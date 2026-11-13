/** Conservative process ownership for one mission instance (local filesystems only). */
import { randomUUID } from "node:crypto";
import fsDefault from "node:fs";
import os from "node:os";
import pathDefault from "node:path";
import type { FsOps } from "./checkpoint.ts";

export interface InstanceLockOwner {
  schema: 1;
  token: string;
  pid: number;
  hostname: string;
  platform: string;
  sessionId: string;
  startedAt: string;
  bootId?: string;
  processStart?: string;
}

export type OwnerLiveness = "dead" | "pid-reused" | "alive" | "unknown";
export interface InstanceLockInspection {
  state: "missing" | "owned" | "abandoned" | "pid-reused" | "possibly-active" | "foreign-host" | "corrupt";
  owner?: InstanceLockOwner;
  detail: string;
}
export type InstanceLockResult = { ok: true; owner: InstanceLockOwner; resumed: boolean } | { ok: false; inspection: InstanceLockInspection; detail: string };

const owned = new Map<string, { fs: FsOps; owner: InstanceLockOwner }>();
let exitHookInstalled = false;

export function instanceLockPath(cwd: string, id: string): string {
  return pathDefault.resolve(cwd, ".pi-handoff", "instances", id, ".owner.lock");
}

export function recoveryMarkerPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function linuxIdentity(pid: number): { bootId?: string; processStart?: string } {
  if (process.platform !== "linux") return {};
  try {
    const bootId = fsDefault.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fsDefault.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may contain spaces or ')'; parse from its final ')'.
    const close = stat.lastIndexOf(")");
    if (close < 0) return { bootId };
    const fieldsFromState = stat.slice(close + 1).trim().split(/\s+/);
    const processStart = fieldsFromState[19]; // proc stat field 22, starttime
    return { bootId, ...(processStart ? { processStart } : {}) };
  } catch {
    return {};
  }
}

function makeOwner(sessionId: string): InstanceLockOwner {
  return {
    schema: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    platform: process.platform,
    sessionId,
    startedAt: new Date().toISOString(),
    ...linuxIdentity(process.pid),
  };
}

function parseOwner(raw: string | undefined): InstanceLockOwner | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<InstanceLockOwner>;
    if (value.schema !== 1 || typeof value.token !== "string" || !value.token || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.hostname !== "string" || typeof value.platform !== "string" || typeof value.sessionId !== "string" || typeof value.startedAt !== "string") return undefined;
    return value as InstanceLockOwner;
  } catch {
    return undefined;
  }
}

/** A PID that exists is never assumed to be the owner on macOS; recovery stays conservative. */
export function probeOwnerLiveness(owner: InstanceLockOwner): OwnerLiveness {
  if (owner.hostname !== os.hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
  if (process.platform === "linux" && owner.platform === "linux" && owner.bootId && owner.processStart) {
    const current = linuxIdentity(owner.pid);
    if (current.bootId && current.processStart && (current.bootId !== owner.bootId || current.processStart !== owner.processStart)) return "pid-reused";
  }
  return "alive";
}

export function inspectInstanceLock(fs: FsOps, lockPath: string, probe = probeOwnerLiveness): InstanceLockInspection {
  const raw = fs.readFile(lockPath);
  if (raw === undefined) return { state: "missing", detail: "no owner lock exists" };
  const owner = parseOwner(raw);
  if (!owner) return { state: "corrupt", detail: "owner lock metadata is missing or corrupt; ownership cannot be proven absent" };
  if (owner.hostname !== os.hostname()) return { state: "foreign-host", owner, detail: `owner host ${owner.hostname} differs from this host; process liveness cannot be checked here` };
  const live = probe(owner);
  if (live === "dead") return { state: "abandoned", owner, detail: `owner pid ${owner.pid} is confirmed absent` };
  if (live === "pid-reused") return { state: "pid-reused", owner, detail: `pid ${owner.pid} now identifies a different Linux process (boot id/start ticks differ)` };
  if (live === "alive") return { state: "possibly-active", owner, detail: `owner pid ${owner.pid} may still be running${owner.sessionId ? ` (session ${owner.sessionId})` : ""}` };
  return { state: "possibly-active", owner, detail: `owner pid ${owner.pid} liveness is uncertain; no automatic recovery is safe` };
}

function removeRecoveryMarkerIfOwned(fs: FsOps, markerPath: string, token: string): void {
  const current = parseOwner(fs.readFile(markerPath));
  if (current?.token === token) fs.remove(markerPath);
}

function releaseOne(lockPath: string, record: { fs: FsOps; owner: InstanceLockOwner }): boolean {
  const current = parseOwner(record.fs.readFile(lockPath));
  if (!current || current.token !== record.owner.token || current.pid !== process.pid) return false;
  record.fs.remove(lockPath);
  return true;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [lockPath, record] of owned) {
      try { releaseOne(lockPath, record); } catch { /* process exit hook must remain synchronous and best-effort */ }
    }
    owned.clear();
  });
}

