/**
 * Phase 2 — revocation regression (observed inconsistency, session 01a18713):
 * enforced level 4 fired at ~155k estimated used, then a fresh valid measurement
 * recovered to ~88k used (40%/220k, ~66k usable, L0) WITHOUT any correction to the
 * model: the closing instruction stayed in the transcript unretracted and the
 * operator saw `guard L0` next to a live "closing phase" history.
 *
 * Required behavior (minimal correction):
 *  - a new VALID measurement may relax the level (already true: evaluate() recomputes);
 *  - crossing alerts stay spent (PROTOCOL §1) and remain in the transcript (audit);
 *  - each previously alerted threshold that the fresh measurement no longer satisfies
 *    fires EXACTLY ONE revocation notice (model + operator + appendEntry audit) naming
 *    the measurements and provenance before/after;
 *  - unknown measurements never revoke (fail-safe holds enforcement);
 *  - the tool gate follows the LIVE level in both directions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { defaultThresholds, ContextPressureMachine, syntheticMeasurement, type Measurement, type Transition } from "../.pi/extensions/context-guard/core.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const T = { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 };
const mkMachine = () => new ContextPressureMachine(defaultThresholds(T));
const text = (m: { message: any }): string =>
  typeof m.message.content === "string" ? m.message.content : m.message.content.map((c: any) => c.text ?? String(c)).join(" ");

function ok(remaining: number, extra: Partial<Measurement> = {}): Measurement {
  return { status: "ok", remaining, tokensUsed: 220000 - remaining - 20000, contextWindow: 220000, reservedForGeneration: 20000, provenance: "real", ...extra };
}

test("RV1: L0 -> L4 -> L0 revokes every alerted threshold exactly once, with before/after context", () => {
  const m = mkMachine();
  const up = m.evaluate(syntheticMeasurement(4900)); // crosses 1..4 in one step
  assert.equal(up.level, 4);
  assert.equal(up.crossed.length, 4);
  assert.equal(up.revoked.length, 0);
  assert.equal(up.enforcementActive, true);

  const down = m.evaluate(syntheticMeasurement(120000)); // valid recovery
  assert.equal(down.previousLevel, 4);
  assert.equal(down.level, 0);
  assert.equal(down.enforcementActive, false, "enforcement follows the LIVE level");
  assert.deepEqual(down.crossed, [], "no re-alert while levels relax");
  assert.deepEqual(down.revoked.map((t) => t.level), [1, 2, 3, 4], "all alerted thresholds are revoked");
  assert.equal(down.previousMeasurement?.remaining, 4900, "measurement captured BEFORE the transition");
  assert.equal(down.measurement.remaining, 120000, "measurement captured AFTER the transition");

  const again = m.evaluate(syntheticMeasurement(121000));
  assert.equal(again.revoked.length, 0, "one revocation notice per level per session");

  const rev = m.formatRevocation(down)!;
  assert.match(rev, /POLICY UPDATE/);
  assert.match(rev, /REVOKED/);
  assert.match(rev, /NO LONGER ACTIVE/);
  assert.match(rev, /HISTORICAL, not current policy/);
  assert.match(rev, /before: .*4900.*synthetic/);
  assert.match(rev, /after: .*120000.*synthetic/);
  assert.equal(m.formatAlert(down), undefined, "relaxation alone never fabricates a crossing alert");
});

test("RV2: re-escalation after revocation re-gates enforcement and re-arms the revocation notice", () => {
  const m = mkMachine();
  m.evaluate(syntheticMeasurement(4900)); // L4, alerts spent
  m.evaluate(syntheticMeasurement(120000)); // revoke 1..4
  const back = m.evaluate(syntheticMeasurement(4800));
  assert.equal(back.level, 4);
  assert.equal(back.enforcementActive, true);
  assert.deepEqual(back.crossed, [], "alerts stay spent: the live gate + block reason carry current policy");
  const down2 = m.evaluate(syntheticMeasurement(150000));
  assert.equal(down2.revoked.length, 4, "a second genuine relaxation revokes again (notice re-armed)");
});

test("RV3: unknown measurements never revoke and never relax enforcement (fail-safe)", () => {
  const m = mkMachine();
  m.evaluate(syntheticMeasurement(4900));
  const unknown: Measurement = { status: "unknown", remaining: null, tokensUsed: null, contextWindow: null, reservedForGeneration: 0, reason: "no-usage", provenance: "unknown" };
  for (let i = 0; i < 4; i++) {
    const t = m.evaluate(unknown);
    assert.equal(t.level, 4, "level is HELD while measurements are missing");
    assert.equal(t.revoked.length, 0, "missing data must not lift closing");
    assert.equal(t.enforcementActive, true);
  }
});

test("RV4: revocation state survives snapshot/restore (no duplicate notices across reloads)", () => {
  const m = mkMachine();
  m.evaluate(syntheticMeasurement(4900));
  m.evaluate(syntheticMeasurement(120000));
  const snap = m.snapshot();
  assert.deepEqual(snap.revokedLevels, [1, 2, 3, 4]);
  const r = ContextPressureMachine.restore(snap, defaultThresholds(T));
  const t = r.evaluate(syntheticMeasurement(130000));
  assert.equal(t.revoked.length, 0, "restored machine does not re-notify a delivered revocation");
});

test("RV5: adapter — alert delivery, tool gate, and revocation end-to-end with REAL-provenance measurements", async () => {
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 0, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: createMemoryFs(DEFAULT_FILES), env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);

  const gate = (toolName: string) => pi.handlers.get("tool_call")![0]({ type: "tool_call", toolName, input: {} } as never, ctx.ctx as never);
  const turn = (tokens: number) =>
    pi.emit(
      { type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never,
      { ...ctx.ctx, getContextUsage: () => ({ tokens, contextWindow: 220000, percent: null }) } as never,
    );

  await turn(216000); // usable = 220000-216000-20000 < 5000 => levels 1..4, enforced closing
  const alertMsgs = () => pi.sentMessages.filter((m) => m.message.customType === "context-guard");
  assert.equal(alertMsgs().length, 1);
  assert.match(text(alertMsgs()[0]), /CONTEXT CRITICAL \(enforced\)/);
  assert.equal(gate("bash")?.block, true, "closing gates non-allowlisted tools");
  assert.equal(gate("write")?.block, undefined, "checkpoint tools stay allowed");

  await turn(100000); // valid measurement recovers => usable 100000 => L0
  const texts = pi.sentMessages.map(text).join("\n");
  assert.match(texts, /POLICY UPDATE/, "model receives the revocation message");
  assert.match(texts, /closing phase is NO LONGER ACTIVE/);
  assert.match(texts, /before: .*used 216000.*provenance real/);
  assert.match(texts, /after: .*used 100000.*provenance real/);
  assert.match(texts, /HISTORICAL, not current policy/);
  const delivered = pi.sentMessages.map((m) => m.options.triggerTurn);
  assert(delivered.every((t) => t === false), "revocation also never interrupts an in-flight turn");
  assert.equal(gate("bash")?.block, undefined, "tool gate FOLLOWS the live level: closing lifted");

  const revEntry = pi.entries.map((e) => e.data as any).find((d) => d?.revokedLevels);
  assert.ok(revEntry, "audit entry persisted outside model context");
  assert.deepEqual(revEntry.revokedLevels, [1, 2, 3, 4]);
  assert.equal(revEntry.before.provenance, "real");
  assert.equal(revEntry.before.tokensUsed, 216000, "used recorded BEFORE the transition");
  assert.equal(revEntry.before.remaining, -16000);
  assert.equal(revEntry.after.tokensUsed, 100000, "used recorded AFTER the transition");
  assert.equal(revEntry.after.remaining, 100000);

  await turn(101000); // still relaxed
  assert.equal(alertMsgs().length, 2, "no repeated alerts and no repeated revocations (identity banner excluded)");
});

test("RV6: /guard status reports the revoked history (operator observability)", async () => {
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 216000, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: createMemoryFs(DEFAULT_FILES), env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  await pi.runCommand("guard", "simulate 4900", ctx.ctx);
  await pi.runCommand("guard", "simulate 120000", ctx.ctx);
  pi.sentMessages.length = 0;
  await pi.runCommand("guard", "status", ctx.ctx);
  const status = ctx.notifications.map((n) => n.text).join("\n");
  assert.match(status, /guard level: 0/);
  assert.match(status, /alerts spent \[1, 2, 3, 4\]/);
  assert.match(status, /revoked notices \[1, 2, 3, 4\]/, "operator sees which enforced guidance was revoked");
});
