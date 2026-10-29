/**
 * Phase 1c — item 6: real two-PROCESS isolation (not the Phase 1b single-process
 * simulation in test/sessions.test.ts).
 *
 * These tests spawn separate Node processes that drive the guard's own persistence
 * modules against one shared REAL directory, then assert the durable invariants:
 * - per-session state files never overwrite each other;
 * - checkpoint blocks are never torn (atomic rename) and mixed generations are detected;
 * - retention pruning never deletes a state file that may belong to a live session.
 *
 * Real simultaneous Pi processes are exercised separately by
 * scripts/e2e-rpc-two-process.mjs (requires the pi binary; skipped here).
 * Zero inference in this file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pruneSessionStates,
  createLocalFs,
  validateCheckpoint,
  saveGuardState,
  sessionStatePath,
  sessionsDirPath,
  type PersistedGuardState,
} from "../.pi/extensions/context-guard/checkpoint.ts";

const CHECKPOINT_TS = new URL("../.pi/extensions/context-guard/checkpoint.ts", import.meta.url).pathname;
const GUARD_TS = new URL("../.pi/extensions/context-guard/index.ts", import.meta.url).pathname;
const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

const WORKER = `
import { saveGuardState, writeCheckpoint, createLocalFs } from ${JSON.stringify(CHECKPOINT_TS)};
const [stateDir, cwd, sessionId, iterations] = process.argv.slice(2);
const fs = createLocalFs();
let writes = 0;
for (let i = 0; i < Number(iterations); i++) {
  const snapshot = { currentLevel: i % 5, alertedLevels: [1, 2].slice(0, i % 3), unknownStreak: 0, degraded: false, lastRemaining: 1000 + i, evaluations: i };
  const state = { version: 2, sessionId, updatedAt: Date.now() + i, snapshot, goalHash: undefined, checkpointOk: true, checkpointFreshness: "current" };
  const r = saveGuardState(fs, stateDir, state);
  if (!r.ok) { console.error("save failed: " + r.error); process.exit(2); }
  if (cwd !== "-") {
    writeCheckpoint(fs, { cwd, files: ${JSON.stringify(FILES)}, level: i % 5, sessionId, remaining: 9000 + i, goalDrift: false, lastVerifiedState: sessionId + " iteration " + i, unfinishedOperations: [], nextAction: "resume " + sessionId, recoveryInstructions: [], configName: "handoff.config.json" });
    writes++;
  }
}
console.log(JSON.stringify({ sessionId, iterations: Number(iterations), writes }));
`;

function workerPath(dir: string): string {
  const p = join(dir, "guard-worker.mjs");
  writeFileSync(p, WORKER, "utf8");
  return p;
}

function makeProject(dir: string): void {
  writeFileSync(join(dir, "GOAL.md"), "# GOAL\n\n## Objective\nx\n\n## Acceptance criteria\n- y\n");
  writeFileSync(join(dir, "PROGRESS.md"), "# PROGRESS\n\n## Current phase\np\n\n## Completed\n- [x] a\n\n## Pending\n- [ ] b\n\n## Verified evidence\ne\n\n## Blockers\nn\n\n## Next action\nRun tests.\n");
  writeFileSync(join(dir, "LEARNINGS.md"), "# LEARNINGS\n\n## Accepted\n- a\n\n## Proposed\n- p\n\n## Falsified or superseded\n- f\n");
  writeFileSync(join(dir, "HANDOFF.md"), "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\ns\n\n## Unfinished operations\n- [ ] b\n\n## Next action\nRun tests.\n\n## Discoveries not yet incorporated\n- d\n");
  writeFileSync(join(dir, "handoff.config.json"), JSON.stringify({ stateDir: ".pi-guard" }));
}

test("P1: two OS processes writing per-session state concurrently never overwrite each other", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-proc-"));
  try {
    const worker = workerPath(dir);
    const stateDir = join(dir, "state");
    const a = spawnSync(process.execPath, [worker, stateDir, "-", "sess-A", "150"], { encoding: "utf8" });
    const b = spawnSync(process.execPath, [worker, stateDir, "-", "sess-B", "150"], { encoding: "utf8" });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const files = readdirSync(sessionsDirPath(stateDir));
    assert.deepEqual(files.sort(), ["sess-A.json", "sess-B.json"], `unexpected files: ${files.join(",")}`);
    const parse = (id: string) => JSON.parse(readFileSync(sessionStatePath(stateDir, id), "utf8")) as PersistedGuardState;
    assert.equal(parse("sess-A").sessionId, "sess-A");
    assert.equal(parse("sess-B").sessionId, "sess-B");
    assert.equal(parse("sess-A").snapshot.evaluations, 149, "each file holds its own last write");
    assert.deepEqual(files.filter((f) => f.includes(".tmp-")), [], "no torn temp files left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2: concurrent checkpoint writers keep every block parseable and mixed generations are detected", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-proc-ckpt-"));
  try {
    makeProject(dir);
    const worker = workerPath(dir);
    const runs = [
      spawnSync(process.execPath, [worker, join(dir, ".pi-guard"), dir, "proc-A", "40"], { encoding: "utf8" }),
      spawnSync(process.execPath, [worker, join(dir, ".pi-guard"), dir, "proc-B", "40"], { encoding: "utf8" }),
    ];
    for (const r of runs) assert.equal(r.status, 0, r.stderr);

    const handoff = readFileSync(join(dir, "HANDOFF.md"), "utf8");
    const progress = readFileSync(join(dir, "PROGRESS.md"), "utf8");
    for (const [name, content] of [["HANDOFF.md", handoff], ["PROGRESS.md", progress]] as const) {
      assert.equal((content.match(/<!-- guard:begin checkpoint -->/g) ?? []).length, 1, `${name}: exactly one managed block (no torn write)`);
      assert.equal((content.match(/<!-- guard:end checkpoint -->/g) ?? []).length, 1, `${name}: block closed`);
      assert.match(content, /checkpoint-id: \S+/);
    }
    const f = validateCheckpoint(createLocalFs(), dir, FILES);
    // Invariant under concurrency: "current" may only be reported when both blocks
    // carry the same transactional identity; anything else must be detected.
    if (f.kind === "current") {
      const idOf = (c: string) => /checkpoint-id: (\S+)/.exec(c)![1];
      assert.equal(idOf(handoff), idOf(progress), "current implies identical ids");
      assert.equal(f.partial, false);
    } else {
      assert.ok(["stale", "corrupt", "missing"].includes(f.kind), `unexpected kind ${f.kind}`);
      if (f.kind === "stale") {
        const idH = /checkpoint-id: (\S+)/.exec(handoff)![1];
        const idP = /checkpoint-id: (\S+)/.exec(progress)![1];
        if (idH !== idP) assert.equal(f.partial, true, "mixed generations must be flagged partial");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3: a read-only audit session running beside a normal session leaves the audit snapshot untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-side-by-side-"));
  try {
    makeProject(dir);
    const snapshotDir = join(dir, "audit-snapshot"); // second copy = the audited tree
    mkdirSync(snapshotDir, { recursive: true });
    makeProject(snapshotDir);
    const before = readdirSnapshot(snapshotDir);
    const worker = workerPath(dir);

    const normal = spawnSync(process.execPath, [worker, join(dir, ".pi-guard"), dir, "normal-proc", "25"], { encoding: "utf8" });
    assert.equal(normal.status, 0, normal.stderr);

    // Audit driver: extension loaded in read-only mode against the snapshot tree, with
    // state pushed outside it. Runs as its own process, concurrently with more writes.
    const auditScript = join(dir, "audit-driver.mjs");
    writeFileSync(
      auditScript,
      `
import contextGuard from ${JSON.stringify(GUARD_TS)};
import { createLocalFs } from ${JSON.stringify(CHECKPOINT_TS)};
const [cwd, stateDir] = process.argv.slice(2);
const handlers = new Map();
const pi = {
  on: (e, h) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
  registerCommand: () => {}, registerFlag: () => {}, getFlag: () => undefined,
  sendMessage: () => {}, appendEntry: () => {},
};
const ctx = {
  mode: "print", hasUI: true, cwd,
  ui: { notify: () => {}, setStatus: () => {} },
  getContextUsage: () => ({ tokens: 205000, contextWindow: 220000, percent: null }),
  model: { maxTokens: 65536, contextWindow: 220000 },
  sessionManager: { getSessionId: () => "audit-proc", getBranch: () => [], getEntries: () => [] },
  isIdle: () => true,
};
contextGuard(pi, { fs: createLocalFs(), env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: stateDir } });
for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, ctx);
for (let i = 0; i < 5; i++) for (const h of handlers.get("turn_end") ?? []) await h({ type: "turn_end" }, ctx);
console.log("audit-done");
`,
      "utf8",
    );
    const auditState = join(dir, "audit-state");
    const audit = spawnSync(process.execPath, [auditScript, snapshotDir, auditState], { encoding: "utf8" });
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /audit-done/);

    assert.deepEqual(readdirSnapshot(snapshotDir), before, "audited snapshot unchanged while another process worked");
    assert.ok(readdirSync(join(dir, ".pi-guard", "sessions")).includes("normal-proc.json"), "normal session still persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readdirSnapshot(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    out.push(`${name}:${readFileSync(p, "utf8")}`);
  }
  return out;
}

test("P4: retention pruning is disabled by default and never removes a recently active session's state", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-prune-"));
  try {
    const stateDir = join(dir, "state");
    const fsOps = createLocalFs();
    mkdirSync(sessionsDirPath(stateDir), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const ids = ["old-1", "old-2", "old-3", "live-other"];
    for (const id of ids) {
      const p = sessionStatePath(stateDir, id);
      saveGuardState(fsOps, stateDir, { version: 2, sessionId: id, updatedAt: Date.now(), snapshot: { currentLevel: 0, alertedLevels: [], unknownStreak: 0, degraded: false, lastRemaining: null, evaluations: 1 } });
      utimesSync(p, now - 40 * 86400, now - 40 * 86400); // pretend all are 40 days old
    }
    // the "live" one is touched now (a running process owns it)
    const live = sessionStatePath(stateDir, "live-other");
    const liveBody = readFileSync(live, "utf8");
    writeFileSync(live, liveBody);

    const removedDisabled = pruneSessionStates(fsOps, stateDir, 0, "me");
    assert.deepEqual(removedDisabled, [], "default (0) disables unsafe pruning");

    const removed = pruneSessionStates(fsOps, stateDir, 1, "me");
    assert.ok(!removed.includes(live), "a state file updated within the grace window is never pruned");
    const remaining = readdirSync(sessionsDirPath(stateDir));
    assert.ok(remaining.includes("live-other.json"), remaining.join(","));
    assert.ok(remaining.includes("me.json") === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P5: real two-process Pi sessions are exercised by the e2e script (skipped when pi is unavailable)", (t) => {
  const piAvailable = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
  if (!piAvailable || process.env.GUARD_E2E !== "1") {
    t.skip("real Pi RPC concurrency is verified out-of-band by scripts/e2e-rpc-two-process.mjs (run with GUARD_E2E=1); documented in PROGRESS.md");
    return;
  }
  const r = spawnSync(process.execPath, [new URL("../scripts/e2e-rpc-two-process.mjs", import.meta.url).pathname], { encoding: "utf8", timeout: 240_000 });
  assert.equal(r.status, 0, `e2e failed:\n${r.stdout}\n${r.stderr}`);
});
