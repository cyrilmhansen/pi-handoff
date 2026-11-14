/** Append-only, operator-approved project knowledge publications. */
import pathDefault from "node:path";
import { sha256, type FsOps } from "./checkpoint.ts";
import { inspectMissionClosure } from "./mission-lifecycle.ts";
import { missionInstancePaths, readMissionInstanceProfile, validMissionInstanceId, type WorkProfileRef } from "./mission-instance.ts";
import { inspectInstanceLock, instanceLockPath, recoveryMarkerPath, ownsInstanceLock } from "./mission-lock.ts";
import type { CheckpointFreshness } from "./checkpoint.ts";

export const KNOWLEDGE_ROOT = ".pi-handoff/knowledge";
export const KNOWLEDGE_PROPOSALS = `${KNOWLEDGE_ROOT}/proposals`;
export const KNOWLEDGE_RECORDS = `${KNOWLEDGE_ROOT}/records`;
export const KNOWLEDGE_LOCK = `${KNOWLEDGE_ROOT}/.publish.lock`;
export const MAX_KNOWLEDGE_PROPOSAL_BYTES = 128 * 1024;
export const MAX_KNOWLEDGE_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const MAX_KNOWLEDGE_TOTAL_EVIDENCE_BYTES = 64 * 1024 * 1024;

export type KnowledgeClassification = "accepted" | "proposed" | "falsified" | "superseded";
export interface KnowledgeEvidenceRef { path: string; sha256: string; description: string }
export interface KnowledgeSourceRef { path: string; locator: string; sha256: string }
export interface KnowledgeProposal {
  schema: 1;
  id: string;
  missionId: string;
  classification: KnowledgeClassification;
  statement: string;
  rationale: string;
  source: KnowledgeSourceRef;
  evidence: KnowledgeEvidenceRef[];
  supersedes?: { publicationId: string; reason: string };
}
export interface KnowledgeRecord {
  schema: 1;
  publicationId: string;
  publicationFingerprint: string;
  transactionId: string;
  knowledgeId: string;
  sourceMissionId: string;
  workProfile: WorkProfileRef | null;
  classification: KnowledgeClassification;
  statement: string;
  rationale: string;
  source: KnowledgeSourceRef;
  evidence: KnowledgeEvidenceRef[];
  sourceCheckpoint: string | null;
  sourceClosure: string | null;
  sourceStateRoot: string | null;
  supersedes: { publicationId: string; reason: string } | null;
  publishedAt: string;
  decision: { actor: "operator"; sessionId: string; approvalFingerprint: string };
}

export interface KnowledgePlan {
  missionId: string;
  proposalPath: string;
  proposal: KnowledgeProposal | null;
  proposalHash: string | null;
  publicationId: string | null;
  publicationFingerprint: string;
  registryFingerprint: string;
  registryCount: number;
  workProfile: WorkProfileRef | null;
  sourceCheckpoint: string | null;
  sourceClosure: string | null;
  sourceStateRoot: string | null;
  evidenceBytes: number;
  idempotent: boolean;
  conflict: string | null;
  blockers: string[];
}

export type KnowledgeRegistryRecord = { record: KnowledgeRecord; state: "current" | "superseded" };
export interface KnowledgeRegistryRead {
  records: KnowledgeRecord[];
  fingerprint: string;
  errors: string[];
  warnings: string[];
}

const CLASSIFICATIONS = new Set<KnowledgeClassification>(["accepted", "proposed", "falsified", "superseded"]);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PUBLICATION_ID = /^[a-f0-9]{64}$/;

function canonical(value: unknown): string { return JSON.stringify(value); }
type KnowledgeContent = {
  schema: 1;
  knowledgeId: string;
  sourceMissionId: string;
  workProfile: WorkProfileRef | null;
  classification: KnowledgeClassification;
  statement: string;
  rationale: string;
  source: KnowledgeSourceRef;
  evidence: KnowledgeEvidenceRef[];
  sourceCheckpoint: string | null;
  sourceClosure: string | null;
  sourceStateRoot: string | null;
  supersedes: { publicationId: string; reason: string } | null;
};
function inside(root: string, candidate: string): boolean {
  const rel = pathDefault.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !pathDefault.isAbsolute(rel));
}

