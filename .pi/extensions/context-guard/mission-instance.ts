/** Mission-instance identity and isolated storage layout. No migration or project writes. */
import pathDefault from "node:path";
import type { FsOps } from "./checkpoint.ts";
import type { GuardConfig, GuardFiles, WorkProfileRef } from "./config.ts";

export const MISSION_INSTANCE_ROOT = ".pi-handoff/instances";
export const INSTANCE_STATE_ROOT = ".pi-guard/instances";

export function validMissionInstanceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && id !== "." && id !== "..";
}

export function validWorkProfileRef(profile: WorkProfileRef | null): boolean {
  return profile === null || (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.id) && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(profile.version));
}

export function workProfilePath(profile: WorkProfileRef): string {
  if (!validWorkProfileRef(profile)) throw new Error("invalid work profile reference");
  return pathDefault.posix.join(".pi-handoff/work-profiles", profile.id, `${profile.version}.json`);
}

export function validateWorkProfile(fs: FsOps, cwd: string, profile: WorkProfileRef): { path: string; error?: string } {
  const relative = workProfilePath(profile);
  const absolute = pathDefault.resolve(cwd, relative);
  const project = fs.realpath?.(cwd) ?? pathDefault.resolve(cwd);
  const real = fs.realpath?.(absolute);
  if (real) {
    const rel = pathDefault.relative(project, real);
    if (rel.startsWith("..") || pathDefault.isAbsolute(rel)) return { path: relative, error: "work profile path resolves outside the project" };
  }
  const raw = fs.readFile(absolute);
  if (raw === undefined) return { path: relative, error: `versioned work profile is missing: ${relative}` };
  try {
    const value = JSON.parse(raw) as { schema?: number; id?: string; version?: string; instructions?: unknown; knowledgeRefs?: unknown };
    if (value.schema !== 1 || value.id !== profile.id || value.version !== profile.version || !Array.isArray(value.instructions) || !value.instructions.every((x) => typeof x === "string") || !Array.isArray(value.knowledgeRefs) || !value.knowledgeRefs.every((x) => typeof x === "string")) {
      return { path: relative, error: "work profile must match its id/version and contain string arrays `instructions` and `knowledgeRefs`" };
    }
    return { path: relative };
  } catch {
    return { path: relative, error: "versioned work profile JSON is unreadable" };
  }
}

export function missionInstancePaths(id: string): { root: string; stateDir: string; files: GuardFiles } {
  if (!validMissionInstanceId(id)) throw new Error("mission instance id must use 1–64 letters, digits, dots, underscores or hyphens and cannot be . or ..");
  const root = pathDefault.posix.join(MISSION_INSTANCE_ROOT, id);
  return {
    root,
    stateDir: pathDefault.posix.join(INSTANCE_STATE_ROOT, id),
    files: {
      goal: "GOAL.md", // shared project objective/rules; still protected by the existing guard
      handoff: pathDefault.posix.join(root, "HANDOFF.md"),
      progress: pathDefault.posix.join(root, "PROGRESS.md"),
      learnings: pathDefault.posix.join(root, "LEARNINGS.md"),
    },
  };
}

/** Apply an explicit per-process identity. An unset id leaves every legacy path intact. */
export function configForMissionInstance(config: GuardConfig): GuardConfig {
  const id = config.missionInstance.id;
  if (id === null) return config;
  const paths = missionInstancePaths(id);
  return {
    ...config,
    files: paths.files,
    stateDir: pathDefault.join(config.stateDir, "instances", id),
  };
}

export function missionChainId(id: string | null, sessionId: string): string {
  return `${id ? `mission:${id}:` : ""}chain:${sessionId}`;
}

const STARTER_FILES: Record<string, string> = {
  "HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n\n## Last verified state\n\n## Unfinished operations\n\n## Next action\n\n## Discoveries not yet incorporated\n\n",
  "PROGRESS.md": "# PROGRESS\n\n## Current phase\n\n## Completed\n\n## Pending\n\n## Verified evidence\n\n## Blockers\n\n## Next action\n\n",
  "LEARNINGS.md": "# LEARNINGS\n\n## Accepted\n\n## Proposed\n\n## Falsified or superseded\n\n",
};

export type CreateInstanceResult = { ok: true; created: string[]; resumed: boolean } | { ok: false; error: string };

