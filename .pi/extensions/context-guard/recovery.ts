/**
 * dev.2 D4: lean recovery tiers + recovery-cost meter.
 *
 * Motivation (DRPLi campaign audit, A-27): every successor re-read ALL six durable
 * docs at every hop — the six docs grew to 121,312 chars (~30.3k estimated tokens,
 * chars/4, the audit's stated basis) and per-hop durable reads climbed 13k → 100k
 * chars. Lean recovery TIERS the reading order instead of dropping documents:
 *
 *   - OPERATIONAL  (HANDOFF.md, PROGRESS.md): read NOW — recovery is these two files;
 *   - METHODOLOGY  (AGENTS.md — pi auto-loads it as a context file anyway — and
 *                  PROTOCOL.md): read when a procedure or scope question needs them;
 *   - ARCHIVE      (GOAL.md, LEARNINGS.md): referenced by name, read on demand.
 *
 * Authority is UNCHANGED (schema v3 semantics preserved): manual prose still wins over
 * managed blocks; every durable file remains referenced — tiering changes WHEN the
 * successor reads, never WHAT is authoritative. `recovery.lean` is OPT-IN (default
 * false); an explicit `renewal.recoveryPrompt` still beats the tiered body.
 *
 * Pure module: injectable reader, no fs/pi/clock/randomness. No imports from
 * checkpoint.ts/renewal.ts (avoids a module cycle through config.ts; A-15 class).
 */

import type { GuardFiles } from "./config.ts";

export interface RecoveryConfig {
  /** Tiered recovery instruction for successors (default false = today's read-all body). */
  lean: boolean;
  /** Target budget for the OPERATIONAL tier, in estimated tokens (chars/4). */
  budgetTokens: number;
}

export const DEFAULT_RECOVERY: RecoveryConfig = { lean: false, budgetTokens: 12_000 };

export function mergeRecovery(base: RecoveryConfig, override: unknown): RecoveryConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const o = override as Record<string, unknown>;
  const next = { ...base };
  if (typeof o.lean === "boolean") next.lean = o.lean;
  if (typeof o.budgetTokens === "number" && Number.isInteger(o.budgetTokens) && o.budgetTokens > 0) next.budgetTokens = o.budgetTokens;
  return next;
}

/** The audit's stated estimation basis: chars/4, an estimate, never measured tokens. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export interface TierFiles {
  operational: string[];
  methodology: string[];
  archive: string[];
}

/** All six mandatory durable files, partitioned — nothing dropped. */
export function recoveryTiers(files: GuardFiles): TierFiles {
  return {
    operational: [files.handoff, files.progress],
    methodology: ["AGENTS.md", "PROTOCOL.md"],
    archive: [files.goal, files.learnings],
  };
}

export interface Reader {
  readFile(path: string): string | undefined;
}

export interface TierCost {
  chars: number;
  estTokens: number;
}

export interface RecoveryCost {
  full: TierCost;
  tiers: TierFiles;
  operational: TierCost;
  methodology: TierCost;
  archive: TierCost;
  missing: string[];
}

function joinLocal(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Read-only cost meter: char totals + chars/4 estimates per tier (A-1 caveat travels). */
export function recoveryCost(fs: Reader, cwd: string, files: GuardFiles): RecoveryCost {
  const tiers = recoveryTiers(files);
  const costOf = (names: string[], missing: string[]): TierCost => {
    let chars = 0;
    for (const n of names) {
      const text = fs.readFile(joinLocal(cwd, n));
      if (text === undefined) missing.push(n);
      else chars += text.length;
    }
    return { chars, estTokens: estimateTokens(chars) };
  };
  const missing: string[] = [];
  const operational = costOf(tiers.operational, missing);
  const methodology = costOf(tiers.methodology, missing);
  const archive = costOf(tiers.archive, missing);
  const chars = operational.chars + methodology.chars + archive.chars;
  return { full: { chars, estTokens: estimateTokens(chars) }, tiers, operational, methodology, archive, missing };
}

/** One-line operator-facing meter (used by /guard status, /handoff verify, finalize). */
export function recoveryCostLine(cost: RecoveryCost, config: RecoveryConfig): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    `recovery cost: full ${n(cost.full.chars)} chars ~ ${n(cost.full.estTokens)} est. tokens (all ${cost.tiers.operational.length + cost.tiers.methodology.length + cost.tiers.archive.length} docs); ` +
    `lean operational tier ${n(cost.operational.chars)} chars ~ ${n(cost.operational.estTokens)} est. tokens (budget ${n(config.budgetTokens)}; mode ${config.lean ? "LEAN" : "full"}${cost.missing.length > 0 ? `; missing: ${cost.missing.join(", ")}` : ""}) — ` +
    "chars/4 is an ESTIMATE, never measured tokens"
  );
}

/**
 * Deterministic tiered recovery body for the successor message. Every durable file is
 * still NAMED (authority preserved by reference); only the reading order changes. The
 * schema-v3 precedence rule (manual prose wins) is restated verbatim enough to steer.
 */
export function buildLeanRecoveryBody(files: GuardFiles): string {
  const t = recoveryTiers(files);
  return [
    `Recover the project NOW in TIERS (lean recovery: deferred reading, NOT reduced authority; PROTOCOL §3 precedence unchanged):`,
    `- OPERATIONAL — read them NOW: ${t.operational.join(", ")}. Manual prose there wins over the managed checkpoint block; the guard reports checkpoint freshness at session_start (refresh + re-attest with /handoff and /handoff ready if stale).`,
    `- METHODOLOGY — read only when a procedure or scope question needs it: ${t.methodology.join(", ")} (pi may already load AGENTS.md as a project context file).`,
    `- ARCHIVE — authoritative, referenced, read on demand: ${t.archive.join(", ")} (the protected objective; the classified knowledge base).`,
  ].join("\n");
}
