/**
 * context-guard core: deterministic context-pressure state machine.
 *
 * Pure module: no fs, no pi imports, no clock, no randomness.
 * All decisions are a function of (thresholds, measurement sequence).
 */

export type GuardLevel = 0 | 1 | 2 | 3 | 4;

export type ThresholdKind = "advisory" | "enforced";

export interface Threshold {
  /** 1..4, higher = more pressure */
  level: GuardLevel;
  /** Threshold is crossed when remaining <= remainingBelow */
  remainingBelow: number;
  kind: ThresholdKind;
  label: string;
  /** Model-facing guidance emitted exactly once per session on crossing. */
  guidance: string;
}

export interface ThresholdsInput {
  advisory: number;
  wrapUp: number;
  handoff: number;
  closing: number;
}

export function defaultThresholds(t: ThresholdsInput, opts: { enforceClosing?: boolean } = {}): Threshold[] {
  // dev.2 D5a: the level-4 alert must describe the ACTUAL policy. With
  // enforceClosing:false nothing is blocked by the guard, so the alert is advisory
  // wording only — claiming enforcement would misdirect a model that still has tools.
  const enforcing = opts.enforceClosing !== false;
  return [
    {
      level: 1,
      remainingBelow: t.advisory,
      kind: "advisory",
      label: "checkpoint",
      guidance:
        "CONTEXT PRESSURE (advisory): checkpoint now (nothing is enforced at this level). Update PROGRESS.md (completed work, blockers, exact next action) and record in LEARNINGS.md every " +
        "important discovery, failed assumption, technical insight and improvement proposal you gained since the last checkpoint. " +
        "Classify each item: accepted (verified), proposed (unverified) or falsified (disproven).",
    },
    {
      level: 2,
      remainingBelow: t.wrapUp,
      kind: "advisory",
      label: "wrap-up",
      guidance:
        "CONTEXT PRESSURE (advisory): finish the bounded task you are on; do not open substantial new investigations. Preserve newly learned procedures and unresolved questions " +
        "in PROGRESS.md and LEARNINGS.md (proposals stay proposals, never adopted silently). " +
        "Classify each item: accepted (verified), proposed (unverified) or falsified (disproven).",
    },
    {
      level: 3,
      remainingBelow: t.handoff,
      kind: "advisory",
      label: "prioritize-handoff",
      guidance:
        "CONTEXT PRESSURE (advisory): prioritize durable handoff above new work. PROGRESS.md, LEARNINGS.md and HANDOFF.md must all carry the latest relevant state: the exact next " +
        "action, the evidence behind each claim, and the unfinished work. " +
        "Classify each item: accepted (verified), proposed (unverified) or falsified (disproven). " +
        "At the next safe boundary, if an unfinished objective and the live renewal gate permit it, prefer handoff_renew over terminal finalization.",
    },
    {
      level: 4,
      remainingBelow: t.closing,
      kind: enforcing ? "enforced" : "advisory",
      label: "closing",
      guidance: enforcing
        ? "CONTEXT CRITICAL (enforced): closing phase active — tools outside the checkpoint allowlist are blocked. Preserve and validate the handoff; record unresolved findings in LEARNINGS.md; " +
          "do not start new experiments. If the objective continues and renewal is permitted or safely preparable, request handoff_renew at a safe boundary. " +
          "If renewal is disabled, stopped, capped or refused after preparation, finalize and stop; the next session can recover from durable files. " +
          "Classify each item: accepted (verified), proposed (unverified) or falsified (disproven)."
        : "CONTEXT CRITICAL (advisory — enforcement is disabled, the guard blocks nothing, closing is YOUR responsibility): preserve and validate the handoff; record unresolved findings in LEARNINGS.md; " +
          "do not start new experiments. If the objective continues and renewal is permitted or safely preparable, request handoff_renew at a safe boundary. " +
          "If renewal is disabled, stopped, capped or refused after preparation, finalize and stop; the next session can recover from durable files. " +
          "Classify each item: accepted (verified), proposed (unverified) or falsified (disproven).",
    },
  ];
}

export type UnknownReason =
  | "no-model"
  | "no-usage"
  | "invalid-measurement"
  | "synthetic";

export type MeasurementProvenance = "real" | "synthetic" | "unknown";

export type ReserveSource = "model-maxTokens" | "generationReserve" | "safetyReserve" | "none";