function knowledgeContent(record: KnowledgeContent): Record<string, unknown> {
  return {
    schema: record.schema,
    knowledgeId: record.knowledgeId,
    sourceMissionId: record.sourceMissionId,
    workProfile: record.workProfile,
    classification: record.classification,
    statement: record.statement,
    rationale: record.rationale,
    source: record.source,
    evidence: record.evidence,
    supersedes: record.supersedes ?? null,
  };
}

function recordBody(record: Omit<KnowledgeRecord, "publicationFingerprint"> | KnowledgeRecord): Record<string, unknown> {
  const { publicationFingerprint: _ignored, ...body } = record as KnowledgeRecord;
  return body;
}

function parseKnowledgeRecord(raw: string | undefined, expectedKnowledgeId?: string, expectedPublicationId?: string): KnowledgeRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as KnowledgeRecord;
    if (value.schema !== 1 || !ID.test(value.knowledgeId) || (expectedKnowledgeId && value.knowledgeId !== expectedKnowledgeId) ||
      !validMissionInstanceId(value.sourceMissionId) || !CLASSIFICATIONS.has(value.classification) ||
      typeof value.statement !== "string" || typeof value.rationale !== "string" || !value.source ||
      !Array.isArray(value.evidence) || !value.evidence.length || !HASH.test(value.publicationId) ||
      (expectedPublicationId && value.publicationId !== expectedPublicationId) || !HASH.test(value.publicationFingerprint) ||
      value.transactionId !== `publish:${value.publicationId}` || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt)) ||
      !value.decision || value.decision.actor !== "operator" || typeof value.decision.sessionId !== "string" ||
      !HASH.test(value.decision.approvalFingerprint) || !value.source || !validSource(value.source) ||
      !validEvidence(value.evidence) || (value.workProfile !== null && (!value.workProfile || !ID.test(value.workProfile.id) || typeof value.workProfile.version !== "string")) ||
      (value.sourceCheckpoint !== null && typeof value.sourceCheckpoint !== "string") ||
      (value.sourceClosure !== null && typeof value.sourceClosure !== "string") ||
      (value.sourceStateRoot !== null && (typeof value.sourceStateRoot !== "string" || pathDefault.resolve(value.sourceStateRoot) !== value.sourceStateRoot)) ||
      (value.supersedes !== null && (!value.supersedes || !HASH.test(value.supersedes.publicationId) || typeof value.supersedes.reason !== "string"))) return undefined;
    if (sha256(canonical(knowledgeContent(value))) !== value.publicationId) return undefined;
    if (sha256(canonical(recordBody(value))) !== value.publicationFingerprint) return undefined;
    return value;
  } catch { return undefined; }
}

function validSource(value: unknown): value is KnowledgeSourceRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as KnowledgeSourceRef;
  return typeof ref.path === "string" && typeof ref.locator === "string" && ref.locator.trim().length > 0 &&
    HASH.test(ref.sha256) && ref.path.length <= 512 && ref.locator.length <= 256;
}

function validEvidence(value: unknown): value is KnowledgeEvidenceRef[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every((item) =>
    item && typeof item === "object" && typeof item.path === "string" && item.path.length <= 512 &&
    HASH.test(item.sha256) && typeof item.description === "string" && item.description.length <= 512);
}

