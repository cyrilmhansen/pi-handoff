import test from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLocalFs } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMissionInstance, missionInstancePaths } from "../.pi/extensions/context-guard/mission-instance.ts";
import { knowledgeRegistryLockPath, readKnowledgeRegistry } from "../.pi/extensions/context-guard/knowledge.ts";
import { recoverAbandonedInstanceLock } from "../.pi/extensions/context-guard/mission-lock.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("KP1: two real Pi-extension processes serialize publications for the same identity from separate missions", { timeout: 20_000 }, async () => {
  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-knowledge-concurrency-"));
  try {
    const project = path.join(temp, "project");
    fsDefault.mkdirSync(project, { recursive: true });
    for (const id of ["source-a", "source-b"]) {
      const local = createLocalFs();
      assert.equal(createMissionInstance(local, project, id, null).ok, true);
      const missionFiles = missionInstancePaths(id).files;
      const learning = `# LEARNINGS\n\n## Accepted\n\n- [race-${id}] source proposition ${id}.\n\n## Proposed\n\n## Falsified or superseded\n\n`;
      fsDefault.writeFileSync(path.join(project, missionFiles.learnings), learning);
      const evidenceRel = `proofs/${id}.txt`;
      fsDefault.mkdirSync(path.join(project, "proofs"), { recursive: true });
      const evidence = `proof bytes for ${id}\n`;
      fsDefault.writeFileSync(path.join(project, evidenceRel), evidence);
      const proposal = {
        schema: 1,
        id: "same-logical-observation",
        missionId: id,
        classification: "proposed",
        statement: `Observation proposed by ${id}.`,
        rationale: "Two source missions are racing for one project-wide identity.",
        source: { path: missionFiles.learnings, locator: `race-${id}`, sha256: createHash("sha256").update(learning).digest("hex") },
        evidence: [{ path: evidenceRel, sha256: createHash("sha256").update(evidence).digest("hex"), description: `proof from ${id}` }],
      };
      const proposalDir = path.join(project, ".pi-handoff", "knowledge", "proposals");
      fsDefault.mkdirSync(proposalDir, { recursive: true });
      fsDefault.writeFileSync(path.join(proposalDir, `${id}.json`), JSON.stringify(proposal, null, 2) + "\n");
    }

    const childSource = `
      import path from "node:path";
      import { createLocalFs } from ${JSON.stringify(pathToFileURL(path.join(REPO, ".pi/extensions/context-guard/checkpoint.ts")).href)};
      import { acquireInstanceLock, releaseInstanceLock, instanceLockPath } from ${JSON.stringify(pathToFileURL(path.join(REPO, ".pi/extensions/context-guard/mission-lock.ts")).href)};
      import { planKnowledgePublication, makeKnowledgeRecord, knowledgeRecordPath, knowledgeRegistryLockPath } from ${JSON.stringify(pathToFileURL(path.join(REPO, ".pi/extensions/context-guard/knowledge.ts")).href)};
      const fs = createLocalFs();
      const cwd = process.env.KNOWLEDGE_TEST_PROJECT;
      const missionId = process.env.KNOWLEDGE_TEST_MISSION;
      const sessionId = "child-" + missionId;
      const missionLockPath = instanceLockPath(cwd, missionId);
      const missionLock = acquireInstanceLock(fs, missionLockPath, sessionId);
      if (!missionLock.ok) throw new Error("mission lock failed: " + missionLock.detail);
      const options = { fs, cwd, selectedMissionId: missionId, stateDir: path.resolve(cwd, ".pi-guard/instances", missionId), checkpoint: { kind: "missing", detail: "race fixture" }, ownsMission: true, proposalName: missionId };
      const planned = planKnowledgePublication(options);
      if (planned.blockers.length) throw new Error("initial plan blocked: " + planned.blockers.join("; "));
      console.log("READY " + planned.publicationFingerprint);
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("data", resolve));
      const registryLockPath = knowledgeRegistryLockPath(cwd, fs);
      const registryLock = acquireInstanceLock(fs, registryLockPath, sessionId);
      if (!registryLock.ok) {
        console.log("LOCK_REFUSED " + registryLock.inspection.state);
        releaseInstanceLock(fs, missionLockPath);
        process.exit(0);
      }
      try {
        const current = planKnowledgePublication({ ...options, ownsRegistryLock: true });
        if (current.publicationFingerprint !== planned.publicationFingerprint || current.blockers.length) {
          console.log("STALE " + current.blockers.join("; "));
        } else {
          const record = makeKnowledgeRecord(current, sessionId);
          const target = knowledgeRecordPath(cwd, record.knowledgeId, record.publicationId, fs);
          const ok = fs.createExclusiveAtomic(target, JSON.stringify(record, null, 2) + "\\n");
          console.log(ok ? "PUBLISHED " + record.publicationId : "TARGET_EXISTS");
        }
      } finally {
        releaseInstanceLock(fs, registryLockPath);
        releaseInstanceLock(fs, missionLockPath);
      }
    `;

    const children: Array<{ child: ReturnType<typeof spawn>; lines: string[]; exit: Promise<unknown>; waitLine(prefix: string): Promise<string>; waitOutcome(): Promise<string> }> = [];
    for (const missionId of ["source-a", "source-b"]) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
        cwd: project,
        env: { ...process.env, KNOWLEDGE_TEST_PROJECT: project, KNOWLEDGE_TEST_MISSION: missionId },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines: string[] = [];
      const exit = once(child, "exit");
      let buffer = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf("\n");
          if (at < 0) break;
          lines.push(buffer.slice(0, at).trim());
          buffer = buffer.slice(at + 1);
        }
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      children.push({
        child,
        lines,
        exit,
        waitLine: async (prefix) => {
          const until = Date.now() + 10_000;
          while (Date.now() < until) {
            const found = lines.find((line) => line.startsWith(prefix));
            if (found) return found;
            if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}: ${stderr}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`timeout waiting ${prefix}; stderr: ${stderr}`);
        },
        waitOutcome: async () => {
          const until = Date.now() + 10_000;
          while (Date.now() < until) {
            const found = lines.find((line) => /^(PUBLISHED |LOCK_REFUSED |STALE |TARGET_EXISTS)/.test(line));
            if (found) return found;
            if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}: ${stderr}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`timeout waiting for publication result; stderr: ${stderr}`);
        },
      });
    }
    try {
      const ready = await Promise.all(children.map((c) => c.waitLine("READY ")));
      assert.equal(ready.length, 2, "both missions planned the same empty registry before the release barrier");
      for (const c of children) c.child.stdin.end("go\n");
      const outcomes = await Promise.all(children.map((c) => c.waitOutcome()));
      await Promise.all(children.map((c) => c.exit));
      assert.equal(outcomes.filter((line) => line.startsWith("PUBLISHED ")).length, 1, outcomes.join("\n"));
      assert.equal(outcomes.filter((line) => line.startsWith("LOCK_REFUSED ") || line.startsWith("STALE ")).length, 1, outcomes.join("\n"));
      const registry = readKnowledgeRegistry(createLocalFs(), project);
      assert.equal(registry.errors.length, 0, registry.errors.join("; "));
      assert.equal(registry.records.length, 1, "one process owns the global publication transaction and identity");
      assert.ok(["source-a", "source-b"].includes(registry.records[0].sourceMissionId));
    } finally {
      for (const c of children) if (c.child.exitCode === null) c.child.kill("SIGKILL");
    }
  } finally {
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});

