/**
 * dev.2 D6 — experimental 95k/5k profile + crossing points in `/guard status`.
 *
 * Pure arithmetic tests (D6x1), the shipped profile's self-consistency through the
 * REAL config merge path (D6x2), and the adapter's status line (D6x3). The plan's
 * documented numbers: window 95 000, reserve 5 000, thresholds 20k/12k/8k/5k →
 * crossings at used ≥ 70k / 78k / 82k / 85k. The same function must reproduce the
 * A-11 live Sushi numbers (220k / reserve 65 536 → 124 464 / 134 464 / 144 464 /
 * 149 464), because it shares `computeBudget`'s formula (usable = window − used −
 * reserve). Honest ownership wording is mandatory: the guard NEVER changes the model
 * window and crossings are advisory budgets over Pi's ESTIMATE (A-1/A-18).
 *
 * Zero inference, mocked harness only; D6x3 exercises the adapter in the mock runtime,
 * the real-runtime load gate is scripts/e2e-rpc-two-process.mjs (A-15 rule).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeBudget,
  crossingPoints,
  crossingPointsLine,
  defaultThresholds,
  selectGenerationReserve,
} from "../.pi/extensions/context-guard/core.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../.pi/extensions/context-guard/config.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const D6_T = { advisory: 20000, wrapUp: 12000, handoff: 8000, closing: 5000 };
const SUSHI_T = { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 };

test("D6x1: crossingPoints turns thresholds into used-token crossings (same arithmetic as computeBudget)", () => {
  const d6 = crossingPoints({
    contextWindow: 95000,
    reserve: selectGenerationReserve({ generationReserve: 5000, safetyReserve: 0 }),
    thresholds: defaultThresholds(D6_T),
  });
  assert.deepEqual(d6.crossings.map((c) => c.usedAt), [70000, 78000, 82000, 85000], "the documented D6 plan numbers");
  assert.deepEqual(d6.crossings.map((c) => c.level), [1, 2, 3, 4], "escalation order");
  assert.deepEqual(d6.crossings.map((c) => c.remainingBelow), [20000, 12000, 8000, 5000]);
  assert.deepEqual(d6.crossings.map((c) => c.kind), ["advisory", "advisory", "advisory", "enforced"]);
  assert.equal(d6.reserve.source, "generationReserve");

  // Cross-check with the production budget function: AT the crossing, usable equals
  // exactly remainingBelow (identical formula, no drift between modules).
  const atL1 = computeBudget({ modelId: "m", contextWindow: 95000, tokens: 70000, generationReserve: 5000, safetyReserve: 0 });
  assert.equal(atL1.usableRemaining, 20000);
  const atL4 = computeBudget({ modelId: "m", contextWindow: 95000, tokens: 85000, generationReserve: 5000, safetyReserve: 0 });
  assert.equal(atL4.usableRemaining, 5000);

  // A-11 live Sushi baseline: window 220 000, reserve = model maxTokens 65 536.
  const sushi = crossingPoints({
    contextWindow: 220000,
    reserve: selectGenerationReserve({ generationReserve: "model", modelMaxOutputTokens: 65536 }),
    thresholds: defaultThresholds(SUSHI_T),
  });
  assert.deepEqual(sushi.crossings.map((c) => c.usedAt), [124464, 134464, 144464, 149464]);

  // safetyReserve floor wins and names itself as the provenance.
  const floored = crossingPoints({
    contextWindow: 95000,
    reserve: selectGenerationReserve({ generationReserve: 2000, safetyReserve: 30000 }),
    thresholds: defaultThresholds(D6_T),
  });
  assert.equal(floored.crossings[3].usedAt, 95000 - 30000 - 5000);
  assert.equal(floored.reserve.source, "safetyReserve");

  // Unknown window: NO crossings, and the line stays honest about window ownership.
  const none = crossingPoints({ contextWindow: null, reserve: selectGenerationReserve({}), thresholds: defaultThresholds(D6_T) });
  assert.deepEqual(none.crossings, []);
  const noneLine = crossingPointsLine(none);
  assert.match(noneLine, /unavailable/);
  assert.match(noneLine, /never changes/);

  // A reserve too big for the window: crossing ≤ 0 is FLAGGED, not hidden —
  // that level would already be active at session start.
  const tight = crossingPoints({
    contextWindow: 95000,
    reserve: selectGenerationReserve({ generationReserve: "model", modelMaxOutputTokens: 65536 }),
    thresholds: defaultThresholds(SUSHI_T),
  });
  assert.equal(tight.crossings[0].usedAt, 95000 - 65536 - 30000, "L1 sits BELOW zero: at used=0 the usable budget (29 464) is already under 30 000");
  assert.ok(tight.crossings[0].usedAt <= 0 && tight.crossings[1].usedAt > 0, "only the over-tight level is flagged; others stay positive");
  assert.match(crossingPointsLine(tight), /too tight/);
});

test("D6x2: docs/profiles/experimental-95k.json is self-consistent through the REAL config merge", () => {
  const raw = JSON.parse(readFileSync(new URL("../docs/profiles/experimental-95k.json", import.meta.url), "utf8"));
  const cfg = mergeConfig(DEFAULT_CONFIG, raw);
  assert.deepEqual(cfg.thresholds, { advisory: 20000, wrapUp: 12000, handoff: 8000, closing: 5000 });
  assert.equal(cfg.generationReserve, 5000);
  assert.equal(cfg.safetyReserve, 0);
  // Documentation keys ("_*") must never leak into the merged config (mergeConfig is
  // whitelist-based — this asserts the profile stays safe to hand to loadConfig).
  for (const k of Object.keys(raw)) {
    if (k.startsWith("_")) assert.ok(!(k in cfg), `documentation key ${k} leaked into the merged config`);
  }
  const report = crossingPoints({
    contextWindow: raw._windowAssumption,
    reserve: selectGenerationReserve({ generationReserve: cfg.generationReserve, safetyReserve: cfg.safetyReserve, modelMaxOutputTokens: null }),
    thresholds: defaultThresholds(cfg.thresholds),
  });
  for (const c of report.crossings) {
    assert.equal(c.usedAt, raw._expectedCrossings[`L${c.level}`], `L${c.level} crossing must equal the documented profile value`);
  }
  assert.deepEqual(report.crossings.map((c) => c.usedAt), [70000, 78000, 82000, 85000]);
});

test("D6x3: /guard status prints the crossing line with provenance and honest window ownership", async () => {
  const SMALL = { contextWindow: 95000, maxTokens: 8192 };

  // Live profile: every documented crossing point visible, provenance named.
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 10000, contextWindow: 95000 }, model: SMALL, sessionId: "sess-d6a", mode: "tui" });
  contextGuard(pi.pi as never, { fs, env: {}, config: { thresholds: D6_T, generationReserve: 5000, safetyReserve: 0 } });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  await pi.runCommand("guard", "status", ctx.ctx);
  const text = ctx.notifications.map((n) => n.text).join("\n");
  assert.match(text, /threshold crossings \(estimated used, escalation order\)/);
  for (const label of ["70,000", "78,000", "82,000", "85,000"]) {
    assert.ok(text.includes(label), `/guard status must print the crossing ${label} — got:\n${text}`);
  }
  assert.match(text, /source: generationReserve/);
  assert.match(text, /never changes the model window/);
  assert.match(text, /advisory policy budgets/);
  assert.match(text, /L4 closing \(enforced\)/);

  // D5a honesty travels: with enforceClosing:false the crossing line labels L4 advisory.
  const fs2 = createMemoryFs(DEFAULT_FILES);
  const pi2 = createMockPi();
  const ctx2 = createMockCtx({ cwd: "/project", usage: { tokens: 10000, contextWindow: 95000 }, model: SMALL, sessionId: "sess-d6b", mode: "tui" });
  contextGuard(pi2.pi as never, { fs: fs2, env: {}, config: { thresholds: D6_T, generationReserve: 5000, safetyReserve: 0, enforceClosing: false } });
  await pi2.emit({ type: "session_start", reason: "startup" } as never, ctx2.ctx as never);
  await pi2.runCommand("guard", "status", ctx2.ctx);
  const text2 = ctx2.notifications.map((n) => n.text).join("\n");
  assert.match(text2, /L4 closing \(advisory\)/, "crossing kind must match live closing policy");

  // Unknown window: reported unavailable, never fabricated.
  const fs3 = createMemoryFs(DEFAULT_FILES);
  const pi3 = createMockPi();
  const ctx3 = createMockCtx({ cwd: "/project", usage: null, model: null as never, sessionId: "sess-d6c", mode: "tui" });
  contextGuard(pi3.pi as never, { fs: fs3, env: {} });
  await pi3.emit({ type: "session_start", reason: "startup" } as never, ctx3.ctx as never);
  await pi3.runCommand("guard", "status", ctx3.ctx);
  const text3 = ctx3.notifications.map((n) => n.text).join("\n");
  assert.match(text3, /threshold crossings: unavailable/, "unknown window must say so");
  assert.match(text3, /never changes/);
});
