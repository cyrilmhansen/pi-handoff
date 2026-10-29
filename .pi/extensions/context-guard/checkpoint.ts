/**
 * context-guard checkpoint module: crash-safe durable working memory.
 *
 * Injectable filesystem operations so tests can simulate write failures and
 * partially written files without touching the real disk layout.
 * No pi imports; safe for Node type-stripped execution.
 */

import { createHash } from "node:crypto";
import fsDefault from "node:fs";
import pathDefault from "node:path";

import type { GuardFiles } from "./config.ts";
import { parseRenewalState, serializeRenewalState, type RenewalState } from "./renewal.ts";

export interface FsOps {
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void; // must be atomic where durability matters
  exists(path: string): boolean;
  mkdirRecursive(path: string): void;
  listFiles(dir: string): string[];
  remove(path: string): void;
  /** Canonical path with symlinks resolved; undefined when unsupported/unresolvable. */
  realpath?(path: string): string | undefined;
  /** Last-modified time in ms (coarse liveness signal for pruning). */
  mtimeMs?(path: string): number | undefined;
}

export function createLocalFs(): FsOps {
  const fs = fsDefault;
  const path = pathDefault;
  return {
    readFile(p) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile(p, content) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, p); // atomic replace on POSIX
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore cleanup errors */
        }
        throw err;
      }
    },
    exists(p) {
      return fs.existsSync(p);
    },
    mkdirRecursive(p) {
      fs.mkdirSync(p, { recursive: true });
    },
    listFiles(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    remove(p) {
      fs.rmSync(p, { force: true });
    },
    realpath(p) {
      try {
        return fs.realpathSync(p);
      } catch {
        // missing tail: resolve the nearest existing ancestor and re-join
        let base = path.resolve(p);
        const tail: string[] = [];
        for (;;) {
          const parent = path.dirname(base);
          if (parent === base) break;
          tail.unshift(path.basename(base));
          base = parent;
          try {
            return path.join(fs.realpathSync(base), ...tail);
          } catch {
            /* keep walking up */
          }
        }
        return undefined;
      }
    },
    mtimeMs(p) {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function joinPath(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  return dir.length === 0 ? name : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Absolute, `.`/`..`-free path. Never compare paths as raw strings. */
export function normalizePath(p: string): string {
  return pathDefault.normalize(p.startsWith("/") ? p : pathDefault.resolve(process.cwd(), p));
}

/**
 * Lexical containment by RELATIVE PATH — no string-prefix comparisons, which treat
 * `/project-evil` as inside `/project` and accept `a/../b` unnormalized.
 */
export function isLexicallyInside(child: string, parent: string): boolean {
  const rel = pathDefault.relative(normalizePath(parent), normalizePath(child));
  return rel === "" || (!rel.startsWith("..") && !pathDefault.isAbsolute(rel));
}

/**
 * Containment check that also follows symlinks: a path is "inside the tree" when it is
 * lexically inside the root, or when either side resolves (symlinks) inside the root.
 * A tree-resident symlink (e.g. `.pi-guard -> /elsewhere`) counts as part of the tree:
 * writing through it changes what the audited snapshot references.
 */
export function isInsideTree(fs: FsOps, child: string, root: string): boolean {
  if (isLexicallyInside(child, root)) return true;
  const realRoot = fs.realpath?.(root) ?? normalizePath(root);
  const realChild = fs.realpath?.(child);
  if (realChild != null && isLexicallyInside(realChild, realRoot)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Managed sections: guard-owned regions that never clobber agent text */
/* ------------------------------------------------------------------ */

const BEGIN = (section: string) => `<!-- guard:begin ${section} -->`;
const END = (section: string) => `<!-- guard:end ${section} -->`;

/**
 * Replace (or append) the managed block for `section`. Everything outside the
 * markers — the model's own initiative, notes and discoveries — is preserved
 * byte-for-byte.
 */
export function replaceManagedSection(content: string, section: string, inner: string): string {
  const begin = BEGIN(section);
  const end = END(section);
  const block = `${begin}\n${inner.trim()}\n${end}`;
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start >= 0 && stop > start) {
    return content.slice(0, start) + block + content.slice(stop + end.length);
  }
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  // Nothing is inserted between the agent's own bytes and the marker: appended
  // managed blocks never alter the existing prose, not even by one newline.
  return `${content}${sep}${block}\n`;
}

export function extractManagedSection(content: string, section: string): string | undefined {
  const begin = BEGIN(section);
  const end = END(section);
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start < 0 || stop < 0 || stop <= start) return undefined;
  return content.slice(start + begin.length, stop).trim();
}

/* ------------------------------------------------------------------ */
/* Guard state file (crash-safe persistence of the state machine)      */
/* ------------------------------------------------------------------ */

export interface PersistedGuardState {
  version: 2;
  sessionId: string;
  updatedAt: number;
  snapshot: {
    currentLevel: number;
    alertedLevels: number[];
    unknownStreak: number;
    degraded: boolean;
    lastRemaining: number | null;
    evaluations: number;
  };
  goalHash?: string;
  checkpointOk?: boolean;
  /** Freshness class of the durable checkpoint at last persist (audit trail). */
  checkpointFreshness?: CheckpointFreshnessKind;
  /** Transactional id of the last checkpoint written/seen by THIS session. */
  checkpointId?: string;
  /** Semantic readiness of that checkpoint (attested / unattested / invalid / none). */
  handoffReady?: ReadinessState | "none";
  /** sha256 of LEARNINGS.md at session start (readiness warning baseline). */
  learningsHash?: string;
  notes?: string;
}

export type StateLoadResult =
  | { kind: "found"; state: PersistedGuardState; migrated?: "self"; repairsSuppressed?: string[] }
  | { kind: "missing"; foreignMigrated?: string; legacyRemoved?: boolean; repairsSuppressed?: string[] }
  | { kind: "corrupt"; detail: string; backupPath?: string; repairsSuppressed?: string[] };

/** What a read-only inspection found, and what a normal load WOULD repair. */
export interface StateInspection {
  kind: "found" | "missing" | "corrupt";
  state?: PersistedGuardState;
  detail?: string;
  /** Repairs a normal (mutating) load would perform — none of these were performed. */
  pendingRepairs: string[];
  legacyOwnerSession?: string;
}

/** Legacy single-slot runtime state (v1); superseded by per-session files. */
export function legacyStatePath(stateDir: string): string {
  return joinPath(stateDir, "state.json");
}

export function sessionsDirPath(stateDir: string): string {
  return joinPath(stateDir, "sessions");
}

/** Session ids become filesystem-safe names; anything unexpected is hashed. */
export function safeSessionId(sessionId: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(sessionId) ? sessionId : `anon-${sha256(sessionId).slice(0, 16)}`;
}

export function sessionStatePath(stateDir: string, sessionId: string): string {
  return joinPath(sessionsDirPath(stateDir), `${safeSessionId(sessionId)}.json`);
}

/**
 * Save per-session runtime state to `<stateDir>/sessions/<sessionId>.json`.
 * Parallel or sequential sessions never share a file, so one session can no
 * longer overwrite another's snapshot (Phase 1b audit finding).
 */
export function saveGuardState(fs: FsOps, stateDir: string, state: PersistedGuardState): { ok: boolean; error?: string } {
  try {
    fs.mkdirRecursive(sessionsDirPath(stateDir));
    fs.writeFile(sessionStatePath(stateDir, state.sessionId), JSON.stringify(state, null, 2) + "\n");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseState(raw: string): PersistedGuardState {
  const parsed = JSON.parse(raw) as PersistedGuardState;
  if (!parsed || typeof parsed !== "object" || (parsed.version !== 1 && parsed.version !== 2) || typeof parsed.sessionId !== "string" || !parsed.snapshot) {
    throw new Error("schema");
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Renewal chain state (Phase 2): ONE durable file per state dir.      */
/* Unlike per-session guard state this MUST survive session            */
/* replacement and process restarts — the renewal cap, the             */
/* idempotence key and the operator stop live here (LEARNINGS A-17.4). */
/* ------------------------------------------------------------------ */

export const RENEWAL_STATE_FILE = "renewal-state.json";

export function renewalStatePath(stateDir: string): string {
  return joinPath(stateDir, RENEWAL_STATE_FILE);
}

/** Read the durable renewal chain state. Never throws; corruption is reported, initial state returned. */
export function loadRenewalState(fs: FsOps, stateDir: string): { state: RenewalState; corrupt: boolean } {
  return parseRenewalState(fs.readFile(renewalStatePath(stateDir)));
}

/** Atomic write (FsOps.writeFile is temp+rename on the local fs). */
export function saveRenewalState(fs: FsOps, stateDir: string, state: RenewalState): { ok: boolean; error?: string } {
  try {
    fs.mkdirRecursive(stateDir);
    fs.writeFile(renewalStatePath(stateDir), serializeRenewalState(state));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function cleanTmpFiles(fs: FsOps, dir: string, dryRun = false): string[] {
  const removed: string[] = [];
  for (const name of fs.listFiles(dir)) {
    if (name.includes(".tmp-")) {
      if (dryRun) {
        removed.push(joinPath(dir, name));
        continue;
      }
      try {
        fs.remove(joinPath(dir, name));
        removed.push(joinPath(dir, name));
      } catch {
        /* best effort */
      }
    }
  }
  return removed;
}

function quarantine(fs: FsOps, path: string, raw: string): string {
  const backup = `${path}.corrupt-${Date.now()}.bak`;
  try {
    fs.writeFile(backup, raw);
    fs.remove(path);
  } catch {
    /* quarantine best effort */
  }
  return backup;
}

/** Newer-wins check so a still-running v1 writer cannot lose its latest snapshot to an older migrated copy. */
function shouldReplaceState(fs: FsOps, targetPath: string, incomingUpdatedAt: number): boolean {
  const cur = fs.readFile(targetPath);
  if (cur === undefined) return true;
  try {
    return (Number(parseState(cur).updatedAt) || 0) < incomingUpdatedAt;
  } catch {
    return true;
  }
}

/**
 * READ-ONLY inspection of runtime state: the audit-mode counterpart of
 * loadGuardState(). It reads, parses and classifies, and reports the repairs it
 * would perform — it performs none of them (no writes, deletes, renames or
 * migrations, even when legacy/corrupt/temp state is already present).
 */
export function inspectGuardState(fs: FsOps, stateDir: string, sessionId: string): StateInspection {
  const pendingRepairs: string[] = [];
  for (const dir of [stateDir, sessionsDirPath(stateDir)]) {
    for (const name of fs.listFiles(dir)) {
      if (name.includes(".tmp-")) pendingRepairs.push(`remove stale temp file ${joinPath(dir, name)}`);
    }
  }

  const ownPath = sessionStatePath(stateDir, sessionId);
  const legacyPath = legacyStatePath(stateDir);
  let legacy: PersistedGuardState | undefined;
  let legacyJunk = false;
  const legacyRaw = fs.readFile(legacyPath);
  if (legacyRaw !== undefined) {
    try {
      legacy = parseState(legacyRaw);
      pendingRepairs.push(`migrate legacy ${legacyPath} to sessions/<owner>.json (owner ${legacy.sessionId})`);
    } catch {
      legacyJunk = true;
      pendingRepairs.push(`quarantine corrupt legacy state ${legacyPath}`);
    }
  }

  const ownRaw = fs.readFile(ownPath);
  if (ownRaw === undefined) {
    if (legacyJunk) return { kind: "corrupt", detail: "legacy state file is corrupt (inspection only: nothing was quarantined)", pendingRepairs };
    return { kind: "missing", pendingRepairs, legacyOwnerSession: legacy?.sessionId };
  }
  try {
    const own = parseState(ownRaw);
    return { kind: "found", state: own, pendingRepairs, legacyOwnerSession: legacy?.sessionId };
  } catch (err) {
    if (legacy) {
      return { kind: "found", state: { ...legacy, version: 2 }, pendingRepairs: [...pendingRepairs, `quarantine corrupt ${ownPath}`], legacyOwnerSession: legacy.sessionId };
    }
    return { kind: "corrupt", detail: `own session state is corrupt (${err instanceof Error ? err.message : String(err)}); inspection only — nothing was quarantined`, pendingRepairs };
  }
}

/**
 * Load THIS session's runtime state from `<stateDir>/sessions/<sessionId>.json`.
 * Corrupt JSON is quarantined to a timestamped backup; only the affected
 * session's file is touched. Migration: a legacy single-slot `state.json` is
 * reconciled by `updatedAt` — whichever copy of a session's state is newer
 * wins (a still-running v1 writer may re-create `state.json` after migration),
 * and every copy is filed under its owning session id, never another's.
 *
 * `options.readOnly` switches to pure inspection: ZERO writes/deletes/renames,
 * which is what audit mode requires (Phase 1c: the old implementation repaired
 * state even in read-only sessions, mutating the audited tree).
 */
export function loadGuardState(fs: FsOps, stateDir: string, sessionId: string, options: { readOnly?: boolean } = {}): StateLoadResult {
  if (options.readOnly) {
    const view = inspectGuardState(fs, stateDir, sessionId);
    if (view.kind === "found" && view.state) {
      return { kind: "found", state: view.state, repairsSuppressed: view.pendingRepairs };
    }
    if (view.kind === "corrupt") return { kind: "corrupt", detail: view.detail, repairsSuppressed: view.pendingRepairs };
    return { kind: "missing", foreignMigrated: view.legacyOwnerSession, repairsSuppressed: view.pendingRepairs };
  }

  cleanTmpFiles(fs, stateDir);
  cleanTmpFiles(fs, sessionsDirPath(stateDir));

  const ownPath = sessionStatePath(stateDir, sessionId);
  const legacyPath = legacyStatePath(stateDir);

  // 1. Legacy v1 reconciliation.
  let legacy: PersistedGuardState | undefined;
  const legacyRaw = fs.readFile(legacyPath);
  if (legacyRaw !== undefined) {
    try {
      legacy = parseState(legacyRaw);
      fs.remove(legacyPath);
    } catch (err) {
      if (fs.readFile(ownPath) === undefined) {
        // nothing else to fall back on: report the corruption
        const backup = quarantine(fs, legacyPath, legacyRaw);
        return { kind: "corrupt", detail: `legacy state file: ${err instanceof Error ? err.message : String(err)}`, backupPath: backup };
      }
      quarantine(fs, legacyPath, legacyRaw); // our own file survives; legacy is junk
    }
  }

  // 2. Our per-session file.
  let own: PersistedGuardState | undefined;
  let ownCorrupt = false;
  const ownRaw = fs.readFile(ownPath);
  if (ownRaw !== undefined) {
    try {
      own = parseState(ownRaw);
    } catch (err) {
      ownCorrupt = true;
      const backup = quarantine(fs, ownPath, ownRaw);
      if (!legacy) return { kind: "corrupt", detail: err instanceof Error ? err.message : String(err), backupPath: backup };
    }
  }

  // 3. Merge decision: newest state for THIS session wins.
  if (legacy && legacy.sessionId === sessionId) {
    const normalized: PersistedGuardState = { ...legacy, version: 2 };
    if (!own || (Number(normalized.updatedAt) || 0) > (Number(own.updatedAt) || 0)) {
      if (!ownCorrupt) {
        try {
          fs.mkdirRecursive(sessionsDirPath(stateDir));
          fs.writeFile(ownPath, JSON.stringify(normalized, null, 2) + "\n");
        } catch {
          /* write failure: still restore in memory */
        }
      }
      return { kind: "found", state: normalized, migrated: "self" };
    }
    return { kind: "found", state: own };
  }
  if (legacy) {
    // belongs to another session: preserve it under ITS name
    const target = sessionStatePath(stateDir, legacy.sessionId);
    try {
      if (shouldReplaceState(fs, target, Number(legacy.updatedAt) || 0)) {
        fs.mkdirRecursive(sessionsDirPath(stateDir));
        fs.writeFile(target, JSON.stringify({ ...legacy, version: 2 }, null, 2) + "\n");
      }
    } catch {
      /* best effort: legacy content was still removed above */
    }
  }
  if (own) return { kind: "found", state: own };
  return legacy && !ownCorrupt ? { kind: "missing", foreignMigrated: legacy.sessionId, legacyRemoved: true } : { kind: "missing" };
}

/**
 * Retention: keep the `keep` most recently updated FOREIGN session files.
 * `keep <= 0` (the Phase 1c default) DISABLES pruning entirely: without OS-level
 * process-liveness detection, deleting another session's state while that process is
 * still running is unsafe (a live session would silently lose its snapshot). A coarse
 * age floor (`minAgeMs`, default 1 hour) guards the opt-in path for the same reason.
 * Runtime state is ephemeral; durable checkpoints are markdown files and are never
 * touched here.
 */
export const PRUNE_MIN_AGE_MS = 3_600_000;

export function pruneSessionStates(
  fs: FsOps,
  stateDir: string,
  keep: number,
  currentSessionId: string,
  options: { minAgeMs?: number; now?: number } = {},
): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return []; // disabled: unsafe to delete possibly-live state
  const minAge = options.minAgeMs ?? PRUNE_MIN_AGE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  const dir = sessionsDirPath(stateDir);
  const entries: Array<{ path: string; updatedAt: number; lastTouch: number }> = [];
  for (const name of fs.listFiles(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = joinPath(dir, name);
    if (name === `${safeSessionId(currentSessionId)}.json`) continue;
    try {
      const parsed = parseState(fs.readFile(p)!);
      const mtime = fs.mtimeMs?.(p);
      entries.push({ path: p, updatedAt: Number(parsed.updatedAt) || 0, lastTouch: Math.max(Number(parsed.updatedAt) || 0, mtime ?? 0) });
    } catch {
      /* keep unknown files */
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of entries.slice(Math.max(0, keep))) {
    if (now - e.lastTouch < minAge) continue; // may belong to a live process: never prune
    try {
      fs.remove(e.path);
      removed.push(e.path);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* Required-section validation for the four durable files              */
/* ------------------------------------------------------------------ */

export const REQUIRED_SECTIONS: Record<keyof GuardFilesInput, string[]> = {
  goal: ["## Objective", "## Acceptance criteria"],
  progress: ["## Current phase", "## Completed", "## Pending", "## Verified evidence", "## Blockers", "## Next action"],
  learnings: ["## Accepted", "## Proposed", "## Falsified or superseded"],
  handoff: ["## Recovery instructions", "## Last verified state", "## Unfinished operations", "## Next action", "## Discoveries not yet incorporated"],
};

export interface GuardFilesInput {
  goal: string;
  progress: string;
  learnings: string;
  handoff: string;
}

export interface FileValidation {
  file: string;
  ok: boolean;
  missingSections: string[];
  unreadable: boolean;
}

export function validateFile(fs: FsOps, file: string, kind: keyof GuardFilesInput): FileValidation {
  const content = fs.readFile(file);
  if (content === undefined) return { file, ok: false, missingSections: REQUIRED_SECTIONS[kind], unreadable: true };
  const missingSections = REQUIRED_SECTIONS[kind].filter((s) => !content.includes(s));
  return { file, ok: missingSections.length === 0, missingSections, unreadable: false };
}

export function validateAll(fs: FsOps, cwd: string, files: GuardFiles): FileValidation[] {
  return (Object.keys(files) as (keyof GuardFiles)[]).map((kind) => validateFile(fs, joinPath(cwd, files[kind]), kind));
}

/* ------------------------------------------------------------------ */
/* Checkpoint freshness: content fingerprints of the source state      */
/* ------------------------------------------------------------------ */

export const CHECKPOINT_SCHEMA = 3;
/** Schema written by Phase 1b (source hashes, no transactional identity). */
export const CHECKPOINT_SCHEMA_PREVIOUS = 2;
export const DEFAULT_CONFIG_NAME = "handoff.config.json";

export const IDENTITY_KEY = "checkpoint-id";
export const GENERATION_KEY = "checkpoint-generation";
export const READINESS_KEY = "readiness";
export const READINESS_BY_KEY = "readiness-by";
export const READINESS_AT_KEY = "readiness-at";
export const READINESS_TARGET_KEY = "readiness-checkpoint";
export const DELTA_KEY = "content-delta";
export const KIND_KEY = "checkpoint-kind";

/** Source-state keys fingerprinted inside every managed checkpoint block. */
export const CHECKPOINT_SOURCE_KEYS = ["source-goal", "source-progress", "source-handoff", "source-learnings", "source-config"] as const;

/**
 * Remove a managed block (marker lines included) so a file's *manual* prose
 * can be hashed without including guard-managed content. This is what breaks
 * the circularity: the checkpoint block stores hashes of the prose, never of
 * the file that embeds the block itself.
 */
export function stripManagedSection(content: string, section = "checkpoint"): string {
  const begin = BEGIN(section);
  const end = END(section);
  const start = content.indexOf(begin);
  if (start < 0) return content;
  const stop = content.indexOf(end, start);
  if (stop < 0) return content;
  return content.slice(0, start) + content.slice(stop + end.length);
}

export interface CheckpointSources {
  entries: Record<string, string>;
  fingerprint: string;
}

/**
 * Fingerprint the relevant source state. GOAL.md and LEARNINGS.md are hashed
 * whole (the guard never writes them); PROGRESS.md and HANDOFF.md are hashed
 * with their managed blocks stripped (manual prose only). Config and missing
 * files hash to the literal "absent".
 */
export function checkpointSources(fs: FsOps, cwd: string, files: GuardFiles, configName = DEFAULT_CONFIG_NAME): CheckpointSources {
  const rawHash = (p: string) => {
    const c = fs.readFile(p);
    return c === undefined ? "absent" : sha256(c);
  };
  const proseHash = (p: string) => {
    const c = fs.readFile(p);
    // A file that is absent, or contains nothing but managed blocks, hashes as
    // "absent" — otherwise writing the first checkpoint would make itself stale.
    if (c === undefined) return "absent";
    const prose = stripManagedSection(c).replace(/\s+$/, "");
    return prose.length === 0 ? "absent" : sha256(prose);
  };
  const entries: Record<string, string> = {
    "source-goal": rawHash(joinPath(cwd, files.goal)),
    "source-progress": proseHash(joinPath(cwd, files.progress)),
    "source-handoff": proseHash(joinPath(cwd, files.handoff)),
    "source-learnings": rawHash(joinPath(cwd, files.learnings)),
    "source-config": rawHash(joinPath(cwd, configName)),
  };
  const fingerprint = sha256(CHECKPOINT_SOURCE_KEYS.map((k) => `${k}=${entries[k]}`).join("\n"));
  return { entries, fingerprint };
}

/** Parse `key: value` lines of a managed block into a map. */
export function parseManagedBlock(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of inner.split("\n")) {
    const m = /^([a-z][a-z0-9-]*):(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export type CheckpointFreshnessKind = "missing" | "corrupt" | "stale" | "current";

/** Transactional identity of one checkpoint operation (shared by both blocks). */
export interface CheckpointIdentity {
  generation: number;
  id: string;
}

export type ReadinessState = "attested" | "unattested" | "invalid";

export interface ReadinessInfo {
  state: ReadinessState;
  detail: string;
  /** The checkpoint generation the attestation is bound to (null when never attested). */
  checkpointId?: string | null;
  by?: string;
}

export interface BlockIdentityView {
  present: boolean;
  schema: number | null;
  generation: number | null;
  id: string | null;
  readiness: string | null;
  readinessTarget: string | null;
  readinessBy: string | null;
  delta: string | null;
  checkpointed?: string;
}

/** Read the identity/readiness fields out of one managed block (no writes). */
export function readBlockIdentity(content: string | undefined, section = "checkpoint"): BlockIdentityView {
  const absent: BlockIdentityView = { present: false, schema: null, generation: null, id: null, readiness: null, readinessTarget: null, readinessBy: null, delta: null };
  if (content === undefined) return absent;
  const inner = extractManagedSection(content, section);
  if (inner === undefined) return absent;
  const b = parseManagedBlock(inner);
  const num = (v: string | undefined) => (v != null && /^\d+$/.test(v.trim()) ? Number(v) : null);
  return {
    present: true,
    schema: num(b["checkpoint-schema"]),
    generation: num(b[GENERATION_KEY]),
    id: b[IDENTITY_KEY] ?? null,
    readiness: b[READINESS_KEY] ?? null,
    readinessTarget: b[READINESS_TARGET_KEY] ?? null,
    readinessBy: b[READINESS_BY_KEY] ?? null,
    delta: b[DELTA_KEY] ?? null,
    checkpointed: b["checkpointed"],
  };
}

/**
 * Next transactional generation: max of the generations recorded in the two managed
 * blocks, plus one. Deterministic — no clock, no randomness — so an interrupted
 * two-file update always moves FORWARD (the next operation cannot reuse the id that
 * the half-written checkpoint got).
 */
export function nextCheckpointGeneration(fs: FsOps, cwd: string, files: GuardFiles): number {
  const h = readBlockIdentity(fs.readFile(joinPath(cwd, files.handoff)));
  const p = readBlockIdentity(fs.readFile(joinPath(cwd, files.progress)));
  const max = Math.max(h.generation ?? 0, p.generation ?? 0);
  return max + 1;
}

export function makeCheckpointId(generation: number, fingerprint: string, sessionId: string): string {
  return `g${generation}-${sha256(`${generation}|${fingerprint}|${sessionId}`).slice(0, 12)}`;
}

/**
 * Source fingerprint recorded INSIDE a block (null when the block predates hashing).
 * Compared against `checkpointSources().fingerprint` this proves WHAT a checkpoint
 * captured, independently of when it was written.
 */
export function blockFingerprint(block: Record<string, string>): string | null {
  const keys = CHECKPOINT_SOURCE_KEYS;
  if (!keys.every((k) => block[k])) return null;
  return sha256(keys.map((k) => `${k}=${block[k]}`).join("\n"));
}

/** Parse a managed block's text into key/value map + body sections. */
export function readBlock(inner: string | undefined): { keys: Record<string, string>; body: Record<string, string> } | undefined {
  if (inner === undefined) return undefined;
  const keys = parseManagedBlock(inner);
  const body: Record<string, string> = {};
  for (const heading of ["### Last verified state", "### Unfinished operations", "### Next action", "### Guard notes"]) {
    const b = sectionBody(inner, heading);
    if (b !== undefined) body[heading] = b;
  }
  return { keys, body };
}

export type CheckpointFreshness =
  | { kind: "missing"; detail: string }
  | { kind: "corrupt"; detail: string }
  | { kind: "stale"; legacy: boolean; legacyIdentity?: boolean; changed: string[]; detail: string; partial?: boolean; identity?: CheckpointIdentity | null; readiness?: ReadinessInfo; checkpointed?: string; session?: string }
  | {
      kind: "current";
      checkpointed?: string;
      session?: string;
      fingerprint: string;
      identity: CheckpointIdentity | null;
      partial: boolean;
      contentDelta: "new" | "none" | "initial" | "unknown";
      readiness: ReadinessInfo;
    };

const HASH_RE = /^(absent|[0-9a-f]{64})$/;

function sourceLines(entries: Record<string, string>): string {
  return CHECKPOINT_SOURCE_KEYS.map((k) => `${k}: ${entries[k]}`).join("\n");
}

/**
 * Validate checkpoint freshness — four distinct outcomes:
 * - missing:  no managed checkpoint block in HANDOFF.md.
 * - corrupt:  block present but structurally invalid (no timestamp, unknown
 *             schema version, missing/garbage source hashes).
 * - stale:    structurally valid but the source state changed after it was
 *             written (or it is an unversioned legacy block whose freshness
 *             cannot be verified at all — `legacy: true`).
 * - current:  schema-v2 block whose source hashes all match the files now,
 *             and whose PROGRESS.md twin is in sync.
 * Read-only: validation NEVER writes, and NEVER overwrites manual prose to
 * "resolve" a conflict — refreshing is an explicit checkpoint operation.
 */
export function validateCheckpoint(fs: FsOps, cwd: string, files: GuardFiles, configName = DEFAULT_CONFIG_NAME): CheckpointFreshness {
  const handoffContent = fs.readFile(joinPath(cwd, files.handoff));
  if (handoffContent === undefined) return { kind: "missing", detail: `${files.handoff} is unreadable` };
  const inner = extractManagedSection(handoffContent, "checkpoint");
  if (inner === undefined) return { kind: "missing", detail: `no managed checkpoint block in ${files.handoff}` };
  const block = parseManagedBlock(inner);
  const sessionMatch = inner.match(/session ([0-9a-zA-Z-]+)/);
  const hView = readBlockIdentity(handoffContent);
  const progressContent = fs.readFile(joinPath(cwd, files.progress));
  const pView = readBlockIdentity(progressContent);
  const readiness = resolveReadiness(hView, pView);
  const identityOf = (v: BlockIdentityView): CheckpointIdentity | null => (v.generation != null && v.id ? { generation: v.generation, id: v.id } : null);

  if (!block["checkpointed"]) return { kind: "corrupt", detail: `${files.handoff} checkpoint block has no 'checkpointed:' timestamp` };
  if (!("checkpoint-schema" in block)) {
    return {
      kind: "stale",
      legacy: true,
      changed: [],
      detail: "unversioned (schema v1) checkpoint block: neither freshness nor transactional identity can be verified",
      identity: null,
      readiness,
      checkpointed: block["checkpointed"],
      session: sessionMatch?.[1],
    };
  }
  const schema = Number(block["checkpoint-schema"]);
  if (!Number.isFinite(schema) || (schema !== CHECKPOINT_SCHEMA && schema !== CHECKPOINT_SCHEMA_PREVIOUS)) {
    return { kind: "corrupt", detail: `unsupported checkpoint-schema ${block["checkpoint-schema"]}` };
  }
  const badKeys = CHECKPOINT_SOURCE_KEYS.filter((k) => !block[k] || !HASH_RE.test(block[k]));
  if (badKeys.length > 0) return { kind: "corrupt", detail: `checkpoint block missing/invalid ${badKeys.join(", ")}` };

  // --- transactional identity: both blocks must prove they came from ONE operation ---
  const identityProblems: string[] = [];
  let legacyIdentity = false;
  if (schema === CHECKPOINT_SCHEMA_PREVIOUS) {
    legacyIdentity = true;
    identityProblems.push("schema v2 block has no transactional checkpoint identity (checkpoint-id/checkpoint-generation are missing, pre-Phase-1c format); run /handoff to upgrade it");
  } else {
    if (!hView.id || hView.generation == null) identityProblems.push(`${files.handoff} block is missing ${IDENTITY_KEY}/${GENERATION_KEY}`);
    if (progressInnerMissing(progressContent)) identityProblems.push(`${files.progress} has no managed checkpoint block`);
    else if (!pView.id || pView.generation == null) identityProblems.push(`${files.progress} block is missing ${IDENTITY_KEY}/${GENERATION_KEY}`);
    if (hView.id && pView.id && hView.id !== pView.id) identityProblems.push(`checkpoint-id mismatch: ${files.handoff}=${hView.id} vs ${files.progress}=${pView.id}`);
    if (hView.generation != null && pView.generation != null && hView.generation !== pView.generation) {
      identityProblems.push(`generation mismatch/obsolete checkpoint: ${files.handoff}=#${hView.generation} vs ${files.progress}=#${pView.generation}`);
    }
  }
  if (readiness.state === "invalid") identityProblems.push(readiness.detail);

  const sources = checkpointSources(fs, cwd, files, configName);
  const changed = CHECKPOINT_SOURCE_KEYS.filter((k) => block[k] !== sources.entries[k]).map((k) => k.replace(/^source-/, ""));
  const progressBlock = progressInner(progressContent);
  // The twin's own staleness is only reported when it DISAGREES with the HANDOFF
  // block (two blocks from different operations); when both blocks record the same
  // older hashes, `changed` already names the source once.
  const progressChanged = progressBlock
    ? CHECKPOINT_SOURCE_KEYS.filter((k) => progressBlock[k] !== block[k]).map((k) => `progress:${k.replace(/^source-/, "")}`)
    : ["progress-checkpoint (no managed block)"];

  if (identityProblems.length > 0) {
    return {
      kind: "stale",
      legacy: false,
      legacyIdentity,
      changed: [...changed, ...progressChanged],
      partial: identityProblems.length > 0,
      detail: legacyIdentity ? identityProblems[0] : `incomplete or inconsistent checkpoint generation: ${identityProblems.join("; ")}`,
      identity: identityOf(hView),
      readiness,
      checkpointed: block["checkpointed"],
      session: sessionMatch?.[1],
    };
  }
  if (changed.length > 0 || progressChanged.length > 0) {
    return {
      kind: "stale",
      legacy: false,
      changed: [...changed, ...progressChanged],
      partial: false,
      detail: `source state changed after the checkpoint was written: ${[...new Set([...changed, ...progressChanged])].join(", ")}`,
      identity: identityOf(hView),
      readiness,
      checkpointed: block["checkpointed"],
      session: sessionMatch?.[1],
    };
  }

  const delta = hView.delta === "new" || hView.delta === "none" || hView.delta === "initial" ? hView.delta : "unknown";
  return {
    kind: "current",
    checkpointed: block["checkpointed"],
    session: sessionMatch?.[1],
    fingerprint: sources.fingerprint,
    identity: identityOf(hView),
    partial: false,
    contentDelta: delta,
    readiness,
  };
}

function progressInner(content: string | undefined): Record<string, string> | undefined {
  if (content === undefined) return undefined;
  const inner = extractManagedSection(content, "checkpoint");
  return inner === undefined ? undefined : parseManagedBlock(inner);
}

function progressInnerMissing(content: string | undefined): boolean {
  return progressInner(content) === undefined;
}

/**
 * Readiness is only "attested" when BOTH managed blocks carry the same
 * `readiness: attested` bound to the CURRENT checkpoint id; disagreement between the
 * blocks (e.g. an interrupted attestation write) is "invalid", never "attested".
 */
export function resolveReadiness(hView: BlockIdentityView, pView: BlockIdentityView): ReadinessInfo {
  const h = hView.readiness ?? null;
  const p = pView.readiness ?? null;
  const id = hView.id;
  if (h === null && p === null) return { state: "unattested", detail: "never attested", checkpointId: id };
  if (h !== p) return { state: "invalid", detail: `managed blocks disagree on ${READINESS_KEY}: HANDOFF=${h ?? "(absent)"} vs PROGRESS=${p ?? "(absent)"} (interrupted attestation)`, checkpointId: id };
  if (h !== "attested") return { state: "unattested", detail: `readiness: ${h}`, checkpointId: id };
  const targets = [hView.readinessTarget, pView.readinessTarget];
  if (!id || targets.some((t) => t !== id)) {
    return { state: "invalid", detail: `attestation belongs to checkpoint ${targets[0] ?? "(none)"}, current id is ${id ?? "(none)"} (obsolete generation)`, checkpointId: targets[0] ?? null, by: hView.readinessBy ?? undefined };
  }
  return { state: "attested", detail: `attested by ${hView.readinessBy ?? "?"} for ${id}`, checkpointId: id, by: hView.readinessBy ?? undefined };
}

/**
 * Technical validity + freshness + transactional identity + attestation, reported
 * separately. Phase 2 renewal must check `authorized`, never `kind === "current"`.
 */
export function renewAuthorization(f: CheckpointFreshness): { authorized: boolean; reason: string } {
  if (f.kind !== "current") return { authorized: false, reason: `checkpoint is ${f.kind}${"detail" in f ? `: ${f.detail}` : ""}` };
  if (f.partial) return { authorized: false, reason: "checkpoint blocks do not share one transactional identity" };
  if (f.readiness.state === "invalid") return { authorized: false, reason: `readiness is inconsistent: ${f.readiness.detail}` };
  if (f.readiness.state !== "attested") return { authorized: false, reason: "handoff readiness has not been attested (/handoff ready)" };
  return { authorized: true, reason: `current, identity ${f.identity?.id ?? "?"}, attested${f.readiness.by ? ` by ${f.readiness.by}` : ""}` };
}

/* ------------------------------------------------------------------ */
/* Checkpoint writing                                                  */
/* ------------------------------------------------------------------ */

export interface CheckpointInput {
  cwd: string;
  /** Who asked for the checkpoint: guard escalation (`auto`) or an explicit /handoff. */
  kind?: "auto" | "manual";
  files: GuardFiles;
  level: number;
  sessionId: string;
  remaining: number | null;
  goalHash?: string;
  goalDrift: boolean;
  lastVerifiedState: string;
  unfinishedOperations: string[];
  nextAction: string;
  recoveryInstructions: string[];
  notes?: string;
  /** Config file name included in the source fingerprint. */
  configName?: string;
}

export type ContentDelta = "initial" | "none" | "new";

export interface CheckpointResult {
  ok: boolean;
  written: string[];
  /** Checkpoint outputs that would be written in a dry run. */
  planned?: string[];
  errors: string[];
  validations: FileValidation[];
  fingerprint: string;
  dryRun: boolean;
  /** Transactional identity stamped into BOTH managed blocks by this operation. */
  identity: CheckpointIdentity & { schema: number };
  /** Did this checkpoint capture anything the previous one had not? */
  contentDelta: ContentDelta;
  /** Readiness after the write: always `unattested` for a new generation. */
  readiness: ReadinessInfo;
}

/** Generic guard-authored summary (carries nothing the agent wrote). */
const GENERIC_STATE_RE = /^guard level \d+; checkpoint requested/;

/** Identity lines shared by both managed blocks — the transactional stamp. */
function identityLines(id: CheckpointIdentity, kind: "auto" | "manual", delta: ContentDelta): string[] {
  return [
    `checkpoint-schema: ${CHECKPOINT_SCHEMA}`,
    `${GENERATION_KEY}: ${id.generation}`,
    `${IDENTITY_KEY}: ${id.id}`,
    `${KIND_KEY}: ${kind}`,
    `${DELTA_KEY}: ${delta}`,
    `${READINESS_KEY}: unattested`,
  ];
}

/**
 * Write the HANDOFF.md checkpoint and stamp PROGRESS.md's managed region.
 * Schema v3: one shared transactional identity (`checkpoint-generation` +
 * `checkpoint-id`) proves both blocks came from the SAME operation, plus the
 * schema-v2 source fingerprints (goal, manual prose of progress/handoff,
 * learnings, config) for freshness. An interrupted two-file write leaves mixed
 * generations, reported as stale+partial instead of `current` (Phase 1c: identical
 * hashes alone could not prove the two blocks belonged together).
 * Automatic checkpoints PRESERVE the previous block's substantive `Last verified
 * state` / `Guard notes` bodies instead of overwriting them with generic text
 * (Phase 1b information-loss bug, reproduced at b2ccdac).
 * Failures are reported, never thrown; agent text outside markers survives
 * byte-for-byte; LEARNINGS.md and GOAL.md are never modified by the guard.
 */
export function writeCheckpoint(fs: FsOps, input: CheckpointInput, opts: { dryRun?: boolean } = {}): CheckpointResult {
  const written: string[] = [];
  const errors: string[] = [];
  const handoffPath = joinPath(input.cwd, input.files.handoff);
  const progressPath = joinPath(input.cwd, input.files.progress);
  const sources = checkpointSources(fs, input.cwd, input.files, input.configName ?? DEFAULT_CONFIG_NAME);

  const existingHandoff = fs.readFile(handoffPath) ?? "";
  const existingProgress = fs.readFile(progressPath) ?? "";
  const prev = readBlock(extractManagedSection(existingHandoff, "checkpoint"));
  const prevFingerprint = prev ? blockFingerprint(prev.keys) : null;
  const contentDelta: ContentDelta = prevFingerprint == null ? "initial" : prevFingerprint === sources.fingerprint ? "none" : "new";
  const kind: "auto" | "manual" = input.kind === "auto" ? "auto" : "manual";

  // Information-loss guard: an automatic checkpoint with no notes must not erase a
  // substantive summary recorded by an earlier checkpoint.
  let lastVerifiedState = input.lastVerifiedState;
  let notes = input.notes;
  if (kind === "auto" && !input.notes && prev) {
    const prevSummary = prev.body["### Last verified state"];
    if (prevSummary && !GENERIC_STATE_RE.test(prevSummary)) lastVerifiedState = prevSummary;
    const prevNotes = prev.body["### Guard notes"];
    if (prevNotes) notes = prevNotes;
  }

  const generation = nextCheckpointGeneration(fs, input.cwd, input.files);
  const identity: CheckpointIdentity & { schema: number } = {
    generation,
    id: makeCheckpointId(generation, sources.fingerprint, input.sessionId),
    schema: CHECKPOINT_SCHEMA,
  };
  const readiness: ReadinessInfo = { state: "unattested", detail: "new checkpoint generation: readiness must be re-attested", checkpointId: identity.id };

  const stamp = new Date().toISOString();
  const remainingText = input.remaining == null ? "unknown" : `~${Math.floor(input.remaining)}`;
  const inner = [
    ...identityLines(identity, kind, contentDelta),
    `status: checkpoint (guard level ${input.level}, remaining ${remainingText}, session ${input.sessionId})`,
    `checkpointed: ${stamp}`,
    sourceLines(sources.entries),
    input.goalDrift ? "WARNING: GOAL.md changed since session start (goal drift); review before continuing." : "",
    "",
    "### Last verified state",
    lastVerifiedState,
    "",
    "### Unfinished operations",
    ...(input.unfinishedOperations.length ? input.unfinishedOperations.map((o) => `- ${o}`) : ["- (none recorded)"]),
    "",
    "### Next action",
    input.nextAction,
    notes ? `\n### Guard notes\n${notes}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const newHandoff = replaceManagedSection(existingHandoff, "checkpoint", inner);
  const progressBlock = [
    ...identityLines(identity, kind, contentDelta),
    `guard-level: ${input.level}`,
    `checkpointed: ${stamp}`,
    sourceLines(sources.entries),
    `next-action: ${input.nextAction}`,
  ].join("\n");
  const newProgress = replaceManagedSection(existingProgress, "checkpoint", progressBlock);

  const planned = [input.files.handoff, input.files.progress];
  if (opts.dryRun) {
    return { ok: true, written: [], planned, errors: [], validations: [], fingerprint: sources.fingerprint, dryRun: true, identity, contentDelta, readiness };
  }
  try {
    fs.writeFile(handoffPath, newHandoff);
    written.push(input.files.handoff);
  } catch (err) {
    errors.push(`${input.files.handoff}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    fs.writeFile(progressPath, newProgress);
    written.push(input.files.progress);
  } catch (err) {
    errors.push(`${input.files.progress}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const validations = (["handoff", "progress", "learnings", "goal"] as (keyof GuardFilesInput)[]).map((kind2) =>
    validateFile(fs, joinPath(input.cwd, input.files[kind2]), kind2),
  );
  for (const v of validations) {
    if (!v.ok) errors.push(`validation ${v.file}: missing ${v.unreadable ? "(unreadable file)" : v.missingSections.join(", ")}`);
  }
  return { ok: errors.length === 0, written, errors, validations, fingerprint: sources.fingerprint, dryRun: false, identity, contentDelta, readiness };
}

/* ------------------------------------------------------------------ */
/* Semantic readiness: is this checkpoint a COMPLETE handoff?          */
/* ------------------------------------------------------------------ */

export type ReadinessCheckStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  status: ReadinessCheckStatus;
  detail: string;
}

export interface ReadinessEvaluation {
  /** No blocking failure: attestation is permitted. Warnings never block. */
  ok: boolean;
  checks: ReadinessCheck[];
  freshness: CheckpointFreshness;
  nextAction?: string;
  nextActionSource?: RecoveryBundle["nextActionSource"];
  identity: CheckpointIdentity | null;
}

const PLACEHOLDER_RE = /^\s*(\(unknown|tbd\b|todo\b|n\/a\b|\(none\)|none|\.?)\s*$/i;
const PLACEHOLDER_HINT_RE = /record the exact next action|fill this in|to be determined/i;

/**
 * Evaluate whether the durable checkpoint is a USABLE handoff, separately from
 * technical validity: a structurally valid, hash-fresh block can still be
 * semantically empty (generic auto text, no next action, nothing new recorded).
 * Read-only — never writes, never "fixes" anything.
 */
export function evaluateHandoffReadiness(
  fs: FsOps,
  cwd: string,
  files: GuardFiles,
  options: { configName?: string; learningsHashAtSessionStart?: string } = {},
): ReadinessEvaluation {
  const configName = options.configName ?? DEFAULT_CONFIG_NAME;
  const freshness = validateCheckpoint(fs, cwd, files, configName);
  const bundle = readRecoveryBundle(fs, cwd, files, { configName });
  const checks: ReadinessCheck[] = [];
  const add = (id: string, status: ReadinessCheckStatus, detail: string) => checks.push({ id, status, detail });

  const handoffContent = fs.readFile(joinPath(cwd, files.handoff));
  const progressContent = fs.readFile(joinPath(cwd, files.progress));
  const hView = readBlockIdentity(handoffContent);
  const pView = readBlockIdentity(progressContent);
  const identity: CheckpointIdentity | null = hView.generation != null && hView.id ? { generation: hView.generation, id: hView.id } : null;

  // --- blocking checks ---
  add(
    "checkpoint-current",
    freshness.kind === "current" ? "pass" : "fail",
    freshness.kind === "current"
      ? `checkpoint is current (written ${freshness.checkpointed ?? "?"}${freshness.session ? `, session ${freshness.session}` : ""})`
      : `checkpoint is ${freshness.kind}${"detail" in freshness ? `: ${freshness.detail}` : ""}`,
  );

  const identityProblems: string[] = [];
  if (!hView.present || !pView.present) identityProblems.push("a managed checkpoint block is missing (both HANDOFF.md and PROGRESS.md must carry one)");
  if (!hView.id || hView.generation == null) identityProblems.push(`${files.handoff} block has no ${IDENTITY_KEY}/${GENERATION_KEY}`);
  if (!pView.id || pView.generation == null) identityProblems.push(`${files.progress} block has no ${IDENTITY_KEY}/${GENERATION_KEY}`);
  if (hView.id && pView.id && hView.id !== pView.id) identityProblems.push(`ids differ: ${hView.id} vs ${pView.id}`);
  if (hView.generation != null && pView.generation != null && hView.generation !== pView.generation) identityProblems.push(`generations differ: #${hView.generation} vs #${pView.generation}`);
  const readi = resolveReadiness(hView, pView);
  if (readi.state === "invalid") identityProblems.push(readi.detail);
  add(
    "identity-consistent",
    identityProblems.length === 0 ? "pass" : "fail",
    identityProblems.length === 0 ? `both blocks share ${identity?.id ?? "?"} (generation ${identity?.generation ?? "?"})` : identityProblems.join("; "),
  );

  const proseNext = handoffContent === undefined ? undefined : sectionBody(stripManagedSection(handoffContent), "## Next action");
  const blockNext = handoffContent === undefined ? undefined : sectionBody(extractManagedSection(handoffContent, "checkpoint") ?? "", "### Next action");
  const nextAction = proseNext ?? blockNext;
  const nextProblems: string[] = [];
  if (!nextAction) nextProblems.push("no next action recorded in HANDOFF.md (manual `## Next action` section required)");
  else if (PLACEHOLDER_RE.test(nextAction) || PLACEHOLDER_HINT_RE.test(nextAction)) nextProblems.push(`next action is a placeholder: ${JSON.stringify(nextAction.slice(0, 80))}`);
  else if (proseNext === undefined) nextProblems.push("next action exists only inside the managed block: write the manual `## Next action` prose (prose always wins)");
  add("next-action-recorded", nextProblems.length === 0 ? "pass" : "fail", nextProblems.length === 0 ? `recorded (source: ${bundle.nextActionSource ?? "handoff-prose"})` : nextProblems.join("; "));

  const invalid = validateAll(fs, cwd, files).filter((v) => !v.ok);
  add(
    "durable-files-valid",
    invalid.length === 0 ? "pass" : "fail",
    invalid.length === 0 ? "all four durable files contain their required sections" : invalid.map((v) => `${v.file}: ${v.unreadable ? "unreadable" : v.missingSections.join(", ")}`).join("; "),
  );

  // --- warnings (never block attestation) ---
  const delta = hView.delta;
  add(
    "content-delta",
    delta === "new" || delta === "initial" ? "pass" : "warn",
    delta === "none"
      ? "checkpoint recorded nothing new: source state is identical to the previous checkpoint — write the discoveries into LEARNINGS/PROGRESS/HANDOFF prose first"
      : delta === "new" || delta === "initial"
        ? `content delta: ${delta}`
        : "content-delta unknown (block predates Phase 1c): refresh the checkpoint",
  );

  const learnings = fs.readFile(joinPath(cwd, files.learnings));
  const nowLearnings = learnings === undefined ? "absent" : sha256(learnings);
  if (options.learningsHashAtSessionStart == null) {
    add("learnings-updated", "warn", "no LEARNINGS.md baseline from session start was supplied: cannot tell whether experience was recorded this session");
  } else if (options.learningsHashAtSessionStart === nowLearnings) {
    add("learnings-updated", "warn", `LEARNINGS.md unchanged since session start (${nowLearnings.slice(0, 12)}): discoveries, falsified hypotheses and proposals may be lost`);
  } else {
    add("learnings-updated", "pass", "LEARNINGS.md changed since session start (experience was recorded)");
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks, freshness, nextAction, nextActionSource: bundle.nextActionSource, identity };
}

export interface AttestationResult {
  ok: boolean;
  written: string[];
  errors: string[];
  checks: ReadinessCheck[];
  dryRun: boolean;
  readiness?: ReadinessInfo;
  checkpointId?: string | null;
}

/** Rewrite only given `key: value` lines inside a managed block; everything else is untouched. */
function stampKeys(inner: string, updates: Record<string, string>): string {
  const out: string[] = [];
  const done = new Set<string>();
  for (const line of inner.split("\n")) {
    const m = /^([a-z][a-z0-9-]*):(.*)$/.exec(line);
    if (m && m[1] in updates) {
      out.push(`${m[1]}: ${updates[m[1]]}`);
      done.add(m[1]);
    } else {
      out.push(line);
    }
  }
  const missing = Object.keys(updates).filter((k) => !done.has(k));
  if (missing.length > 0) {
    const at = out.findIndex((l) => l.startsWith("#"));
    out.splice(at < 0 ? out.length : at, 0, ...missing.map((k) => `${k}: ${updates[k]}`));
  }
  return out.join("\n");
}

/**
 * Attest that the CURRENT checkpoint generation is a complete handoff: rewrites only
 * the readiness lines of both managed blocks in ONE operation (no new generation, no
 * content change), bound to the current `checkpoint-id`. Refused with zero writes
 * unless every blocking check passes; `dryRun` performs no writes at all.
 */
export function attestHandoff(
  fs: FsOps,
  cwd: string,
  files: GuardFiles,
  options: { sessionId?: string; by?: string; dryRun?: boolean; configName?: string; learningsHashAtSessionStart?: string } = {},
): AttestationResult {
  const configName = options.configName ?? DEFAULT_CONFIG_NAME;
  const evaluation = evaluateHandoffReadiness(fs, cwd, files, { configName, learningsHashAtSessionStart: options.learningsHashAtSessionStart });
  const by = options.by ?? (options.sessionId ? `session:${options.sessionId}` : "unknown");
  if (!evaluation.ok) {
    return {
      ok: false,
      written: [],
      errors: evaluation.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`),
      checks: evaluation.checks,
      dryRun: Boolean(options.dryRun),
      checkpointId: evaluation.identity?.id ?? null,
    };
  }
  const id = evaluation.identity!;
  const updates: Record<string, string> = {
    [READINESS_KEY]: "attested",
    [READINESS_BY_KEY]: by,
    [READINESS_AT_KEY]: new Date().toISOString(),
    [READINESS_TARGET_KEY]: id.id,
  };
  const handoffPath = joinPath(cwd, files.handoff);
  const progressPath = joinPath(cwd, files.progress);
  const handoffContent = fs.readFile(handoffPath) ?? "";
  const progressContent = fs.readFile(progressPath) ?? "";
  const newHandoff = replaceManagedSection(handoffContent, "checkpoint", stampKeys(extractManagedSection(handoffContent, "checkpoint") ?? "", updates));
  const newProgress = replaceManagedSection(progressContent, "checkpoint", stampKeys(extractManagedSection(progressContent, "checkpoint") ?? "", updates));
  if (options.dryRun) {
    return { ok: true, written: [], errors: [], checks: evaluation.checks, dryRun: true, checkpointId: id.id, readiness: { state: "attested", detail: `would attest ${id.id} as ${by}`, checkpointId: id.id, by } };
  }
  const written: string[] = [];
  const errors: string[] = [];
  try {
    fs.writeFile(handoffPath, newHandoff);
    written.push(files.handoff);
  } catch (err) {
    errors.push(`${files.handoff}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    fs.writeFile(progressPath, newProgress);
    written.push(files.progress);
  } catch (err) {
    errors.push(`${files.progress}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const after = validateCheckpoint(fs, cwd, files, configName);
  const readiness: ReadinessInfo =
    after.kind === "current" || after.kind === "stale"
      ? after.readiness
      : { state: "unattested", detail: `attestation left the checkpoint ${after.kind}`, checkpointId: id.id };
  return { ok: errors.length === 0, written, errors, checks: evaluation.checks, dryRun: false, checkpointId: id.id, readiness };
}

export interface RecoveryBundle {
  objective: string | undefined;
  nextAction: string | undefined;
  /** Where nextAction came from: fresh manual prose, a current checkpoint, or a stale one as last resort. */
  nextActionSource: "handoff-prose" | "checkpoint" | "stale-checkpoint" | undefined;
  checkpoint: CheckpointFreshness;
  recoveryInstructions: string[];
}

/**
 * Read back the recovery essentials (used by tests and by /handoff).
 * Precedence (Phase 1b fix): manual `## Next action` prose always wins — it is
 * the newest human/agent statement. The managed checkpoint block is used only
 * when there is no manual section AND the block is verified current; a stale
 * block is a last-resort fallback, clearly labelled.
 */
export function readRecoveryBundle(fs: FsOps, cwd: string, files: GuardFiles, options: { configName?: string } = {}): RecoveryBundle {
  const goal = fs.readFile(joinPath(cwd, files.goal)) ?? "";
  const handoff = fs.readFile(joinPath(cwd, files.handoff)) ?? "";
  // Manual sections are searched in the prose ONLY (managed block stripped),
  // so "## ..." headings can never accidentally match inside "### ..." lines.
  const handoffProse = stripManagedSection(handoff);
  const objective = sectionBody(goal, "## Objective");
  const checkpoint = extractManagedSection(handoff, "checkpoint");
  const nextFromCheckpoint = checkpoint ? sectionBody(checkpoint, "### Next action") : undefined;
  const nextFromHandoff = sectionBody(handoffProse, "## Next action");
  const recovery = sectionBody(handoffProse, "## Recovery instructions") ?? "";
  const freshness = validateCheckpoint(fs, cwd, files, options.configName ?? DEFAULT_CONFIG_NAME);

  let nextAction: string | undefined;
  let nextActionSource: RecoveryBundle["nextActionSource"];
  if (nextFromHandoff !== undefined) {
    nextAction = nextFromHandoff;
    nextActionSource = "handoff-prose";
  } else if (nextFromCheckpoint !== undefined && freshness.kind === "current") {
    nextAction = nextFromCheckpoint;
    nextActionSource = "checkpoint";
  } else if (nextFromCheckpoint !== undefined) {
    nextAction = nextFromCheckpoint;
    nextActionSource = "stale-checkpoint";
  } else {
    nextActionSource = undefined;
  }
  return {
    objective,
    nextAction,
    nextActionSource,
    checkpoint: freshness,
    recoveryInstructions: recovery.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")),
  };
}

function sectionBody(content: string, heading: string): string | undefined {
  const start = content.indexOf(heading);
  if (start < 0) return undefined;
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n#{1,6} /);
  return (next >= 0 ? rest.slice(0, next) : rest).trim() || undefined;
}
