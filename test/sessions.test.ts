/**
 * Phase 1b — session isolation, read-only audit mode, durable-only recovery.
 *
 * Reproduces the recovery-audit findings at the extension (adapter) level:
 * - a single-slot state.json let a second session overwrite the first's state;
 * - a "read-only" audit session still mutated the tree via guard runtime state;
 * - fresh-session recovery must work from durable files alone.
 * Mocked Pi events + memory fs + synthetic budgets only; zero inference.
 * NOTE: these are serial, single-process simulations. Real multi-process
 * concurrency is NOT tested here (see LEARNINGS P-5).
 */

import test from "node:test";
import assert from "node:assert/strict";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { readRecoveryBundle, sessionStatePath, writeCheckpoint, type CheckpointInput } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

interface Session {
  fs: MemoryFs;
  pi: ReturnType<typeof createMockPi>;
  ctx: ReturnType<typeof createMockCtx>;
  start: () => Promise<void>;
  turnEnd: (usageTokens: number | null) => Promise<void>;
  command: (name: string, args: string) => Promise<void>;
  alerts: () => Array<{ message: any; options: any }>;
}

function session(fs: MemoryFs, sessionId: string, options: { env?: Record<string, string | undefined>; config?: Record<string, unknown>; flags?: Record<string, string> } = {}): Session {
  const pi = createMockPi(options.flags ?? {});
  const ctx = createMockCtx({ cwd: "/project", sessionId });
  contextGuard(pi.pi as never, {
    fs,
    env: options.env ?? {},
    ...(options.config ? { config: options.config as never } : {}),
  });
  return {
    fs,
    pi,
    ctx,
    async start() {
      await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    },
    async turnEnd(usageTokens) {
      await pi.emit({ type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never, {
        ...ctx.ctx,
        getContextUsage: () =>
          usageTokens === null ? undefined : { tokens: usageTokens, contextWindow: 220000, percent: null },
      } as never);
    },
    async command(name, args) {
      await pi.runCommand(name, args, ctx.ctx);
    },
    alerts: () => pi.sentMessages.filter((m) => m.message.customType === "context-guard"),
  };
}

const LEVEL1_TOKENS = 125464; // remaining ~29000 with 220k window / 65536 reserve
const LEVEL2_TOKENS = 135464; // remaining ~19000

test("S1: two sessions with distinct ids get distinct state files", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const a = session(fs, "session-A");
  const b = session(fs, "session-B");
  await a.start();
  await b.start();
  await a.turnEnd(LEVEL1_TOKENS);
  await b.turnEnd(LEVEL2_TOKENS);

  const pathA = sessionStatePath("/project/.pi-guard", "session-A");
  const pathB = sessionStatePath("/project/.pi-guard", "session-B");
  assert.ok(fs.exists(pathA) && fs.exists(pathB));
  const stateA = JSON.parse(fs.readFile(pathA)!);
  const stateB = JSON.parse(fs.readFile(pathB)!);
  assert.equal(stateA.version, 2);
  assert.equal(stateA.sessionId, "session-A");
  assert.deepEqual(stateA.snapshot.alertedLevels, [1]);
  assert.equal(stateB.sessionId, "session-B");
  assert.deepEqual(stateB.snapshot.alertedLevels, [1, 2]);
});

test("S2: no cross-session overwrite — restart of A restores A and leaves B's state intact", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const a = session(fs, "session-A");
  await a.start();
  await a.turnEnd(LEVEL1_TOKENS);
  const b = session(fs, "session-B");
  await b.start();
  await b.turnEnd(LEVEL2_TOKENS);
  const pathB = sessionStatePath("/project/.pi-guard", "session-B");
  const bBefore = fs.readFile(pathB)!;

  // A reloads (new extension instance, same id, same fs): restores ITS OWN spent alerts.
  const a2 = session(fs, "session-A");
  await a2.start();
  await a2.turnEnd(LEVEL1_TOKENS); // would alert again if A's state had been lost
  assert.equal(a2.alerts().length, 0, "A's spent alert must survive B's activity");
  assert.equal(fs.readFile(pathB), bBefore, "B's runtime state must not be touched by A");
});

