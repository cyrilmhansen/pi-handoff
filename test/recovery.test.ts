/**
 * dev.2 D4: compact (lean) recovery tiers + recovery-cost meter.
 *
 * Motivation (DRPLi campaign, A-27): every successor re-read ALL six durable docs at
 * every hop (13k → 100k chars growing with the chain); the six docs totalled 121,312
 * chars (~30.3k estimated tokens). Lean recovery tiers the reading: OPERATIONAL files
 * (handoff + progress) are read NOW; METHODOLOGY (AGENTS — auto-loaded by pi anyway —
 * and PROTOCOL) only when a procedure is needed; ARCHIVE (goal + learnings) referenced
 * by name and read only on demand. Nothing is deleted or demoted in authority: tiering
 * changes WHEN the successor reads, never WHAT is authoritative.
 *
 * Schema v3 compatible: the managed checkpoint blocks are untouched; the tier info is
 * recovery-PROMPT policy only. `recovery.lean` defaults to FALSE (opt-in).
 *
 * The DRPLi-shaped fixture (six docs summing to EXACTLY 121,312 chars) is GENERATED in
 * this test file — zero inference, memory fs, nothing touches the real tree.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RECOVERY,
  buildLeanRecoveryBody,
  estimateTokens,
  mergeRecovery,
  recoveryCost,
  recoveryTiers,
} from "../.pi/extensions/context-guard/recovery.ts";
import { buildRecoveryPrompt } from "../.pi/extensions/context-guard/renewal.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../.pi/extensions/context-guard/config.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES, type MemoryFs } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

/* ------------------------------------------------------------------ */
/* fixture: DRPLi-shaped durable set                                   */
/* ------------------------------------------------------------------ */

function filler(name: string, chars: number): string {
  const head = `# ${name}\n\n`;
  const unit = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ";
  let body = "";
  while (body.length + head.length < chars) body += unit.repeat(8) + "\n\n";
  return (head + body).slice(0, chars);
}

/** Six docs summing to exactly the audited 121,312 chars (A-27), shaped like DRPLi:
 *  big accreting HANDOFF/PROGRESS, big PROTOCOL, big LEARNINGS, small AGENTS/GOAL. */
function drpliFixture(): { fs: MemoryFs; sizes: Record<string, number> } {
  const sizes: Record<string, number> = {
    "AGENTS.md": 4_000,
    "PROTOCOL.md": 40_000,
    "GOAL.md": 8_000,
    "HANDOFF.md": 20_000,
    "PROGRESS.md": 20_000,
    "LEARNINGS.md": 29_312,
  };
  const mem = createMemoryFs();
  for (const [name, size] of Object.entries(sizes)) mem.writeFile(`/drpli/${name}`, filler(name, size));
  return { fs: mem, sizes };
}

test("RC1: tiers partition all six durable files; estimation is chars/4 (the audit's stated basis)", () => {
  const tiers = recoveryTiers(FILES);
  const all = [...tiers.operational, ...tiers.methodology, ...tiers.archive];
  assert.equal(all.length, 6, "the mandatory set is still SIX files — lean tiering DEFERS reading, never drops authority");
  assert.deepEqual(tiers.operational, ["HANDOFF.md", "PROGRESS.md"]);
  assert.deepEqual(tiers.methodology, ["AGENTS.md", "PROTOCOL.md"]);
  assert.deepEqual(tiers.archive, ["GOAL.md", "LEARNINGS.md"]);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(121_312), 30_328);
});

test("RC2: DRPLi-shaped fixture (exactly 121,312 chars): full mandatory set >> budget; lean operational tier fits 12k est. tokens; archive refs exist", () => {
  const { fs, sizes } = drpliFixture();
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  assert.equal(total, 121_312, "fixture reproduces the audited durable-document size");
  const cost = recoveryCost(fs, "/drpli", FILES);
  assert.equal(cost.full.chars, 121_312);
  assert.ok(cost.full.estTokens > 2.5 * DEFAULT_RECOVERY.budgetTokens, `full mandatory set must EXCEED the lean budget by >>: ${cost.full.estTokens}`);
  assert.ok(cost.operational.estTokens <= DEFAULT_RECOVERY.budgetTokens, `lean tier must fit the budget: ${cost.operational.estTokens}`);
  // every tier member is named in the lean recovery body: archive authority preserved BY REFERENCE
  const body = buildLeanRecoveryBody(FILES);
  for (const f of ["AGENTS.md", "PROTOCOL.md", "GOAL.md", "LEARNINGS.md"]) {
    assert.ok(body.includes(f), `lean body must still reference ${f}`);
  }
  assert.match(body, /on demand|reference/i);
  // missing docs are reported, not fatal
  const partial = recoveryCost(createMemoryFs(), "/drpli", FILES);
  assert.equal(partial.missing.length, 6);
  assert.equal(partial.full.chars, 0);
});