function readSafeFile(fs: FsOps, cwd: string, rel: string, limit: number): { absolute: string; text: string; hash: string; size: number } | { error: string } {
  if (!rel || rel.includes("\0") || rel.includes("\\") || pathDefault.posix.isAbsolute(rel) || pathDefault.posix.normalize(rel) !== rel || rel.split("/").some((part) => part === ".." || part === "." || !part)) {
    return { error: `unsafe project-relative path: ${rel}` };
  }
  if (!fs.realpath || !fs.hashFile || !fs.fileSize) return { error: "filesystem cannot verify canonical paths and raw-byte file identity" };
  const project = pathDefault.resolve(fs.realpath(cwd) ?? cwd);
  const absolute = pathDefault.resolve(project, rel);
  if (!inside(project, absolute)) return { error: `path escapes the project: ${rel}` };
  const real = fs.realpath(absolute);
  if (!real || pathDefault.resolve(real) !== absolute || !inside(project, pathDefault.resolve(real))) {
    return { error: `missing file or symbolic-link path refused: ${rel}` };
  }
  const size = fs.fileSize(absolute);
  if (size === undefined) return { error: `not a readable regular file: ${rel}` };
  if (size > limit) return { error: `file exceeds the ${limit}-byte limit: ${rel}` };
  const text = fs.readFileLimited?.(absolute, limit);
  if (!text || text.tooLarge) return { error: `file could not be read within the ${limit}-byte limit: ${rel}` };
  if (text.size !== undefined && text.size !== size) return { error: `file changed while being read: ${rel}` };
  const canonicalAfterRead = fs.realpath(absolute);
  if (!canonicalAfterRead || pathDefault.resolve(canonicalAfterRead) !== absolute) return { error: `file path changed during verification: ${rel}` };
  const hash = text.sha256 ?? fs.hashFile(absolute);
  if (!hash) return { error: `raw-byte hash unavailable: ${rel}` };
  return { absolute, text: text.content, hash, size };
}