test("S3: corrupt state in one session is quarantined without harming another", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const a = session(fs, "session-A");
  await a.start();
  await a.turnEnd(LEVEL1_TOKENS);
  const b = session(fs, "session-B");
  await b.start();
  await b.turnEnd(LEVEL2_TOKENS);

  // crash-truncate A's file only
  const pathA = sessionStatePath("/project/.pi-guard", "session-A");
  fs.writeFile(pathA, '{"version":2,"sessionId":"session-A","snapsh');
  const pathB = sessionStatePath("/project/.pi-guard", "session-B");
  const bSnapBefore = JSON.parse(fs.readFile(pathB)!).snapshot;

  const a2 = session(fs, "session-A");
  await a2.start(); // quarantines the corrupt file, then persists a fresh state under the same id
  const freshA = JSON.parse(fs.readFile(pathA)!);
  assert.equal(freshA.snapshot.alertedLevels.length, 0, "A restarted fail-safe with re-armed alerts");
  assert.equal([...fs.files.keys()].filter((k) => k.includes("corrupt") && k.endsWith(".bak")).length, 1);
  await a2.turnEnd(LEVEL1_TOKENS);
  assert.equal(a2.alerts().length, 1, "A re-armed after corruption");

  const b2 = session(fs, "session-B");
  await b2.start();
  assert.deepEqual(JSON.parse(fs.readFile(pathB)!).snapshot, bSnapBefore, "B's snapshot content untouched by A's corruption+recovery");
  await b2.turnEnd(LEVEL2_TOKENS);
  assert.equal(b2.alerts().length, 0, "B still restores its own spent alerts");
});

test("S4: legacy single-slot state.json is migrated to its owning session, never applied to another", async () => {
  const legacy = JSON.stringify({
    version: 1,
    sessionId: "audit-session",
    updatedAt: 42,
    snapshot: { currentLevel: 1, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 29000, evaluations: 2 },
  });
  const fs = createMemoryFs({ ...DEFAULT_FILES, "/project/.pi-guard/state.json": legacy });
  const s = session(fs, "fresh-session");
  await s.start();
  assert.ok(s.ctx.notifications.some((n) => n.text.includes("audit-session") && n.text.includes("preserved")));
  assert.equal(fs.exists("/project/.pi-guard/state.json"), false);
  const moved = fs.readFile(sessionStatePath("/project/.pi-guard", "audit-session"));
  assert.ok(moved && JSON.parse(moved).snapshot.alertedLevels.length === 1);
  // the fresh session re-arms (it is not the legacy owner)
  await s.turnEnd(LEVEL1_TOKENS);
  assert.equal(s.alerts().length, 1);
});

test("S5: session state retention prunes old ephemeral files but keeps durable checkpoints", async () => {
  const mkState = (id: string, updatedAt: number) =>
    JSON.stringify({ version: 2, sessionId: id, updatedAt, snapshot: { currentLevel: 0, alertedLevels: [], unknownStreak: 0, degraded: false, lastRemaining: null, evaluations: 0 } });
  const fs = createMemoryFs({
    ...DEFAULT_FILES,
    "/project/.pi-guard/sessions/old-1.json": mkState("old-1", 1),
    "/project/.pi-guard/sessions/old-2.json": mkState("old-2", 2),
    "/project/.pi-guard/sessions/old-3.json": mkState("old-3", 3),
    "/project/.pi-guard/sessions/old-4.json": mkState("old-4", 4),
  });
  writeHandoffCheckpoint(fs);
  const s = session(fs, "live", { config: { maxSessionStates: 2 } });
  await s.start();
  const kept = [...fs.files.keys()].filter((k) => k.includes("/sessions/") && k.endsWith(".json"));
  assert.equal(kept.includes(sessionStatePath("/project/.pi-guard", "old-4")), true, "newest kept");
  assert.equal(kept.includes(sessionStatePath("/project/.pi-guard", "old-1")), false, "oldest pruned");
  assert.equal(kept.includes(sessionStatePath("/project/.pi-guard", "live")), true, "current kept");
  assert.ok(fs.readFile("/project/HANDOFF.md")!.includes("guard:begin checkpoint"), "durable checkpoint NOT pruned");
});

test("S6: read-only audit mode performs zero writes to the project tree", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const before = JSON.stringify([...fs.files.entries()].sort());
  const s = session(fs, "audit-1", { env: { CONTEXT_GUARD_READONLY: "1" } });
  await s.start();
  await s.turnEnd(LEVEL1_TOKENS);
  await s.command("guard", "simulate 9000"); // would auto-checkpoint in normal mode
  await s.command("handoff", "audit notes"); // would write HANDOFF/PROGRESS in normal mode
  assert.ok(s.ctx.notifications.some((n) => n.text.includes("read-only audit mode") && n.text.includes("suppressed")));
  assert.ok(s.ctx.notifications.some((n) => n.text.includes("dry run")));
  await s.command("guard", "status");
  assert.ok(s.ctx.notifications.some((n) => n.text.includes("READ-ONLY audit mode")));
  assert.equal(fs.writes.length, 0, "audit mode must not write anything at all");
  assert.equal(JSON.stringify([...fs.files.entries()].sort()), before);
});

test("S6b: read-only mode also activates via the --guard-readonly CLI flag (real runtime path)", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const before = JSON.stringify([...fs.files.entries()].sort());
  const s = session(fs, "audit-flag", { flags: { "guard-readonly": "1" } });
  await s.start();
  await s.turnEnd(LEVEL1_TOKENS);
  await s.command("guard", "simulate 9000");
  await s.command("handoff", "flag notes");
  assert.equal(fs.writes.length, 0);
  assert.equal(JSON.stringify([...fs.files.entries()].sort()), before);
  assert.ok(s.ctx.notifications.some((n) => n.text.includes("read-only audit mode")));
});

