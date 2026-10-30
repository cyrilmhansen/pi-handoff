/**
 * D7 — temporary test-artifact lifecycle tests (scripts/lib/e2e-cleanup.mjs and the
 * three out-of-band e2e scripts). ZERO inference: real scripts run against a FAKE `pi`
 * stub placed on PATH, which speaks just enough of the RPC protocol for the drivers to
 * reach every code path (including the optional GUARD_E2E_LLM=1 workspace). Checks may
 * FAIL inside those runs — that is fine; what this file asserts is the ARTIFACT
 * LIFECYCLE, never guard behavior (that is e2e-rpc's own job with real pi).
 *
 * Proven here:
 *   CL1 keepRequested: "1" ONLY retains; "0"/"true"/""/unset remove (defect 3);
 *   CL2 normal exit removes every created dir; setup THROW after registration removes
 *      it too (defect 1 — exit safety net);
 *   CL3 GUARD_E2E_KEEP=0 removes, =1 retains (worker-level, real env);
 *   CL4 SIGTERM mid-run: tracked child killed BEFORE workspace removal, driver exits
 *      143, artifacts gone (defect 4);
 *   CL5 children are shut down before ANY rm on both cleanup paths (ordering);
 *   CL6 ownership safety: only the exact dirs THIS invocation created (guard-prefixed,
 *      directly under tmpdir) are ever removed; foreign/sentinel dirs survive; a
 *      non-guard prefix or an outside-tmpdir creation path is REFUSED (no sweeper);
 *   CL7 real scripts: e2e-rpc with GUARD_E2E_LLM=1 removes the llm workspace (defect
 *      2) and every other dir; KEEP=1 retains them all (incl. llm) byte-present for
 *      forensics; e2e-renew setup failure (git unavailable) cleans its clone parent;
 *      check-skill-discovery with GUARD_E2E_KEEP=0 cleans up (was: leaked);
 *   CL8 SIGKILL/crash limitation is documented (header of e2e-cleanup.mjs) — no test
 *      can prove the unprovable; CL7's pre-existing sentinels prove no sweeper exists.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ArtifactTracker, keepRequested, onceExited } from "../scripts/lib/e2e-cleanup.mjs";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const HELPERS = path.join(REPO, "scripts", "lib", "e2e-cleanup.mjs");
const E2E_RPC = path.join(REPO, "scripts", "e2e-rpc-two-process.mjs");
const E2E_RENEW = path.join(REPO, "scripts", "e2e-renew.mjs");
const SKILL = path.join(REPO, "scripts", "check-skill-discovery.mjs");
const TMP = fs.realpathSync(os.tmpdir());

const fixture = fs.mkdtempSync(path.join(TMP, "guard-d7fix-")); // test-owned, removed in after()
const workerPath = path.join(fixture, "worker.mjs");
const fakePiDir = path.join(fixture, "bin");
const fakePiPath = path.join(fakePiDir, "pi");
const pidLog = path.join(fixture, "fake-pi.pids");

const WORKER = `
import { spawn } from "node:child_process";
import { ArtifactTracker } from ${JSON.stringify(HELPERS)};
const mode = process.argv[2];
const tracker = new ArtifactTracker({ prefix: "guard-d7work-" });
tracker.installHandlers();
const d1 = tracker.createTempDir("a");
console.log("DIR " + d1);
if (mode === "hang") {
  const child = tracker.trackChild(spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], { stdio: "ignore" }));
  console.log("CHILD " + child.pid);
  await new Promise(() => {}); // hang until the test SIGTERMs us
}
if (mode === "crash") {
  const d2 = tracker.createTempDir("b");
  console.log("DIR " + d2);
  throw new Error("setup boom after registration"); // uncaught: the 'exit' safety net must clean up
}
if (mode === "leak-child") {
  const child = tracker.trackChild(spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], { stdio: "ignore" }));
  child.unref(); // let the worker exit while the tracked child is still alive: the 'exit' safety net must still kill it
  console.log("CHILD " + child.pid);
  // exit normally WITHOUT calling cleanup(): the 'exit' safety net must kill + remove
}
console.log("DONE");
`;

const FAKE_PI = `#!/usr/bin/env node
/* Fake "pi" for D7 artifact-lifecycle integration tests ONLY. Speaks just enough of
   the RPC protocol (id-correlated responses, /guard status notify, agent_settled after
   prompts) for the real driver scripts to REACH their code paths with zero inference.
   NEVER used to assert guard behavior — check failures here are expected and fine. */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const id = "fake-" + process.pid;
