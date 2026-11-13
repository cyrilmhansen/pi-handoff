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

import { execFileSync } from "node:child_process";
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
  CHECKPOINT_SCHEMA,
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
  cycleMetadata,
  documentationCycleId,
  documentationSourceFingerprint,
  DOCUMENTATION_CYCLE_STATE_FILE,
  parseDocumentationCycleState,
  serializeDocumentationCycleState,
  type DocumentationCyclePhase,
  type DocumentationCycleState,
} from "./documentation-cycle.ts";
import {
  buildSuccessorUserMessage,
  buildRecoveryPrompt,
  decideRenewal,
  INITIAL_RENEWAL_STATE,
  parseRenewalArgs,
  serializeRenewalState,
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
import { configForMissionInstance, createMissionInstance, instancePathIsSafe, missionChainId, readMissionInstanceProfile, validMissionInstanceId, validWorkProfileRef, workProfilePath } from "./mission-instance.ts";
import { acquireInstanceLock, inspectInstanceLock, instanceLockPath, ownsInstanceLock, processSelectionIsStable, recoverAbandonedInstanceLock, releaseInstanceLock } from "./mission-lock.ts";

export const CUSTOM_TYPE = "context-guard";
const MAX_OPERATOR_TASK_BYTES = 64 * 1024;

/**
 * dev.2 D5d (P-9): the runtime identity carries a VERSION, never a milestone label.
 * `GUARD_VERSION` overrides it for probes/forensics without touching code.
 */
export const DEFAULT_GUARD_VERSION = "0.1.0-dev.4";
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
      return "This checkpoint ID cannot seed a second successor. If you are its recorded successor and work remains, handoff_renew can create a fresh generation and recheck the real gate; otherwise do not retry this ID. A consumed checkpoint alone is not a reason to finalize unfinished work.";
    case "not-authorized":
      return "Renewal is not authorized NOW. Preserve the durable prose and exact next action; handoff_renew can refresh a missing/stale checkpoint and attest an unattested current one before rechecking the real gate. Correct any reported blocking checks and retry at a safe boundary. Use handoff_finalize only for intentional non-renewing closure or a terminal refusal; temporary readiness alone does not require stopping unfinished work.";
    case "stopped":
      return "The operator stop is durable on this chain (renewal stays refused until an operator /handoff renew resume); close with handoff_finalize.";
    case "read-only":
      return "Read-only audit mode never switches sessions; handoff_finalize is a reported dry run here. Ask the operator to leave audit mode only if a write or renewal is required.";
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
const renewalRuntime: { pending: PendingRenewalMarker | null; running: boolean; operatorStop: boolean; toolScheduled: boolean } = {
  pending: null,
  running: false,
  operatorStop: false,
  toolScheduled: false,
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
  missionInstanceError?: string;
  missionInstanceLockPath?: string;
  missionInstanceLockError?: string;
  readOnlyRequested: boolean;
}

export interface GuardOverrides {
  config?: Partial<GuardConfig>;
  fs?: FsOps;
  env?: Record<string, string | undefined>;
  /** Deterministic Git-HEAD seam for tests; production reads `git rev-parse HEAD`. */
  gitRevision?: () => string | undefined;
  /** Deterministic fake-process identity for ownership tests; production uses process.pid. */
  processScope?: string;
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
    merged.documentation = { ...base.documentation, ...(overrides.config?.documentation ?? {}) };
    merged.missionInstance = { ...base.missionInstance, ...(overrides.config?.missionInstance ?? {}) };
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

  function cycleStatePath(): string {
    return g ? joinPath(resolvedStateDir(g), DOCUMENTATION_CYCLE_STATE_FILE) : DOCUMENTATION_CYCLE_STATE_FILE;
  }

  function loadCycleState(): { state?: DocumentationCycleState; corrupt: boolean } {
    return parseDocumentationCycleState(fs.readFile(cycleStatePath()));
  }

  function saveCycleState(state: DocumentationCycleState): { ok: boolean; error?: string } {
    if (!g || !canPersistState()) return { ok: false, error: "documentation-cycle state cannot be persisted in the current read-only mode" };
    try {
      fs.mkdirRecursive(pathDefault.dirname(cycleStatePath()));
      fs.writeFile(cycleStatePath(), serializeDocumentationCycleState(state));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function gitHeadRevision(): string | undefined {
    if (overrides.gitRevision) {
      try { return overrides.gitRevision(); } catch { return undefined; }
    }
    if (!g) return undefined;
    try {
      const out = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: g.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      const rev = out.trim();
      return /^[0-9a-f]{40,64}$/i.test(rev) ? rev.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  }

  function cycleSourceSnapshot(): { sources: Record<string, string>; fingerprint: string; goalFingerprint: string } | { error: string } {
    if (!g) return { error: "context-guard is not initialized" };
    const paths: Record<string, string> = {
      "AGENTS.md": "AGENTS.md",
      "PROTOCOL.md": "PROTOCOL.md",
      [g.config.files.goal]: g.config.files.goal,
      [g.config.files.handoff]: g.config.files.handoff,
      [g.config.files.progress]: g.config.files.progress,
      [g.config.files.learnings]: g.config.files.learnings,
      [DEFAULT_CONFIG_NAME]: DEFAULT_CONFIG_NAME,
      "scripts/durable_edit.py": "scripts/durable_edit.py",
      ".agents/skills/pi-handoff/SKILL.md": ".agents/skills/pi-handoff/SKILL.md",
      ".agents/skills/pi-handoff/references/consolidation.md": ".agents/skills/pi-handoff/references/consolidation.md",
      ".agents/skills/pi-handoff/references/documentation-cycle/plan-v1.md": ".agents/skills/pi-handoff/references/documentation-cycle/plan-v1.md",
      ".agents/skills/pi-handoff/references/documentation-cycle/apply-v1.md": ".agents/skills/pi-handoff/references/documentation-cycle/apply-v1.md",
      ".agents/skills/pi-handoff/references/documentation-cycle/review-v1.md": ".agents/skills/pi-handoff/references/documentation-cycle/review-v1.md",
    };
    for (const key of ["planPrompt", "applyPrompt", "reviewPrompt"] as const) {
      const overridePath = g.config.documentation[key];
      if (overridePath) paths[`configured:${key}`] = overridePath;
    }
    const sources: Record<string, string> = {};
    for (const [name, relative] of Object.entries(paths)) {
      const sourcePath = safeProjectPath(relative);
      if (!sourcePath) return { error: `reference path must remain inside project root: ${relative}` };
      const content = fs.readFile(sourcePath);
      if (content === undefined) return { error: `required reference file is unreadable: ${relative}` };
      // Checkpoint stamps are machine metadata, not durable source prose. Ignore them
      // so a readiness refresh cannot stale an otherwise reviewed documentation plan.
      sources[name] = relative === g.config.files.handoff || relative === g.config.files.progress ? stripManagedSection(content) : content;
    }
    const goal = fs.readFile(joinPath(g.cwd, g.config.files.goal));
    if (goal === undefined) return { error: `required reference file is unreadable: ${g.config.files.goal}` };
    return { sources, fingerprint: documentationSourceFingerprint(sources, sha256), goalFingerprint: sha256(goal) };
  }

  function safeProjectPath(input: string): string | undefined {
    if (!g || !input.trim()) return undefined;
    const candidate = pathDefault.resolve(g.cwd, input);
    const root = normalizePath(g.cwd);
    if (!isLexicallyInside(candidate, root) || normalizePath(candidate) === root) return undefined;
    const realRoot = fs.realpath?.(g.cwd) ?? root;
    const realCandidate = fs.realpath?.(candidate) ?? normalizePath(candidate);
    if (!isLexicallyInside(realCandidate, realRoot) || normalizePath(realCandidate) === normalizePath(realRoot)) return undefined;
    return candidate;
  }

  function safeCycleStatePath(input: string): string | undefined {
    if (!g) return undefined;
    const candidate = normalizePath(input);
    const root = normalizePath(resolvedStateDir(g));
    if (!isLexicallyInside(candidate, root) || candidate === root) return undefined;
    const realRoot = fs.realpath?.(root) ?? root;
    const realCandidate = fs.realpath?.(candidate) ?? candidate;
    if (!isLexicallyInside(realCandidate, realRoot) || normalizePath(realCandidate) === normalizePath(realRoot)) return undefined;
    return candidate;
  }

  function cycleArtifactPath(cycleId: string, name: string): string {
    return joinPath(joinPath(resolvedStateDir(g!), `documentation-cycle/${cycleId}`), name);
  }

  function cycleStatusText(): string {
    if (!g) return "context-guard cycle: not initialized";
    if (!g.config.documentation.enabled) return "context-guard cycle: disabled (set documentation.enabled=true to use the operator-started workflow)";
    const loaded = loadCycleState();
    const lockPath = joinPath(resolvedStateDir(g), "documentation-cycle/transition.lock");
    const lockRaw = fs.readFile(lockPath);
    if (lockRaw !== undefined) {
      let command = "unknown";
      try { command = String((JSON.parse(lockRaw) as Record<string, unknown>).command ?? "unknown"); } catch { /* preserve corrupt lock for explicit repair */ }
      const token = sha256(lockRaw);
      return `context-guard cycle: a prior transition lock remains (${command}, recovery token ${token}). This usually means a process stopped mid-operation. No stage will be replayed; inspect sessions/artifacts, then run /handoff cycle recover ${token} explicitly.`;
    }
    if (loaded.corrupt) return "context-guard cycle: state CORRUPT; no automatic repair or session dispatch was performed. Preserve the file and repair it explicitly.";
    const state = loaded.state;
    if (!state) return "context-guard cycle: idle; the development renewal chain and durable documents are unchanged.";
    const revision = gitHeadRevision();
    const snapshot = cycleSourceSnapshot();
    const refsCurrent = revision === state.baseRevision && !("error" in snapshot) && snapshot.fingerprint === state.baseFingerprint;
    const planArtifact = readCycleArtifact(state.planFile, "plan");
    const planHash = planArtifact.hash;
    const reportArtifact = readCycleArtifact(state.reviewFile, "review");
    const reportHash = reportArtifact.hash;
    const details = [
      `context-guard cycle ${state.cycleId}: ${state.phase}${state.noChange ? " (NO CHANGE)" : ""}`,
      `  base revision ${state.baseRevision}; source references ${refsCurrent ? "current" : "CHANGED / unavailable"}`,
      `  plan ${planHash ? `${state.planFile} sha256=${planHash}` : `${state.planFile} (${planArtifact.error ?? "not written yet"})`}${state.planHash ? `; approved sha256=${state.planHash}` : ""}`,
      `  review ${reportHash ? `${state.reviewFile} sha256=${reportHash}` : `${state.reviewFile} (${reportArtifact.error ?? "not written yet"})`}${state.reviewHash ? `; accepted sha256=${state.reviewHash}` : ""}`,
      state.phase === "planning" || state.phase === "applying" || state.phase === "reviewing"
        ? "  stage outcome may be pending after a crash; it will not be dispatched again automatically. Inspect the session/artifact, then continue the stage or explicitly abort."
        : "  documentation state is separate from renewal counters; no chain transition has occurred.",
      "  scientific claims are not independently validated by this status.",
    ];
    if ("error" in snapshot) details.splice(1, 0, `  source inspection error: ${snapshot.error}`);
    return details.join("\n");
  }

  /** Read-only audit mode forbids every write inside the project tree. */
  function canWriteProjectTree(): boolean {
    return g ? !g.config.readOnly && hasInstanceOwnership() : false;
  }

  function hasInstanceOwnership(): boolean {
    if (!g) return false;
    const id = g.config.missionInstance.id;
    return id === null || (!!g.missionInstanceLockPath && ownsInstanceLock(fs, g.missionInstanceLockPath));
  }

  function ownershipRefusal(): string | undefined {
    if (!g || g.config.missionInstance.id === null || hasInstanceOwnership()) return undefined;
    return `mission instance ${g.config.missionInstance.id} is not owned by this Pi process${g.missionInstanceLockError ? ` (${g.missionInstanceLockError})` : " (the owner lock is missing, corrupt, or has changed)"}`;
  }

  /** Runtime state may persist in read-only mode ONLY outside the audited tree. */
  function canPersistState(): boolean {
    if (!g) return false;
    if (!hasInstanceOwnership()) return false;
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
        `  renewal: policy enabled=${r.enabled} autoRenew=${r.autoRenew} maxRenewals=${r.maxRenewals}; chain ${chain.state.chainId || "(none)"} done=${chain.state.renewalsDone}/${r.maxRenewals}${chain.state.renewedFromCheckpointId ? ` lastFrom=${chain.state.renewedFromCheckpointId}` : ""}; stop in-memory=${renewalRuntime.operatorStop} durable=${chain.state.stopped}${renewalRuntime.pending || renewalRuntime.running || renewalRuntime.toolScheduled ? `; PENDING (${renewalRuntime.pending?.trigger ?? (renewalRuntime.toolScheduled ? "model request scheduled" : "renewal running")})` : ""}${chain.corrupt ? "; chain state CORRUPT (treated as initial)" : ""}`,
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
      g?.missionInstanceError
        ? `mission instance: selection refused (${g.missionInstanceError})`
        : g?.config.missionInstance.id
          ? `mission instance: ${g.config.missionInstance.id}; ownership ${hasInstanceOwnership() ? "held by this Pi process" : "NOT HELD"}${g.config.missionInstance.workProfile ? `; work profile ${workProfilePath(g.config.missionInstance.workProfile)}` : ""}; read this instance's operational files`
          : "mission instance: legacy project mode",
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

  function isSelectedInstanceTarget(target: string): boolean {
    if (!g || g.config.missionInstance.id === null) return false;
    const candidate = normalizePath(target.startsWith("/") ? target : joinPath(g.cwd, target));
    const candidateReal = fs.realpath?.(candidate) ?? candidate;
    const instanceRoot = normalizePath(joinPath(g.cwd, `.pi-handoff/instances/${g.config.missionInstance.id}`));
    const instanceReal = fs.realpath?.(instanceRoot) ?? instanceRoot;
    const stateRoot = normalizePath(resolvedStateDir(g));
    const stateReal = fs.realpath?.(stateRoot) ?? stateRoot;
    return isLexicallyInside(candidate, instanceRoot) || isLexicallyInside(candidateReal, instanceReal) ||
      isLexicallyInside(candidate, stateRoot) || isLexicallyInside(candidateReal, stateReal);
  }

  function checkpoint(ctx: ExtensionContext, reason: string, notes?: string, opts: { dryRun?: boolean; kind?: "auto" | "manual" } = {}): CheckpointResult | undefined {
    if (!g) return undefined;
    if (!opts.dryRun) {
      const refused = ownershipRefusal();
      if (refused) { notify(ctx, `context-guard: checkpoint refused — ${refused}`, "warning"); return undefined; }
    }
    // Reuse a fully current identity when this request adds no Guard notes.
    // A new identity is needed only after source changes, for substantive new
    // notes, or when the recorded successor is continuing from a consumed id.
    // A predecessor cannot mint a replacement id after dispatch.
    if (!opts.dryRun && !notes?.trim()) {
      const current = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      if (current.kind === "current") {
        const chain = loadRenewalState(fs, resolvedStateDir(g)).state;
        const consumed = chain.renewedFromCheckpointId === current.identity?.id;
        const recordedSuccessor = consumed && chain.lastSuccessorSessionId === g.sessionId;
        if (!recordedSuccessor && current.identity) {
          return {
            ok: true,
            written: [],
            errors: [],
            validations: validateAll(fs, g.cwd, g.config.files),
            fingerprint: current.fingerprint,
            dryRun: false,
            identity: { ...current.identity, schema: CHECKPOINT_SCHEMA },
            contentDelta: current.contentDelta === "unknown" ? "none" : current.contentDelta,
            readiness: current.readiness,
          };
        }
      }
    }
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
        sessionId: g.config.missionInstance.id ? `mission:${g.config.missionInstance.id}:${g.sessionId}` : g.sessionId,
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

  /** A consumed checkpoint may be renewed again only by its recorded successor. */
  function prepareSuccessorCheckpoint(
    ctx: ExtensionContext,
    fresh: CheckpointFreshness,
    chain: RenewalState,
    notes?: string,
  ): { freshness: CheckpointFreshness; error?: string } {
    const checkpointId = fresh.kind === "current" ? fresh.identity?.id : undefined;
    if (!checkpointId || chain.renewedFromCheckpointId !== checkpointId) return { freshness: fresh };
    if (chain.lastSuccessorSessionId !== g?.sessionId) {
      return { freshness: fresh, error: `checkpoint ${checkpointId} already seeded its successor; this session is not the recorded successor` };
    }
    const written = checkpoint(ctx, "successor continuation renewal", notes, { kind: "manual" });
    if (!written?.ok) return { freshness: fresh, error: `fresh successor checkpoint failed: ${written?.errors.join("; ") ?? "no result"}` };
    const refreshed = validateCheckpoint(fs, g!.cwd, g!.config.files, DEFAULT_CONFIG_NAME);
    if (refreshed.kind !== "current") return { freshness: refreshed, error: `fresh successor checkpoint is ${refreshed.kind}` };
    return { freshness: refreshed };
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
    // Compute renewal advice against the resulting checkpoint generation. In
    // particular, an L3 auto-checkpoint must replace an earlier consumed-id refusal.
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
        pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running || renewalRuntime.toolScheduled,
        readOnly: g.config.readOnly === true,
      });
      const done = chainNow.state.renewalsDone;
      const max = g.config.renewal.maxRenewals;
      const successorCanPrepare = !preview.renew && preview.why === "already-renewed" && chainNow.state.lastSuccessorSessionId === g.sessionId;
      if (preview.renew) {
        renewalHint =
          `\nRENEWAL AVAILABLE: when your durable files (HANDOFF.md/PROGRESS.md/LEARNINGS.md) carry your current state, call the handoff_renew tool — it refreshes+attests the checkpoint and switches to a FRESH session that recovers from those files only (no transcript replay, no compaction; chain renewals used ${done}/${max}).`;
      } else if (successorCanPrepare) {
        renewalHint = `\nRENEWAL PREPARATION REQUIRED: this recorded successor inherited a checkpoint that already seeded this session. At a safe boundary, call handoff_renew if work remains; it will create and attest a fresh generation (content-delta none if durable prose is unchanged), then recheck stop, cap, read-only, pending and readiness before any switch. Do not finalize unfinished work solely because the inherited checkpoint was consumed.`;
      } else {
        renewalHint = `\nRENEWAL NOT AVAILABLE (${preview.why}): ${preview.detail} ${renewalSafeInstructions(preview.why, done, max)}`;
      }
    }
    if (alertText) {
      // triggerTurn:false while Pi is streaming => Pi defers the append to the end
      // of the turn. The resulting checkpoint and its gate state are now visible.
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
    persistState();
    setStatus(ctx);
    return transition;
  }

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    // Rebuild all session-bound state; never reuse values from a previous session.
    const cwd = ctx.cwd;
    let sessionId = "anon";
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      /* read-only mocks */
    }
    const rawConfig = readConfig(cwd);
    let config = rawConfig;
    let missionInstanceError: string | undefined;
    let missionInstanceLockError: string | undefined;
    let selectedLockPath: string | undefined;
    try {
      const stable = processSelectionIsStable(cwd, rawConfig.missionInstance.id, overrides.processScope);
      if (!stable.ok) throw new Error(`instance selection changed during this Pi process (was ${stable.previous ?? "legacy"}, now ${rawConfig.missionInstance.id ?? "legacy"}); restart Pi to select another instance`);
      if (rawConfig.missionInstance.id !== null) {
        const instanceId = rawConfig.missionInstance.id;
        const identity = readMissionInstanceProfile(fs, cwd, instanceId);
        if (identity.error) throw new Error(identity.error);
        if (!validWorkProfileRef(rawConfig.missionInstance.workProfile)) throw new Error("invalid work profile reference");
        if (rawConfig.missionInstance.workProfile && JSON.stringify(rawConfig.missionInstance.workProfile) !== JSON.stringify(identity.profile)) throw new Error("selected work profile does not match the instance manifest");
        config = configForMissionInstance({ ...rawConfig, missionInstance: { ...rawConfig.missionInstance, workProfile: identity.profile } });
        selectedLockPath = instanceLockPath(cwd, instanceId);
        if (!rawConfig.readOnly) {
          const acquired = acquireInstanceLock(fs, selectedLockPath, sessionId);
          if (!acquired.ok) {
            missionInstanceLockError = acquired.detail + (acquired.inspection.owner ? `; owner pid ${acquired.inspection.owner.pid} on ${acquired.inspection.owner.hostname}, session ${acquired.inspection.owner.sessionId}` : `; lock state: ${acquired.inspection.state}`);
            config = { ...config, readOnly: true };
          }
        } else {
          missionInstanceLockError = "read-only audit session does not acquire or release mission ownership";
        }
      }
    } catch (err) {
      missionInstanceError = err instanceof Error ? err.message : String(err);
      // Invalid identity must never silently fall back to shared legacy documents.
      config = {
        ...rawConfig,
        readOnly: true,
        stateDir: ".pi-guard/invalid-instance-selection",
        files: {
          ...rawConfig.files,
          handoff: ".pi-handoff/invalid-instance-selection/HANDOFF.md",
          progress: ".pi-handoff/invalid-instance-selection/PROGRESS.md",
          learnings: ".pi-handoff/invalid-instance-selection/LEARNINGS.md",
        },
      };
      selectedLockPath = undefined;
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
      missionInstanceError,
      missionInstanceLockPath: selectedLockPath,
      missionInstanceLockError,
      readOnlyRequested: rawConfig.readOnly,
    };
    if (missionInstanceError) notify(ctx, `context-guard: mission instance selection refused (${missionInstanceError}); project-tree writes and renewal are disabled.`, "error");
    if (missionInstanceLockError) notify(ctx, `context-guard: mission instance has no write ownership (${missionInstanceLockError}); checkpoint, attestation, renewal, document-cycle mutations, and writes to its operational files are refused.`, "warning");
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
    renewalRuntime.toolScheduled = false; // an undelivered bridge cannot survive a session boundary
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
    if (g.config.missionInstance.id !== null && !hasInstanceOwnership()) {
      const input = event.input as { path?: string; file_path?: string } | undefined;
      const target = input?.path ?? input?.file_path;
      const managedMutation = event.toolName === "bash" || (!!target && isSelectedInstanceTarget(target));
      if (managedMutation) {
        recordDiag("tool_block", { tool: event.toolName, kind: "instance-ownership" });
        return {
          block: true,
          reason: ownershipRefusal() ?? "context-guard: this Pi process no longer holds its mission-instance ownership; stop writes and restart after safe ownership recovery.",
        };
      }
    }
    // Enforced closing phase: gate NEW tool calls before execution.
    // This never interrupts an in-flight call (turn boundary already passed).
    // `handoff_finalize` is checkpoint machinery (managed-block writes only, never a
    // session switch, never chain-state writes — D2): allowed during closing even if
    // the project's closingAllowlist does not name it. `handoff_renew` stays
    // allowlist-gated because it DOES schedule a switch.
    if (g.machine.currentLevel >= 4 && g.config.enforceClosing) {
      if (!g.config.closingAllowlist.includes(event.toolName) && event.toolName !== "handoff_finalize" && event.toolName !== "handoff_inspect") {
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

  // A session can shut down as part of a renewal while the Pi process continues.
  // Keep the module-scoped owner lock through that boundary; process exit releases it.
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
  function inspectReport(includeDetails = false): { text: string; details: Record<string, unknown> } {
    if (!g) return { text: "context-guard: not initialized", details: { initialized: false } };
    const f = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
    const checkpointId = f.kind === "current" || f.kind === "stale" ? f.identity?.id ?? null : null;
    const readiness = "readiness" in f ? f.readiness : undefined;
    const auth = renewAuthorization(f);
    const readinessEval = evaluateHandoffReadiness(fs, g.cwd, g.config.files, {
      configName: DEFAULT_CONFIG_NAME,
      learningsHashAtSessionStart: g.learningsHash,
    });
    const chain = loadRenewalState(fs, resolvedStateDir(g));
    const decision = decideRenewal({
      renewal: g.config.renewal,
      trigger: "model",
      auth,
      checkpointId,
      state: chain.state,
      operatorStop: renewalRuntime.operatorStop || chain.state.stopped,
      pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running || renewalRuntime.toolScheduled,
      readOnly: g.config.readOnly,
    });
    const successorCanPrepare = f.kind === "current" && chain.state.renewedFromCheckpointId === checkpointId && chain.state.lastSuccessorSessionId === g.sessionId;
    const renewalState = decision.renew ? "ready-now" : decision.why === "not-authorized" || (decision.why === "already-renewed" && successorCanPrepare) ? "preparation-required" : "refused";
    const nextAction = readinessEval.checks.find((c) => c.id === "next-action-recorded");
    const report = {
      checkpoint: f.kind,
      id: checkpointId,
      generation: "identity" in f ? f.identity?.generation ?? null : null,
      attestation: readiness?.state ?? "unknown",
      changedSources: f.kind === "stale" ? f.changed : [],
      nextAction: { status: nextAction?.status ?? "unknown", detail: nextAction?.detail ?? "not evaluated" },
      renewal: {
        state: renewalState,
        reason: decision.why,
        detail: decision.detail,
        chainId: chain.state.chainId || null,
        renewalsDone: chain.state.renewalsDone,
        maxRenewals: g.config.renewal.maxRenewals,
        stopped: chain.state.stopped || renewalRuntime.operatorStop,
        checkpointAuthorization: auth.authorized,
        chainCorrupt: chain.corrupt,
      },
      documentOwnership: {
        manualProse: [g.config.files.handoff, g.config.files.progress],
        managedCheckpointBlocks: [g.config.files.handoff, g.config.files.progress],
        gitWorkingTree: "not-inspected",
      },
      science: "Mission/scientific claims have NOT been independently verified by this inspection.",
    };
    const detailsText = [
      `context-guard verify: checkpoint ${f.kind}${"detail" in f ? `: ${f.detail}` : ""}` +
        ("checkpointed" in f && f.checkpointed ? ` (written ${f.checkpointed}${f.session ? `, session ${f.session}` : ""})` : ""),
      `  identity: ${checkpointId ?? "none"}${f.kind === "current" ? `; content-delta ${f.contentDelta}` : ""}`,
      `  readiness: ${readiness ? `${readiness.state} — ${readiness.detail}` : "unknown (checkpoint is not current)"}`,
      `  next action: ${report.nextAction.status} — ${report.nextAction.detail}`,
      `  renewal authorization (gate for /handoff renew): ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}`,
      `  renewal: ${renewalState} (${decision.why}) — ${decision.detail}; chain ${chain.state.chainId || "(none)"} ${chain.state.renewalsDone}/${g.config.renewal.maxRenewals}`,
      `  changed sources: ${report.changedSources.length ? report.changedSources.join(", ") : "none"}`,
      `  document ownership: manual prose and Handoff-managed blocks are distinct in HANDOFF/PROGRESS; Git working-tree state is not inspected here (use git status/diff).`,
      `  ${recoveryCostLine(recoveryCost(fs, g.cwd, g.config.files), g.config.recovery)}`,
      "  manual prose in HANDOFF.md/PROGRESS.md always takes precedence over these blocks.",
      `  science: ${report.science}`,
    ];
    const healthy = f.kind === "current" && auth.authorized && renewalState === "ready-now" && nextAction?.status === "pass";
    const summary = `checkpoint ${f.kind}${checkpointId ? ` ${checkpointId}` : ""}; ${readiness?.state ?? "unattested"}; renewal ${renewalState}${renewalState === "ready-now" ? ` (${chain.state.renewalsDone}/${g.config.renewal.maxRenewals})` : ` (${decision.why})`}. Mission/scientific claims are not independently verified; Git working-tree state was not inspected.`;
    return { text: includeDetails || !healthy ? detailsText.join("\n") : summary, details: report };
  }

  function verifyReport(): string {
    return inspectReport(true).text;
  }

  let documentationCycleRunning = false;

  function cycleGateError(): string | undefined {
    if (!g) return "context-guard is not initialized";
    if (!g.config.documentation.enabled) return "documentation.enabled is false; set it to true to enable this optional workflow";
    if (g.config.readOnly || !canWriteProjectTree()) return "read-only audit mode refuses documentation-cycle transitions";
    if (!canPersistState()) return "documentation-cycle state cannot be persisted safely";
    return undefined;
  }

  function cycleCurrentReference(): { revision: string; fingerprint: string; goalFingerprint: string } | { error: string } {
    const revision = gitHeadRevision();
    if (!revision) return { error: "cannot determine Git HEAD; documentation cycle requires a readable base revision" };
    const snapshot = cycleSourceSnapshot();
    if ("error" in snapshot) return snapshot;
    return { revision, fingerprint: snapshot.fingerprint, goalFingerprint: snapshot.goalFingerprint };
  }

  function cyclePrompt(stage: "plan" | "apply" | "review", state: DocumentationCycleState, extra: Record<string, string> = {}): { prompt?: string; error?: string } {
    if (!g) return { error: "context-guard is not initialized" };
    const configured = g.config.documentation[`${stage}Prompt` as "planPrompt" | "applyPrompt" | "reviewPrompt"];
    const defaults = {
      plan: ".agents/skills/pi-handoff/references/documentation-cycle/plan-v1.md",
      apply: ".agents/skills/pi-handoff/references/documentation-cycle/apply-v1.md",
      review: ".agents/skills/pi-handoff/references/documentation-cycle/review-v1.md",
    };
    const relative = configured ?? defaults[stage];
    const path = safeProjectPath(relative);
    if (!path) return { error: `documentation ${stage} prompt path must remain inside the project: ${relative}` };
    const raw = fs.readFile(path);
    if (raw === undefined) return { error: `documentation ${stage} prompt is unreadable: ${relative}` };
    if (Buffer.byteLength(raw, "utf8") > 32 * 1024) return { error: `documentation ${stage} prompt exceeds the 32 KiB limit` };
    const vars: Record<string, string> = {
      CYCLE_ID: state.cycleId,
      BASE_REVISION: state.baseRevision,
      BASE_FINGERPRINT: state.baseFingerprint,
      GOAL_FINGERPRINT: state.goalFingerprint,
      PLAN_FILE: state.planFile,
      REVIEW_FILE: state.reviewFile,
      ARCHIVE_DIR: g.config.documentation.archiveDir,
      PLAN_SHA256: state.planHash ?? "(not approved)",
      REVIEW_REVISION: state.reviewRevision ?? "(not captured)",
      REVIEW_FINGERPRINT: state.reviewFingerprint ?? "(not captured)",
      ...extra,
    };
    let prompt = raw;
    for (const [key, value] of Object.entries(vars)) prompt = prompt.replaceAll(`{{${key}}}`, value);
    const wrapper = [
      `Handoff documentation cycle ${state.cycleId}; stage ${stage}.`,
      "This continuation was generated by the Handoff extension after an explicit operator command; it is not a human-authored message and grants no authority beyond the stage described below.",
      "Use the durable project files as authority. Do not replay or summarize the prior transcript, compact context, edit GOAL.md, publish, push, or alter renewal-chain state.",
      "",
      prompt,
    ].join("\n");
    if (Buffer.byteLength(wrapper, "utf8") > MAX_OPERATOR_TASK_BYTES) return { error: "documentation mission prompt exceeds the 64 KiB dispatch limit" };
    return { prompt: wrapper };
  }

  async function dispatchDocumentationStage(
    ctx: ExtensionCommandContext,
    previous: DocumentationCycleState | undefined,
    next: DocumentationCycleState,
    prompt: string,
    stage: "plan" | "apply" | "review",
  ): Promise<void> {
    if (documentationCycleRunning) {
      notify(ctx, "context-guard cycle: another documentation transition is already running", "warning");
      return;
    }
    documentationCycleRunning = true;
    const saved = saveCycleState(next);
    if (!saved.ok) {
      documentationCycleRunning = false;
      notify(ctx, `context-guard cycle: could not persist the ${stage} stage before session dispatch: ${saved.error}`, "error");
      return;
    }
    try {
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (nctx: ReplacedSessionContext) => {
          notify(nctx, `context-guard cycle: ${stage} mission started for ${next.cycleId}; it does not consume renewal quota`, "info");
          try {
            await nctx.sendMessage(
              {
                customType: `${CUSTOM_TYPE}-documentation-cycle`,
                content: prompt,
                display: true,
                details: { origin: "context-guard-extension", generated: true, operatorInvoked: true, purpose: "documentation-cycle", cycleId: next.cycleId, stage },
              },
              { triggerTurn: true },
            );
          } catch (err) {
            notify(nctx, `context-guard cycle: ${stage} mission turn failed to start; it will not be dispatched a second time automatically (${err instanceof Error ? err.message : String(err)})`, "error");
          }
        },
      });
      if (result.cancelled) {
        const cancelled: DocumentationCycleState = previous
          ? { ...previous, updatedAt: Date.now() }
          : { ...next, phase: "abandoned", updatedAt: Date.now() };
        const rollback = saveCycleState(cancelled);
        notify(ctx, rollback.ok
          ? `context-guard cycle: ${stage} session was cancelled; no mission turn was sent and the prior phase was restored.`
          : `context-guard cycle: session was cancelled, but state rollback failed (${rollback.error}); inspect cycle status before retrying.`, "warning");
      }
      // On success, the persisted stage blocks replay after a crash or repeated command.
    } catch (err) {
      // A throw may happen after Pi created the replacement session. Keep the durable
      // stage marker and require explicit operator recovery; never risk a duplicate.
      notify(ctx, `context-guard cycle: ${stage} dispatch outcome is uncertain; the stage is held and will not be retried automatically (${err instanceof Error ? err.message : String(err)}). Inspect the artifact/session, then explicitly abort or continue.`, "error");
    } finally {
      documentationCycleRunning = false;
    }
  }

  function readCycleArtifact(file: string, label: string): { content?: string; hash?: string; error?: string } {
    const safe = safeCycleStatePath(file);
    if (!safe) return { error: `${label} artifact escapes the configured state directory` };
    const content = fs.readFile(safe);
    if (content === undefined) return { error: `${label} artifact is missing or unreadable: ${file}` };
    if (Buffer.byteLength(content, "utf8") > 128 * 1024) return { error: `${label} artifact exceeds the 128 KiB limit` };
    return { content, hash: sha256(content) };
  }

  function cycleStatusNotify(ctx: ExtensionContext): void {
    notify(ctx, cycleStatusText(), "info");
  }

  async function runDocumentationCycle(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const command = args[0] ?? "status";
    if (command === "status") { cycleStatusNotify(ctx); return; }
    const gate = cycleGateError();
    if (gate) { notify(ctx, `context-guard cycle: refused (${gate})`, "warning"); return; }
    const loaded = loadCycleState();
    if (loaded.corrupt) { notify(ctx, "context-guard cycle: state is corrupt; preserve it and repair it explicitly before any session or chain transition", "error"); return; }
    const current = loaded.state;
    const now = Date.now();
    const phaseError = (expected: string) => notify(ctx, `context-guard cycle: command ${command} requires ${expected}; current phase is ${current?.phase ?? "idle"}`, "warning");

    if (command === "plan") {
      if (current && !["complete", "no-change", "abandoned"].includes(current.phase)) { phaseError("an idle or completed workflow"); return; }
      const cp = validateCheckpoint(fs, g!.cwd, g!.config.files, DEFAULT_CONFIG_NAME);
      const auth = renewAuthorization(cp);
      if (!auth.authorized) { notify(ctx, `context-guard cycle: planning requires a current, attested checkpoint (${auth.reason})`, "warning"); return; }
      const chain = loadRenewalState(fs, resolvedStateDir(g!));
      if (chain.corrupt) { notify(ctx, "context-guard cycle: renewal state is corrupt; no documentation session was started", "error"); return; }
      if (chain.state.stopped) { notify(ctx, "context-guard cycle: the development chain is durably stopped; operator must resume it explicitly before planning a new campaign", "warning"); return; }
      if (chain.state.renewalsDone < g!.config.renewal.maxRenewals) {
        notify(ctx, `context-guard cycle: campaign chain is not at its configured boundary (${chain.state.renewalsDone}/${g!.config.renewal.maxRenewals}); no documentation mission was started`, "warning");
        return;
      }
      const ref = cycleCurrentReference();
      if ("error" in ref) { notify(ctx, `context-guard cycle: planning refused: ${ref.error}`, "error"); return; }
      if (current) {
        const historyPath = joinPath(resolvedStateDir(g!), `documentation-cycle/history/${current.cycleId}.json`);
        const history = serializeDocumentationCycleState(current);
        const existingHistory = fs.readFile(historyPath);
        if (existingHistory !== undefined && existingHistory !== history) { notify(ctx, `context-guard cycle: previous cycle history conflicts at ${historyPath}; preserve it and repair explicitly`, "error"); return; }
        if (existingHistory === undefined) {
          try { fs.writeFile(historyPath, history); }
          catch (err) { notify(ctx, `context-guard cycle: previous cycle state could not be preserved before a new plan (${err instanceof Error ? err.message : String(err)})`, "error"); return; }
        }
      }
      const cycleId = documentationCycleId(ref.revision, ref.fingerprint, g!.sessionId, now, sha256);
      const dir = joinPath(resolvedStateDir(g!), `documentation-cycle/${cycleId}`);
      const state: DocumentationCycleState = {
        version: 1, cycleId, phase: "planning", baseRevision: ref.revision, baseFingerprint: ref.fingerprint,
        goalFingerprint: ref.goalFingerprint,
        planFile: joinPath(dir, "plan.md"), reviewFile: joinPath(dir, "review.md"),
        createdAt: now, updatedAt: now, stageStartedBy: g!.sessionId,
      };
      const mission = cyclePrompt("plan", state);
      if (mission.error) { notify(ctx, `context-guard cycle: ${mission.error}`, "error"); return; }
      await dispatchDocumentationStage(ctx, current, state, mission.prompt!, "plan");
      return;
    }

    if (!current) { phaseError("a started documentation cycle"); return; }
    const ref = cycleCurrentReference();
    const staleBase = (phase = current.phase) => {
      if ("error" in ref) return ref.error;
      if (ref.revision !== current.baseRevision || ref.fingerprint !== current.baseFingerprint) return `reference changed since planning (base ${current.baseRevision}, current ${ref.revision}); abandon and plan again`;
      return undefined;
    };

    if (command === "approve" || command === "no-change") {
      if (current.phase !== "planning") { phaseError("planning with an unapproved plan"); return; }
      const stale = staleBase();
      if (stale) { notify(ctx, `context-guard cycle: approval refused: ${stale}`, "warning"); return; }
      const artifact = readCycleArtifact(current.planFile, "plan");
      if (artifact.error) { notify(ctx, `context-guard cycle: ${artifact.error}`, "warning"); return; }
      const suppliedHash = args[1]?.toLowerCase();
      if (!suppliedHash || !/^[0-9a-f]{64}$/.test(suppliedHash) || suppliedHash !== artifact.hash) {
        notify(ctx, `context-guard cycle: approval requires the current plan SHA-256 shown by status (${artifact.hash}); plan content is not approved`, "warning"); return;
      }
      const meta = cycleMetadata(artifact.content!);
      if (meta["Cycle-ID"] !== current.cycleId || meta["Base-Revision"] !== current.baseRevision || meta["Base-Fingerprint"] !== current.baseFingerprint) {
        notify(ctx, "context-guard cycle: plan metadata does not match this cycle's base identity/fingerprints", "error"); return;
      }
      if (/\bGOAL\.md\b/i.test(meta["Target-Files"] ?? "")) {
        notify(ctx, "context-guard cycle: plan targets protected GOAL.md; approval is refused", "error"); return;
      }
      if (command === "no-change") {
        if (meta.Result !== "NO_CHANGE" || meta["Target-Files"]?.toLowerCase() !== "none") { notify(ctx, "context-guard cycle: no-change requires `Result: NO_CHANGE` and `Target-Files: none`", "warning"); return; }
        const next = { ...current, phase: "no-change" as const, noChange: true, planHash: artifact.hash!, updatedAt: now };
        const saved = saveCycleState(next);
        notify(ctx, saved.ok ? `context-guard cycle ${current.cycleId}: NO CHANGE recorded from plan ${artifact.hash}; no edits, review mission, or renewal reset occurred.` : `context-guard cycle: state write failed: ${saved.error}`, saved.ok ? "info" : "error");
        return;
      }
      if (meta.Result !== "CHANGE" || !meta["Target-Files"] || meta["Target-Files"].toLowerCase() === "none") { notify(ctx, "context-guard cycle: approval requires `Result: CHANGE` and a non-empty Target-Files list; use `no-change` for an audited NO_CHANGE plan", "warning"); return; }
      const next = { ...current, phase: "approved" as const, planHash: artifact.hash!, updatedAt: now };
      const saved = saveCycleState(next);
      notify(ctx, saved.ok ? `context-guard cycle ${current.cycleId}: exact plan approved (sha256 ${artifact.hash}); no files were edited. Run /handoff cycle apply explicitly.` : `context-guard cycle: approval state write failed: ${saved.error}`, saved.ok ? "info" : "error");
      return;
    }

    if (command === "apply") {
      if (current.phase !== "approved") { phaseError("operator-approved"); return; }
      const stale = staleBase();
      if (stale) { notify(ctx, `context-guard cycle: apply refused: ${stale}`, "warning"); return; }
      const plan = readCycleArtifact(current.planFile, "approved plan");
      if (plan.error || plan.hash !== current.planHash) { notify(ctx, `context-guard cycle: approved plan changed; re-approval required (${plan.error ?? `current sha256 ${plan.hash}`})`, "warning"); return; }
      const mission = cyclePrompt("apply", current);
      if (mission.error) { notify(ctx, `context-guard cycle: ${mission.error}`, "error"); return; }
      const next = { ...current, phase: "applying" as const, updatedAt: now, stageStartedBy: g!.sessionId };
      await dispatchDocumentationStage(ctx, current, next, mission.prompt!, "apply");
      return;
    }

    if (command === "review") {
      if (!["applying", "needs-correction", "verified", "reviewing"].includes(current.phase)) { phaseError("an applied document set or a review that needs correction"); return; }
      if ("error" in ref) { notify(ctx, `context-guard cycle: review refused: ${ref.error}`, "error"); return; }
      if (ref.goalFingerprint !== current.goalFingerprint) { notify(ctx, "context-guard cycle: GOAL.md changed; review and continuation are blocked. Handle goal pivots as a separate operator-authorized procedure.", "error"); return; }
      const plan = readCycleArtifact(current.planFile, "approved plan");
      if (plan.error || plan.hash !== current.planHash) { notify(ctx, `context-guard cycle: approved plan changed; review refused (${plan.error ?? "hash mismatch"})`, "error"); return; }
      if (current.phase === "reviewing" && ref.fingerprint === current.reviewFingerprint && ref.revision === current.reviewRevision) {
        notify(ctx, `context-guard cycle: review stage for ${current.cycleId} is already pending; it will not start a duplicate session. Inspect status/artifact or explicitly abort.`, "warning"); return;
      }
      const previous = current.phase === "reviewing" ? { ...current, phase: "needs-correction" as const } : current;
      const next: DocumentationCycleState = {
        ...current, phase: "reviewing", reviewRevision: ref.revision, reviewFingerprint: ref.fingerprint,
        reviewHash: undefined, updatedAt: now, stageStartedBy: g!.sessionId,
      };
      const mission = cyclePrompt("review", next);
      if (mission.error) { notify(ctx, `context-guard cycle: ${mission.error}`, "error"); return; }
      await dispatchDocumentationStage(ctx, previous, next, mission.prompt!, "review");
      return;
    }

    if (command === "accept-review") {
      if (current.phase !== "reviewing") { phaseError("reviewing"); return; }
      if ("error" in ref || ref.revision !== current.reviewRevision || ref.fingerprint !== current.reviewFingerprint) {
        notify(ctx, `context-guard cycle: review acceptance refused; documents or Git HEAD changed after the independent review started. Run review again.`, "warning"); return;
      }
      if (ref.goalFingerprint !== current.goalFingerprint) { notify(ctx, "context-guard cycle: GOAL.md changed; acceptance refused; handle goal pivots separately", "error"); return; }
      const artifact = readCycleArtifact(current.reviewFile, "review");
      if (artifact.error) { notify(ctx, `context-guard cycle: ${artifact.error}`, "warning"); return; }
      const suppliedHash = args[1]?.toLowerCase();
      if (!suppliedHash || suppliedHash !== artifact.hash || !/^[0-9a-f]{64}$/.test(suppliedHash)) {
        notify(ctx, `context-guard cycle: review acceptance requires its exact SHA-256 (${artifact.hash})`, "warning"); return;
      }
      const meta = cycleMetadata(artifact.content!);
      if (meta["Cycle-ID"] !== current.cycleId || meta["Review-Revision"] !== current.reviewRevision || meta["Review-Fingerprint"] !== current.reviewFingerprint) {
        notify(ctx, "context-guard cycle: review metadata does not match its independent review snapshot", "error"); return;
      }
      if (meta["Review-Result"] === "NEEDS_CORRECTION") {
        const next = { ...current, phase: "needs-correction" as const, reviewHash: artifact.hash!, updatedAt: now };
        const saved = saveCycleState(next);
        notify(ctx, saved.ok ? `context-guard cycle ${current.cycleId}: review requests corrections; no next campaign is authorized. Correct manually, then run review again.` : `context-guard cycle: state write failed: ${saved.error}`, saved.ok ? "warning" : "error");
        return;
      }
      if (meta["Review-Result"] !== "PASS") { notify(ctx, "context-guard cycle: review report must say `Review-Result: PASS` or `NEEDS_CORRECTION`", "warning"); return; }
      const next: DocumentationCycleState = { ...current, phase: "verified", verifiedRevision: ref.revision, verifiedFingerprint: ref.fingerprint, reviewHash: artifact.hash!, updatedAt: now };
      const saved = saveCycleState(next);
      notify(ctx, saved.ok ? `context-guard cycle ${current.cycleId}: independent review accepted (sha256 ${artifact.hash}); scientific claims remain unverified. Run /handoff finalize, then /handoff cycle continue when ready.` : `context-guard cycle: review state write failed: ${saved.error}`, saved.ok ? "info" : "error");
      return;
    }

    if (command === "continue") {
      if (!["verified", "no-change", "continuing"].includes(current.phase)) { phaseError("verified or NO CHANGE"); return; }
      if ("error" in ref) { notify(ctx, `context-guard cycle: continuation refused: ${ref.error}`, "error"); return; }
      if (ref.goalFingerprint !== current.goalFingerprint) { notify(ctx, "context-guard cycle: GOAL.md changed; continuation refused; use the separate goal-pivot procedure", "error"); return; }
      const expectedFingerprint = current.noChange ? current.baseFingerprint : current.verifiedFingerprint;
      const expectedRevision = current.noChange ? current.baseRevision : current.verifiedRevision;
      if (ref.fingerprint !== expectedFingerprint || ref.revision !== expectedRevision) {
        notify(ctx, "context-guard cycle: documents or Git HEAD changed after review; repeat the independent review before continuing", "warning"); return;
      }
      const acceptedArtifact = readCycleArtifact(current.noChange ? current.planFile : current.reviewFile, current.noChange ? "NO CHANGE plan" : "accepted review");
      if (acceptedArtifact.error || acceptedArtifact.hash !== (current.noChange ? current.planHash : current.reviewHash)) {
        notify(ctx, `context-guard cycle: accepted ${current.noChange ? "plan" : "review"} changed since approval; continuation refused (${acceptedArtifact.error ?? `current sha256 ${acceptedArtifact.hash}`})`, "warning"); return;
      }
      const cp = validateCheckpoint(fs, g!.cwd, g!.config.files, DEFAULT_CONFIG_NAME);
      const auth = renewAuthorization(cp);
      if (!auth.authorized) { notify(ctx, `context-guard cycle: current, attested checkpoint required before new campaign (${auth.reason}); finalize explicitly first`, "warning"); return; }
      if (current.phase !== "continuing") {
        const chain = loadRenewalState(fs, resolvedStateDir(g!));
        if (chain.corrupt) { notify(ctx, "context-guard cycle: renewal state is corrupt; it was preserved and no reset occurred", "error"); return; }
        if (chain.state.stopped) { notify(ctx, "context-guard cycle: the development chain is durably stopped; resume it explicitly before approving a new campaign chain", "warning"); return; }
        const renewPath = joinPath(resolvedStateDir(g!), "renewal-state.json");
        if (fs.readFile(renewPath) === undefined) {
          const initialized = saveRenewalState(fs, resolvedStateDir(g!), chain.state);
          if (!initialized.ok) { notify(ctx, `context-guard cycle: could not materialize the old chain before archiving: ${initialized.error}`, "error"); return; }
        }
        const oldRaw = fs.readFile(renewPath);
        if (oldRaw === undefined) { notify(ctx, "context-guard cycle: renewal state could not be read for archival", "error"); return; }
        const archiveRelative = `${g!.config.documentation.archiveDir.replace(/\/$/, "")}/${g!.config.missionInstance.id ? `instances/${g!.config.missionInstance.id}/` : ""}renewal-chain-${current.cycleId}.json`;
        const archivePath = safeProjectPath(archiveRelative);
        if (!archivePath) { notify(ctx, "context-guard cycle: configured archiveDir must resolve inside the project; no chain reset occurred", "error"); return; }
        const nextChainId = missionChainId(g!.config.missionInstance.id, current.cycleId);
        const nextRenewalState: RenewalState = { ...INITIAL_RENEWAL_STATE, chainId: nextChainId, updatedAt: now };
        const archiveContent = JSON.stringify({ version: 1, cycleId: current.cycleId, baseRevision: current.baseRevision, sourceFingerprint: expectedFingerprint, archivedRenewalState: JSON.parse(oldRaw) }, null, 2) + "\n";
        const next: DocumentationCycleState = {
          ...current, phase: "continuing", archivePath, archivedRenewalState: oldRaw, nextChainId,
          nextChainUpdatedAt: now, nextRenewalState: serializeRenewalState(nextRenewalState), updatedAt: now,
        };
        const saved = saveCycleState(next);
        if (!saved.ok) { notify(ctx, `context-guard cycle: could not record the transition journal: ${saved.error}; renewal chain is unchanged`, "error"); return; }
        const existingArchive = fs.readFile(archivePath);
        if (existingArchive !== undefined && existingArchive !== archiveContent) {
          notify(ctx, `context-guard cycle: archive path already contains different data (${archivePath}); it was preserved and renewal state was not reset`, "error"); return;
        }
        if (existingArchive === undefined) {
          try { fs.writeFile(archivePath, archiveContent); }
          catch (err) { notify(ctx, `context-guard cycle: old chain archive write failed; journal is retained for retry and renewal chain is unchanged (${err instanceof Error ? err.message : String(err)})`, "error"); return; }
        }
      }
      const journal = loadCycleState().state;
      if (!journal || journal.cycleId !== current.cycleId || journal.phase !== "continuing" || !journal.nextRenewalState || !journal.archivePath) {
        notify(ctx, "context-guard cycle: continuation journal is missing or corrupt; no automatic repair was attempted", "error"); return;
      }
      const safeArchivePath = safeProjectPath(journal.archivePath);
      if (!safeArchivePath) { notify(ctx, "context-guard cycle: journal archive path is outside the project or symlink-escaped; no chain reset occurred", "error"); return; }
      if (journal.archivedRenewalState === undefined) { notify(ctx, "context-guard cycle: archived renewal source is missing; no reset occurred", "error"); return; }
      const expectedArchive = JSON.stringify({
        version: 1, cycleId: journal.cycleId, baseRevision: journal.baseRevision,
        sourceFingerprint: journal.noChange ? journal.baseFingerprint : journal.verifiedFingerprint,
        archivedRenewalState: JSON.parse(journal.archivedRenewalState),
      }, null, 2) + "\n";
      let archive = fs.readFile(safeArchivePath);
      if (archive === undefined) {
        try { fs.writeFile(safeArchivePath, expectedArchive); archive = expectedArchive; }
        catch (err) { notify(ctx, `context-guard cycle: archive retry failed; journal is preserved and no reset occurred (${err instanceof Error ? err.message : String(err)})`, "error"); return; }
      }
      if (archive !== expectedArchive) { notify(ctx, "context-guard cycle: archive does not match the transition journal; preserve both and repair explicitly", "error"); return; }
      const newChain = JSON.parse(journal.nextRenewalState) as RenewalState;
      const currentRenewalRaw = fs.readFile(joinPath(resolvedStateDir(g!), "renewal-state.json"));
      if (currentRenewalRaw !== journal.nextRenewalState) {
        if (currentRenewalRaw !== journal.archivedRenewalState) {
          notify(ctx, "context-guard cycle: renewal state matches neither the archived old state nor the prepared new chain; preserve both and repair explicitly", "error"); return;
        }
        const finalRef = cycleCurrentReference();
        const finalFingerprint = journal.noChange ? journal.baseFingerprint : journal.verifiedFingerprint;
        const finalRevision = journal.noChange ? journal.baseRevision : journal.verifiedRevision;
        const finalCheckpoint = validateCheckpoint(fs, g!.cwd, g!.config.files, DEFAULT_CONFIG_NAME);
        if ("error" in finalRef || finalRef.fingerprint !== finalFingerprint || finalRef.revision !== finalRevision || finalRef.goalFingerprint !== journal.goalFingerprint || !renewAuthorization(finalCheckpoint).authorized) {
          notify(ctx, "context-guard cycle: documents, Git HEAD, protected GOAL.md or checkpoint changed during archival; old chain is preserved. Re-review/finalize explicitly before retrying.", "error"); return;
        }
        const reset = saveRenewalState(fs, resolvedStateDir(g!), newChain);
        if (!reset.ok) { notify(ctx, `context-guard cycle: old chain is archived but new-chain write failed; rerun continue to resume safely (${reset.error})`, "error"); return; }
      }
      const completed: DocumentationCycleState = { ...journal, phase: "complete", updatedAt: Date.now() };
      const saved = saveCycleState(completed);
      notify(ctx, saved.ok
        ? `context-guard cycle ${current.cycleId}: new development chain ${journal.nextChainId} initialized; old chain preserved at ${journal.archivePath}. No session was started. Scientific validation remains an independent project responsibility.`
        : `context-guard cycle: new chain ${journal.nextChainId} is durable, but cycle completion state could not be saved (${saved.error}); repeat status/continue to reconcile.`, saved.ok ? "info" : "error");
      return;
    }

    if (command === "abort") {
      if (["continuing", "complete"].includes(current.phase)) { notify(ctx, "context-guard cycle: cannot abort an archived/reset transition; preserve the journal and repair explicitly", "error"); return; }
      const saved = saveCycleState({ ...current, phase: "abandoned", updatedAt: now });
      notify(ctx, saved.ok ? `context-guard cycle ${current.cycleId} abandoned; plans, reports and documents were not deleted or rolled back.` : `context-guard cycle: abort state write failed: ${saved.error}`, saved.ok ? "warning" : "error");
      return;
    }

    if (command === "apply" || command === "review") return;
    notify(ctx, "usage: /handoff cycle status | plan | approve <plan-sha256> | apply | no-change <plan-sha256> | review | accept-review <report-sha256> | continue | abort", "warning");
  }

  async function handleDocumentationCycle(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const args = rawArgs.trim().split(/\s+/).filter(Boolean);
    const command = args[0] ?? "status";
    if (command === "status") { cycleStatusNotify(ctx); return; }
    if (command !== "recover") {
      const refused = ownershipRefusal();
      if (refused) { notify(ctx, `context-guard cycle refused — ${refused}`, "warning"); return; }
    }
    if (command === "recover") {
      if (!g || g.config.readOnly || !canPersistState()) { notify(ctx, "context-guard cycle: recovery is unavailable in read-only mode", "warning"); return; }
      if (documentationCycleRunning) { notify(ctx, "context-guard cycle: a transition is active in this process; it cannot be recovered concurrently", "warning"); return; }
      const lockPath = joinPath(resolvedStateDir(g), "documentation-cycle/transition.lock");
      const raw = fs.readFile(lockPath);
      const token = args[1];
      if (raw === undefined) { notify(ctx, "context-guard cycle: no recovery lock exists", "info"); return; }
      if (!token || token !== sha256(raw)) { notify(ctx, `context-guard cycle: recovery requires the exact status token ${sha256(raw)}; no state was changed`, "warning"); return; }
      try { fs.remove(lockPath); notify(ctx, "context-guard cycle: transition lock explicitly cleared. State and artifacts were preserved; inspect status before issuing another stage command.", "warning"); }
      catch (err) { notify(ctx, `context-guard cycle: could not clear recovery lock: ${err instanceof Error ? err.message : String(err)}`, "error"); }
      return;
    }
    const valid = new Set(["plan", "approve", "apply", "no-change", "review", "accept-review", "continue", "abort"]);
    if (!valid.has(command)) { notify(ctx, "usage: /handoff cycle status | plan | approve <plan-sha256> | apply | no-change <plan-sha256> | review | accept-review <report-sha256> | continue | abort | recover <status-token>", "warning"); return; }
    if (documentationCycleRunning) { notify(ctx, "context-guard cycle: another documentation transition is already running", "warning"); return; }
    if (!fs.createExclusive) { notify(ctx, "context-guard cycle: this filesystem cannot create an exclusive transition lock; refusing to risk a duplicate session", "error"); return; }
    const lockPath = joinPath(resolvedStateDir(g!), "documentation-cycle/transition.lock");
    const lockRaw = JSON.stringify({ command, sessionId: g!.sessionId, startedAt: Date.now() });
    let acquired = false;
    try { acquired = fs.createExclusive(lockPath, lockRaw); }
    catch (err) { notify(ctx, `context-guard cycle: transition lock failed: ${err instanceof Error ? err.message : String(err)}`, "error"); return; }
    if (!acquired) { notify(ctx, "context-guard cycle: another or interrupted transition holds the lock; inspect /handoff cycle status, no session was started", "warning"); return; }
    try { await runDocumentationCycle(args.join(" "), ctx); }
    finally {
      try { fs.remove(lockPath); }
      catch (err) { notify(ctx, `context-guard cycle: transition finished but its lock could not be removed (${err instanceof Error ? err.message : String(err)}); recover explicitly from status`, "error"); }
    }
  }

  /** `/handoff ready [check]`: evaluate semantic readiness; bare `ready` also attests. */
  function readyReport(attest: boolean, dry: boolean): { text: string; ok: boolean } {
    if (!g) return { text: "context-guard: not initialized", ok: false };
    if (attest) {
      const refused = ownershipRefusal();
      if (refused) return { text: `context-guard handoff attestation refused — ${refused}`, ok: false };
    }
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
          : att.written.length === 0
            ? `  already attested ${att.checkpointId}; no files changed`
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
    if (!(att.ok && !att.dryRun && att.written.length === 0)) persistState();
    return { text: lines.join("\n"), ok: att.ok };
  }

  pi.registerTool({
    name: "handoff_inspect",
    label: "Inspect handoff",
    description:
      "Read-only inspection of the durable checkpoint and renewal preconditions. Returns checkpoint freshness, identity, attestation, changed sources, next-action validation, chain state, and whether renewal is ready, preparable, or refused. Does not write files or state, checkpoint, attest, consume an identity, renew, or change the chain/operator stop. It does not verify scientific results.",
    promptSnippet: "handoff_inspect — inspect checkpoint and renewal readiness without changing state",
    parameters: { type: "object", properties: { details: { type: "boolean", description: "Include full diagnostic details even when checkpoint and renewal are healthy." } }, additionalProperties: false },
    async execute(_toolCallId: string, args: { details?: boolean }) {
      const report = inspectReport(args?.details === true);
      return { content: [{ type: "text", text: report.text }], details: report.details };
    },
  } as never);

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
      `  policy: enabled=${r.enabled} autoRenew=${r.autoRenew} maxRenewals=${r.maxRenewals} successorTurn=${r.successorTurn}${r.recoveryPrompt ? " recoveryPrompt=custom" : ""}${r.testCommand ? ` testCommand=${JSON.stringify(r.testCommand)}` : " testCommand=(none — successor prompt carries no build-verify line)"}`,
      `  chain: ${chain.state.chainId || "(none yet)"} renewalsDone=${chain.state.renewalsDone}/${r.maxRenewals}${chain.state.renewedFromCheckpointId ? ` lastFrom=${chain.state.renewedFromCheckpointId}` : ""}${chain.state.lastSuccessorSessionId ? ` lastSuccessor=${chain.state.lastSuccessorSessionId}` : ""}`,
      `  operator stop: in-memory=${renewalRuntime.operatorStop} durable=${chain.state.stopped}${chain.corrupt ? "; CHAIN STATE CORRUPT (treated as initial)" : ""}`,
      `  pending switch: ${renewalRuntime.pending ? `${renewalRuntime.pending.trigger} from ${renewalRuntime.pending.fromSessionId} (checkpoint ${renewalRuntime.pending.checkpointId})` : renewalRuntime.running ? "renewal command running" : renewalRuntime.toolScheduled ? "model renewal request scheduled" : "none"}`,
      `  authorization now: ${auth.authorized ? "AUTHORIZED" : "not authorized"} — ${auth.reason}${cpId ? ` (checkpoint ${cpId})` : ""}`,
      `  note: the cap and the idempotence key are DURABLE (renewal-state.json); they survive session replacement and process restart (RN9).`,
    ];
    return lines.join("\n");
  }

  /** Persist the durable operator stop (in-memory flag is always set; durable write best-effort). */  function persistRenewalStop(stop: boolean, ctx: ExtensionContext): void {
    const ownership = ownershipRefusal();
    if (ownership) {
      notify(ctx, `context-guard: renewal stop/resume refused — ${ownership}`, "warning");
      return;
    }
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
    const ownership = ownershipRefusal();
    if (ownership) return { ok: false, text: `context-guard FINALIZE refused — ${ownership}`, checkpointId: null, dry: true };
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

  function validateOperatorTask(task: string): string | undefined {
    if (task.trim().length === 0) return "operator task is empty";
    const size = Buffer.byteLength(task, "utf8");
    if (size > MAX_OPERATOR_TASK_BYTES) return `operator task is ${size} bytes; maximum is ${MAX_OPERATOR_TASK_BYTES} bytes (64 KiB)`;
    return undefined;
  }

  function readOperatorTaskFile(inputPath: string): { task?: string; error?: string } {
    if (!g) return { error: "context-guard is not initialized" };
    const candidate = pathDefault.resolve(g.cwd, inputPath);
    const projectRoot = normalizePath(g.cwd);
    if (!isLexicallyInside(candidate, projectRoot) || normalizePath(candidate) === projectRoot) {
      return { error: "--task-file must name a file inside the project directory" };
    }
    if (!fs.realpath) return { error: "--task-file refused because this filesystem cannot verify symlinks" };
    const realRoot = fs.realpath(g.cwd);
    const realFile = fs.realpath(candidate);
    if (!realRoot || !realFile || !isLexicallyInside(realFile, realRoot) || normalizePath(realFile) === normalizePath(realRoot)) {
      return { error: "--task-file must resolve to a file inside the project directory; symlink escapes are refused" };
    }
    // Read the canonical target after the containment check, not the original path.
    if (!fs.readFileLimited) return { error: "--task-file refused because this filesystem cannot enforce the size limit while reading" };
    const result = fs.readFileLimited(realFile, MAX_OPERATOR_TASK_BYTES);
    if (result === undefined) return { error: "--task-file could not be read (missing file, directory, or permission error)" };
    if (result.tooLarge) return { error: `--task-file exceeds the ${MAX_OPERATOR_TASK_BYTES}-byte (64 KiB UTF-8) limit` };
    const task = result.content;
    const sizeError = validateOperatorTask(task);
    if (sizeError) return { error: sizeError };
    return { task };
  }

  /**
   * The renewal transition (P-6 / A-17 / PROTOCOL §6). Safe boundary first
   * (waitForIdle — never mid tool call), then refresh + attest the checkpoint, gate,
   * persist chain state BEFORE the switch (crash-safe), then newSession with one
   * successor-turn trigger (custom or user-role). After the switch the old ctx is
   * INVALID (A-17.5):
   * only plain data and the successor's own session_start reporting remain.
   */
  async function runRenewal(trigger: RenewalTrigger, ctx: ExtensionCommandContext, notes?: string, operatorTask?: string): Promise<void> {
    if (!g) {
      notify(ctx, "context-guard: not initialized", "error");
      return;
    }
    const ownership = ownershipRefusal();
    if (ownership) {
      notify(ctx, `context-guard: renewal refused — ${ownership}`, "warning");
      return;
    }
    if (renewalRuntime.running || renewalRuntime.pending || (renewalRuntime.toolScheduled && trigger !== "model")) {
      notify(ctx, "context-guard: renewal refused (pending): another renewal is already pending/running in this process", "warning");
      recordDiag("renewal_result", { trigger, ok: false, why: "pending", detail: "another renewal is pending/running in this process" });
      return;
    }
    if (trigger === "model") {
      if (!renewalRuntime.toolScheduled) {
        notify(ctx, "context-guard: renewal refused (pending): no handoff_renew request is scheduled", "warning");
        recordDiag("renewal_result", { trigger, ok: false, why: "pending", detail: "no model tool request is scheduled" });
        return;
      }
      renewalRuntime.toolScheduled = false;
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
      const chainBeforeRefresh = loadRenewalState(fs, resolvedStateDir(g));
      if (fresh.kind === "current") {
        const prepared = prepareSuccessorCheckpoint(ctx, fresh, chainBeforeRefresh.state, notes);
        if (prepared.error) {
          notify(ctx, `context-guard: renewal NOT performed (already-renewed): ${prepared.error}`, "warning");
          recordDiag("renewal_result", { trigger, ok: false, why: "already-renewed", detail: prepared.error.slice(0, 300) });
          return;
        }
        fresh = prepared.freshness;
      }
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
      const chainId = chain.state.chainId || missionChainId(g.config.missionInstance.id, g.sessionId);
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
        operatorTask,
      });
      const fromSessionId = g.sessionId;
      const maxRen = g.config.renewal.maxRenewals;
      const successorTurn = g.config.renewal.successorTurn;
      const res = await ctx.newSession({
        parentSession: parentSessionFile,
        withSession: async (nctx: ReplacedSessionContext) => {
          // From here on the OLD ctx is invalid (A-17.5): report via nctx only.
          notify(nctx, `context-guard: session renewed (${renewalIndex}/${maxRen}) from checkpoint ${checkpointId}; starting successor turn…`, "info");
          recordDiag("renewal_result", { trigger, ok: true, checkpoint: checkpointId, chain: chainId, renewalsDone: renewalIndex, maxRenewals: maxRen });
          try {
            if (successorTurn === "user") {
              // Keep a machine-origin marker with structured metadata. It is explicitly
              // non-triggering; the following user-role message is the sole turn start.
              await nctx.sendMessage(
                {
                  customType: `${CUSTOM_TYPE}-continuation-origin`,
                  content: "Handoff is appending an automated successor continuation message; this marker is extension-generated, not operator-authored.",
                  display: true,
                  details: {
                    origin: "context-guard-extension",
                    generated: true,
                    purpose: "successor-continuation",
                    checkpointId,
                    chainId,
                    renewalIndex,
                    parentSessionId: fromSessionId,
                    operatorTaskPresent: operatorTask !== undefined,
                  },
                },
                { triggerTurn: false },
              );
              const dispatch = nctx.sendUserMessage(buildSuccessorUserMessage(recovery));
              void dispatch.catch((err: unknown) => {
                notify(nctx, `context-guard: recovery turn FAILED to start: ${err instanceof Error ? err.message : String(err)}`, "error");
              });
            } else {
              const dispatch = nctx.sendMessage(
                {
                  customType: `${CUSTOM_TYPE}-recovery`,
                  content: recovery,
                  display: true,
                  details: {
                    origin: "context-guard-extension",
                    generated: true,
                    purpose: "successor-continuation",
                    checkpointId,
                    chainId,
                    renewalIndex,
                    parentSessionId: fromSessionId,
                    operatorTaskPresent: operatorTask !== undefined,
                  },
                },
                { triggerTurn: true },
              );
              void dispatch.catch((err: unknown) => {
                notify(nctx, `context-guard: recovery turn FAILED to start: ${err instanceof Error ? err.message : String(err)}`, "error");
              });
            }
          } catch (err) {
            // Do not dispatch a fallback turn: the session was replaced, and a retry
            // here could create a duplicate first inference or duplicate mission.
            notify(nctx, `context-guard: recovery turn FAILED to start: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
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
      "Request a controlled session renewal. Refreshes and attests the durable checkpoint, then schedules the switch for the end of this turn: the successor starts with FRESH context and recovers ONLY from durable files — no transcript replay, no compaction. Call it when work remains and the durable state is current. If this session is the recorded successor of an already-used checkpoint, the tool can create and attest a fresh generation (content-delta none when prose is unchanged) before rechecking the full gate. A refusal names its reason; continue work when the refusal is preparable.",
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
      const ownership = ownershipRefusal();
      if (ownership) return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled — ${ownership}` }], details: { ok: false, why: "instance-ownership" } };
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
          pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running || renewalRuntime.toolScheduled,
          readOnly: g.config.readOnly,
        });
        if (!pre.renew) {
          return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled (${pre.why}): ${pre.detail}` }], details: { ok: false, why: pre.why } };
        }
      }
      // Synchronous durable prerequisite, then the full gate.
      let fresh = validateCheckpoint(fs, g.cwd, g.config.files, DEFAULT_CONFIG_NAME);
      const chainBeforeRefresh = loadRenewalState(fs, resolvedStateDir(g));
      if (fresh.kind === "current") {
        const prepared = prepareSuccessorCheckpoint(toolCtx, fresh, chainBeforeRefresh.state, notes);
        if (prepared.error) {
          return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled (already-renewed): ${prepared.error}` }], details: { ok: false, why: "already-renewed" } };
        }
        fresh = prepared.freshness;
      }
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
        pendingInFlight: renewalRuntime.pending !== null || renewalRuntime.running || renewalRuntime.toolScheduled,
        readOnly: g.config.readOnly,
      });
      if (!decision.renew) {
        return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled (${decision.why}): ${decision.detail}` }], details: { ok: false, why: decision.why } };
      }
      // Fire-and-forget: the command handler runs at dispatch (A-19), awaits
      // waitForIdle itself, and performs the switch once this turn settles.
      renewalRuntime.toolScheduled = true;
      try {
        pi.sendUserMessage(`/handoff renew go${notes ? ` ${notes}` : ""}`, { expandPromptTemplates: true });
      } catch (err) {
        renewalRuntime.toolScheduled = false;
        return { content: [{ type: "text", text: `context-guard: renewal NOT scheduled — dispatch failed: ${err instanceof Error ? err.message : String(err)}` }], details: { ok: false, why: "dispatch-failed" } };
      }
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
    description: "Read-only status/verify; explicit checkpoint, readiness, finalization and renewal. Use /handoff checkpoint [notes] to write.",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!g) {
        ctx.ui.notify("context-guard: not initialized", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "instance") {
        const sub = parts[1];
        const active = g.config.missionInstance.id;
        if (sub === "status" || !sub) {
          ctx.ui.notify(active
            ? `mission instance ${active} (work profile ${g.config.missionInstance.workProfile ? `${g.config.missionInstance.workProfile.id}@${g.config.missionInstance.workProfile.version}` : "none"}); ownership ${hasInstanceOwnership() ? "HELD by this process" : `NOT HELD (${g.missionInstanceLockError ?? "lock token missing or changed"})`}; operational files: ${g.config.files.handoff}, ${g.config.files.progress}, ${g.config.files.learnings}; state: ${g.config.stateDir}`
            : "legacy project mode: shared project-root operational files and .pi-guard state; no mission instance selected.", "info");
          return;
        }
        if (sub === "recover") {
          const id = parts[2] ?? active;
          if (!id || !validMissionInstanceId(id)) {
            ctx.ui.notify("usage: /handoff instance recover <id>; recovery requires an explicit valid instance id", "warning");
            return;
          }
          if (g.readOnlyRequested) {
            ctx.ui.notify("mission-instance recovery is unavailable in read-only audit mode; inspect the owner and use a normal operator session", "warning");
            return;
          }
          if (!instancePathIsSafe(fs, g.cwd, id)) {
            ctx.ui.notify("mission-instance recovery refused: instance storage path resolves outside the project", "error");
            return;
          }
          const result = recoverAbandonedInstanceLock(fs, instanceLockPath(g.cwd, id), g.sessionId);
          ctx.ui.notify(`mission instance ${id} recovery ${result.ok ? "complete" : "refused"}: ${result.detail}. Owner state: ${result.inspection.state}${result.inspection.owner ? `; pid ${result.inspection.owner.pid} on ${result.inspection.owner.hostname}, session ${result.inspection.owner.sessionId}` : ""}. ${result.ok ? "Restart Pi to acquire ownership; this process remains unowned." : "Do not delete or replace the lock while its owner may still run."}`, result.ok ? "info" : "warning");
          return;
        }
        if (sub === "create") {
          const id = parts[2];
          if (!id) {
            ctx.ui.notify("usage: /handoff instance create <id> [--profile <id@version>]", "warning");
            return;
          }
          let profile = g.config.missionInstance.workProfile;
          if (parts[3] === "--profile" && parts[4]) {
            const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([A-Za-z0-9][A-Za-z0-9._+-]{0,31})$/.exec(parts[4]);
            if (!match) {
              ctx.ui.notify("invalid profile reference; use <id>@<version>", "warning");
              return;
            }
            profile = { id: match[1], version: match[2] };
          } else if (parts.length > 3) {
            ctx.ui.notify("usage: /handoff instance create <id> [--profile <id@version>]", "warning");
            return;
          }
          if (!validMissionInstanceId(id) || !validWorkProfileRef(profile)) {
            ctx.ui.notify("invalid instance id or work profile reference", "warning");
            return;
          }
          if (!instancePathIsSafe(fs, g.cwd, id)) {
            ctx.ui.notify("mission instance creation refused: instance storage path resolves outside the project", "error");
            return;
          }
          const lockPath = instanceLockPath(g.cwd, id);
          const alreadyOwnedByThisSession = active === id && hasInstanceOwnership();
          const lock = acquireInstanceLock(fs, lockPath, g.sessionId);
          if (!lock.ok) {
            ctx.ui.notify(`mission instance creation refused: ${lock.detail}${lock.inspection.owner ? `; owner pid ${lock.inspection.owner.pid} on ${lock.inspection.owner.hostname}, session ${lock.inspection.owner.sessionId}` : `; lock state ${lock.inspection.state}`}`, "warning");
            return;
          }
          try {
            const result = createMissionInstance(fs, g.cwd, id, profile);
            ctx.ui.notify(result.ok
              ? `mission instance ${id} ${result.resumed ? "creation resumed" : "created"}; initialized missing empty operational documents [${result.created.join(", ")}]. No project documents were copied. Select explicitly at the next session start with CONTEXT_GUARD_MISSION_INSTANCE=${id} or missionInstance.id in handoff.config.json.`
              : `mission instance creation refused: ${result.error}`, result.ok ? "info" : "warning");
          } catch (err) {
            ctx.ui.notify(`mission instance creation incomplete; preserve existing files and inspect before retrying: ${err instanceof Error ? err.message : String(err)}`, "error");
          } finally {
            if (!alreadyOwnedByThisSession) {
              const released = releaseInstanceLock(fs, lockPath);
              if (!released.released) ctx.ui.notify(`mission instance creation finished but its temporary owner lock was not released: ${released.detail}`, "error");
            }
          }
          return;
        }
        if (sub === "select" && parts[2]) {
          const id = parts[2];
          if (!validMissionInstanceId(id)) {
            ctx.ui.notify("invalid mission instance id", "warning");
            return;
          }
          const manifest = joinPath(g.cwd, `.pi-handoff/instances/${id}/mission.json`);
          if (!fs.exists(manifest)) {
            ctx.ui.notify(`mission instance ${id} has no identity manifest; create it first with /handoff instance create ${id}`, "warning");
            return;
          }
          ctx.ui.notify(`selection is per Pi process and takes effect only at session start. Restart this project with CONTEXT_GUARD_MISSION_INSTANCE=${id}, or set missionInstance.id to "${id}" in handoff.config.json. Existing sessions are unchanged.`, "info");
          return;
        }
        ctx.ui.notify("usage: /handoff instance status | create <id> [--profile <id@version>] | select <id> | recover <id>. Selection is explicit per process and takes effect at session start.", "warning");
        return;
      }
      if (parts[0] === "status") {
        const inspection = inspectReport();
        const renewal = inspection.details.renewal as { state?: string; chainCorrupt?: boolean };
        const healthy = inspection.details.checkpoint === "current" && inspection.details.attestation === "attested" && renewal.state === "ready-now" && renewal.chainCorrupt !== true;
        ctx.ui.notify(healthy ? inspection.text : `${inspectReport(true).text}\n${renewStatusReport()}`, "info");
        return;
      }
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
        if (sub === "go") {
          const notes = parts.slice(2).join(" ").trim() || undefined;
          await runRenewal("model", ctx as ExtensionCommandContext, notes);
          return;
        }
        const rawRenewalArgs = args.trimStart().slice("renew".length).trimStart();
        const parsed = parseRenewalArgs(rawRenewalArgs);
        if (!parsed.ok) {
          ctx.ui.notify(`usage error: ${parsed.error}. Use /handoff renew [notes], --task "...", or --task-file <path inside project>.`, "warning");
          return;
        }
        let operatorTask = parsed.operatorTask;
        if (parsed.taskFile !== undefined) {
          const loaded = readOperatorTaskFile(parsed.taskFile);
          if (loaded.error) {
            ctx.ui.notify(`context-guard: renewal refused before checkpoint or session changes: ${loaded.error}`, "warning");
            return;
          }
          operatorTask = loaded.task;
        }
        if (operatorTask !== undefined) {
          const sizeError = validateOperatorTask(operatorTask);
          if (sizeError) {
            ctx.ui.notify(`context-guard: renewal refused before checkpoint or session changes: ${sizeError}`, "warning");
            return;
          }
        }
        await runRenewal("operator", ctx as ExtensionCommandContext, parsed.notes, operatorTask);
        return;
      }
      if (parts[0] === "cycle") {
        await handleDocumentationCycle(parts.slice(1).join(" "), ctx as ExtensionCommandContext);
        return;
      }
      if (parts.length > 0 && parts[0] !== "checkpoint") {
        ctx.ui.notify(
          'usage: /handoff status | verify | ready [check] | checkpoint [notes] | finalize [notes] | renew [notes] | renew --task "..." | renew --task-file <project-path> | renew go | renew stop | renew resume | renew status | instance status|create <id>|select <id> | cycle status|plan|approve|apply|no-change|review|accept-review|continue|abort|recover. Slash commands are Pi operator commands, not Bash commands.',
          "warning",
        );
        return;
      }
      const notes = parts[0] === "checkpoint" ? parts.slice(1).join(" ").trim() : "";
      const ownership = ownershipRefusal();
      if (ownership) {
        ctx.ui.notify(`context-guard: checkpoint refused — ${ownership}`, "warning");
        return;
      }
      const dry = !canWriteProjectTree();
      const result = checkpoint(ctx, dry ? `read-only audit (${notes || "manual /handoff"})` : notes || "manual /handoff", notes || undefined, { dryRun: dry });
      if (!result) return;
      const missing = validateAll(fs, g.cwd, g.config.files).filter((v) => !v.ok).map((v) => v.file);
      const bundle = readRecoveryBundle(fs, g.cwd, g.config.files, { configName: DEFAULT_CONFIG_NAME });
      const text =
        (result.dryRun
          ? `read-only audit mode: NOT written (dry run; would update [${(result.planned ?? []).join(", ")}])`
          : result.ok && result.written.length === 0
            ? `checkpoint unchanged ${result.identity.id} (generation ${result.identity.generation}, content-delta ${result.contentDelta}); no files written`
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
