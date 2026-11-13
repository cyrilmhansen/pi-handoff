import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLocalFs } from "../.pi/extensions/context-guard/checkpoint.ts";
import {
  acquireInstanceLock,
  inspectInstanceLock,
  instanceLockPath,
  processSelectionIsStable,
  recoverAbandonedInstanceLock,
  releaseInstanceLock,
  type InstanceLockOwner,
} from "../.pi/extensions/context-guard/mission-lock.ts";
import { createMemoryFs } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockModuleUrl = pathToFileURL(path.join(root, ".pi/extensions/context-guard/mission-lock.ts")).href;
const checkpointModuleUrl = pathToFileURL(path.join(root, ".pi/extensions/context-guard/checkpoint.ts")).href;

const workerCode = `
  import { createLocalFs } from ${JSON.stringify(checkpointModuleUrl)};
  import { acquireInstanceLock, releaseInstanceLock } from ${JSON.stringify(lockModuleUrl)};
  const fs = createLocalFs();
  const lockPath = process.argv[1];
  const result = acquireInstanceLock(fs, lockPath, "worker-" + process.pid);
  process.stdout.write(JSON.stringify({ ok: result.ok, detail: result.ok ? "acquired" : result.detail }) + "\\n");
  if (!result.ok) process.exit(0);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (data.includes("exit")) {
      process.exit(0); // prove the production process-exit hook, without calling releaseInstanceLock
    }
    if (data.includes("release")) {
      const released = releaseInstanceLock(fs, lockPath);
      process.stdout.write(JSON.stringify(released) + "\\n");
      process.exit(0);
    }
  });
`;

function startWorker(lockPath: string): { child: ChildProcess; firstLine: Promise<any> } {
  const child = spawn(process.execPath, ["--input-type=module", "-e", workerCode, lockPath], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const firstLine = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("instance lock worker did not report acquisition")), 5000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    child.once("error", (err) => { clearTimeout(timeout); reject(err); });
    child.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error(`worker exited early with ${code}`)); }
    });
  });
  return { child, firstLine };
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

