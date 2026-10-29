/**
 * Checkpoint / durability tests (requirements 5, 6, 8, 9) using in-memory fs,
 * plus one real-disk atomicity test in a temp dir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createLocalFs,
  extractManagedSection,
  joinPath,
  loadGuardState,
  readRecoveryBundle,
  replaceManagedSection,
  saveGuardState,
  sessionStatePath,
  sha256,
  validateAll,
  validateCheckpoint,
  writeCheckpoint,
  type PersistedGuardState,
} from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function checkpointInput(over: Partial<Parameters<typeof writeCheckpoint>[0]> = {}): Parameters<typeof writeCheckpoint>[0] {
  return {
    cwd: "/project",
    files: FILES,
    level: 3,
    sessionId: "s-1",
    remaining: 9000,
    goalHash: sha256("goal"),
    goalDrift: false,
    lastVerifiedState: "tests green at commit abc",
    unfinishedOperations: ["- run recovery test"],
    nextAction: "Implement Phase 2 renewal",
    recoveryInstructions: ["read AGENTS.md"],
    ...over,
  };
}

test("managed section: replaces guard block, preserves agent text byte-for-byte", () => {
  const original = [
    "# HANDOFF",
    "",
    "## Agent-authored freeform notes",
    "A wild idea appeared: try X. <- must survive",
    "",
    "<!-- guard:begin checkpoint -->",
    "old inner",
    "<!-- guard:end checkpoint -->",
    "",
    "## Tail section",
    "also preserved",
  ].join("\n");
  const out = replaceManagedSection(original, "checkpoint", "new inner");
  assert.ok(out.includes("A wild idea appeared: try X. <- must survive"));
  assert.ok(out.includes("also preserved"));
  assert.ok(!out.includes("old inner"));
  assert.equal(extractManagedSection(out, "checkpoint"), "new inner");
  // idempotent second replace
  const out2 = replaceManagedSection(out, "checkpoint", "newer");
  assert.equal(extractManagedSection(out2, "checkpoint"), "newer");
  assert.equal((out2.match(/guard:begin checkpoint/g) ?? []).length, 1);
});

test("managed section: appended when absent, without touching existing content", () => {
  const original = "# HANDOFF\n\nfree text\n";
  const out = replaceManagedSection(original, "checkpoint", "inner");
  assert.ok(out.startsWith("# HANDOFF"));
  assert.ok(out.includes("free text"));
  assert.equal(extractManagedSection(out, "checkpoint"), "inner");
});

test("R5: checkpoint write failure is reported, not thrown, and other files still update", () => {
  const fs = createMemoryFs({ "/project/HANDOFF.md": "## stub", "/project/PROGRESS.md": "## stub" });
  fs.failNext.set("/project/HANDOFF.md", 1);
  const result = writeCheckpoint(fs, checkpointInput());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("HANDOFF.md") && e.includes("simulated write failure")));
  assert.deepEqual(result.written, ["PROGRESS.md"]); // progress still written
});

test("R5b: guard state persistence failure is reported and survivable", () => {
  const fs = createMemoryFs();
  fs.failNext.set("/project/.pi-guard/sessions/s.json", 1);
  const saved = saveGuardState(fs, "/project/.pi-guard", {
    version: 2,
    sessionId: "s",
    updatedAt: 0,
    snapshot: { currentLevel: 0, alertedLevels: [], unknownStreak: 0, degraded: false, lastRemaining: null, evaluations: 0 },
  });
  assert.equal(saved.ok, false);
  assert.ok(saved.error);
});

test("R6: partially written (corrupt) per-session state file is quarantined; stale tmp files are removed", () => {
  const fs = createMemoryFs({
    "/project/.pi-guard/sessions/s-1.json": '{"version":2,"sessionId":"s-1","snapsh', // truncated mid-write
    "/project/.pi-guard/sessions/s-1.json.tmp-42-999": "junk", // leftover tmp from a crash
  });
  const loaded = loadGuardState(fs, "/project/.pi-guard", "s-1");
  assert.equal(loaded.kind, "corrupt");
  assert.equal(fs.exists("/project/.pi-guard/sessions/s-1.json"), false); // quarantined
  const backups = [...fs.files.keys()].filter((k) => k.includes("corrupt") && k.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.ok(backups[0].startsWith("/project/.pi-guard/sessions/s-1.json"));
  assert.equal(fs.exists("/project/.pi-guard/sessions/s-1.json.tmp-42-999"), false); // tmp cleaned
});

test("R6b: state round trip is per-session; foreign-session state is untouched by load", () => {
  const fs = createMemoryFs();
  const state: PersistedGuardState = {
    version: 2,
    sessionId: "s-1",
    updatedAt: 1,
    snapshot: { currentLevel: 2, alertedLevels: [1, 2], unknownStreak: 0, degraded: false, lastRemaining: 19000, evaluations: 7 },
    goalHash: "abc",
  };
  assert.equal(saveGuardState(fs, "/project/.pi-guard", state).ok, true);
  assert.ok(fs.exists(sessionStatePath("/project/.pi-guard", "s-1")));
  const loaded = loadGuardState(fs, "/project/.pi-guard", "s-1");
  assert.equal(loaded.kind, "found");
  if (loaded.kind === "found") {
    assert.equal(loaded.state.sessionId, "s-1");
    assert.deepEqual(loaded.state.snapshot.alertedLevels, [1, 2]);
  }
  // another session loading its own (absent) state does not disturb s-1
  const other = loadGuardState(fs, "/project/.pi-guard", "s-2");
  assert.equal(other.kind, "missing");
  assert.ok(fs.exists(sessionStatePath("/project/.pi-guard", "s-1")));
});

test("R6c: legacy single-slot state.json migrates to its owner's per-session file", () => {
  const legacy = JSON.stringify({
    version: 1,
    sessionId: "old-session",
    updatedAt: 5,
    snapshot: { currentLevel: 1, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 25000, evaluations: 3 },
  });
  const fs = createMemoryFs({ "/project/.pi-guard/state.json": legacy });
  // a DIFFERENT session starts: legacy state is preserved under its owner's name, not applied
  const loaded = loadGuardState(fs, "/project/.pi-guard", "new-session");
  assert.equal(loaded.kind, "missing");
  if (loaded.kind === "missing") assert.equal(loaded.foreignMigrated, "old-session");
  assert.equal(fs.exists("/project/.pi-guard/state.json"), false); // legacy slot retired
  const owner = loadGuardState(fs, "/project/.pi-guard", "old-session");
  assert.equal(owner.kind, "found");
  if (owner.kind === "found") {
    assert.equal(owner.state.version, 2);
    assert.deepEqual(owner.state.snapshot.alertedLevels, [1]); // content preserved
  }
  // OWN-session migration: legacy file matching the current id is adopted and normalized
  const fs2 = createMemoryFs({ "/project/.pi-guard/state.json": legacy });
  const mine = loadGuardState(fs2, "/project/.pi-guard", "old-session");
  assert.equal(mine.kind, "found");
  if (mine.kind === "found") assert.equal(mine.migrated, "self");
  assert.equal(fs2.exists("/project/.pi-guard/state.json"), false);

  // coexistence: a still-running v1 writer may re-create state.json after a
  // migration; the NEWER snapshot must win, never the older migrated copy.
  const newerLegacy = JSON.stringify({ ...JSON.parse(legacy), version: 1, updatedAt: 999 });
  const fs3 = createMemoryFs({
    "/project/.pi-guard/state.json": newerLegacy,
    "/project/.pi-guard/sessions/old-session.json": JSON.stringify({ ...JSON.parse(legacy), version: 2, updatedAt: 10 }),
  });
  const winner = loadGuardState(fs3, "/project/.pi-guard", "old-session");
  assert.equal(winner.kind, "found");
  if (winner.kind === "found") assert.equal(winner.state.updatedAt, 999, "newer legacy snapshot wins");
  // and when the migrated file is newer, it is kept
  const fs4 = createMemoryFs({
    "/project/.pi-guard/state.json": legacy, // updatedAt 5
    "/project/.pi-guard/sessions/old-session.json": JSON.stringify({ ...JSON.parse(legacy), version: 2, updatedAt: 50 }),
  });
  const kept = loadGuardState(fs4, "/project/.pi-guard", "old-session");
  assert.equal(kept.kind, "found");
  if (kept.kind === "found") assert.equal(kept.state.updatedAt, 50, "newer per-session file wins");
});

test("R8: checkpoint never touches LEARNINGS.md — unresolved proposals survive", () => {
  const learnings =
    "# LEARNINGS\n\n## Accepted\n(none)\n\n## Proposed\n- [P-7] Try speculative decoding.\n  evidence: bench x\n  value: medium\n  cost: medium\n  confidence: low\n  status: proposed\n\n## Falsified or superseded\n(none)\n";
  const fs = createMemoryFs({
    "/project/LEARNINGS.md": learnings,
    "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- a\n\n## Last verified state\n- b\n\n## Unfinished operations\n- c\n\n## Next action\n- d\n\n## Discoveries not yet incorporated\n- e\n",
    "/project/PROGRESS.md":
      "# PROGRESS\n\n## Current phase\np\n\n## Completed\n- x\n\n## Pending\n- y\n\n## Verified evidence\nz\n\n## Blockers\nnone\n\n## Next action\nRun recovery test.\n",
    "/project/GOAL.md": "# GOAL\n\n## Objective\nO\n\n## Acceptance criteria\nA\n",
  });
  const result = writeCheckpoint(fs, checkpointInput());
  assert.equal(result.ok, true);
  assert.equal(fs.files.get("/project/LEARNINGS.md"), learnings); // byte-for-byte untouched
  assert.ok(fs.files.get("/project/HANDOFF.md")!.includes("[P-7]") === false); // not duplicated into handoff body
  assert.ok(fs.files.get("/project/HANDOFF.md")!.includes("Implement Phase 2 renewal"));
});

test("R9: recovery bundle prefers fresh manual prose; checkpoint block is used only when current", () => {
  const fs = createMemoryFs({
    "/project/GOAL.md": "# GOAL\n\n## Objective\nShip the context guard without touching pli80.\n\n## Acceptance criteria\n- Tests pass.\n",
    "/project/HANDOFF.md":
      "# HANDOFF\n\n## Recovery instructions\n- Read AGENTS.md first.\n- Then PROGRESS.md.\n\n## Last verified state\nold\n\n## Unfinished operations\nold\n\n## Next action\nmanual prose next\n\n## Discoveries not yet incorporated\n- e\n",
  });
  const bundle = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(bundle.objective, "Ship the context guard without touching pli80.");
  assert.equal(bundle.nextAction, "manual prose next");
  assert.equal(bundle.nextActionSource, "handoff-prose");
  assert.equal(bundle.checkpoint.kind, "missing");
  assert.deepEqual(bundle.recoveryInstructions, ["- Read AGENTS.md first.", "- Then PROGRESS.md."]);

  // after a checkpoint (no manual prose would be overwritten): prose still wins,
  // and the checkpoint itself verifies as current (no false staleness).
  writeCheckpoint(fs, checkpointInput({ nextAction: "ignored because prose exists" }));
  const bundle2 = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(bundle2.nextAction, "manual prose next");
  assert.equal(bundle2.checkpoint.kind, "current");

  // with NO manual prose section, a current checkpoint supplies the next action
  const fs3 = createMemoryFs({
    "/project/GOAL.md": "# GOAL\n\n## Objective\nO.\n\n## Acceptance criteria\nA\n",
    "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- r\n\n## Last verified state\ns\n\n## Unfinished operations\nu\n\n## Discoveries not yet incorporated\nd\n",
    "/project/PROGRESS.md": "# PROGRESS\n\n## Current phase\np\n",
  });
  writeCheckpoint(fs3, checkpointInput({ nextAction: "Run `node --test test/` and fix failures" }));
  const bundle3 = readRecoveryBundle(fs3, "/project", FILES);
  assert.equal(bundle3.nextAction, "Run `node --test test/` and fix failures");
  assert.equal(bundle3.nextActionSource, "checkpoint");
});

test("validation reports missing required sections", () => {
  const fs = createMemoryFs({
    "/project/GOAL.md": "# GOAL\n\n## Objective\nonly objective, no acceptance criteria\n",
    "/project/PROGRESS.md": "# PROGRESS\n\n## Current phase\np\n\n## Completed\nc\n\n## Pending\nq\n\n## Verified evidence\nz\n\n## Blockers\nn\n\n## Next action\na\n",
    "/project/LEARNINGS.md": "# LEARNINGS\n\n## Accepted\na\n\n## Proposed\np\n\n## Falsified or superseded\nf\n",
    "/project/HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\nr\n\n## Last verified state\ns\n\n## Unfinished operations\nu\n\n## Next action\nn\n\n## Discoveries not yet incorporated\nd\n",
  });
  const validations = validateAll(fs, "/project", FILES);
  const byFile = new Map(validations.map((v) => [v.file, v]));
  assert.equal(byFile.get("/project/GOAL.md")!.ok, false);
  assert.deepEqual(byFile.get("/project/GOAL.md")!.missingSections, ["## Acceptance criteria"]);
  assert.equal(byFile.get("/project/PROGRESS.md")!.ok, true);
  assert.equal(byFile.get("/project/MISSING.md") === undefined, true);
});

test("unreadable durable file is a validation failure, not a crash", () => {
  const fs = createMemoryFs();
  const validations = validateAll(fs, "/project", FILES);
  assert.ok(validations.every((v) => v.unreadable && !v.ok));
});

test("real disk: createLocalFs writes atomically and leaves no tmp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  const fs = createLocalFs();
  const target = joinPath(dir, "nested/state.json");
  fs.writeFile(target, '{"ok":true}');
  assert.equal(fs.readFile(target), '{"ok":true}');
  const leftovers = readdirSync(join(dir, "nested")).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);

  // failure path: parent path is a file -> mkdir throws, nothing half-written
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  assert.throws(() => fs.writeFile(join(blocker, "x.json"), "data"));
  assert.equal(existsSync(join(blocker, "x.json")), false);

  // loadGuardState on a real corrupt legacy file (v1 migration path)
  const stateDir = join(dir, "state");
  fs.mkdirRecursive(stateDir);
  fs.writeFile(join(stateDir, "state.json"), '{"version":1,"session');
  fs.writeFile(join(stateDir, "state.json.tmp-1-1"), "stale");
  const loaded = loadGuardState(fs, stateDir, "real-sess");
  assert.equal(loaded.kind, "corrupt");
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(existsSync(join(stateDir, "state.json.tmp-1-1")), false);
  assert.equal(readdirSync(stateDir).filter((n) => n.includes("corrupt")).length, 1);

  // real disk: per-session save/load round trip
  const sess = { version: 2 as const, sessionId: "real-sess", updatedAt: 1, snapshot: { currentLevel: 1, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 100, evaluations: 1 } };
  assert.equal(saveGuardState(fs, stateDir, sess).ok, true);
  assert.ok(existsSync(join(stateDir, "sessions", "real-sess.json")));
  const rl = loadGuardState(fs, stateDir, "real-sess");
  assert.equal(rl.kind, "found");
});
