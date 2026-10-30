/**
 * dev.2 D5: structured diagnostics — a bounded, typed event trail the guard writes to
 * `<stateDir>/diagnostics.jsonl` so interruptions and gate decisions can be CLASSIFIED
 * after the fact (DRPLi campaign audit, LEARNINGS A-27/P-10: 17 abort events, two
 * manual recoveries, cause unknown — speculation must be replaceable by evidence).
 *
 * Pure module: caller injects FsOps + clock; no pi imports, no randomness.
 *
 * Hard privacy rule (mission D5c): events carry ONLY guard-authored, allowlisted,
 * length-bounded fields. NO prompts, NO tool arguments, NO file contents, NO secrets:
 * unknown keys are DROPPED at build time, so there is no channel through which model
 * or tool payloads could leak. `agent_settled.aborted` is RECORDED as the interruption
 * signal — the guard never retries an aborted generation automatically (P-10).
 *
 * Audit mode: persistence follows the runtime-state rule (PROTOCOL §2.3) — the caller
 * records only when `canPersistState()` holds, i.e. never with an in-tree stateDir in
 * read-only mode, only outside the tree when the stateDir is external.
 */

import { joinPath, type FsOps } from "./checkpoint.ts";

export const DIAGNOSTICS_FILE = "diagnostics.jsonl";
export const DIAGNOSTICS_MAX_ENTRIES = 500;

/** Closed vocabulary — the ONLY event types that may be persisted. */
export const DIAGNOSTIC_TYPES = ["session_start", "alert", "revocation", "renewal_request", "renewal_result", "finalize", "tool_block", "turn_aborted"] as const;
export type DiagnosticType = (typeof DIAGNOSTIC_TYPES)[number];

/** Allowlisted field names. Anything else is dropped before serialization. */
export const DIAGNOSTIC_FIELD_KEYS = ["session", "reason", "trigger", "level", "remaining", "crossed", "boundary", "revoked", "checkpoint", "chain", "renewalsDone", "maxRenewals", "ok", "why", "tool", "kind", "dry", "aborted", "detail"] as const;
export type DiagnosticFieldKey = (typeof DIAGNOSTIC_FIELD_KEYS)[number];

export interface DiagnosticEvent {
  ts: string;
  epoch: number;
  type: DiagnosticType;
  [field: string]: unknown;
}

const TYPE_ALLOW = new Set<string>(DIAGNOSTIC_TYPES);
const FIELD_ALLOW = new Set<string>(DIAGNOSTIC_FIELD_KEYS);
const STRING_BOUND = 300;
const LIST_BOUND = 12;

/**
 * Build one event: ISO + epoch stamps, type allowlist enforced (unknown type -> null),
 * unknown/null fields dropped, strings and lists bounded. Deterministic given `now`.
 */
export function buildDiagnosticEvent(type: string, fields: Record<string, unknown> = {}, now: number = Date.now()): DiagnosticEvent | null {
  if (!TYPE_ALLOW.has(type) || !Number.isFinite(now)) return null;
  const event: DiagnosticEvent = { ts: new Date(now).toISOString(), epoch: Math.floor(now), type };
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOW.has(key) || value === undefined || value === null) continue;
    if (typeof value === "string") event[key] = value.slice(0, STRING_BOUND);
    else if (typeof value === "number" || typeof value === "boolean") event[key] = value;
    else if (Array.isArray(value)) event[key] = value.map((v) => String(v).slice(0, 100)).slice(0, LIST_BOUND);
    // objects/other shapes are DROPPED: never smuggle structured payloads
  }
  return event;
}

export function diagnosticsPath(stateDir: string): string {
  return joinPath(stateDir, DIAGNOSTICS_FILE);
}

/** Append (JSONL, one line per event) with size rotation: the LAST `max` entries survive. */
export function appendDiagnostic(fs: FsOps, stateDir: string, event: DiagnosticEvent, max: number = DIAGNOSTICS_MAX_ENTRIES): { ok: boolean; error?: string } {
  try {
    const path = diagnosticsPath(stateDir);
    const lines = (fs.readFile(path) ?? "").split("\n").filter((l) => l.trim().length > 0);
    lines.push(JSON.stringify(event));
    const kept = lines.length > max ? lines.slice(lines.length - max) : lines;
    fs.mkdirRecursive(stateDir);
    fs.writeFile(path, kept.join("\n") + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }; // diagnostics never break the guard
  }
}

/** Read the last `n` structurally valid events (corrupt lines skipped, never thrown). */
export function recentDiagnostics(fs: FsOps, stateDir: string, n = 20): DiagnosticEvent[] {
  const raw = fs.readFile(diagnosticsPath(stateDir));
  if (raw == null) return [];
  const parsed: DiagnosticEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const p = JSON.parse(t) as unknown;
      if (p && typeof p === "object" && typeof (p as DiagnosticEvent).ts === "string" && typeof (p as DiagnosticEvent).type === "string" && TYPE_ALLOW.has((p as DiagnosticEvent).type)) {
        parsed.push(p as DiagnosticEvent);
      }
    } catch {
      /* corrupt line: skipped */
    }
  }
  return parsed.slice(Math.max(0, parsed.length - Math.max(1, n)));
}

/** Operator-facing one-line rendering (used by `/guard events`). */
export function formatDiagnosticEvent(e: DiagnosticEvent): string {
  const kv = Object.entries(e)
    .filter(([k]) => k !== "ts" && k !== "epoch" && k !== "type")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v).slice(0, 120)}`);
  return `${e.ts} ${e.type}${kv.length > 0 ? ` ${kv.join(" ")}` : ""}`;
}
