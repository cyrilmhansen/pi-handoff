import test from "node:test";
import assert from "node:assert/strict";

import { attestHandoff, validateCheckpoint, writeCheckpoint } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMissionInstance, missionInstancePaths } from "../.pi/extensions/context-guard/mission-instance.ts";
import { inspectMissionClosure, missionClosurePaths } from "../.pi/extensions/context-guard/mission-lifecycle.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const text = {
  handoff: "# HANDOFF\n\n## Recovery instructions\nRead durable files only.\n\n## Last verified state\nBaseline recorded.\n\n## Unfinished operations\nNone.\n\n## Next action\nFinish this mission.\n\n## Discoveries not yet incorporated\nNone.\n",
  progress: "# PROGRESS\n\n## Current phase\nComplete.\n\n## Completed\n- Work finished.\n\n## Pending\nNone.\n\n## Verified evidence\nChecks recorded.\n\n## Blockers\nNone.\n\n## Next action\nFinish this mission.\n",
  learnings: "# LEARNINGS\n\n## Accepted\nNone.\n\n## Proposed\nNone.\n\n## Falsified or superseded\nNone.\n",
};

async function activeMission(id: string) {
  const fs = createMemoryFs(DEFAULT_FILES);
  assert.equal(createMissionInstance(fs, "/project", id, null).ok, true);
  const paths = missionInstancePaths(id);
  fs.writeFile(`/project/${paths.files.handoff}`, text.handoff);
  fs.writeFile(`/project/${paths.files.progress}`, text.progress);
  fs.writeFile(`/project/${paths.files.learnings}`, text.learnings);
  const checkpoint = writeCheckpoint(fs, {
    cwd: "/project", files: paths.files, level: 1, sessionId: `setup-${id}`, remaining: 1000,
    goalDrift: false, lastVerifiedState: "state recorded", unfinishedOperations: [],
    nextAction: "Finish this mission.", recoveryInstructions: ["Read durable files."], kind: "manual",
  });
  assert.equal(checkpoint.ok, true, checkpoint.errors.join("; "));
  assert.equal(attestHandoff(fs, "/project", paths.files, { sessionId: `setup-${id}` }).ok, true);
  assert.equal(validateCheckpoint(fs, "/project", paths.files).kind, "current");
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", sessionId: `active-${id}` });
  contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: id }, processScope: `scope-${id}` });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  return { fs, paths, pi, ctx, id, stateDir: `/project/.pi-guard/instances/${id}` };
}

function planHash(ctx: ReturnType<typeof createMockCtx>): string {
  const report = ctx.notifications.map((x) => x.text).join("\n");
  const match = /approval fingerprint: ([a-f0-9]{64})/.exec(report);
  assert.ok(match, report);
  return match[1];
}

