/**
 * Core state machine tests (test requirement 1, 2, 3, 4 partial, 10-pure).
 * Synthetic budgets only: no inference, no real session.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextPressureMachine,
  computeMeasurement,
  defaultThresholds,
  syntheticMeasurement,
} from "../.pi/extensions/context-guard/core.ts";

function machine() {
  return new ContextPressureMachine(
    defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 }),
    3,
  );
}

test("T1: each threshold fires at its own crossing", () => {
  const m = machine();
  const t31 = m.evaluate(syntheticMeasurement(30001));
  assert.equal(t31.level, 0);
  assert.equal(t31.crossed.length, 0);

  const t30 = m.evaluate(syntheticMeasurement(30000)); // boundary is inclusive
  assert.equal(t30.level, 1);
  assert.deepEqual(t30.crossed.map((c) => c.level), [1]);
  assert.equal(t30.crossed[0].kind, "advisory");

  const t20 = m.evaluate(syntheticMeasurement(20000));
  assert.equal(t20.level, 2);
  assert.deepEqual(t20.crossed.map((c) => c.level), [2]);

  const t10 = m.evaluate(syntheticMeasurement(10000));
  assert.equal(t10.level, 3);
  assert.deepEqual(t10.crossed.map((c) => c.level), [3]);

  const t5 = m.evaluate(syntheticMeasurement(5000));
  assert.equal(t5.level, 4);
  assert.deepEqual(t5.crossed.map((c) => c.level), [4]);
  assert.equal(t5.crossed[0].kind, "enforced");
  assert.equal(t5.enforcementActive, true);
});

test("T2: multiple thresholds crossed in one step produce one ordered set", () => {
  const m = machine();
  const t = m.evaluate(syntheticMeasurement(4000));
  assert.equal(t.level, 4);
  assert.deepEqual(t.crossed.map((c) => c.level), [1, 2, 3, 4]);
  const alert = m.formatAlert(t);
  assert.ok(alert);
  assert.match(alert, /4 pressure thresholds crossed in one step/);
  assert.match(alert, /CONTEXT PRESSURE \(advisory\)/);
  assert.match(alert, /CONTEXT CRITICAL \(enforced\)/);
});

test("T3: no duplicate alerts per session; re-crossing after headroom returns does not re-alert", () => {
  const m = machine();
  assert.equal(m.evaluate(syntheticMeasurement(25000)).crossed.length, 1);
  assert.equal(m.evaluate(syntheticMeasurement(24000)).crossed.length, 0);
  // headroom returns (e.g. entries pruned): level relaxes, alerts stay spent
  const relaxed = m.evaluate(syntheticMeasurement(100000));
  assert.equal(relaxed.level, 0);
  assert.equal(relaxed.crossed.length, 0);
  // crossed again: no re-alert (once per session)
  const again = m.evaluate(syntheticMeasurement(25000));
  assert.equal(again.level, 1);
  assert.equal(again.crossed.length, 0);
});

test("T4a: unknown measurements never alert and never relax enforcement (fail-safe)", () => {
  const m = machine();
  m.evaluate(syntheticMeasurement(4000)); // level 4
  const unknown: Parameters<ContextPressureMachine["evaluate"]>[0] = {
    status: "unknown",
    remaining: null,
    tokensUsed: null,
    contextWindow: null,
    reservedForGeneration: 0,
    reason: "no-usage",
  };
  const t = m.evaluate(unknown);
  assert.equal(t.unknown, true);
  assert.equal(t.level, 4); // enforcement held despite missing measurement
  assert.equal(t.enforcementActive, true);
  assert.equal(t.crossed.length, 0);
  const t2 = m.evaluate(unknown);
  const t3 = m.evaluate(unknown);
  assert.equal(t3.degraded, true); // 3 consecutive unknowns
  assert.equal(t3.crossed.length, 0); // still no spam
  void t2;
});

test("T4b: computeMeasurement handles missing model, null usage, invalid numbers", () => {
  const noModel = computeMeasurement({ contextWindow: undefined, tokens: 100, maxOutputTokens: 8 });
  assert.equal(noModel.status, "unknown");
  assert.equal(noModel.reason, "no-model");

  const noUsage = computeMeasurement({ contextWindow: 200000, tokens: null });
  assert.equal(noUsage.status, "unknown");
  assert.equal(noUsage.reason, "no-usage");

  const negative = computeMeasurement({ contextWindow: 200000, tokens: -5 });
  assert.equal(negative.status, "unknown");
  assert.equal(negative.reason, "no-usage");

  const ok = computeMeasurement({ contextWindow: 200000, tokens: 100000, maxOutputTokens: 64000, safetyReserve: 1000 });
  assert.equal(ok.status, "ok");
  // reserved generation capacity = max(model maxTokens, safetyReserve)
  assert.equal(ok.reservedForGeneration, 64000);
  assert.equal(ok.remaining, 36000);

  const bigSafety = computeMeasurement({ contextWindow: 200000, tokens: 100000, maxOutputTokens: 1000, safetyReserve: 30000 });
  assert.equal(bigSafety.reservedForGeneration, 30000);
  assert.equal(bigSafety.remaining, 70000);
});

test("T4c: generation reserve dominates thresholds (capacity for the next completion is not usable context)", () => {
  const m = computeMeasurement({ contextWindow: 128000, tokens: 60000, maxOutputTokens: 64000 });
  // 128000 - 60000 used - 64000 reserved generation = 4000 remaining
  assert.equal(m.remaining, 4000);
  const machine = new ContextPressureMachine(defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 }), 3);
  const t = machine.evaluate(m);
  assert.deepEqual(t.crossed.map((c) => c.level), [1, 2, 3, 4]);
  assert.equal(t.level, 4);
});

test("snapshot/restore round trip preserves spent alerts and level", () => {
  const m = machine();
  m.evaluate(syntheticMeasurement(9000)); // crosses 1,2,3
  const snap = m.snapshot();
  assert.deepEqual(snap.alertedLevels, [1, 2, 3]);
  assert.equal(snap.currentLevel, 3);

  const restored = ContextPressureMachine.restore(snap, defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 }), 3);
  const t = restored.evaluate(syntheticMeasurement(9000));
  assert.equal(t.crossed.length, 0); // alerts stay spent across restore
  assert.equal(t.level, 3);
  const t4 = restored.evaluate(syntheticMeasurement(3000));
  assert.deepEqual(t4.crossed.map((c) => c.level), [4]); // only the new crossing fires
});

test("restore rejects garbage snapshot values", () => {
  const restored = ContextPressureMachine.restore(
    { currentLevel: 99, alertedLevels: [1, 77, null], unknownStreak: Number.NaN, degraded: "yes", lastRemaining: undefined, evaluations: -3 } as never,
    defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 }),
    3,
  );
  const snap = restored.snapshot();
  assert.equal(snap.currentLevel, 0);
  assert.deepEqual(snap.alertedLevels, [1]);
  assert.equal(snap.unknownStreak, 0);
  assert.equal(snap.evaluations, 0);
});
