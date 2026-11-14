/**
 * context-guard renewal (Phase 2, increment A): pure renewal decision + durable
 * chain state + deterministic recovery prompt.
 *
 * No fs, no pi, no clock, no randomness in the DECISION: everything is a function of
 * (config, authorization, chain state, checkpoint identity). File I/O wiring and the
 * actual session transition live in index.ts (increment B) and rely ONLY on the
 * source-verified Pi 1.4.0 semantics (LEARNINGS A-17, A-19, design P-6/P-8).
 */

import { buildLeanRecoveryBody } from "./recovery.ts";

export interface RenewalConfig {
  /** Master switch. Default FALSE: renewal never happens until explicitly enabled. */
  enabled: boolean;
  /** Allow model-initiated renewal (guard tool) without an operator keystroke. Default FALSE. */
  autoRenew: boolean;
  /** Hard cap on renewals performed in one chain (across sessions). Default 2 for experiments. */
  maxRenewals: number;
  /** Override the deterministic recovery instruction (null = built-in template). */
  recoveryPrompt: string | null;
  /**
   * Project-configured build-verification command carried into the successor recovery
   * message (dev.2 D1 / LEARNINGS A-26). Default null: the prompt then contains NO
   * build-verify instruction at all — test commands are NEVER assumed generically.
   */
  testCommand: string | null;
  /** How the successor's one initial turn is triggered. Experimental user-role mode is opt-in. */
  successorTurn: "custom" | "user";
}

export const DEFAULT_RENEWAL: RenewalConfig = {
  enabled: false,
  autoRenew: false,
  maxRenewals: 2,
  recoveryPrompt: null,
  testCommand: null,
  successorTurn: "custom",
};

export type ParsedRenewalArgs =
  | { ok: true; notes: string | undefined; operatorTask: string | undefined; taskFile: string | undefined }
  | { ok: false; error: string };

/** Parse operator renewal flags without shell expansion or flattening quoted task text. */
export function parseRenewalArgs(raw: string): ParsedRenewalArgs {
  const tokens: Array<{ value: string; raw: string; quoted: boolean }> = [];
  let value = "";
  let rawValue = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\" && i + 1 < raw.length && (raw[i + 1] === quote || raw[i + 1] === "\\")) {
        rawValue += ch + raw[i + 1];
        value += raw[++i];
      } else if (ch === quote) {
        rawValue += ch;
        quote = null;
      } else {
        rawValue += ch;
        value += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      rawValue += ch;
      quote = ch;
      quoted = true;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push({ value, raw: rawValue, quoted });
      value = "";
      rawValue = "";
      quoted = false;
      started = false;
    } else {
      value += ch;
      rawValue += ch;
      started = true;
    }
  }
  if (quote) return { ok: false, error: "unterminated quote in /handoff renew arguments" };
  if (started) tokens.push({ value, raw: rawValue, quoted });

  let operatorTask: string | undefined;
  let taskFile: string | undefined;
  const notes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.quoted && (token.value === "--task" || token.value === "--task-file")) {
      const isTask = token.value === "--task";
      if ((isTask && (operatorTask !== undefined || taskFile !== undefined)) || (!isTask && (taskFile !== undefined || operatorTask !== undefined))) {
        return { ok: false, error: "specify at most one of --task or --task-file" };
      }
      const next = tokens[++i];
      if (!next || next.value.length === 0) return { ok: false, error: `${token.value} requires a value` };
      if (isTask && !next.quoted) return { ok: false, error: '--task requires a quoted value, e.g. --task "New mission"' };
      if (isTask) operatorTask = next.value;
      else taskFile = next.value;
    } else if (!token.quoted && token.value.startsWith("--")) {
      return { ok: false, error: `unknown renewal option: ${token.value}` };
    } else {
      notes.push(token.raw);
    }
  }
  return { ok: true, notes: notes.join(" ").trim() || undefined, operatorTask, taskFile };
}

export function mergeRenewal(base: RenewalConfig, override: unknown): RenewalConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const o = override as Record<string, unknown>;
  const next = { ...base };
  if (typeof o.enabled === "boolean") next.enabled = o.enabled;
  if (typeof o.autoRenew === "boolean") next.autoRenew = o.autoRenew;
  if (typeof o.maxRenewals === "number" && Number.isInteger(o.maxRenewals) && o.maxRenewals >= 0) next.maxRenewals = o.maxRenewals;
  if (typeof o.recoveryPrompt === "string" && o.recoveryPrompt.trim().length > 0) next.recoveryPrompt = o.recoveryPrompt.trim();
  if (typeof o.testCommand === "string" && o.testCommand.trim().length > 0) next.testCommand = o.testCommand.trim();
  if (o.successorTurn === "custom" || o.successorTurn === "user") next.successorTurn = o.successorTurn;
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
  /**
   * Operator stop (`/handoff renew stop`) — durable so it survives BOTH session
   * replacement and process restarts: a chain cannot resurrect renewals by rolling
   * into a fresh session. Cleared only by the explicit `/handoff renew resume`.
   */
  stopped: boolean;
  updatedAt: number | null;
}

