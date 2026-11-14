import test from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLocalFs, writeCheckpoint, attestHandoff, validateCheckpoint, renewAuthorization, saveRenewalState, loadRenewalState } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMissionInstance, missionInstancePaths } from "../.pi/extensions/context-guard/mission-instance.ts";
import { decideRenewal, DEFAULT_RENEWAL, INITIAL_RENEWAL_STATE, type RenewalState } from "../.pi/extensions/context-guard/renewal.ts";
import { inspectMissionClosure, makeMissionClosureRecord, missionClosurePaths, prepareMissionClosure } from "../.pi/extensions/context-guard/mission-lifecycle.ts";
import { inspectInstanceLock } from "../.pi/extensions/context-guard/mission-lock.ts";
import { knowledgeRegistrySummary } from "../.pi/extensions/context-guard/knowledge.ts";
import { parseDocumentationCycleState } from "../.pi/extensions/context-guard/documentation-cycle.ts";

const durable = {
  handoff: "# HANDOFF\n\n## Recovery instructions\nRead the durable project files.\n\n## Last verified state\nA qualification fixture.\n\n## Unfinished operations\nNone.\n\n## Next action\nContinue the isolated qualification.\n\n## Discoveries not yet incorporated\nNone.\n",
  progress: "# PROGRESS\n\n## Current phase\nQualification.\n\n## Completed\n- Fixture prepared.\n\n## Pending\n- Restore test.\n\n## Verified evidence\nFixture only.\n\n## Blockers\nNone.\n\n## Next action\nContinue the isolated qualification.\n",
  learnings: "# LEARNINGS\n\n## Accepted\nNone.\n\n## Proposed\nNone.\n\n## Falsified or superseded\nNone.\n",
};

const renewalConfig = { ...DEFAULT_RENEWAL, enabled: true, maxRenewals: 2 };

async function isolated<T>(name: string, fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = fsDefault.mkdtempSync(path.join(os.tmpdir(), `atlas-qualification-${name}-`));
  try { return await fn(root); }
  finally { fsDefault.rmSync(root, { recursive: true, force: true }); }
}

function fixture(project: string, id: string): { stateDir: string; files: ReturnType<typeof missionInstancePaths>["files"]; checkpointId: string } {
  fsDefault.mkdirSync(project, { recursive: true });
  fsDefault.writeFileSync(path.join(project, "GOAL.md"), "# GOAL\n\n## Objective\nQualification fixture only.\n\n## Acceptance criteria\nDurable state restored without changing authorization.\n");
  fsDefault.writeFileSync(path.join(project, "AGENTS.md"), "# Agent rules\nUse durable files.\n");
  fsDefault.writeFileSync(path.join(project, "PROTOCOL.md"), "# Protocol\nQualification fixture.\n");
  fsDefault.writeFileSync(path.join(project, "handoff.config.json"), JSON.stringify({ stateDir: ".pi-guard", missionInstance: { id } }));
  const fs = createLocalFs();
  const created = createMissionInstance(fs, project, id, null);
  assert.equal(created.ok, true, "explicit mission fixture is created without migration");
  const paths = missionInstancePaths(id);
  fsDefault.writeFileSync(path.join(project, paths.files.handoff), durable.handoff);
  fsDefault.writeFileSync(path.join(project, paths.files.progress), durable.progress);
  fsDefault.writeFileSync(path.join(project, paths.files.learnings), durable.learnings);
  const written = writeCheckpoint(fs, {
    cwd: project, files: paths.files, level: 1, sessionId: `qual-${id}`, remaining: 1000,
    goalDrift: false, lastVerifiedState: "isolated qualification fixture", unfinishedOperations: [],
    nextAction: "Continue the isolated qualification.", recoveryInstructions: ["Read the durable files."], kind: "manual",
  });
  assert.equal(written.ok, true, written.errors.join("; "));
  const attested = attestHandoff(fs, project, paths.files, { sessionId: `qual-${id}` });
  assert.equal(attested.ok, true, attested.errors.join("; "));
  const check = validateCheckpoint(fs, project, paths.files);
  assert.equal(check.kind, "current");
  assert.equal(check.readiness.state, "attested");
  return { stateDir: path.join(project, paths.stateDir), files: paths.files, checkpointId: written.identity.id };
}

