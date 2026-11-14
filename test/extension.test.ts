/**
 * Extension wiring tests against mocked Pi API events (all 10 requirements,
 * adapter level). Synthetic budgets; zero inference; real pi runtime NOT loaded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { readRecoveryBundle, joinPath, sha256 } from "../.pi/extensions/context-guard/checkpoint.ts";
import { parseDocumentationCycleState } from "../.pi/extensions/context-guard/documentation-cycle.ts";
import { INITIAL_RENEWAL_STATE, serializeRenewalState, type RenewalState } from "../.pi/extensions/context-guard/renewal.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

interface Harness {
  mockPi: ReturnType<typeof createMockPi>;
  memFs: ReturnType<typeof createMemoryFs>;
  mockCtx: ReturnType<typeof createMockCtx>;
  turnEnd: (usageTokens: number | null) => Promise<void>;
  toolCall: (name: string, input?: unknown) => Promise<any>;
  command: (name: string, args: string) => Promise<void>;
}

function harness(options: {
  usage?: { tokens: number | null; contextWindow: number } | null;
  model?: { maxTokens: number; contextWindow: number } | null;
  sessionId?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  gitRevision?: string;
  cancelNewSession?: boolean;
} = {}): Harness {
  const memFs = createMemoryFs(options.files ?? DEFAULT_FILES);
  const mockPi = createMockPi();
  const mockCtx = createMockCtx({
    cwd: "/project",
    usage: options.usage === null ? null : options.usage,
    model: options.model === null ? undefined : options.model,
    sessionId: options.sessionId ?? "session-1",
    cancelNewSession: options.cancelNewSession,
  });
  contextGuard(mockPi.pi as never, {
    fs: memFs,
    env: options.env ?? {},
    ...(options.gitRevision ? { gitRevision: () => options.gitRevision } : {}),
    ...(options.config ? { config: options.config as never } : {}),
  });
  return {
    mockPi,
    memFs,
    mockCtx,
    async turnEnd(usageTokens) {
      mockCtx.ctx.__usage = usageTokens;
      await mockPi.emit({ type: "turn_end", turnIndex: 1, entries: [], continue: false, context: {}, outcome: "completed" } as never, {
        ...mockCtx.ctx,
        getContextUsage: () =>
          usageTokens === null
            ? undefined
            : { tokens: usageTokens, contextWindow: mockCtx.ctx.model?.contextWindow ?? 220000, percent: null },
      } as never);
    },
    async toolCall(name, input = {}) {
      const handlers = mockPi.handlers.get("tool_call") ?? [];
      let result: any;
      for (const h of handlers) result = await h({ type: "tool_call", toolName: name, input }, mockCtx.ctx);
      return result;
    },
    async command(name, args) {
      // session_start must be emitted by the caller first
      await mockPi.runCommand(name, args, mockCtx.ctx);
    },
  };
}

async function startSession(h: Harness) {
  await h.mockPi.emit({ type: "session_start", reason: "startup" } as never, h.mockCtx.ctx as never);
}

function alerts(h: Harness) {
  return h.mockPi.sentMessages.filter((m) => m.message.customType === "context-guard");
}

const CYCLE_REVISION = "a".repeat(40);
const RENEWAL_STATE_FILE = "/project/.pi-guard/renewal-state.json";
const CYCLE_STATE_FILE = "/project/.pi-guard/documentation-cycle/state.json";

function seedLegacyChain(h: Harness, chainId = "chain:session-1") {
  h.memFs.writeFile(RENEWAL_STATE_FILE, serializeRenewalState({ ...INITIAL_RENEWAL_STATE, chainId, updatedAt: 1 }));
}

async function readyCappedCycleHarness(options: { cancelNewSession?: boolean } = {}) {
  const h = harness({
    config: { renewal: { enabled: true, maxRenewals: 2 }, documentation: { enabled: true, archiveDir: "docs/history" } },
    gitRevision: CYCLE_REVISION,
    cancelNewSession: options.cancelNewSession,
  });
  await startSession(h);
  await h.command("handoff", "checkpoint campaign work complete");
  await h.command("handoff", "ready");
  const chain: RenewalState = { ...INITIAL_RENEWAL_STATE, chainId: "chain:campaign-old", renewalsDone: 2, renewedFromCheckpointId: "g-old-campaign", updatedAt: 123 };
  h.memFs.writeFile(RENEWAL_STATE_FILE, serializeRenewalState(chain));
  return h;
}

function cycleState(h: Harness) {
  const parsed = parseDocumentationCycleState(h.memFs.files.get(CYCLE_STATE_FILE));
  assert.equal(parsed.corrupt, false, "cycle state remains parseable");
  assert.ok(parsed.state, `cycle state exists (notifications: ${JSON.stringify(h.mockCtx.notifications)})`);
  return parsed.state!;
}

function cyclePlan(h: Harness, result: "CHANGE" | "NO_CHANGE" = "CHANGE") {
  const s = cycleState(h);
  const target = result === "NO_CHANGE" ? "none" : "HANDOFF.md, PROGRESS.md, docs/history/section.md";
  const body = [
    `Cycle-ID: ${s.cycleId}`,
    `Base-Revision: ${s.baseRevision}`,
    `Base-Fingerprint: ${s.baseFingerprint}`,
    `Result: ${result}`,
    `Target-Files: ${target}`,
    "",
    result === "NO_CHANGE" ? "NO CHANGE: no justified consolidation." : "Plan: replace one obsolete operational section and archive the exact original excerpt.",
    "",
  ].join("\n");
  h.memFs.files.set(s.planFile, body);
  return { state: s, body, hash: sha256(body) };
}

function cycleReview(h: Harness, result: "PASS" | "NEEDS_CORRECTION" = "PASS") {
  const s = cycleState(h);
  const body = [
    `Cycle-ID: ${s.cycleId}`,
    `Review-Revision: ${s.reviewRevision}`,
    `Review-Fingerprint: ${s.reviewFingerprint}`,
    `Review-Result: ${result}`,
    "",
    "GOAL.md is unchanged; negative evidence and archive references checked; scientific claims not independently validated.",
    "",
  ].join("\n");
  h.memFs.files.set(s.reviewFile, body);
  return { state: s, body, hash: sha256(body) };
}

/* ------------------------------------------------------------------ */

