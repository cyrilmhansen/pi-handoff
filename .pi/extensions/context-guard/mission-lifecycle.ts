/** Sealed, read-only lifecycle for explicitly selected mission instances. */
import pathDefault from "node:path";
import type { CheckpointFreshness, FsOps } from "./checkpoint.ts";
import { sha256 } from "./checkpoint.ts";
import { parseDocumentationCycleState, type DocumentationCyclePhase } from "./documentation-cycle.ts";
import { instancePathIsSafe, missionInstancePaths, validMissionInstanceId, type WorkProfileRef } from "./mission-instance.ts";
import { parseRenewalState, type RenewalState } from "./renewal.ts";

export const MISSION_CLOSURE_FILE = "closure.json";
export const MISSION_CLOSURE_PENDING_FILE = "closure.pending";
export const MISSION_CLOSURE_SCHEMA = 1;

export interface MissionClosureRecord {
  schema: 1;
  missionId: string;
  workProfile: WorkProfileRef | null;
  closedAt: string;
  reason: string;
  files: Record<string, string>;
  stateRoot: string;
  sourceFingerprint: string;
  checkpoint: { id: string; attestation: "attested" };
  renewalState: RenewalState;
  renewalMax: number;
  gitRevision: string | null;
  operationId: string;
}

export interface MissionClosureOptions {
  fs: FsOps;
  cwd: string;
  missionId: string;
  stateDir: string;
  checkpoint: CheckpointFreshness;
  renewalMax: number;
  gitRevision?: string;
  ownsLock: boolean;
  readOnly: boolean;
  stateCorrupted: boolean;
  renewalBusy: boolean;
  cycleBusy: boolean;
}

export interface MissionClosurePlan {
  missionId: string;
  missionRoot: string;
  stateRoot: string;
  workProfile: WorkProfileRef | null;
  files: Record<string, string>;
  checkpoint: { id: string | null; state: string; attestation: string };
  renewalState: RenewalState;
  renewalMax: number;
  cyclePhase: DocumentationCyclePhase | "idle" | "corrupt";
  gitRevision: string | null;
  fingerprint: string;
  blockers: string[];
}

export type MissionClosureInspection =
  | { state: "active"; detail: string }
  | { state: "uncertain"; detail: string; record?: MissionClosureRecord; changed?: string[] }
  | { state: "closed" | "changed"; detail: string; record: MissionClosureRecord; changed: string[] };

export function missionClosurePaths(cwd: string, id: string): { root: string; closure: string; pending: string; state: string; ownerRecovery: string } {
  const root = pathDefault.resolve(cwd, missionInstancePaths(id).root);
  const lock = pathDefault.resolve(root, ".owner.lock");
  return {
    root,
    closure: pathDefault.join(root, MISSION_CLOSURE_FILE),
    pending: pathDefault.join(root, MISSION_CLOSURE_PENDING_FILE),
    state: pathDefault.resolve(cwd, missionInstancePaths(id).stateDir),
    ownerRecovery: `${lock}.recovery`,
  };
}

function parseClosure(raw: string | undefined, expectedId: string): MissionClosureRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<MissionClosureRecord>;
    if (
      value.schema !== MISSION_CLOSURE_SCHEMA || value.missionId !== expectedId ||
      typeof value.closedAt !== "string" || !Number.isFinite(Date.parse(value.closedAt)) ||
      typeof value.reason !== "string" || value.reason.trim().length === 0 ||
      typeof value.stateRoot !== "string" || pathDefault.resolve(value.stateRoot) !== value.stateRoot ||
      typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
      typeof value.operationId !== "string" || value.operationId !== `close:${value.sourceFingerprint}` ||
      !value.checkpoint || typeof value.checkpoint.id !== "string" || value.checkpoint.attestation !== "attested" ||
      !value.renewalState || value.renewalState.version !== 1 || typeof value.renewalState.chainId !== "string" ||
      typeof value.renewalState.renewalsDone !== "number" || typeof value.renewalState.stopped !== "boolean" ||
      typeof value.renewalMax !== "number" || !Number.isInteger(value.renewalMax) ||
      typeof value.gitRevision !== "string" && value.gitRevision !== null ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files) ||
      !Object.entries(value.files).every(([k, v]) => typeof k === "string" && typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    ) return undefined;
    const profile = value.workProfile;
    if (profile !== null && (!profile || typeof profile.id !== "string" || typeof profile.version !== "string")) return undefined;
    return value as MissionClosureRecord;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = pathDefault.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathDefault.isAbsolute(relative));
}

