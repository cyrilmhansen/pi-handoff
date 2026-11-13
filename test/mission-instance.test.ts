import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { loadConfig } from "../.pi/extensions/context-guard/config.ts";
import { configForMissionInstance, createMissionInstance, missionChainId, missionInstancePaths, validMissionInstanceId, workProfilePath } from "../.pi/extensions/context-guard/mission-instance.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { instanceLockPath, type InstanceLockOwner } from "../.pi/extensions/context-guard/mission-lock.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

test("MI1: ids are path-safe and invalid ids are refused", () => {
  for (const id of ["alpha", "research-2", "profile.v1"]) assert.equal(validMissionInstanceId(id), true);
  for (const id of ["", ".", "..", "../other", "a/b", "équipe", "x".repeat(65)]) assert.equal(validMissionInstanceId(id), false);
});

test("MI1b: chain identities are namespaced by instance and retain the legacy form when unset", () => {
  assert.notEqual(missionChainId("alpha", "session-1"), missionChainId("beta", "session-1"));
  assert.equal(missionChainId(null, "session-1"), "chain:session-1");
});

test("MI2: explicit creation makes empty operational documents, never copies project knowledge, and retries without overwriting", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const profile = { id: "compiler", version: "2.1" };
  fs.writeFile(`/project/${workProfilePath(profile)}`, JSON.stringify({ schema: 1, ...profile, instructions: ["Keep exact compiler evidence."], knowledgeRefs: ["docs/evidence.md"] }));
  const first = createMissionInstance(fs, "/project", "alpha", profile, "2026-01-01T00:00:00.000Z");
  assert.equal(first.ok, true);
  assert.deepEqual(first.ok && first.created, ["HANDOFF.md", "PROGRESS.md", "LEARNINGS.md"]);
  const paths = missionInstancePaths("alpha");
  assert.equal(fs.files.has(`/project/${paths.root}/GOAL.md`), false, "GOAL remains project-shared and is not copied");
  assert.equal(fs.files.get(`/project/${paths.files.handoff}`)?.includes("Run the test suite"), false);
  fs.writeFile(`/project/${paths.files.handoff}`, "operator prose\n");
  const again = createMissionInstance(fs, "/project", "alpha", profile);
  assert.equal(again.ok, true);
  assert.equal(fs.files.get(`/project/${paths.files.handoff}`), "operator prose\n");
  assert.equal(createMissionInstance(fs, "/project", "alpha", null).ok, false, "identity collision cannot silently change profile");
});

test("MI2b: symlinked instance storage outside the project is refused", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  fs.realPaths.set("/project/.pi-handoff/instances/escape", "/outside/escape");
  const result = createMissionInstance(fs, "/project", "escape", null);
  assert.equal(result.ok, false);
  assert.match(result.error, /outside the project/);
  assert.equal(fs.files.has("/outside/escape/mission.json"), false);
});

test("MI2c: missing instance beneath a symlinked parent is still refused", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  fs.realPaths.set("/project/.pi-handoff", "/outside/.pi-handoff");
  const result = createMissionInstance(fs, "/project", "not-created-yet", null);
  assert.equal(result.ok, false);
  assert.match(result.error, /outside the project/);
});

test("MI3: absent selection preserves legacy layout; explicit environment selection is per process", () => {
  const legacy = loadConfig((name) => name === "handoff.config.json" ? "{}" : undefined, {});
  assert.equal(configForMissionInstance(legacy).files.handoff, "HANDOFF.md");
  assert.equal(configForMissionInstance(legacy).stateDir, ".pi-guard");
  const selected = loadConfig((name) => name === "handoff.config.json" ? "{}" : undefined, { CONTEXT_GUARD_MISSION_INSTANCE: "beta" });
  const effective = configForMissionInstance(selected);
  assert.equal(effective.files.handoff, ".pi-handoff/instances/beta/HANDOFF.md");
  assert.equal(effective.files.goal, "GOAL.md");
  assert.equal(effective.stateDir, ".pi-guard/instances/beta");
});