test("S7: read-only mode may still persist runtime state OUTSIDE the audited tree", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const s = session(fs, "audit-2", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/tmp/guard-audit-state" } });
  await s.start();
  await s.turnEnd(LEVEL1_TOKENS);
  await s.command("handoff", "would-be checkpoint"); // dry run: no tree write
  const projectWrites = fs.writes.filter((p) => p.startsWith("/project"));
  assert.deepEqual(projectWrites, [], "no writes inside the audited tree");
  const external = fs.readFile("/tmp/guard-audit-state/sessions/audit-2.json");
  assert.ok(external, "runtime state persisted outside the tree");
  assert.equal(JSON.parse(external).sessionId, "audit-2");
});

test("S8: manual discoveries survive a checkpoint refresh after staleness is detected", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const learningsBefore = fs.readFile("/project/LEARNINGS.md")!;
  const s1 = session(fs, "sess-1");
  await s1.start();
  await s1.command("handoff", "first checkpoint");
  assert.equal(readRecoveryBundle(fs, "/project", FILES).checkpoint.kind, "current");

  // agent adds manual discoveries (prose edits) after the checkpoint
  const discovery = "GUARD beats compaction for cross-session memory.";
  fs.writeFile("/project/HANDOFF.md", fs.readFile("/project/HANDOFF.md")!.replace("- followUp deferral semantics.", `- followUp deferral semantics.\n- ${discovery}`));
  fs.writeFile("/project/LEARNINGS.md", learningsBefore + `\n- [A-9] ${discovery}\n`);

  const s2 = session(fs, "sess-2");
  await s2.start();
  assert.ok(s2.ctx.notifications.some((n) => n.text.includes("stale") && n.text.includes("manual")), "fresh session warns about staleness, not silently overwrites");

  await s2.command("handoff", "refresh");
  const handoff = fs.readFile("/project/HANDOFF.md")!;
  assert.ok(handoff.includes(discovery), "manual discovery preserved verbatim");
  assert.ok(!handoff.includes("A-9"), "guard never copies LEARNINGS content into HANDOFF body");
  assert.equal(fs.readFile("/project/LEARNINGS.md")!.startsWith(learningsBefore), true, "LEARNINGS additions untouched by guard");
  assert.equal(fs.readFile("/project/LEARNINGS.md")!.includes(discovery), true);
  assert.equal(readRecoveryBundle(fs, "/project", FILES).checkpoint.kind, "current");
});

test("S9: fresh-session recovery works from durable files alone (no runtime state)", async () => {
  // session 1 checkpoints, then only the durable markdown files + config survive.
  const fs1 = createMemoryFs(DEFAULT_FILES);
  const s1 = session(fs1, "sess-1");
  await s1.start();
  await s1.command("handoff", "durable-only recovery");
  fs1.writeFile("/project/HANDOFF.md", fs1.readFile("/project/HANDOFF.md")!.replace("Run the test suite.", "Run node --test test/, then human review."));

  const durableOnly: Record<string, string> = {};
  for (const key of ["/project/GOAL.md", "/project/PROGRESS.md", "/project/LEARNINGS.md", "/project/HANDOFF.md", "/project/handoff.config.json", "/project/AGENTS.md"]) {
    const v = fs1.readFile(key);
    if (v !== undefined) durableOnly[key] = v;
  }
  assert.equal(Object.keys(durableOnly).length >= 5, true);

  const fs2 = createMemoryFs(durableOnly);
  const s2 = session(fs2, "sess-2");
  await s2.start();
  assert.ok(![...fs2.files.keys()].some((k) => k.includes("sess-1")), "no foreign runtime state carried over");

  const bundle = readRecoveryBundle(fs2, "/project", FILES);
  assert.equal(bundle.objective, "Build a context guard prototype.");
  assert.equal(bundle.nextAction, "Run node --test test/, then human review.");
  assert.equal(bundle.nextActionSource, "handoff-prose");
  assert.equal(bundle.recoveryInstructions.length > 0, true);
  await s2.turnEnd(LEVEL1_TOKENS);
  assert.equal(s2.alerts().length, 1, "fresh session armed independently");
});

/** Write a v2 checkpoint directly (shared durable state fixture for S5). */
function writeHandoffCheckpoint(fs: MemoryFs) {
  const input: CheckpointInput = {
    cwd: "/project",
    files: FILES,
    level: 1,
    sessionId: "writer",
    remaining: 25000,
    goalDrift: false,
    lastVerifiedState: "fixture",
    unfinishedOperations: [],
    nextAction: "Run node --test test/.",
    recoveryInstructions: [],
  };
  const r = writeCheckpoint(fs, input);
  assert.equal(r.ok, true);
}