function makeState(id: string, checkpointId: string, values: Partial<RenewalState> = {}): RenewalState {
  return {
    version: 1, chainId: `mission:${id}:chain:qual`, renewalsDone: 1,
    renewedFromCheckpointId: checkpointId, lastSuccessorSessionId: "successor-qual",
    stopped: false, updatedAt: 1_800_000_000_000, ...values,
  };
}

function decision(project: string, id: string, stateDir: string) {
  const fs = createLocalFs();
  const check = validateCheckpoint(fs, project, missionInstancePaths(id).files);
  const state = loadRenewalState(fs, stateDir);
  const checkpointId = check.kind === "current" ? check.identity?.id ?? null : null;
  return { check, state, decision: decideRenewal({
    renewal: renewalConfig, trigger: "operator", auth: renewAuthorization(check), checkpointId,
    state: state.state, operatorStop: state.state.stopped, pendingInFlight: false, readOnly: false,
  }) };
}

test("Q1-A: coherent full restore preserves checkpoint, consumed identity, cap and durable stop", async () => {
  await isolated("restore-a", (root) => {
    const source = path.join(root, "source");
    const id = "restore-a";
    const sourceFixture = fixture(source, id);
    const variants: Array<[string, Partial<RenewalState>, string]> = [
      ["consumed", { renewalsDone: 1, renewedFromCheckpointId: sourceFixture.checkpointId }, "already-renewed"],
      ["capped", { renewalsDone: 2, renewedFromCheckpointId: null }, "capped"],
      ["stopped", { stopped: true, renewedFromCheckpointId: null }, "stopped"],
    ];
    for (const [name, changes, expected] of variants) {
      const state = makeState(id, sourceFixture.checkpointId, changes);
      assert.equal(saveRenewalState(createLocalFs(), sourceFixture.stateDir, state).ok, true);
      const restored = path.join(root, `restored-${name}`);
      fsDefault.cpSync(source, restored, { recursive: true });
      const targetState = path.join(restored, missionInstancePaths(id).stateDir);
      const result = decision(restored, id, targetState);
      assert.equal(result.check.kind, "current");
      assert.equal(result.check.readiness.state, "attested");
      assert.deepEqual(result.state.state, state, `${name}: chain state bytes survive coherent restore`);
      assert.equal(result.decision.renew ? "ready" : result.decision.why, expected, `${name}: original gate remains in force`);
      fsDefault.rmSync(path.join(sourceFixture.stateDir, "renewal-state.json"));
    }
  });
});

test("Q1-B REPRODUCER: Git-only restore omits renewal state and re-authorizes a consumed checkpoint", async () => {
  await isolated("restore-b", (root) => {
    const id = "restore-b";
    const source = path.join(root, "source");
    const sourceFixture = fixture(source, id);
    const sourceStateDir = sourceFixture.stateDir;
    const variants: Array<[string, Partial<RenewalState>]> = [
      ["consumed checkpoint", { renewalsDone: 1, renewedFromCheckpointId: sourceFixture.checkpointId }],
      ["exhausted cap", { renewalsDone: 2, renewedFromCheckpointId: null }],
      ["operator stop", { stopped: true, renewedFromCheckpointId: null }],
    ];
    for (const [name, changes] of variants) {
      assert.equal(saveRenewalState(createLocalFs(), sourceStateDir, makeState(id, sourceFixture.checkpointId, changes)).ok, true);
      const checkout = path.join(root, `checkout-${name.replaceAll(" ", "-")}`);
      fsDefault.mkdirSync(checkout, { recursive: true });
      for (const file of ["GOAL.md", "AGENTS.md", "PROTOCOL.md", "handoff.config.json"]) fsDefault.copyFileSync(path.join(source, file), path.join(checkout, file));
      fsDefault.cpSync(path.join(source, ".pi-handoff", "instances", id), path.join(checkout, ".pi-handoff", "instances", id), { recursive: true });
      const absent = decision(checkout, id, path.join(checkout, missionInstancePaths(id).stateDir));
      assert.equal(absent.check.kind, "current");
      assert.equal(absent.check.readiness.state, "attested");
      assert.equal(absent.state.corrupt, false, "missing state is silently parsed as an initial chain");
      assert.equal(absent.state.state.renewalsDone, 0);
      assert.equal(absent.state.state.stopped, false);
      assert.equal(absent.decision.renew, true, `${name}: unsafe renewal authorization reproduced after checkout-only restore`);
      fsDefault.rmSync(path.join(sourceStateDir, "renewal-state.json"));
    }

    const fresh = path.join(root, "new-explicit-mission");
    fsDefault.mkdirSync(fresh, { recursive: true });
    const freshFixture = fixture(fresh, "new-authorized-mission");
    fsDefault.rmSync(path.join(freshFixture.stateDir, "renewal-state.json"), { force: true });
    const freshCheck = validateCheckpoint(createLocalFs(), fresh, freshFixture.files);
    assert.equal(freshCheck.kind, "current", "new explicitly created mission remains usable with a fresh checkpoint");
  });
});