test("MC1: operator plan is read-only; sealing is hash-bound, in-place and idempotent", async () => {
  const h = await activeMission("close-normal");
  const beforePlan = [...h.fs.files.entries()].sort();
  await h.pi.runCommand("handoff", "instance close plan", h.ctx.ctx);
  const fingerprint = planHash(h.ctx);
  assert.deepEqual([...h.fs.files.entries()].sort(), beforePlan, "planning leaves all files byte-identical");
  const closeArgs = `instance close --confirm ${fingerprint} --reason "campaign complete"`;
  await h.pi.runCommand("handoff", closeArgs, h.ctx.ctx);
  const closurePath = missionClosurePaths("/project", h.id).closure;
  const closureRaw = h.fs.files.get(closurePath)!;
  const closure = JSON.parse(closureRaw);
  assert.equal(closure.schema, 1);
  assert.equal(closure.missionId, h.id);
  assert.equal(closure.reason, "campaign complete");
  assert.equal(closure.checkpoint.attestation, "attested");
  assert.match(closure.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(h.fs.files.has(missionClosurePaths("/project", h.id).pending), false);
  assert.equal(inspectMissionClosure(h.fs, "/project", h.id, h.stateDir).state, "closed");
  assert.equal(h.fs.files.has(`/project/${h.paths.files.handoff}`), true, "documents stay in place");
  const writesAfterClose = h.fs.writes.length;
  await h.pi.runCommand("handoff", closeArgs, h.ctx.ctx);
  assert.equal(h.fs.files.get(closurePath), closureRaw, "repeat does not rewrite the seal");
  assert.equal(h.fs.writes.length, writesAfterClose, "repeat is write-free");
});

test("MC2: stale approval is refused and creates no seal", async () => {
  const h = await activeMission("close-stale");
  await h.pi.runCommand("handoff", "instance close plan", h.ctx.ctx);
  const fingerprint = planHash(h.ctx);
  h.fs.writeFile(`/project/${h.paths.files.progress}`, text.progress + "\nexternal change\n");
  const writes = h.fs.writes.length;
  await h.pi.runCommand("handoff", `instance close --confirm ${fingerprint} --reason "done"`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /approval is stale/);
  assert.equal(h.fs.files.has(missionClosurePaths("/project", h.id).closure), false);
  assert.equal(h.fs.writes.length, writes);
});

test("MC3: failed-before-publication remains active; partial and post-publication interruptions remain uncertain/read-only", async () => {
  const before = await activeMission("close-before");
  await before.pi.runCommand("handoff", "instance close plan", before.ctx.ctx);
  const beforeHash = planHash(before.ctx);
  const beforePaths = missionClosurePaths("/project", before.id);
  before.fs.failNext.set(beforePaths.pending, 1);
  await before.pi.runCommand("handoff", `instance close --confirm ${beforeHash} --reason "done"`, before.ctx.ctx);
  assert.equal(inspectMissionClosure(before.fs, "/project", before.id, before.stateDir).state, "active");
  assert.equal(before.fs.files.has(beforePaths.closure), false);

  const during = await activeMission("close-during");
  await during.pi.runCommand("handoff", "instance close plan", during.ctx.ctx);
  const duringHash = planHash(during.ctx);
  const duringPaths = missionClosurePaths("/project", during.id);
  const originalAtomic = during.fs.createExclusiveAtomic!.bind(during.fs);
  during.fs.createExclusiveAtomic = (p, content) => {
    if (p === duringPaths.closure) {
      during.fs.files.set(p, content.slice(0, 20));
      during.fs.writes.push(p);
      throw new Error("simulated interruption during seal publication");
    }
    return originalAtomic(p, content);
  };
  await during.pi.runCommand("handoff", `instance close --confirm ${duringHash} --reason "done"`, during.ctx.ctx);
  assert.equal(inspectMissionClosure(during.fs, "/project", during.id, during.stateDir).state, "uncertain");
  assert.equal(during.fs.files.has(duringPaths.pending), true);
  const beforeBlockedMutation = [...during.fs.files.entries()].sort();
  await during.pi.runCommand("handoff", "checkpoint", during.ctx.ctx);
  assert.deepEqual([...during.fs.files.entries()].sort(), beforeBlockedMutation);
  const uncertainRestart = createMockPi();
  const uncertainCtx = createMockCtx({ cwd: "/project", sessionId: "restart-uncertain" });
  contextGuard(uncertainRestart.pi as never, { fs: during.fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: during.id }, processScope: "restart-uncertain-scope" });
  await uncertainRestart.emit({ type: "session_start", reason: "startup" } as never, uncertainCtx.ctx as never);
  const uncertainBefore = [...during.fs.files.entries()].sort();
  await uncertainRestart.runCommand("handoff", "checkpoint", uncertainCtx.ctx);
  assert.deepEqual([...during.fs.files.entries()].sort(), uncertainBefore, "pending close remains immutable after process restart");
  assert.match(uncertainCtx.notifications.map((item) => item.text).join("\n"), /uncertain closure record/);

  const after = await activeMission("close-after");
  await after.pi.runCommand("handoff", "instance close plan", after.ctx.ctx);
  const afterHash = planHash(after.ctx);
  const afterPaths = missionClosurePaths("/project", after.id);
  const originalRemove = after.fs.remove.bind(after.fs);
  after.fs.remove = (p) => {
    if (p === afterPaths.pending) throw new Error("simulated interruption after seal creation");
    originalRemove(p);
  };
  await after.pi.runCommand("handoff", `instance close --confirm ${afterHash} --reason "done"`, after.ctx.ctx);
  assert.equal(inspectMissionClosure(after.fs, "/project", after.id, after.stateDir).state, "uncertain");
  assert.ok(after.fs.files.has(afterPaths.closure));
  assert.ok(after.fs.files.has(afterPaths.pending));
});

