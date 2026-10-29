/**
 * Phase 1c — item 2 (P0): audit mode must be genuinely non-mutating.
 *
 * Baseline evidence (reproduced before the fix, /tmp/repro-audit.ts): a read-only audit
 * session on a tree containing legacy `state.json`, a corrupt per-session state file and
 * stale `*.tmp-*` files mutated the tree — it quarantined the corrupt file to
 * `<path>.corrupt-<ts>.bak`, removed/migrated `state.json`, created another session's
 * file and deleted the temp files (6 manifest entries differed).
 *
 * These tests use the REAL filesystem in a temp directory (not a mock), so they prove
 * extension-level non-mutation of the audited tree. OS-enforced immutability is a
 * different guarantee and is NOT claimed here (PROTOCOL §2.3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, rmSync, symlinkSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createLocalFs } from "../.pi/extensions/context-guard/checkpoint.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

const GOAL = "# GOAL\n\n## Objective\nGuard prototype.\n\n## Acceptance criteria\n- Tests pass.\n";
const PROGRESS = "# PROGRESS\n\n## Current phase\n1c\n\n## Completed\n- [x] baseline\n\n## Pending\n- [ ] fix\n\n## Verified evidence\nnone\n\n## Blockers\nnone\n\n## Next action\nRun tests.\n";
const LEARNINGS = "# LEARNINGS\n\n## Accepted\n- a\n\n## Proposed\n- p\n\n## Falsified or superseded\n- f\n";
const HANDOFF = "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nbaseline\n\n## Unfinished operations\n- [ ] fix\n\n## Next action\nRun tests.\n\n## Discoveries not yet incorporated\nnone\n";

function legacyState(sessionId: string): string {
  return JSON.stringify({ version: 1, sessionId, updatedAt: 1, snapshot: { currentLevel: 1, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 29000, evaluations: 4 } });
}

/** Create a project tree pre-loaded with messy runtime state (legacy, corrupt, tmp). */
function makeTree(opts: { stateDir?: string } = {}): { root: string; external: string } {
  const root = mkdtempSync(join(tmpdir(), "guard-audit-"));
  const external = mkdtempSync(join(tmpdir(), "guard-state-"));
  const stateDir = opts.stateDir ?? ".pi-guard";
  mkdirSync(join(root, stateDir, "sessions"), { recursive: true });
  writeFileSync(join(root, "GOAL.md"), GOAL);
  writeFileSync(join(root, "PROGRESS.md"), PROGRESS);
  writeFileSync(join(root, "LEARNINGS.md"), LEARNINGS);
  writeFileSync(join(root, "HANDOFF.md"), HANDOFF);
  writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n");
  writeFileSync(join(root, "handoff.config.json"), JSON.stringify({ stateDir, autoCheckpointAtHandoffLevel: true }));
  // legacy single-slot state belonging to a DIFFERENT session
  writeFileSync(join(root, stateDir, "state.json"), legacyState("other-session"));
  // stale temp files from interrupted writes
  writeFileSync(join(root, stateDir, "state.json.tmp-9999-1111"), "junk");
  writeFileSync(join(root, stateDir, "sessions", "stale.json.tmp-1-1"), "junk");
  return { root, external };
}

function manifest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(`link ${rel} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else out.push(`${rel} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out.sort();
}

interface Session {
  notifications: string[];
  start: () => Promise<void>;
  turn: (tokens: number | null) => Promise<void>;
  command: (name: string, args: string) => Promise<void>;
  shutdown: () => Promise<void>;
  toolCall: (name: string, input: unknown) => Promise<any>;
}