test("Q1-C: mismatched durable evidence and interrupted seals/locks are refused or surfaced", async () => {
  await isolated("restore-c", (root) => {
    const project = path.join(root, "project");
    const id = "restore-c";
    const f = fixture(project, id);
    const state = makeState(id, f.checkpointId);
    assert.equal(saveRenewalState(createLocalFs(), f.stateDir, state).ok, true);

    const currentDocs = path.join(root, "current-docs");
    fsDefault.cpSync(project, currentDocs, { recursive: true });
    fsDefault.appendFileSync(path.join(project, f.files.learnings), "\n## external newer evidence\n");
    const newerDocs = decision(project, id, f.stateDir);
    assert.equal(newerDocs.check.kind, "stale", "newer manual documents invalidate old source fingerprints");
    assert.equal(newerDocs.decision.renew, false);
    assert.equal(newerDocs.decision.why, "not-authorized");

    const currentStateDir = path.join(currentDocs, missionInstancePaths(id).stateDir);
    assert.equal(saveRenewalState(createLocalFs(), currentStateDir, { ...state, stopped: true, updatedAt: state.updatedAt! + 1 }).ok, true);
    const newerState = decision(currentDocs, id, currentStateDir);
    assert.equal(newerState.check.kind, "current", "newer transaction state does not rewrite document identity");
    assert.equal(newerState.decision.renew, false);
    assert.equal(newerState.decision.why, "stopped", "durable operator stop remains terminal for renewal");

    const corruptState = path.join(currentStateDir, "renewal-state.json");
    fsDefault.writeFileSync(corruptState, "{corrupt\n");
    const corrupted = decision(currentDocs, id, currentStateDir);
    assert.equal(corrupted.state.corrupt, true);
    assert.equal(corrupted.decision.renew, true, "current renewal implementation also re-authorizes when corrupt state parses to initial state");

    const externalStateDir = path.join(root, "external-state-configured-outside-project");
    fsDefault.mkdirSync(externalStateDir, { recursive: true });
    assert.equal(saveRenewalState(createLocalFs(), externalStateDir, { ...state, stopped: true }).ok, true);
    const externalState = decision(currentDocs, id, externalStateDir);
    assert.equal(path.relative(currentDocs, externalStateDir).startsWith(".."), true, "configured transaction state is outside the project tree");
    assert.equal(externalState.decision.why, "stopped", "an external stateDir preserves the stop when backed up");
    const externalBackup = path.join(root, "external-state-backup");
    fsDefault.cpSync(externalStateDir, externalBackup, { recursive: true });
    fsDefault.rmSync(externalStateDir, { recursive: true, force: true });
    assert.equal(decision(currentDocs, id, externalStateDir).decision.renew, true, "losing external state has the same unsafe reset semantics");
    assert.equal(decision(currentDocs, id, externalBackup).decision.why, "stopped", "restoring the external state snapshot retains the operator stop");

    const fs = createLocalFs();
    const paths = missionClosurePaths(project, id);
    fsDefault.mkdirSync(path.dirname(paths.pending), { recursive: true });
    fsDefault.writeFileSync(paths.pending, "operation interrupted before closure record\n");
    assert.equal(inspectMissionClosure(fs, project, id, f.stateDir).state, "uncertain", "interrupted closure remains mutation-blocking");

    const lockPath = path.join(project, ".pi-handoff", "instances", id, ".owner.lock");
    fsDefault.writeFileSync(lockPath, JSON.stringify({ schema: 1, token: "old", pid: 4242, hostname: os.hostname(), platform: "linux", sessionId: "old", startedAt: "2026-01-01T00:00:00Z", bootId: "old-boot", processStart: "4" }));
    const reused = inspectInstanceLock(fs, lockPath, () => "pid-reused");
    assert.equal(reused.state, "pid-reused", "PID reuse requires boot/process identity evidence; age alone is unused");
    assert.notEqual(reused.state, "missing");

    fsDefault.mkdirSync(path.join(project, ".pi-handoff", "knowledge", "records", "interrupted"), { recursive: true });
    fsDefault.writeFileSync(path.join(project, ".pi-handoff", "knowledge", "records", "interrupted", ".tmp-publication-partial"), "partial record");
    const registry = knowledgeRegistrySummary(fs, project);
    assert.equal(registry.errors.length, 0);
    assert.match(registry.warnings.join("\n"), /uncommitted atomic publication artifact preserved/);

    const absentCycle = parseDocumentationCycleState(undefined);
    assert.equal(absentCycle.corrupt, false);
    assert.equal(absentCycle.state, undefined, "a missing cycle journal is interpreted as idle, so an in-flight cycle cannot be reconstructed from that stateDir alone");
  });
});