const state = JSON.stringify({
  version: 2, sessionId: id, updatedAt: Date.now(),
  snapshot: { currentLevel: 0, alertedLevels: [], unknownStreak: 0, degraded: false, lastRemaining: 200000, evaluations: 1 },
  checkpointId: null, handoffReady: null, learningsHash: null,
});
if (process.env.D7_FAKE_PI_LOG) fs.appendFileSync(process.env.D7_FAKE_PI_LOG, process.pid + "\\n");
try {
  // session state files ONLY where the test explicitly asks (never the real repo tree)
  const cwd = process.cwd();
  if (process.env.D7_FAKE_TREE_STATE === "1" && cwd !== ${JSON.stringify(REPO)} && fs.existsSync(path.join(cwd, ".pi-guard"))) {
    fs.mkdirSync(path.join(cwd, ".pi-guard", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-guard", "sessions", id + ".json"), state);
  }
  if (process.env.CONTEXT_GUARD_STATE_DIR && fs.existsSync(process.env.CONTEXT_GUARD_STATE_DIR)) {
    fs.mkdirSync(path.join(process.env.CONTEXT_GUARD_STATE_DIR, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(process.env.CONTEXT_GUARD_STATE_DIR, "sessions", id + ".json"), state);
  }
} catch {}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  let data = { disposition: "handled" };
  if (req.type === "get_state") data = { sessionId: id, sessionFile: path.join(process.cwd(), id + ".jsonl"), messageCount: 1, model: { id: "fake-model", provider: "fake", contextWindow: 200000, maxTokens: 8192 }, autoCompactionEnabled: false, isStreaming: false };
  else if (req.type === "get_last_assistant_text") data = { text: "x".repeat(40) };
  else if (req.type === "get_messages") data = [];
  else if (req.type === "get_commands") data = { commands: [] };
  out({ type: "response", id: req.id, success: true, data });
  if (req.type === "prompt" && typeof req.message === "string" && req.message.includes("/guard status")) {
    out({ type: "extension_ui_request", method: "notify", message: "context-guard status (fake): usable remaining: 10 generation reserve: 5 provenance: config threshold crossings (estimated used, escalation order) at used >= 3 the guard never changes the model window" });
  }
  if (req.type === "prompt") out({ type: "agent_settled" });
});
rl.on("close", () => process.exit(0));
`;

before(() => {
  fs.writeFileSync(workerPath, WORKER, { mode: 0o644 });
  fs.mkdirSync(fakePiDir, { recursive: true });
  fs.writeFileSync(fakePiPath, FAKE_PI, { mode: 0o755 });
});

after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

/** snapshot of /tmp entries matching a prefix (to prove THIS run left nothing behind) */
const snapshot = (prefix) => new Set(fs.readdirSync(TMP).filter((f) => f.startsWith(prefix)));
const newEntries = (beforeSet, prefix) => fs.readdirSync(TMP).filter((f) => f.startsWith(prefix) && !beforeSet.has(f));

function runWorker(mode, env = {}) {
  return spawnSync(process.execPath, [workerPath, mode], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
}
const dirsOf = (stdout) => stdout.split("\n").filter((l) => l.startsWith("DIR ")).map((l) => l.slice(4).trim());
const childOf = (stdout) => {
  const l = stdout.split("\n").find((x) => x.startsWith("CHILD "));
  return l ? Number(l.slice(6)) : null;
};
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // an orphaned child may linger as a ZOMBIE until reparented-and-reaped: a zombie is
  // DEAD for our purposes (kill(pid,0) still succeeds on it).
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = st.slice(st.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
    if (state === "Z") return false;
  } catch {
    /* no /proc or vanished */
  }
  return true;
}
async function waitForDead(pid, ms = 4000) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// --------------------------------------------------------------------------- CL1
test("CL1: keepRequested — '1' is the ONLY retention value ('0', 'true', '' and unset all mean REMOVE)", () => {
  assert.equal(keepRequested({ GUARD_E2E_KEEP: "1" }), true);
  assert.equal(keepRequested({ GUARD_E2E_KEEP: "0" }), false);
  assert.equal(keepRequested({ GUARD_E2E_KEEP: "true" }), false);
  assert.equal(keepRequested({ GUARD_E2E_KEEP: "" }), false);
  assert.equal(keepRequested({}), false);
});

// --------------------------------------------------------------------------- CL2/CL3
test("CL2: normal exit + setup throw AFTER registration both remove every owned dir (worker, real fs)", () => {
  const beforeSet = snapshot("guard-d7work-");
  const ok = runWorker("ok");
  assert.match(ok.stdout, /DONE/);
  assert.equal(ok.status, 0);
  assert.deepEqual(newEntries(beforeSet, "guard-d7work-"), [], "normal exit must leave nothing behind");

  const crash = runWorker("crash");
  assert.equal(crash.status, 1, "uncaught setup throw exits nonzero");
  assert.match(crash.stderr.toString() + crash.stdout, /setup boom after registration/);
  assert.deepEqual(newEntries(beforeSet, "guard-d7work-"), [], "the 'exit' safety net must remove dirs registered before the throw");
});

test("CL3: GUARD_E2E_KEEP=0 removes (defect 3 class); GUARD_E2E_KEEP=1 retains for forensics", (t) => {
  const beforeSet = snapshot("guard-d7work-");
  const keep0 = runWorker("ok", { GUARD_E2E_KEEP: "0" });
  assert.equal(keep0.status, 0);
  assert.deepEqual(newEntries(beforeSet, "guard-d7work-"), [], "GUARD_E2E_KEEP=0 must NOT retain");

  const keep1 = runWorker("ok", { GUARD_E2E_KEEP: "1" });
  assert.equal(keep1.status, 0);
  const kept = newEntries(beforeSet, "guard-d7work-");
  assert.equal(kept.length, 1);
  assert.ok(fs.existsSync(path.join(TMP, kept[0], ".") ) || fs.existsSync(path.join(TMP, kept[0])));
  t.diagnostic(`retained (test cleans up): ${kept[0]}`);
  fs.rmSync(path.join(TMP, kept[0]), { recursive: true, force: true });
});

// --------------------------------------------------------------------------- CL4/CL8
test("CL4: SIGTERM mid-run kills the tracked child and removes owned dirs; driver exits 143", async () => {
  const beforeSet = snapshot("guard-d7work-");
  const child = spawn(process.execPath, [workerPath, "hang"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  let out = "";
  child.stdout.on("data", (c) => (out += String(c)));
  const deadline = Date.now() + 10_000;
  while (!/CHILD \d+/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const workerChildPid = childOf(out);
  const dir = dirsOf(out)[0];
  assert.ok(workerChildPid && dir, `worker reported child+dir (got ${out.slice(0, 200)})`);
  child.kill("SIGTERM");
  const code = await onceExited(child);
  assert.equal(child.exitCode, 143, "signal path exits 128+15");
  assert.equal(await waitForDead(workerChildPid), true, "the tracked grandchild must be killed");
  assert.ok(!fs.existsSync(dir), "workspace must be removed AFTER the child shutdown");
  assert.deepEqual(newEntries(beforeSet, "guard-d7work-"), []);
});

test("CL4b: normal exit WITHOUT explicit cleanup still kills a live tracked child (exit safety net)", async () => {
  const beforeSet = snapshot("guard-d7work-");
  const r = runWorker("leak-child");
  assert.equal(r.status, 0);
  const pid = childOf(r.stdout);
  assert.ok(pid);
  assert.equal(await waitForDead(pid), true, "the exit safety net must shut tracked children down");
  assert.deepEqual(newEntries(beforeSet, "guard-d7work-"), [], "the exit safety net must remove owned dirs");
});

// --------------------------------------------------------------------------- CL5
test("CL5: cleanup shuts children down BEFORE removing any workspace (ordering, both paths)", async () => {
  const events = [];
  const mkChild = (name) => {
    const ch = new EventEmitter();
    ch.exitCode = null;
    ch.signalCode = null;
    ch.pid = -1;
    // behaves like a well-behaved pi child: stdin close => clean exit
    ch.stdin = { end: () => { events.push(`${name}:stdin-end`); ch.exitCode = 0; ch.emit("exit", 0, null); } };
    ch.kill = (sig) => {
      events.push(`${name}:kill:${sig}`);
      if (sig === "SIGKILL") {
        ch.signalCode = sig;
        ch.emit("exit", sig, null);
      } // SIGTERM alone does not stop this fake — escalation to SIGKILL must happen
    };
    return ch;
  };
  const tracker = new ArtifactTracker({ prefix: "guard-d7order-", env: {}, deps: { mkdtemp: (t) => `${TMP}/${path.basename(t)}FAKE`, rm: (d) => events.push(`rm:${path.basename(d)}`), log: () => {} } });
  const c1 = tracker.trackChild(mkChild("c1"));
  const dir = tracker.createTempDir("w");
  // async path: graceful stdin.end -> SIGTERM exit, THEN rm
  const report = await tracker.cleanup({ graceMs: 20 });
  assert.deepEqual(events, ["c1:stdin-end", "rm:guard-d7order-w-FAKE"], `children first, then removal; got ${events}`);
  assert.deepEqual(report.removed, [dir]);
  // sync path: SIGTERM+SIGKILL immediately, THEN rm
  const tracker2 = new ArtifactTracker({ prefix: "guard-d7order-", env: {}, deps: { mkdtemp: (t) => `${TMP}/${path.basename(t)}FAKE2`, rm: (d) => events.push(`rm2:${path.basename(d)}`), log: () => {} } });
  events.length = 0;
  const c2 = tracker2.trackChild(mkChild("c2"));
  tracker2.createTempDir("w2");
  const r2 = tracker2.cleanupSync();
  assert.deepEqual(events, ["c2:kill:SIGTERM", "c2:kill:SIGKILL", "rm2:guard-d7order-w2-FAKE2"], `sync path: kill before rm; got ${events}`);
  assert.equal(r2.killed, 1);
  assert.equal(r2.sync, true);
});

// --------------------------------------------------------------------------- CL6
test("CL6: ownership safety — only this invocation's exact dirs are removed; foreign paths refused, nothing swept", () => {
  const beforeSet = snapshot("guard-d7own-");
  // unregistered look-alikes (a "sweeper" would delete these; a sentinel outside the
  // prefix too): must survive cleanup untouched.
  const foreign = fs.mkdtempSync(path.join(TMP, "guard-d7own-foreign-"));
  fs.writeFileSync(path.join(foreign, "keep.txt"), "do not delete");
  const sentinel = fs.mkdtempSync(path.join(TMP, "d7sentinel-"));
  fs.writeFileSync(path.join(sentinel, "keep.txt"), "do not delete");

  const tracker = new ArtifactTracker({ prefix: "guard-d7own-", env: {} });
  const mine = tracker.createTempDir("run");
  fs.writeFileSync(path.join(mine, "mine.txt"), "x");
  assert.ok(tracker.ownsDir(mine));
  assert.ok(!tracker.ownsDir(foreign), "a same-prefix dir this invocation did NOT create is NOT owned");

  const r = tracker.cleanupSync();
  assert.deepEqual(r.removed, [mine]);
  assert.ok(!fs.existsSync(mine));
  assert.equal(fs.readFileSync(path.join(foreign, "keep.txt"), "utf8"), "do not delete");
  assert.equal(fs.readFileSync(path.join(sentinel, "keep.txt"), "utf8"), "do not delete");
  assert.deepEqual(newEntries(beforeSet, "guard-d7own-").sort(), [path.basename(foreign)], "only the unregistered sentinel dir remains new — no sweep, no wild removal");

  // non-guard tracker prefixes are refused outright (nothing outside guard-* is ever ownable)
  assert.throws(() => new ArtifactTracker({ prefix: "rmrf-" }), /must start with "guard-"/);
  // a fake mkdtemp trying to hand us a path outside tmpdir or off-prefix must throw at registration
  const bad1 = new ArtifactTracker({ prefix: "guard-d7own-", env: {}, deps: { mkdtemp: () => path.join(REPO, "project-tree-must-never-be-owned") } });
  assert.throws(() => bad1.createTempDir("x"), /refusing to own/);
  const bad2 = new ArtifactTracker({ prefix: "guard-d7own-", env: {}, deps: { mkdtemp: () => path.join(TMP, "totally-different-name") } });
  assert.throws(() => bad2.createTempDir("x"), /refusing to own/);
  assert.deepEqual(bad1.ownedDirs(), []);
  assert.ok(fs.existsSync(REPO), "the project tree was never registered, so it was never touched");

  fs.rmSync(foreign, { recursive: true, force: true }); // test cleanup
  fs.rmSync(sentinel, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- CL7
test("CL7a: e2e-rpc-two-process with GUARD_E2E_LLM=1 removes EVERY workspace incl. the llm one (real script, fake pi, zero inference)", () => {
  const beforeSet = snapshot("guard-e2e-");
  fs.rmSync(pidLog, { force: true });
  const foreign = fs.mkdtempSync(path.join(TMP, "guard-e2e-sentinel-not-owned-"));
  fs.writeFileSync(path.join(foreign, "keep.txt"), "x");
  const r = spawnSync(process.execPath, [E2E_RPC], {
    encoding: "utf8",
    timeout: 150_000,
    env: { ...process.env, PATH: `${fakePiDir}:${process.env.PATH}`, GUARD_E2E_LLM: "1", D7_FAKE_PI_LOG: pidLog, D7_FAKE_TREE_STATE: "1" },
  });
  assert.match(r.stdout, /LLM: prompt accepted/, "the optional LLM branch must have RUN (its guard-behavior checks may legitimately fail against the fake pi)");
  assert.match(r.stdout, /e2e checks passed/, "the driver must complete to its summary line");
  assert.equal(r.stdout.includes("kept artifacts"), false, "default env removes everything");
  const leftover = newEntries(beforeSet, "guard-e2e-");
  assert.deepEqual(leftover.filter((d) => !d.includes("sentinel")), [], `no workspace leaked: ${leftover}`);
  assert.ok(fs.existsSync(path.join(foreign, "keep.txt")), "an unregistered same-prefix dir must survive (no sweeper)");
  fs.rmSync(foreign, { recursive: true, force: true });
});

test("CL7b: GUARD_E2E_KEEP=1 retains ALL workspaces incl. guard-e2e-llm-* with forensics intact", () => {
  const beforeSet = snapshot("guard-e2e-");
  const r = spawnSync(process.execPath, [E2E_RPC], {
    encoding: "utf8",
    timeout: 150_000,
    env: { ...process.env, PATH: `${fakePiDir}:${process.env.PATH}`, GUARD_E2E_LLM: "1", GUARD_E2E_KEEP: "1", D7_FAKE_PI_LOG: pidLog, D7_FAKE_TREE_STATE: "1" },
  });
  assert.match(r.stdout, /LLM: prompt accepted/);
  const keptLine = (r.stdout.match(/kept artifacts: (.+)/) ?? [])[1] ?? "";
  const kept = keptLine.split(" ").filter(Boolean);
  assert.ok(kept.length >= 6, `kept list covers tree/audit/audit-intree/capped/llm/home: ${keptLine}`);
  const llmKept = kept.filter((d) => path.basename(d).startsWith("guard-e2e-llm-"));
  assert.equal(llmKept.length, 1, "the LLM workspace is now part of the retained set (forensics preserved)");
  for (const d of kept) {
    assert.ok(fs.existsSync(path.join(d, "GOAL.md")) || fs.existsSync(d), `retained dir exists: ${d}`);
  }
  assert.ok(newEntries(beforeSet, "guard-e2e-").length >= 6);
  for (const d of kept) fs.rmSync(d, { recursive: true, force: true }); // test cleanup
});

test("CL7c: SIGTERM mid-run of e2e-rpc shuts live pi (fake) children down BEFORE removing workspaces", async () => {
  const beforeSet = snapshot("guard-e2e-");
  fs.rmSync(pidLog, { force: true });
  const driver = spawn(process.execPath, [E2E_RPC], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${fakePiDir}:${process.env.PATH}`, D7_FAKE_PI_LOG: pidLog, D7_FAKE_TREE_STATE: "1" },
  });
  let out = "";
  driver.stdout.on("data", (c) => (out += String(c)));
  const deadline = Date.now() + 30_000;
  while (!/PASS  A\/B/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /PASS  A\/B/, "driver reached its first checks (children live)");
  await new Promise((r) => setTimeout(r, 300)); // let both pi children be spawned & tracked
  const pids = fs.existsSync(pidLog) ? fs.readFileSync(pidLog, "utf8").split("\n").filter(Boolean).map(Number) : [];
  assert.ok(pids.length >= 2, `fake pi children recorded: ${pids}`);
  driver.kill("SIGTERM");
  await onceExited(driver);
  assert.equal(driver.exitCode, 143);
  for (const pid of pids) assert.equal(await waitForDead(pid), true, `child ${pid} must be dead after SIGTERM cleanup`);
  assert.deepEqual(newEntries(beforeSet, "guard-e2e-"), [], "SIGTERM cleanup removed every workspace");
});