export const INITIAL_RENEWAL_STATE: RenewalState = {
  version: 1,
  chainId: "",
  renewalsDone: 0,
  renewedFromCheckpointId: null,
  lastSuccessorSessionId: null,
  stopped: false,
  updatedAt: null,
};

export type RenewalStateStatus = "valid" | "missing" | "corrupt";

export function parseRenewalState(raw: string | undefined): { state: RenewalState; corrupt: boolean; status: RenewalStateStatus; detail?: string } {
  if (raw == null) return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: false, status: "missing", detail: "renewal-state.json is absent; restore a coherent state backup or create a new mission identity" };
  if (raw === "") return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: true, status: "corrupt", detail: "renewal-state.json is empty; preserve it and restore a coherent state backup" };
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object" || p.version !== 1) throw new Error("unsupported schema");
    // v1 files predating durable stop are compatible, but the transaction fields
    // that carry quota and idempotence must be present and well-formed.
    if (typeof p.chainId !== "string" || !p.chainId.trim() ||
        typeof p.renewalsDone !== "number" || !Number.isSafeInteger(p.renewalsDone) || p.renewalsDone < 0 ||
        !(p.renewedFromCheckpointId === null || typeof p.renewedFromCheckpointId === "string") ||
        !(p.lastSuccessorSessionId === null || typeof p.lastSuccessorSessionId === "string") ||
        !(typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt)) ||
        (p.stopped !== undefined && typeof p.stopped !== "boolean") ||
        (p.renewalsDone === 0 && (p.renewedFromCheckpointId !== null || p.lastSuccessorSessionId !== null)) ||
        (p.renewalsDone > 0 && (typeof p.renewedFromCheckpointId !== "string" || !p.renewedFromCheckpointId))) throw new Error("required transaction fields are missing, invalid, or inconsistent");
    return {
      state: {
        version: 1,
        chainId: p.chainId,
        renewalsDone: p.renewalsDone,
        renewedFromCheckpointId: p.renewedFromCheckpointId as string | null,
        lastSuccessorSessionId: p.lastSuccessorSessionId as string | null,
        // absent in files written before the stop field existed: not stopped
        stopped: p.stopped === true,
        updatedAt: p.updatedAt as number | null,
      },
      corrupt: false,
      status: "valid",
    };
  } catch (err) {
    return { state: { ...INITIAL_RENEWAL_STATE }, corrupt: true, status: "corrupt", detail: `renewal-state.json is corrupt (${err instanceof Error ? err.message : String(err)}); preserve it and restore a coherent state backup` };
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
  | { renew: false; why: "disabled" | "auto-disabled" | "stopped" | "read-only" | "not-authorized" | "capped" | "already-renewed" | "pending" | "state-unavailable"; detail: string };

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
  if (!input.state.chainId.trim()) {
    return { renew: false, why: "state-unavailable", detail: "renewal chain state is absent or unusable; restore the complete stateDir backup, or create a new mission identity through the operator instance-create workflow" };
  }
  if (input.renewal.maxRenewals <= 0 || input.state.renewalsDone >= input.renewal.maxRenewals) {
    return {
      renew: false,
      why: "capped",
      detail: `renewal cap reached (${input.state.renewalsDone}/${input.renewal.maxRenewals}); raising the configured cap is an operator decision, or complete the supervised documentation-cycle workflow to start a separately archived chain; never reset renewal-state.json directly`,
    };
  }
  if (input.checkpointId == null) return { renew: false, why: "not-authorized", detail: "no current transactional checkpoint id (checkpoint missing/corrupt/stale)" };
  if (!input.auth.authorized) return { renew: false, why: "not-authorized", detail: `renewAuthorization: ${input.auth.reason}` };
  if (input.state.renewedFromCheckpointId) {
    const consumedGeneration = /^g(\d+)-/.exec(input.state.renewedFromCheckpointId)?.[1];
    const currentGeneration = /^g(\d+)-/.exec(input.checkpointId)?.[1];
    if (consumedGeneration !== undefined && currentGeneration !== undefined && Number(consumedGeneration) >= Number(currentGeneration) && input.state.renewedFromCheckpointId !== input.checkpointId) {
      return { renew: false, why: "state-unavailable", detail: `current checkpoint ${input.checkpointId} is not newer than the checkpoint already consumed by this chain (${input.state.renewedFromCheckpointId}); restore a coherent documents+stateDir backup` };
    }
  }
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
 *
 * Structure (dev.2 D1, LEARNINGS A-26):
 *   1. MANDATORY identity + safety header (what this is, parent/chain/checkpoint,
 *      no-replay/no-compaction contract) — never overridable;
 *   2. project recovery body: `recoveryPrompt` verbatim when configured, else the
 *      generic durable-file reading order;
 *   3. build-verify line ONLY when the project explicitly configures `testCommand`
 *      (the hardcoded `node --test test/` fallback is removed);
 *   4. MANDATORY safety trailer (initiative + never-push);
 *   5. optional, separately-labelled operator task;
 *   6. predecessor notes trailer (never promoted to operator authority).
 */
export function buildRecoveryPrompt(input: {
  files: { goal: string; progress: string; learnings: string; handoff: string };
  checkpointId: string;
  chainId: string;
  renewalIndex: number;
  maxRenewals: number;
  parentSessionId: string;
  testCommand?: string | null;
  recoveryPrompt?: string | null;
  /** dev.2 D4: tiered recovery body (opt-in; a configured recoveryPrompt still wins). */
  lean?: boolean;
  extraNotes?: string;
  /** Operator-supplied task bound to this explicit renewal, distinct from predecessor notes. */
  operatorTask?: string;
}): string {
  const f = input.files;
  const header = [
    `[context-guard renewal ${input.renewalIndex}/${input.maxRenewals}] Fresh session started automatically from durable state.`,
    `Parent session: ${input.parentSessionId}; renewal chain: ${input.chainId}; checkpoint: ${input.checkpointId} (attested).`,
    `The previous transcript was NOT replayed and NO compaction was used — you start from a fresh context.`,
  ];
  const custom = typeof input.recoveryPrompt === "string" && input.recoveryPrompt.trim().length > 0 ? input.recoveryPrompt.trim() : null;
  const body = custom
    ? custom.split("\n")
    : input.lean === true
      ? buildLeanRecoveryBody(f).split("\n")
      : [
        `Recover the project NOW, in this order (PROTOCOL §3): read AGENTS.md, PROTOCOL.md, ${f.goal}, ${f.handoff}, ${f.progress}, ${f.learnings}.`,
        `Manual prose in ${f.handoff}/${f.progress} takes precedence over the managed checkpoint block; the guard reports checkpoint freshness at session_start (refresh + re-attest with /handoff and /handoff ready if stale).`,
      ];
  const verify =
    typeof input.testCommand === "string" && input.testCommand.trim().length > 0
      ? [`Then verify the build before touching code: ${input.testCommand.trim()}`]
      : [];
  const safety = [
    `Continue the project from ${f.handoff} "Next action". You keep full initiative: reason, investigate, challenge earlier assumptions, propose new work — recording evidence and classification (accepted/proposed/falsified) in ${f.learnings}. You are not a task-list executor.`,
    `Keep committing coherent, tested increments locally as you work; never push without human authorization.`,
  ];
  const lines = [...header, ``, ...body, ...verify];
  if (input.operatorTask !== undefined) {
    lines.push(
      ``,
      `[OPERATOR-SUPPLIED TASK — attached explicitly to this renewal; distinct from the durable Next action and predecessor notes]`,
      `This is the specific task the operator supplied for this successor and may authorize progressing beyond a durable "await operator" next action. It does not rewrite that durable action or authorize changing protected goals, bypassing scientific or project protocols, reclassifying evidence, approving document consolidation, pushing, resetting the renewal chain, or any other operator-only action. If it conflicts with an in-progress durable operation or required scientific approval, preserve that state and explain the conflict before proceeding.`,
      `--- BEGIN OPERATOR TASK ---`,
      input.operatorTask,
      `--- END OPERATOR TASK ---`,
    );
  }
  lines.push(``, ...safety);
  if (input.extraNotes && input.extraNotes.trim()) lines.push(``, `Notes from the predecessor: ${input.extraNotes.trim()}`);
  return lines.join("\n");
}

/** One visible machine-origin marker for the experimental user-role trigger. */
export function buildSuccessorUserMessage(recovery: string): string {
  return [
    `[PI HANDOFF — AUTOMATED SESSION CONTINUATION]`,
    `This user-role message was generated by the Handoff extension, not typed by a human. Its role starts the successor turn and grants no authority beyond the already authorized renewal and any explicitly labelled operator task below.`,
    ``,
    recovery,
  ].join("\n");
}