/** Refuse every existing symlink along registry paths before reads or publication. */
export function knowledgePathsSafe(fs: FsOps, cwd: string, knowledgeId?: string): boolean {
  if (!fs.realpath) return false;
  const project = pathDefault.resolve(fs.realpath(cwd) ?? cwd);
  const paths = [
    pathDefault.resolve(project, KNOWLEDGE_ROOT),
    pathDefault.resolve(project, KNOWLEDGE_RECORDS),
    pathDefault.resolve(project, KNOWLEDGE_LOCK),
    ...(knowledgeId ? [pathDefault.resolve(project, KNOWLEDGE_RECORDS, knowledgeId)] : []),
  ];
  for (const target of paths) {
    let current = target;
    for (;;) {
      const real = fs.realpath(current);
      if (real) {
        if (pathDefault.resolve(real) !== current || !inside(project, pathDefault.resolve(real))) return false;
        break;
      }
      const parent = pathDefault.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
  return true;
}

export function knowledgeProposalPath(name: string): string | undefined {
  const base = name.endsWith(".json") ? name : `${name}.json`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(base)) return undefined;
  return pathDefault.posix.join(KNOWLEDGE_PROPOSALS, base);
}

function parseProposal(raw: string): KnowledgeProposal | undefined {
  try {
    const p = JSON.parse(raw) as KnowledgeProposal;
    const keys = Object.keys(p as object).sort().join(",");
    const allowed = ["classification", "evidence", "id", "missionId", "rationale", "schema", "source", "statement", "supersedes"];
    if (keys !== allowed.filter((key) => key in (p as object)).sort().join(",")) return undefined;
    if (p.schema !== 1 || !ID.test(p.id) || !validMissionInstanceId(p.missionId) || !CLASSIFICATIONS.has(p.classification) ||
      typeof p.statement !== "string" || !p.statement.trim() || p.statement.length > 8_000 ||
      typeof p.rationale !== "string" || !p.rationale.trim() || p.rationale.length > 12_000 ||
      !validSource(p.source) || !validEvidence(p.evidence)) return undefined;
    if (p.classification === "superseded" && !p.supersedes) return undefined;
    if (p.supersedes && (!HASH.test(p.supersedes.publicationId) || typeof p.supersedes.reason !== "string" || !p.supersedes.reason.trim() || p.supersedes.reason.length > 4_000)) return undefined;
    return {
      schema: 1, id: p.id, missionId: p.missionId, classification: p.classification,
      statement: p.statement.trim(), rationale: p.rationale.trim(),
      source: { path: p.source.path, locator: p.source.locator.trim(), sha256: p.source.sha256.toLowerCase() },
      evidence: p.evidence.map((ref) => ({ path: ref.path, sha256: ref.sha256.toLowerCase(), description: ref.description.trim() })),
      ...(p.supersedes ? { supersedes: { publicationId: p.supersedes.publicationId.toLowerCase(), reason: p.supersedes.reason.trim() } } : {}),
    };
  } catch { return undefined; }
}

function recordsRoot(fs: FsOps, cwd: string): string { return pathDefault.resolve(fs.realpath?.(cwd) ?? cwd, KNOWLEDGE_RECORDS); }
export function knowledgeRegistryLockPath(cwd: string, fs?: FsOps): string { return pathDefault.resolve(fs?.realpath?.(cwd) ?? cwd, KNOWLEDGE_LOCK); }

export function readKnowledgeRegistry(fs: FsOps, cwd: string): KnowledgeRegistryRead {
  const root = recordsRoot(fs, cwd);
  const records: KnowledgeRecord[] = [];
  const hashes: Array<[string, string]> = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!knowledgePathsSafe(fs, cwd)) return { records, fingerprint: sha256("unsafe-registry-path"), errors: ["knowledge registry path contains a symbolic link or escapes the project"], warnings };
  let ids: string[];
  try { ids = fs.listFilesStrict ? fs.listFilesStrict(root) : fs.listFiles(root); }
  catch (err) {
    if (!fs.exists(root)) ids = [];
    else return { records, fingerprint: sha256("unreadable-registry"), errors: [`registry cannot be listed: ${err instanceof Error ? err.message : String(err)}`], warnings };
  }
  for (const id of ids.sort()) {
    if (!ID.test(id)) { errors.push(`unsafe or unexpected registry entry: ${id}`); continue; }
    const dir = pathDefault.join(root, id);
    const dirReal = fs.realpath?.(dir);
    if (dirReal && pathDefault.resolve(dirReal) !== pathDefault.resolve(dir)) {
      errors.push(`symbolic-link registry directory refused: ${id}`);
      continue;
    }
    let files: string[];
    try { files = fs.listFilesStrict ? fs.listFilesStrict(dir) : fs.listFiles(dir); }
    catch (err) { errors.push(`registry identity ${id} cannot be listed: ${err instanceof Error ? err.message : String(err)}`); continue; }
    for (const filename of files.sort()) {
      if (filename.includes(".tmp-")) { warnings.push(`uncommitted atomic publication artifact preserved for inspection: ${id}/${filename}`); continue; }
      const match = /^([a-f0-9]{64})\.json$/.exec(filename);
      if (!match) { errors.push(`unexpected registry file: ${id}/${filename}`); continue; }
      const file = pathDefault.join(dir, filename);
      const fileReal = fs.realpath?.(file);
      if (fileReal && pathDefault.resolve(fileReal) !== pathDefault.resolve(file)) {
        errors.push(`symbolic-link registry file refused: ${id}/${filename}`);
        continue;
      }
      const raw = fs.readFile(file);
      const digest = fs.hashFile?.(file) ?? (raw === undefined ? undefined : sha256(raw));
      if (!raw || !digest) { errors.push(`registry record is unreadable: ${id}/${filename}`); continue; }
      hashes.push([`${id}/${filename}`, digest]);
      const record = parseKnowledgeRecord(raw, id, match[1]);
      if (!record) { errors.push(`registry record is corrupt or has an invalid self-fingerprint: ${id}/${filename}`); continue; }
      records.push(record);
    }
  }
  const byPublication = new Map(records.map((record) => [record.publicationId, record]));
  for (const record of records) {
    const priorId = record.supersedes?.publicationId;
    if (!priorId) continue;
    const prior = byPublication.get(priorId);
    if (!prior || prior.knowledgeId !== record.knowledgeId || prior.publicationId === record.publicationId) {
      errors.push(`invalid supersession link in ${record.knowledgeId}/${record.publicationId}`);
    }
  }
  hashes.sort(([a], [b]) => a.localeCompare(b));
  return { records, fingerprint: sha256(canonical(hashes)), errors, warnings };
}

