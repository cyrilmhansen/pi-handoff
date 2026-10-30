/**
 * dev.2 D2: INDEPENDENT finalization (`/handoff finalize` + `handoff_finalize` tool).
 *
 * Motivation (DRPLi campaign, A-27): the chain exhausted its cap 8/8 and ended with an
 * obsolete final checkpoint; finalization must work even when renewal is capped,
 * disabled or stopped — and must NEVER switch sessions, increment the renewal counter,
 * reset the cap or bypass readiness checks.
 *
 * All deterministic, memory fs, zero inference (adapter level, mocked Pi API).
 */

import test from "node:test";
import assert from "node:assert/strict";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { validateCheckpoint, renewAuthorization } from "../.pi/extensions/context-guard/checkpoint.ts";
import type { RenewalState } from "../.pi/extensions/context-guard/renewal.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs, type MockPi } from "./helpers.ts";

const STATE = "/project/.pi-guard/renewal-state.json";
const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function cfg(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    thresholds: { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 },
    enforceClosing: true,
    closingAllowlist: ["write", "edit", "read", "handoff_renew"],
    protectGoal: true,
    autoCheckpointAtHandoffLevel: true,
    stateDir: ".pi-guard",
    ...over,
  });
}

function stateSeed(s: Partial<RenewalState>): string {
  return JSON.stringify({ version: 1, chainId: "chain:seed", renewalsDone: 0, renewedFromCheckpointId: null, lastSuccessorSessionId: null, stopped: false, updatedAt: 5, ...s });
}

interface FH {
  pi: MockPi;
  memFs: MemoryFs;
  mc: ReturnType<typeof createMockCtx>;
  start: (sessionId?: string) => Promise<void>;
  command: (args: string, ctx?: any) => Promise<void>;
}

function harness(opts: { config?: string; files?: Record<string, string>; env?: Record<string, string | undefined> } = {}): FH {
  const memFs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": opts.config ?? cfg(), ...opts.files });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-F", usage: { tokens: 1000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: memFs, env: opts.env ?? {} });
  return {
    pi,
    memFs,
    mc,
    async start(sessionId = "session-F") {
      const ctx = createMockCtx({ cwd: "/project", sessionId, usage: { tokens: 1000, contextWindow: 220000 } });
      await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    },
    async command(args, ctx) {
      await pi.runCommand("handoff", args, ctx ?? mc.ctx);
    },
  };
}

function texts(mc: ReturnType<typeof createMockCtx>): string {
  return mc.notifications.map((n) => n.text).join("\n");
}

async function finalized(h: FH): Promise<{ f: ReturnType<typeof validateCheckpoint>; out: string }> {
  await h.command("finalize done with the increment; stop after this");
  return { f: validateCheckpoint(h.memFs, "/project", FILES), out: texts(h.mc) };
}

test("FZ1: finalize WORKS with renewal disabled (no renewal block at all)", async () => {
  const h = harness({ config: JSON.stringify({ stateDir: ".pi-guard" }) }); // defaults: renewal OFF
  await h.start();
  const { f, out } = await finalized(h);
  assert.match(out, /FINALIZE/);
  assert.match(out, /readiness attested|READY/);
  assert.equal(f.kind, "current");
  assert.equal(f.readiness.state, "attested");
  assert.equal(renewAuthorization(f).authorized, true);
  assert.equal(h.mc.newSessionCalls, 0, "finalize NEVER switches sessions");
  assert.equal(h.mc.switchSessionCalls, 0);
  assert.equal(h.mc.compactCalls, 0);
  assert.equal(h.memFs.files.has(STATE), false, "finalize does not create renewal chain state");
});

