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
import { attestHandoff, joinPath, validateCheckpoint, renewAuthorization, writeCheckpoint } from "../.pi/extensions/context-guard/checkpoint.ts";
import { buildRecoveryPrompt } from "../.pi/extensions/context-guard/renewal.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs, type MockPi, type MockCtxOptions } from "./helpers.ts";

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

function harness(opts: { config?: string; env?: Record<string, string | undefined>; files?: Record<string, string>; mcOptions?: MockCtxOptions } = {}): RH {
  const memFs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": opts.config ?? renewConfig(), ...opts.files });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-A", usage: { tokens: 1000, contextWindow: 220000 }, ...opts.mcOptions });
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

  // Consume the pending marker via successor session_start. The inherited checkpoint
  // id is used already, but this recorded successor can create a fresh no-delta id.
  await h.pi.emit({ type: "session_start", reason: "new", previousSessionFile: "/sessions/session-A.jsonl" } as never, createMockCtx({ cwd: "/project", sessionId: "session-B" }).ctx as never);
  const ctxB = createMockCtx({ cwd: "/project", sessionId: "session-B" });
  await h.pi.runCommand("handoff", "renew again", ctxB.ctx);
  assert.equal(ctxB.newSessionCalls, 1, "the authorized successor can continue without fabricating a prose edit");
  const next = validateCheckpoint(h.memFs, "/project", FILES);
  assert.equal(next.kind, "current");
  assert.equal(next.contentDelta, "none");
  assert.equal(next.readiness.state, "attested");
  assert.notEqual(next.identity!.id, cpId, "the consumed id is never reused");
  const nextChain = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(nextChain.renewalsDone, 2);
  assert.equal(nextChain.renewedFromCheckpointId, next.identity!.id);
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

