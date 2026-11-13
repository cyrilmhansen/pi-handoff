import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../.pi/extensions/context-guard/config.ts";
import { configForMissionInstance, createMissionInstance, missionChainId, missionInstancePaths, validMissionInstanceId } from "../.pi/extensions/context-guard/mission-instance.ts";
import contextGuard from "../.pi/extensions/context-guard/index.ts";
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
  const first = createMissionInstance(fs, "/project", "alpha", { id: "compiler", version: "2.1" }, "2026-01-01T00:00:00.000Z");
  assert.equal(first.ok, true);
  assert.deepEqual(first.ok && first.created, ["HANDOFF.md", "PROGRESS.md", "LEARNINGS.md"]);
  const paths = missionInstancePaths("alpha");
  assert.equal(fs.files.has(`/project/${paths.root}/GOAL.md`), false, "GOAL remains project-shared and is not copied");
  assert.equal(fs.files.get(`/project/${paths.files.handoff}`)?.includes("Run the test suite"), false);
  fs.writeFile(`/project/${paths.files.handoff}`, "operator prose\n");
  const again = createMissionInstance(fs, "/project", "alpha", { id: "compiler", version: "2.1" });
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
    contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: id } });
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
  contextGuard(restartPi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: "alpha" } });
  await restartPi.emit({ type: "session_start", reason: "startup" } as never, restartCtx.ctx as never);
  const inspection = await restartPi.tools.get("handoff_inspect").execute("inspect", {}, undefined, undefined, restartCtx.ctx);
  assert.match(inspection.content[0].text, /current/);
  assert.match(inspection.content[0].text, /attested/);
});

test("MI5: invalid selection fails closed instead of falling back to shared files", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project" });
  contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: "../shared" } });
  await pi.emit({ type: "session_start", reason: "startup" } as never, mc.ctx as never);
  await pi.runCommand("handoff", "checkpoint", mc.ctx);
  assert.match(mc.notifications.map((n) => n.text).join("\n"), /mission instance selection refused/);
  assert.equal(fs.files.get("/project/HANDOFF.md"), DEFAULT_FILES["/project/HANDOFF.md"]);
});

test("MI6: operator create/select commands are explicit and do not switch the running session", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const mc = createMockCtx({ cwd: "/project", sessionId: "legacy-session" });
  contextGuard(pi.pi as never, { fs, env: {} });
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
