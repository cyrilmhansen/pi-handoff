/**
 * context-guard — Pi 1.4.0 extension (Phase 1)
 *
 * Monitors remaining context against configurable thresholds, delivers
 * one-shot threshold alerts, enforces a closing phase at the critical level,
 * and maintains durable handoff files (PROGRESS.md / HANDOFF.md checkpoints).
 *
 * Deliberately does NOT: compact, change the system prompt, transform messages
 * already in context, or switch sessions. Session renewal is Phase 2.
 *
 * Runtime imports are node built-ins and local pure modules only; the pi
 * package is imported type-only so this module can be unit-tested standalone.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
  computeBudget,
  defaultThresholds,
  syntheticBudget,
  ContextPressureMachine,
  type GuardLevel,
  type BudgetBreakdown,
  type Transition,
} from "./core.ts";
import { DEFAULT_CONFIG, loadConfig, type GuardConfig } from "./config.ts";
import {
  attestHandoff,
  createLocalFs,
  evaluateHandoffReadiness,
  isInsideTree,
  isLexicallyInside,
  joinPath,
  loadGuardState,
  normalizePath,
  pruneSessionStates,
  readRecoveryBundle,
  renewAuthorization,
  saveGuardState,
  sha256,
  stripManagedSection,
  validateAll,
  validateCheckpoint,
  writeCheckpoint,
  DEFAULT_CONFIG_NAME,
  type CheckpointFreshness,
  type CheckpointResult,
  type FsOps,
  type PersistedGuardState,
  type ReadinessInfo,
} from "./checkpoint.ts";

export const CUSTOM_TYPE = "context-guard";

interface GuardInternals {
  config: GuardConfig;
  machine: ContextPressureMachine;
  cwd: string;
  sessionId: string;
  goalHash: string | undefined;
  goalDrift: boolean;
  lastCheckpointLevel: GuardLevel;
  checkpointOk: boolean | undefined;
  stateCorrupted: boolean;
  checkpoint: CheckpointFreshness;
  /** sha256 of LEARNINGS.md at session start (readiness warning baseline). */
  learningsHash: string | undefined;
  checkpointId: string | null;
  handoffReady: ReadinessInfo | undefined;
  /** Repairs suppressed by read-only audit mode (reported, never performed). */
  repairsSuppressed: string[];
}

export interface GuardOverrides {
  config?: Partial<GuardConfig>;
  fs?: FsOps;
  env?: Record<string, string | undefined>;
}

