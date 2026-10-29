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
  computeMeasurement,
  defaultThresholds,
  syntheticMeasurement,
  ContextPressureMachine,
  type GuardLevel,
  type Measurement,
  type Transition,
} from "./core.ts";
import { DEFAULT_CONFIG, loadConfig, type GuardConfig } from "./config.ts";
import {
  createLocalFs,
  joinPath,
  loadGuardState,
  pruneSessionStates,
  readRecoveryBundle,
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

  function isUnder(child: string, parent: string): boolean {
    const c = child.replace(/\/+$/, "");
    const p = parent.replace(/\/+$/, "");
    return c === p || c.startsWith(p + "/");
  }

  /** Read-only audit mode forbids every write inside the project tree. */
  function canWriteProjectTree(): boolean {
    return g ? !g.config.readOnly : false;
  }

  /** Runtime state may persist in read-only mode ONLY outside the audited tree. */
  function canPersistState(): boolean {
    if (!g) return false;
    if (!g.config.readOnly) return true;
    return !isUnder(resolvedStateDir(g), g.cwd);
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

  function measure(ctx: ExtensionContext): Measurement {
    const config = g?.config ?? DEFAULT_CONFIG;
    if (config.syntheticRemaining != null) {
      return syntheticMeasurement(config.syntheticRemaining, ctx.getContextUsage?.()?.contextWindow ?? 0);
    }
    const usage = ctx.getContextUsage?.();
    if (!usage) {
      return { status: "unknown", remaining: null, tokensUsed: null, contextWindow: null, reservedForGeneration: 0, reason: "no-model" };
    }
    const reserve = config.generationReserve === "model" ? (ctx.model?.maxTokens ?? 0) : config.generationReserve;
    return computeMeasurement({
      contextWindow: usage.contextWindow,
      tokens: usage.tokens,
      maxOutputTokens: reserve,
      safetyReserve: config.safetyReserve,
    });
  }

  function notify(ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" | "error"): void {
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, level);
    } catch {
      /* UI unavailable (print/json mode) */
    }
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

  function checkpoint(ctx: ExtensionContext, reason: string, notes?: string, opts: { dryRun?: boolean } = {}): CheckpointResult | undefined {
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
        configName: DEFAULT_CONFIG_NAME,
      },
      opts,
    );
    if (!result.dryRun) {
      g.checkpointOk = result.ok;
      g.checkpoint = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
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
        checkpoint(ctx, `auto at level ${transition.level}`);
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
    };
    const goalText = fs.readFile(joinPath(cwd, config.files.goal));
    g.goalHash = goalText === undefined ? undefined : sha256(goalText);

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

    // Per-session runtime state (isolated by session id; v1 state.json is migrated).
    const loaded = loadGuardState(fs, joinPath(cwd, config.stateDir), sessionId);
    if (loaded.kind === "found" && loaded.state.sessionId === sessionId) {
      g.machine = ContextPressureMachine.restore(loaded.state.snapshot, defaultThresholds(config.thresholds), config.maxConsecutiveUnknown);
      g.lastCheckpointLevel = g.machine.currentLevel;
      if (typeof loaded.state.goalHash === "string") g.goalHash = loaded.state.goalHash;
      g.checkpointOk = loaded.state.checkpointOk;
      if (loaded.migrated === "self") {
        notify(ctx, `context-guard: migrated legacy state.json to per-session state for ${sessionId}.`, "info");
      }
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
      const goal = goalPath();
      if (target && goal && resolveComparable(target) === goal) {
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
        const m = measure(ctx);
        const s = g.machine.snapshot();
        ctx.ui.notify(
          `guard level ${s.currentLevel}; remaining ${m.remaining ?? "unknown"} (${m.status}${m.reason ? `, ${m.reason}` : ""}); alerted [${s.alertedLevels.join(",")}]; checkpointOk ${g.checkpointOk ?? "n/a"}; checkpoint ${g.checkpoint.kind}${"changed" in g.checkpoint && g.checkpoint.changed.length > 0 ? ` (${g.checkpoint.changed.join(", ")})` : ""}; session ${g.sessionId}${g.config.readOnly ? "; READ-ONLY audit mode" : ""}`,
          "info",
        );
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
        g.checkpoint = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
        const f = g.checkpoint;
        ctx.ui.notify(
          `context-guard: checkpoint ${f.kind}${"detail" in f ? `: ${f.detail}` : ""}${"checkpointed" in f && f.checkpointed ? ` (written ${f.checkpointed}${f.session ? `, session ${f.session}` : ""})` : ""}`,
          f.kind === "current" ? "info" : "warning",
        );
        return;
      }
      ctx.ui.notify("usage: /guard status | /guard simulate <remainingTokens> | /guard reset | /guard verify-checkpoint", "info");
    },
  });

  pi.registerCommand("handoff", {
    description: "Durable checkpoint (HANDOFF.md + PROGRESS.md managed blocks; no session switch). Subcommand: verify",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!g) {
        ctx.ui.notify("context-guard: not initialized", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "verify") {
        const f = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
        ctx.ui.notify(
          `context-guard /handoff verify: checkpoint ${f.kind}${"detail" in f ? `: ${f.detail}` : ""}${"checkpointed" in f && f.checkpointed ? ` (written ${f.checkpointed}${f.session ? `, session ${f.session}` : ""})` : ""}`,
          f.kind === "current" ? "info" : "warning",
        );
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
          : `checkpoint ${result.ok ? "OK" : "FAILED"}; wrote [${result.written.join(", ")}]`) +
        `; freshness ${bundle.checkpoint.kind}` +
        (bundle.nextActionSource === "stale-checkpoint" ? "; next action taken from STALE checkpoint (prefer manual prose!)" : "") +
        (missing.length > 0 ? `; missing required sections in: ${missing.join(", ")}` : "") +
        (bundle.nextAction ? `; next action: ${bundle.nextAction.split("\n")[0].slice(0, 120)}` : "") +
        (result.errors.length > 0 ? `; errors: ${result.errors.join("; ")}` : "");
      ctx.ui.notify(`context-guard /handoff: ${text}`, !result.ok ? "error" : result.dryRun ? "warning" : "info");
      // Phase 2 (NOT implemented in this build): fresh-session renewal.
    },
  });

  function resolveComparable(target: string): string {
    if (target.startsWith("/")) return target;
    const cwd = g?.cwd ?? process.cwd();
    return joinPath(cwd, target);
  }
}

// Exported for the test harness; pi ignores these.
export { ContextPressureMachine, computeMeasurement, defaultThresholds };
export type { GuardConfig, GuardInternals };