function registryTip(records: KnowledgeRecord[]): { tip?: KnowledgeRecord; conflict?: string } {
  if (!records.length) return {};
  const superseded = new Set(records.map((item) => item.supersedes?.publicationId).filter((x): x is string => !!x));
  const tips = records.filter((item) => !superseded.has(item.publicationId));
  if (tips.length !== 1) return { conflict: `registry contains ${tips.length} unsuperseded publications for this identity; operator arbitration is required` };
  return { tip: tips[0] };
}

export function planKnowledgePublication(options: {
  fs: FsOps; cwd: string; selectedMissionId: string | null; stateDir: string; checkpoint: CheckpointFreshness;
  ownsMission: boolean; ownsRegistryLock?: boolean; proposalName: string;
}): KnowledgePlan {
  const { fs, cwd, selectedMissionId, stateDir, checkpoint } = options;
  const blockers: string[] = [];
  const proposalPath = knowledgeProposalPath(options.proposalName);
  if (!proposalPath) blockers.push("proposal name must be a short filename under .pi-handoff/knowledge/proposals/");
  const proposalFile = proposalPath ? readSafeFile(fs, cwd, proposalPath, MAX_KNOWLEDGE_PROPOSAL_BYTES) : { error: "invalid proposal path" };
  if ("error" in proposalFile) blockers.push(proposalFile.error);
  const proposal = !("error" in proposalFile) ? parseProposal(proposalFile.text) : undefined;
  if (!proposal && !("error" in proposalFile)) blockers.push("proposal JSON is malformed, oversized by field limits, or has unknown fields");
  if (!selectedMissionId) blockers.push("publication requires an explicitly selected mission instance; legacy mode is not a publication source");
  else if (!validMissionInstanceId(selectedMissionId)) blockers.push("selected mission id is invalid; publication is refused");
  if (proposal && selectedMissionId && proposal.missionId !== selectedMissionId) blockers.push("proposal missionId does not match this Pi process's selected instance");
  if (proposal && selectedMissionId && !options.ownsMission) {
    const closure = inspectMissionClosure(fs, cwd, selectedMissionId, stateDir);
    if (closure.state !== "closed") blockers.push("active or non-closed source missions require this process to own the Lot G instance lock");
  }

  let profile: WorkProfileRef | null = null;
  let sourceClosure: string | null = null;
  let sourceStateRoot: string | null = null;
  if (selectedMissionId && validMissionInstanceId(selectedMissionId)) {
    const identity = readMissionInstanceProfile(fs, cwd, selectedMissionId);
    if (identity.error) blockers.push(identity.error);
    else profile = identity.profile;
    const closure = inspectMissionClosure(fs, cwd, selectedMissionId, stateDir);
    if (closure.state === "closed") { sourceClosure = closure.record.operationId; sourceStateRoot = closure.record.stateRoot; }
    else if (closure.state === "changed" || closure.state === "uncertain") blockers.push(`sealed source mission is ${closure.state}: ${closure.detail}`);
  }
  if (selectedMissionId && validMissionInstanceId(selectedMissionId) && options.ownsMission && !options.readOnly && !profile && fs.readFile(pathDefault.resolve(cwd, missionInstancePaths(selectedMissionId).root, "mission.json")) === undefined) {
    blockers.push("mission identity is unavailable");
  }

  let proposalHash: string | null = null;
  if (!("error" in proposalFile)) proposalHash = proposalFile.hash;
  let evidenceBytes = 0;
  let sourceObservedHash: string | null = null;
  const evidenceObservations: Array<[string, string | null]> = [];
  if (proposal && selectedMissionId && validMissionInstanceId(selectedMissionId)) {
    const instancePaths = missionInstancePaths(selectedMissionId);
    const sourceAllowed = new Set([instancePaths.files.learnings, instancePaths.files.handoff, instancePaths.files.progress]);
    if (!sourceAllowed.has(proposal.source.path)) blockers.push("source.path must identify this mission's HANDOFF.md, PROGRESS.md or LEARNINGS.md");
    const source = readSafeFile(fs, cwd, proposal.source.path, 2 * 1024 * 1024);
    if ("error" in source) blockers.push(source.error);
    else {
      sourceObservedHash = source.hash;
      if (source.hash !== proposal.source.sha256) blockers.push(`mission source hash changed: ${proposal.source.path}`);
      if (!source.text.includes(proposal.source.locator)) blockers.push(`source locator is not present in ${proposal.source.path}`);
    }
    for (const ref of proposal.evidence) {
      const evidence = readSafeFile(fs, cwd, ref.path, MAX_KNOWLEDGE_EVIDENCE_BYTES);
      if ("error" in evidence) { blockers.push(evidence.error); evidenceObservations.push([ref.path, null]); }
      else {
        evidenceBytes += evidence.size;
        evidenceObservations.push([ref.path, evidence.hash]);
        if (evidence.hash !== ref.sha256) blockers.push(`evidence hash changed: ${ref.path}`);
      }
    }
    if (evidenceBytes > MAX_KNOWLEDGE_TOTAL_EVIDENCE_BYTES) blockers.push(`combined evidence references exceed ${MAX_KNOWLEDGE_TOTAL_EVIDENCE_BYTES} bytes`);
  }

  const registry = readKnowledgeRegistry(fs, cwd);
  blockers.push(...registry.errors);
  if (registry.warnings.length) blockers.push("uncommitted atomic publication artifacts require explicit inspection before any new publication");
  const registryLock = knowledgeRegistryLockPath(cwd, fs);
  if (fs.exists(recoveryMarkerPath(registryLock))) blockers.push("a registry publication-lock recovery marker exists; inspect it explicitly");
  if (fs.exists(registryLock) && !(options.ownsRegistryLock && ownsInstanceLock(fs, registryLock))) blockers.push("another or abandoned publication lock exists; inspect /handoff knowledge status");

  let publicationId: string | null = null;
  let idempotent = false;
  let conflict: string | null = null;
  let sourceCheckpoint: string | null = null;
  if (checkpoint.kind === "current" || checkpoint.kind === "stale") sourceCheckpoint = checkpoint.identity?.id ?? null;
  if (proposal && selectedMissionId && validMissionInstanceId(selectedMissionId)) {
    const content: KnowledgeContent = {
      schema: 1 as const,
      knowledgeId: proposal.id,
      sourceMissionId: selectedMissionId,
      workProfile: profile,
      classification: proposal.classification,
      statement: proposal.statement,
      rationale: proposal.rationale,
      source: proposal.source,
      evidence: proposal.evidence,
      supersedes: proposal.supersedes ?? null,
    };
    publicationId = sha256(canonical(content));
    const sameId = registry.records.filter((record) => record.knowledgeId === proposal.id);
    idempotent = sameId.some((record) => record.publicationId === publicationId);
    if (!idempotent && sameId.length) {
      const tip = registryTip(sameId);
      if (tip.conflict) conflict = tip.conflict;
      else if (!proposal.supersedes) conflict = `knowledge identity ${proposal.id} already exists; a changed statement requires explicit supersession of ${tip.tip!.publicationId}`;
      else if (proposal.supersedes.publicationId !== tip.tip!.publicationId) conflict = `supersedes must point to the current publication ${tip.tip!.publicationId}`;
    } else if (!idempotent && proposal.supersedes) {
      conflict = "supersedes names a publication that is not the current registry tip for this identity";
    }
    if (proposal.classification === "superseded" && !proposal.supersedes) conflict = "a superseded classification requires an explicit prior publication";
  }
  if (conflict) blockers.push(conflict);
  const fingerprintPayload = {
    schema: 1,
    selectedMissionId,
    proposalPath,
    proposalHash,
    publicationId,
    registry: registry.fingerprint,
    profile,
    sourceCheckpoint,
    sourceClosure,
    sourceStateRoot,
    sourceObservedHash,
    evidenceObservations,
    evidenceBytes,
    conflict,
    blockers: [...new Set(blockers)],
  };
  return {
    missionId: selectedMissionId ?? "",
    proposalPath: proposalPath ?? "",
    proposal: proposal ?? null,
    proposalHash,
    publicationId,
    publicationFingerprint: sha256(canonical(fingerprintPayload)),
    registryFingerprint: registry.fingerprint,
    registryCount: registry.records.length,
    workProfile: profile,
    sourceCheckpoint,
    sourceClosure,
    sourceStateRoot,
    evidenceBytes,
    idempotent,
    conflict,
    blockers: [...new Set(blockers)],
  };
}

