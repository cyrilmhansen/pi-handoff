/** Durable, renewal-independent state for an operator-supervised doc cycle. */

export const DOCUMENTATION_CYCLE_VERSION = 1;
export const DOCUMENTATION_CYCLE_STATE_FILE = "documentation-cycle/state.json";

export type DocumentationCyclePhase =
  | "planning"
  | "approved"
  | "applying"
  | "reviewing"
  | "needs-correction"
  | "verified"
  | "no-change"
  | "continuing"
  | "complete"
  | "abandoned";

export interface DocumentationCycleState {
  version: 1;
  cycleId: string;
  phase: DocumentationCyclePhase;
  baseRevision: string;
  baseFingerprint: string;
  goalFingerprint: string;
  planFile: string;
  reviewFile: string;
  createdAt: number;
  updatedAt: number;
  stageStartedBy: string;
  planHash?: string;
  reviewRevision?: string;
  reviewFingerprint?: string;
  reviewHash?: string;
  verifiedRevision?: string;
  verifiedFingerprint?: string;
  noChange?: boolean;
  archivePath?: string;
  archivedRenewalState?: string;
  nextChainId?: string;
  nextChainUpdatedAt?: number;
  nextRenewalState?: string;
}

const PHASES = new Set<DocumentationCyclePhase>([
  "planning", "approved", "applying", "reviewing", "needs-correction", "verified", "no-change", "continuing", "complete", "abandoned",
]);

export function parseDocumentationCycleState(raw: string | undefined): { state?: DocumentationCycleState; corrupt: boolean } {
  if (raw === undefined || raw === "") return { corrupt: false };
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (
      p.version !== DOCUMENTATION_CYCLE_VERSION ||
      typeof p.cycleId !== "string" ||
      typeof p.phase !== "string" || !PHASES.has(p.phase as DocumentationCyclePhase) ||
      typeof p.baseRevision !== "string" ||
      typeof p.baseFingerprint !== "string" ||
      typeof p.goalFingerprint !== "string" ||
      typeof p.planFile !== "string" ||
      typeof p.reviewFile !== "string" ||
      typeof p.createdAt !== "number" ||
      typeof p.updatedAt !== "number" ||
      typeof p.stageStartedBy !== "string"
    ) return { corrupt: true };
    const optionalStrings = ["planHash", "reviewRevision", "reviewFingerprint", "reviewHash", "verifiedRevision", "verifiedFingerprint", "archivePath", "archivedRenewalState", "nextChainId", "nextRenewalState"];
    if (!/^dc-[a-z0-9]+-[0-9a-f]{12}$/.test(p.cycleId)) return { corrupt: true };
    if (p.nextChainUpdatedAt !== undefined && typeof p.nextChainUpdatedAt !== "number") return { corrupt: true };
    if (optionalStrings.some((k) => p[k] !== undefined && typeof p[k] !== "string")) return { corrupt: true };
    if (p.noChange !== undefined && typeof p.noChange !== "boolean") return { corrupt: true };
    return { state: p as unknown as DocumentationCycleState, corrupt: false };
  } catch {
    return { corrupt: true };
  }
}

export function serializeDocumentationCycleState(state: DocumentationCycleState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/** Stable fingerprint of the exact source files used to bind planning/review. */
export function documentationSourceFingerprint(sources: Record<string, string>, sha256: (s: string) => string): string {
  return sha256(Object.keys(sources).sort().map((name) => `${name}\0${sources[name]}`).join("\0"));
}

export function documentationCycleId(baseRevision: string, fingerprint: string, sessionId: string, now: number, sha256: (s: string) => string): string {
  return `dc-${now.toString(36)}-${sha256(`${baseRevision}\0${fingerprint}\0${sessionId}\0${now}`).slice(0, 12)}`;
}

export function cycleMetadata(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(0, 24)) {
    const m = /^(Cycle-ID|Base-Revision|Base-Fingerprint|Review-Revision|Review-Fingerprint|Result|Target-Files|Review-Result):\s*(.*?)\s*$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}