test("R1: crossing 30k remaining sends exactly one advisory custom message at turn_end", async () => {
  // contextWindow 220000, model maxTokens 65536 -> reserve 65536
  // remaining = 220000 - tokens - 65536; for remaining ~29000 -> tokens = 125464
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464);
  assert.equal(alerts(h).length, 1);
  assert.match(alerts(h)[0].message.content, /CONTEXT PRESSURE \(advisory\)/);
  assert.match(alerts(h)[0].message.content, /Update PROGRESS.md/);
  assert.deepEqual(alerts(h)[0].options, { triggerTurn: false }); // deferred append: never interrupts in-flight tools
  assert.equal(h.mockPi.entries.filter((e) => (e.data as any)?.alertLevels).length, 1, "one alert audit entry appended");
});

test("R1b: no alerts while budget is healthy", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(1000); // remaining ~152k
  assert.equal(alerts(h).length, 0);
});

test("R2: /guard simulate 4000 delivers one message covering all four thresholds", async () => {
  const h = harness();
  await startSession(h);
  await h.command("guard", "simulate 4000");
  assert.equal(alerts(h).length, 1);
  const text = alerts(h)[0].message.content;
  assert.match(text, /4 pressure thresholds crossed in one step/);
  assert.equal((text.match(/CONTEXT PRESSURE/g) ?? []).length, 3);
  assert.equal((text.match(/CONTEXT CRITICAL/g) ?? []).length, 1);
});

test("R3: same threshold never alerts twice, including across simulate + turn_end", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464); // level 1
  await h.turnEnd(125464);
  await h.command("guard", "simulate 29000");
  assert.equal(alerts(h).length, 1);
});

test("R4: missing context usage -> no alerts, no crash; degraded notice after repeated unknowns", async () => {
  const h = harness({ usage: null }); // getContextUsage() returns undefined
  await startSession(h);
  await h.turnEnd(null);
  await h.turnEnd(null);
  assert.equal(alerts(h).length, 0);
  await h.turnEnd(null);
  assert.ok(h.mockCtx.notifications.some((n) => n.text.includes("measurement unavailable")));
  // null tokens (post-compaction unknown) behaves the same
  const h2 = harness({ usage: { tokens: null, contextWindow: 220000 } });
  await startSession(h2);
  await h2.command("guard", "status");
  assert.ok(h2.mockCtx.notifications.some((n) => n.text.includes("no-usage")));
  assert.equal(alerts(h2).length, 0);
  await h2.turnEnd(null);
  assert.equal(alerts(h2).length, 0);
});

test("R4b: unknown model (no contextWindow) is handled safely", async () => {
  const h = harness({ usage: null, model: null });
  await startSession(h);
  await h.turnEnd(null);
  assert.equal(alerts(h).length, 0);
});

test("R5: checkpoint write failure is notified and does not crash the guard", async () => {
  const h = harness();
  await startSession(h);
  h.memFs.failNext.set("/project/HANDOFF.md", 1);
  await h.command("guard", "simulate 9000"); // level 3 => auto checkpoint
  assert.ok(h.mockCtx.notifications.some((n) => n.text.includes("checkpoint failed")));
  // guard keeps functioning: further evaluations still work
  await h.command("guard", "simulate 8000");
  assert.equal(alerts(h).length, 1); // level 3 alert fired once
});