/** How much output capacity the guard subtracts from the window, and WHY. */
export interface ReserveSelection {
  /** Config value: "model" (use ctx.model.maxTokens) or a fixed number. */
  setting: "model" | number;
  safetyReserve: number;
  /** ctx.model.maxTokens as declared by the model config (may be absent). */
  modelMaxOutputTokens: number | null;
  /** The reserve actually applied: max(setting value, safetyReserve). */
  selected: number;
  source: ReserveSource;
}

export function selectGenerationReserve(input: {
  generationReserve?: "model" | number;
  modelMaxOutputTokens?: number | null;
  safetyReserve?: number;
}): ReserveSelection {
  const setting: "model" | number = input.generationReserve === undefined ? "model" : input.generationReserve;
  const safety = numOr(input.safetyReserve, 0);
  const maxOut = numOrNull(input.modelMaxOutputTokens);
  const fromSetting = setting === "model" ? (maxOut ?? 0) : Math.max(0, setting);
  const selected = Math.max(fromSetting, safety);
  let source: ReserveSource = "none";
  if (selected > 0) source = safety > fromSetting ? "safetyReserve" : setting === "model" ? "model-maxTokens" : "generationReserve";
  return { setting, safetyReserve: safety, modelMaxOutputTokens: maxOut, selected, source };
}

export interface Measurement {
  status: "ok" | "unknown";
  /** Tokens usable before hitting the window minus generation reserve. Null when unknown. */
  remaining: number | null;
  tokensUsed: number | null;
  contextWindow: number | null;
  reservedForGeneration: number;
  reason?: UnknownReason;
  /** Where the numbers came from. Pi 1.4.0 supplies an ESTIMATE, never exact counts. */
  provenance?: MeasurementProvenance;
  /** contextWindow - tokensUsed, before any reserve. */
  rawRemaining?: number | null;
  reserveSource?: ReserveSource;
  inconsistencies?: string[];
}

export interface BudgetBreakdown extends Measurement {
  /** contextWindow - tokensUsed - reserve.selected (same as `remaining` when status is ok). */
  usableRemaining: number | null;
  modelId: string | undefined;
  /** Where the effective policy window came from (not necessarily Pi's physical limit). */
  contextWindowSource: "usage" | "model" | "working-policy" | "unknown";
  /** Pi's actual declared/reported technical window; this value is never changed by the guard. */
  physicalContextWindow: number | null;
  /** Configured policy ceiling; null means the Pi window is used for guard thresholds. */
  configuredWorkingContextWindow: number | null;
  /** ctx.model.contextWindow (declared), cross-checked against the usage value. */
  modelContextWindow: number | null;
  /** ctx.model.maxTokens (declared maximum output). */
  modelMaxOutputTokens: number | null;
  reserve: ReserveSelection;
  /** reserve / contextWindow (null when the window is unknown). */
  reserveFraction: number | null;
  /** Pi's own percent estimate, when it supplied one. */
  percent: number | null;
}

export interface BudgetInput {
  modelId?: string | null;
  /** ctx.getContextUsage().contextWindow */
  contextWindow?: number | null;
  /** ctx.model.contextWindow */
  modelContextWindow?: number | null;
  /** Guard-only work budget; does not alter ctx.model, Pi provider requests or Sushi. */
  workingContextWindow?: number | null;
  /** ctx.model.maxTokens */
  modelMaxOutputTokens?: number | null;
  /** ctx.getContextUsage().tokens — a Pi 1.4.0 estimate, not an exact count. */
  tokens?: number | null;
  /** ctx.getContextUsage().percent — cross-check only. */
  percent?: number | null;
  generationReserve?: "model" | number;
  safetyReserve?: number;
}

