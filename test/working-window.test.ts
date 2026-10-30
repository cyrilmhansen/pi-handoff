/**
 * Independent policy window (dev.3 draft): Pi/Sushi may expose a larger PHYSICAL
 * window than the working budget enforced by context-guard. Zero inference.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeBudget, defaultThresholds, crossingPoints, selectGenerationReserve, ContextPressureMachine } from "../.pi/extensions/context-guard/core.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../.pi/extensions/context-guard/config.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const T = { advisory: 19000, wrapUp: 11000, handoff: 7000, closing: 5000 };

test("WW1: 250k physical + 95k work + 5k reserve triggers L4 at 85k without shrinking Pi output", () => {
  const c = mergeConfig(DEFAULT_CONFIG, { workingContextWindow: 95000, generationReserve: 5000, thresholds: T });
  assert.equal(c.workingContextWindow, 95000);
  const at = (used: number) => computeBudget({
    contextWindow: 250000, modelContextWindow: 250000, modelMaxOutputTokens: 32768,
    workingContextWindow: c.workingContextWindow, generationReserve: c.generationReserve,
    tokens: used, percent: used / 2500,
  });
  const b = at(85000);
  assert.equal(b.contextWindow, 95000, "machine receives the work ceiling");
  assert.equal(b.physicalContextWindow, 250000, "real Pi window is preserved");
  assert.equal(b.rawRemaining, 10000);
  assert.equal(b.usableRemaining, 5000);
  assert.equal(b.modelMaxOutputTokens, 32768);
  assert.equal(b.contextWindowSource, "working-policy");
  assert.deepEqual(crossingPoints({
    contextWindow: b.contextWindow, reserve: b.reserve, thresholds: defaultThresholds(c.thresholds),
  }).crossings.map(x => x.usedAt), [71000, 79000, 83000, 85000]);
  const machine = new ContextPressureMachine(defaultThresholds(c.thresholds));
  assert.equal(machine.evaluate(at(84999)).level, 3);
  assert.equal(machine.evaluate(b).level, 4);
  assert.ok(!b.inconsistencies.some(s => /percent/.test(s)), "Pi percent is physical-window based");
});

test("WW2: invalid options are ignored, explicit null restores legacy policy", () => {
  const original = DEFAULT_CONFIG.workingContextWindow;
  assert.equal(original, null);
  for (const value of [-1, 0, 1.5, "95000", 9007199254740992]) {
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workingContextWindow: value }).workingContextWindow, null);
  }
  assert.equal(mergeConfig(mergeConfig(DEFAULT_CONFIG, { workingContextWindow: 95000 }), { workingContextWindow: null }).workingContextWindow, null);
  const legacy = computeBudget({ contextWindow: 250000, tokens: 85000, generationReserve: 5000 });
  assert.equal(legacy.contextWindow, 250000);
  assert.equal(legacy.usableRemaining, 160000);
});

test("WW3: unsafe work ceiling is clamped to physical capacity; unknown capacity stays unknown", () => {
  const b = computeBudget({ contextWindow: 48000, workingContextWindow: 95000, tokens: 41000, generationReserve: 4000 });
  assert.equal(b.contextWindow, 48000);
  assert.equal(b.usableRemaining, 3000);
  assert.ok(b.inconsistencies.some(x => /clamped/.test(x)));
  const missing = computeBudget({ contextWindow: null, modelContextWindow: null, workingContextWindow: 95000, tokens: 1000, generationReserve: 5000 });
  assert.equal(missing.status, "unknown");
  assert.equal(missing.usableRemaining, null);
});

test("WW4: real adapter /guard status labels the independent windows and policy crossings", async () => {
  const fs = createMemoryFs({ ...DEFAULT_FILES,
    "/project/handoff.config.json": JSON.stringify({ workingContextWindow: 95000, generationReserve: 5000, thresholds: T, enforceClosing: false, autoCheckpointAtHandoffLevel: false }),
  });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", usage: { tokens: 85000, contextWindow: 250000 }, model: { contextWindow: 250000, maxTokens: 32768 } });
  contextGuard(pi.pi as never, { fs, env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  await pi.runCommand("guard", "status", mc.ctx);
  const report = mc.notifications.map(n => n.text).join("\n");
  assert.match(report, /physical context window: 250000/);
  assert.match(report, /working context window: 95000/);
  assert.match(report, /85000/);
  assert.match(report, /Pi\/Sushi window unchanged/);
});