function session(root: string, sessionId: string, options: { env?: Record<string, string | undefined>; config?: Record<string, unknown>; flags?: Record<string, string> } = {}): Session {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const pi: any = {
    on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
    registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
    registerFlag: () => {},
    getFlag: (n: string) => options.flags?.[n],
    sendMessage: () => {},
    sendUserMessage: () => {},
    registerTool: () => {},
    appendEntry: () => {},
  };
  const ctx: any = {
    mode: "print",
    hasUI: true,
    cwd: root,
    ui: { notify: (t: string) => notifications.push(t), setStatus: () => {} },
    getContextUsage: () => ({ tokens: 200000, contextWindow: 220000, percent: null }),
    model: { maxTokens: 65536, contextWindow: 220000 },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
    isIdle: () => true,
  };
  contextGuard(pi, { fs: createLocalFs(), env: options.env ?? {}, ...(options.config ? { config: options.config as never } : {}) });
  const fire = async (type: string, event: any = {}) => {
    let result: any;
    for (const h of handlers.get(type) ?? []) result = await h({ type, ...event }, ctx);
    return result;
  };
  return {
    notifications,
    start: () => fire("session_start", { reason: "startup" }),
    turn: (tokens) => {
      ctx.getContextUsage = () => (tokens === null ? undefined : { tokens, contextWindow: 220000, percent: null });
      return fire("turn_end", { turnIndex: 0, entries: [], continue: false, context: {}, outcome: "completed" });
    },
    command: (name, args) => commands.get(name)!(args, ctx),
    shutdown: () => fire("session_shutdown", { reason: "exit" }),
    toolCall: (toolName, input) => fire("tool_call", { toolName, input, toolCallId: "t1" }),
  };
}