function numOr(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Above this share of the window, a policy reserve is worth flagging. */
export const RESERVE_FRACTION_WARN = 0.25;

/**
 * Full budget accounting. `remaining`/`status` keep the historical semantics
 * (usable = window - used - reserve); every other field exists so `/guard status`
 * can explain WHY the guard sits where it does. Do not read this as exact
 * accounting: Pi 1.4.0 provides an estimate (usage + chars/4 trailing).
 */
export function computeBudget(input: BudgetInput): BudgetBreakdown {
  const reserve = selectGenerationReserve(input);
  const inconsistencies: string[] = [];
  const usageWindow = numOrNull(input.contextWindow);
  const declaredWindow = numOrNull(input.modelContextWindow);
  const physicalWindow = usageWindow != null && usageWindow > 0 ? usageWindow : declaredWindow != null && declaredWindow > 0 ? declaredWindow : null;
  const requestedWorkingWindow = typeof input.workingContextWindow === "number" && Number.isSafeInteger(input.workingContextWindow) && input.workingContextWindow > 0
    ? input.workingContextWindow : null;
  // A policy ceiling must NEVER expand the physical model window. If Pi reports no
  // technical window, do not manufacture safe headroom from a configured target.
  const effectiveWindow = physicalWindow == null ? null : Math.min(physicalWindow, requestedWorkingWindow ?? physicalWindow);
  const contextWindowSource: BudgetBreakdown["contextWindowSource"] =
    physicalWindow == null ? "unknown" : requestedWorkingWindow != null ? "working-policy" : usageWindow != null && usageWindow > 0 ? "usage" : "model";
  const rawTokens = numOrNull(input.tokens);
  const tokens = rawTokens != null && rawTokens >= 0 ? rawTokens : null;

  if (requestedWorkingWindow != null && physicalWindow != null && requestedWorkingWindow > physicalWindow) {
    inconsistencies.push(`workingContextWindow ${requestedWorkingWindow} exceeds Pi physical window ${physicalWindow}; guard policy clamped to ${physicalWindow}`);
  }
  if (usageWindow != null && declaredWindow != null && usageWindow !== declaredWindow) {
    inconsistencies.push(`inconsistent context window: Pi usage reports ${usageWindow}, ctx.model declares ${declaredWindow}`);
  }
  if (effectiveWindow == null) inconsistencies.push("no context window available (no model / no usage data): budget unknown, enforcement is held");
  if (rawTokens != null && rawTokens < 0) inconsistencies.push(`invalid usage estimate: ${rawTokens}`);
  if (tokens == null && effectiveWindow != null) inconsistencies.push("no token estimate available yet (no-usage): Pi reports null until a fresh assistant response");
  if (reserve.setting === "model" && reserve.modelMaxOutputTokens == null) {
    inconsistencies.push("generationReserve is \"model\" but the model declares no maxTokens: reserve fell back to safetyReserve");
  }

  const rawRemaining = effectiveWindow != null && tokens != null ? effectiveWindow - tokens : null;
  const usableRemaining = rawRemaining == null ? null : rawRemaining - reserve.selected;
  const reserveFraction = effectiveWindow != null && effectiveWindow > 0 ? reserve.selected / effectiveWindow : null;
  if (reserveFraction != null && reserveFraction > RESERVE_FRACTION_WARN) {
    inconsistencies.push(
      `large generation reserve: ${reserve.selected} tokens = ${(reserveFraction * 100).toFixed(1)}% of the ${effectiveWindow}-token window — ` +
        "thresholds are measured against usable remaining, so the guard escalates early. A policy reserve is not an output cap: " +
        "Pi clamps max_tokens to window - estimate - 4096 per request (see README §Generation reserve).",
    );
  }
  if (usableRemaining != null && usableRemaining <= 0) {
    inconsistencies.push(`usable budget is exhausted (negative remaining ${usableRemaining}): used + reserve >= window, enforced closing is unavoidable`);
  }
  const percent = numOrNull(input.percent);
  if (percent != null && tokens != null && physicalWindow != null && physicalWindow > 0) {
    // Pi reports usage percent relative to its PHYSICAL window, not our policy ceiling.
    const implied = (percent / 100) * physicalWindow;
    if (Math.abs(implied - tokens) > Math.max(1000, physicalWindow * 0.02)) {
      inconsistencies.push(`inconsistent measurement: Pi's percent (${percent.toFixed(1)}%) implies ~${Math.round(implied)} tokens used while the estimate says ${tokens}`);
    }
  }

  const reason: UnknownReason | undefined =
    effectiveWindow == null ? "no-model" : tokens == null ? "no-usage" : usableRemaining != null && !Number.isFinite(usableRemaining) ? "invalid-measurement" : undefined;
  const status: "ok" | "unknown" = reason == null ? "ok" : "unknown";

  return {
    status,
    reason,
    provenance: status === "ok" ? "real" : "unknown",
    remaining: status === "ok" ? usableRemaining : null,
    usableRemaining,
    rawRemaining,
    tokensUsed: tokens,
    contextWindow: effectiveWindow,
    reservedForGeneration: reserve.selected,
    reserveSource: reserve.source,
    inconsistencies,
    modelId: input.modelId ?? undefined,
    contextWindowSource,
    physicalContextWindow: physicalWindow,
    configuredWorkingContextWindow: requestedWorkingWindow,
    modelContextWindow: declaredWindow,
    modelMaxOutputTokens: reserve.modelMaxOutputTokens,
    reserve,
    reserveFraction,
    percent,
  };
}

/** Synthetic budget for test mode: bypasses real accounting and declares itself. */
export function syntheticBudget(remaining: number, contextWindow?: number | null, workingContextWindow?: number | null): BudgetBreakdown {
  const physical = numOr(contextWindow, 0) > 0 ? (contextWindow as number) : null;
  const requested = typeof workingContextWindow === "number" && Number.isSafeInteger(workingContextWindow) && workingContextWindow > 0 ? workingContextWindow : null;
  const window = physical == null ? null : Math.min(physical, requested ?? physical);
  if (!Number.isFinite(remaining)) {
    return { ...computeBudget({ contextWindow: physical, workingContextWindow: requested }), status: "unknown", reason: "invalid-measurement", remaining: null, usableRemaining: null, provenance: "unknown" };
  }
  return {
    status: "ok",
    reason: "synthetic",
    provenance: "synthetic",
    remaining: Math.floor(remaining),
    usableRemaining: Math.floor(remaining),
    rawRemaining: Math.floor(remaining),
    tokensUsed: null,
    contextWindow: window,
    reservedForGeneration: 0,
    reserveSource: "none",
    inconsistencies: ["synthetic measurement: test-injected remaining; real token accounting is NOT proven by this session"],
    modelId: undefined,
    contextWindowSource: window == null ? "unknown" : requested != null ? "working-policy" : "usage",
    physicalContextWindow: physical,
    configuredWorkingContextWindow: requested,
    modelContextWindow: null,
    modelMaxOutputTokens: null,
    reserve: selectGenerationReserve({ generationReserve: 0, safetyReserve: 0 }),
    reserveFraction: 0,
    percent: null,
  };
}

export function measurementFromBudget(b: BudgetBreakdown): Measurement {
  return {
    status: b.status,
    remaining: b.remaining,
    tokensUsed: b.tokensUsed,
    contextWindow: b.contextWindow,
    reservedForGeneration: b.reserve.selected,
    reason: b.reason,
    provenance: b.provenance,
    rawRemaining: b.rawRemaining,
    reserveSource: b.reserveSource,
    inconsistencies: b.inconsistencies,
  };
}

/**
 * Compute a measurement from raw provider/session numbers.
 * Reserved generation capacity is subtracted so thresholds refer to what is
 * left for *conversation*, not for the next completion. Thin wrapper over
 * computeBudget so there is exactly one accounting implementation.
 */
export function computeMeasurement(input: {
  contextWindow?: number | null;
  tokens?: number | null;
  /** Declared model maximum output (used when generationReserve is "model"). */
  maxOutputTokens?: number | null;
  safetyReserve?: number;
  generationReserve?: "model" | number;
  modelId?: string | null;
  modelContextWindow?: number | null;
  workingContextWindow?: number | null;
  percent?: number | null;
}): Measurement {
  return measurementFromBudget(
    computeBudget({
      contextWindow: input.contextWindow,
      modelContextWindow: input.modelContextWindow ?? input.contextWindow,
      workingContextWindow: input.workingContextWindow,
      modelMaxOutputTokens: input.maxOutputTokens,
      tokens: input.tokens,
      percent: input.percent,
      generationReserve: input.generationReserve ?? "model",
      safetyReserve: input.safetyReserve,
      modelId: input.modelId,
    }),
  );
}

/** Synthetic measurement for test mode (bypasses real accounting). */
export function syntheticMeasurement(remaining: number, contextWindow = 0): Measurement {
  return measurementFromBudget(syntheticBudget(remaining, contextWindow));
}

export interface NextThresholdReport {
  /** Next threshold crossed as usage grows (its alert may already be spent). */
  nextCrossing: (Threshold & { tokensUntil: number }) | null;
  /** Next threshold that would still fire an alert in THIS session. */
  nextAlert: (Threshold & { tokensUntil: number }) | null;
}

/** Which threshold comes next, and how many tokens of growth away it is. */
export function nextThresholds(thresholds: Threshold[], remaining: number | null, alerted: Iterable<GuardLevel> = []): NextThresholdReport {
  if (remaining == null) return { nextCrossing: null, nextAlert: null };
  const spent = new Set(alerted);
  // remaining falls as the session grows: the next crossing is the largest
  // threshold still ABOVE the current level's cut, i.e. the closest one below now.
  const candidates = thresholds.filter((t) => t.remainingBelow < remaining).sort((a, b) => b.remainingBelow - a.remainingBelow);
  const wrap = (t: Threshold | undefined): (Threshold & { tokensUntil: number }) | null =>
    t ? { ...t, tokensUntil: Math.max(0, Math.ceil(remaining - t.remainingBelow)) } : null;
  return { nextCrossing: wrap(candidates[0]), nextAlert: wrap(candidates.find((t) => !spent.has(t.level))) };
}

export interface CrossingPoint {
  /** 1..4, higher = more pressure */
  level: GuardLevel;
  label: string;
  /** Live policy kind — with enforceClosing:false L4 is advisory (D5a honesty). */
  kind: ThresholdKind;
  /** The level activates when usable remaining drops to or below this value. */
  remainingBelow: number;
  /**
   * Estimated used tokens at which usable remaining reaches `remainingBelow`:
   * `window − reserve − remainingBelow` — the SAME arithmetic as `computeBudget`.
   * May be ≤ 0: the level would already be active at session start.
   */
  usedAt: number;
}

export interface CrossingReport {
  /** The resolved reserve whose value went into the arithmetic (provenance). */
  reserve: ReserveSelection;
  /** Ascending by usedAt = escalation order; EMPTY when the window is unknown. */
  crossings: CrossingPoint[];
}

/**
 * dev.2 D6: express the thresholds as the practical question — "at which USED-token
 * count does each level fire?" Pure arithmetic over the DECLARED window and the
 * resolved reserve, sharing `computeBudget`'s formula (usable = window − used −
 * reserve). The guard does not own the window: it comes from the runtime model /
 * provider and the guard never changes it; `used` is a Pi ESTIMATE (A-1/A-18), so
 * crossing points are advisory budgets, never exact accounting.
 */
export function crossingPoints(input: {
  contextWindow: number | null | undefined;
  reserve: ReserveSelection;
  thresholds: Threshold[];
}): CrossingReport {
  const window = numOrNull(input.contextWindow);
  const crossings: CrossingPoint[] =
    window == null || window <= 0
      ? []
      : input.thresholds
          .map((t) => ({
            level: t.level,
            label: t.label,
            kind: t.kind,
            remainingBelow: t.remainingBelow,
            usedAt: window - input.reserve.selected - t.remainingBelow,
          }))
          .sort((a, b) => a.usedAt - b.usedAt);
  return { reserve: input.reserve, crossings };
}

/** One-line operator rendering for `/guard status` (dev.2 D6). */
export function crossingPointsLine(report: CrossingReport): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (report.crossings.length === 0) {
    return "threshold crossings: unavailable (context window unknown — the guard only reports the window declared by the model/provider; it never changes it)";
  }
  const parts = report.crossings.map(
    (c) =>
      `L${c.level} ${c.label} (${c.kind}) at used ≥ ${n(c.usedAt)}` +
      (c.usedAt <= 0 ? " (!! ≤ 0: this level would already be active at session start — the reserve/threshold budget is too tight for this window)" : ""),
  );
  return (
    `threshold crossings (estimated used, escalation order): ${parts.join("; ")} — ` +
    `arithmetic: window − reserve − threshold (reserve ${n(report.reserve.selected)}, source: ${report.reserve.source}). ` +
    "The guard never changes the model window (owned by the model/provider); these points are advisory policy budgets computed from Pi's estimated usage, not exact accounting."
  );
}

