import test from "node:test";
import assert from "node:assert/strict";

import { attestHandoff, validateCheckpoint, writeCheckpoint } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMissionInstance, missionInstancePaths } from "../.pi/extensions/context-guard/mission-instance.ts";
import {
  inspectMissionClosure,
  makeMissionClosureRecord,
  missionClosurePaths,
  prepareMissionClosure,
} from "../.pi/extensions/context-guard/mission-lifecycle.ts";
import { createMemoryFs, DEFAULT_FILES } from "./helpers.ts";

const id = "sealed";
const docs = {
  handoff: "# HANDOFF\n\n## Recovery instructions\nRead durable files only.\n\n## Last verified state\nBaseline recorded.\n\n## Unfinished operations\nNone.\n\n## Next action\nContinue the next mission.\n\n## Discoveries not yet incorporated\nNone.\n",
  progress: "# PROGRESS\n\n## Current phase\nComplete.\n\n## Completed\n- Work finished.\n\n## Pending\nNone.\n\n## Verified evidence\nDeterministic checks recorded.\n\n## Blockers\nNone.\n\n## Next action\nContinue the next mission.\n",
  learnings: "# LEARNINGS\n\n## Accepted\nNone.\n\n## Proposed\nNone.\n\n## Falsified or superseded\nNone.\n",
};

function readyFixture() {
  const fs = createMemoryFs(DEFAULT_FILES);
  assert.equal(createMissionInstance(fs, "/project", id, null).ok, true);
  const paths = missionInstancePaths(id);
  fs.writeFile(`/project/${paths.files.handoff}`, docs.handoff);
  fs.writeFile(`/project/${paths.files.progress}`, docs.progress);
  fs.writeFile(`/project/${paths.files.learnings}`, docs.learnings);
  const files = paths.files;
  const checkpoint = writeCheckpoint(fs, {
    cwd: "/project", files, level: 1, sessionId: "close-fixture", remaining: 1000,
    goalDrift: false, lastVerifiedState: "all outcomes preserved", unfinishedOperations: [],
    nextAction: "Continue the next mission.", recoveryInstructions: ["Read durable files."], kind: "manual",
  });
  assert.equal(checkpoint.ok, true, checkpoint.errors.join("; "));
  const attestation = attestHandoff(fs, "/project", files, { sessionId: "close-fixture" });
  assert.equal(attestation.ok, true, attestation.errors.join("; "));
  const current = validateCheckpoint(fs, "/project", files);
  assert.equal(current.kind, "current");
  const stateDir = "/project/.pi-guard/instances/sealed";
  return { fs, paths, stateDir, current };
}

function options(fixture: ReturnType<typeof readyFixture>, extra: Partial<Parameters<typeof prepareMissionClosure>[0]> = {}) {
  return {
    fs: fixture.fs,
    cwd: "/project",
    missionId: id,
    stateDir: fixture.stateDir,
    checkpoint: fixture.current,
    renewalMax: 8,
    gitRevision: "a".repeat(40),
    ownsLock: true,
    readOnly: false,
    stateCorrupted: false,
    renewalBusy: false,
    cycleBusy: false,
    ...extra,
  };
}