function collectFiles(fs: FsOps, root: string, prefix: string, excludeRootNames: Set<string>, blockers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const rootExists = fs.exists(root) || fs.listFiles(root).length > 0;
  if (!rootExists) return out;
  const canonicalRoot = fs.realpath?.(root) ?? pathDefault.resolve(root);
  const seen = new Set<string>();
  const walk = (absolute: string, relative: string): void => {
    if (seen.has(absolute)) { blockers.push(`directory cycle while reading ${absolute}`); return; }
    seen.add(absolute);
    const real = fs.realpath?.(absolute);
    const expectedReal = relative ? pathDefault.resolve(canonicalRoot, relative) : canonicalRoot;
    if (real && pathDefault.resolve(real) !== pathDefault.resolve(expectedReal)) {
      blockers.push(`symbolic link in sealed files: ${absolute}`);
      return;
    }
    if (real && !pathInside(canonicalRoot, pathDefault.resolve(real))) {
      blockers.push(`path escapes its sealed root: ${absolute}`);
      return;
    }
    const text = fs.readFile(absolute);
    if (text !== undefined) {
      const digest = fs.hashFile ? fs.hashFile(absolute) : sha256(text);
      if (!digest) blockers.push(`file cannot be hashed: ${absolute}`);
      else out[`${prefix}${relative}`] = digest;
      return;
    }
    let names: string[];
    try {
      names = fs.listFilesStrict ? fs.listFilesStrict(absolute) : fs.listFiles(absolute);
    } catch (err) {
      blockers.push(`directory cannot be inspected: ${absolute} (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    if (names.length === 0 && !fs.exists(absolute) && relative !== "") {
      blockers.push(`listed entry disappeared or cannot be read: ${absolute}`);
      return;
    }
    for (const name of names.sort()) {
      if (!relative && excludeRootNames.has(name)) continue;
      if (name === "." || name === ".." || name.includes(pathDefault.sep)) {
        blockers.push(`invalid directory entry under ${absolute}`);
        continue;
      }
      const childRelative = relative ? pathDefault.join(relative, name) : name;
      if (name.includes(".tmp-")) blockers.push(`interrupted temporary write requires inspection: ${pathDefault.join(absolute, name)}`);
      walk(pathDefault.join(absolute, name), childRelative);
    }
  };
  walk(root, "");
  return out;
}

function currentFileInventory(fs: FsOps, cwd: string, id: string, stateDir: string): { files: Record<string, string>; errors: string[]; roots: ReturnType<typeof missionClosurePaths> } {
  const roots = missionClosurePaths(cwd, id);
  const errors: string[] = [];
  if (!validMissionInstanceId(id) || !instancePathIsSafe(fs, cwd, id)) {
    return { files: {}, errors: ["mission instance id/path is invalid or resolves outside the project"], roots };
  }
  const files = {
    ...collectFiles(fs, roots.root, "mission:", new Set([".owner.lock", ".owner.lock.recovery", MISSION_CLOSURE_FILE, MISSION_CLOSURE_PENDING_FILE]), errors),
    ...collectFiles(fs, stateDir, "state:", new Set(), errors),
  };
  for (const required of ["mission:mission.json", "mission:HANDOFF.md", "mission:PROGRESS.md", "mission:LEARNINGS.md"]) {
    if (!files[required]) errors.push(`required mission file is missing or unreadable: ${required.slice("mission:".length)}`);
  }
  return { files, errors, roots };
}

function readManifest(fs: FsOps, root: string, id: string): { profile: WorkProfileRef | null; error?: string } {
  const raw = fs.readFile(pathDefault.join(root, "mission.json"));
  if (raw === undefined) return { profile: null, error: "mission identity manifest is missing or unreadable" };
  try {
    const parsed = JSON.parse(raw) as { schema?: number; id?: string; workProfile?: unknown };
    if (parsed.schema !== 1 || parsed.id !== id) return { profile: null, error: "mission identity manifest is corrupt or mismatched" };
    if (parsed.workProfile == null) return { profile: null };
    const profile = parsed.workProfile as WorkProfileRef;
    if (typeof profile.id !== "string" || typeof profile.version !== "string") return { profile: null, error: "mission work-profile identity is corrupt" };
    return { profile };
  } catch {
    return { profile: null, error: "mission identity manifest is corrupt" };
  }
}

export function prepareMissionClosure(options: MissionClosureOptions): MissionClosurePlan {
  const { fs, cwd, missionId, stateDir, checkpoint, renewalMax } = options;
  const roots = missionClosurePaths(cwd, missionId);
  const blockers: string[] = [];
  const inventory = currentFileInventory(fs, cwd, missionId, stateDir);
  blockers.push(...inventory.errors);
  const manifest = readManifest(fs, roots.root, missionId);
  if (manifest.error) blockers.push(manifest.error);
  if (!options.ownsLock) blockers.push("this Pi process does not own the selected mission instance");
  if (options.readOnly) blockers.push("read-only audit mode cannot close a mission");
  if (options.stateCorrupted) blockers.push("current per-session Handoff state is corrupt or was recovered from corruption");
  if (options.renewalBusy) blockers.push("a Handoff renewal or session transition is in progress");
  if (options.cycleBusy) blockers.push("a documentation-cycle transition is in progress");
  if (fs.exists(roots.ownerRecovery)) blockers.push("an owner-lock recovery marker exists; ownership state is uncertain");
  if (fs.exists(roots.pending)) blockers.push("a prior mission-close attempt left an uncertain pending marker");
  if (!fs.createExclusive || !fs.createExclusiveAtomic) blockers.push("filesystem adapter cannot atomically publish a complete closure record exclusively");
  if (!fs.listFilesStrict) blockers.push("filesystem adapter cannot distinguish an empty tree from an unreadable directory");
  if (!fs.hashFile) blockers.push("filesystem adapter cannot hash mission files as raw bytes");

  const checkpointId = checkpoint.kind === "current" ? checkpoint.identity?.id ?? null : null;
  const attestation = checkpoint.kind === "current" ? checkpoint.readiness?.state ?? "unknown" : "not-current";
  const checkpointView = { id: checkpointId, state: checkpoint.kind, attestation };
  if (checkpoint.kind !== "current" || !checkpointId || checkpoint.readiness?.state !== "attested") {
    blockers.push(`normal closure requires a current, attested checkpoint (now ${checkpoint.kind}/${attestation})`);
  }
  const renewalPath = pathDefault.join(stateDir, "renewal-state.json");
  const renewalParsed = parseRenewalState(fs.readFile(renewalPath));
  if (renewalParsed.status !== "valid") blockers.push(`renewal chain state is ${renewalParsed.status}: ${renewalParsed.detail ?? "restore a coherent stateDir backup"}`);
  else if (!renewalParsed.state.chainId.startsWith(`mission:${missionId}:`)) blockers.push("renewal chain identity does not belong to the selected mission instance");
  const cyclePath = pathDefault.join(stateDir, "documentation-cycle/state.json");
  const cycle = parseDocumentationCycleState(fs.readFile(cyclePath));
  const cyclePhase = cycle.corrupt ? "corrupt" : cycle.state?.phase ?? "idle";
  if (cycle.corrupt) blockers.push("documentation-cycle state is corrupt");
  else if (cycle.state && !["complete", "abandoned"].includes(cycle.state.phase)) blockers.push(`documentation cycle is incomplete (${cycle.state.phase})`);
  if (fs.exists(pathDefault.join(stateDir, "documentation-cycle/transition.lock"))) blockers.push("documentation-cycle transaction lock exists");

  const payload = {
    schema: MISSION_CLOSURE_SCHEMA,
    missionId,
    stateRoot: pathDefault.resolve(stateDir),
    workProfile: manifest.profile,
    files: inventory.files,
    checkpoint: checkpointView,
    renewalState: renewalParsed.state,
    renewalMax,
    cyclePhase,
  };
  const fingerprint = sha256(JSON.stringify(payload));
  return {
    missionId,
    missionRoot: roots.root,
    stateRoot: pathDefault.resolve(stateDir),
    workProfile: manifest.profile,
    files: inventory.files,
    checkpoint: checkpointView,
    renewalState: renewalParsed.state,
    renewalMax,
    cyclePhase,
    gitRevision: options.gitRevision ?? null,
    fingerprint,
    blockers: [...new Set(blockers)],
  };
}

export function makeMissionClosureRecord(plan: MissionClosurePlan, reason: string, closedAt = new Date().toISOString()): MissionClosureRecord {
  if (!reason.trim()) throw new Error("closure reason must not be empty");
  if (plan.blockers.length > 0 || !plan.checkpoint.id || plan.checkpoint.attestation !== "attested") throw new Error("cannot create a closure record from a blocked or unattested plan");
  return {
    schema: MISSION_CLOSURE_SCHEMA,
    missionId: plan.missionId,
    workProfile: plan.workProfile,
    closedAt,
    reason: reason.trim(),
    files: { ...plan.files },
    stateRoot: plan.stateRoot,
    sourceFingerprint: plan.fingerprint,
    checkpoint: { id: plan.checkpoint.id, attestation: "attested" },
    renewalState: { ...plan.renewalState },
    renewalMax: plan.renewalMax,
    gitRevision: plan.gitRevision,
    operationId: `close:${plan.fingerprint}`,
  };
}

export function parseMissionClosure(raw: string | undefined, missionId: string): MissionClosureRecord | undefined {
  return parseClosure(raw, missionId);
}

export function inspectMissionClosure(fs: FsOps, cwd: string, missionId: string, stateDir: string): MissionClosureInspection {
  if (!validMissionInstanceId(missionId) || !instancePathIsSafe(fs, cwd, missionId)) {
    return { state: "uncertain", detail: "mission identity/path is invalid or resolves outside the project" };
  }
  const roots = missionClosurePaths(cwd, missionId);
  const raw = fs.readFile(roots.closure);
  if (raw === undefined) {
    if (fs.exists(roots.pending)) return { state: "uncertain", detail: "a prior close operation left an unresolved pending marker; preserve it and inspect before any mutation" };
    return { state: "active", detail: "no closure record exists" };
  }
  const record = parseClosure(raw, missionId);
  if (!record) return { state: "uncertain", detail: "closure.json exists but is incomplete or corrupt; instance remains sealed against mutation" };
  if (pathDefault.resolve(stateDir) !== record.stateRoot) {
    return { state: "changed", detail: "CLOSED mission state root differs from the sealed root externally; all Handoff mutations remain refused", record, changed: ["state-root"] };
  }
  const inventory = currentFileInventory(fs, cwd, missionId, stateDir);
  const expected = record.files;
  const actual = inventory.files;
  const changed = new Set<string>();
  for (const [name, hash] of Object.entries(expected)) if (actual[name] !== hash) changed.add(name);
  for (const name of Object.keys(actual)) if (expected[name] === undefined) changed.add(name);
  for (const error of inventory.errors) changed.add(error);
  if (changed.size) return { state: "changed", detail: "CLOSED mission files changed externally or are missing; all Handoff mutations remain refused", record, changed: [...changed].sort() };
  if (fs.exists(roots.pending)) return { state: "uncertain", detail: "closure record validates, but a pending close marker remains; preserve it for explicit inspection", record, changed: [] };
  return { state: "closed", detail: "closure record and sealed file hashes validate", record, changed: [] };
}
