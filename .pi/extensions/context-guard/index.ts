/**
 * context-guard — Pi 1.4.0 extension (guard + durable handoff + renewal + finalization + diagnostics)
 *
 * Monitors remaining context against configurable thresholds, delivers
 * one-shot threshold alerts, enforces a closing phase at the critical level,
 * maintains durable handoff files (PROGRESS.md / HANDOFF.md checkpoints), and —
 * ONLY when explicitly enabled and authorized — performs bounded session renewal:
 * `/handoff renew` (operator) and the `handoff_renew` tool bridge (model, requires
 * renewal.autoRenew) replace the session with a fresh one seeded ONLY by the durable
 * files. No transcript replay, no compaction, no LLM summarization.
 *
 * Runtime imports are node built-ins and local pure modules only; the pi
 * package is imported type-only so this module can be unit-tested standalone.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ReplacedSessionContext,
  SessionBeforeSwitchEvent,
  SessionStartEvent,
  ToolCallEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import pathDefault from "node:path";

import {
  computeBudget,
  crossingPoints,
  crossingPointsLine,
  defaultThresholds,
  syntheticBudget,
  ContextPressureMachine,
  type GuardLevel,
  type BudgetBreakdown,
  type Measurement,
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
  loadRenewalState,
  normalizePath,
  pruneSessionStates,
  readRecoveryBundle,
  renewAuthorization,
  saveGuardState,
  saveRenewalState,
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
import { recoveryCost, recoveryCostLine } from "./recovery.ts";
import {
  buildRecoveryPrompt,
  decideRenewal,
  INITIAL_RENEWAL_STATE,
  type RenewalState,
  type RenewalTrigger,
} from "./renewal.ts";
import {
  appendDiagnostic,
  buildDiagnosticEvent,
  diagnosticsPath,
  formatDiagnosticEvent,
  recentDiagnostics,
  type DiagnosticType,
} from "./diagnostics.ts";

export const CUSTOM_TYPE = "context-guard";

/**
 * dev.2 D5d (P-9): the runtime identity carries a VERSION, never a milestone label.
 * `GUARD_VERSION` overrides it for probes/forensics without touching code.
 */
export const DEFAULT_GUARD_VERSION = "0.1.0-dev.2";
export function guardVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.GUARD_VERSION;
  return typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 40) : DEFAULT_GUARD_VERSION;
}

/** D5b: concrete next steps when the renewal preview refuses — never a bare "no". */
function renewalSafeInstructions(why: string, done: number, max: number): string {
  switch (why) {
    case "capped":
      return `At the cap (${done}/${max}) the safe closing path is the handoff_finalize tool — one synchronous checkpoint + attestation, never a switch; raising renewal.maxRenewals or resetting the chain state stays an explicit OPERATOR decision. Finish the durable prose, finalize, then stop.`;
    case "already-renewed":
      return "This checkpoint already seeded a successor: refresh (/handoff) and re-attest (/handoff ready) before renewing again, or close with handoff_finalize.";
    case "not-authorized":
      return "Renewal needs a current + attested checkpoint: run /handoff, then /handoff ready; meanwhile finish the durable prose and close with handoff_finalize.";
    case "stopped":
      return "The operator stop is durable on this chain (renewal stays refused until an operator /handoff renew resume); close with handoff_finalize.";
    case "read-only":
      return "Read-only audit mode never switches sessions; /handoff finalize is a reported dry run here.";
    case "pending":
      return "A renewal is already pending/running in this process; finish the current turn normally.";
    default:
      return "Keep the durable files current and stop cleanly; renewal remains operator-driven.";
  }
}

/**
 * MODULE-SCOPE renewal runtime (LEARNINGS A-17.4): jiti caches the extension module,
 * so top-level state survives session replacement within the process; the factory is
 * re-invoked per replacement, so per-closure state (g) does NOT. The pending marker
 * lets the successor's session_start record the lineage, and the operator stop flag
 * is honored by `session_before_switch` for GUARD-pending switches only.
 * The durable chain state (cap, idempotence, stop) lives in renewal-state.json; this
 * is the in-process fast path + the marker for the in-flight transition.
 */
interface PendingRenewalMarker {
  checkpointId: string;
  chainId: string;
  fromSessionId: string;
  trigger: RenewalTrigger;
  renewalIndex: number;
  requestedAt: number;
}
const renewalRuntime: { pending: PendingRenewalMarker | null; running: boolean; operatorStop: boolean } = {
  pending: null,
  running: false,
  operatorStop: false,
};

/**
 * Detect the RUNNING pi harness at runtime (identity requirement: never invent
 * values). process.argv[1] is the pi CLI entry (e.g. dist/bundle/cli.js); walk up to
 * the nearest package.json named "@earendil-works/pi-coding-agent". "unknown" when
 * unresolvable (compiled bundling, odd argv) — the banner then omits what it cannot
 * verify.
 */