test("KP2: an interrupted registry owner is recovered only after its real process is gone", { timeout: 10_000 }, async () => {
  const temp = fsDefault.mkdtempSync(path.join(os.tmpdir(), "atlas-knowledge-recovery-"));
  try {
    const project = path.join(temp, "project");
    fsDefault.mkdirSync(project, { recursive: true });
    const lockPath = knowledgeRegistryLockPath(project);
    const childSource = `
      import { createLocalFs } from ${JSON.stringify(pathToFileURL(path.join(REPO, ".pi/extensions/context-guard/checkpoint.ts")).href)};
      import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(path.join(REPO, ".pi/extensions/context-guard/mission-lock.ts")).href)};
      const fs = createLocalFs();
      const result = acquireInstanceLock(fs, process.env.KNOWLEDGE_TEST_LOCK, "abandoned-publisher");
      if (!result.ok) throw new Error(result.detail);
      console.log("LOCK_HELD");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("data", resolve));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: project, env: { ...process.env, KNOWLEDGE_TEST_LOCK: lockPath }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const deadline = Date.now() + 5_000;
    while (!stdout.includes("LOCK_HELD") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(stdout, /LOCK_HELD/, stderr);
    const pid = child.pid;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(fsDefault.existsSync(lockPath), true, "crash leaves the global owner lock in place");
    const recovered = recoverAbandonedInstanceLock(createLocalFs(), lockPath, "operator-recovery");
    assert.equal(recovered.ok, true, recovered.detail);
    assert.equal(fsDefault.existsSync(lockPath), false);
    assert.equal(recovered.inspection.owner?.pid, pid);
    assert.equal(readKnowledgeRegistry(createLocalFs(), project).records.length, 0, "recovery never replays a publication");
  } finally {
    fsDefault.rmSync(temp, { recursive: true, force: true });
  }
});