test("LK1: real processes serialize one instance while distinct instances run concurrently", async () => {
  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-lot-g-instance-lock-"));
  const same = path.join(temp, ".pi-handoff/instances/shared/.owner.lock");
  const other = path.join(temp, ".pi-handoff/instances/other/.owner.lock");
  const first = startWorker(same);
  const secondInstance = startWorker(other);
  try {
    assert.deepEqual(await first.firstLine, { ok: true, detail: "acquired" });
    assert.deepEqual(await secondInstance.firstLine, { ok: true, detail: "acquired" });
    const contender = startWorker(same);
    const denied = await contender.firstLine;
    assert.equal(denied.ok, false);
    assert.match(denied.detail, /already owns|owner pid/);
    await waitExit(contender.child);
    first.child.stdin!.write("release\n");
    await waitExit(first.child);
    assert.equal(fsDefault.existsSync(same), false, "normal owner release removes only its lock");
    const afterRelease = startWorker(same);
    assert.equal((await afterRelease.firstLine).ok, true, "a new process can acquire after the old owner exits normally");
    afterRelease.child.stdin!.write("release\n");
    await waitExit(afterRelease.child);
    secondInstance.child.stdin!.write("release\n");
    await waitExit(secondInstance.child);
    const normalExit = startWorker(same);
    assert.equal((await normalExit.firstLine).ok, true);
    normalExit.child.stdin!.write("exit\n");
    await waitExit(normalExit.child);
    assert.equal(fsDefault.existsSync(same), false, "normal process exit releases the lock via its matching owner token");
  } finally {
    for (const child of [first.child, secondInstance.child]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});

test("LK0: process selection is immutable and lock identities are project-scoped", () => {
  const scope = `selection-${process.pid}-${Date.now()}`;
  assert.deepEqual(processSelectionIsStable("/project", "alpha", scope), { ok: true });
  assert.deepEqual(processSelectionIsStable("/project", "alpha", scope), { ok: true, previous: "alpha" });
  assert.deepEqual(processSelectionIsStable("/project", "beta", scope), { ok: false, previous: "alpha" });
  assert.deepEqual(processSelectionIsStable("/other", "beta", scope), { ok: true });
  assert.notEqual(instanceLockPath("/project", "alpha"), instanceLockPath("/project", "beta"));
});

test("LK0b: failed atomic lock creation never grants ownership or writes a partial claim", () => {
  const mem = createMemoryFs();
  const lockPath = "/project/.pi-handoff/instances/failed/.owner.lock";
  mem.failNext.set(lockPath, 1);
  const result = acquireInstanceLock(mem, lockPath, "failed-session");
  assert.equal(result.ok, false);
  assert.match(result.detail, /exclusive instance-lock creation failed/);
  assert.equal(mem.files.has(lockPath), false);
  assert.deepEqual(mem.writes, []);
});

test("LK2: SIGKILL leaves the lock; a later process refuses until explicit dead-owner recovery", async () => {
  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-lot-g-instance-crash-"));
  const lockPath = path.join(temp, ".pi-handoff/instances/crash/.owner.lock");
  const owner = startWorker(lockPath);
  try {
    assert.equal((await owner.firstLine).ok, true);
    const raw = fsDefault.readFileSync(lockPath, "utf8");
    owner.child.kill("SIGKILL");
    await waitExit(owner.child);
    assert.equal(fsDefault.readFileSync(lockPath, "utf8"), raw, "abrupt exit never unlinks its lock");
    const blocked = startWorker(lockPath);
    const denied = await blocked.firstLine;
    assert.equal(denied.ok, false);
    await waitExit(blocked.child);
    const recovered = recoverAbandonedInstanceLock(createLocalFs(), lockPath, "recovery-session");
    assert.equal(recovered.ok, true, recovered.detail);
    assert.equal(fsDefault.existsSync(lockPath), false);
    const restarted = startWorker(lockPath);
    assert.equal((await restarted.firstLine).ok, true);
    restarted.child.stdin!.write("release\n");
    await waitExit(restarted.child);
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});

test("LK3: active, corrupt, foreign-host and uncertain locks are never recovered", () => {
  const mem = createMemoryFs();
  const lockPath = "/project/.pi-handoff/instances/alpha/.owner.lock";
  const active: InstanceLockOwner = { schema: 1, token: "active-token", pid: process.pid, hostname: os.hostname(), platform: process.platform, sessionId: "live-session", startedAt: new Date().toISOString() };
  mem.writeFile(lockPath, JSON.stringify(active));
  const refuseActive = recoverAbandonedInstanceLock(mem, lockPath, "operator");
  assert.equal(refuseActive.ok, false);
  assert.equal(mem.files.get(lockPath), JSON.stringify(active));
  mem.files.set(lockPath, "{broken");
  assert.equal(recoverAbandonedInstanceLock(mem, lockPath, "operator").ok, false);
  assert.equal(mem.files.get(lockPath), "{broken");
  const foreign = { ...active, hostname: "other-host" };
  mem.files.set(lockPath, JSON.stringify(foreign));
  assert.equal(inspectInstanceLock(mem, lockPath).state, "foreign-host");
  assert.equal(recoverAbandonedInstanceLock(mem, lockPath, "operator").ok, false);
});

test("LK4: Linux PID reuse is distinguished by boot id/start ticks; token mismatch cannot release", () => {
  const mem = createMemoryFs();
  const lockPath = "/project/.pi-handoff/instances/reused/.owner.lock";
  const owner: InstanceLockOwner = { schema: 1, token: "stale-token", pid: 4242, hostname: os.hostname(), platform: "linux", sessionId: "old", startedAt: "now", bootId: "boot", processStart: "10" };
  mem.writeFile(lockPath, JSON.stringify(owner));
  const recovered = recoverAbandonedInstanceLock(mem, lockPath, "recovery", () => "pid-reused");
  assert.equal(recovered.ok, true);
  assert.equal(mem.files.has(lockPath), false);

  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-lot-g-instance-token-"));
  try {
    const lock2 = path.join(temp, ".pi-handoff/instances/token/.owner.lock");
    const fs = createLocalFs();
    const created = acquireInstanceLock(fs, lock2, "current");
    assert.equal(created.ok, true);
    const tampered = { ...created.ok ? created.owner : owner, token: "replacement" };
    mem.writeFile(lock2, JSON.stringify(tampered));
    assert.deepEqual(releaseInstanceLock(mem, lock2), { released: false, detail: "owner token no longer matches; the lock was left untouched" });
    assert.ok(mem.files.has(lock2));
    if (created.ok) releaseInstanceLock(fs, lock2);
  } finally {
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});

test("LK5: real symlink escapes are rejected by the instance path validator", async () => {
  const { instancePathIsSafe } = await import("../.pi/extensions/context-guard/mission-instance.ts");
  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-lot-g-instance-symlink-"));
  try {
    const project = path.join(temp, "project");
    fsDefault.mkdirSync(path.join(project, ".pi-handoff/instances"), { recursive: true });
    const outside = path.join(temp, "outside");
    fsDefault.mkdirSync(outside);
    fsDefault.symlinkSync(outside, path.join(project, ".pi-handoff/instances/escape"), "dir");
    assert.equal(instancePathIsSafe(createLocalFs(), project, "escape"), false);
    const projectWithSymlinkParent = path.join(temp, "project-parent");
    fsDefault.mkdirSync(projectWithSymlinkParent);
    fsDefault.symlinkSync(outside, path.join(projectWithSymlinkParent, ".pi-handoff"), "dir");
    assert.equal(instancePathIsSafe(createLocalFs(), projectWithSymlinkParent, "missing"), false, "a symlinked ancestor is refused even when instances/id does not exist");
  } finally {
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});
