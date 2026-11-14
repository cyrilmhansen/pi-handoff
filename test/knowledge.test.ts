import test from "node:test";
import assert from "node:assert/strict";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { sha256, writeCheckpoint, attestHandoff, validateCheckpoint } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMissionInstance, missionInstancePaths } from "../.pi/extensions/context-guard/mission-instance.ts";
import { knowledgeRecordPath, makeKnowledgeRecord, planKnowledgePublication, readKnowledgeRegistry, verifyKnowledge } from "../.pi/extensions/context-guard/knowledge.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

const evidencePath = "docs/results.md";
const evidenceText = "Run 17 returned the expected byte-exact result.\n";
const learnings = (id: string) => `# LEARNINGS\n\n## Accepted\n\n- [${id}] Durable result recorded with its source and evidence.\n\n## Proposed\n\n## Falsified or superseded\n\n`;

async function setupMission(id: string, withCheckpoint = false, sharedFs = createMemoryFs(DEFAULT_FILES)) {
  const fs = sharedFs;
  assert.equal(createMissionInstance(fs, "/project", id, null).ok, true);
  const files = missionInstancePaths(id).files;
  fs.writeFile(`/project/${files.handoff}`, "# HANDOFF\n\n## Recovery instructions\nRead durable files.\n\n## Last verified state\nEvidence recorded.\n\n## Unfinished operations\nNone.\n\n## Next action\nContinue this mission.\n\n## Discoveries not yet incorporated\nNone.\n");
  fs.writeFile(`/project/${files.progress}`, "# PROGRESS\n\n## Current phase\nWork.\n\n## Completed\n- Evidence recorded.\n\n## Pending\nNone.\n\n## Verified evidence\n- Output saved.\n\n## Blockers\nNone.\n\n## Next action\nContinue this mission.\n");
  fs.writeFile(`/project/${files.learnings}`, learnings(`K-${id}`));
  fs.writeFile(`/project/${evidencePath}`, evidenceText);
  if (withCheckpoint) {
    const cp = writeCheckpoint(fs, {
      cwd: "/project", files, level: 1, sessionId: `setup-${id}`, remaining: 1000,
      goalDrift: false, lastVerifiedState: "scientific result referenced", unfinishedOperations: [],
      nextAction: "Continue this mission.", recoveryInstructions: ["Read the durable files."], kind: "manual",
    });
    assert.equal(cp.ok, true, cp.errors.join("; "));
    assert.equal(attestHandoff(fs, "/project", files, { sessionId: `setup-${id}` }).ok, true);
    assert.equal(validateCheckpoint(fs, "/project", files).kind, "current");
  }
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", sessionId: `knowledge-${id}` });
  contextGuard(pi.pi as never, { fs, env: { CONTEXT_GUARD_MISSION_INSTANCE: id }, processScope: `knowledge-${id}` });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  return { fs, files, pi, ctx, id };
}

function setProposal(h: Awaited<ReturnType<typeof setupMission>>, options: {
  name?: string; id?: string; missionId?: string; classification?: string; statement?: string; rationale?: string;
  sourceText?: string; evidenceText?: string; sourcePath?: string; evidencePath?: string;
  supersedes?: { publicationId: string; reason: string };
} = {}): string {
  const sourcePath = options.sourcePath ?? h.files.learnings;
  const evidence = options.evidenceText ?? evidenceText;
  const evidenceRel = options.evidencePath ?? evidencePath;
  if (options.sourceText !== undefined) h.fs.writeFile(`/project/${sourcePath}`, options.sourceText);
  h.fs.writeFile(`/project/${evidenceRel}`, evidence);
  const proposal = {
    schema: 1,
    id: options.id ?? "result-observation",
    missionId: options.missionId ?? h.id,
    classification: options.classification ?? "accepted",
    statement: options.statement ?? "The recorded run produced the expected exact output.",
    rationale: options.rationale ?? "The claim is limited to the linked run and its saved output.",
    source: { path: sourcePath, locator: `K-${h.id}`, sha256: sha256(options.sourceText ?? h.fs.files.get(`/project/${sourcePath}`)!) },
    evidence: [{ path: evidenceRel, sha256: sha256(evidence), description: "saved output for the referenced run" }],
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  };
  const proposalName = options.name ?? "proposal";
  h.fs.writeFile(`/project/.pi-handoff/knowledge/proposals/${proposalName}.json`, JSON.stringify(proposal, null, 2) + "\n");
  return proposalName;
}