test("Q1-A/B: full closure restore validates; a project-only restore refuses the missing sealed state", async () => {
  await isolated("restore-closure", (root) => {
    const project = path.join(root, "project");
    const id = "restore-sealed";
    const f = fixture(project, id);
    const fs = createLocalFs();
    assert.equal(saveRenewalState(fs, f.stateDir, makeState(id, f.checkpointId, { renewalsDone: 2 })).ok, true);
    const checkpoint = validateCheckpoint(fs, project, f.files);
    const plan = prepareMissionClosure({
      fs, cwd: project, missionId: id, stateDir: f.stateDir, checkpoint, renewalMax: 2,
      ownsLock: true, readOnly: false, stateCorrupted: false, renewalBusy: false, cycleBusy: false,
    });
    assert.equal(plan.blockers.length, 0, plan.blockers.join("; "));
    const record = makeMissionClosureRecord(plan, "restore qualification seal");
    const closePaths = missionClosurePaths(project, id);
    assert.equal(fs.createExclusive!(closePaths.pending, JSON.stringify({ operationId: record.operationId })), true);
    assert.equal(fs.createExclusiveAtomic!(closePaths.closure, JSON.stringify(record, null, 2) + "\n"), true);
    fs.remove(closePaths.pending);
    assert.equal(inspectMissionClosure(fs, project, id, f.stateDir).state, "closed");

    const backup = path.join(root, "full-backup");
    fsDefault.cpSync(project, backup, { recursive: true });
    fsDefault.rmSync(project, { recursive: true, force: true });
    fsDefault.cpSync(backup, project, { recursive: true });
    assert.equal(inspectMissionClosure(fs, project, id, f.stateDir).state, "closed", "complete same-path restore preserves the seal and hashes");

    fsDefault.rmSync(project, { recursive: true, force: true });
    fsDefault.mkdirSync(project, { recursive: true });
    for (const file of ["GOAL.md", "AGENTS.md", "PROTOCOL.md", "handoff.config.json"]) fsDefault.copyFileSync(path.join(backup, file), path.join(project, file));
    fsDefault.cpSync(path.join(backup, ".pi-handoff", "instances", id), path.join(project, ".pi-handoff", "instances", id), { recursive: true });
    const partial = inspectMissionClosure(fs, project, id, path.join(project, missionInstancePaths(id).stateDir));
    assert.equal(partial.state, "changed", "project-only restore is not treated as a closed, valid instance when sealed state is absent");
    assert.match(partial.detail, /state root differs|files changed externally or are missing/);
  });
});