export function makeKnowledgeRecord(plan: KnowledgePlan, sessionId: string, publishedAt = new Date().toISOString()): KnowledgeRecord {
  if (!plan.proposal || !plan.publicationId || plan.blockers.length) throw new Error("cannot publish a blocked knowledge plan");
  const proposal = plan.proposal;
  const body: Omit<KnowledgeRecord, "publicationFingerprint"> = {
    schema: 1,
    publicationId: plan.publicationId,
    transactionId: `publish:${plan.publicationId}`,
    knowledgeId: proposal.id,
    sourceMissionId: proposal.missionId,
    workProfile: plan.workProfile,
    classification: proposal.classification,
    statement: proposal.statement,
    rationale: proposal.rationale,
    source: proposal.source,
    evidence: proposal.evidence,
    sourceCheckpoint: plan.sourceCheckpoint,
    sourceClosure: plan.sourceClosure,
    sourceStateRoot: plan.sourceStateRoot,
    supersedes: proposal.supersedes ?? null,
    publishedAt,
    decision: { actor: "operator", sessionId, approvalFingerprint: plan.publicationFingerprint },
  };
  return { ...body, publicationFingerprint: sha256(canonical(body)) };
}

export function knowledgeRecordPath(cwd: string, knowledgeId: string, publicationId: string, fs?: FsOps): string {
  if (!ID.test(knowledgeId) || !HASH.test(publicationId)) throw new Error("invalid knowledge record identity");
  return pathDefault.resolve(fs?.realpath?.(cwd) ?? cwd, KNOWLEDGE_RECORDS, knowledgeId, `${publicationId}.json`);
}

