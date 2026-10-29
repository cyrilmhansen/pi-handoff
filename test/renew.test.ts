/**
 * Phase 2 increment B: renewal WIRING tests (adapter level, mocked Pi API).
 *
 * Proves the command/tool plumbing around the pure decision module (RN tests):
 *   - disabled-by-default refusal performs NO tree writes and NO switch;
 *   - the successful operator path: waitForIdle -> refresh+attest -> gate -> durable
 *     chain state BEFORE the switch -> ctx.newSession({parentSession, withSession}) ->
 *     recovery prompt sent on the SUCCESSOR context with triggerTurn:true (fire-and-
 *     track) and zero compact/switchSession calls;
 *   - successor session_start records lineage from the pending marker (P-4) and the
 *     durable idempotence/cap carry across simulated restarts;
 *   - model bridge (P-8): handoff_renew tool fires `pi.sendUserMessage("/handoff renew
 *     go", {expandPromptTemplates:true})` WITHOUT switching inside execute; the
 *     dispatched command then performs the switch with trigger "model";
 *   - operator stop is durable; read-only mode refuses; authorization is required.
 */

import test from "node:test";
import assert from "node:assert/strict";

import contextGuard, { detectPiHarness } from "../.pi/extensions/context-guard/index.ts";
import { joinPath, validateCheckpoint, renewAuthorization } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs, type MockPi } from "./helpers.ts";

const STATE = "/project/.pi-guard/renewal-state.json";
const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function renewConfig(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    thresholds: { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 },
    enforceClosing: true,
    closingAllowlist: ["write", "edit", "read", "handoff_renew"],
    protectGoal: true,
    autoCheckpointAtHandoffLevel: true,
    stateDir: ".pi-guard",
    renewal: { enabled: true, autoRenew: false, maxRenewals: 2, ...over },
  });
}

interface RH {
  pi: MockPi;
  memFs: MemoryFs;
  mc: ReturnType<typeof createMockCtx>;
  start: (sessionId?: string, extra?: Record<string, unknown>) => Promise<void>;
  command: (args: string) => Promise<void>;
  notes: () => string;
}

function harness(opts: { config?: string; env?: Record<string, string | undefined>; files?: Record<string, string> } = {}): RH {
  const memFs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": opts.config ?? renewConfig(), ...opts.files });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-A", usage: { tokens: 1000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: memFs, env: opts.env ?? {} });
  return {
    pi,
    memFs,
    mc,
    async start(sessionId = "session-A", extra = {}) {
      const ctx = createMockCtx({ cwd: "/project", sessionId, usage: { tokens: 1000, contextWindow: 220000 } });
      await pi.emit({ type: "session_start", reason: "startup", ...extra } as never, ctx.ctx as never);
      return ctx;
    },
    async command(args) {
      await pi.runCommand("handoff", args, mc.ctx);
    },
    notes: () => mc.notifications.map((n) => n.text).join("\n"),
  };
}

async function succeedRenewal(h: RH): Promise<string> {
  await h.command("renew");
  const state = JSON.parse(h.memFs.files.get(STATE)!);
  return state.renewedFromCheckpointId;
}

test("RB1: disabled by default — refusal WITHOUT any tree write or session switch", async () => {
  const h = harness({ config: JSON.stringify({ stateDir: ".pi-guard" }) }); // no renewal block => defaults OFF
  await h.start();
  const writesBefore = h.memFs.writes.length;
  await h.command("renew");
  assert.match(h.notes(), /renewal NOT performed \(disabled\)/);
  assert.equal(h.mc.newSessionCalls, 0);
  assert.equal(h.mc.ops.includes("newSession"), false);
  assert.equal(h.memFs.files.has(STATE), false, "no chain state written by a refused renewal");
  assert.ok(!h.memFs.writes.slice(writesBefore).some((w) => w.endsWith("HANDOFF.md") || w.endsWith("PROGRESS.md")), "pre-gate refuses BEFORE the checkpoint refresh writes");
});

