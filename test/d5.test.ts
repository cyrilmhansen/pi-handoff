/**
 * dev.2 D5: honest closing guidance + honest renewal hint + structured diagnostics.
 *
 * Mission requirements (DRPLi campaign audit):
 *  (a) the level-4 alert must NOT claim blocking when enforceClosing:false —
 *      defaultThresholds is parameterized and the adapter passes the config;
 *  (b) "RENEWAL AVAILABLE" appears ONLY when a full WRITE-FREE preview of the real gate
 *      passes (decideRenewal + live checkpoint identity + renewAuthorization + durable
 *      stop + cap + read-only + pending); otherwise the model gets safe instructions,
 *      including handoff_finalize at the cap (P-10: attribution, no speculation);
 *  (c) structured diagnostics <stateDir>/diagnostics.jsonl — bounded, typed events,
 *      NO prompts/tool args/secrets, rotation ~500, audit mode external-stateDir rule,
 *      /guard events [n]; agent_settled.aborted is RECORDED, never auto-retried;
 *  (d) identity banner carries GUARD_VERSION instead of the hardcoded "Phase 2
 *      increment B" label (P-9).
 *
 * All deterministic, memory fs, zero inference.
 */

import test from "node:test";
import assert from "node:assert/strict";

import contextGuard, { DEFAULT_GUARD_VERSION, guardVersion } from "../.pi/extensions/context-guard/index.ts";
import { defaultThresholds } from "../.pi/extensions/context-guard/core.ts";
import {
  DIAGNOSTICS_FILE,
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTIC_TYPES,
  appendDiagnostic,
  buildDiagnosticEvent,
  diagnosticsPath,
  recentDiagnostics,
} from "../.pi/extensions/context-guard/diagnostics.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs, type MockPi } from "./helpers.ts";

const T = { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 };
const STATE = "/project/.pi-guard/renewal-state.json";
const DIAG = "/project/.pi-guard/" + DIAGNOSTICS_FILE;

function cfg(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    thresholds: T,
    enforceClosing: true,
    closingAllowlist: ["write", "edit", "read", "handoff_renew"],
    protectGoal: true,
    autoCheckpointAtHandoffLevel: true,
    stateDir: ".pi-guard",
    ...over,
  });
}

function stateSeed(s: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, chainId: "chain:seed", renewalsDone: 0, renewedFromCheckpointId: null, lastSuccessorSessionId: null, stopped: false, updatedAt: 5, ...s });
}

interface DH {
  pi: MockPi;
  memFs: MemoryFs;
  mc: ReturnType<typeof createMockCtx>;
  start: (sessionId?: string) => Promise<void>;
  command: (name: string, args: string, ctx?: any) => Promise<void>;
  turnEnd: (ctx?: any) => Promise<void>;
  alerts: () => string;
  diag: () => string;
  notifications: () => string;
}