test("FZ2: finalize WORKS at the exhausted cap (8/8) and leaves chain state byte-identical", async () => {
  const seed = stateSeed({ renewalsDone: 8, renewedFromCheckpointId: "g19-old", chainId: "chain:campaign" });
  const h = harness({ config: cfg({ renewal: { enabled: true, autoRenew: true, maxRenewals: 8 } }), files: { [STATE]: seed } });
  await h.start();
  const { f, out } = await finalized(h);
  assert.equal(f.kind, "current");
  assert.equal(f.readiness.state, "attested");
  assert.match(out, /cap|8\/8/, "report names the cap state");
  assert.match(out, /UNTOUCHED|untouched/);
  assert.equal(h.memFs.files.get(STATE), seed, "chain state byte-identical: no counter increment, no cap reset, no idempotence-key change");
  assert.equal(h.mc.newSessionCalls, 0);
});

test("FZ3: finalize WORKS on a durably stopped chain (stop flag survives untouched)", async () => {
  const seed = stateSeed({ stopped: true, renewalsDone: 1, chainId: "chain:stopped" });
  const h = harness({ config: cfg({ renewal: { enabled: true, autoRenew: false, maxRenewals: 2 } }), files: { [STATE]: seed } });
  await h.start();
  const { f, out } = await finalized(h);
  assert.equal(f.kind, "current");
  assert.equal(f.readiness.state, "attested");
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).stopped, true, "durable stop is never cleared by finalize");
  assert.match(out, /stopped|UNTOUCHED|untouched/i);
  assert.equal(h.mc.newSessionCalls, 0);
});

test("FZ4: finalize refreshes a STALE checkpoint (manual prose changed), then attests", async () => {
  const h = harness();
  await h.start();
  await h.command(""); // establish a current checkpoint first
  const gBefore = validateCheckpoint(h.memFs, "/project", FILES).identity!.generation;
  h.memFs.writeFile("/project/HANDOFF.md", (h.memFs.files.get("/project/HANDOFF.md") ?? "") + "\n## Notes from session F\nFresh discovery: finalize semantics verified.\n");
  assert.equal(validateCheckpoint(h.memFs, "/project", FILES).kind, "stale");
  const { f, out } = await finalized(h);
  assert.equal(f.kind, "current", "finalize refreshed the managed block over the new prose");
  assert.ok(f.identity!.generation > gBefore);
  assert.equal(f.readiness.state, "attested");
  assert.match(out, /FINALIZE/);
});

test("FZ5: finalize NEVER bypasses readiness — attestation refuses on a missing next action", async () => {
  const noNext = {
    "/project/HANDOFF.md":
      "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nok\n\n## Unfinished operations\n- [ ] x\n\n## Discoveries not yet incorporated\n- (none)\n",
  };
  const h = harness({ files: noNext });
  await h.start();
  await h.command("finalize whatever");
  const out = texts(h.mc);
  assert.match(out, /NOT READY|attestation refused/i);
  assert.match(out, /next-action-recorded/);
  const f = validateCheckpoint(h.memFs, "/project", FILES);
  assert.notEqual(f.readiness.state, "attested", "readiness is NEVER stamped over a failed blocking check");
  assert.equal(h.mc.newSessionCalls, 0);
});

