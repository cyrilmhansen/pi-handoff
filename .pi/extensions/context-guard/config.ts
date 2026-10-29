/**
 * context-guard configuration: defaults + safe merging.
 * Pure module (injectable file reader), no pi imports.
 */

import type { ThresholdsInput } from "./core.ts";
import { DEFAULT_RENEWAL, mergeRenewal, type RenewalConfig } from "./renewal.ts";

export interface GuardFiles {
  goal: string;
  progress: string;
  learnings: string;
  handoff: string;
}

export interface GuardConfig {
  enabled: boolean;
  thresholds: ThresholdsInput;
  /** "model" = subtract ctx.model.maxTokens; number = fixed reserve. */
  generationReserve: "model" | number;
  safetyReserve: number;
  enforceClosing: boolean;
  closingAllowlist: string[];
  protectGoal: boolean;
  autoCheckpointAtHandoffLevel: boolean;
  maxConsecutiveUnknown: number;
  stateDir: string;
  /**
   * Read-only audit mode: the guard performs ZERO writes inside the project
   * tree (no checkpoints, no managed-block stamps). Runtime state may still
   * persist if `stateDir` resolves outside the project directory.
   */
  readOnly: boolean;
  /**
   * Retention cap for per-session runtime state files (ephemeral).
   * 0 (the default) DISABLES pruning: without OS-level liveness detection, deleting a
   * state file that may belong to a still-running session is unsafe.
   */
  maxSessionStates: number;
  files: GuardFiles;
  /** Fixed remaining-token figure used by synthetic test mode. */
  syntheticRemaining: number | null;
  /**
   * Phase 2 renewal policy (see renewal.ts). Disabled by default: NOTHING switches
   * sessions until `renewal.enabled` is true, and model-initiated renewal additionally
   * requires `renewal.autoRenew`.
   */
  renewal: RenewalConfig;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  thresholds: { advisory: 30000, wrapUp: 20000, handoff: 10000, closing: 5000 },
  generationReserve: "model",
  safetyReserve: 0,
  enforceClosing: true,
  closingAllowlist: ["write", "edit", "read"],
  protectGoal: true,
  autoCheckpointAtHandoffLevel: true,
  maxConsecutiveUnknown: 3,
  stateDir: ".pi-guard",
  readOnly: false,
  maxSessionStates: 0,
  files: { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" },
  syntheticRemaining: null,
  renewal: { ...DEFAULT_RENEWAL },
};

export interface MiniFs {
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
}

type Json = Record<string, unknown>;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v) && v >= 0;
}

export function mergeConfig(base: GuardConfig, override: Json | null | undefined): GuardConfig {
  if (!override || typeof override !== "object") return base;
  const next: GuardConfig = { ...base, files: { ...base.files }, thresholds: { ...base.thresholds }, closingAllowlist: [...base.closingAllowlist], renewal: { ...base.renewal } };
  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  const th = override.thresholds;
  if (th && typeof th === "object") {
    const t = th as Json;
    for (const key of ["advisory", "wrapUp", "handoff", "closing"] as const) {
      if (isPositiveInt(t[key])) next.thresholds[key] = t[key] as number;
    }
  }
  if (override.generationReserve === "model" || isPositiveInt(override.generationReserve) || override.generationReserve === 0) {
    next.generationReserve = override.generationReserve as GuardConfig["generationReserve"];
  }
  if (typeof override.safetyReserve === "number" && Number.isFinite(override.safetyReserve) && override.safetyReserve >= 0) next.safetyReserve = override.safetyReserve;
  if (typeof override.enforceClosing === "boolean") next.enforceClosing = override.enforceClosing;
  if (Array.isArray(override.closingAllowlist)) next.closingAllowlist = override.closingAllowlist.filter((x): x is string => typeof x === "string");
  if (typeof override.protectGoal === "boolean") next.protectGoal = override.protectGoal;
  if (typeof override.autoCheckpointAtHandoffLevel === "boolean") next.autoCheckpointAtHandoffLevel = override.autoCheckpointAtHandoffLevel;
  if (isPositiveInt(override.maxConsecutiveUnknown)) next.maxConsecutiveUnknown = override.maxConsecutiveUnknown;
  if (typeof override.stateDir === "string" && override.stateDir.length > 0) next.stateDir = override.stateDir;
  if (typeof override.readOnly === "boolean") next.readOnly = override.readOnly;
  if (isNonNegativeInt(override.maxSessionStates)) next.maxSessionStates = override.maxSessionStates;
  const files = override.files;
  if (files && typeof files === "object") {
    const f = files as Json;
    for (const key of ["goal", "progress", "learnings", "handoff"] as const) {
      if (typeof f[key] === "string" && (f[key] as string).length > 0) next.files[key] = f[key] as string;
    }
  }
  next.renewal = mergeRenewal(next.renewal, override.renewal);
  return next;
}

/**
 * Load config from `handoff.config.json` (if readable and valid), then apply
 * environment overrides. Malformed files fall back to defaults (fail safe).
 */
export function loadConfig(
  readFile: (path: string) => string | undefined,
  env: Record<string, string | undefined> = process.env,
  fileName = "handoff.config.json",
): GuardConfig {
  let merged = DEFAULT_CONFIG;
  const raw = readFile(fileName);
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) merged = mergeConfig(merged, parsed as Json);
    } catch {
      // corrupt config: keep defaults, guard stays functional
    }
  }
  if (env.CONTEXT_GUARD_DISABLED === "1") merged = { ...merged, enabled: false };
  if (env.CONTEXT_GUARD_ENFORCE === "0") merged = { ...merged, enforceClosing: false };
  if (env.CONTEXT_GUARD_READONLY === "1") merged = { ...merged, readOnly: true };
  if (typeof env.CONTEXT_GUARD_STATE_DIR === "string" && env.CONTEXT_GUARD_STATE_DIR.length > 0) {
    merged = { ...merged, stateDir: env.CONTEXT_GUARD_STATE_DIR };
  }
  const sim = env.CONTEXT_GUARD_SYNTHETIC_REMAINING;
  if (sim != null) {
    const n = Number(sim);
    if (Number.isFinite(n)) merged = { ...merged, syntheticRemaining: Math.floor(n) };
  }
  // Renewal kill switch / experiment switch: "1" enables renewal AND the model-initiated
  // path for this process; "0" forces both off regardless of the config file.
  if (env.CONTEXT_GUARD_AUTO_RENEW === "1") {
    merged = { ...merged, renewal: { ...merged.renewal, enabled: true, autoRenew: true } };
  } else if (env.CONTEXT_GUARD_AUTO_RENEW === "0") {
    merged = { ...merged, renewal: { ...merged.renewal, enabled: false, autoRenew: false } };
  }
  return merged;
}