export interface Transition {
  previousLevel: GuardLevel;
  level: GuardLevel;
  /** Thresholds newly crossed on this evaluation (never alerted before in this session). */
  crossed: Threshold[];
  /**
   * Thresholds whose alert was delivered earlier in this session but whose condition
   * a NEW VALID measurement no longer satisfies (remaining rose back above the
   * threshold). Their guidance is now HISTORICAL: enforcement follows `level`, not
   * history. One revocation notice per level per session (re-arms if re-crossed).
   */
  revoked: Threshold[];
  /** The last valid measurement before this one (null if none); revocation context. */
  previousMeasurement: Measurement | null;
  /** True when the measurement was unusable; level is then held (fail-safe). */
  unknown: boolean;
  /** True once unknownStreak >= maxConsecutiveUnknown. */
  degraded: boolean;
  /** Enforcement (level >= closing) is active regardless of measurement freshness. */
  enforcementActive: boolean;
  measurement: Measurement;
}

export interface MachineSnapshot {
  currentLevel: GuardLevel;
  alertedLevels: GuardLevel[];
  /** Levels whose closing/advisory alert has already been REVOKED (notice sent once). */
  revokedLevels?: GuardLevel[];
  unknownStreak: number;
  degraded: boolean;
  lastRemaining: number | null;
  evaluations: number;
}

