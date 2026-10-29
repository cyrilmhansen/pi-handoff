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

export function defaultThresholds(t: ThresholdsInput): Threshold[] {
  return [
    {
      level: 1,
      remainingBelow: t.advisory,
      kind: "advisory",
      label: "checkpoint",
      guidance:
        "CONTEXT PRESSURE (advisory): remaining context is low. Update PROGRESS.md with completed work, blockers and the exact next action. No behavior is enforced at this level.",
    },
    {
      level: 2,
      remainingBelow: t.wrapUp,
      kind: "advisory",
      label: "wrap-up",
      guidance:
        "CONTEXT PRESSURE (advisory): finish the current substantial task. Do not open new lines of work. Fold results into PROGRESS.md as you go.",
    },
    {
      level: 3,
      remainingBelow: t.handoff,
      kind: "advisory",
      label: "prioritize-handoff",
      guidance:
        "CONTEXT PRESSURE (advisory): prioritize durable handoff. Write current state to HANDOFF.md (recovery instructions, last verified state, unfinished operations, next action) before doing anything else.",
    },
    {
      level: 4,
      remainingBelow: t.closing,
      kind: "enforced",
      label: "closing",
      guidance:
        "CONTEXT CRITICAL (enforced): controlled closing phase is active. Tools outside the checkpoint allowlist are blocked. Complete HANDOFF.md and PROGRESS.md, then stop; a fresh session will resume from the files.",
    },
  ];
}

export type UnknownReason =
  | "no-model"
  | "no-usage"
  | "invalid-measurement"
  | "synthetic";

export interface Measurement {
  status: "ok" | "unknown";
  /** Tokens usable before hitting the window minus generation reserve. Null when unknown. */
  remaining: number | null;
  tokensUsed: number | null;
  contextWindow: number | null;
  reservedForGeneration: number;
  reason?: UnknownReason;
}

/**
 * Compute a measurement from raw provider/session numbers.
 * Reserved generation capacity is subtracted so thresholds refer to what is
 * left for *conversation*, not for the next completion.
 */
export function computeMeasurement(input: {
  contextWindow?: number | null;
  tokens?: number | null;
  maxOutputTokens?: number | null;
  safetyReserve?: number;
}): Measurement {
  const { contextWindow, tokens } = input;
  const safety = Number.isFinite(input.safetyReserve) ? (input.safetyReserve ?? 0) : 0;
  const maxOut = Number.isFinite(input.maxOutputTokens) ? (input.maxOutputTokens ?? 0) : 0;
  const reserved = Math.max(maxOut, safety);

  if (contextWindow == null || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { status: "unknown", remaining: null, tokensUsed: tokens ?? null, contextWindow: contextWindow ?? null, reservedForGeneration: reserved, reason: "no-model" };
  }
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0) {
    return { status: "unknown", remaining: null, tokensUsed: tokens ?? null, contextWindow, reservedForGeneration: reserved, reason: "no-usage" };
  }
  const remaining = contextWindow - tokens - reserved;
  if (!Number.isFinite(remaining)) {
    return { status: "unknown", remaining: null, tokensUsed: tokens, contextWindow, reservedForGeneration: reserved, reason: "invalid-measurement" };
  }
  return { status: "ok", remaining, tokensUsed: tokens, contextWindow, reservedForGeneration: reserved };
}

/** Synthetic measurement for test mode (bypasses real accounting). */
export function syntheticMeasurement(remaining: number, contextWindow = 0): Measurement {
  if (!Number.isFinite(remaining)) {
    return { status: "unknown", remaining: null, tokensUsed: null, contextWindow: null, reservedForGeneration: 0, reason: "invalid-measurement" };
  }
  return {
    status: "ok",
    remaining,
    tokensUsed: null,
    contextWindow: contextWindow || null,
    reservedForGeneration: 0,
    reason: "synthetic",
  };
}

export interface Transition {
  previousLevel: GuardLevel;
  level: GuardLevel;
  /** Thresholds newly crossed on this evaluation (never alerted before in this session). */
  crossed: Threshold[];
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
  private unknownStreak = 0;
  private degraded = false;
  private lastRemaining: number | null = null;
  private evaluations = 0;

  constructor(thresholds: Threshold[], maxUnknown = 3) {
    this.thresholds = [...thresholds].sort((a, b) => a.level - b.level);
    this.maxUnknown = Math.max(1, maxUnknown);
  }

  get currentLevel(): GuardLevel {
    return this.level;
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
        unknown: true,
        degraded: this.degraded,
        enforcementActive: this.level >= 4,
        measurement,
      };
    }

    this.unknownStreak = 0;
    this.degraded = false;
    this.lastRemaining = measurement.remaining;

    const crossed: Threshold[] = [];
    let newLevel: GuardLevel = 0;
    for (const t of this.thresholds) {
      if (measurement.remaining <= t.remainingBelow) {
        newLevel = t.level;
        if (!this.alerted.has(t.level)) {
          this.alerted.add(t.level);
          crossed.push(t);
        }
      }
    }
    this.level = newLevel;

    return {
      previousLevel,
      level: newLevel,
      crossed,
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
    for (const t of transition.crossed) lines.push(t.guidance);
    if (transition.measurement.remaining != null) {
      lines.push(`[remaining budget: ~${Math.max(0, Math.floor(transition.measurement.remaining))} tokens]`);
    }
    return lines.join("\n");
  }

  snapshot(): MachineSnapshot {
    return {
      currentLevel: this.level,
      alertedLevels: [...this.alerted].sort((a, b) => a - b),
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
    machine.level = validLevels.has(snapshot.currentLevel) ? snapshot.currentLevel : 0;
    machine.unknownStreak = Number.isFinite(snapshot.unknownStreak) && snapshot.unknownStreak >= 0 ? snapshot.unknownStreak : 0;
    machine.degraded = Boolean(snapshot.degraded);
    machine.lastRemaining = Number.isFinite(snapshot.lastRemaining) ? (snapshot.lastRemaining as number) : null;
    machine.evaluations = Number.isFinite(snapshot.evaluations) && snapshot.evaluations >= 0 ? snapshot.evaluations : 0;
    return machine;
  }
}