test("R6: corrupt (legacy) state file quarantined on session_start; guard restarts with fresh alerts", async () => {
  const files = { ...DEFAULT_FILES, "/project/.pi-guard/state.json": '{"version":1,"sessionId":"session-1","snapshot":{' };
  const h = harness({ files });
  await startSession(h);
  // corrupt copy quarantined to a .bak, then a FRESH valid state written per-session
  const backups = [...h.memFs.files.keys()].filter((k) => k.includes("corrupt") && k.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.ok(backups[0].startsWith("/project/.pi-guard/state.json"));
  const fresh = JSON.parse(h.memFs.files.get("/project/.pi-guard/sessions/session-1.json")!);
  assert.equal(fresh.version, 2);
  assert.equal(fresh.sessionId, "session-1");
  assert.deepEqual(fresh.snapshot.alertedLevels, []); // fail-safe: machine reset
  assert.equal(fresh.notes, "recovered from corrupt state file");
  await h.turnEnd(125464); // level 1 alerts normally after safe fallback
  assert.equal(alerts(h).length, 1);
});

test("R6b: same-session restart restores spent alerts (no re-fire after reload)", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464);
  assert.equal(alerts(h).length, 1);

  // Simulate extension reload in the SAME session: fresh guard, same state dir + sessionId.
  const h2 = harness({ files: Object.fromEntries(h.memFs.files) as Record<string, string> });
  await startSession(h2);
  await h2.turnEnd(125464);
  assert.equal(alerts(h2).length, 0);

  // New session id => alerts re-armed (one alert per threshold per session).
  const h3 = harness({ files: Object.fromEntries(h2.memFs.files) as Record<string, string>, sessionId: "session-2" });
  await startSession(h3);
  await h3.turnEnd(125464);
  assert.equal(alerts(h3).length, 1);
});

test("R7: a model that ignores advisories is still constrained at the enforced level; advisory does not block tools", async () => {
  const h = harness();
  await startSession(h);
  // advisory level 1: bash allowed (advisory, not enforced)
  await h.turnEnd(125464);
  assert.equal(await h.toolCall("bash", { command: "ls" }), undefined);
  // model keeps working past warnings straight into enforced closing
  await h.command("guard", "simulate 4000");
  const blocked = await h.toolCall("bash", { command: "rm -rf /" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /closing phase/);
  // checkpoint tools stay available
  assert.equal(await h.toolCall("write", { path: "/project/HANDOFF.md", content: "x" }), undefined);
  assert.equal(await h.toolCall("edit", { path: "HANDOFF.md" }), undefined);
});

test("R7b: GOAL.md is protected from silent rewrite by write/edit (any level)", async () => {
  const h = harness();
  await startSession(h);
  const blocked = await h.toolCall("write", { path: "/project/GOAL.md", content: "new goal" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /GOAL.md is protected/);
  assert.equal(await h.toolCall("write", { path: "PROGRESS.md", content: "y" }), undefined);
});

test("R7c: enforceClosing=false keeps level 4 advisory-only (distinguish enforced vs advisory)", async () => {
  const h = harness({ config: { enforceClosing: false } });
  await startSession(h);
  await h.command("guard", "simulate 4000");
  assert.equal(await h.toolCall("bash", { command: "echo hi" }), undefined);
});

test("R8: unresolved discoveries survive an auto checkpoint", async () => {
  const h = harness();
  await startSession(h);
  const before = h.memFs.files.get("/project/LEARNINGS.md");
  await h.command("guard", "simulate 9000"); // level 3 auto-checkpoint
  assert.equal(h.memFs.files.get("/project/LEARNINGS.md"), before);
  const handoff = h.memFs.files.get("/project/HANDOFF.md") ?? "";
  // agent-authored HANDOFF sections preserved alongside the guard block
  assert.ok(handoff.includes("## Discoveries not yet incorporated"));
  assert.ok(handoff.includes("followUp deferral semantics."));
  assert.ok(handoff.includes("guard:begin checkpoint"));
});

test("R9: /handoff writes a checkpoint whose next action and objective survive a simulated fresh restore", async () => {
  const h = harness();
  await startSession(h);
  await h.command("handoff", "checkpoint phase 1 demo");
  const bundle = readRecoveryBundle(h.memFs, "/project", FILES);
  assert.equal(bundle.objective, "Build a context guard prototype.");
  assert.ok(bundle.nextAction && bundle.nextAction.length > 0);
  assert.ok(bundle.recoveryInstructions.length > 0);
  const handoff = h.memFs.files.get("/project/HANDOFF.md") ?? "";
  assert.ok(handoff.includes("phase 1 demo"));
  assert.ok(h.memFs.exists("/project/.pi-guard/sessions/session-1.json")); // per-session state
  // manual prose wins the recovery bundle (Phase 1b precedence), checkpoint is current
  const bundle2 = readRecoveryBundle(h.memFs, "/project", FILES);
  assert.equal(bundle2.nextActionSource, "handoff-prose");
  assert.equal(bundle2.checkpoint.kind, "current");
});

test("A2: /handoff status and unknown verbs are read-only on an attested checkpoint", async () => {
  const h = harness({ config: { renewal: { enabled: true, autoRenew: true, maxRenewals: 8 } } });
  seedLegacyChain(h);
  await startSession(h);
  await h.command("handoff", "checkpoint preserve these notes");
  await h.command("handoff", "ready");
  assert.match(h.memFs.files.get("/project/HANDOFF.md") ?? "", /Guard notes\npreserve these notes/);
  assert.match(h.memFs.files.get("/project/HANDOFF.md") ?? "", /readiness: attested/);

  const before = [...h.memFs.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const writesBefore = h.memFs.writes.length;
  const checkpointId = h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1];
  await h.command("handoff", "status");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /checkpoint current .*attested; renewal ready-now/);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /renewal ready-now/);
  assert.deepEqual([...h.memFs.files.entries()].sort(([a], [b]) => a.localeCompare(b)), before);
  assert.equal(h.memFs.writes.length, writesBefore);
  assert.equal(h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1], checkpointId);

  await h.command("handoff", "statuz");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /usage: \/handoff status/);
  assert.deepEqual([...h.memFs.files.entries()].sort(([a], [b]) => a.localeCompare(b)), before);
  assert.equal(h.memFs.writes.length, writesBefore);
});