export function verifyKnowledgeReferences(fs: FsOps, cwd: string, record: KnowledgeRecord): { ok: boolean; detail: string[] } {
  const detail: string[] = [];
  const source = readSafeFile(fs, cwd, record.source.path, 2 * 1024 * 1024);
  if ("error" in source) detail.push(source.error);
  else {
    if (source.hash !== record.source.sha256) detail.push(`source hash mismatch: ${record.source.path}`);
    if (!source.text.includes(record.source.locator)) detail.push(`source locator missing: ${record.source.path}#${record.source.locator}`);
  }
  for (const ref of record.evidence) {
    const result = readSafeFile(fs, cwd, ref.path, MAX_KNOWLEDGE_EVIDENCE_BYTES);
    if ("error" in result) detail.push(result.error);
    else if (result.hash !== ref.sha256) detail.push(`evidence hash mismatch: ${ref.path}`);
  }
  if (record.sourceClosure) {
    const stateDir = record.sourceStateRoot ?? pathDefault.resolve(cwd, ".pi-guard", "instances", record.sourceMissionId);
    const closure = inspectMissionClosure(fs, cwd, record.sourceMissionId, stateDir);
    if (closure.state !== "closed" || closure.record?.operationId !== record.sourceClosure) detail.push(`source mission seal is ${closure.state}; expected ${record.sourceClosure}`);
  }
  return { ok: detail.length === 0, detail };
}