test("MI4: same project keeps checkpoint, attestation, and renewal stop state isolated by mission instance", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const instances = ["alpha", "beta"];
  const harnesses = instances.map((id) => {
    assert.equal(createMissionInstance(fs, "/project", id, null).ok, true);
    const paths = missionInstancePaths(id);
    for (const name of ["HANDOFF.md", "PROGRESS.md", "LEARNINGS.md"]) {
      const rootName = name === "HANDOFF.md" ? "HANDOFF.md" : name === "PROGRESS.md" ? "PROGRESS.md" : "LEARNINGS.md";
      fs.writeFile(`/project/${paths.root}/${name}`, DEFAULT_FILES[`/project/${rootName}`]);
    }
    const pi = createMockPi();
    const mc = createMockCtx({ cwd: "/project", sessionId: `session-${id}` });
    contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: id }, processScope: `process-${id}` });
    return { id, paths, pi, mc };
  });
  await Promise.all(harnesses.map((h) => h.pi.emit({ type: "session_start", reason: "startup" } as never, h.mc.ctx as never)));
  await Promise.all(harnesses.map(async (h) => {
    await h.pi.runCommand("handoff", "checkpoint", h.mc.ctx);
    await h.pi.runCommand("handoff", "ready", h.mc.ctx);
    await h.pi.runCommand("handoff", "renew stop", h.mc.ctx);
  }));
  const [a, b] = harnesses;
  await b.pi.runCommand("handoff", "renew resume", b.mc.ctx);
  for (const h of harnesses) {
    const checkpoint = fs.files.get(`/project/${h.paths.files.handoff}`)!;
    assert.match(checkpoint, /guard:begin checkpoint/);
    assert.match(checkpoint, /attested/);
    assert.ok(fs.files.has(`/project/${h.paths.stateDir}/renewal-state.json`));
  }
  const handoffA = fs.files.get(`/project/${a.paths.files.handoff}`)!;
  const handoffB = fs.files.get(`/project/${b.paths.files.handoff}`)!;
  const checkpointIdA = handoffA.match(/checkpoint-id:\s*([^\s<]+)/)?.[1];
  const checkpointIdB = handoffB.match(/checkpoint-id:\s*([^\s<]+)/)?.[1];
  assert.ok(checkpointIdA && checkpointIdB, JSON.stringify({ handoffA, handoffB, keys: [...fs.files.keys()].filter((k) => k.includes("instances")), notes: harnesses.map((h) => h.mc.notifications) }));
  assert.notEqual(checkpointIdA, checkpointIdB, `${a.id}=${checkpointIdA}; ${b.id}=${checkpointIdB}`);
  const chainA = JSON.parse(fs.files.get(`/project/${a.paths.stateDir}/renewal-state.json`)!);
  const chainB = JSON.parse(fs.files.get(`/project/${b.paths.stateDir}/renewal-state.json`)!);
  assert.equal(chainA.stopped, true);
  assert.equal(chainB.stopped, false, "resuming one instance does not clear the other instance's durable stop");
  assert.equal(fs.files.get("/project/HANDOFF.md"), DEFAULT_FILES["/project/HANDOFF.md"], "legacy shared operational document stays untouched");

  const restartPi = createMockPi();
  const restartCtx = createMockCtx({ cwd: "/project", sessionId: "restart-alpha" });
  contextGuard(restartPi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: "alpha" }, processScope: "restart-alpha" });
  await restartPi.emit({ type: "session_start", reason: "startup" } as never, restartCtx.ctx as never);
  const inspection = await restartPi.tools.get("handoff_inspect").execute("inspect", {}, undefined, undefined, restartCtx.ctx);
  assert.match(inspection.content[0].text, /current/);
  assert.match(inspection.content[0].text, /attested/);
});

test("MI5: invalid selection fails closed instead of falling back to shared files", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project" });
  contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: "../shared" }, processScope: "invalid-selection" });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  await pi.runCommand("handoff", "checkpoint", mc.ctx);
  assert.match(mc.notifications.map((n) => n.text).join("\n"), /mission instance selection refused/);
  assert.equal(fs.files.get("/project/HANDOFF.md"), DEFAULT_FILES["/project/HANDOFF.md"]);
});

test("MI6: operator create/select commands are explicit and do not switch the running session", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "legacy-session" });
  const profilePath = "/project/.pi-handoff/work-profiles/research/1.0.json";
  fs.writeFile(profilePath, JSON.stringify({ schema: 1, id: "research", version: "1.0", instructions: ["Record negative results."], knowledgeRefs: ["PROTOCOL.md#4"] }));
  contextGuard(pi.pi as never, { fs, env: {}, processScope: "legacy-create" });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  await pi.runCommand("handoff", "instance create beta --profile research@1.0", mc.ctx);
  const manifest = JSON.parse(fs.files.get("/project/.pi-handoff/instances/beta/mission.json")!);
  assert.deepEqual(manifest.workProfile, { id: "research", version: "1.0" });
  await pi.runCommand("handoff", "instance select beta", mc.ctx);
  assert.match(mc.notifications.at(-1)!.text, /takes effect only at session start/);
  await pi.runCommand("handoff", "instance status", mc.ctx);
  assert.match(mc.notifications.at(-1)!.text, /legacy project mode/);
  assert.equal(fs.files.get("/project/HANDOFF.md"), DEFAULT_FILES["/project/HANDOFF.md"]);
});