test("R10: no compaction, no session switching, no settings/install writes, stable system prompt", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464);
  await h.command("guard", "simulate 4000");
  await h.toolCall("bash", {});
  await h.command("handoff", "checkpoint final");
  await h.mockPi.emit({ type: "session_shutdown", reason: "quit" } as never, h.mockCtx.ctx as never);

  assert.equal(h.mockCtx.compactCalls, 0);
  assert.equal(h.mockCtx.newSessionCalls, 0);
  assert.equal(h.mockCtx.switchSessionCalls, 0);

  const touched = h.memFs.writes.filter((p) => !p.startsWith("/project/"));
  assert.deepEqual(touched, []); // everything stays inside the project dir
  const configWrites = h.memFs.writes.filter((p) => p.includes("settings") || p.includes("config.yml") || p.includes("node_modules"));
  assert.deepEqual(configWrites, []);

  // Static contract (re-specified for Phase 2): compaction, switchSession, fork,
  // navigateTree and system-prompt mutation remain FORBIDDEN. Session replacement is
  // allowed only through either the gated renewal path or the explicitly operator-
  // invoked documentation-cycle path. They remain separate and independently gated.
  const src = readFileSync(new URL("../.pi/extensions/context-guard/index.ts", import.meta.url), "utf8");
  for (const forbidden of [".compact(", "switchSession(", "fork(", "systemPrompt", "context_with_system", "navigateTree("]) {
    assert.ok(!src.includes(forbidden), `extension source must not reference ${forbidden}`);
  }
  assert.equal((src.match(/\.newSession\(/g) ?? []).length, 2, "only renewal and explicit documentation-cycle transitions may create sessions");
  const renewBody = src.slice(src.indexOf("async function runRenewal"), src.indexOf("Model-initiated renewal"));
  assert.ok(renewBody.includes("decideRenewal(") && renewBody.includes("await ctx.waitForIdle()") && renewBody.includes(".newSession("), "newSession lives in runRenewal, after the idle boundary and the decision gate");
  const cycleBody = src.slice(src.indexOf("async function dispatchDocumentationStage"), src.indexOf("async function runDocumentationCycle"));
  assert.ok(cycleBody.includes("operatorInvoked: true") && cycleBody.includes(".newSession("), "documentation-cycle session creation is separately marked and explicitly staged");
  const toolBody = src.slice(src.indexOf("name: \"handoff_renew\""), src.indexOf("registerCommand(\"handoff\""));
  assert.ok(!toolBody.includes(".newSession(") && !toolBody.includes("waitForIdle("), "the model-facing tool NEVER calls waitForIdle or switches sessions itself (P-8 deadlock rule)");
});

test("alerts survive as custom entries; guard messages are added without triggering extra turns", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464);
  const sent = alerts(h)[0];
  assert.equal(sent.options.triggerTurn, false);
  assert.equal(sent.message.display, true);
  assert.equal(h.mockPi.entries[0].type, "context-guard");
});

