/**
 * context-guard renewal (Phase 2, increment A): pure renewal decision + durable
 * chain state + deterministic recovery prompt.
 *
 * No fs, no pi, no clock, no randomness in the DECISION: everything is a function of
 * (config, authorization, chain state, checkpoint identity). File I/O wiring and the
 * actual session transition live in index.ts (increment B) and rely ONLY on the
 * source-verified Pi 1.4.0 semantics (LEARNINGS A-17, A-19, design P-6/P-8).
 */

export interface RenewalConfig {
  /** Master switch. Default FALSE: renewal never happens until explicitly enabled. */
  enabled: boolean;
  /** Allow model-initiated renewal (guard tool) without an operator keystroke. Default FALSE. */
  autoRenew: boolean;
  /** Hard cap on renewals performed in one chain (across sessions). Default 2 for experiments. */
  maxRenewals: number;
  /** Override the deterministic recovery instruction (null = built-in template). */
  recoveryPrompt: string | null;
}

export const DEFAULT_RENEWAL: RenewalConfig = {
  enabled: false,
  autoRenew: false,
  maxRenewals: 2,
  recoveryPrompt: null,
};

export function mergeRenewal(base: RenewalConfig, override: unknown): RenewalConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const o = override as Record<string, unknown>;
  const next = { ...base };
  if (typeof o.enabled === "boolean") next.enabled = o.enabled;
  if (typeof o.autoRenew === "boolean") next.autoRenew = o.autoRenew;
  if (typeof o.maxRenewals === "number" && Number.isInteger(o.maxRenewals) && o.maxRenewals >= 0) next.maxRenewals = o.maxRenewals;
  if (typeof o.recoveryPrompt === "string" && o.recoveryPrompt.trim().length > 0) next.recoveryPrompt = o.recoveryPrompt;
  return next;
}

/** Durable renewal chain state (persisted OUTSIDE the session transcript: survives replacement AND process restarts — A-17.4). */
export interface RenewalState {
  version: 1;
  /** Stable identifier for this renewal chain (set at the first renewal). */
  chainId: string;
  /** Renewals COMPLETED so far in the chain (successor increments nothing; the initiator increments before switching). */
  renewalsDone: number;
  /** Checkpoint id the last renewal transitioned FROM (idempotence key). */
  renewedFromCheckpointId: string | null;
  /** Session id of the last renewal's successor, recorded by that successor at session_start. */
  lastSuccessorSessionId: string | null;
  updatedAt: number | null;
}

export const INITIAL_RENEWAL_STATE: RenewalState = {
  version: 1,
  chainId: "",
  renewalsDone: 0,
  renewedFromCheckpointId: null,
  lastSuccessorSessionId: null,
  updatedAt: null,
};

export function parseRenewalState(raw: string | undefined): { state: RenewalState; corrupt: boolean } {
  if (raw == null || raw === "") return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: false };
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object" || p.version !== 1) return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: true };
    return {
      state: {
        version: 1,
        chainId: typeof p.chainId === "string" ? p.chainId : "",
        renewalsDone: typeof p.renewalsDone === "number" && Number.isFinite(p.renewalsDone) && p.renewalsDone >= 0 ? Math.floor(p.renewalsDone) : 0,
        renewedFromCheckpointId: typeof p.renewedFromCheckpointId === "string" ? p.renewedFromCheckpointId : null,
        lastSuccessorSessionId: typeof p.lastSuccessorSessionId === "string" ? p.lastSuccessorSessionId : null,
        updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : null,
      },
      corrupt: false,
    };
  } catch {
    return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: true };
  }
}

export function serializeRenewalState(s: RenewalState): string {
  return JSON.stringify(s, null, 2) + "\n";
}

/** Shape of `renewAuthorization()` (checkpoint.ts) without importing it here (pure module). */
export interface AuthorizationView {
  authorized: boolean;
  reason: string;
}

export type RenewalTrigger = "operator" | "model" | "auto";

export type RenewalDecision =
  | { renew: true; reason: string }
  | { renew: false; why: "disabled" | "auto-disabled" | "stopped" | "read-only" | "not-authorized" | "capped" | "already-renewed" | "pending"; detail: string };

