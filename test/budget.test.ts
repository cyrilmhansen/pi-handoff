/**
 * Phase 1c — item 1 (P0): context-budget observability.
 *
 * Deterministic tests for the budget breakdown across model context windows, model
 * maxTokens values, fixed reserves, safety margins and unknown measurements; plus the
 * detailed /guard status report. Synthetic/mock only, zero inference.
 *
 * Baseline evidence (accepted): with generationReserve "model" and the Sushi model
 * declaring contextWindow=220000 / maxTokens=65536, usable remaining is
 * 220000 - used - 65536, so level 3 fires at used >= 144464 and enforced level 4 at
 * used >= 149464 — the "~150k closing" behaviour. See A-11 in LEARNINGS.md.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeBudget,
  computeMeasurement,
  defaultThresholds,
  nextThresholds,
  selectGenerationReserve,
  syntheticBudget,
  ContextPressureMachine,
} from "../.pi/extensions/context-guard/core.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const SUSHI = { contextWindow: 220000, maxTokens: 65536 };
const T = { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 };

test("B1: model reserve explains the ~150k closing behaviour (raw vs usable)", () => {
  const thresholds = defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 });
  const machine = new ContextPressureMachine(thresholds);
  const at = (used: number) => machine.evaluate(computeMeasurement({ ...SUSHI, tokens: used, maxOutputTokens: SUSHI.maxTokens })).level;

  assert.equal(at(124463), 0, "one token below level 1");
  assert.equal(at(124464), 1, "level 1 at used = window - reserve - 30000");
  assert.equal(at(144464), 3, "level 3 (handoff) at used = 144464");
  assert.equal(at(149464), 4, "enforced closing at used = 149464 (~150k, NOT 220k)");

  const b = computeBudget({ modelId: "sushi/x", contextWindow: SUSHI.contextWindow, tokens: 150000, modelMaxOutputTokens: SUSHI.maxTokens, generationReserve: "model", safetyReserve: 0 });
  assert.equal(b.rawRemaining, 70000, "raw remaining = window - used");
  assert.equal(b.usableRemaining, 4464, "usable remaining = raw - selected reserve");
  assert.equal(b.reserve.selected, 65536);
  assert.equal(b.reserve.source, "model-maxTokens");
  assert.equal(b.provenance, "real");
  assert.ok(b.inconsistencies.some((s) => /reserve/i.test(s) && /50%|large|fraction/i.test(s)), "over-large reserve is flagged");
});

test("B2: fixed reserve of 20000 keeps the same usage far from closing", () => {
  const b = computeBudget({ contextWindow: SUSHI.contextWindow, tokens: 150000, modelMaxOutputTokens: SUSHI.maxTokens, generationReserve: 20000, safetyReserve: 0 });
  assert.equal(b.reserve.selected, 20000);
  assert.equal(b.reserve.source, "generationReserve");
  assert.equal(b.usableRemaining, 50000);
  const machine = new ContextPressureMachine(defaultThresholds({ advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 }));
  assert.equal(machine.evaluate({ status: "ok", remaining: b.usableRemaining, tokensUsed: 150000, contextWindow: 220000, reservedForGeneration: 20000 }).level, 0);
});

test("B3: reserve selection honours model/number/safety precedence deterministically", () => {
  assert.deepEqual(selectGenerationReserve({ generationReserve: "model", modelMaxOutputTokens: 65536, safetyReserve: 0 }), {
    setting: "model", safetyReserve: 0, modelMaxOutputTokens: 65536, selected: 65536, source: "model-maxTokens",
  });
  assert.equal(selectGenerationReserve({ generationReserve: "model", modelMaxOutputTokens: 4096, safetyReserve: 20000 }).source, "safetyReserve");
  assert.equal(selectGenerationReserve({ generationReserve: 12000, modelMaxOutputTokens: 65536, safetyReserve: 0 }).source, "generationReserve");
  assert.equal(selectGenerationReserve({ generationReserve: "model", modelMaxOutputTokens: null, safetyReserve: 0 }).source, "none");
  assert.equal(selectGenerationReserve({ generationReserve: 0, modelMaxOutputTokens: 65536, safetyReserve: 0 }).selected, 0, "explicit 0 reserve is respected");
});

test("B4: different context windows and model maxima are all reported, not guessed", () => {
  for (const [window_, maxOut, used, expectUsable] of [
    [128000, 8192, 60000, 59808],
    [190000, 65536, 100000, 24464],
    [220000, 65536, 66000, 88464],
    [32000, 16384, 20000, -4384],
  ] as const) {
    const b = computeBudget({ contextWindow: window_, modelContextWindow: window_, tokens: used, modelMaxOutputTokens: maxOut, generationReserve: "model", safetyReserve: 0 });
    assert.equal(b.usableRemaining, expectUsable, `window ${window_}`);
    assert.equal(b.status, "ok");
    if (expectUsable <= 0) assert.ok(b.inconsistencies.some((s) => /negative|exhausted/i.test(s)), "negative budget flagged");
  }
});

test("B5: unknown measurements are labelled, never silently zeroed", () => {
  const noModel = computeBudget({ contextWindow: null, tokens: 12000 });
  assert.equal(noModel.provenance, "unknown");
  assert.equal(noModel.usableRemaining, null);
  assert.ok(noModel.inconsistencies.length > 0);
  const noUsage = computeBudget({ contextWindow: 220000, tokens: null, modelMaxOutputTokens: 65536 });
  assert.equal(noUsage.status, "unknown");
  assert.equal(noUsage.reason, "no-usage");
  assert.equal(noUsage.rawRemaining, null);
  assert.equal(noUsage.reserve.selected, 65536, "reserve is still reported when usage is missing");
  const measurement = computeMeasurement({ contextWindow: undefined, tokens: 5, maxOutputTokens: 8 });
  assert.equal(measurement.remaining, null);
});

test("B6: synthetic mode declares its provenance", () => {
  const b = syntheticBudget(9000, 220000);
  assert.equal(b.provenance, "synthetic");
  assert.equal(b.usableRemaining, 9000);
  assert.equal(b.reserve.selected, 0);
  assert.ok(b.inconsistencies.some((s) => /synthetic/i.test(s)));
});

test("B7: expected/measured window and percent inconsistencies are detected", () => {
  const mismatch = computeBudget({ contextWindow: 220000, modelContextWindow: 190000, tokens: 100000, modelMaxOutputTokens: 65536, generationReserve: "model" });
  assert.ok(mismatch.inconsistencies.some((s) => /window/i.test(s)), "window mismatch reported");

  const percentMismatch = computeBudget({ contextWindow: 220000, tokens: 100000, percent: 70, modelMaxOutputTokens: 8192, generationReserve: 8192 });
  assert.ok(percentMismatch.inconsistencies.some((s) => /percent/i.test(s)), "Pi percent vs estimate disagreement reported");
  assert.ok(percentMismatch.inconsistencies.some((s) => /~154000/.test(s)), "reports the window the percent implies");

  const clean = computeBudget({ contextWindow: 220000, modelContextWindow: 220000, tokens: 100000, percent: 100000 / 2200, modelMaxOutputTokens: 8192, generationReserve: 8192 });
  assert.deepEqual(clean.inconsistencies, [], "consistent numbers produce no warnings");
});

test("B8: nextThresholds reports both the next crossing and the next alert", () => {
  const thresholds = defaultThresholds(T);
  // remaining falls as the session grows: "next" = closest threshold below now.
  const first = nextThresholds(thresholds, 40000, []);
  assert.equal(first.nextCrossing?.level, 1);
  assert.equal(first.nextCrossing?.tokensUntil, 10000);
  const mid = nextThresholds(thresholds, 25000, []);
  assert.equal(mid.nextCrossing?.level, 2, "level 1 is already active at 25000");
  assert.equal(mid.nextCrossing?.tokensUntil, 5000);
  const afterAlert = nextThresholds(thresholds, 25000, [1, 2]);
  assert.equal(afterAlert.nextCrossing?.level, 2, "crossing is still level 2...");
  assert.equal(afterAlert.nextAlert?.level, 3, "...but its alert is spent, so the next alert is level 3");
  assert.equal(afterAlert.nextAlert?.tokensUntil, 15000);
  const done = nextThresholds(thresholds, 1000, [1, 2, 3, 4]);
  assert.equal(done.nextCrossing, null);
  assert.equal(done.nextAlert, null);
  const unknown = nextThresholds(thresholds, null, []);
  assert.equal(unknown.nextCrossing, null);
});

test("B9: /guard status exposes every component of the budget and the reserve source", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 150000, contextWindow: SUSHI.contextWindow }, model: SUSHI, sessionId: "sess-b9", mode: "tui" });
  contextGuard(pi.pi as never, { fs, env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  await pi.runCommand("guard", "status", ctx.ctx);

  const text = ctx.notifications.map((n) => n.text).join("\n");
  for (const label of [
    "model:", "context window:", "estimated used:", "raw remaining:", "generation reserve:",
    "usable remaining:", "guard level:", "next threshold:", "measurement:", "provenance:",
  ]) {
    assert.ok(text.includes(label), `/guard status must print "${label}" — got:\n${text}`);
  }
  assert.ok(text.includes("65536"), "shows the actual reserved output capacity");
  assert.ok(text.includes("4464"), "shows usable remaining after the reserve");
  assert.ok(/model maxTokens|model-maxTokens/i.test(text), "names where the reserve came from");
  assert.ok(text.includes("220000"), "shows the effective context window");
  assert.ok(/reserve/.test(text) && /inconsisten|fraction|large/i.test(text), "flags the oversized reserve");
});

test("B10: /guard status works with unknown measurements and synthetic mode", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: null, model: null as never, sessionId: "sess-b10" });
  contextGuard(pi.pi as never, { fs, env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  await pi.runCommand("guard", "status", ctx.ctx);
  const text = ctx.notifications.map((n) => n.text).join("\n");
  assert.ok(/unknown/.test(text) && /no-model/.test(text), `unknown measurement must be labelled: ${text}`);

  const pi2 = createMockPi();
  const ctx2 = createMockCtx({ cwd: "/project", usage: { tokens: 1000, contextWindow: 220000 }, model: SUSHI });
  contextGuard(pi2.pi as never, { fs, env: {}, config: { syntheticRemaining: 12000 } as never });
  await pi2.emit({ type: "session_start", reason: "startup" } as never, ctx2.ctx as never);
  await pi2.runCommand("guard", "status", ctx2.ctx);
  const text2 = ctx2.notifications.map((n) => n.text).join("\n");
  assert.ok(/synthetic/i.test(text2), `synthetic provenance must be labelled: ${text2}`);
});

test("B11: the default config keeps generationReserve=model (no silent 20k policy)", () => {
  const raw = DEFAULT_FILES["/project/handoff.config.json"];
  assert.ok(raw.includes("\"stateDir\""));
  const fs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": JSON.stringify({ generationReserve: 20000 }) });
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 150000, contextWindow: 220000 }, model: SUSHI });
  contextGuard(pi.pi as never, { fs, env: {} });
  return (async () => {
    await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    await pi.runCommand("guard", "status", ctx.ctx);
    const text = ctx.notifications.map((n) => n.text).join("\n");
    assert.ok(text.includes("20000"), "configured fixed reserve is reported as such");
    assert.ok(/config|generationReserve|fixed/i.test(text));
  })();
});