export function readMissionInstanceProfile(fs: FsOps, cwd: string, id: string): { profile: WorkProfileRef | null; error?: string } {
  if (!validMissionInstanceId(id)) return { profile: null, error: "invalid mission instance id" };
  if (!instancePathIsSafe(fs, cwd, id)) return { profile: null, error: "instance path or one of its parent directories resolves outside the project" };
  const manifestPath = pathDefault.resolve(cwd, missionInstancePaths(id).root, "mission.json");
  const raw = fs.readFile(manifestPath);
  if (raw === undefined) return { profile: null, error: `mission instance ${id} has no identity manifest; create it explicitly first` };
  try {
    const manifest = JSON.parse(raw) as { schema?: number; id?: string; workProfile?: unknown };
    if (manifest.schema !== 1 || manifest.id !== id) return { profile: null, error: "instance identity manifest is corrupt or does not match the selected id" };
    const profile = manifest.workProfile === null || manifest.workProfile === undefined
      ? null
      : manifest.workProfile as WorkProfileRef;
    if (!validWorkProfileRef(profile)) return { profile: null, error: "instance manifest has an invalid work profile reference" };
    if (profile) {
      const checked = validateWorkProfile(fs, cwd, profile);
      if (checked.error) return { profile: null, error: checked.error };
    }
    return { profile };
  } catch {
    return { profile: null, error: "instance identity manifest is unreadable; preserve it and inspect manually" };
  }
}

/**
 * Operator-invoked, non-overwriting creation. The manifest is an exclusive identity
 * claim; after a crash, retry fills only missing starter files and never replaces text.
 */
export function createMissionInstance(
  fs: FsOps,
  cwd: string,
  id: string,
  profile: WorkProfileRef | null,
  createdAt = new Date().toISOString(),
): CreateInstanceResult {
  if (!validMissionInstanceId(id)) return { ok: false, error: "invalid mission instance id" };
  if (!validWorkProfileRef(profile)) return { ok: false, error: "invalid work profile reference" };
  if (!instancePathIsSafe(fs, cwd, id)) return { ok: false, error: "instance storage path resolves outside the project" };
  if (profile) {
    const checked = validateWorkProfile(fs, cwd, profile);
    if (checked.error) return { ok: false, error: checked.error };
  }
  const paths = missionInstancePaths(id);
  const absoluteRoot = pathDefault.resolve(cwd, paths.root);
  const manifestPath = pathDefault.join(absoluteRoot, "mission.json");
  const existing = fs.readFile(manifestPath);
  if (existing !== undefined) {
    try {
      const manifest = JSON.parse(existing) as { schema?: number; id?: string; workProfile?: WorkProfileRef | null };
      if (manifest.schema !== 1 || manifest.id !== id || JSON.stringify(manifest.workProfile ?? null) !== JSON.stringify(profile)) {
        return { ok: false, error: "instance id already exists with a different identity or work profile" };
      }
    } catch {
      return { ok: false, error: "existing instance manifest is corrupt; preserve it and inspect it manually" };
    }
  } else {
    if (Object.keys(STARTER_FILES).some((name) => fs.exists(pathDefault.join(absoluteRoot, name)))) {
      return { ok: false, error: "instance directory has files but no identity manifest; preserve it and inspect it manually" };
    }
    fs.mkdirRecursive(absoluteRoot);
    const manifest = JSON.stringify({ schema: 1, id, workProfile: profile, createdAt }, null, 2) + "\n";
    if (fs.createExclusive) {
      if (!fs.createExclusive(manifestPath, manifest)) return { ok: false, error: "another session created this instance concurrently" };
    } else {
      if (fs.exists(manifestPath)) return { ok: false, error: "another session created this instance concurrently" };
      fs.writeFile(manifestPath, manifest);
    }
  }
  const created: string[] = [];
  for (const [name, content] of Object.entries(STARTER_FILES)) {
    const file = pathDefault.join(absoluteRoot, name);
    if (fs.exists(file)) continue;
    if (fs.createExclusive) {
      if (fs.createExclusive(file, content)) created.push(name);
    } else {
      if (!fs.exists(file)) { fs.writeFile(file, content); created.push(name); }
    }
  }
  return { ok: true, created, resumed: existing !== undefined };
}

export function instancePathIsSafe(fs: FsOps, cwd: string, id: string): boolean {
  const paths = missionInstancePaths(id);
  const project = fs.realpath?.(cwd) ?? pathDefault.resolve(cwd);
  const root = pathDefault.resolve(cwd, paths.root);
  // Walk up to the nearest existing ancestor. Checking only dirname(root) misses a
  // symlinked `.pi-handoff` when `instances/<id>` has not been created yet.
  let candidate = root;
  for (;;) {
    const real = fs.realpath?.(candidate);
    if (real) {
      const rel = pathDefault.relative(project, real);
      return rel === "" || (!rel.startsWith("..") && !pathDefault.isAbsolute(rel));
    }
    const parent = pathDefault.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const rel = pathDefault.relative(project, root);
  return rel === "" || (!rel.startsWith("..") && !pathDefault.isAbsolute(rel));
}
