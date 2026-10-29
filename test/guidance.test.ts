/**
 * Phase 1c — item 4: alerts must preserve acquired experience (LEARNINGS.md), and item 7:
 * the delivery contract (append-only, no system-prompt change, no interruption).
 *
 * Baseline evidence for item 4: at b2ccdac `defaultThresholds()` guidance mentioned only
 * PROGRESS.md/HANDOFF.md — nothing told the model to record discoveries, failed
 * assumptions or proposals in LEARNINGS.md, so accumulated experience was the first thing
 * lost when a session ran out of context.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { defaultThresholds, ContextPressureMachine, computeMeasurement } from "../.pi/extensions/context-guard/core.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const T = { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 };

test("G1: every level's guidance tells the model to preserve LEARNINGS.md explicitly", () => {
  const th = defaultThresholds(T);
  const byLevel = Object.fromEntries(th.map((t) => [t.level, t.guidance]));
  for (const level of [1, 2, 3, 4]) {
    assert.ok(/LEARNINGS\.md/.test(byLevel[level]), `level ${level} must mention LEARNINGS.md: ${byLevel[level]}`);
  }
  assert.match(byLevel[1], /discover|insight/i);
  assert.match(byLevel[1], /failed|wrong|hypothes|propos/i);
  assert.match(byLevel[2], /finish|bounded/i);
  assert.match(byLevel[2], /do not open|avoid opening|no new/i);
  assert.match(byLevel[2], /unresolved|open question/i);
  assert.match(byLevel[3], /PROGRESS\.md/);
  assert.match(byLevel[3], /HANDOFF\.md/);
  assert.match(byLevel[3], /next action/i);
  assert.match(byLevel[3], /evidence/i);
  assert.match(byLevel[4], /do not start new experiments/i);
  assert.match(byLevel[4], /stop/i);
  assert.match(byLevel[4], /valid/i, "closing must tell the agent to validate the handoff");
});

test("G2: classification of knowledge survives (accepted/proposed/falsified) and alerts stay short", () => {
  const all = defaultThresholds(T).map((t) => t.guidance).join("\n");
  assert.match(all, /accepted/i);
  assert.match(all, /proposed/i);
  assert.match(all, /falsified|disproof|superseded/i);
  for (const t of defaultThresholds(T)) {
    assert.ok(t.guidance.length <= 700, `level ${t.level} guidance must stay short (${t.guidance.length})`);
    assert.ok(!/\n/.test(t.guidance), "one guidance paragraph per level");
  }
});

test("G3: the guard never fabricates discovery content — it only names the file to write", () => {
  const fs = createMemoryFs({ ...DEFAULT_FILES, "/project/LEARNINGS.md": DEFAULT_FILES["/project/LEARNINGS.md"].replace("- [P-1]", "- [KEEP-ME]") });
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 0, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs, env: {} });
  return (async () => {
    await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    for (const tokens of [195000, 205000, 215000, 219000]) await pi.emit({ type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never, { ...ctx.ctx, getContextUsage: () => ({ tokens, contextWindow: 220000, percent: null }) } as never);
    assert.ok(fs.files.get("/project/LEARNINGS.md")!.includes("- [KEEP-ME]"), "LEARNINGS.md is never written by the guard");
    const text = (m: any): string => (typeof m.message.content === "string" ? m.message.content : m.message.content.map((c: any) => c.text ?? String(c)).join(" "));
    const alertTexts = pi.sentMessages.map(text).join("\n");
    assert.ok(alertTexts.includes("LEARNINGS.md"));
    assert.ok(!/discovered that|the agent learned/i.test(alertTexts), "no invented discoveries in alert text");
  })();
});

test("G4: alerts are append-only custom messages with triggerTurn:false and stable text", async () => {
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 190000, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: createMemoryFs(DEFAULT_FILES), env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  const event = { type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" };
  await pi.emit(event as never, ctx.ctx as never);
  await pi.emit(event as never, ctx.ctx as never); // must not re-alert
  assert.equal(pi.sentMessages.length, 1, "one alert per crossing, none on repeat");
  const sent = pi.sentMessages[0];
  assert.equal(sent.options.triggerTurn, false, "never interrupts the running turn");
  assert.equal(sent.message.display, true);
  assert.equal(sent.message.customType, "context-guard");
  assert.ok(!JSON.stringify(sent).includes("systemPrompt"), "no system-prompt mutation");
  assert.deepEqual(pi.entries[0].data && Object.keys(pi.entries[0].data as object), ["alertLevels", "remaining", "boundary"], "audit entry persisted outside model context");
});

test("G5: combined crossing produces one message whose text is deterministic", async () => {
  const mk = async () => {
    const pi = createMockPi();
    const ctx = createMockCtx({ cwd: "/project", usage: { tokens: 216000, contextWindow: 220000 }, model: { maxTokens: 20000, contextWindow: 220000 } });
    contextGuard(pi.pi as never, { fs: createMemoryFs(DEFAULT_FILES), env: {} });
    await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    await pi.emit({ type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never, ctx.ctx as never);
    return pi.sentMessages.map((m) => (typeof m.message.content === "string" ? m.message.content : m.message.content.map((c: any) => c.text ?? String(c)).join(" "))).join("\n");
  };
  const a = await mk();
  const b = await mk();
  assert.equal(a, b, "alert text depends only on (thresholds, remaining bucket), so prompt prefixes stay stable");
  assert.ok(a.includes("thresholds crossed in one step"), a);
  assert.ok(a.includes("LEARNINGS.md"));
});