/**
 * The renewal gate. Pure: (config, authorization, chain state, checkpoint identity,
 * operator stop flag, trigger). Never throws; every refusal names its reason so the
 * transition failure path stays observable.
 */
export function decideRenewal(input: {
  renewal: RenewalConfig;
  trigger: RenewalTrigger;
  auth: AuthorizationView;
  checkpointId: string | null;
  state: RenewalState;
  operatorStop: boolean;
  pendingInFlight: boolean;
  readOnly: boolean;
}): RenewalDecision {
  if (input.operatorStop) return { renew: false, why: "stopped", detail: "operator stopped renewals (/handoff renew stop); no transition will run" };
  if (input.readOnly) return { renew: false, why: "read-only", detail: "read-only audit mode never switches sessions" };
  if (!input.renewal.enabled) return { renew: false, why: "disabled", detail: "renewal.enabled is false (default); enable in handoff.config.json to use this feature" };
  if (input.trigger === "model" || input.trigger === "auto") {
    if (!input.renewal.autoRenew) return { renew: false, why: "auto-disabled", detail: `${input.trigger}-initiated renewal requires renewal.autoRenew: true` };
  }
  if (input.pendingInFlight) return { renew: false, why: "pending", detail: "a renewal is already pending/running in this process" };
  if (input.renewal.maxRenewals <= 0 || input.state.renewalsDone >= input.renewal.maxRenewals) {
    return {
      renew: false,
      why: "capped",
      detail: `renewal cap reached (${input.state.renewalsDone}/${input.renewal.maxRenewals}); increase renewal.maxRenewals or reset <stateDir>/renewal-state.json`,
    };
  }
  if (input.checkpointId == null) return { renew: false, why: "not-authorized", detail: "no current transactional checkpoint id (checkpoint missing/corrupt/stale)" };
  if (!input.auth.authorized) return { renew: false, why: "not-authorized", detail: `renewAuthorization: ${input.auth.reason}` };
  if (input.state.renewedFromCheckpointId === input.checkpointId) {
    return { renew: false, why: "already-renewed", detail: `checkpoint ${input.checkpointId} already seeded a successor (idempotence guard)` };
  }
  return {
    renew: true,
    reason: `authorized (${input.auth.reason}); cap ${input.state.renewalsDone + 1}/${input.renewal.maxRenewals}`,
  };
}

/**
 * Deterministic recovery instruction for the successor session (P-6 / PROTOCOL §6):
 * durable files only, no transcript replay, no LLM summarization. Same inputs => same
 * bytes (cache-stable, auditable).
 */
export function buildRecoveryPrompt(input: {
  files: { goal: string; progress: string; learnings: string; handoff: string };
  checkpointId: string;
  chainId: string;
  renewalIndex: number;
  maxRenewals: number;
  parentSessionId: string;
  testCommand?: string;
  extraNotes?: string;
}): string {
  const lines = [
    `[context-guard renewal ${input.renewalIndex}/${input.maxRenewals}] Fresh session started automatically from durable state.`,
    `Parent session: ${input.parentSessionId}; renewal chain: ${input.chainId}; checkpoint: ${input.checkpointId} (attested).`,
    `The previous transcript was NOT replayed and NO compaction was used — you start from a fresh context.`,
    ``,
    `Recover the project NOW, in this order (PROTOCOL §3): read AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md.`,
    `Manual prose in HANDOFF.md/PROGRESS.md takes precedence over the managed checkpoint block; the guard reports checkpoint freshness at session_start (refresh + re-attest with /handoff and /handoff ready if stale).`,
    `Then verify the build before touching code: ${input.testCommand ?? "node --test test/"}.`,
    ``,
    `Continue the project from HANDOFF.md "Next action". You keep full initiative: reason, investigate, challenge earlier assumptions, propose new work — recording evidence and classification (accepted/proposed/falsified) in LEARNINGS.md. You are not a task-list executor.`,
    `Keep committing coherent, tested increments locally as you work; never push without human authorization.`,
  ];
  if (input.extraNotes && input.extraNotes.trim()) lines.push(``, `Notes from the predecessor: ${input.extraNotes.trim()}`);
  return lines.join("\n");
}