test("MC4: closed mission refuses every Handoff mutation after restart and inspection reports external edits", async () => {
  const h = await activeMission("close-immutable");
  await h.pi.runCommand("handoff", "instance close plan", h.ctx.ctx);
  const fingerprint = planHash(h.ctx);
  await h.pi.runCommand("handoff", `instance close --confirm ${fingerprint} --reason "done"`, h.ctx.ctx);
  const before = [...h.fs.files.entries()].sort();
  await h.pi.runCommand("handoff", "checkpoint", h.ctx.ctx);
  await h.pi.runCommand("handoff", "ready", h.ctx.ctx);
  await h.pi.runCommand("handoff", "finalize", h.ctx.ctx);
  await h.pi.runCommand("handoff", "renew stop", h.ctx.ctx);
  await h.pi.runCommand("handoff", "cycle plan", h.ctx.ctx);
  await h.pi.runCommand("handoff", "instance create close-immutable", h.ctx.ctx);
  const finalized = await h.pi.tools.get("handoff_finalize").execute("finalize", {}, undefined, undefined, h.ctx.ctx);
  const renewed = await h.pi.tools.get("handoff_renew").execute("renew", {}, undefined, undefined, h.ctx.ctx);
  assert.equal(finalized.details.ok, false);
  assert.equal(renewed.details.why, "instance-ownership");
  assert.deepEqual([...h.fs.files.entries()].sort(), before, "no closed instance files or state are rewritten");

  const restarted = createMockPi();
  const restartedCtx = createMockCtx({ cwd: "/project", sessionId: "restart-closed" });
  contextGuard(restarted.pi as never, { fs: h.fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: h.id }, processScope: "restart-closed-scope" });
  await restarted.emit({ type: "session_start", reason: "startup" } as never, restartedCtx.ctx as never);
  const report = await restarted.tools.get("handoff_inspect").execute("inspect", { details: true }, undefined, undefined, restartedCtx.ctx);
  assert.equal(report.details.missionLifecycle.state, "closed");
  const restartBefore = [...h.fs.files.entries()].sort();
  await restarted.runCommand("handoff", "checkpoint", restartedCtx.ctx);
  await restarted.runCommand("handoff", "instance status", restartedCtx.ctx);
  assert.deepEqual([...h.fs.files.entries()].sort(), restartBefore, "closed startup acquires no owner lock and persists no state");

  h.fs.writeFile(`/project/${h.paths.files.learnings}`, text.learnings + "external edit\n");
  const changed = inspectMissionClosure(h.fs, "/project", h.id, h.stateDir);
  assert.equal(changed.state, "changed");
  await restarted.runCommand("handoff", "instance status", restartedCtx.ctx);
  assert.match(restartedCtx.notifications.at(-1)!.text, /changed externally|CLOSED/);
  const writeTool = restarted.handlers.get("tool_call")!;
  let blocked: any;
  for (const handler of writeTool) blocked = await handler({ type: "tool_call", toolName: "write", input: { path: `/project/${h.paths.files.learnings}` } }, restartedCtx.ctx);
  assert.equal(blocked.block, true);
});

test("MC5: a fresh mission starts with blank operational structure and no inherited Next action", () => {
  const h = createMemoryFs(DEFAULT_FILES);
  assert.equal(createMissionInstance(h, "/project", "old", null).ok, true);
  const old = missionInstancePaths("old");
  h.writeFile(`/project/${old.files.handoff}`, text.handoff);
  const closure = missionClosurePaths("/project", "old").closure;
  h.createExclusive!(closure, JSON.stringify({ schema: 1 }));
  assert.equal(createMissionInstance(h, "/project", "new", null).ok, true);
  const fresh = missionInstancePaths("new");
  const newHandoff = h.files.get(`/project/${fresh.files.handoff}`)!;
  assert.match(newHandoff, /## Next action\n\n## Discoveries/);
  assert.doesNotMatch(newHandoff, /Finish this mission\./);
  assert.notEqual(fresh.stateDir, old.stateDir);
  assert.equal(h.files.has(`/project/${fresh.files.learnings}`), true);
});

test("MC6: legacy mode remains unsealed and close commands do not create lifecycle files", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", sessionId: "legacy-close" });
  contextGuard(pi.pi as never, { fs, env: {}, processScope: "legacy-close-scope" });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  const before = [...fs.files.entries()].sort();
  await pi.runCommand("handoff", "instance close plan", ctx.ctx);
  assert.deepEqual([...fs.files.entries()].sort(), before);
  assert.match(ctx.notifications.at(-1)!.text, /explicitly selected mission instance/);
  assert.equal(fs.files.has("/project/closure.json"), false);
});