export class ContextPressureMachine {
  private thresholds: Threshold[];
  private maxUnknown: number;
  private level: GuardLevel = 0;
  private alerted = new Set<GuardLevel>();
  private revokedNotified = new Set<GuardLevel>();
  private unknownStreak = 0;
  private degraded = false;
  private lastRemaining: number | null = null;
  private lastMeasurement: Measurement | null = null;
  private evaluations = 0;

  constructor(thresholds: Threshold[], maxUnknown = 3) {
    this.thresholds = [...thresholds].sort((a, b) => a.level - b.level);
    this.maxUnknown = Math.max(1, maxUnknown);
  }

  get currentLevel(): GuardLevel {
    return this.level;
  }

  /** Read-only copy, for status reporting. */
  get thresholdList(): Threshold[] {
    return [...this.thresholds];
  }

  /** Next crossing / next alertable threshold for a given usable-remaining value. */
  nextThreshold(remaining: number | null): NextThresholdReport {
    return nextThresholds(this.thresholds, remaining, this.alerted);
  }

  /**
   * Feed one measurement. Unknown measurements never relax enforcement
   * (fail-safe: keep the last known level) and never fire alerts.
   */
  evaluate(measurement: Measurement): Transition {
    this.evaluations += 1;
    const previousLevel = this.level;

    if (measurement.status !== "ok" || measurement.remaining == null) {
      this.unknownStreak += 1;
      if (this.unknownStreak >= this.maxUnknown) this.degraded = true;
      return {
        previousLevel,
        level: this.level,
        crossed: [],
        revoked: [],
        previousMeasurement: this.lastMeasurement,
        unknown: true,
        degraded: this.degraded,
        enforcementActive: this.level >= 4,
        measurement,
      };
    }

    this.unknownStreak = 0;
    this.degraded = false;
    const previousMeasurement = this.lastMeasurement;
    this.lastRemaining = measurement.remaining;
    this.lastMeasurement = { ...measurement };

    const crossed: Threshold[] = [];
    const satisfied = new Set<GuardLevel>();
    let newLevel: GuardLevel = 0;
    for (const t of this.thresholds) {
      if (measurement.remaining <= t.remainingBelow) {
        satisfied.add(t.level);
        newLevel = t.level;
        if (!this.alerted.has(t.level)) {
          this.alerted.add(t.level);
          crossed.push(t);
        }
      }
    }
    // A previously alerted threshold the current valid measurement no longer satisfies
    // is REVOKED: its guidance becomes historical, not current policy. Alerts stay
    // spent (one alert per crossing per session, PROTOCOL §1); enforcement is live via
    // `level` (re-escalation re-gates tools even without a new alert).
    const revoked: Threshold[] = [];
    for (const t of this.thresholds) {
      if (satisfied.has(t.level)) {
        this.revokedNotified.delete(t.level); // a future drop can revoke again
        continue;
      }
      if (this.alerted.has(t.level) && !this.revokedNotified.has(t.level)) {
        this.revokedNotified.add(t.level);
        revoked.push(t);
      }
    }
    this.level = newLevel;

    return {
      previousLevel,
      level: newLevel,
      crossed,
      revoked,
      previousMeasurement,
      unknown: false,
      degraded: false,
      enforcementActive: newLevel >= 4,
      measurement,
    };
  }