export function acquireInstanceLock(fs: FsOps, lockPath: string, sessionId: string): InstanceLockResult {
  if (!fs.createExclusive) {
    const inspection = inspectInstanceLock(fs, lockPath);
    return { ok: false, inspection, detail: "this filesystem adapter cannot guarantee exclusive file creation" };
  }
  const held = owned.get(lockPath);
  if (held) {
    const current = parseOwner(fs.readFile(lockPath));
    if (current?.token === held.owner.token && current.pid === process.pid) {
      held.fs = fs;
      installExitHook();
      return { ok: true, owner: held.owner, resumed: true };
    }
    owned.delete(lockPath);
  }
  const marker = recoveryMarkerPath(lockPath);
  if (fs.exists(marker)) {
    const inspection = inspectInstanceLock(fs, lockPath);
    return { ok: false, inspection, detail: "an instance-lock recovery operation is in progress or was interrupted" };
  }
  const owner = makeOwner(sessionId);
  try {
    if (!fs.createExclusive(lockPath, JSON.stringify(owner) + "\n")) {
      const inspection = inspectInstanceLock(fs, lockPath);
      return { ok: false, inspection, detail: "another process already owns this mission instance" };
    }
  } catch (err) {
    const inspection = inspectInstanceLock(fs, lockPath);
    return { ok: false, inspection, detail: `exclusive instance-lock creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  owned.set(lockPath, { fs, owner });
  installExitHook();
  return { ok: true, owner, resumed: false };
}

/** Re-read the lock token immediately before every Handoff-controlled persistent write. */
export function ownsInstanceLock(fs: FsOps, lockPath: string): boolean {
  const held = owned.get(lockPath);
  if (!held || held.owner.pid !== process.pid) return false;
  const current = parseOwner(fs.readFile(lockPath));
  return current?.token === held.owner.token && current.pid === process.pid;
}

export function releaseInstanceLock(fs: FsOps, lockPath: string): { released: boolean; detail: string } {
  const held = owned.get(lockPath);
  if (!held) return { released: false, detail: "this process does not hold the instance lock" };
  const current = parseOwner(fs.readFile(lockPath));
  if (!current || current.token !== held.owner.token || current.pid !== process.pid) {
    owned.delete(lockPath);
    return { released: false, detail: "owner token no longer matches; the lock was left untouched" };
  }
  fs.remove(lockPath);
  owned.delete(lockPath);
  return { released: true, detail: "instance lock released by its owner" };
}

/** Recover only a lock whose owner is provably absent or whose Linux PID was reused. */
export function recoverAbandonedInstanceLock(
  fs: FsOps,
  lockPath: string,
  sessionId: string,
  probe = probeOwnerLiveness,
): { ok: boolean; detail: string; inspection: InstanceLockInspection } {
  const held = owned.get(lockPath);
  if (held && ownsInstanceLock(fs, lockPath)) {
    const inspection = inspectInstanceLock(fs, lockPath, probe);
    return { ok: false, detail: "this process still owns the instance lock; recovery is refused", inspection };
  }
  if (!fs.createExclusive) {
    const inspection = inspectInstanceLock(fs, lockPath, probe);
    return { ok: false, detail: "this filesystem adapter cannot create an atomic recovery claim", inspection };
  }
  const markerPath = recoveryMarkerPath(lockPath);
  const markerOwner = makeOwner(sessionId);
  try {
    if (!fs.createExclusive(markerPath, JSON.stringify(markerOwner) + "\n")) {
      const inspection = inspectInstanceLock(fs, lockPath, probe);
      return { ok: false, detail: "another recovery is active or a prior recovery was interrupted; inspect it manually", inspection };
    }
  } catch (err) {
    const inspection = inspectInstanceLock(fs, lockPath, probe);
    return { ok: false, detail: `recovery claim failed: ${err instanceof Error ? err.message : String(err)}`, inspection };
  }
  try {
    const firstRaw = fs.readFile(lockPath);
    const inspection = inspectInstanceLock(fs, lockPath, probe);
    if (inspection.state === "missing") return { ok: true, detail: "no lock existed; no files changed", inspection };
    if (inspection.state !== "abandoned" && inspection.state !== "pid-reused") {
      return { ok: false, detail: `${inspection.detail}. Lock preserved; stop/inspect the owner before any manual recovery`, inspection };
    }
    const ownerAgain = inspectInstanceLock(fs, lockPath, probe);
    if (ownerAgain.state !== inspection.state || fs.readFile(lockPath) !== firstRaw) {
      return { ok: false, detail: "owner lock changed during recovery inspection; lock preserved", inspection: ownerAgain };
    }
    fs.remove(lockPath);
    return { ok: true, detail: `abandoned lock for pid ${inspection.owner?.pid} removed; restart Pi to acquire ownership`, inspection };
  } catch (err) {
    const inspection = inspectInstanceLock(fs, lockPath, probe);
    return { ok: false, detail: `recovery failed without retry: ${err instanceof Error ? err.message : String(err)}`, inspection };
  } finally {
    removeRecoveryMarkerIfOwned(fs, markerPath, markerOwner.token);
  }
}

export function processSelectionIsStable(projectRoot: string, id: string | null, scope = String(process.pid)): { ok: boolean; previous?: string | null } {
  const key = `${scope}\0${pathDefault.resolve(projectRoot)}`;
  const existing = selectionByProcess.get(key);
  if (existing !== undefined || selectionByProcess.has(key)) {
    return existing === id ? { ok: true, previous: existing } : { ok: false, previous: existing };
  }
  selectionByProcess.set(key, id);
  return { ok: true };
}

const selectionByProcess = new Map<string, string | null>();