test("RB16 (#1): recorded successor can renew an unchanged research checkpoint once, with a fresh attested id", async () => {
  const h = harness({ config: renewConfig({ autoRenew: true, maxRenewals: 8 }) });
  const initial = writeCheckpoint(h.memFs, {
    cwd: "/project", files: FILES, level: 0, sessionId: "session-parent", remaining: 50000,
    goalDrift: false, lastVerifiedState: "verified", unfinishedOperations: [],
    nextAction: "Continue the active research phase.", recoveryInstructions: [],
  });
  assert.ok(initial.ok, initial.errors.join("; "));
  assert.ok(attestHandoff(h.memFs, "/project", FILES, { sessionId: "session-parent" }).ok);
  const previousId = validateCheckpoint(h.memFs, "/project", FILES).identity!.id;
  const oldChain = JSON.stringify({
    version: 1, chainId: "chain:active", renewalsDone: 1, renewedFromCheckpointId: previousId,
    lastSuccessorSessionId: "session-successor", stopped: false, updatedAt: 1,
  }, null, 2) + "\n";
  h.memFs.writeFile(STATE, oldChain);
  const successor = await h.start("session-successor");
  const tool = h.pi.tools.get("handoff_renew");
  const first = await tool.execute("tc-first", {}, undefined, undefined, successor.ctx);
  assert.equal(first.details.ok, true);
  assert.match(first.content[0].text, /renewal SCHEDULED/);
  const fresh = validateCheckpoint(h.memFs, "/project", FILES);
  assert.equal(fresh.kind, "current");
  assert.notEqual(fresh.identity!.id, previousId, "the consumed checkpoint id is never reused");
  assert.equal(fresh.contentDelta, "none", "read-only research can advance the checkpoint identity without fake content edits");
  assert.equal(fresh.readiness.state, "attested");
  assert.equal(h.memFs.files.get(STATE), oldChain, "tool preparation does not consume chain capacity before the switch path");
  assert.equal(h.pi.userMessages.length, 1);

  const afterFirstWrites = h.memFs.writes.length;
  const repeated = await tool.execute("tc-second", {}, undefined, undefined, successor.ctx);
  assert.equal(repeated.details.ok, false);
  assert.equal(repeated.details.why, "pending");
  assert.equal(h.pi.userMessages.length, 1, "repeated/concurrent tool requests dispatch only once");
  assert.equal(h.memFs.writes.length, afterFirstWrites, "the refused duplicate performs no writes");

  await h.pi.runCommand("handoff", "renew go", successor.ctx);
  assert.equal(successor.newSessionCalls, 1);
  const chain = JSON.parse(h.memFs.files.get(STATE)!);
  assert.equal(chain.renewalsDone, 2);
  assert.equal(chain.renewedFromCheckpointId, fresh.identity!.id);
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
  // A real section with a placeholder passes structural validation but fails readiness.
  const placeholder = { ...DEFAULT_FILES, "/project/handoff.config.json": renewConfig(), "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nok\n\n## Unfinished operations\n- [ ] x\n\n## Next action\nTODO\n\n## Discoveries not yet incorporated\n- (none)\n" };
  const h = harness({ files: placeholder });
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

test("RB14 (A-26 regression): configured recoveryPrompt + testCommand reach the EXACT message sent to the successor", async () => {
  const custom = "CUSTOM-PROJECT RECOVERY: read spec/CLAIMS.md authority notes before any edit.";
  const h = harness({
    config: JSON.stringify({
      thresholds: { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 },
      enforceClosing: true,
      closingAllowlist: ["write", "edit", "read", "handoff_renew"],
      protectGoal: true,
      autoCheckpointAtHandoffLevel: true,
      stateDir: ".pi-guard",
      renewal: { enabled: true, autoRenew: false, maxRenewals: 2, recoveryPrompt: custom, testCommand: "node scripts/check-skill-discovery.mjs" },
    }),
  });
  await h.start();
  await h.command("renew");
  assert.equal(h.mc.recoverySends.length, 1);
  const content = h.mc.recoverySends[0].message.content as string;
  // configured text reaches the ACTUAL message, verbatim
  assert.ok(content.includes(custom), "configured recoveryPrompt is carried verbatim into the successor message");
  assert.ok(content.includes("node scripts/check-skill-discovery.mjs"), "project-configured test command reaches the message");
  assert.ok(!content.includes("node --test test/"), "no unconditional generic test command");
  assert.ok(!content.includes("in this order (PROTOCOL \u00a73)"), "generic body replaced by the configured prompt");
  // mandatory identity + safety survive
  const f = validateCheckpoint(h.memFs, "/project", FILES);
  assert.ok(content.includes("[context-guard renewal 1/2]"));
  assert.ok(content.includes("session-A") && content.includes("chain:session-A") && content.includes(f.identity!.id));
  assert.ok(/NOT replayed/.test(content) && /NO compaction/.test(content) && /never push without human authorization/.test(content));
  // EXACT message: byte-identical to what buildRecoveryPrompt produces from the same inputs
  const expected = buildRecoveryPrompt({
    files: FILES,
    checkpointId: f.identity!.id,
    chainId: "chain:session-A",
    renewalIndex: 1,
    maxRenewals: 2,
    parentSessionId: "session-A",
    recoveryPrompt: custom,
    testCommand: "node scripts/check-skill-discovery.mjs",
  });
  assert.equal(content, expected, "the message sent is exactly the deterministic prompt");
});

test("RB15: without a configured testCommand the successor message carries NO build-verify line (generic body kept)", async () => {
  const h = harness(); // renewConfig(): renewal enabled, no testCommand
  await h.start();
  await h.command("renew");
  const content = h.mc.recoverySends[0].message.content as string;
  assert.ok(!/verify the build/i.test(content));
  assert.ok(!content.includes("node --test test/"));
  assert.ok(content.includes("in this order (PROTOCOL \u00a73)"), "generic recovery body still used when no custom prompt");
});

test("LB5: --task-file sends faithful Markdown in one user-role turn and leaves durable docs unchanged", async () => {
  const task = `Nouvelle mission : analyse le jalon.\n\n  garder cette indentation\n\n- vérifier Unicode : café, 東京\n\n\`\`\`python\nprint("exact\")\n\`\`\`\n`;
  const configObject = JSON.parse(renewConfig({ successorTurn: "user", maxRenewals: 8, recoveryPrompt: "CUSTOM RECOVERY BODY", testCommand: "node --test test/" }));
  configObject.recovery = { lean: true, budgetTokens: 9000 };
  const h = harness({
    config: JSON.stringify(configObject),
    files: { "/project/missions/next mission.md": task },
  });
  await h.start();
  await h.command("checkpoint stable durable action");
  await h.command("ready");
  const beforeHandoff = h.memFs.files.get("/project/HANDOFF.md");
  const beforeProgress = h.memFs.files.get("/project/PROGRESS.md");
  await h.command('renew predecessor note --task-file "missions/next mission.md"');

  assert.equal(h.mc.newSessionCalls, 1);
  assert.equal(h.mc.recoveryUserSends.length, 1);
  assert.equal(h.mc.recoverySends.length, 1, "one non-triggering machine-origin marker is inspectable in the transcript");
  assert.equal(h.mc.recoverySends[0].options.triggerTurn, false);
  assert.equal(h.mc.recoverySends[0].message.customType, "context-guard-continuation-origin");
  assert.equal(h.mc.recoverySends[0].message.details.origin, "context-guard-extension");
  assert.equal(h.mc.recoverySends[0].message.details.operatorTaskPresent, true);
  const userTurn = h.mc.recoveryUserSends[0].content;
  assert.ok(userTurn.startsWith("[PI HANDOFF — AUTOMATED SESSION CONTINUATION]"));
  assert.ok(userTurn.includes("This user-role message was generated by the Handoff extension, not typed by a human."));
  assert.ok(userTurn.includes("CUSTOM RECOVERY BODY"));
  assert.ok(userTurn.includes("Then verify the build before touching code: node --test test/"));
  assert.ok(userTurn.includes(`[OPERATOR-SUPPLIED TASK —`));
  assert.ok(userTurn.includes(`--- BEGIN OPERATOR TASK ---\n${task}\n--- END OPERATOR TASK ---`), "multiline task is byte-for-byte present inside the prompt");
  assert.ok(userTurn.includes("Notes from the predecessor: predecessor note"));
  assert.equal(h.memFs.files.get("/project/HANDOFF.md"), beforeHandoff);
  assert.equal(h.memFs.files.get("/project/PROGRESS.md"), beforeProgress);
  assert.equal(h.memFs.files.get("/project/missions/next mission.md"), task);
  assert.ok(!h.memFs.files.get("/project/HANDOFF.md")!.includes("Nouvelle mission"));
  assert.ok(!h.memFs.files.get("/project/PROGRESS.md")!.includes("Nouvelle mission"));
  for (const [path, content] of h.memFs.files) {
    if (path.endsWith("diagnostics.jsonl")) assert.ok(!content.includes("Nouvelle mission"), "mission bodies are never recorded in diagnostics");
  }
});

test("LB6: default custom mode remains one custom trigger and carries --task separately", async () => {
  const h = harness();
  await h.start();
  await h.command('renew --task "Continue with the authorized new mission"');
  assert.equal(h.mc.newSessionCalls, 1);
  assert.equal(h.mc.recoverySends.length, 1);
  assert.equal(h.mc.recoverySends[0].options.triggerTurn, true);
  assert.equal(h.mc.recoveryUserSends.length, 0);
  assert.match(h.mc.recoverySends[0].message.content, /\[OPERATOR-SUPPLIED TASK/);
  assert.match(h.mc.recoverySends[0].message.content, /Continue with the authorized new mission/);
  assert.equal(h.mc.recoverySends[0].message.details.operatorTaskPresent, true);
});

test("LB6b: stale checkpoint refresh keeps task out of managed blocks and sends it to the successor", async () => {
  const h = harness({ config: renewConfig({ successorTurn: "user" }) });
  await h.start();
  await h.command("checkpoint old durable action");
  await h.command("ready");
  h.memFs.files.set("/project/PROGRESS.md", `${h.memFs.files.get("/project/PROGRESS.md")}\nOperator-independent finding.\n`);
  assert.equal(validateCheckpoint(h.memFs, "/project", FILES).kind, "stale");
  const task = "Fresh task on an updated checkpoint";
  await h.command(`renew --task "${task}"`);
  assert.equal(h.mc.newSessionCalls, 1);
  assert.equal(h.mc.recoveryUserSends.length, 1);
  assert.ok(h.mc.recoveryUserSends[0].content.includes(task));
  const refreshed = validateCheckpoint(h.memFs, "/project", FILES);
  assert.equal(refreshed.kind, "current");
  assert.equal(refreshed.readiness.state, "attested");
  assert.ok(!h.memFs.files.get("/project/HANDOFF.md")!.includes(task));
  assert.ok(!h.memFs.files.get("/project/PROGRESS.md")!.includes(task));
});

test("LB7: task-file traversal and symlink escapes are refused before renewal", async () => {
  const h = harness({ files: { "/outside/secret.md": "do not read me", "/project/escape.md": "link" } });
  h.memFs.realPaths.set("/project/escape.md", "/outside/secret.md");
  await h.start();
  const writesBefore = [...h.memFs.writes];
  await h.command('renew --task-file "../outside/secret.md"');
  await h.command("renew --task-file escape.md");
  assert.equal(h.mc.newSessionCalls, 0);
  assert.equal(h.mc.recoverySends.length + h.mc.recoveryUserSends.length, 0);
  assert.deepEqual(h.memFs.writes, writesBefore, "unsafe path refusals happen before checkpoint or chain writes");
  assert.match(h.notes(), /inside the project directory|symlink escapes are refused/);
});

test("LB7b: an in-project symlink to a task file is read through its verified canonical target", async () => {
  const task = "Read-only internal mission\n  with exact indentation\n";
  const h = harness({
    config: renewConfig({ successorTurn: "user" }),
    files: { "/project/mission-source.md": task, "/project/mission-link.md": "symlink" },
  });
  h.memFs.realPaths.set("/project/mission-link.md", "/project/mission-source.md");
  await h.start();
  await h.command("renew --task-file mission-link.md");
  assert.equal(h.mc.newSessionCalls, 1);
  assert.ok(h.mc.recoveryUserSends[0].content.includes(`--- BEGIN OPERATOR TASK ---\n${task}\n--- END OPERATOR TASK ---`));
});

test("LB8: malformed, empty and over-limit missions fail before checkpointing", async () => {
  const h = harness({ files: {
    "/project/blank.md": " \n \t",
    "/project/oversize.md": "x".repeat(64 * 1024 + 1),
  } });
  await h.start();
  const writesBefore = [...h.memFs.writes];
  await h.command("renew --task unquoted mission");
  await h.command('renew --task "   "');
  await h.command(`renew --task "${"x".repeat(64 * 1024 + 1)}"`);
  await h.command("renew --task-file blank.md");
  await h.command("renew --task-file oversize.md");
  assert.equal(h.mc.newSessionCalls, 0);
  assert.deepEqual(h.memFs.writes, writesBefore);
  assert.match(h.notes(), /quoted value/);
  assert.match(h.notes(), /operator task is empty/);
  assert.match(h.notes(), /maximum is 65536 bytes/);
  assert.match(h.notes(), /exceeds the 65536-byte/);
});

test("LB9: stopped, capped, read-only and impossible-attestation refusals do not dispatch the task", async () => {
  const taskArg = 'renew --task "pending operator task"';
  const stopped = harness();
  await stopped.start();
  await stopped.command("renew stop");
  await stopped.command(taskArg);
  assert.equal(stopped.mc.newSessionCalls, 0);
  assert.equal(stopped.mc.recoverySends.length, 0);
  assert.ok(!stopped.memFs.files.get("/project/HANDOFF.md")!.includes("pending operator task"));

  const capped = harness({ config: renewConfig({ maxRenewals: 0 }) });
  await capped.start();
  await capped.command(taskArg);
  assert.equal(capped.mc.newSessionCalls, 0);

  const audit = harness({ env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/outside/guard-audit" } });
  await audit.start();
  await audit.command(taskArg);
  assert.equal(audit.mc.newSessionCalls, 0);
  assert.ok(!audit.memFs.files.get("/project/HANDOFF.md")!.includes("pending operator task"));

  const notReady = harness({ files: {
    "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nok\n\n## Unfinished operations\n- [ ] x\n\n## Next action\nTODO\n\n## Discoveries not yet incorporated\n- (none)\n",
  } });
  await notReady.start();
  await notReady.command(taskArg);
  assert.equal(notReady.mc.newSessionCalls, 0);
  assert.equal(notReady.mc.recoverySends.length, 0);
  assert.ok(!notReady.memFs.files.get("/project/HANDOFF.md")!.includes("pending operator task"));
});

test("LB10: cancellation and a failed user-turn send never fall back to a second trigger", async () => {
  const cancelled = harness({ config: renewConfig({ successorTurn: "user" }), mcOptions: { cancelNewSession: true } });
  await cancelled.start();
  await cancelled.command('renew --task "not consumed on cancel"');
  assert.equal(cancelled.mc.newSessionCalls, 1);
  assert.equal(cancelled.mc.recoveryUserSends.length, 0);
  assert.equal(cancelled.mc.recoverySends.length, 0);
  assert.equal(JSON.parse(cancelled.memFs.files.get(STATE)!).renewalsDone, 0);

  const failed = harness({ config: renewConfig({ successorTurn: "user" }), mcOptions: { successorSendReject: "user" } });
  await failed.start();
  await failed.command('renew --task "only once"');
  assert.equal(failed.mc.newSessionCalls, 1);
  assert.equal(failed.mc.recoveryUserSends.length, 1);
  assert.equal(failed.mc.recoverySends.length, 1);
  assert.equal(failed.mc.recoverySends[0].options.triggerTurn, false, "no custom-trigger fallback after user send failure");
  assert.match(failed.mc.notifications.map((n) => n.text).join("\n"), /recovery turn FAILED to start/);
});

test("LB11: simultaneous renewal requests schedule one successor and one first turn", async () => {
  const h = harness({ config: renewConfig({ successorTurn: "user" }) });
  await h.start();
  await Promise.all([
    h.command('renew --task "one mission"'),
    h.command('renew --task "one mission"'),
  ]);
  assert.equal(h.mc.newSessionCalls, 1);
  assert.equal(h.mc.recoveryUserSends.length, 1);
  assert.equal(h.mc.recoverySends.length, 1);
  assert.equal(h.mc.recoverySends[0].options.triggerTurn, false);
  assert.equal(JSON.parse(h.memFs.files.get(STATE)!).renewalsDone, 1);
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