test("RB2: operator renewal — idle boundary, refresh+attest, durable state BEFORE switch, recovery send on successor ctx", async () => {
  const h = harness();
  await h.start();
  await h.command("renew landing state recorded");

  // ordering: boundary first, then the switch; compaction and switchSession NEVER
  assert.deepEqual(h.mc.ops.filter((o) => o === "waitForIdle" || o === "newSession" || o === "compact" || o === "switchSession"), ["waitForIdle", "newSession"]);
  assert.equal(h.mc.compactCalls, 0);
  assert.equal(h.mc.switchSessionCalls, 0);

  // newSession called with parentSession + withSession
  assert.equal(h.mc.newSessionCalls, 1);
  const o = h.mc.newSessionOptions[0];
  assert.equal(o.parentSession, "/sessions/session-A.jsonl");
  assert.equal(typeof o.withSession, "function");

  // checkpoint got refreshed + attested durably BEFORE the gate passed
  const f = validateCheckpoint(h.memFs, "/project", FILES);
  assert.equal(f.kind, "current");
  assert.equal(f.readiness.state, "attested");
  assert.equal(renewAuthorization(f).authorized, true);
  const cpId = f.identity!.id;

  // durable chain state recorded before switching
  const state = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(state.chainId, "chain:session-A");
  assert.equal(state.renewalsDone, 1);
  assert.equal(state.renewedFromCheckpointId, cpId);

  // recovery instruction fired on the SUCCESSOR context, triggerTurn true, no replay
  assert.equal(h.mc.recoverySends.length, 1);
  const rec = h.mc.recoverySends[0];
  assert.equal(rec.message.customType, "context-guard-recovery");
  assert.equal(rec.options.triggerTurn, true);
  assert.match(rec.message.content, /durable state/);
  assert.ok(rec.message.content.includes("AGENTS.md") && rec.message.content.includes(cpId) && rec.message.content.includes("session-A"));
  assert.ok(rec.message.content.includes("landing state recorded"), "notes carried into the successor prompt");
  assert.match(h.notes(), /session renewed \(1\/2\)/);

  // consume the pending marker via a successor session_start (the real runtime does
  // this through the re-invoked factory; module scope persists — A-17.4), THEN retry:
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-A.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-B" }).ctx as never);
  const before = h.mc.newSessionCalls;
  await h.command("renew again");
  assert.match(h.notes(), /already-renewed/);
  assert.equal(h.mc.newSessionCalls, before);
});

test("RB3: successor session_start records the lineage (pending marker consumed, lastSuccessorSessionId persisted, audit entry)", async () => {
  const h = harness();
  await h.start();
  const cpId = await succeedRenewal(h);
  // the REAL runtime re-invokes the factory and emits session_start on the successor;
  // emulate with the same module state (jiti cache, A-17.4):
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-A.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-B" }).ctx as never);
  const state = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(state.lastSuccessorSessionId, "session-B");
  assert.equal(state.renewalsDone, 1);
  const audit = h.pi.entries.find((e) => (e.data as any)?.renewalSuccessor);
  assert.ok(audit, "audit entry naming the checkpoint it transitioned from (PROTOCOL §6)");
  assert.equal((audit!.data as any).renewalSuccessor.fromCheckpointId, cpId);
  assert.equal((audit!.data as any).renewalSuccessor.parentSessionFile, "/sessions/session-A.jsonl");
  // pending marker was consumed: a NEW checkpoint can renew again (B -> C)
  h.memFs.writeFile("/project/LEARNINGS.md", DEFAULT_FILES["/project/LEARNINGS.md"] + "\n- [A-99] discovery from session B. evidence: rb3 fixture. confidence: high. adopted: no\n");
  const ctxB = createMockCtx({ cwd: "/project", sessionId: "session-B" });
  await h.pi.runCommand("handoff", "renew second hop", ctxB.ctx);
  assert.equal(ctxB.newSessionCalls, 1, "second transition happens from the successor session");
  const st2 = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(st2.renewalsDone, 2);
  assert.notEqual(st2.renewedFromCheckpointId, cpId, "second hop seeded by a NEW checkpoint id");
});

test("RB4: operator stop is durable and beats everything; resume clears it; session_before_switch never cancels human switches", async () => {
  const h = harness();
  await h.start();
  await h.command("renew stop");
  assert.match(h.notes(), /STOPPED/);
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).stopped, true);
  await h.command("renew");
  assert.match(h.notes(), /renewal NOT performed \(stopped\)/);
  assert.equal(h.mc.newSessionCalls, 0);
  // a FRESH session inherits the durable stop (successor cannot resurrect the chain)
  const ctx2 = await h.start("session-A2");
  await h.command("renew");
  assert.match(ctx2.notifications.map((n) => n.text).join("\n") + h.notes(), /stopped/);
  // resume clears both flags
  await h.command("renew resume");
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).stopped, false);
  // no pending marker => the cancel hook leaves human-initiated switches alone
  const results = await h.pi.emit({ type: "session_before_switch", reason: "new" } as never, h.mc.ctx as never);
  assert.ok((h.pi.handlers.get("session_before_switch") ?? []).length > 0, "cancel hook registered");
  assert.ok(results.every((r) => r === undefined), "human switch is NEVER cancelled by the guard", JSON.stringify(results));
  // and with a GUARD-pending switch + stop set, it DOES cancel:
  // (simulate the pending window by driving the internal marker through a tool-less
  // renewal attempt that stalls on newSession cancellation)
  const mc3 = createMockCtx({ cwd: "/project", sessionId: "session-A3", cancelNewSession: true });
  await h.pi.runCommand("handoff", "renew cancelled hop", mc3.ctx);
  const midPending = await h.pi.emit({ type: "session_before_switch", reason: "new" } as never, mc3.ctx);
  // pending was consumed by the cancelled hop's rollback; the result above must not cancel
  assert.ok(midPending.every((r) => r === undefined), "after rollback no phantom pending remains");
  assert.equal(mc3.newSessionCalls, 1);
  assert.equal(mc3.recoverySends.length, 0, "cancelled switch never sends the recovery turn");
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).renewalsDone, 0, "cap rolled back on cancellation (no switch happened)");
});