test("FZ6: read-only audit mode — finalize is a reported dry run, zero writes inside the tree", async () => {
  const h = harness({ config: cfg({ renewal: { enabled: true } }), env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/tmp/guard-fz6" } });
  await h.start();
  await h.command("finalize audit");
  const out = texts(h.mc);
  assert.match(out, /dry run|NOT written/i);
  assert.ok(!h.memFs.writes.some((w) => w.startsWith("/project/")), "read-only finalize writes NOTHING in the audited tree");
  assert.equal(h.mc.newSessionCalls, 0);
});

test("FZ7: repeated finalize is idempotent (no new generation, still attested, chain untouched)", async () => {
  const seed = stateSeed({ renewalsDone: 2, renewedFromCheckpointId: "g17-x", chainId: "chain:idem" });
  const h = harness({ config: cfg({ renewal: { enabled: true, autoRenew: false, maxRenewals: 2 } }), files: { [STATE]: seed } });
  await h.start();
  const first = validateCheckpoint(h.memFs, "/project", FILES);
  await finalized(h);
  const after1 = validateCheckpoint(h.memFs, "/project", FILES);
  await h.command("finalize again");
  const after2 = validateCheckpoint(h.memFs, "/project", FILES);
  assert.equal(after1.kind, "current");
  assert.equal(after2.kind, "current");
  assert.equal(after2.readiness.state, "attested");
  assert.equal(after1.identity!.generation, after2.identity!.generation, "no new generation while nothing changed");
  assert.notEqual(first.kind, "current"); // sanity: session_start saw the pre-existing block as stale vs fixture prose? not required — tolerated either way
  assert.equal(h.memFs.files.get(STATE), seed);
  assert.equal(h.mc.newSessionCalls, 0);
});

test("FZ8: handoff_finalize TOOL — registered, synchronous, no idle wait, no switch; allowed during enforced closing", async () => {
  const h = harness({ config: cfg({ renewal: { enabled: false } }) }); // renewal disabled: finalize must still work
  await h.start();
  const tool = h.pi.tools.get("handoff_finalize");
  assert.ok(tool, "handoff_finalize registered even with renewal disabled");
  assert.equal(tool.parameters.type, "object");
  // drive real pressure: remaining = 220000 - 216500 - reserve < closing threshold => level 4
  const mc4 = createMockCtx({ cwd: "/project", sessionId: "session-F", usage: { tokens: 216500, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
  await h.pi.emit({ type: "turn_end", turnIndex: 1, message: {} as never, toolResults: [], messageEntryId: "m", toolResultEntryIds: [] } as never, mc4.ctx as never);
  const blockFinalize = await h.pi.emit({ type: "tool_call", toolName: "handoff_finalize", input: {} } as never, mc4.ctx as never);
  assert.ok(blockFinalize.every((r) => !r || !(r as any).block), "handoff_finalize is callable during enforced closing");
  const blockBash = await h.pi.emit({ type: "tool_call", toolName: "bash", input: { command: "echo hi" } } as never, mc4.ctx as never);
  assert.ok(blockBash.some((r) => (r as any)?.block === true), "ordinary tools stay blocked at level 4");
  // execute: synchronous, no waitForIdle, no switch, no chain write
  const res = await tool.execute("tc-1", { notes: "closing out the increment" }, undefined, undefined, mc4.ctx);
  assert.equal(res.details.ok, true);
  assert.match(res.content[0].text, /FINALIZE/);
  assert.ok(!h.mc.ops.includes("waitForIdle"), "finalize NEVER waits for idle (no deadlock, distinct from the renewal switch path)");
  assert.ok(!mc4.ops.includes("waitForIdle"), "the tool path never waits for idle either");
  assert.equal(h.mc.newSessionCalls, 0);
  assert.equal(mc4.newSessionCalls, 0);
  assert.equal(h.pi.userMessages.length, 0, "no command dispatch needed — no P-8 bridge round trip");
  assert.equal(h.memFs.files.has(STATE), false, "finalize with renewal disabled creates NO chain state");
});

test("FZ9: finalize report is compact and structured (one line, ISO timestamp, ids)", async () => {
  const h = harness({ config: cfg({ renewal: { enabled: true, autoRenew: false, maxRenewals: 2 } }) });
  await h.start();
  await finalized(h);
  const line = texts(h.mc).split("\n").find((l) => /FINALIZE/.test(l)) ?? "";
  assert.match(line, /FINALIZE \(session session-F, 20\d\d-\d\d-\d\dT.*Z\)/, "compact ISO-8601 timestamp in the header");
  assert.match(line, /checkpoint g\d+-[0-9a-f]+ readiness attested -> FINALIZED/, "single-line outcome with checkpoint id");
  assert.match(line, /chain done=\d+\/\d+ UNTOUCHED/, "chain state reported as untouched, compactly");
});