test("MH1: current attested closure hashes mission and state files without moving them", () => {
  const fixture = readyFixture();
  fixture.fs.writeFile(`${fixture.stateDir}/renewal-state.json`, JSON.stringify({ version: 1, chainId: "mission:sealed:chain:x", renewalsDone: 2, renewedFromCheckpointId: "g1-sealed", lastSuccessorSessionId: null, stopped: false, updatedAt: 10 }));
  fixture.fs.writeFile(`${fixture.stateDir}/checkpoint-history/g1.json`, "checkpoint history");
  assert.ok(fixture.fs.files.has(`${fixture.stateDir}/checkpoint-history/g1.json`));
  assert.deepEqual(fixture.fs.listFilesStrict!(fixture.stateDir).sort(), ["checkpoint-history", "renewal-state.json"]);
  const before = [...fixture.fs.files.entries()].sort();
  const plan = prepareMissionClosure(options(fixture));
  assert.deepEqual(plan.blockers, []);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.checkpoint.attestation, "attested");
  assert.ok(plan.files["mission:HANDOFF.md"]);
  assert.ok(plan.files["state:checkpoint-history/g1.json"], Object.keys(plan.files).join(", ") + "\n" + fixture.stateDir);
  assert.deepEqual([...fixture.fs.files.entries()].sort(), before, "planning is read-only");

  const record = makeMissionClosureRecord(plan, "campaign completed", "2026-11-14T12:00:00.000Z");
  const closure = missionClosurePaths("/project", id).closure;
  assert.equal(fixture.fs.createExclusiveAtomic!(closure, JSON.stringify(record, null, 2) + "\n"), true);
  const inspection = inspectMissionClosure(fixture.fs, "/project", id, fixture.stateDir);
  assert.equal(inspection.state, "closed");
  for (const [file, content] of before) assert.equal(fixture.fs.files.get(file), content, `closure preserves ${file}`);
  assert.ok(fixture.fs.files.has(`${fixture.stateDir}/checkpoint-history/g1.json`), "history remains in its original location");
});

test("MH2: corrupt, pending, incomplete, busy and non-owner states block closure", () => {
  const fixture = readyFixture();
  for (const extra of [
    { ownsLock: false },
    { readOnly: true },
    { stateCorrupted: true },
    { renewalBusy: true },
    { cycleBusy: true },
  ]) assert.ok(prepareMissionClosure(options(fixture, extra)).blockers.length > 0);

  fixture.fs.writeFile(`${fixture.stateDir}/renewal-state.json`, "{broken");
  assert.ok(prepareMissionClosure(options(fixture)).blockers.some((b) => /renewal chain state is corrupt/.test(b)));
  fixture.fs.files.delete(`${fixture.stateDir}/renewal-state.json`);
  fixture.fs.writeFile(`${fixture.stateDir}/documentation-cycle/state.json`, JSON.stringify({ version: 1, cycleId: "dc-test-123456789012", phase: "planning", baseRevision: "x", baseFingerprint: "x", goalFingerprint: "x", planFile: "p", reviewFile: "r", createdAt: 1, updatedAt: 1, stageStartedBy: "s" }));
  assert.ok(prepareMissionClosure(options(fixture)).blockers.some((b) => /documentation cycle is incomplete/.test(b)));
});

test("MH3: interrupted/corrupt closure evidence stays uncertain and is never treated as active", () => {
  const fixture = readyFixture();
  const paths = missionClosurePaths("/project", id);
  fixture.fs.writeFile(paths.closure, '{"schema":1');
  assert.equal(inspectMissionClosure(fixture.fs, "/project", id, fixture.stateDir).state, "uncertain");
  fixture.fs.files.delete(paths.closure);
  fixture.fs.writeFile(paths.pending, "partial pending operation");
  assert.equal(inspectMissionClosure(fixture.fs, "/project", id, fixture.stateDir).state, "uncertain");
});

test("MH4: sealed file changes are reported while the instance remains closed", () => {
  const fixture = readyFixture();
  const plan = prepareMissionClosure(options(fixture));
  const record = makeMissionClosureRecord(plan, "done", "2026-11-14T12:00:00.000Z");
  const closure = missionClosurePaths("/project", id).closure;
  fixture.fs.createExclusiveAtomic!(closure, JSON.stringify(record, null, 2) + "\n");
  fixture.fs.writeFile(`/project/${fixture.paths.files.learnings}`, docs.learnings + "\nexternal note\n");
  const inspection = inspectMissionClosure(fixture.fs, "/project", id, fixture.stateDir);
  assert.equal(inspection.state, "changed");
  assert.ok(inspection.changed.includes("mission:LEARNINGS.md"));
});