test("auto-checkpoint refreshes stale state but reuses a current identity across threshold escalations", async () => {
  const h = harness();
  await startSession(h);
  await h.command("guard", "simulate 9000"); // level 3 -> checkpoint
  const handoffAfterFirst = h.memFs.files.get("/project/HANDOFF.md");
  const id = handoffAfterFirst?.match(/checkpoint-id: ([^\n]+)/)?.[1];
  const writesAfterFirst = h.memFs.writes.filter((p) => p === "/project/HANDOFF.md" || p === "/project/PROGRESS.md").length;
  await h.command("guard", "simulate 8500"); // still level 3 -> no new checkpoint stamp change
  const handoffAfterSecond = h.memFs.files.get("/project/HANDOFF.md");
  assert.match(handoffAfterFirst ?? "", /status: checkpoint \(guard level 3/);
  assert.equal(handoffAfterSecond, handoffAfterFirst, "same-level evaluation does not rewrite a current checkpoint");
  await h.command("guard", "simulate 4000"); // escalate to 4; existing identity still authorizes the same transition
  assert.equal(h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1], id);
  assert.equal(h.memFs.writes.filter((p) => p === "/project/HANDOFF.md" || p === "/project/PROGRESS.md").length, writesAfterFirst);
});

test("A4: handoff_inspect reports current readiness without any file or state writes", async () => {
  const h = harness({ config: { renewal: { enabled: true, autoRenew: true, maxRenewals: 8 } } });
  seedLegacyChain(h);
  await startSession(h);
  await h.command("handoff", "checkpoint inspect fixture");
  await h.command("handoff", "ready");
  const beforeFiles = new Map(h.memFs.files);
  const beforeWrites = [...h.memFs.writes];
  const tool = h.mockPi.tools.get("handoff_inspect");
  assert.ok(tool, "model-callable inspection tool registered");
  const report = await tool.execute("inspect-current", { details: true }, undefined, undefined, h.mockCtx.ctx);
  assert.equal(report.details.checkpoint, "current");
  assert.ok(report.details.id);
  assert.equal(report.details.attestation, "attested");
  assert.equal(report.details.renewal.state, "ready-now");
  assert.equal(report.details.nextAction.status, "pass");
  assert.deepEqual(report.details.documentOwnership.manualProse, ["HANDOFF.md", "PROGRESS.md"]);
  assert.deepEqual(report.details.documentOwnership.managedCheckpointBlocks, ["HANDOFF.md", "PROGRESS.md"]);
  assert.equal(report.details.documentOwnership.gitWorkingTree, "not-inspected");
  assert.match(report.content[0].text, /manual prose and Handoff-managed blocks are distinct/);
  assert.match(report.content[0].text, /Git working-tree state is not inspected/);
  assert.match(report.details.science, /NOT been independently verified/i);
  assert.deepEqual(h.memFs.files, beforeFiles);
  assert.deepEqual(h.memFs.writes, beforeWrites);
  assert.equal(h.mockCtx.newSessionCalls, 0);
  assert.equal(h.mockPi.userMessages.length, 0);
});

test("D1: repeated checkpoint and attestation reuse the current identity without file or state writes", async () => {
  const h = harness();
  await startSession(h);
  await h.command("handoff", "checkpoint initial durable note");
  await h.command("handoff", "ready");
  const id = h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1];
  const beforeFiles = new Map(h.memFs.files);
  const beforeWrites = [...h.memFs.writes];

  await h.command("handoff", "checkpoint");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /checkpoint unchanged/);
  await h.command("handoff", "ready");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /already attested .* no files changed/);

  assert.deepEqual(h.memFs.files, beforeFiles);
  assert.deepEqual(h.memFs.writes, beforeWrites);
  assert.equal(h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1], id);
});

test("D1b: substantive checkpoint notes create a fresh unattested generation", async () => {
  const h = harness();
  await startSession(h);
  await h.command("handoff", "checkpoint initial notes");
  await h.command("handoff", "ready");
  const oldId = h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-id: ([^\n]+)/)?.[1];
  const oldGeneration = Number(h.memFs.files.get("/project/HANDOFF.md")?.match(/checkpoint-generation: (\d+)/)?.[1]);

  await h.command("handoff", "checkpoint added durable finding");
  const handoff = h.memFs.files.get("/project/HANDOFF.md") ?? "";
  const progress = h.memFs.files.get("/project/PROGRESS.md") ?? "";
  assert.notEqual(handoff.match(/checkpoint-id: ([^\n]+)/)?.[1], oldId);
  assert.equal(Number(handoff.match(/checkpoint-generation: (\d+)/)?.[1]), oldGeneration + 1);
  assert.equal(handoff.match(/checkpoint-id: ([^\n]+)/)?.[1], progress.match(/checkpoint-id: ([^\n]+)/)?.[1]);
  assert.match(handoff, /Guard notes\nadded durable finding/);
  assert.match(handoff, /readiness: unattested/);
});