async function plan(h: Awaited<ReturnType<typeof setupMission>>, name: string): Promise<{ text: string; fingerprint?: string }> {
  const start = h.ctx.notifications.length;
  await h.pi.runCommand("handoff", `knowledge plan ${name}`, h.ctx.ctx);
  const text = h.ctx.notifications.slice(start).map((item) => item.text).join("\n");
  const fingerprint = /approval fingerprint: ([a-f0-9]{64})/.exec(text)?.[1];
  return { text, fingerprint };
}

test("KI1: read-only plan and operator approval publish one immutable, verifiable record", async () => {
  const h = await setupMission("knowledge-a");
  const name = setProposal(h);
  const before = [...h.fs.files.entries()].sort();
  const p = await plan(h, name);
  assert.ok(p.fingerprint, p.text);
  assert.deepEqual([...h.fs.files.entries()].sort(), before, "planning is read-only");
  assert.match(p.text, /classification: accepted/);
  assert.match(p.text, /source: .*LEARNINGS\.md#K-knowledge-a/);
  await h.pi.runCommand("handoff", `knowledge publish ${name} --confirm ${p.fingerprint}`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /published immutably.*references verified/);
  const registry = readKnowledgeRegistry(h.fs, "/project");
  assert.equal(registry.errors.length, 0, registry.errors.join("; "));
  assert.equal(registry.records.length, 1);
  assert.equal(registry.records[0].decision.actor, "operator");
  assert.equal(registry.records[0].sourceMissionId, h.id);
  assert.equal(registry.records[0].evidence[0].sha256, sha256(evidenceText));
  assert.equal(verifyKnowledge(h.fs, "/project", "result-observation").ok, true);
});

test("KI2: stale source/evidence plans are refused without publication", async () => {
  const h = await setupMission("knowledge-stale");
  const name = setProposal(h);
  const p = await plan(h, name);
  assert.ok(p.fingerprint);
  h.fs.writeFile(`/project/${evidencePath}`, "changed output\n");
  await h.pi.runCommand("handoff", `knowledge publish ${name} --confirm ${p.fingerprint}`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /stale|evidence hash changed/);
  assert.equal(readKnowledgeRegistry(h.fs, "/project").records.length, 0);

  setProposal(h, { name: "source", sourceText: learnings(`K-${h.id}`) + "\nlate edit\n" });
  const sourcePlan = await plan(h, "source");
  assert.ok(sourcePlan.fingerprint);
  h.fs.writeFile(`/project/${h.files.learnings}`, learnings(`K-${h.id}`) + "\nnew source edit\n");
  await h.pi.runCommand("handoff", `knowledge publish source --confirm ${sourcePlan.fingerprint}`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /stale|mission source hash changed/);
  assert.equal(readKnowledgeRegistry(h.fs, "/project").records.length, 0);
});

test("KI3: identical retry is idempotent; a changed use of the logical id needs explicit supersession", async () => {
  const a = await setupMission("knowledge-origin-a");
  const same = setProposal(a, { name: "first" });
  const p1 = await plan(a, same);
  assert.ok(p1.fingerprint);
  await a.pi.runCommand("handoff", `knowledge publish ${same} --confirm ${p1.fingerprint}`, a.ctx.ctx);
  const first = readKnowledgeRegistry(a.fs, "/project").records[0];

  const repeat = await plan(a, same);
  assert.ok(repeat.fingerprint);
  assert.match(repeat.text, /identical publication already exists/);
  const writes = a.fs.writes.length;
  await a.pi.runCommand("handoff", `knowledge publish ${same} --confirm ${repeat.fingerprint}`, a.ctx.ctx);
  assert.match(a.ctx.notifications.at(-1)!.text, /already exists; no registry file was written/);
  assert.equal(a.fs.writes.length, writes);
  assert.equal(readKnowledgeRegistry(a.fs, "/project").records.length, 1);

  const b = await setupMission("knowledge-origin-b", false, a.fs);
  const conflict = setProposal(b, { name: "conflict", id: "result-observation", statement: "A different observation under the same logical id." });
  const conflictPlan = await plan(b, conflict);
  assert.match(conflictPlan.text, /already exists; a changed statement requires explicit supersession/);
  assert.equal(conflictPlan.fingerprint, undefined, "conflicts do not yield an approvable plan");
  const superseding = setProposal(b, {
    name: "revision", id: "result-observation", classification: "falsified",
    statement: "The earlier generalization did not hold in the later controlled run.",
    rationale: "A new independent run falsified the broader claim while preserving the original observation.",
    supersedes: { publicationId: first.publicationId, reason: "new controlled evidence falsified the broader wording" },
  });
  const p2 = await plan(b, superseding);
  assert.ok(p2.fingerprint, p2.text);
  await b.pi.runCommand("handoff", `knowledge publish ${superseding} --confirm ${p2.fingerprint}`, b.ctx.ctx);
  const rows = (await import("../.pi/extensions/context-guard/knowledge.ts")).listKnowledge(a.fs, "/project", { id: "result-observation" });
  assert.equal(rows.items.length, 2);
  assert.equal(rows.items.find((x) => x.record.publicationId === first.publicationId)?.state, "superseded");
  assert.equal(rows.items.find((x) => x.record.publicationId !== first.publicationId)?.record.classification, "falsified");
});

test("KI4: closed missions can publish their verified provenance without changing sealed bytes", async () => {
  const h = await setupMission("knowledge-closed", true);
  await h.pi.runCommand("handoff", "instance close plan", h.ctx.ctx);
  const closeText = h.ctx.notifications.at(-1)!.text;
  const closeFp = /approval fingerprint: ([a-f0-9]{64})/.exec(closeText)?.[1];
  assert.ok(closeFp, closeText);
  await h.pi.runCommand("handoff", `instance close --confirm ${closeFp} --reason "research phase concluded"`, h.ctx.ctx);
  const sealedBefore = [...h.fs.files.entries()].filter(([key]) => key.startsWith(`/project/.pi-handoff/instances/${h.id}/`) || key.startsWith(`/project/.pi-guard/instances/${h.id}/`)).sort();
  const name = setProposal(h, { name: "closed-source" });
  const p = await plan(h, name);
  assert.ok(p.fingerprint, p.text);
  assert.match(p.text, /sealed close:/);
  await h.pi.runCommand("handoff", `knowledge publish ${name} --confirm ${p.fingerprint}`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /published immutably/);
  const sealedAfter = [...h.fs.files.entries()].filter(([key]) => key.startsWith(`/project/.pi-handoff/instances/${h.id}/`) || key.startsWith(`/project/.pi-guard/instances/${h.id}/`)).sort();
  assert.deepEqual(sealedAfter, sealedBefore, "publication changes only the common registry");
  assert.ok(readKnowledgeRegistry(h.fs, "/project").records[0].sourceClosure);
});

test("KI5: a different mission can consult the registry without importing its Next action", async () => {
  const owner = await setupMission("knowledge-owner");
  const name = setProposal(owner);
  const p = await plan(owner, name);
  await owner.pi.runCommand("handoff", `knowledge publish ${name} --confirm ${p.fingerprint}`, owner.ctx.ctx);
  const reader = await setupMission("knowledge-reader", false, owner.fs);
  const docsBefore = [reader.files.handoff, reader.files.progress, reader.files.learnings].map((file) => reader.fs.files.get(`/project/${file}`));
  const before = [...reader.fs.files.entries()].sort();
  const tool = reader.pi.tools.get("handoff_knowledge");
  assert.ok(tool);
  const result = await tool.execute("read", { action: "list", classification: "accepted" }, undefined, undefined, reader.ctx.ctx);
  assert.match(result.content[0].text, /result-observation current \[accepted\]/);
  assert.match(result.content[0].text, /source=\.pi-handoff\/instances\/knowledge-owner\/LEARNINGS\.md/);
  assert.deepEqual([reader.files.handoff, reader.files.progress, reader.files.learnings].map((file) => reader.fs.files.get(`/project/${file}`)), docsBefore);
  assert.deepEqual([...reader.fs.files.entries()].sort(), before, "consultation writes no registry or mission state");
  assert.doesNotMatch(result.content[0].text, /Continue this mission\./);
});

test("KI6: path traversal, symlinks, oversized proposals and corrupt records fail closed", async () => {
  const h = await setupMission("knowledge-danger");
  const traversal = setProposal(h, { name: "traversal", evidencePath: "../../outside" });
  const badPath = await plan(h, traversal);
  assert.match(badPath.text, /unsafe project-relative path/);
  assert.equal(badPath.fingerprint, undefined);
  const symlink = setProposal(h, { name: "symlink" });
  h.fs.realPaths.set(`/project/${evidencePath}`, "/outside/results.md");
  const badLink = await plan(h, symlink);
  assert.match(badLink.text, /symbolic-link path refused/);
  assert.equal(badLink.fingerprint, undefined);
  h.fs.realPaths.delete(`/project/${evidencePath}`);

  const oversized = "x".repeat(128 * 1024 + 1);
  h.fs.writeFile("/project/.pi-handoff/knowledge/proposals/huge.json", oversized);
  const huge = await plan(h, "huge");
  assert.match(huge.text, /128-byte limit|131072-byte limit/);
  assert.equal(huge.fingerprint, undefined);

  h.fs.writeFile(`/project/.pi-handoff/knowledge/records/broken/${"a".repeat(64)}.json`, "{broken");
  const blocked = await plan(h, symlink);
  assert.match(blocked.text, /registry record is corrupt/);
  assert.equal(blocked.fingerprint, undefined);
});

test("KI7: a registry change after planning invalidates the exact approval", async () => {
  const h = await setupMission("knowledge-interrupt");
  const first = setProposal(h, { name: "first" });
  const planned = await plan(h, first);
  assert.ok(planned.fingerprint);
  const other = setProposal(h, { name: "other", id: "unrelated-observation" });
  const direct = planKnowledgePublication({
    fs: h.fs, cwd: "/project", selectedMissionId: h.id, stateDir: `/project/.pi-guard/instances/${h.id}`,
    checkpoint: validateCheckpoint(h.fs, "/project", h.files), ownsMission: true, proposalName: other,
  });
  assert.equal(direct.blockers.length, 0, direct.blockers.join("; "));
  const record = makeKnowledgeRecord(direct, "another-operator-process");
  const path = knowledgeRecordPath("/project", record.knowledgeId, record.publicationId, h.fs);
  assert.equal(h.fs.createExclusiveAtomic!(path, JSON.stringify(record, null, 2) + "\n"), true);
  await h.pi.runCommand("handoff", `knowledge publish ${first} --confirm ${planned.fingerprint}`, h.ctx.ctx);
  assert.match(h.ctx.notifications.at(-1)!.text, /approval is stale/);
  assert.equal(readKnowledgeRegistry(h.fs, "/project").records.length, 1, "only the competing immutable record exists");
});

test("KI8: interrupted atomic publication preserves the complete record and a retry is idempotent", async () => {
  const before = await setupMission("knowledge-before-interrupt");
  const beforeName = setProposal(before, { name: "before" });
  const beforePlan = await plan(before, beforeName);
  const atomic = before.fs.createExclusiveAtomic!.bind(before.fs);
  before.fs.createExclusiveAtomic = (p, bytes) => {
    if (p.includes("/knowledge/records/")) throw new Error("simulated stop before atomic publication");
    return atomic(p, bytes);
  };
  await before.pi.runCommand("handoff", `knowledge publish ${beforeName} --confirm ${beforePlan.fingerprint}`, before.ctx.ctx);
  assert.match(before.ctx.notifications.at(-1)!.text, /outcome is uncertain/);
  assert.equal(readKnowledgeRegistry(before.fs, "/project").records.length, 0);
  before.fs.createExclusiveAtomic = atomic;
  const retryPlan = await plan(before, beforeName);
  assert.equal(retryPlan.fingerprint, beforePlan.fingerprint, "no registry bytes changed before publication");
  await before.pi.runCommand("handoff", `knowledge publish ${beforeName} --confirm ${retryPlan.fingerprint}`, before.ctx.ctx);
  assert.match(before.ctx.notifications.at(-1)!.text, /published immutably/);

  const after = await setupMission("knowledge-after-interrupt");
  const afterName = setProposal(after, { name: "after" });
  const afterPlan = await plan(after, afterName);
  const realAtomic = after.fs.createExclusiveAtomic!.bind(after.fs);
  let target = "";
  after.fs.createExclusiveAtomic = (p, bytes) => { target = p; return realAtomic(p, bytes); };
  const realRead = after.fs.readFile.bind(after.fs);
  let hidePublishedRead = true;
  after.fs.readFile = (p) => {
    if (p === target && hidePublishedRead) { hidePublishedRead = false; return undefined; }
    return realRead(p);
  };
  await after.pi.runCommand("handoff", `knowledge publish ${afterName} --confirm ${afterPlan.fingerprint}`, after.ctx.ctx);
  assert.match(after.ctx.notifications.at(-1)!.text, /verification is uncertain/);
  assert.equal(readKnowledgeRegistry(after.fs, "/project").records.length, 1, "post-publication interruption leaves a complete record");
  after.fs.readFile = realRead;
  const recoveredPlan = await plan(after, afterName);
  assert.match(recoveredPlan.text, /identical publication already exists/);
  const writes = after.fs.writes.length;
  await after.pi.runCommand("handoff", `knowledge publish ${afterName} --confirm ${recoveredPlan.fingerprint}`, after.ctx.ctx);
  assert.match(after.ctx.notifications.at(-1)!.text, /already exists; no registry file was written/);
  assert.equal(after.fs.writes.length, writes);
});

test("KI9: an explicit read-only tool exposes only list/show/verify and legacy mode cannot publish", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const pi = createMockPi();
  const ctx = createMockCtx({ cwd: "/project", sessionId: "knowledge-legacy" });
  contextGuard(pi.pi as never, { fs, env: {}, processScope: "knowledge-legacy" });
  await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
  const tool = pi.tools.get("handoff_knowledge");
  const result = await tool.execute("bad", { action: "publish", id: "x" }, undefined, undefined, ctx.ctx);
  assert.match(result.content[0].text, /Read-only actions/);
  await pi.runCommand("handoff", "knowledge plan proposal", ctx.ctx);
  assert.match(ctx.notifications.at(-1)!.text, /explicitly selected mission instance/);
  assert.equal(fs.files.has("/project/.pi-handoff/knowledge/.publish.lock"), false);
});

test("KI10: interrupted atomic temp artifacts are preserved and surfaced as warnings", async () => {
  const h = await setupMission("knowledge-interrupted-temp");
  const tempPath = "/project/.pi-handoff/knowledge/records/orphan-id/.tmp-publication-123";
  h.fs.writeFile(tempPath, "partial temporary bytes");
  const registry = readKnowledgeRegistry(h.fs, "/project");
  assert.equal(registry.errors.length, 0);
  assert.match(registry.warnings.join("\n"), /uncommitted atomic publication artifact preserved/);
  assert.equal(h.fs.readFile(tempPath), "partial temporary bytes", "inspection never cleans artifacts");
  const proposalName = setProposal(h, { name: "blocked-by-interruption" });
  const nextPlan = await plan(h, proposalName);
  assert.equal(nextPlan.fingerprint, undefined, "uncertain temporary state blocks approval");
  assert.match(nextPlan.text, /artifacts require explicit inspection/);
});