test("RB5: model bridge — tool fires the dispatch WITHOUT switching inside execute; the dispatched command switches (trigger model)", async () => {
  const h = harness({ env: { CONTEXT_GUARD_AUTO_RENEW: "1" } }); // enables renewal + autoRenew for the process
  await h.start();
  const tool = h.pi.tools.get("handoff_renew");
  assert.ok(tool, "handoff_renew registered as a tool");
  assert.equal(tool.parameters.type, "object", "parameters is a plain JSON Schema object (A-21: pi accepts non-TypeBox schemas)");
  assert.ok(tool.parameters.properties.notes);
  const result = await tool.execute("tc-1", { notes: "context nearly gone" }, undefined, undefined, h.mc.ctx);
  assert.equal(result.details.ok, true);
  assert.match(result.content[0].text, /renewal SCHEDULED/);
  // fire-and-forget bridge (A-19/P-8): dispatched, but NOTHING switched yet (no deadlock)
  assert.equal(h.pi.userMessages.length, 1);
  assert.equal(h.pi.userMessages[0].content, "/handoff renew go context nearly gone");
  assert.equal(h.pi.userMessages[0].options.expandPromptTemplates, true);
  assert.equal(h.mc.newSessionCalls, 0, "the tool must never await the switch inside execute");
  // the RPC host now runs the dispatched command (the real runtime executes it at dispatch;
  // the command's own waitForIdle provides the safe boundary after this turn):
  await h.command("renew go context nearly gone");
  assert.equal(h.mc.newSessionCalls, 1);
  assert.match(h.mc.recoverySends[0].message.content, /context nearly gone/);
  const st = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(st.renewalsDone, 1);
});

test("RB6: autoRenew off => the model path refuses (with no tree writes) but the operator path still works", async () => {
  const h = harness(); // enabled true, autoRenew FALSE (fixture default)
  await h.start();
  const tool = h.pi.tools.get("handoff_renew");
  const res = await tool.execute("tc-1", {}, undefined, undefined, h.mc.ctx);
  assert.equal(res.details.ok, false);
  assert.equal(res.details.why, "auto-disabled");
  assert.equal(h.pi.userMessages.length, 0);
  assert.equal(h.mc.newSessionCalls, 0);
  await h.command("renew");
  assert.equal(h.mc.newSessionCalls, 1, "operator path unaffected by autoRenew=false");
});

test("RB7: cap — the third renewal in a chain of max 2 is refused durably", async () => {
  const h = harness();
  await h.start();
  await succeedRenewal(h);
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-A.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-B" }).ctx as never);
  h.memFs.writeFile("/project/LEARNINGS.md", DEFAULT_FILES["/project/LEARNINGS.md"] + "\n- [A-98] more discoveries. evidence: rb7. confidence: high. adopted: no\n");
  const ctxB = createMockCtx({ cwd: "/project", sessionId: "session-B" });
  await h.pi.runCommand("handoff", "renew hop 2", ctxB.ctx);
  assert.equal(ctxB.newSessionCalls, 1);
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-B.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-C" }).ctx as never);
  h.memFs.writeFile("/project/LEARNINGS.md", DEFAULT_FILES["/project/LEARNINGS.md"] + "\n- [A-97] even more. evidence: rb7. confidence: high. adopted: no\n");
  const ctxC = createMockCtx({ cwd: "/project", sessionId: "session-C" });
  await h.pi.runCommand("handoff", "renew hop 3", ctxC.ctx);
  assert.match(ctxC.notifications.map((n) => n.text).join("\n"), /renewal NOT performed \(capped\)/);
  assert.equal(ctxC.newSessionCalls, 0, "renewal cap respected ACROSS sessions");
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).renewalsDone, 2);
});

test("RB8: authorization gate — attestation refusal aborts the renewal and blocks the switch", async () => {
  // HANDOFF without a manual "## Next action" section => next-action-recorded FAILS
  const noNext = { ...DEFAULT_FILES, "/project/handoff.config.json": renewConfig(), "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nok\n\n## Unfinished operations\n- [ ] x\n\n## Discoveries not yet incorporated\n- (none)\n" };
  const h = harness({ files: noNext });
  await h.start();
  await h.command("renew");
  assert.match(h.notes(), /renewal ABORTED — attestation refused/);
  assert.match(h.notes(), /next-action-recorded/);
  assert.equal(h.mc.newSessionCalls, 0);
});