test("D2: healthy inspect is concise by default and detailed diagnostics remain available on request", async () => {
  const h = harness({ config: { renewal: { enabled: true, autoRenew: true, maxRenewals: 8 } } });
  seedLegacyChain(h);
  await startSession(h);
  await h.command("handoff", "checkpoint inspect fixture");
  await h.command("handoff", "ready");
  const tool = h.mockPi.tools.get("handoff_inspect");
  const brief = await tool.execute("inspect-brief", {}, undefined, undefined, h.mockCtx.ctx);
  assert.match(brief.content[0].text, /^checkpoint current .*attested; renewal ready-now \(\d+\/\d+\); mission lifecycle legacy\./);
  assert.match(brief.content[0].text, /Mission\/scientific claims are not independently verified/);
  assert.doesNotMatch(brief.content[0].text, /recovery cost|changed sources|document ownership/i);
  const full = await tool.execute("inspect-full", { details: true }, undefined, undefined, h.mockCtx.ctx);
  assert.match(full.content[0].text, /document ownership: manual prose and Handoff-managed blocks are distinct/);
});

test("E1: documentation workflow is opt-in, starts a fresh read-only planning mission, and cannot replay it", async () => {
  const off = harness({ gitRevision: CYCLE_REVISION });
  await startSession(off);
  await off.command("handoff", "cycle plan");
  assert.match(off.mockCtx.notifications.at(-1)?.text ?? "", /documentation.enabled is false/);
  assert.equal(off.mockCtx.newSessionCalls, 0);
  assert.equal(off.memFs.files.has(CYCLE_STATE_FILE), false);

  const h = await readyCappedCycleHarness();
  const beforeRenewal = h.memFs.files.get(RENEWAL_STATE_FILE);
  await h.command("handoff", "cycle plan");
  assert.equal(h.mockCtx.newSessionCalls, 1);
  const firstTurn = h.mockCtx.recoverySends.at(-1);
  assert.equal(firstTurn?.options.triggerTurn, true);
  assert.match(firstTurn?.message.content ?? "", /read-only audit/);
  assert.match(firstTurn?.message.content ?? "", /not a human-authored message/);
  const state = cycleState(h);
  assert.equal(state.phase, "planning");
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), beforeRenewal, "documentation stage does not consume or alter the development chain");
  const beforeStatus = new Map(h.memFs.files);
  const writesBeforeStatus = [...h.memFs.writes];
  await h.command("handoff", "cycle status");
  assert.deepEqual(h.memFs.files, beforeStatus, "cycle status is read-only across durable and runtime files");
  assert.deepEqual(h.memFs.writes, writesBeforeStatus);
  await h.command("handoff", "cycle plan");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /current phase is planning/);
  assert.equal(h.mockCtx.newSessionCalls, 1, "repeated stage command never creates a second session");
});

test("Q2: documentation-cycle continuation refuses missing or corrupt chain state without initializing it", async () => {
  const h = harness({ config: { renewal: { enabled: true, maxRenewals: 2 }, documentation: { enabled: true, archiveDir: "docs/history" } }, gitRevision: CYCLE_REVISION });
  await startSession(h);
  h.memFs.files.delete(RENEWAL_STATE_FILE);
  const beforeDocs = ["/project/HANDOFF.md", "/project/PROGRESS.md", "/project/LEARNINGS.md"].map((p) => h.memFs.files.get(p));
  await h.command("handoff", "cycle continue");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /cycle: continue refused.*state is missing/);
  assert.equal(h.memFs.files.has(RENEWAL_STATE_FILE), false);
  assert.equal(h.memFs.files.has(CYCLE_STATE_FILE), false);
  assert.deepEqual(["/project/HANDOFF.md", "/project/PROGRESS.md", "/project/LEARNINGS.md"].map((p) => h.memFs.files.get(p)), beforeDocs);

  h.memFs.writeFile(RENEWAL_STATE_FILE, "{corrupt");
  const corruptBytes = h.memFs.files.get(RENEWAL_STATE_FILE);
  await h.command("handoff", "cycle continue");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /cycle: continue refused.*state is corrupt/);
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), corruptBytes, "corrupt bytes are preserved");
});