test("RC3: lean body is deterministic, orders tiers, and preserves manual-prose precedence", () => {
  const a = buildLeanRecoveryBody(FILES);
  const b = buildLeanRecoveryBody(FILES);
  assert.equal(a, b, "same inputs => same bytes (cache-stable recovery instruction)");
  assert.ok(a.indexOf("HANDOFF.md") < a.indexOf("PROTOCOL.md") && a.indexOf("PROTOCOL.md") < a.indexOf("LEARNINGS.md"), "operational before methodology before archive");
  assert.match(a, /manual prose/i);
  assert.match(a, /precedence/i, "schema-v3 precedence rule (manual prose wins) must survive tiering");
  assert.ok(!/read AGENTS\.md, PROTOCOL\.md, GOAL\.md, HANDOFF\.md, PROGRESS\.md, LEARNINGS\.md/i.test(a), "must not be the old mandatory read-all body");
});

test("RC4: buildRecoveryPrompt — lean replaces the GENERIC body only; custom recoveryPrompt wins; mandatory header/trailer byte-identical", () => {
  const base = {
    files: FILES,
    checkpointId: "g9-abc",
    chainId: "chain:x",
    renewalIndex: 2,
    maxRenewals: 8,
    parentSessionId: "session-P",
  };
  const full = buildRecoveryPrompt({ ...base, testCommand: "node --test test/" });
  const lean = buildRecoveryPrompt({ ...base, testCommand: "node --test test/", lean: true });
  assert.ok(full.includes("read AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md"), "default (full) body unchanged — lean is OPT-IN");
  assert.ok(!full.includes("read them NOW"), full.slice(0, 400));
  assert.ok(lean.includes("read them NOW"), "lean body present");
  assert.ok(lean.includes("GOAL.md") && lean.includes("LEARNINGS.md"), "archive still referenced");
  // mandatory parts identical in both variants
  const headerOf = (t: string) => t.split("\n").slice(0, 3).join("\n");
  const trailerOf = (t: string) => t.split("\n").filter((l) => /never push|task-list/.test(l)).join("\n");
  assert.equal(headerOf(full), headerOf(lean), "identity header is NEVER overridable");
  assert.equal(trailerOf(full), trailerOf(lean), "safety trailer is NEVER overridable");
  const custom = buildRecoveryPrompt({ ...base, lean: true, recoveryPrompt: "CUSTOM BODY LINE" });
  assert.ok(custom.includes("CUSTOM BODY LINE") && !custom.includes("read them NOW"), "explicit recoveryPrompt beats lean tiers");
});

test("RC5: config — recovery.lean defaults false; merge is strict; env override works", () => {
  assert.equal(DEFAULT_CONFIG.recovery.lean, false, "lean recovery is OPT-IN");
  assert.equal(DEFAULT_CONFIG.recovery.budgetTokens, 12_000);
  assert.equal(DEFAULT_RECOVERY.lean, false);
  const cfg = loadConfig((p) => (p === "handoff.config.json" ? JSON.stringify({ recovery: { lean: true, budgetTokens: 9000 } }) : undefined), {});
  assert.equal(cfg.recovery.lean, true);
  assert.equal(cfg.recovery.budgetTokens, 9000);
  const bad = loadConfig((p) => (p === "handoff.config.json" ? JSON.stringify({ recovery: { lean: "yes", budgetTokens: -5 } }) : undefined), {});
  assert.deepEqual(bad.recovery, DEFAULT_RECOVERY, "garbage is ignored, defaults kept");
  const env = loadConfig(() => undefined, { CONTEXT_GUARD_LEAN: "1" });
  assert.equal(env.recovery.lean, true, "CONTEXT_GUARD_LEAN=1 forces lean for probes");
  assert.equal(mergeRecovery(DEFAULT_RECOVERY, { budgetTokens: 12_000 }).budgetTokens, 12_000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { recovery: { lean: true } } as never).recovery.lean, true);
});

test("RC6: adapter — lean renewal reaches the successor message (exact bytes) and cost meter appears in status/verify/finalize", async () => {
  const memFs = createMemoryFs({ ...DEFAULT_FILES, "/project/handoff.config.json": JSON.stringify({ stateDir: ".pi-guard", recovery: { lean: true }, renewal: { enabled: true, autoRenew: false, maxRenewals: 8 } }) });
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "session-C", usage: { tokens: 1000, contextWindow: 220000 } });
  contextGuard(pi.pi as never, { fs: memFs, env: {} });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  // cost meter in /guard status (read-only computation, zero writes beyond state)
  await pi.runCommand("guard", "status", mc.ctx);
  const status = mc.notifications.map((n) => n.text).join("\n");
  assert.match(status, /recovery cost: full .* lean operational/);
  // lean renewal: successor message carries the tiered body, header/safety intact
  await pi.runCommand("handoff", "finalize before renew", mc.ctx);
  await pi.runCommand("handoff", "renew", mc.ctx);
  const sent = mc.recoverySends[0]?.message;
  assert.ok(sent, "recovery message sent to successor");
  assert.equal(sent.customType, "context-guard-recovery");
  assert.ok(sent.content.includes("read them NOW"), "lean body crossed into the successor message");
  assert.ok(sent.content.includes("[context-guard renewal 1/8]"), "mandatory header kept");
  assert.ok(sent.content.includes("never push without human authorization"), "mandatory safety trailer kept");
  assert.ok(!sent.content.includes("read AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md."), "generic read-all body replaced");
  // finalize report carries the meter too
  assert.match(mc.notifications.map((n) => n.text).join("\n"), /recovery cost/);
});