  /** Compose the single alert text for a transition (may cover several thresholds crossed at once). */
  formatAlert(transition: Transition): string | undefined {
    if (transition.crossed.length === 0) return undefined;
    const lines: string[] = [];
    if (transition.crossed.length > 1) {
      lines.push(
        `CONTEXT GUARD: ${transition.crossed.length} pressure thresholds crossed in one step ` +
          `(${transition.crossed.map((t) => t.label).join(", ")}).`,
      );
    }
    for (const t of this.thresholds.filter((x) => transition.crossed.some((c) => c.level === x.level))) lines.push(t.guidance);
    if (transition.measurement.remaining != null) {
      lines.push(`[remaining budget: ~${Math.max(0, Math.floor(transition.measurement.remaining))} tokens]`);
    }
    return lines.join("\n");
  }

  /**
   * Policy-update text for a REVOKED threshold: distinguishes historical instructions
   * (the earlier alert remains in the transcript for audit) from current policy, and
   * records the measurements and provenance before/after the transition. Returns
   * undefined when nothing was revoked.
   */
  formatRevocation(transition: Transition): string | undefined {
    if (transition.revoked.length === 0) return undefined;
    const names = transition.revoked.map((t) => `level ${t.level} "${t.label}" (${t.kind})`);
    const enforced = transition.revoked.some((t) => t.kind === "enforced");
    const fmt = (m: Measurement | null): string =>
      m == null
        ? "previous measurement not captured by this session instance"
        : `remaining ~${m.remaining == null ? "?" : Math.max(0, Math.floor(m.remaining))}, used ${m.tokensUsed ?? "?"}, window ${m.contextWindow ?? "?"}, reserve ${m.reservedForGeneration}, provenance ${m.provenance ?? "unknown"}, status ${m.status}`;
    const lines = [
      `CONTEXT GUARD POLICY UPDATE (measurement recovered): ${names.join(", ")} ${names.length > 1 ? "are" : "is"} REVOKED — ` +
        (enforced
          ? "the enforced closing phase is NO LONGER ACTIVE; tools outside the allowlist are permitted again. " +
            "The earlier closing instruction above is HISTORICAL, not current policy; do not rush or truncate work because of it. "
          : "the earlier guidance is no longer current policy. ") +
        "Pi 1.4.0 context numbers are estimates and may move in BOTH directions when a provider-reported usage projection replaces a heuristic projection (LEARNINGS A-1); this correction is based on a fresh valid measurement, provenance below.",
      `  before: ${fmt(transition.previousMeasurement)}`,
      `  after:  ${fmt(transition.measurement)}`,
      `  level ${transition.previousLevel} -> ${transition.level}. Historical alerts are retained in this transcript for audit and will not repeat; if pressure returns, enforcement follows the live level again (tool gate reports it).`,
    ];
    return lines.join("\n");
  }