test("E2: stale plan approval is refused when source documents change", async () => {
  const h = await readyCappedCycleHarness();
  await h.command("handoff", "cycle plan");
  const plan = cyclePlan(h);
  h.memFs.files.set("/project/PROGRESS.md", `${h.memFs.files.get("/project/PROGRESS.md")}\nmanual correction after plan\n`);
  const renewalBefore = h.memFs.files.get(RENEWAL_STATE_FILE);
  await h.command("handoff", `cycle approve ${plan.hash}`);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /reference changed since planning/);
  assert.equal(cycleState(h).phase, "planning");
  assert.equal(h.mockCtx.newSessionCalls, 1);
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), renewalBefore);
});

test("E3: explicit plan approval, durable_edit application mission and independent review gate a new chain", async () => {
  const h = await readyCappedCycleHarness();
  const oldChainRaw = h.memFs.files.get(RENEWAL_STATE_FILE)!;
  await h.command("handoff", "cycle plan");
  const plan = cyclePlan(h);
  await h.command("handoff", `cycle approve ${plan.hash}`);
  assert.equal(cycleState(h).phase, "approved");
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), oldChainRaw);
  await h.command("handoff", "cycle apply");
  assert.equal(cycleState(h).phase, "applying");
  assert.equal(h.mockCtx.newSessionCalls, 2);
  assert.match(h.mockCtx.recoverySends.at(-1)?.message.content ?? "", new RegExp(plan.hash));
  assert.match(h.mockCtx.recoverySends.at(-1)?.message.content ?? "", /Apply approved plan/);

  h.memFs.files.set("/project/PROGRESS.md", `${h.memFs.files.get("/project/PROGRESS.md")}\n## Historical context\nArchived material is linked.\n`);
  await h.command("handoff", "cycle review");
  assert.equal(cycleState(h).phase, "reviewing");
  assert.equal(h.mockCtx.newSessionCalls, 3, "review uses an independent fresh context");
  const review = cycleReview(h);
  await h.command("handoff", `cycle accept-review ${review.hash}`);
  assert.equal(cycleState(h).phase, "verified");
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), oldChainRaw, "review acceptance alone does not reset renewal state");

  await h.command("handoff", "finalize");
  assert.equal(h.mockCtx.newSessionCalls, 3);
  await h.command("handoff", "cycle continue");
  assert.equal(cycleState(h).phase, "complete");
  const newChain = JSON.parse(h.memFs.files.get(RENEWAL_STATE_FILE)!);
  assert.equal(newChain.chainId, `chain:${plan.state.cycleId}`);
  assert.equal(newChain.renewalsDone, 0);
  assert.equal(newChain.renewedFromCheckpointId, null);
  assert.equal(newChain.stopped, false);
  const archivePath = `/project/docs/history/renewal-chain-${plan.state.cycleId}.json`;
  const archive = JSON.parse(h.memFs.files.get(archivePath)!);
  assert.deepEqual(archive.archivedRenewalState, JSON.parse(oldChainRaw));
  assert.equal(h.mockCtx.newSessionCalls, 3, "continue initializes state but never silently starts a campaign session");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /Scientific validation remains an independent/);
});

test("E4: NO CHANGE can skip application/review; interrupted chain reset resumes without losing the old chain", async () => {
  const h = await readyCappedCycleHarness();
  const old = h.memFs.files.get(RENEWAL_STATE_FILE)!;
  await h.command("handoff", "cycle plan");
  const plan = cyclePlan(h, "NO_CHANGE");
  await h.command("handoff", `cycle no-change ${plan.hash}`);
  assert.equal(cycleState(h).phase, "no-change");
  assert.equal(h.mockCtx.newSessionCalls, 1, "NO CHANGE does not force apply/review sessions");
  const renewalPath = RENEWAL_STATE_FILE;
  h.memFs.failNext.set(renewalPath, 1);
  await h.command("handoff", "cycle continue");
  assert.equal(cycleState(h).phase, "continuing", "partial transition remains journaled for explicit retry");
  assert.equal(h.memFs.files.get(renewalPath), old, "failed reset keeps old chain bytes");
  const s = cycleState(h);
  assert.ok(s.archivePath && h.memFs.files.has(s.archivePath), "old chain archive survived the interrupted reset");
  await h.command("handoff", "cycle continue");
  assert.equal(cycleState(h).phase, "complete");
  assert.equal(JSON.parse(h.memFs.files.get(renewalPath)!).renewalsDone, 0);
  assert.equal(h.mockCtx.newSessionCalls, 1);
});

