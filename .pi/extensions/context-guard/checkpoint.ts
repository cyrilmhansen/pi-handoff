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

export interface FsOps {
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void; // must be atomic where durability matters
  exists(path: string): boolean;
  mkdirRecursive(path: string): void;
  listFiles(dir: string): string[];
  remove(path: string): void;
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
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function joinPath(dir: string, name: string): string {
  if (name.startsWith("/")) return name;
  return dir.length === 0 ? name : `${dir.replace(/\/+$/, "")}/${name}`;
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
  return `${content}${sep}\n${block}\n`;
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
  notes?: string;
}

export type StateLoadResult =
  | { kind: "found"; state: PersistedGuardState; migrated?: "self" }
  | { kind: "missing"; foreignMigrated?: string; legacyRemoved?: boolean }
  | { kind: "corrupt"; detail: string; backupPath?: string };

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

function cleanTmpFiles(fs: FsOps, dir: string): void {
  for (const name of fs.listFiles(dir)) {
    if (name.includes(".tmp-")) {
      try {
        fs.remove(joinPath(dir, name));
      } catch {
        /* best effort */
      }
    }
  }
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
 * Load THIS session's runtime state from `<stateDir>/sessions/<sessionId>.json`.
 * Corrupt JSON is quarantined to a timestamped backup; only the affected
 * session's file is touched. Migration: a legacy single-slot `state.json` is
 * reconciled by `updatedAt` — whichever copy of a session's state is newer
 * wins (a still-running v1 writer may re-create `state.json` after migration),
 * and every copy is filed under its owning session id, never another's.
 */
export function loadGuardState(fs: FsOps, stateDir: string, sessionId: string): StateLoadResult {
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
 * Best-effort retention: keep the `keep` most recently updated session state
 * files (never the current one). Unparseable files are left alone — loading
 * quarantines them. Runtime state is ephemeral; durable checkpoints live in
 * the markdown files and are never pruned here.
 */
export function pruneSessionStates(fs: FsOps, stateDir: string, keep: number, currentSessionId: string): string[] {
  const removed: string[] = [];
  const dir = sessionsDirPath(stateDir);
  const entries: Array<{ path: string; updatedAt: number }> = [];
  for (const name of fs.listFiles(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = joinPath(dir, name);
    if (name === `${safeSessionId(currentSessionId)}.json`) continue;
    try {
      const parsed = parseState(fs.readFile(p)!);
      entries.push({ path: p, updatedAt: Number(parsed.updatedAt) || 0 });
    } catch {
      /* keep unknown files */
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const e of entries.slice(Math.max(0, keep))) {
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

export const CHECKPOINT_SCHEMA = 2;
export const DEFAULT_CONFIG_NAME = "handoff.config.json";

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

export type CheckpointFreshness =
  | { kind: "missing"; detail: string }
  | { kind: "corrupt"; detail: string }
  | { kind: "stale"; legacy: boolean; changed: string[]; detail: string; checkpointed?: string; session?: string }
  | { kind: "current"; checkpointed?: string; session?: string; fingerprint: string };

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
  if (!block["checkpointed"]) return { kind: "corrupt", detail: `${files.handoff} checkpoint block has no 'checkpointed:' timestamp` };
  if (!("checkpoint-schema" in block)) {
    return {
      kind: "stale",
      legacy: true,
      changed: [],
      detail: "unversioned (schema v1) checkpoint block: freshness cannot be verified against source state",
      checkpointed: block["checkpointed"],
      session: sessionMatch?.[1],
    };
  }
  const schema = Number(block["checkpoint-schema"]);
  if (!Number.isFinite(schema) || schema !== CHECKPOINT_SCHEMA) {
    return { kind: "corrupt", detail: `unsupported checkpoint-schema ${block["checkpoint-schema"]}` };
  }
  const badKeys = CHECKPOINT_SOURCE_KEYS.filter((k) => !block[k] || !HASH_RE.test(block[k]));
  if (badKeys.length > 0) return { kind: "corrupt", detail: `checkpoint block missing/invalid ${badKeys.join(", ")}` };

  const sources = checkpointSources(fs, cwd, files, configName);
  const changed = CHECKPOINT_SOURCE_KEYS.filter((k) => block[k] !== sources.entries[k]).map((k) => k.replace(/^source-/, ""));
  if (changed.length > 0) {
    return {
      kind: "stale",
      legacy: false,
      changed,
      detail: `source state changed after the checkpoint was written: ${changed.join(", ")}`,
      checkpointed: block["checkpointed"],
      session: sessionMatch?.[1],
    };
  }

  // PROGRESS.md must carry the same fingerprint (twin block written atomically
  // in the same operation); a missing or divergent twin means a partial write.
  const progressContent = fs.readFile(joinPath(cwd, files.progress));
  const progressInner = progressContent === undefined ? undefined : extractManagedSection(progressContent, "checkpoint");
  if (progressInner === undefined) {
    return { kind: "stale", legacy: false, changed: ["progress-checkpoint (no managed block)"], detail: `${files.progress} has no managed checkpoint block`, checkpointed: block["checkpointed"] };
  }
  const progressBlock = parseManagedBlock(progressInner);
  const progressChanged = CHECKPOINT_SOURCE_KEYS.filter((k) => progressBlock[k] !== sources.entries[k]).map((k) => `progress:${k.replace(/^source-/, "")}`);
  if (progressChanged.length > 0) {
    return { kind: "stale", legacy: false, changed: progressChanged, detail: `${files.progress} checkpoint block out of sync`, checkpointed: block["checkpointed"] };
  }

  return { kind: "current", checkpointed: block["checkpointed"], session: sessionMatch?.[1], fingerprint: sources.fingerprint };
}

/* ------------------------------------------------------------------ */
/* Checkpoint writing                                                  */
/* ------------------------------------------------------------------ */

export interface CheckpointInput {
  cwd: string;
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

export interface CheckpointResult {
  ok: boolean;
  written: string[];
  /** Checkpoint outputs that would be written in a dry run. */
  planned?: string[];
  errors: string[];
  validations: FileValidation[];
  fingerprint: string;
  dryRun: boolean;
}

/**
 * Write the HANDOFF.md checkpoint and stamp PROGRESS.md's managed region.
 * The managed blocks are schema v2: they embed sha256 fingerprints of the
 * relevant source state (goal, manual prose of progress/handoff, learnings,
 * config), so staleness against later edits is detectable by validateCheckpoint.
 * Failures are reported, never thrown by design, and never clobber agent text.
 * LEARNINGS.md and GOAL.md are never modified by the guard.
 */
export function writeCheckpoint(fs: FsOps, input: CheckpointInput, opts: { dryRun?: boolean } = {}): CheckpointResult {
  const written: string[] = [];
  const errors: string[] = [];
  const handoffPath = joinPath(input.cwd, input.files.handoff);
  const progressPath = joinPath(input.cwd, input.files.progress);
  const sources = checkpointSources(fs, input.cwd, input.files, input.configName ?? DEFAULT_CONFIG_NAME);

  const stamp = new Date().toISOString();
  const remainingText = input.remaining == null ? "unknown" : `~${Math.floor(input.remaining)}`;
  const inner = [
    `checkpoint-schema: ${CHECKPOINT_SCHEMA}`,
    `status: checkpoint (guard level ${input.level}, remaining ${remainingText}, session ${input.sessionId})`,
    `checkpointed: ${stamp}`,
    sourceLines(sources.entries),
    input.goalDrift ? "WARNING: GOAL.md changed since session start (goal drift); review before continuing." : "",
    "",
    "### Last verified state",
    input.lastVerifiedState,
    "",
    "### Unfinished operations",
    ...(input.unfinishedOperations.length ? input.unfinishedOperations.map((o) => `- ${o}`) : ["- (none recorded)"]),
    "",
    "### Next action",
    input.nextAction,
    input.notes ? `\n### Guard notes\n${input.notes}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const existingHandoff = fs.readFile(handoffPath) ?? "";
  const newHandoff = replaceManagedSection(existingHandoff, "checkpoint", inner);
  const existingProgress = fs.readFile(progressPath) ?? "";
  const progressInner = [
    `checkpoint-schema: ${CHECKPOINT_SCHEMA}`,
    `guard-level: ${input.level}`,
    `checkpointed: ${stamp}`,
    sourceLines(sources.entries),
    `next-action: ${input.nextAction}`,
  ].join("\n");
  const newProgress = replaceManagedSection(existingProgress, "checkpoint", progressInner);

  const planned = [input.files.handoff, input.files.progress];
  if (opts.dryRun) {
    return { ok: true, written: [], planned, errors: [], validations: [], fingerprint: sources.fingerprint, dryRun: true };
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

  const validations = (["handoff", "progress", "learnings", "goal"] as (keyof GuardFilesInput)[]).map((kind) =>
    validateFile(fs, joinPath(input.cwd, input.files[kind]), kind),
  );
  for (const v of validations) {
    if (!v.ok) errors.push(`validation ${v.file}: missing ${v.unreadable ? "(unreadable file)" : v.missingSections.join(", ")}`);
  }
  return { ok: errors.length === 0, written, errors, validations, fingerprint: sources.fingerprint, dryRun: false };
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