test("A1: read-only audit session with legacy + corrupt + stale-tmp state leaves the tree byte-for-byte unchanged", async () => {
  const { root, external } = makeTree();
  try {
    const before = manifest(root);
    const s = session(root, "audit-1", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: external } });
    await s.start();
    await s.turn(200000);
    await s.command("guard", "status");
    await s.command("handoff", "");
    await s.shutdown();
    assert.deepEqual(manifest(root), before, "audited tree must be unchanged (writes, deletes, renames, migrations all forbidden)");
    assert.ok(s.notifications.some((n) => /read-only/i.test(n)), "audit mode announces itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("A2: read-only audit with an in-tree stateDir performs no repair writes and reports the suppressed repairs", async () => {
  const { root } = makeTree();
  try {
    // corrupt state belonging to THIS session, in the tree
    writeFileSync(join(root, ".pi-guard", "sessions", "audit-2.json"), "{ truncated");
    const before = manifest(root);
    const s = session(root, "audit-2", { env: { CONTEXT_GUARD_READONLY: "1" } });
    await s.start();
    await s.turn(210000);
    await s.command("handoff", "notes must not be written");
    await s.shutdown();
    assert.deepEqual(manifest(root), before, "no quarantine/migration/tmp-cleanup may happen inside the tree");
    assert.ok(s.notifications.some((n) => /repair|migrat|quarantin/i.test(n)), "suppressed repairs must be visible: " + s.notifications.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3: read-only mode reads existing external state but never touches the tree", async () => {
  const { root, external } = makeTree();
  try {
    mkdirSync(join(external, "sessions"), { recursive: true });
    writeFileSync(join(external, "sessions", "audit-3.json"), JSON.stringify({ version: 2, sessionId: "audit-3", updatedAt: 5, snapshot: { currentLevel: 0, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 25000, evaluations: 9 } }));
    writeFileSync(join(external, "state.json"), legacyState("audit-3")); // legacy copy of OUR session, outside the tree
    const before = manifest(root);
    const s = session(root, "audit-3", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: external } });
    await s.start();
    await s.turn(200000); // level 1 already alerted => no new alert, proves state was restored
    assert.equal(s.notifications.filter((n) => /CONTEXT PRESSURE|level 1/.test(n)).length, 0, "alert already spent in restored state");
    assert.deepEqual(manifest(root), before);
    assert.ok(readdirSync(join(external, "sessions")).includes("audit-3.json"), "external state may be maintained");
    assert.ok(!readdirSync(external).includes("state.json"), "legacy state.json outside the tree is migrated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("A4: containment uses normalized paths — '..' tricks do not make an in-tree stateDir look external", async () => {
  const { root } = makeTree();
  try {
    const before = manifest(root);
    const parent = resolve(root, "..");
    const sneaky = join(parent, root.split("/").pop()!, ".pi-guard"); // resolves back inside the tree
    const s = session(root, "audit-4", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: sneaky } });
    await s.start();
    await s.turn(210000);
    await s.shutdown();
    assert.deepEqual(manifest(root), before, `"${sneaky}" resolves inside the audited tree => treated as in-tree`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A5: a symlinked in-tree stateDir is treated as part of the audited tree (no writes through it)", async () => {
  const { root, external } = makeTree({ stateDir: "guard-link" });
  try {
    rmSync(join(root, "guard-link"), { recursive: true, force: true });
    symlinkSync(external, join(root, "guard-link"), "dir");
    const before = manifest(root);
    const s = session(root, "audit-5", { env: { CONTEXT_GUARD_READONLY: "1" } });
    await s.start();
    await s.turn(210000);
    await s.shutdown();
    assert.deepEqual(manifest(root), before, "no writes through a tree-resident symlinked state dir");
    assert.ok(s.notifications.some((n) => /READ-ONLY/i.test(n)), "status still reports audit mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("A6: GOAL protection is path-normalised and symlink-aware (no string-prefix bypass)", async () => {
  const { root, external } = makeTree();
  try {
    symlinkSync("GOAL.md", join(root, "goal-alias.md"));
    const s = session(root, "normal-6", { env: { CONTEXT_GUARD_STATE_DIR: external } });
    await s.start();
    for (const target of ["GOAL.md", "./GOAL.md", "sub/../GOAL.md", join(root, "sub", "..", "GOAL.md"), join(root, "goal-alias.md"), resolve(root) + "/GOAL.md"]) {
      const result = await s.toolCall("write", { path: target, content: "hijacked" });
      assert.equal(result?.block, true, `must block GOAL.md writes via ${JSON.stringify(target)}`);
    }
    const notGoal = await s.toolCall("write", { path: "OTHER.md", content: "fine" });
    assert.notEqual(notGoal?.block, true, "unrelated path must not be blocked");
    assert.deepEqual(readFileSync(join(root, "GOAL.md"), "utf8"), GOAL, "GOAL.md untouched on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("A7: normal (non-audit) mode still recovers and migrates — behaviour preserved", async () => {
  const { root, external } = makeTree();
  try {
    mkdirSync(join(external, "sessions"), { recursive: true });
    // the messy runtime state lives in the session's OWN state dir (external here)
    writeFileSync(join(external, "state.json"), legacyState("other-session"));
    writeFileSync(join(external, "state.json.tmp-9999-1111"), "junk");
    writeFileSync(join(external, "sessions", "stale.json.tmp-1-1"), "junk");
    writeFileSync(join(external, "sessions", "normal-7.json"), "{ truncated");
    const s = session(root, "normal-7", { env: { CONTEXT_GUARD_STATE_DIR: external } });
    await s.start();
    await s.turn(200000);
    await s.command("handoff", "");
    const files = readdirSync(external);
    assert.ok(!files.includes("state.json"), "legacy state.json migrated");
    assert.ok(readdirSync(join(external, "sessions")).some((f) => f === "other-session.json"), "foreign legacy state preserved under its own name");
    assert.ok(readdirSync(join(external, "sessions")).some((f) => f.startsWith("normal-7.json.corrupt-")), "corrupt own state quarantined");
    assert.ok(!files.some((f) => f.includes(".tmp-")), "stale tmp files cleaned");
    assert.ok(readFileSync(join(root, "HANDOFF.md"), "utf8").includes("guard:begin checkpoint"), "checkpoint written in normal mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("A8: audit mode does not fabricate checkpoints even at enforced level", async () => {
  const { root, external } = makeTree();
  try {
    const before = manifest(root);
    const s = session(root, "audit-8", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: external } });
    await s.start();
    await s.turn(216000); // enforced closing
    await s.shutdown();
    assert.deepEqual(manifest(root), before, "level-4 auto-checkpoint must stay a dry run in audit mode");
    assert.ok(s.notifications.some((n) => /checkpoint/i.test(n)));
    const fresh = session(root, "audit-8b", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: external } });
    await fresh.start();
    assert.notEqual((await fresh.toolCall("bash", { command: "ls" }))?.block, true, "a fresh audit session is not in enforced closing");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