test("RB9: read-only audit mode — renewal refused, zero writes to the audited tree", async () => {
  const h = harness({ config: renewConfig(), env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/tmp/guard-rb9" } });
  await h.start();
  await h.command("renew");
  assert.match(h.notes(), /renewal NOT performed \(read-only\)/);
  assert.equal(h.mc.newSessionCalls, 0);
  assert.ok(!h.memFs.writes.some((w) => w.startsWith("/project/")), "read-only mode performs zero writes inside the project tree");
});

test("RB10: status reports policy + durable chain; authorization text reflects the live gate", async () => {
  const h = harness();
  await h.start();
  await h.command("renew status");
  const t = h.notes();
  assert.match(t, /policy: enabled=true autoRenew=false maxRenewals=2/);
  assert.match(t, /renewalsDone=0\/2/);
  await succeedRenewal(h);
  await h.command("renew status");
  assert.match(h.notes(), /renewalsDone=1\/2/);
  assert.match(h.notes(), /not authorized — checkpoint g1.*already|lastFrom=g\d/);
});

test("RB11: identity banner — runtime-derived, operator-visible AND model-delivered before first inference", async () => {
  const h = harness();
  const c = await h.start();
  const id = h.pi.sentMessages.find((m) => m.message.customType === "context-guard-identity");
  assert.ok(id, "identity custom message delivered");
  assert.equal(id!.options.triggerTurn, false, "appended without starting a turn (A-13: in context before the next inference)");
  assert.match(id!.message.content, /session: session-A/);
  assert.match(id!.message.content, /project: project \(\/project\)/);
  assert.match(id!.message.content, /start: startup/);
  assert.match(id!.message.content, /harness: pi \d+\.\d+\.\d+|harness: pi unknown/, "version is DETECTED, never invented (unknown when unresolvable)");
  assert.ok(c.notifications.some((n) => /context-guard identity/.test(n.text)), "also visible to the operator (notified on the session_start context)");
});

test("RB12: detectPiHarness walks up to the REAL package.json (no invented values)", () => {
  const f = {
    readFile: (p: string) => (p === "/opt/pi-x/package.json" ? JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }) : undefined),
    realpath: (p: string) => (p === "/usr/bin/pi" ? "/opt/pi-x/dist/bundle/cli.js" : p),
  };
  assert.deepEqual(detectPiHarness(f as never, "/usr/bin/pi"), { version: "9.9.9", pkgDir: "/opt/pi-x" });
  assert.deepEqual(detectPiHarness(f as never, "/elsewhere/script.js"), { version: "unknown", pkgDir: null });
  assert.deepEqual(detectPiHarness(f as never, undefined), { version: "unknown", pkgDir: null });
  // NOTE: inside `node --test`, argv[1] is the test file, NOT the pi CLI — detection
  // correctly returns "unknown" there (no invented values). Live detection against the
  // real install is asserted in scripts/e2e-renew.mjs (identity banner carries the
  // actual pi version from `pi --mode rpc`).
});

test("RB13: simulated process restart — durable cap/idempotence/stop survive (module state is per-process; the FILE is the truth)", async () => {
  const h = harness();
  await h.start();
  const cpId = await succeedRenewal(h);
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-A.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-B" }).ctx as never);
  // new factory invocation on the SAME memory fs = restart; the old checkpoint is still
  // the only current one, so the idempotence key loaded from disk must block a re-switch.
  const h2 = harnessForRestart(h.memFs);
  await h2.start("session-B2");
  const mc2 = h2.mc;
  await h2.command("renew");
  assert.match(mc2.notifications.map((n) => n.text).join("\n"), /already-renewed/);
  assert.equal(mc2.newSessionCalls, 0);
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).renewalsDone, 1, "cap counter survived the restart");
  assert.ok(cpId);
});

function harnessForRestart(memFs: MemoryFs): RH {
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-B2", usage: { tokens: 1000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: memFs, env: {} });
  return {
    pi,
    memFs,
    mc,
    async start(sessionId = "session-B2", extra = {}) {
      const ctx = createMockCtx({ cwd: "/project", sessionId, usage: { tokens: 1000, contextWindow: 220000 } });
      await pi.emit({ type: "session_start", reason: "startup", ...extra } as never, ctx.ctx as never);
      return ctx;
    },
    async command(args) {
      await pi.runCommand("handoff", args, mc.ctx);
    },
    notes: () => mc.notifications.map((n) => n.text).join("\n"),
  };
}