export function listKnowledge(fs: FsOps, cwd: string, filter: { classification?: KnowledgeClassification; missionId?: string; id?: string } = {}): { items: KnowledgeRegistryRecord[]; errors: string[]; warnings: string[] } {
  const registry = readKnowledgeRegistry(fs, cwd);
  const superseded = new Set(registry.records.map((record) => record.supersedes?.publicationId).filter((id): id is string => !!id));
  const items = registry.records
    .filter((record) => !filter.classification || record.classification === filter.classification)
    .filter((record) => !filter.missionId || record.sourceMissionId === filter.missionId)
    .filter((record) => !filter.id || record.knowledgeId === filter.id)
    .map((record) => ({ record, state: (superseded.has(record.publicationId) ? "superseded" : "current") as "current" | "superseded" }))
    .sort((a, b) => a.record.knowledgeId.localeCompare(b.record.knowledgeId) || a.record.publishedAt.localeCompare(b.record.publishedAt));
  return { items, errors: registry.errors, warnings: registry.warnings };
}

export function showKnowledge(fs: FsOps, cwd: string, id: string): { items: KnowledgeRegistryRecord[]; errors: string[]; warnings: string[] } {
  return listKnowledge(fs, cwd, { id });
}

export function verifyKnowledge(fs: FsOps, cwd: string, id: string): { ok: boolean; items: Array<{ record: KnowledgeRecord; state: "current" | "superseded"; references: string[] }>; errors: string[]; warnings: string[] } {
  const shown = showKnowledge(fs, cwd, id);
  const items = shown.items.map(({ record, state }) => {
    const refs = verifyKnowledgeReferences(fs, cwd, record);
    return { record, state, references: refs.detail };
  });
  const errors = [...shown.errors];
  const identityRecords = shown.items.map((x) => x.record);
  const tips = registryTip(identityRecords);
  if (tips.conflict) errors.push(tips.conflict);
  return { ok: errors.length === 0 && items.every((item) => item.references.length === 0), items, errors, warnings: shown.warnings };
}

export function formatKnowledgeRecord(item: KnowledgeRegistryRecord): string {
  const r = item.record;
  return `${r.knowledgeId} ${item.state} [${r.classification}] publication=${r.publicationId}\n  mission=${r.sourceMissionId}${r.workProfile ? ` profile=${r.workProfile.id}@${r.workProfile.version}` : ""}\n  ${r.statement}\n  source=${r.source.path}#${r.source.locator} sha256=${r.source.sha256}${r.sourceClosure ? ` seal=${r.sourceClosure}` : r.sourceCheckpoint ? ` checkpoint=${r.sourceCheckpoint}` : ""}\n  evidence=${r.evidence.length}; published=${r.publishedAt}${r.supersedes ? `; supersedes=${r.supersedes.publicationId} (${r.supersedes.reason})` : ""}`;
}

export function knowledgeRegistrySummary(fs: FsOps, cwd: string): { count: number; errors: string[]; warnings: string[]; lock: ReturnType<typeof inspectInstanceLock> } {
  const registry = readKnowledgeRegistry(fs, cwd);
  const lock = knowledgePathsSafe(fs, cwd)
    ? inspectInstanceLock(fs, knowledgeRegistryLockPath(cwd, fs))
    : { state: "corrupt" as const, detail: "unsafe registry path; lock was not read" };
  return { count: registry.records.length, errors: registry.errors, warnings: registry.warnings, lock };
}

export { inspectInstanceLock, ownsInstanceLock, recoveryMarkerPath };