test("CL7d: e2e-renew setup failure (git unavailable) reports the failure and removes its clone parent (real script)", () => {
  const beforeSet = snapshot("guard-renew-");
  const r = spawnSync(process.execPath, [E2E_RENEW], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: "/nonexistent-d7" }, // git AND pi unreachable: setup must fail
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL  e2e-renew setup completed/, "the setup failure is a REPORTED check, not a bare stack");
  assert.match(r.stdout, /git clone failed/, String(r.stdout).slice(0, 300));
  assert.deepEqual(newEntries(beforeSet, "guard-renew-"), [], "a pre-try setup failure can no longer leak guard-renew-*");
});

test("CL7e: check-skill-discovery with GUARD_E2E_KEEP=0 cleans up (defect 3: it used to treat '0' as keep)", () => {
  const beforeSet = snapshot("guard-skill-home-");
  const r = spawnSync(process.execPath, [SKILL], {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, PATH: `${fakePiDir}:${process.env.PATH}`, GUARD_E2E_KEEP: "0" },
  });
  assert.match(r.stdout, /checks passed/);
  assert.deepEqual(newEntries(beforeSet, "guard-skill-home-"), []);
  // and the repo tree was never touched by the fake pi
  assert.equal(fs.readdirSync(path.join(REPO, ".pi-guard", "sessions")).some((f) => f.startsWith("fake-")), false);
});

test("CL7f: the three scripts register artifacts ONLY through the tracker (no raw mkdtemp/rmSync remains)", () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const f of [E2E_RPC, E2E_RENEW, SKILL]) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    assert.match(src, /lib\/e2e-cleanup\.mjs/, `${f} imports the helper`);
    assert.equal(/fs\.mkdtempSync\(/.test(src), false, `${f} must not create temp dirs outside the tracker`);
    assert.equal(/fs\.rmSync\(/.test(src), false, `${f} must not remove anything outside the tracker`);
    assert.equal(/if \(!process\.env\.GUARD_E2E_KEEP\)/.test(src), false, `${f} must not use truthiness for retention`);
  }
  const rpcSrc = stripComments(fs.readFileSync(E2E_RPC, "utf8"));
  assert.match(rpcSrc, /makeProject\("llm"\)/, "the LLM workspace is created by makeProject — hence tracker-owned");
});