test("E5: reviewer report cannot be accepted after manual edits; review can be explicitly reopened", async () => {
  const h = await readyCappedCycleHarness();
  await h.command("handoff", "cycle plan");
  const plan = cyclePlan(h);
  await h.command("handoff", `cycle approve ${plan.hash}`);
  await h.command("handoff", "cycle apply");
  await h.command("handoff", "cycle review");
  const oldReview = cycleReview(h);
  h.memFs.files.set("/project/HANDOFF.md", `${h.memFs.files.get("/project/HANDOFF.md")}\nmanual correction after review start\n`);
  await h.command("handoff", `cycle accept-review ${oldReview.hash}`);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /documents or Git HEAD changed after the independent review/);
  await h.command("handoff", "cycle review");
  assert.equal(h.mockCtx.newSessionCalls, 4, "changed documents start a new, explicitly requested review");
  await h.command("handoff", "cycle review");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /already pending/);
  assert.equal(h.mockCtx.newSessionCalls, 4);
});

test("E6: crashed transition lock requires the displayed recovery token and never replays a stage", async () => {
  const h = await readyCappedCycleHarness();
  await h.command("handoff", "cycle plan");
  const lock = "/project/.pi-guard/documentation-cycle/transition.lock";
  const raw = JSON.stringify({ command: "plan", sessionId: "lost-process", startedAt: 1 });
  h.memFs.createExclusive(lock, raw);
  await h.command("handoff", "cycle status");
  const token = sha256(raw);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", new RegExp(token));
  await h.command("handoff", "cycle recover wrong-token");
  assert.equal(h.memFs.files.has(lock), true);
  await h.command("handoff", `cycle recover ${token}`);
  assert.equal(h.memFs.files.has(lock), false);
  await h.command("handoff", "cycle plan");
  assert.equal(h.mockCtx.newSessionCalls, 1, "recovery unlock does not replay the persisted planning stage");
});

test("E7: cancelled stage dispatch sends no mission and needs an explicit new plan request", async () => {
  const h = await readyCappedCycleHarness({ cancelNewSession: true });
  const oldChain = h.memFs.files.get(RENEWAL_STATE_FILE);
  await h.command("handoff", "cycle plan");
  assert.equal(h.mockCtx.newSessionCalls, 1);
  assert.equal(h.mockCtx.recoverySends.length, 0);
  assert.equal(cycleState(h).phase, "abandoned");
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), oldChain);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /session was cancelled; no mission turn was sent/);
});

test("E8: plan approval rejects a protected GOAL target even through a nested path", async () => {
  const h = await readyCappedCycleHarness();
  await h.command("handoff", "cycle plan");
  const s = cycleState(h);
  const body = [
    `Cycle-ID: ${s.cycleId}`,
    `Base-Revision: ${s.baseRevision}`,
    `Base-Fingerprint: ${s.baseFingerprint}`,
    "Result: CHANGE",
    "Target-Files: docs/archive/GOAL.md",
    "Operation: rewrite historical objective",
  ].join("\n");
  h.memFs.files.set(s.planFile, body);
  await h.command("handoff", `cycle approve ${sha256(body)}`);
  assert.equal(cycleState(h).phase, "planning");
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /plan targets protected GOAL\.md/);
  assert.equal(h.mockCtx.newSessionCalls, 1);
});

test("E9: documentation cycle cannot bypass the operator's durable stop flag", async () => {
  const h = await readyCappedCycleHarness();
  const stopped = { ...JSON.parse(h.memFs.files.get(RENEWAL_STATE_FILE)!), stopped: true } as RenewalState;
  h.memFs.writeFile(RENEWAL_STATE_FILE, serializeRenewalState(stopped));
  const before = h.memFs.files.get(RENEWAL_STATE_FILE);
  await h.command("handoff", "cycle plan");
  assert.equal(h.mockCtx.newSessionCalls, 0);
  assert.equal(h.memFs.files.get(RENEWAL_STATE_FILE), before);
  assert.match(h.mockCtx.notifications.at(-1)?.text ?? "", /durably stopped/);
});

test("A4: handoff_inspect reports changed sources and is callable during enforced closing", async () => {
  const h = harness();
  await startSession(h);
  await h.command("handoff", "checkpoint inspect fixture");
  await h.command("handoff", "ready");
  await h.command("guard", "simulate 4000");
  const result = await h.toolCall("handoff_inspect");
  assert.equal(result?.block, undefined, "read-only inspection is allowed during enforced closing");
  h.memFs.files.set("/project/PROGRESS.md", `${h.memFs.files.get("/project/PROGRESS.md")}\nnew durable fact\n`);
  const beforeFiles = new Map(h.memFs.files);
  const beforeWrites = [...h.memFs.writes];
  const tool = h.mockPi.tools.get("handoff_inspect");
  const report = await tool.execute("inspect-stale", {}, undefined, undefined, h.mockCtx.ctx);
  assert.equal(report.details.checkpoint, "stale");
  assert.ok(report.details.changedSources.includes("progress"));
  assert.deepEqual(h.memFs.files, beforeFiles);
  assert.deepEqual(h.memFs.writes, beforeWrites, "inspection itself adds no durable or state writes");
});