  snapshot(): MachineSnapshot {
    return {
      currentLevel: this.level,
      alertedLevels: [...this.alerted].sort((a, b) => a - b),
      revokedLevels: [...this.revokedNotified].sort((a, b) => a - b),
      unknownStreak: this.unknownStreak,
      degraded: this.degraded,
      lastRemaining: this.lastRemaining,
      evaluations: this.evaluations,
    };
  }

  static restore(snapshot: MachineSnapshot, thresholds: Threshold[], maxUnknown = 3): ContextPressureMachine {
    const machine = new ContextPressureMachine(thresholds, maxUnknown);
    const validLevels = new Set(thresholds.map((t) => t.level));
    for (const level of snapshot.alertedLevels ?? []) {
      if (validLevels.has(level as GuardLevel)) machine.alerted.add(level as GuardLevel);
    }
    for (const level of snapshot.revokedLevels ?? []) {
      if (validLevels.has(level as GuardLevel)) machine.revokedNotified.add(level as GuardLevel);
    }
    machine.level = validLevels.has(snapshot.currentLevel) ? snapshot.currentLevel : 0;
    machine.unknownStreak = Number.isFinite(snapshot.unknownStreak) && snapshot.unknownStreak >= 0 ? snapshot.unknownStreak : 0;
    machine.degraded = Boolean(snapshot.degraded);
    machine.lastRemaining = Number.isFinite(snapshot.lastRemaining) ? (snapshot.lastRemaining as number) : null;
    machine.evaluations = Number.isFinite(snapshot.evaluations) && snapshot.evaluations >= 0 ? snapshot.evaluations : 0;
    return machine;
  }
}