export default function contextGuard(pi: ExtensionAPI, overrides: GuardOverrides = {}) {
  let g: GuardInternals | undefined;
  const env = overrides.env ?? process.env;
  const fs = overrides.fs ?? createLocalFs();

  function readConfig(cwd: string): GuardConfig {
    const base = loadConfig((name) => fs.readFile(joinPath(cwd, name)), env);
    const merged: GuardConfig = { ...base, ...(overrides.config ?? {}) };
    merged.thresholds = { ...base.thresholds, ...(overrides.config?.thresholds ?? {}) };
    merged.files = { ...base.files, ...(overrides.config?.files ?? {}) };
    const flag = safeGetFlag("guard-synthetic");
    if (flag != null) {
      const n = Number(flag);
      if (Number.isFinite(n)) merged.syntheticRemaining = Math.floor(n);
    }
    const ro = safeGetFlag("guard-readonly");
    if (ro != null && ro !== "0") merged.readOnly = true;
    return merged;
  }

  /** Resolve the state directory (config/env may point it outside the project). */
  function resolvedStateDir(internals: GuardInternals): string {
    return joinPath(internals.cwd, internals.config.stateDir);
  }

  /** Read-only audit mode forbids every write inside the project tree. */
  function canWriteProjectTree(): boolean {
    return g ? !g.config.readOnly : false;
  }

  /** Runtime state may persist in read-only mode ONLY outside the audited tree. */
  function canPersistState(): boolean {
    if (!g) return false;
    if (!g.config.readOnly) return true;
    // containment is realpath-aware AND normalized: `..` tricks and a symlinked
    // state dir inside the tree are still part of the audited tree.
    return !isInsideTree(fs, resolvedStateDir(g), g.cwd);
  }

  function safeGetFlag(name: string): string | undefined {
    try {
      const v = pi.getFlag(name);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  function buildMachine(config: GuardConfig): ContextPressureMachine {
    return new ContextPressureMachine(defaultThresholds(config.thresholds), config.maxConsecutiveUnknown);
  }

  function measure(ctx: ExtensionContext): BudgetBreakdown {
    const config = g?.config ?? DEFAULT_CONFIG;
    const usage = ctx.getContextUsage?.();
    if (config.syntheticRemaining != null) {
      return syntheticBudget(config.syntheticRemaining, usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
    }
    return computeBudget({
      modelId: (ctx.model as { id?: string } | undefined)?.id ?? null,
      contextWindow: usage?.contextWindow ?? null,
      modelContextWindow: ctx.model?.contextWindow ?? null,
      modelMaxOutputTokens: ctx.model?.maxTokens ?? null,
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
      generationReserve: config.generationReserve,
      safetyReserve: config.safetyReserve,
    });
  }

  const RESERVE_LABEL: Record<string, string> = {
    "model-maxTokens": "model maxTokens (generationReserve: \"model\")",
    generationReserve: "config generationReserve (fixed)",
    safetyReserve: "config safetyReserve (floor above the requested reserve)",
    none: "none (no reserve subtracted)",
  };

  function notify(ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" | "error"): void {
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, level);
    } catch {
      /* UI unavailable (print/json mode) */
    }
  }

  /**
   * Full budget accounting for `/guard status`: every number the guard used, where it
   * came from, and what is inconsistent. Pi 1.4.0 provides an ESTIMATE (last usage +
   * chars/4), so this is an advisory budget, never exact accounting.
   */
  function statusReport(ctx: ExtensionContext): string {
    if (!g) return "context-guard: not initialized";
    const m = measure(ctx);
    const s = g.machine.snapshot();
    const next = g.machine.nextThreshold(m.remaining);
    const nextText =
      next.nextCrossing == null
        ? "none (no threshold below the current remaining budget)"
        : `level ${next.nextCrossing.level} "${next.nextCrossing.label}" in ${next.nextCrossing.tokensUntil} tokens` +
          (next.nextAlert
            ? `; next alert in this session: level ${next.nextAlert.level} "${next.nextAlert.label}" in ${next.nextAlert.tokensUntil} tokens`
            : "; every lower threshold has already alerted in this session");
    const readiness = g.checkpoint.kind === "current" || g.checkpoint.kind === "stale" ? g.checkpoint.readiness : undefined;
    const auth = renewAuthorization(g.checkpoint);
    const lines = [
      `context-guard status (session ${g.sessionId})`,
      `  mode: ${g.config.readOnly ? "READ-ONLY audit mode (no writes inside the project tree)" : canPersistState() ? "normal (runtime state persists)" : "normal (runtime state persistence disabled)"}${g.config.enabled ? "" : " — guard DISABLED"}`,
      `  model: ${m.modelId ?? "unknown"}`,
      `  context window: ${m.contextWindow ?? "unknown"} (source: ${m.contextWindowSource}${m.modelContextWindow != null && m.modelContextWindow !== m.contextWindow ? `, ctx.model declares ${m.modelContextWindow}` : ""})`,
      `  estimated used: ${m.tokensUsed ?? "unknown"} tokens (Pi estimate: last reported usage + chars/4 heuristic, not exact)`,
      `  raw remaining: ${m.rawRemaining == null ? "unknown" : Math.floor(m.rawRemaining)} (window - used, no reserve subtracted)`,
      `  generation reserve: ${m.reserve.selected}${m.reserveFraction == null ? "" : ` = ${(m.reserveFraction * 100).toFixed(1)}% of the window`} (source: ${RESERVE_LABEL[m.reserve.source] ?? m.reserve.source}; safetyReserve ${m.reserve.safetyReserve})`,
      `  usable remaining: ${m.usableRemaining == null ? "unknown" : Math.floor(m.usableRemaining)} = window - used - reserve`,
      `  guard level: ${s.currentLevel}${s.currentLevel >= 4 && g.config.enforceClosing ? ` (ENFORCED closing: only ${g.config.closingAllowlist.join(", ")} run)` : ""}; alerts spent [${s.alertedLevels.join(", ")}]; evaluations ${s.evaluations}${s.degraded ? "; DEGRADED (measurements unavailable)" : ""}`,
      `  next threshold: ${nextText}`,
      `  measurement: ${m.status}${m.reason ? ` (${m.reason})` : ""}`,
      `  provenance: ${m.provenance ?? "unknown"}`,
      `  checkpoint: ${g.checkpoint.kind}${g.checkpointId ? ` ${g.checkpointId}` : ""}${readiness ? `; readiness ${readiness.state}` : ""}; checkpointOk ${g.checkpointOk ?? "n/a"}${"changed" in g.checkpoint && g.checkpoint.changed.length > 0 ? `; changed sources: ${g.checkpoint.changed.join(", ")}` : ""}`,
      `  renewal authorization (Phase 2, not implemented): ${auth.authorized ? "would be authorized" : "NOT authorized"} — ${auth.reason}`,
    ];
    if (g.repairsSuppressed.length > 0) {
      lines.push(`  audit mode: ${g.repairsSuppressed.length} state repair(s) suppressed (no quarantine/migration/cleanup writes): ${g.repairsSuppressed.join("; ")}`);
    }
    if (m.inconsistencies && m.inconsistencies.length > 0) {
      lines.push(`  inconsistencies (${m.inconsistencies.length}):`);
      for (const i of m.inconsistencies) lines.push(`    - ${i}`);
    }
    if (g.goalDrift) lines.push("  WARNING: GOAL.md changed since session start (goal drift).");
    return lines.join("\n");
  }

  function statusText(ctx: ExtensionContext | undefined): string | undefined {
    if (!g || ctx?.mode !== "tui") return undefined;
    const m = measure(ctx);
    return m.remaining == null
      ? `guard L${g.machine.currentLevel} ctx ?`
      : `guard L${g.machine.currentLevel} ctx ${Math.floor(m.remaining / 1000)}k left`;
  }

  function setStatus(ctx: ExtensionContext | undefined): void {
    try {
      if (ctx?.mode === "tui") ctx.ui.setStatus(CUSTOM_TYPE, statusText(ctx));
    } catch {
      /* non-interactive */
    }
  }

  function persistState(): void {
    if (!g || !canPersistState()) return;
    const state: PersistedGuardState = {
      version: 2,
      sessionId: g.sessionId,
      updatedAt: Date.now(),
      snapshot: g.machine.snapshot(),
      goalHash: g.goalHash,
      checkpointOk: g.checkpointOk,
      checkpointFreshness: g.checkpoint.kind,
      checkpointId: g.checkpointId ?? undefined,
      handoffReady: g.handoffReady?.state ?? "none",
      learningsHash: g.learningsHash,
      notes: g.stateCorrupted ? "recovered from corrupt state file" : undefined,
    };
    const result = saveGuardState(fs, resolvedStateDir(g), state);
    if (!result.ok) g.checkpointOk = false; // failure recorded, guard keeps running
  }

  function goalPath(): string | undefined {
    if (!g) return undefined;
    return joinPath(g.cwd, g.config.files.goal);
  }

  function checkGoalDrift(ctx: ExtensionContext): void {
    if (!g || !g.config.protectGoal || g.goalHash === undefined) return;
    const current = fs.readFile(goalPath()!);
    const currentHash = current === undefined ? undefined : sha256(current);
    if (currentHash !== g.goalHash && !g.goalDrift) {
      g.goalDrift = true;
      notify(ctx, "context-guard: GOAL.md changed since session start (goal drift). The guard will not rewrite GOAL.md; review the change.", "warning");
    }
  }

  /** True when `target` addresses the protected GOAL file (normalized + symlink-aware). */
  function isGoalTarget(target: string): boolean {
    if (!g) return false;
    const goal = joinPath(g.cwd, g.config.files.goal);
    const cand = normalizePath(target.startsWith("/") ? target : joinPath(g.cwd, target));
    const goalReal = fs.realpath?.(goal) ?? normalizePath(goal);
    const candReal = fs.realpath?.(cand) ?? cand;
    return cand === normalizePath(goal) || candReal === goalReal || isLexicallyInside(candReal, goalReal);
  }

  function checkpoint(ctx: ExtensionContext, reason: string, notes?: string, opts: { dryRun?: boolean; kind?: "auto" | "manual" } = {}): CheckpointResult | undefined {
    if (!g) return undefined;
    const m = measure(ctx);
    const bundle = readRecoveryBundle(fs, g.cwd, g.config.files, { configName: DEFAULT_CONFIG_NAME });
    const progress = fs.readFile(joinPath(g.cwd, g.config.files.progress)) ?? "";
    // Unfinished items are read from the MANUAL prose only — the managed block
    // echoes an older copy of itself, which would fossilize across refreshes.
    const progressProse = stripManagedSection(progress);
    const nextAction = bundle.nextAction ?? "(unknown — record the exact next action in PROGRESS.md)";
    const unfinished = (progressProse.match(/^- \[[ x]\] .*/gm) ?? []).slice(0, 12).map((line) => line.slice(2));
    const result = writeCheckpoint(
      fs,
      {
        cwd: g.cwd,
        files: g.config.files,
        level: g.machine.currentLevel,
        sessionId: g.sessionId,
        remaining: m.remaining,
        goalHash: g.goalHash,
        goalDrift: g.goalDrift,
        lastVerifiedState: `guard level ${g.machine.currentLevel}; checkpoint requested (${reason})`,
        unfinishedOperations: unfinished,
        nextAction,
        recoveryInstructions: [],
        notes,
        kind: opts.kind ?? "manual",
        configName: DEFAULT_CONFIG_NAME,
      },
      opts,
    );
    if (!result.dryRun) {
      g.checkpointOk = result.ok;
      g.checkpoint = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      g.checkpointId = result.identity.id;
      g.handoffReady = "readiness" in g.checkpoint ? g.checkpoint.readiness : result.readiness;
      persistState();
      if (!result.ok) {
        notify(ctx, `context-guard: checkpoint failed: ${result.errors.join("; ")}`, "error");
      }
    }
    return result;
  }

  /** Evaluate pressure, alert once per crossing, checkpoint at level >= 3. */
  function evaluate(ctx: ExtensionContext, boundary: "turn_end" | "command" | "settled"): Transition | undefined {
    if (!g || !g.config.enabled) return undefined;
    const transition = g.machine.evaluate(measure(ctx));
    const alertText = g.machine.formatAlert(transition);
    if (alertText) {
      // triggerTurn:false while Pi is streaming => Pi defers the append to the
      // end of the current turn: an in-flight tool call is never interrupted.
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: alertText,
          display: true,
          details: { level: transition.level, crossed: transition.crossed.map((t) => t.label), boundary },
        },
        { triggerTurn: false },
      );
      try {
        pi.appendEntry(CUSTOM_TYPE, { alertLevels: transition.crossed.map((t) => t.level), remaining: transition.measurement.remaining, boundary });
      } catch {
        /* audit entry is best-effort */
      }
      notify(ctx, `context-guard: level ${transition.level} (${transition.crossed.map((t) => t.label).join(", ")})`, transition.level >= 4 ? "error" : "warning");
    }
    if (transition.degraded && transition.crossed.length === 0) {
      notify(ctx, "context-guard: context measurement unavailable for several evaluations; holding last known pressure level.", "warning");
    }
    checkGoalDrift(ctx);
    if (g.config.autoCheckpointAtHandoffLevel && transition.level >= 3 && g.lastCheckpointLevel < transition.level) {
      g.lastCheckpointLevel = transition.level;
      if (canWriteProjectTree()) {
        checkpoint(ctx, `auto at level ${transition.level}`, undefined, { kind: "auto" });
      } else {
        notify(ctx, "context-guard: read-only audit mode — automatic checkpoint suppressed (no writes to the project tree).", "info");
      }
    }
    persistState();
    setStatus(ctx);
    return transition;
  }

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    // Rebuild all session-bound state; never reuse values from a previous session.
    const cwd = ctx.cwd;
    const config = readConfig(cwd);
    let sessionId = "anon";
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      /* read-only mocks */
    }
    const machine = buildMachine(config);
    g = {
      config,
      machine,
      cwd,
      sessionId,
      goalHash: undefined,
      goalDrift: false,
      lastCheckpointLevel: 0,
      checkpointOk: undefined,
      stateCorrupted: false,
      checkpoint: { kind: "missing", detail: "not yet checked" },
      learningsHash: undefined,
      checkpointId: null,
      handoffReady: undefined,
      repairsSuppressed: [],
    };
    const goalText = fs.readFile(joinPath(cwd, config.files.goal));
    g.goalHash = goalText === undefined ? undefined : sha256(goalText);
    const learningsText = fs.readFile(joinPath(cwd, config.files.learnings));
    g.learningsHash = learningsText === undefined ? undefined : sha256(learningsText);

    // Durable checkpoint freshness — read-only check, never auto-fixed.
    g.checkpoint = validateCheckpoint(fs, cwd, config.files, DEFAULT_CONFIG_NAME);
    if (g.checkpoint.kind !== "current") {
      const guidance =
        g.checkpoint.kind === "missing"
          ? "Run /handoff to create one."
          : "Prefer the manual sections of HANDOFF.md/PROGRESS.md (they are newer); run /handoff to refresh the managed block. The guard never overwrites manual text.";
      notify(
        ctx,
        `context-guard: HANDOFF checkpoint ${g.checkpoint.kind}${"detail" in g.checkpoint ? ` (${g.checkpoint.detail})` : ""}. ${guidance}`,
        g.checkpoint.kind === "missing" ? "info" : "warning",
      );
    }

    // Per-session runtime state. In audit mode this is INSPECTION ONLY: the guard
    // reads and classifies but performs no quarantine/migration/cleanup writes
    // inside the audited tree (Phase 1c, LEARNINGS A-10).
    const readOnlyState = !canPersistState();
    const loaded = loadGuardState(fs, resolvedStateDir(g), sessionId, { readOnly: readOnlyState });
    if (readOnlyState && (loaded.repairsSuppressed?.length ?? 0) > 0) {
      g.repairsSuppressed = loaded.repairsSuppressed ?? [];
      notify(
        ctx,
        `context-guard: read-only audit mode — ${g.repairsSuppressed.length} state repair(s) suppressed (no quarantine/migration/cleanup writes): ${g.repairsSuppressed.join("; ")}`,
        "info",
      );
    }
    if (loaded.kind === "found" && loaded.state.sessionId === sessionId) {
      g.machine = ContextPressureMachine.restore(loaded.state.snapshot, defaultThresholds(config.thresholds), config.maxConsecutiveUnknown);
      g.lastCheckpointLevel = g.machine.currentLevel;
      if (typeof loaded.state.goalHash === "string") g.goalHash = loaded.state.goalHash;
      if (typeof loaded.state.learningsHash === "string") g.learningsHash = loaded.state.learningsHash;
      g.checkpointOk = loaded.state.checkpointOk;
      g.checkpointId = loaded.state.checkpointId ?? g.checkpointId;
      if (loaded.migrated === "self") {
        notify(ctx, `context-guard: migrated legacy state.json to per-session state for ${sessionId}.`, "info");
      }
    } else if (loaded.kind === "corrupt") {
      g.stateCorrupted = true; // fresh machine: safe default, alerts re-armed once
      notify(ctx, `context-guard: per-session state was corrupt (${loaded.detail})${loaded.backupPath ? `, quarantined to ${loaded.backupPath}` : "; started with a fresh machine"}.`, "warning");
    } else if (loaded.kind === "missing" && loaded.foreignMigrated) {
      notify(ctx, `context-guard: legacy state.json belonged to session ${loaded.foreignMigrated}; preserved at its own per-session file.`, "info");
    } else if (loaded.kind === "corrupt") {
      g.stateCorrupted = true; // fresh machine: safe default, alerts re-armed once
    }
    if (canPersistState()) {
      const pruned = pruneSessionStates(fs, resolvedStateDir(g), config.maxSessionStates, sessionId);
      if (pruned.length > 0) notify(ctx, `context-guard: pruned ${pruned.length} old session state file(s).`, "info");
    }
    persistState();
    setStatus(ctx);
  });

  pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
    evaluate(ctx, "turn_end");
    return undefined;
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (g && g.config.enabled) evaluate(ctx, "settled");
    else persistState();
  });

  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext) => {
    if (!g || !g.config.enabled) return undefined;
    // Enforced closing phase: gate NEW tool calls before execution.
    // This never interrupts an in-flight call (turn boundary already passed).
    if (g.machine.currentLevel >= 4 && g.config.enforceClosing) {
      if (!g.config.closingAllowlist.includes(event.toolName)) {
        return {
          block: true,
          reason:
            "context-guard enforced closing phase: tools outside the checkpoint allowlist " +
            `(${g.config.closingAllowlist.join(", ")}) are blocked. Finish HANDOFF.md and PROGRESS.md, then stop; a fresh session resumes from those files.`,
        };
      }
    }
    // Goal protection: GOAL.md must not be silently rewritten by the agent.
    if (g.config.protectGoal && (event.toolName === "write" || event.toolName === "edit")) {
      const input = event.input as { path?: string; file_path?: string } | undefined;
      const target = input?.path ?? input?.file_path;
      if (target && isGoalTarget(target)) {
        return {
          block: true,
          reason:
            "context-guard: GOAL.md is protected. Record proposed goal changes in LEARNINGS.md (Proposed) and HANDOFF.md for human review instead of rewriting it.",
        };
      }
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    persistState();
    g = undefined;
  });

  pi.registerFlag("guard-synthetic", {
    description: "context-guard synthetic mode: fixed remaining tokens, e.g. --guard-synthetic 4500",
    type: "string",
  });

  pi.registerFlag("guard-readonly", {
    description: "context-guard read-only audit mode: no writes to the project tree (state optional via CONTEXT_GUARD_STATE_DIR)",
    type: "string",
  });

  pi.registerCommand("guard", {
    description: "Context guard status/simulation: /guard status | simulate <tokens> | reset | verify-checkpoint",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!g) {
        ctx.ui.notify("context-guard: not initialized (no active session)", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      if (sub === "status") {
        ctx.ui.notify(statusReport(ctx), "info");
        return;
      }
      if (sub === "simulate") {
        const n = Number(parts[1]);
        if (!Number.isFinite(n)) {
          ctx.ui.notify("usage: /guard simulate <remainingTokens>", "error");
          return;
        }
        g.config = { ...g.config, syntheticRemaining: Math.floor(n) };
        const transition = evaluate(ctx, "command");
        ctx.ui.notify(
          `simulated remaining ${Math.floor(n)} -> level ${transition?.level ?? "?"}${transition && transition.crossed.length > 0 ? `; fired ${transition.crossed.length} alert(s)` : "; no new alerts"}`,
          "info",
        );
        return;
      }
      if (sub === "reset") {
        g.machine = buildMachine(g.config);
        g.lastCheckpointLevel = 0;
        g.goalDrift = false;
        const goalText = fs.readFile(joinPath(g.cwd, g.config.files.goal));
        g.goalHash = goalText === undefined ? undefined : sha256(goalText);
        persistState();
        ctx.ui.notify("context-guard state reset (alerts re-armed, goal hash re-baselined, level 0)", "info");
        return;
      }
      if (sub === "verify-checkpoint") {
        ctx.ui.notify(verifyReport(), g.checkpoint.kind === "current" ? "info" : "warning");
        return;
      }
      ctx.ui.notify("usage: /guard status | /guard simulate <remainingTokens> | /guard reset | /guard verify-checkpoint", "info");
    },
  });

  /**
   * Technical validity + freshness + identity + semantic readiness, reported SEPARATELY.
   * The Phase 2 renewal gate is `renewAuthorization()`: current AND identity-consistent
   * AND attested — a merely fresh-but-empty checkpoint never authorizes renewal.
   */
  function verifyReport(): string {
    if (!g) return "context-guard: not initialized";
    g.checkpoint = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    const f = g.checkpoint;
    g.checkpointId = f.kind === "current" || f.kind === "stale" ? f.identity?.id ?? null : null;
    g.handoffReady = "readiness" in f ? f.readiness : undefined;
    const readiness = "readiness" in f ? f.readiness : undefined;
    const auth = renewAuthorization(f);
    const lines = [
      `context-guard verify: checkpoint ${f.kind}${"detail" in f ? `: ${f.detail}` : ""}` +
        ("checkpointed" in f && f.checkpointed ? ` (written ${f.checkpointed}${f.session ? `, session ${f.session}` : ""})` : ""),
      `  identity: ${g.checkpointId ?? "none"}${f.kind === "current" ? `; content-delta ${f.contentDelta}` : ""}`,
      `  readiness: ${readiness ? `${readiness.state} — ${readiness.detail}` : "unknown (checkpoint is not current)"}`,
      `  renewal authorization (Phase 2, not implemented): ${auth.authorized ? "would be authorized" : "NOT authorized"} — ${auth.reason}`,
      "  manual prose in HANDOFF.md/PROGRESS.md always takes precedence over these blocks.",
    ];
    persistState();
    return lines.join("\n");
  }

  /** `/handoff ready [check]`: evaluate semantic readiness; bare `ready` also attests. */
  function readyReport(attest: boolean, dry: boolean): { text: string; ok: boolean } {
    if (!g) return { text: "context-guard: not initialized", ok: false };
    const ev = evaluateHandoffReadiness(fs, g.cwd, g.config.files, {
      configName: DEFAULT_CONFIG_NAME,
      learningsHashAtSessionStart: g.learningsHash,
    });
    const lines = [`context-guard handoff readiness: ${ev.ok ? "READY" : "NOT READY"}${ev.identity ? ` (checkpoint ${ev.identity.id})` : ""}`];
    for (const c of ev.checks) lines.push(`  [${c.status.toUpperCase()}] ${c.id}: ${c.detail}`);
    if (!attest) {
      lines.push("  (evaluation only; run /handoff ready to attest the current checkpoint generation)");
      return { text: lines.join("\n"), ok: ev.ok };
    }
    const att = attestHandoff(fs, g.cwd, g.config.files, {
      sessionId: g.sessionId,
      dryRun: dry,
      configName: DEFAULT_CONFIG_NAME,
      learningsHashAtSessionStart: g.learningsHash,
    });
    if (att.ok) {
      lines.push(
        att.dryRun
          ? "  read-only audit mode: attestation NOT written (dry run)"
          : `  attested ${att.checkpointId} (wrote ${att.written.join(", ")})`,
      );
    } else {
      for (const e of att.errors) lines.push(`  ATTESTATION REFUSED: ${e}`);
    }
    g.checkpoint = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    g.checkpointId = att.checkpointId ?? g.checkpointId;
    if ("readiness" in g.checkpoint) g.handoffReady = att.readiness ?? g.checkpoint.readiness;
    const auth = renewAuthorization(g.checkpoint);
    lines.push(`  renewal authorization (Phase 2, not implemented): ${auth.authorized ? "would be authorized" : "NOT authorized"} — ${auth.reason}`);
    persistState();
    return { text: lines.join("\n"), ok: att.ok };
  }

  pi.registerCommand("handoff", {
    description: "Durable checkpoint (HANDOFF.md + PROGRESS.md managed blocks; no session switch). Subcommands: verify, ready [check]",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!g) {
        ctx.ui.notify("context-guard: not initialized", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "verify") {
        ctx.ui.notify(verifyReport(), g.checkpoint.kind === "current" ? "info" : "warning");
        return;
      }
      if (parts[0] === "ready") {
        const res = readyReport(parts[1] !== "check", !canWriteProjectTree());
        ctx.ui.notify(res.text, res.ok ? "info" : "warning");
        return;
      }
      const notes = args.trim();
      const dry = !canWriteProjectTree();
      const result = checkpoint(ctx, dry ? `read-only audit (${notes || "manual /handoff"})` : notes || "manual /handoff", notes || undefined, { dryRun: dry });
      if (!result) return;
      const missing = validateAll(fs, g.cwd, g.config.files).filter((v) => !v.ok).map((v) => v.file);
      const bundle = readRecoveryBundle(fs, g.cwd, g.config.files, { configName: DEFAULT_CONFIG_NAME });
      const text =
        (result.dryRun
          ? `read-only audit mode: NOT written (dry run; would update [${(result.planned ?? []).join(", ")}])`
          : `checkpoint ${result.ok ? "OK" : "FAILED"} ${result.identity.id} (generation ${result.identity.generation}, content-delta ${result.contentDelta}); wrote [${result.written.join(", ")}]`) +
        `; freshness ${bundle.checkpoint.kind}` +
        (bundle.checkpoint.kind === "current" && bundle.checkpoint.readiness.state === "unattested"
          ? "; readiness unattested (run /handoff ready once the handoff is complete)"
          : "") +
        (bundle.nextActionSource === "stale-checkpoint" ? "; next action taken from STALE checkpoint (prefer manual prose!)" : "") +
        (missing.length > 0 ? `; missing required sections in: ${missing.join(", ")}` : "") +
        (bundle.nextAction ? `; next action: ${bundle.nextAction.split("\n")[0].slice(0, 120)}` : "") +
        (result.errors.length > 0 ? `; errors: ${result.errors.join("; ")}` : "");
      ctx.ui.notify(`context-guard /handoff: ${text}`, !result.ok ? "error" : result.dryRun ? "warning" : "info");
      // Phase 2 (NOT implemented in this build): fresh-session renewal.
    },
  });
}

// Exported for the test harness; pi ignores these.
// `computeMeasurement` is not used inside this module (the adapter measures through
// `computeBudget`), so it is re-exported FROM the source module rather than through an
// unused local binding — a re-export of a non-imported name is a hard module-level error
// ("Export 'computeMeasurement' is not defined") that breaks extension loading in both
// Node's type-stripping loader and pi's jiti loader.
export { ContextPressureMachine, defaultThresholds };
export { computeMeasurement } from "./core.ts";
export type { GuardConfig, GuardInternals };