function harness(opts: { config?: string; env?: Record<string, string | undefined>; files?: Record<string, string> } = {}): DH {
  const memFs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": opts.config ?? cfg(), ...opts.files });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-D5", usage: { tokens: 1000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: memFs, env: opts.env ?? {} });
  const text = (m: any): string => (typeof m.message.content === "string" ? m.message.content : (m.message.content ?? []).map((c: any) => c.text ?? String(c)).join(" "));
  return {
    pi,
    memFs,
    mc,
    async start(sessionId = "session-D5") {
      const ctx = createMockCtx({ cwd: "/project", sessionId, usage: { tokens: 1000, contextWindow: 220000 } });
      await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    },
    async command(name, args, ctx) {
      await pi.runCommand(name, args, ctx ?? mc.ctx);
    },
    async turnEnd(ctx) {
      await pi.emit({ type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never, ctx ?? mc.ctx);
    },
    alerts: () => pi.sentMessages.filter((m) => m.message.customType === "context-guard").map(text).join("\n"),
    diag: () => memFs.files.get(DIAG) ?? "",
    notifications: () => mc.notifications.map((n) => n.text).join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* (a) level-4 wording under enforceClosing                            */
/* ------------------------------------------------------------------ */

test("D5a1 (pure): defaultThresholds(t,{enforceClosing:false}) makes level 4 ADVISORY and never claims blocking", () => {
  const th = defaultThresholds(T, { enforceClosing: false });
  const l4 = th.find((t) => t.level === 4)!;
  assert.equal(l4.kind, "advisory", "without enforcement level 4 is not 'enforced'");
  assert.match(l4.guidance, /enforcement is disabled/i);
  assert.ok(!/are blocked|allowlist are blocked/i.test(l4.guidance), `must not claim blocking: ${l4.guidance}`);
  // still useful closing guidance (G1 contract kept for BOTH variants)
  assert.match(l4.guidance, /do not start new experiments/i);
  assert.match(l4.guidance, /stop/i);
  assert.match(l4.guidance, /LEARNINGS\.md/);
  assert.match(l4.guidance, /valid/i);
  assert.ok(l4.guidance.length <= 700 && !/\n/.test(l4.guidance), "one bounded paragraph (G2 contract)");
});

test("D5a2 (pure): the DEFAULT (enforceClosing true / omitted) keeps the enforced wording — backwards compatible", () => {
  const a = defaultThresholds(T).find((t) => t.level === 4)!;
  const b = defaultThresholds(T, { enforceClosing: true }).find((t) => t.level === 4)!;
  assert.equal(a.kind, "enforced");
  assert.equal(b.kind, "enforced");
  assert.match(a.guidance, /blocked/i);
});

test("D5a3 (adapter): L4 alert with enforceClosing:false does NOT claim tools are blocked, and the gate really stays open", async () => {
  const h = harness({ config: cfg({ enforceClosing: false }), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "4000" } });
  await h.start();
  await h.turnEnd();
  const alert = h.alerts();
  assert.ok(alert.includes("CONTEXT CRITICAL"), "level 4 still alerts loudly");
  assert.match(alert, /enforcement is disabled/i);
  assert.ok(!/are blocked/i.test(alert), `alert must not claim blocking: ${alert}`);
  const results = await h.pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "echo hi" } } as never, h.mc.ctx as never);
  assert.ok(results.every((r: any) => !r || r.block !== true), "bash is NOT gated when enforceClosing is false");
});

test("D5a4 (adapter): L4 alert with enforceClosing:true claims blocking AND the gate blocks bash (pair for the wording)", async () => {
  const h = harness({ env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "4000" } });
  await h.start();
  await h.turnEnd();
  const alert = h.alerts();
  assert.match(alert, /enforced/i);
  assert.match(alert, /blocked/i);
  const results = await h.pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "echo hi" } } as never, h.mc.ctx as never);
  assert.ok(results.some((r: any) => r?.block === true), "bash IS gated when enforceClosing is true");
});

/* ------------------------------------------------------------------ */
/* (b) honest RENEWAL AVAILABLE behind a write-free preview            */
/* ------------------------------------------------------------------ */

const renewCfg = (over: Record<string, unknown> = {}) => cfg({ renewal: { enabled: true, autoRenew: true, maxRenewals: 2, testCommand: "node --test test/" }, ...over });