export function detectPiHarness(f: Pick<FsOps, "readFile" | "realpath">, argv1: string | undefined = process.argv[1]): { version: string; pkgDir: string | null } {
  if (!argv1) return { version: "unknown", pkgDir: null };
  const candidates = [argv1, f.realpath?.(argv1) ?? undefined];
  for (const start of candidates) {
    if (!start) continue;
    let dir = pathDefault.dirname(start);
    for (let i = 0; i < 8; i++) {
      const raw = f.readFile(joinPath(dir, "package.json"));
      if (raw) {
        try {
          const pkg = JSON.parse(raw) as { name?: string; version?: string };
          if (pkg.name === "@earendil-works/pi-coding-agent") {
            return { version: typeof pkg.version === "string" ? pkg.version : "unknown", pkgDir: dir };
          }
        } catch {
          /* keep walking */
        }
      }
      const parent = pathDefault.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { version: "unknown", pkgDir: null };
}

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
    return new ContextPressureMachine(defaultThresholds(config.thresholds, { enforceClosing: config.enforceClosing }), config.maxConsecutiveUnknown);
  }

  function measure(ctx: ExtensionContext): BudgetBreakdown {
    const config = g?.config ?? DEFAULT_CONFIG;
    const usage = ctx.getContextUsage?.();
    if (config.syntheticRemaining != null) {
      return syntheticBudget(config.syntheticRemaining, usage?.contextWindow ?? ctx.model?.contextWindow ?? 0, config.workingContextWindow);
    }
    return computeBudget({
      modelId: (ctx.model as { id?: string } | undefined)?.id ?? null,
      contextWindow: usage?.contextWindow ?? null,
      modelContextWindow: ctx.model?.contextWindow ?? null,
      workingContextWindow: config.workingContextWindow,
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
   * dev.2 D5c: structured diagnostics trail (<stateDir>/diagnostics.jsonl).
   * Bounded, allowlisted events only — NEVER prompts, tool arguments or secrets.
   * Persistence follows the audit rule (PROTOCOL §2.3): read-only mode with an IN-TREE
   * stateDir records NOTHING; an external stateDir records outside the audited tree.
   */
  function recordDiag(type: DiagnosticType, fields: Record<string, unknown> = {}): void {
    if (!g || !g.config.enabled) return;
    if (!canPersistState()) return;
    const event = buildDiagnosticEvent(type, { session: g.sessionId, ...fields });
    if (event) appendDiagnostic(fs, resolvedStateDir(g), event);
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
      `  physical context window: ${m.physicalContextWindow ?? "unknown"} (Pi/provider; ctx.model declares ${m.modelContextWindow ?? "unknown"})`,
      `  working context window: ${m.contextWindow ?? "unknown"} (source: ${m.contextWindowSource}${m.configuredWorkingContextWindow != null ? `, configured ${m.configuredWorkingContextWindow}` : ", inherited from Pi"}) — POLICY ONLY; Pi/Sushi window unchanged`,
      `  estimated used: ${m.tokensUsed ?? "unknown"} tokens (Pi estimate: last reported usage + chars/4 heuristic, not exact)`,
      `  raw remaining: ${m.rawRemaining == null ? "unknown" : Math.floor(m.rawRemaining)} (working window - used, no reserve subtracted)`,
      `  physical raw remaining: ${m.physicalContextWindow == null || m.tokensUsed == null ? "unknown" : Math.floor(m.physicalContextWindow - m.tokensUsed)} (Pi physical window - used, does not subtract Pi's own safety margin)`,
      `  generation reserve: ${m.reserve.selected}${m.reserveFraction == null ? "" : ` = ${(m.reserveFraction * 100).toFixed(1)}% of the window`} (source: ${RESERVE_LABEL[m.reserve.source] ?? m.reserve.source}; safetyReserve ${m.reserve.safetyReserve})`,
      `  usable remaining: ${m.usableRemaining == null ? "unknown" : Math.floor(m.usableRemaining)} = window - used - reserve`,
      `  ${crossingPointsLine(crossingPoints({ contextWindow: m.contextWindow, reserve: m.reserve, thresholds: defaultThresholds(g.config.thresholds, { enforceClosing: g.config.enforceClosing }) }))}`,
      `  guard level: ${s.currentLevel}${s.currentLevel >= 4 && g.config.enforceClosing ? ` (ENFORCED closing: only ${g.config.closingAllowlist.join(", ")} run)` : ""}; alerts spent [${s.alertedLevels.join(", ")}]; revoked notices [${(s.revokedLevels ?? []).join(", ")}]; evaluations ${s.evaluations}${s.degraded ? "; DEGRADED (measurements unavailable)" : ""}`,
      `  next threshold: ${nextText}`,
      `  measurement: ${m.status}${m.reason ? ` (${m.reason})` : ""}`,
      `  provenance: ${m.provenance ?? "unknown"}`,
      `  checkpoint: ${g.checkpoint.kind}${g.checkpointId ? ` ${g.checkpointId}` : ""}${readiness ? `; readiness ${readiness.state}` : ""}; checkpointOk ${g.checkpointOk ?? "n/a"}${"changed" in g.checkpoint && g.checkpoint.changed.length > 0 ? `; changed sources: ${g.checkpoint.changed.join(", ")}` : ""}`,
      `  renewal authorization (gate for /handoff renew): ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}`,
    ];
    // Renewal policy + durable chain state (cap/idempotence/stop survive replacement+restart).
    {
      const r = g.config.renewal;
      const chain = loadRenewalState(fs, resolvedStateDir(g));
      lines.push(
        `  renewal: policy enabled=${r.enabled} autoRenew=${r.autoRenew} maxRenewals=${r.maxRenewals}; chain ${chain.state.chainId || "(none)"} done=${chain.state.renewalsDone}/${r.maxRenewals}${chain.state.renewedFromCheckpointId ? ` lastFrom=${chain.state.renewedFromCheckpointId}` : ""}; stop in-memory=${renewalRuntime.operatorStop} durable=${chain.state.stopped}${renewalRuntime.pending ? `; PENDING (${renewalRuntime.pending.trigger} from ${renewalRuntime.pending.fromSessionId})` : ""}${chain.corrupt ? "; chain state CORRUPT (treated as initial)" : ""}`,
      );
      lines.push(`  ${recoveryCostLine(recoveryCost(fs, g.cwd, g.config.files), g.config.recovery)}`);
    }
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

  /** Concise, RUNTIME-DERIVED identity (nothing invented, nothing from stale docs). */
  function identityBanner(ctx: ExtensionContext, event: SessionStartEvent, sessionId: string): string {
    const harness = detectPiHarness(fs);
    const model = ctx.model as { provider?: string; id?: string; api?: string; contextWindow?: number; maxTokens?: number } | undefined;
    const bits = [
      `harness: pi ${harness.version}${harness.pkgDir ? ` @ ${harness.pkgDir}` : " (package dir unresolved)"}`,
      "extension: context-guard (project-local, v" + guardVersion(env) + ")",
      model?.id
        ? `model: ${model.provider ?? "?"}/${model.id}${model.api ? ` api=${model.api}` : ""}${model.contextWindow ? ` window=${model.contextWindow}` : ""}${model.maxTokens ? ` maxOutput=${model.maxTokens}` : ""}`
        : "model: none selected",
      `project: ${pathDefault.basename(ctx.cwd)} (${ctx.cwd})`,
      `session: ${sessionId}`,
      `start: ${event.reason}${event.previousSessionFile ? ` after ${event.previousSessionFile}` : ""}`,
    ];
    return `[context-guard identity] ${bits.join(" | ")}`;
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

  /** Compact measurement summary for audit entries: values + provenance, before/after. */
  function measurementBrief(m: Measurement | null): Record<string, unknown> | null {
    if (!m) return null;
    return {
      status: m.status,
      remaining: m.remaining,
      tokensUsed: m.tokensUsed,
      contextWindow: m.contextWindow,
      rawRemaining: m.rawRemaining ?? null,
      reserve: m.reservedForGeneration,
      reserveSource: m.reserveSource ?? null,
      provenance: m.provenance ?? "unknown",
    };
  }

  /** Evaluate pressure, alert once per crossing, notify once per revocation, checkpoint at level >= 3. */
  function evaluate(ctx: ExtensionContext, boundary: "turn_end" | "command" | "settled"): Transition | undefined {
    if (!g || !g.config.enabled) return undefined;
    const transition = g.machine.evaluate(measure(ctx));
    const alertText = g.machine.formatAlert(transition);
    // dev.2 D5b: the model hears about renewal ONLY through a WRITE-FREE preview of the
    // REAL gate (decideRenewal with the LIVE checkpoint identity + renewAuthorization +
    // durable stop + cap + read-only + pending). A hint must never promise a transition
    // the gate would refuse; refusals get concrete safe instructions instead
    // (finalize-at-cap included — P-10: facts, no speculation). validateCheckpoint,
    // renewAuthorization and loadRenewalState are read-only: the preview performs ZERO writes.
    let renewalHint = "";
    if (transition.level >= 3 && g.config.renewal.enabled && g.config.renewal.autoRenew) {
      const chainNow = loadRenewalState(fs, resolvedStateDir(g));
      const live = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      const preview = decideRenewal({
        renewal: g.config.renewal,
        trigger: "model",
        auth: renewAuthorization(live),
        checkpointId: live.kind === "current" ? live.identity?.id ?? null : null,
        state: chainNow.state,
        operatorStop: renewalRuntime.operatorStop || chainNow.state.stopped === true,
        pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running,
        readOnly: g.config.readOnly === true,
      });
      const done = chainNow.state.renewalsDone;
      const max = g.config.renewal.maxRenewals;
      if (preview.renew) {
        renewalHint =
          `\nRENEWAL AVAILABLE: when your durable files (HANDOFF.md/PROGRESS.md/LEARNINGS.md) carry your current state, call the handoff_renew tool — it refreshes+attests the checkpoint and switches to a FRESH session that recovers from those files only (no transcript replay, no compaction; chain renewals used ${done}/${max}).`;
      } else {
        renewalHint = `\nRENEWAL NOT AVAILABLE (${preview.why}): ${preview.detail} ${renewalSafeInstructions(preview.why, done, max)}`;
      }
    }
    if (alertText) {
      // triggerTurn:false while Pi is streaming => Pi defers the append to the
      // end of the current turn: an in-flight tool call is never interrupted.
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: alertText + renewalHint,
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
      recordDiag("alert", {
        level: transition.level,
        crossed: transition.crossed.map((t) => t.label),
        remaining: transition.measurement.remaining ?? undefined,
        boundary,
      });
    }
    if (transition.degraded && transition.crossed.length === 0) {
      notify(ctx, "context-guard: context measurement unavailable for several evaluations; holding last known pressure level.", "warning");
    }
    // Revocation: a fresh VALID measurement lifted a previously alerted (possibly
    // enforced) threshold. The historical alert stays in the transcript for audit;
    // this message tells model AND operator that closing guidance is no longer
    // current policy. Measurements + provenance before/after are recorded.
    const revocationText = g.machine.formatRevocation(transition);
    if (revocationText) {
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: revocationText,
          display: true,
          details: {
            revoked: transition.revoked.map((t) => ({ level: t.level, label: t.label, kind: t.kind })),
            levelFrom: transition.previousLevel,
            levelTo: transition.level,
            before: transition.previousMeasurement,
            after: transition.measurement,
            boundary,
          },
        },
        { triggerTurn: false },
      );
      try {
        pi.appendEntry(CUSTOM_TYPE, {
          revokedLevels: transition.revoked.map((t) => t.level),
          levelFrom: transition.previousLevel,
          levelTo: transition.level,
          before: measurementBrief(transition.previousMeasurement),
          after: measurementBrief(transition.measurement),
          boundary,
        });
      } catch {
        /* audit entry is best-effort */
      }
      notify(
        ctx,
        `context-guard: level ${transition.previousLevel} -> ${transition.level}; closing REVOKED by fresh measurement (${transition.revoked.map((t) => t.label).join(", ")} no longer current policy).`,
        "info",
      );
      recordDiag("revocation", {
        revoked: transition.revoked.map((t) => t.label),
        level: transition.level,
        remaining: transition.measurement.remaining ?? undefined,
        boundary,
      });
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
      g.machine = ContextPressureMachine.restore(loaded.state.snapshot, defaultThresholds(config.thresholds, { enforceClosing: config.enforceClosing }), config.maxConsecutiveUnknown);
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

    // --- Phase 2 renewal: inherit the DURABLE operator stop, then handle lineage ---
    // Module-scope runtime survives replacement (A-17.4); the chain file survives
    // restarts. A successor must never resurrect a stopped chain, and a fresh process
    // must never forget one.
    const chain0 = loadRenewalState(fs, resolvedStateDir(g));
    renewalRuntime.operatorStop = chain0.state.stopped === true;
    const pend = renewalRuntime.pending;
    renewalRuntime.pending = null; // any session start consumes a stale marker
    if (pend && event.reason === "new" && event.previousSessionFile) {
      // This session IS the successor the previous session switched into: record the
      // lineage durably (P-4), audit the checkpoint it came from (PROTOCOL §6) and
      // tell the operator. Reporting goes through THIS context — the predecessor's is
      // invalid (A-17.5).
      if (chain0.state.chainId === pend.chainId) {
        saveRenewalState(fs, resolvedStateDir(g), { ...chain0.state, lastSuccessorSessionId: sessionId, updatedAt: Date.now() });
      }
      notify(
        ctx,
        `context-guard: renewed session ${pend.renewalIndex}(chain ${pend.chainId}) from checkpoint ${pend.checkpointId} (parent session ${pend.fromSessionId}, trigger ${pend.trigger}). Recovering from durable files; transcripts are NOT replayed.`,
        "info",
      );
      try {
        pi.appendEntry(CUSTOM_TYPE, {
          renewalSuccessor: {
            chainId: pend.chainId,
            fromCheckpointId: pend.checkpointId,
            parentSessionId: pend.fromSessionId,
            parentSessionFile: event.previousSessionFile,
            trigger: pend.trigger,
            renewalsDone: chain0.state.renewalsDone,
          },
        });
      } catch {
        /* audit entry is best-effort */
      }
    }

    // Runtime-derived identity for EVERY session (operator-visible + model-delivered
    // BEFORE the first inference: a triggerTurn:false custom message lands in the
    // transcript now and reaches the model on its next request — A-13). Values are
    // read from the live runtime; unknowns are stated, never invented.
    try {
      const banner = identityBanner(ctx, event, sessionId);
      notify(ctx, banner, "info");
      pi.sendMessage({ customType: `${CUSTOM_TYPE}-identity`, content: banner, display: true, details: { reason: event.reason } }, { triggerTurn: false });
      try {
        pi.appendEntry(CUSTOM_TYPE, { identity: banner });
      } catch {
        /* audit entry is best-effort */
      }
    } catch (err) {
      notify(ctx, `context-guard: identity banner failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }

    recordDiag("session_start", {
      reason: event.reason,
      level: g.machine.currentLevel,
      checkpoint: g.checkpoint.kind,
      chain: chain0.state.chainId || undefined,
      renewalsDone: chain0.state.renewalsDone,
      maxRenewals: config.renewal.maxRenewals,
    });
    persistState();
    setStatus(ctx);
  });

  // Cancellation hook (P-6): cancel ONLY a switch the guard itself has pending, and
  // only while the operator stop is set — a human-initiated /new or /resume is never
  // touched. `session_before_switch` fires before teardown (agent-session-runtime.js),
  // so cancelling leaves the current session fully alive.
  pi.on("session_before_switch", (_event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => {
    if (renewalRuntime.pending && renewalRuntime.operatorStop) {
      notify(ctx, "context-guard: pending renewal CANCELLED by the operator stop (session_before_switch).", "warning");
      return { cancel: true };
    }
    return undefined;
  });

  pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
    evaluate(ctx, "turn_end");
    return undefined;
  });

  pi.on("agent_settled", (event, ctx: ExtensionContext) => {
    if (g && g.config.enabled) {
      // D5c/P-10: an aborted run is the INTERRUPTION SIGNAL — record it for later
      // attribution (known refusal vs unknown cause). The guard NEVER retries an
      // aborted generation automatically; recovery stays model/operator driven.
      if ((event as { aborted?: boolean }).aborted === true) {
        recordDiag("turn_aborted", { aborted: true, detail: "agent_settled.aborted — recorded for attribution; no automatic retry is performed or implied" });
      }
      evaluate(ctx, "settled");
    } else persistState();
  });

  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext) => {
    if (!g || !g.config.enabled) return undefined;
    // Enforced closing phase: gate NEW tool calls before execution.
    // This never interrupts an in-flight call (turn boundary already passed).
    // `handoff_finalize` is checkpoint machinery (managed-block writes only, never a
    // session switch, never chain-state writes — D2): allowed during closing even if
    // the project's closingAllowlist does not name it. `handoff_renew` stays
    // allowlist-gated because it DOES schedule a switch.
    if (g.machine.currentLevel >= 4 && g.config.enforceClosing) {
      if (!g.config.closingAllowlist.includes(event.toolName) && event.toolName !== "handoff_finalize") {
        recordDiag("tool_block", { tool: event.toolName, kind: "closing" });
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
        recordDiag("tool_block", { tool: event.toolName, kind: "goal" });
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
    description: "Context guard status/simulation: /guard status | simulate <tokens> | reset | verify-checkpoint | events [n]",
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
      if (sub === "events") {
        // D5c: operator-facing tail of the diagnostics trail (no prompts/args/secrets
        // can appear — the file itself is allowlisted at write time).
        if (!canPersistState()) {
          ctx.ui.notify("context-guard events: diagnostics are not persisted in read-only audit mode with an in-tree stateDir (zero writes to the audited tree).", "info");
          return;
        }
        const nRaw = parts[1] != null ? Number(parts[1]) : 20;
        const n = Number.isFinite(nRaw) ? Math.min(200, Math.max(1, Math.floor(nRaw))) : 20;
        const events = recentDiagnostics(fs, resolvedStateDir(g), n);
        ctx.ui.notify(
          events.length === 0
            ? `context-guard events: no diagnostics recorded yet (${diagnosticsPath(resolvedStateDir(g))})`
            : `context-guard events (last ${events.length}):\n` + events.map(formatDiagnosticEvent).join("\n"),
          "info",
        );
        return;
      }
      ctx.ui.notify("usage: /guard status | /guard simulate <remainingTokens> | /guard reset | /guard verify-checkpoint | /guard events [n]", "info");
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
      `  renewal authorization (gate for /handoff renew): ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}`,
      `  ${recoveryCostLine(recoveryCost(fs, g.cwd, g.config.files), g.config.recovery)}`,
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
    lines.push(`  renewal authorization (gate for /handoff renew): ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}`);
    persistState();
    return { text: lines.join("\n"), ok: att.ok };
  }

  /* ---------------------------------------------------------------- */
  /* Phase 2 renewal (increment B): the ONLY paths that switch sessions. */
  /* Operator: /handoff renew [notes]; model: handoff_renew tool ->     */
  /* /handoff renew go (P-8 bridge). Everything is gated by             */
  /* decideRenewal(renewAuthorization(...) ∧ enabled ∧ cap ∧             */
  /* idempotence ∧ not-stopped ∧ not-read-only).                        */
  /* ---------------------------------------------------------------- */

  function renewStatusReport(): string {
    if (!g) return "context-guard: not initialized";
    const chain = loadRenewalState(fs, resolvedStateDir(g));
    const r = g.config.renewal;
    const fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    const auth = renewAuthorization(fresh);
    const cpId = fresh.kind === "current" || fresh.kind === "stale" ? fresh.identity?.id ?? null : null;
    const lines = [
      `context-guard renewal status (state dir ${resolvedStateDir(g)})`,
      `  policy: enabled=${r.enabled} autoRenew=${r.autoRenew} maxRenewals=${r.maxRenewals}${r.recoveryPrompt ? " recoveryPrompt=custom" : ""}${r.testCommand ? ` testCommand=${JSON.stringify(r.testCommand)}` : " testCommand=(none — successor prompt carries no build-verify line)"}`,
      `  chain: ${chain.state.chainId || "(none yet)"} renewalsDone=${chain.state.renewalsDone}/${r.maxRenewals}${chain.state.renewedFromCheckpointId ? ` lastFrom=${chain.state.renewedFromCheckpointId}` : ""}${chain.state.lastSuccessorSessionId ? ` lastSuccessor=${chain.state.lastSuccessorSessionId}` : ""}`,
      `  operator stop: in-memory=${renewalRuntime.operatorStop} durable=${chain.state.stopped}${chain.corrupt ? "; CHAIN STATE CORRUPT (treated as initial)" : ""}`,
      `  pending switch: ${renewalRuntime.pending ? `${renewalRuntime.pending.trigger} from ${renewalRuntime.pending.fromSessionId} (checkpoint ${renewalRuntime.pending.checkpointId})` : renewalRuntime.running ? "renewal command running" : "none"}`,
      `  authorization now: ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}${cpId ? ` (checkpoint ${cpId})` : ""}`,
      `  note: the cap and the idempotence key are DURABLE (renewal-state.json); they survive session replacement and process restart (RN9).`,
    ];
    return lines.join("\n");
  }

  /** Persist the durable operator stop (in-memory flag is always set; durable write best-effort). */  function persistRenewalStop(stop: boolean, ctx: ExtensionContext): void {
    renewalRuntime.operatorStop = stop;
    if (!g) return;
    const stateDir = resolvedStateDir(g);
    if (!canPersistState()) {
      notify(ctx, `context-guard: renewal stop flag set IN MEMORY only (state dir inside the audited tree / read-only mode; a restart would lose it)`, "warning");
      return;
    }
    const chain = loadRenewalState(fs, stateDir);
    const saved = saveRenewalState(fs, stateDir, { ...chain.state, stopped: stop, updatedAt: Date.now() });
    notify(
      ctx,
      saved.ok
        ? `context-guard: renewals ${stop ? "STOPPED" : "RESUMED"} for this chain (durable: renewal-state.json).${stop ? " A pending guard switch will be cancelled at session_before_switch." : ""}`
        : `context-guard: renewals ${stop ? "stopped" : "resumed"} in memory; durable write FAILED: ${saved.error}`,
      stop ? "warning" : "info",
    );
  }

  /* ---------------------------------------------------------------- */
  /* dev.2 D2: INDEPENDENT finalization. Reuses the checkpoint          */
  /* transaction + readiness + attestation primitives, but is NOT part */
  /* of the renewal path: it never switches sessions, never touches    */
  /* chain state (cap/idempotence/stop stay byte-identical), and never */
  /* bypasses readiness — attestation refuses on failed blocking       */
  /* checks. Works with renewal disabled, capped or stopped. Fully     */
  /* SYNCHRONOUS (no waitForIdle — deadlock-free by construction).     */
  /* ---------------------------------------------------------------- */
  function finalizeHandoff(ctx: ExtensionContext, notes?: string): { ok: boolean; text: string; checkpointId: string | null; dry: boolean } {
    if (!g) return { ok: false, text: "context-guard FINALIZE: not initialized", checkpointId: null, dry: false };
    const dry = !canWriteProjectTree();
    const chain = loadRenewalState(fs, resolvedStateDir(g)); // READ-ONLY: finalize never writes chain state
    const header = (outcome: string, cpId: string | null, readiness: string): string =>
      `context-guard FINALIZE (session ${g.sessionId}, ${new Date().toISOString()}): checkpoint ${cpId ?? "none"} readiness ${readiness} -> ${outcome}; chain done=${chain.state.renewalsDone}/${g.config.renewal.maxRenewals} UNTOUCHED; no session switch`;
    const lines: string[] = [];
    let fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    const capExhausted = g.config.renewal.maxRenewals <= 0 || chain.state.renewalsDone >= g.config.renewal.maxRenewals;
    if (dry) {
      // Audit mode: evaluate + report only; checkpoint and attestation stay dry runs.
      const ev = evaluateHandoffReadiness(fs, g.cwd, g.config.files, {
        configName: DEFAULT_CONFIG_NAME,
        learningsHashAtSessionStart: g.learningsHash,
      });
      const readiness = ev.freshness.kind === "current" || ev.freshness.kind === "stale" ? ev.freshness.readiness.state : ev.freshness.kind;
      lines.push(header(ev.ok ? "DRY RUN" : "DRY RUN (NOT READY)", ev.identity?.id ?? null, String(readiness)));
      lines.push(`  read-only audit mode: NOT written (would ${fresh.kind !== "current" ? "refresh + attest" : "attest"} the managed blocks; no renewal involvement)`);
      lines.push(`  ${recoveryCostLine(recoveryCost(fs, g.cwd, g.config.files), g.config.recovery)}`);
      for (const c of ev.checks) if (c.status === "fail") lines.push(`  FAIL ${c.id}: ${c.detail}`);
      recordDiag("finalize", { ok: ev.ok, dry: true, checkpoint: ev.identity?.id ?? undefined, detail: "audit dry run (zero tree writes)" });
      persistState();
      return { ok: ev.ok, text: lines.join("\n"), checkpointId: ev.identity?.id ?? null, dry };
    }
    if (fresh.kind !== "current") {
      const res = checkpoint(ctx, `finalize${notes ? `: ${notes}` : ""}`, notes, { kind: "manual" });
      if (!res || !res.ok) {
        lines.push(header("FAILED", res?.identity.id ?? null, "n/a"));
        lines.push(`  checkpoint refresh failed: ${res ? res.errors.join("; ") : "no result"}`);
        recordDiag("finalize", { ok: false, dry: false, checkpoint: res?.identity.id, detail: "checkpoint refresh failed" });
        persistState();
        return { ok: false, text: lines.join("\n"), checkpointId: res?.identity.id ?? null, dry };
      }
      fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    }
    let alreadyFinal = false;
    if (fresh.kind === "current" && fresh.readiness.state !== "attested") {
      const att = attestHandoff(fs, g.cwd, g.config.files, {
        sessionId: g.sessionId,
        configName: DEFAULT_CONFIG_NAME,
        learningsHashAtSessionStart: g.learningsHash,
      });
      if (!att.ok) {
        // NEVER bypass readiness: blocking failures refuse the attestation with zero stamps.
        lines.push(header("NOT READY", att.checkpointId ?? null, "unattested"));
        for (const e of att.errors) lines.push(`  attestation refused: ${e}`);
        recordDiag("finalize", { ok: false, dry: false, checkpoint: att.checkpointId ?? undefined, detail: "attestation refused (readiness blocking checks failed)" });
        persistState();
        return { ok: false, text: lines.join("\n"), checkpointId: att.checkpointId ?? null, dry };
      }
      fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    } else if (fresh.kind === "current") {
      alreadyFinal = fresh.readiness.state === "attested";
    }
    const ok = fresh.kind === "current" && fresh.readiness.state === "attested";
    const cpId = fresh.kind === "current" || fresh.kind === "stale" ? fresh.identity?.id ?? null : null;
    lines.push(header(ok ? "FINALIZED" : "NOT READY", cpId, fresh.kind === "current" ? fresh.readiness.state : fresh.kind));
    if (alreadyFinal) lines.push("  already current + attested: nothing to do (idempotent).");
    if (capExhausted) {
      lines.push(
        `  renewal cap exhausted (${chain.state.renewalsDone}/${g.config.renewal.maxRenewals}): finalization is the safe closing path — finish the durable prose, then stop; raising renewal.maxRenewals or resetting <stateDir>/renewal-state.json stays an explicit operator choice.`,
      );
    }
    if (chain.state.stopped) {
      lines.push("  operator stop is durable on this chain; finalize neither needs nor clears it (renewal stays refused until /handoff renew resume).");
    }
    lines.push(`  ${recoveryCostLine(recoveryCost(fs, g.cwd, g.config.files), g.config.recovery)}`);
    recordDiag("finalize", { ok, dry: false, checkpoint: cpId ?? undefined, detail: ok ? "finalized (current + attested)" : "not ready" });
    persistState();
    setStatus(ctx);
    return { ok, text: lines.join("\n"), checkpointId: cpId, dry };
  }

  /**
   * The renewal transition (P-6 / A-17 / PROTOCOL §6). Safe boundary first
   * (waitForIdle — never mid tool call), then refresh + attest the checkpoint, gate,
   * persist chain state BEFORE the switch (crash-safe), then newSession with a
   * fire-and-track recovery send (O-1: awaiting would block newSession until the
   * successor's first turn ENDS). After the switch the old ctx is INVALID (A-17.5):
   * only plain data and the successor's own session_start reporting remain.
   */
  async function runRenewal(trigger: RenewalTrigger, ctx: ExtensionCommandContext, notes?: string): Promise<void> {
    if (!g) {
      notify(ctx, "context-guard: not initialized", "error");
      return;
    }
    if (renewalRuntime.running || renewalRuntime.pending) {
      notify(ctx, "context-guard: renewal refused (pending): another renewal is already pending/running in this process", "warning");
      recordDiag("renewal_result", { trigger, ok: false, why: "pending", detail: "another renewal is pending/running in this process" });
      return;
    }
    renewalRuntime.running = true;
    recordDiag("renewal_request", { trigger });
    try {
      // 0. NO-WRITE pre-gate: stop/read-only/disabled/auto-disabled/pending/cap refuse
      //    before anything touches the tree (authorization/idempotence are re-checked
      //    after the refresh below). The dummy checkpoint id + authorized:true make
      //    decideRenewal evaluate ONLY the cheap prefix of its precedence chain.
      {
        const pre = decideRenewal({
          renewal: g.config.renewal,
          trigger,
          auth: { authorized: true, reason: "pre-gate (authorization checked after refresh)" },
          checkpointId: "__pre-gate__",
          state: loadRenewalState(fs, resolvedStateDir(g)).state,
          operatorStop: renewalRuntime.operatorStop,
          pendingInFlight: renewalRuntime.pending !== null,
          readOnly: g.config.readOnly,
        });
        if (!pre.renew) {
          notify(ctx, `context-guard: renewal NOT performed (${pre.why}): ${pre.detail}`, "warning");
          recordDiag("renewal_result", { trigger, ok: false, why: pre.why, detail: pre.detail });
          return;
        }
      }
      // 1. Safe execution boundary.
      await ctx.waitForIdle();
      // 2. Durable prerequisite: refresh the checkpoint if it is not current, then attest.
      let fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      if (fresh.kind !== "current") {
        const res = checkpoint(ctx, `renewal refresh (${trigger})`, notes, { kind: "manual" });
        if (!res || !res.ok) {
          notify(ctx, `context-guard: renewal ABORTED — checkpoint refresh failed: ${res ? res.errors.join("; ") : "no result"}`, "error");
          recordDiag("renewal_result", { trigger, ok: false, why: "checkpoint-refresh-failed", detail: res ? res.errors.join("; ").slice(0, 300) : "no result" });
          return;
        }
        fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      }
      if (fresh.kind === "current" && fresh.readiness.state !== "attested") {
        const att = attestHandoff(fs, g.cwd, g.config.files, {
          sessionId: g.sessionId,
          configName: DEFAULT_CONFIG_NAME,
          learningsHashAtSessionStart: g.learningsHash,
        });
        if (!att.ok) {
          notify(ctx, `context-guard: renewal ABORTED — attestation refused: ${att.errors.join("; ")}`, "error");
          recordDiag("renewal_result", { trigger, ok: false, why: "attestation-refused", detail: att.errors.join("; ").slice(0, 300) });
          return;
        }
        fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      }
      // 3. Gate.
      const auth = renewAuthorization(fresh);
      const checkpointId = fresh.kind === "current" || fresh.kind === "stale" ? fresh.identity?.id ?? null : null;
      const chain = loadRenewalState(fs, resolvedStateDir(g));
      const decision = decideRenewal({
        renewal: g.config.renewal,
        trigger,
        auth,
        checkpointId,
        state: chain.state,
        operatorStop: renewalRuntime.operatorStop,
        pendingInFlight: renewalRuntime.pending !== null,
        readOnly: g.config.readOnly,
      });
      if (!decision.renew) {
        notify(ctx, `context-guard: renewal NOT performed (${decision.why}): ${decision.detail}`, "warning");
        recordDiag("renewal_result", { trigger, ok: false, why: decision.why, detail: decision.detail, checkpoint: checkpointId ?? undefined });
        return;
      }
      // 4. Persist chain state BEFORE the switch: cap + idempotence key must already
      //    be visible when the successor (or a restart) reads them.
      const chainId = chain.state.chainId || `chain:${g.sessionId}`;
      const renewalIndex = chain.state.renewalsDone + 1;
      const stateDir = resolvedStateDir(g);
      const updated: RenewalState = {
        ...chain.state,
        chainId,
        renewalsDone: renewalIndex,
        renewedFromCheckpointId: checkpointId!,
        updatedAt: Date.now(),
      };
      const saved = saveRenewalState(fs, stateDir, updated);
      if (!saved.ok) {
        notify(ctx, `context-guard: renewal ABORTED — chain state not persisted (${saved.error}); refusing an uncounted switch`, "error");
        recordDiag("renewal_result", { trigger, ok: false, why: "chain-state-save-failed", detail: saved.error ?? "unknown", checkpoint: checkpointId ?? undefined });
        return;
      }
      // 5. Mark pending (successor's session_start records lineage; the stop flag
      //    cancels via session_before_switch) and switch.
      renewalRuntime.pending = { checkpointId: checkpointId!, chainId, fromSessionId: g.sessionId, trigger, renewalIndex, requestedAt: Date.now() };
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const recovery = buildRecoveryPrompt({
        files: g.config.files,
        checkpointId: checkpointId!,
        chainId,
        renewalIndex,
        maxRenewals: g.config.renewal.maxRenewals,
        parentSessionId: g.sessionId,
        recoveryPrompt: g.config.renewal.recoveryPrompt,
        testCommand: g.config.renewal.testCommand,
        lean: g.config.recovery.lean,
        extraNotes: notes,
      });
      const fromSessionId = g.sessionId;
      const maxRen = g.config.renewal.maxRenewals;
      const res = await ctx.newSession({
        parentSession: parentSessionFile,
        withSession: async (nctx: ReplacedSessionContext) => {
          // From here on the OLD ctx is invalid (A-17.5): report via nctx only.
          notify(nctx, `context-guard: session renewed (${renewalIndex}/${maxRen}) from checkpoint ${checkpointId}; starting successor turn…`, "info");
          recordDiag("renewal_result", { trigger, ok: true, checkpoint: checkpointId, chain: chainId, renewalsDone: renewalIndex, maxRenewals: maxRen });
          void nctx
            .sendMessage(
              {
                customType: `${CUSTOM_TYPE}-recovery`,
                content: recovery,
                display: true,
                details: { checkpointId, chainId, renewalIndex, parentSessionId: fromSessionId },
              },
              { triggerTurn: true },
            )
            .catch((err: unknown) => {
              notify(nctx, `context-guard: recovery turn FAILED to start: ${err instanceof Error ? err.message : String(err)}`, "error");
            });
        },
      });
      if (res.cancelled) {
        // Cancelled at session_before_switch (operator stop) BEFORE teardown: the old
        // session is still alive, so ctx remains valid. Roll the durable counters back.
        renewalRuntime.pending = null;
        const cur = loadRenewalState(fs, stateDir);
        saveRenewalState(fs, stateDir, {
          ...cur.state,
          renewalsDone: Math.max(0, cur.state.renewalsDone - 1),
          renewedFromCheckpointId: null,
          updatedAt: Date.now(),
        });
        notify(ctx, "context-guard: renewal CANCELLED by the operator stop — no session switch; chain state rolled back", "warning");
        recordDiag("renewal_result", { trigger, ok: false, why: "cancelled-by-stop", checkpoint: checkpointId ?? undefined });
      }
      // Success path: do NOT touch ctx here — the successor's session_start handler
      // records lineage, notifies the operator and names the checkpoint it came from.
    } catch (err) {
      // Failure path: never leave the pending marker armed; report honestly.
      renewalRuntime.pending = null;
      notify(ctx, `context-guard: renewal FAILED with an error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, "error");
      recordDiag("renewal_result", { trigger, ok: false, why: "error", detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    } finally {
      renewalRuntime.running = false;
    }
  }

  /**
   * Model-initiated renewal (LEARNINGS A-19/P-8). The tool runs DURING a turn, so it
   * may only do the SYNCHRONOUS part (refresh + attest + gate) and then FIRE-AND-FORGET
   * the command dispatch. It must NEVER await anything that waits for idle — the agent
   * run is blocked on this tool's own result (deadlock, P-8). pi's API-level
   * sendUserMessage is void/fire-and-forget by contract (agent-session.js:2774), and
   * `expandPromptTemplates:true` routes it straight to _tryExecuteExtensionCommand,
   * which executes immediately even during streaming (A-19). No chain state is
   * persisted here — the command handler re-gates and does the durable accounting.
   */
  pi.registerTool({
    name: "handoff_renew",
    label: "Handoff renew",
    description:
      "Request an automatic session renewal (Phase 2). Refreshes and attests the durable checkpoint NOW, then schedules the session switch for the end of this turn: the successor starts with FRESH context and recovers ONLY from the durable files (AGENTS/PROTOCOL/GOAL/HANDOFF/PROGRESS/LEARNINGS) — no transcript replay, no compaction. Call it when your context is nearly exhausted AND your current state is written into the durable files. Returns the gate decision; a refusal names its reason and you should keep working normally afterwards.",
    promptSnippet: "handoff_renew — renew the session from durable handoff files when context is nearly exhausted",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Optional notes carried into the successor's recovery instruction" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { notes?: string }, _signal: unknown, _onUpdate: unknown, toolCtx: ExtensionContext) {
      const notes = typeof params?.notes === "string" ? params.notes.trim() : undefined;
      if (!g) return { content: [{ type: "text", text: "context-guard: not initialized" }], details: { ok: false, why: "not-initialized" } };
      // NO-WRITE pre-gate (same dummy-id trick as runRenewal): cheap refusals never
      // dirty the tree and never schedule a doomed dispatch.
      {
        const pre = decideRenewal({
          renewal: g.config.renewal,
          trigger: "model",
          auth: { authorized: true, reason: "pre-gate" },
          checkpointId: "__pre-gate__",
          state: loadRenewalState(fs, resolvedStateDir(g)).state,
          operatorStop: renewalRuntime.operatorStop,
          pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running,
          readOnly: g.config.readOnly,
        });
        if (!pre.renew) {
          return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled (${pre.why}): ${pre.detail}` }], details: { ok: false, why: pre.why } };
        }
      }
      // Synchronous durable prerequisite, then the full gate.
      let fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      if (fresh.kind !== "current") {
        const res = checkpoint(toolCtx, `renewal tool refresh`, notes, { kind: "manual" });
        if (!res || !res.ok) {
          return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled — checkpoint refresh failed: ${res ? res.errors.join("; ") : "no result"}` }], details: { ok: false, why: "checkpoint-failed" } };
        }
        fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      }
      if (fresh.kind === "current" && fresh.readiness.state !== "attested") {
        const att = attestHandoff(fs, g.cwd, g.config.files, { sessionId: g.sessionId, configName: DEFAULT_CONFIG_NAME, learningsHashAtSessionStart: g.learningsHash });
        if (!att.ok) {
          return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled — attestation refused: ${att.errors.join("; ")}. Fix the blocking checks (write the real next action) and call again.` }], details: { ok: false, why: "attestation-refused" } };
        }
        fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      }
      const auth = renewAuthorization(fresh);
      const checkpointId = fresh.kind === "current" || fresh.kind === "stale" ? fresh.identity?.id ?? null : null;
      const chain = loadRenewalState(fs, resolvedStateDir(g));
      const decision = decideRenewal({
        renewal: g.config.renewal,
        trigger: "model",
        auth,
        checkpointId,
        state: chain.state,
        operatorStop: renewalRuntime.operatorStop,
        pendingInFlight: false,
        readOnly: g.config.readOnly,
      });
      if (!decision.renew) {
        return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled (${decision.why}): ${decision.detail}` }], details: { ok: false, why: decision.why } };
      }
      // Fire-and-forget: the command handler runs at dispatch (A-19), awaits
      // waitForIdle itself, and performs the switch once this turn settles.
      pi.sendUserMessage(`/handoff renew go${notes ? ` ${notes}` : ""}`, { expandPromptTemplates: true });
      return {
        content: [
          {
            type: "text",
            text:
              `context-guard: renewal SCHEDULED for the end of this turn (authorized — ${decision.reason}). ` +
              `Checkpoint ${checkpointId} is refreshed and attested. Use the REST OF THIS TURN to make HANDOFF.md/PROGRESS.md/LEARNINGS.md current — ` +
              `the successor session receives ONLY those durable files (no transcript). Finish your reply normally; the switch happens automatically after it.`,
          },
        ],
        details: { ok: true, scheduled: true, checkpointId, cap: `${chain.state.renewalsDone + 1}/${g.config.renewal.maxRenewals}` },
      };
    },
  } as never);

  /**
   * dev.2 D2: model-driven closing WITHOUT a session switch. Deliberately has NO
   * waitForIdle, NO sendUserMessage and NO newSession (the renewal deadlock class of
   * A-19/P-8 cannot occur): everything is synchronous file work reusing the existing
   * checkpoint transaction + attestation primitives. Callable during enforced closing
   * (see the tool_call gate) and regardless of renewal policy (disabled/capped/stopped).
   */
  pi.registerTool({
    name: "handoff_finalize",
    label: "Handoff finalize",
    description:
      "Finalize the durable handoff WITHOUT switching sessions: refreshes the checkpoint when stale and attests readiness with the guard's existing transaction machinery. Works even when renewal is disabled, capped or stopped; never increments the renewal counter, resets the cap, clears the stop flag or bypasses readiness checks. Fully synchronous — no idle wait, no deadlock. Read-only audit mode: reported dry run, zero tree writes. Returns a compact structured one-line report.",
    promptSnippet: "handoff_finalize — checkpoint + attest the durable handoff; safe closing at the renewal cap (never switches sessions)",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Optional notes recorded into the checkpoint when it is refreshed" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { notes?: string }, _signal: unknown, _onUpdate: unknown, toolCtx: ExtensionContext) {
      const notes = typeof params?.notes === "string" ? params.notes.trim() || undefined : undefined;
      const res = finalizeHandoff(toolCtx, notes);
      return {
        content: [{ type: "text", text: res.text }],
        details: { ok: res.ok, checkpointId: res.checkpointId, dry: res.dry },
      };
    },
  } as never);

  pi.registerCommand("handoff", {
    description: "Durable checkpoint + renewal + finalization. Subcommands: verify, ready [check], finalize [notes], renew [notes] | renew go | renew stop | renew resume | renew status",
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
      if (parts[0] === "finalize") {
        const notes = parts.slice(1).join(" ").trim() || undefined;
        const res = finalizeHandoff(ctx, notes);
        ctx.ui.notify(res.text, res.ok ? "info" : "warning");
        return;
      }
      if (parts[0] === "renew") {
        const sub = parts[1];
        if (sub === "stop") {
          persistRenewalStop(true, ctx);
          return;
        }
        if (sub === "resume") {
          persistRenewalStop(false, ctx);
          return;
        }
        if (sub === "status") {
          ctx.ui.notify(renewStatusReport(), "info");
          return;
        }
        const trigger: RenewalTrigger = sub === "go" ? "model" : "operator";
        const notes = (sub === "go" ? parts.slice(2) : parts.slice(1)).join(" ").trim() || undefined;
        await runRenewal(trigger, ctx as ExtensionCommandContext, notes);
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
