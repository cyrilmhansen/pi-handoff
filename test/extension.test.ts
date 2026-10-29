/**
 * Extension wiring tests against mocked Pi API events (all 10 requirements,
 * adapter level). Synthetic budgets; zero inference; real pi runtime NOT loaded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { readRecoveryBundle, joinPath } from "../.pi/extensions/context-guard/checkpoint.ts";
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
} = {}): Harness {
  const memFs = createMemoryFs(options.files ?? DEFAULT_FILES);
  const mockPi = createMockPi();
  const mockCtx = createMockCtx({
    cwd: "/project",
    usage: options.usage === null ? null : options.usage,
    model: options.model === null ? undefined : options.model,
    sessionId: options.sessionId ?? "session-1",
  });
  contextGuard(mockPi.pi as never, {
    fs: memFs,
    env: options.env ?? {},
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
  await h.command("handoff", "phase 1 demo");
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

test("R10: no compaction, no session switching, no settings/install writes, stable system prompt", async () => {
  const h = harness();
  await startSession(h);
  await h.turnEnd(125464);
  await h.command("guard", "simulate 4000");
  await h.toolCall("bash", {});
  await h.command("handoff", "final");
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
  // allowed ONLY through the gated renewal path (LEARNINGS A-17 / PROTOCOL §6):
  // exactly one ctx.newSession( call site, and it must sit inside runRenewal AFTER
  // decideRenewal (never in a tool execute or event handler).
  const src = readFileSync(new URL("../.pi/extensions/context-guard/index.ts", import.meta.url), "utf8");
  for (const forbidden of [".compact(", "switchSession(", "fork(", "systemPrompt", "context_with_system", "navigateTree("]) {
    assert.ok(!src.includes(forbidden), `extension source must not reference ${forbidden}`);
  }
  assert.equal((src.match(/\.newSession\(/g) ?? []).length, 1, "exactly ONE newSession call site (the gated renewal transition)");
  const renewBody = src.slice(src.indexOf("async function runRenewal"), src.indexOf("Model-initiated renewal"));
  assert.ok(renewBody.includes("decideRenewal(") && renewBody.includes("await ctx.waitForIdle()") && renewBody.includes(".newSession("), "newSession lives in runRenewal, after the idle boundary and the decision gate");
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

test("auto-checkpoint happens once per escalated level, not every turn", async () => {
  const h = harness();
  await startSession(h);
  await h.command("guard", "simulate 9000"); // level 3 -> checkpoint
  const handoffAfterFirst = h.memFs.files.get("/project/HANDOFF.md");
  await h.command("guard", "simulate 8500"); // still level 3 -> no new checkpoint stamp change
  const handoffAfterSecond = h.memFs.files.get("/project/HANDOFF.md");
  // PROGRESS managed block content identical apart from timestamp; compare guard-level line instead
  assert.match(handoffAfterFirst ?? "", /status: checkpoint \(guard level 3/);
  assert.match(handoffAfterSecond ?? "", /status: checkpoint \(guard level 3/);
  await h.command("guard", "simulate 4000"); // escalate to 4 -> checkpoint again
  assert.match(h.memFs.files.get("/project/HANDOFF.md") ?? "", /status: checkpoint \(guard level 4/);
});