test("D5b1: hint shows RENEWAL AVAILABLE only when the full preview passes (enabled+autoRenew+current+attested+under cap+not stopped+not pending)", async () => {
  const h = harness({ config: renewCfg(), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.command("handoff", "finalize state is current; awaiting renewal");
  await h.turnEnd();
  const alert = h.alerts();
  assert.match(alert, /RENEWAL AVAILABLE:/);
  assert.match(alert, /0\/2/);
  assert.ok(!/RENEWAL NOT AVAILABLE/.test(alert));
  assert.equal(h.mc.newSessionCalls, 0, "a hint is guidance, never a transition");
});

test("D5b2: at the cap the alert says NOT AVAILABLE (capped) and names handoff_finalize — no false promise", async () => {
  const h = harness({ config: renewCfg(), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" }, files: { [STATE]: stateSeed({ renewalsDone: 2, renewedFromCheckpointId: "g5-aaaaaaaaaaaa" }) } });
  await h.start();
  await h.command("handoff", "finalize final increment before closing");
  const stateBefore = h.memFs.files.get(STATE)!;
  await h.turnEnd();
  const alert = h.alerts();
  assert.ok(!/RENEWAL AVAILABLE:/.test(alert), "cap-exhausted chain must NOT advertise renewal");
  assert.match(alert, /RENEWAL NOT AVAILABLE \(capped\)/);
  assert.match(alert, /handoff_finalize/);
  assert.match(alert, /2\/2/);
  assert.equal(h.memFs.files.get(STATE), stateBefore, "the preview is WRITE-FREE: chain state byte-identical");
  assert.equal(h.mc.newSessionCalls, 0);
});

test("D5b3: unattested/missing checkpoint => NOT AVAILABLE (not-authorized) with refresh + attest instructions", async () => {
  const h = harness({ config: renewCfg({ autoCheckpointAtHandoffLevel: false }), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.turnEnd(); // no checkpoint exists, never attested
  const alert = h.alerts();
  assert.ok(!/RENEWAL AVAILABLE:/.test(alert));
  assert.match(alert, /RENEWAL NOT AVAILABLE \(not-authorized\)/);
  assert.match(alert, /\/handoff/);
  assert.match(alert, /\/handoff ready|attest/i);
});

test("D5b4: durable operator stop => NOT AVAILABLE (stopped) with resume + finalize instructions; preview still write-free", async () => {
  const h = harness({ config: renewCfg(), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" }, files: { [STATE]: stateSeed({ stopped: true, renewalsDone: 1 }) } });
  await h.start();
  await h.command("handoff", "finalize under stop");
  const before = h.memFs.files.get(STATE)!;
  await h.turnEnd();
  const alert = h.alerts();
  assert.match(alert, /RENEWAL NOT AVAILABLE \(stopped\)/);
  assert.match(alert, /resume/i);
  assert.match(alert, /handoff_finalize/);
  assert.equal(h.memFs.files.get(STATE), before);
});

test("D5b5: autoRenew:false stays SILENT — projects without the model path see no renewal chatter at all", async () => {
  const h = harness({ config: cfg({ renewal: { enabled: true, autoRenew: false, maxRenewals: 2 } }), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.command("handoff", "finalize");
  await h.turnEnd();
  const alert = h.alerts();
  assert.ok(!/RENEWAL/.test(alert), `no renewal lines when the model path is off: ${alert}`);
});

/* ------------------------------------------------------------------ */
/* (c) diagnostics: pure module                                        */
/* ------------------------------------------------------------------ */

test("DG1 (pure): events carry ISO+epoch and a TYPE allowlist; unknown types refused; unknown fields DROPPED; strings bounded", () => {
  const e = buildDiagnosticEvent("alert", { level: 3, crossed: ["prioritize-handoff"], remaining: 9000, boundary: "turn_end", promptText: "SECRET-USER-PROMPT", toolArgs: { command: "SECRET" } } as never, 1730260000000)!;
  assert.equal(e.type, "alert");
  assert.equal(e.epoch, 1730260000000);
  assert.equal(e.ts, new Date(1730260000000).toISOString());
  assert.ok("level" in e && "crossed" in e);
  assert.ok(!("promptText" in e) && !("toolArgs" in e), "unknown keys are dropped, NEVER persisted — no channel for prompts/args/secrets");
  assert.equal(buildDiagnosticEvent("exfiltrate_secrets", {}), null, "unknown type refused");
  const long = buildDiagnosticEvent("finalize", { detail: "x".repeat(500) }, 1)!;
  assert.ok((long as any).detail.length <= 300, "bounded strings");
  assert.deepEqual([...DIAGNOSTIC_TYPES].sort(), ["alert", "finalize", "renewal_request", "renewal_result", "revocation", "session_start", "tool_block", "turn_aborted"]);
});

test("DG2 (pure): append creates JSONL under stateDir; recent() round-trips", () => {
  const mem = createMemoryFs();
  const dir = "/proj/.pi-guard";
  assert.deepEqual(recentDiagnostics(mem, dir, 10), [], "no file yet -> empty, no throw");
  for (const level of [1, 2, 3]) assert.equal(appendDiagnostic(mem, dir, buildDiagnosticEvent("alert", { level }, 1000 + level)!).ok, true);
  const lines = mem.files.get(diagnosticsPath(dir))!.trim().split("\n");
  assert.equal(lines.length, 3);
  const recent = recentDiagnostics(mem, dir, 10);
  assert.deepEqual(recent.map((r) => r.level), [1, 2, 3]);
});

test("DG3 (pure): rotation keeps the LAST max entries", () => {
  const mem = createMemoryFs();
  const dir = "/proj/.pi-guard";
  for (let i = 1; i <= 8; i++) appendDiagnostic(mem, dir, buildDiagnosticEvent("alert", { level: i, detail: `e${i}` }, 1000 + i)!, 5);
  const recent = recentDiagnostics(mem, dir, 100);
  assert.deepEqual(recent.map((r) => r.detail), ["e4", "e5", "e6", "e7", "e8"], "oldest trimmed");
  assert.equal(DIAGNOSTICS_MAX_ENTRIES, 500);
});

test("DG4 (pure): corrupt lines are skipped, never thrown; tail order preserved", () => {
  const mem = createMemoryFs({ "/proj/.pi-guard/diagnostics.jsonl": '{"ts":"x","type":"alert","level":1}\nNOT-JSON{{\n{"ts":"y","type":"finalize","ok":true}\n{"type":"bogus"}\n' });
  const recent = recentDiagnostics(mem, "/proj/.pi-guard", 10);
  assert.equal(recent.length, 2, "only structurally valid allowlisted events");
  assert.deepEqual(recent.map((r) => r.type), ["alert", "finalize"]);
});

/* ------------------------------------------------------------------ */
/* (c) diagnostics: adapter integration                                */
/* ------------------------------------------------------------------ */

test("DG5: session_start and alert events are recorded with bounded fields (no prompt text anywhere)", async () => {
  const h = harness({ env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.turnEnd();
  const events = recentDiagnostics(h.memFs, "/project/.pi-guard", 50);
  assert.ok(events.some((e) => e.type === "session_start" && (e as any).level === 0), "session_start recorded");
  const alert = events.find((e) => e.type === "alert");
  assert.ok(alert && (alert as any).level === 3 && Array.isArray((alert as any).crossed), "alert recorded with level + crossed labels");
  assert.ok(!JSON.stringify(events).includes("SECRET"), "diagnostics carry no secrets by construction");
  assert.ok(!JSON.stringify(events).includes("systemPrompt"));
});

test("DG6: tool_block records the tool NAME and policy kind, never the arguments (secret scrub proof)", async () => {
  const h = harness({ env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "4000" } });
  await h.start();
  await h.turnEnd();
  await h.pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "echo SUPER-SECRET-ARG" } } as never, h.mc.ctx as never);
  await h.pi.emit({ type: "tool_call", toolName: "write", toolCallId: "t2", input: { path: "GOAL.md", content: "SECRET GOAL REWRITE" } } as never, h.mc.ctx as never);
  const raw = h.diag();
  const blocks = recentDiagnostics(h.memFs, "/project/.pi-guard", 50).filter((e) => e.type === "tool_block");
  assert.equal(blocks.length, 2, "closing block + goal-protection block");
  assert.ok(raw.includes("bash") && raw.includes("goal"), "tool names + kinds recorded");
  assert.ok(!raw.includes("SUPER-SECRET-ARG") && !raw.includes("SECRET GOAL REWRITE"), "NEVER tool arguments/content in diagnostics");
});

test("DG7: agent_settled.aborted is RECORDED and NEVER auto-retried (P-10 constraint)", async () => {
  const h = harness({ env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.pi.emit({ type: "agent_settled", aborted: true } as never, h.mc.ctx as never);
  const events = recentDiagnostics(h.memFs, "/project/.pi-guard", 50);
  assert.ok(events.some((e) => e.type === "turn_aborted" && (e as any).aborted === true), "interruption signal recorded for attribution");
  assert.equal(h.mc.newSessionCalls, 0, "no automatic renewal on abort");
  assert.equal(h.pi.userMessages.length, 0, "no automatic retry dispatch of any kind");
  await h.pi.emit({ type: "agent_settled", aborted: false } as never, h.mc.ctx as never);
  assert.equal(recentDiagnostics(h.memFs, "/project/.pi-guard", 50).filter((e) => e.type === "turn_aborted").length, 1, "completed settles are not recorded as aborts");
});

test("DG8: finalize + renewal refusal/success all land in diagnostics with typed outcomes", async () => {
  // refusal path (pre-gate disabled)
  const off = harness({ config: cfg(), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await off.start();
  await off.command("handoff", "finalize one");
  await off.command("handoff", "renew");
  const offEvents = recentDiagnostics(off.memFs, "/project/.pi-guard", 50);
  assert.ok(offEvents.some((e) => e.type === "finalize" && (e as any).ok === true));
  assert.ok(offEvents.some((e) => e.type === "renewal_request" && (e as any).trigger === "operator"));
  assert.ok(offEvents.some((e) => e.type === "renewal_result" && (e as any).ok === false && (e as any).why === "disabled"), "refusals name their reason");
  // success path (operator renewal, mocked switch)
  const ok = harness({ config: renewCfg({ autoRenew: false }), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await ok.start();
  await ok.command("handoff", "finalize two");
  await ok.command("handoff", "renew done");
  const okEvents = recentDiagnostics(ok.memFs, "/project/.pi-guard", 50);
  const result = okEvents.find((e) => e.type === "renewal_result" && (e as any).ok === true);
  assert.ok(result, "success recorded");
  assert.ok((result as any).checkpoint && (result as any).chain === "chain:session-D5" && (result as any).renewalsDone === 1, "fresh chain seeded from the session id; counter advanced to 1");
});

test("DG9: /guard events [n] reports the tail; audit mode with an IN-TREE stateDir records NOTHING (zero writes), external stateDir records outside the tree", async () => {
  const h = harness({ env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await h.start();
  await h.turnEnd();
  await h.command("guard", "events 1", h.mc.ctx);
  const n = h.notifications();
  assert.match(n, /context-guard events \(last 1\)/);
  assert.match(n, /alert session=session-D5 level=3/);
  // audit, in-tree stateDir: canPersistState() false -> no diagnostics, no state files in the tree
  const audit = harness({ config: cfg({ stateDir: ".pi-guard" }), env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_SYNTHETIC_REMAINING: "9000" } });
  await audit.start();
  await audit.turnEnd();
  assert.ok(!audit.memFs.files.has(DIAG), "read-only audit with in-tree stateDir: zero diagnostics writes inside the tree");
  assert.ok(!audit.memFs.writes.some((w) => w.startsWith("/project/")), "and no writes to the audited tree at all");
  await audit.command("guard", "events", audit.mc.ctx);
  assert.match(audit.notifications(), /not persisted in read-only audit mode|no diagnostics/i);
  // audit, EXTERNAL stateDir: state + diagnostics allowed OUTSIDE the audited tree
  const ext = harness({ config: cfg({ stateDir: "/external/guard-state" }), env: { CONTEXT_GUARD_READONLY: "1" } });
  await ext.start();
  assert.ok(ext.memFs.files.has("/external/guard-state/" + DIAGNOSTICS_FILE), "external-stateDir rule: diagnostics persist outside the tree");
  assert.ok(!ext.memFs.writes.some((w) => w.startsWith("/project/")), "tree still byte-untouched");
});

/* ------------------------------------------------------------------ */
/* (d) banner version label (P-9)                                      */
/* ------------------------------------------------------------------ */

test("D5d1: banner carries GUARD_VERSION, NOT the hardcoded milestone label; env override wins", async () => {
  const h = harness();
  await h.start();
  const banner = h.pi.sentMessages.find((m) => m.message.customType === "context-guard-identity");
  const content = typeof banner?.message.content === "string" ? banner.message.content : "";
  assert.ok(content.includes(`context-guard (project-local, v${DEFAULT_GUARD_VERSION})`), content.slice(0, 200));
  assert.ok(!/Phase 2 increment/.test(content), "milestone labels must never be hardcoded in the runtime identity");
  const h2 = harness({ env: { GUARD_VERSION: "9.9.9-probe" } });
  await h2.start();
  const b2 = h2.pi.sentMessages.find((m) => m.message.customType === "context-guard-identity");
  assert.ok(typeof b2?.message.content === "string" && b2.message.content.includes("v9.9.9-probe"));
  assert.equal(guardVersion({}), DEFAULT_GUARD_VERSION);
  assert.equal(guardVersion({ GUARD_VERSION: " 1.2.3 " }), "1.2.3");
});

test("D5b6 (issue #1): recoverable missing checkpoint must not make terminal finalize the default", async () => {
  const h = harness({ config: renewCfg({ autoCheckpointAtHandoffLevel: false }), env: { CONTEXT_GUARD_SYNTHETIC_REMAINING: "4000" } });
  await h.start();
  await h.turnEnd();
  const alert = h.alerts();
  assert.match(alert, /RENEWAL NOT AVAILABLE \(not-authorized\)/);
  assert.match(alert, /not authorized NOW/i);
  assert.match(alert, /handoff_renew refreshes/i);
  assert.ok(!/meanwhile.*close with handoff_finalize/i.test(alert), "a preparable renewal should not be steered to terminal close");
  assert.equal(h.mc.newSessionCalls, 0, "no forced transition");
});