test("MI7: losing instance ownership blocks every Handoff mutation path and managed Pi writes", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  assert.equal(createMissionInstance(fs, "/project", "contended", null).ok, true);
  const lockPath = instanceLockPath("/project", "contended");
  const owner: InstanceLockOwner = {
    schema: 1,
    token: "other-process-token",
    pid: process.pid,
    hostname: os.hostname(),
    platform: process.platform,
    sessionId: "other-session",
    startedAt: new Date().toISOString(),
  };
  fs.writeFile(lockPath, JSON.stringify(owner));
  fs.writes.length = 0;

  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "loser-session" });
  contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: "contended" }, processScope: "contended-loser" });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  const before = JSON.stringify([...fs.files.entries()].sort());
  for (const command of ["checkpoint", "ready", "finalize", "renew", "renew stop", "renew resume", "cycle plan", "cycle recover x"]) {
    await pi.runCommand("handoff", command, mc.ctx);
  }
  const finalize = await pi.tools.get("handoff_finalize").execute("finalize", {}, undefined, undefined, mc.ctx);
  const renew = await pi.tools.get("handoff_renew").execute("renew", {}, undefined, undefined, mc.ctx);
  assert.equal(finalize.details.ok, false);
  assert.equal(renew.details.why, "instance-ownership");
  assert.equal((await pi.tools.get("handoff_inspect").execute("inspect", {}, undefined, undefined, mc.ctx)).content.length, 1, "read-only inspection remains available");
  const toolHandlers = pi.handlers.get("tool_call")!;
  let blockedWrite: any;
  for (const handler of toolHandlers) blockedWrite = await handler({ type: "tool_call", toolName: "write", input: { path: "/project/.pi-handoff/instances/contended/HANDOFF.md" } }, mc.ctx);
  let blockedBash: any;
  for (const handler of toolHandlers) blockedBash = await handler({ type: "tool_call", toolName: "bash", input: { command: "echo unsafe" } }, mc.ctx);
  assert.equal(blockedWrite?.block, true);
  assert.equal(blockedBash?.block, true);
  assert.equal(JSON.stringify([...fs.files.entries()].sort()), before, "no checkpoint, attestation, renewal, cycle, diagnostics, or session-state write occurred");
  assert.equal(fs.writes.length, 0);
});

test("MI8: session shutdown does not release ownership before same-process successor startup", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  assert.equal(createMissionInstance(fs, "/project", "continuous", null).ok, true);
  const env = { CONTEXT_GUARD_MISSION_INSTANCE: "continuous" };
  const firstPi = createMockPi();
  const firstCtx = createMockCtx({ cwd: "/project", sessionId: "predecessor" });
  contextGuard(firstPi.pi as never, { fs, env, processScope: "continuous-process" });
  await firstPi.emit({ type: "session_start", reason: "startup" } as never, firstCtx.ctx as never);
  const lockPath = instanceLockPath("/project", "continuous");
  const lockBytes = fs.files.get(lockPath);
  assert.ok(lockBytes);
  await firstPi.emit({ type: "session_shutdown", reason: "new" } as never, firstCtx.ctx as never);
  assert.equal(fs.files.get(lockPath), lockBytes, "session-level shutdown preserves process-level ownership");

  const successorPi = createMockPi();
  const successorCtx = createMockCtx({ cwd: "/project", sessionId: "successor" });
  contextGuard(successorPi.pi as never, { fs, env, processScope: "continuous-process" });
  await successorPi.emit({ type: "session_start", reason: "new" } as never, successorCtx.ctx as never);
  await successorPi.runCommand("handoff", "checkpoint", successorCtx.ctx);
  assert.match(successorCtx.notifications.map((n) => n.text).join("\n"), /mission instance: continuous/);
  assert.equal(fs.files.get(lockPath), lockBytes, "successor process context reuses the exact same process owner token");
});
