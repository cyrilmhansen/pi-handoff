/**
 * Phase 1c — items 3 & 5: transactional checkpoint identity + readiness.
 *
 * Baseline evidence for item 3 (reproduced before the fix, /tmp/repro-identity.ts): two
 * checkpoint operations over unchanged source state produced byte-identical source
 * hashes, so an interrupted second write (HANDOFF replaced, PROGRESS write failed) was
 * classified "current" — the two managed blocks belonged to different checkpoint
 * operations and nothing could prove otherwise.
 *
 * Baseline evidence for item 5: the real repo diff at b2ccdac shows an automatic
 * level-3 checkpoint that rewrote the managed block, replaced a substantive
 * "Last verified state" line with "guard level 3; checkpoint requested (end of current
 * iteration /handoff verify)" and still validated as `current` — structurally valid,
 * hash-fresh, semantically empty.
 *
 * Memory fs + injected failures only; zero inference.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECKPOINT_SCHEMA,
  checkpointSources,
  extractManagedSection,
  replaceManagedSection,
  writeCheckpoint,
  validateCheckpoint,
  evaluateHandoffReadiness,
  attestHandoff,
  nextCheckpointGeneration,
  readRecoveryBundle,
  renewAuthorization,
  type CheckpointInput,
} from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, DEFAULT_FILES, type MemoryFs } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function input(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
  return {
    cwd: "/project",
    files: FILES,
    level: 1,
    sessionId: "sess-1",
    remaining: 25000,
    goalDrift: false,
    lastVerifiedState: "suite green",
    unfinishedOperations: ["- [ ] item"],
    nextAction: "Run the test suite.",
    recoveryInstructions: [],
    configName: "handoff.config.json",
    ...overrides,
  } as CheckpointInput;
}

function blocks(fs: MemoryFs) {
  const h = extractManagedSection(fs.files.get("/project/HANDOFF.md")!, "checkpoint")!;
  const p = extractManagedSection(fs.files.get("/project/PROGRESS.md")!, "checkpoint")!;
  return { h, p };
}

test("I1: one checkpoint operation stamps the same identity into both managed blocks", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const r = writeCheckpoint(fs, input());
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.identity.schema, CHECKPOINT_SCHEMA);
  assert.ok(r.identity.generation >= 1);
  assert.ok(r.identity.id.length >= 8);
  const { h, p } = blocks(fs);
  assert.ok(h.includes(`checkpoint-id: ${r.identity.id}`), "HANDOFF block carries the checkpoint id");
  assert.ok(p.includes(`checkpoint-id: ${r.identity.id}`), "PROGRESS block carries the SAME id");
  assert.ok(h.includes("checkpoint-kind: manual"));
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
});

test("I2: interrupted write between the two files is detected (never classified current)", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  // same source state: nothing new recorded, so the source hashes are identical —
  // only a transactional identity can prove the two blocks belong together.
  fs.failNext.set("/project/PROGRESS.md", 1);
  const r = writeCheckpoint(fs, input({ level: 3, sessionId: "sess-2", remaining: 9000, lastVerifiedState: "v2" }));
  assert.equal(r.ok, false);
  assert.equal(r.written.join(","), "HANDOFF.md", "HANDOFF replaced, PROGRESS write failed");

  const f = validateCheckpoint(fs, "/project", FILES);
  assert.notEqual(f.kind, "current", "partial checkpoint must not be reported current");
  assert.equal(f.kind, "stale");
  assert.equal(f.partial, true, "flagged as a partial/inconsistent generation");
  assert.ok(/generation/i.test(f.detail), f.detail);
});

test("I3: obsolete generations are detected even when every source hash matches", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  const first = blocks(fs).p;
  writeCheckpoint(fs, input({ level: 2 })); // generation 2 in both files
  // hand-edit PROGRESS back to its previous (obsolete) generation, source hashes intact
  const progress = fs.files.get("/project/PROGRESS.md")!;
  fs.files.set("/project/PROGRESS.md", replaceManagedSection(progress, "checkpoint", first));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.notEqual(f.kind, "current");
  assert.equal(f.partial, true);
  assert.ok(/obsolete|generation/i.test(f.detail), f.detail);
});

test("I4: mismatched ids and missing identity lines are reported distinctly", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  const { h } = blocks(fs);
  const tampered = replaceManagedSection(fs.files.get("/project/HANDOFF.md")!, "checkpoint", h.replace(/checkpoint-id: \S+/, "checkpoint-id: forged-0000"));
  fs.files.set("/project/HANDOFF.md", tampered);
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.partial, true, "forged id => identity mismatch");
  assert.ok(/mismatch/i.test(f.detail), f.detail);

  const fs2 = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs2, input());
  const { p } = blocks(fs2);
  fs2.files.set("/project/PROGRESS.md", replaceManagedSection(fs2.files.get("/project/PROGRESS.md")!, "checkpoint", p.replace(/checkpoint-id: .*\n/, "")));
  const f2 = validateCheckpoint(fs2, "/project", FILES);
  assert.equal(f2.kind, "stale");
  assert.equal(f2.partial, true);
  assert.ok(/missing/i.test(f2.detail), f2.detail);
});

test("I5: manual prose survives refresh and attestation byte-for-byte", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const manual = "\n\n## Manual discovery (mine)\nKeep me exactly: tab\tand  spaces  and --- dashes.\n";
  fs.files.set("/project/HANDOFF.md", fs.files.get("/project/HANDOFF.md")! + manual);
  fs.files.set("/project/PROGRESS.md", fs.files.get("/project/PROGRESS.md")! + manual);
  writeCheckpoint(fs, input());
  attestHandoff(fs, "/project", FILES, { sessionId: "sess-1" });
  writeCheckpoint(fs, input({ level: 2 }));
  for (const path of ["/project/HANDOFF.md", "/project/PROGRESS.md"]) {
    const content = fs.files.get(path)!;
    const prose = content.split("<!-- guard:begin")[0]!;
    assert.ok(prose.endsWith(manual), `${path} manual prose preserved`);
  }
});

test("I6: legacy schema-v1 block stays detected as stale-legacy (documented migration)", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const legacy = ["status: checkpoint (guard level 3)", "checkpointed: 2026-01-01T00:00:00.000Z", "", "### Next action", "old"].join("\n");
  fs.files.set("/project/HANDOFF.md", replaceManagedSection(DEFAULT_FILES["/project/HANDOFF.md"], "checkpoint", legacy));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "stale");
  assert.equal(f.legacy, true);
  assert.ok(/schema v1|unversioned/i.test(f.detail), f.detail);
});

test("I7: schema-v2 blocks without identity are reported as needing upgrade, then upgraded", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  // hand-built pre-Phase-1c (schema 2) checkpoint with correct hashes but no identity
  const sources = checkpointSources(fs, "/project", FILES);
  const inner = ["checkpoint-schema: 2", "status: checkpoint (guard level 3, session old)", "checkpointed: 2026-01-01T00:00:00.000Z", ...Object.entries(sources.entries).map(([k, v]) => `${k}: ${v}`), "", "### Next action", "Run the test suite."].join("\n");
  fs.files.set("/project/HANDOFF.md", replaceManagedSection(fs.files.get("/project/HANDOFF.md")!, "checkpoint", inner));
  fs.files.set("/project/PROGRESS.md", replaceManagedSection(fs.files.get("/project/PROGRESS.md")!, "checkpoint", inner));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "stale");
  assert.equal(f.legacyIdentity, true, "identity-less v2 block needs explicit upgrade");
  assert.ok(/identity/i.test(f.detail) && /\/handoff/.test(f.detail), f.detail);

  writeCheckpoint(fs, input());
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
});

test("I8: readiness is separate from technical currency — a fresh checkpoint is not a complete handoff", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  const fresh = validateCheckpoint(fs, "/project", FILES);
  assert.equal(fresh.kind, "current", "technically valid and fresh");
  assert.equal(fresh.readiness.state, "unattested", "but NOT semantically complete");
  assert.equal(renewAuthorization(fresh).authorized, false, "must not authorize renewal");

  const r = attestHandoff(fs, "/project", FILES, { sessionId: "sess-1" });
  assert.ok(r.ok, JSON.stringify(r.checks));
  const after = validateCheckpoint(fs, "/project", FILES);
  assert.equal(after.kind, "current");
  assert.equal(after.readiness.state, "attested");
  assert.equal(after.readiness.checkpointId, after.identity!.id, "attestation is bound to this checkpoint generation");
  assert.equal(renewAuthorization(after).authorized, true);

  // a later source edit voids the attestation (checkpoint goes stale)
  fs.files.set("/project/LEARNINGS.md", DEFAULT_FILES["/project/LEARNINGS.md"] + "\n- [A-99] new discovery. evidence: test. confidence: high.\n");
  const stale = validateCheckpoint(fs, "/project", FILES);
  assert.equal(stale.kind, "stale");
  assert.equal(renewAuthorization(stale).authorized, false, "attested-but-stale must not authorize renewal");

  // a new checkpoint generation resets readiness to unattested
  writeCheckpoint(fs, input({ level: 2 }));
  const re = validateCheckpoint(fs, "/project", FILES);
  assert.equal(re.kind, "current");
  assert.equal(re.readiness.state, "unattested");
});

test("I9: readiness checks are deterministic and failures are visible (no silent attestation)", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  fs.files.set("/project/HANDOFF.md", DEFAULT_FILES["/project/HANDOFF.md"].replace("## Next action\nRun the test suite.", "## Next action\n(unknown — record the exact next action in PROGRESS.md)"));
  writeCheckpoint(fs, input({ nextAction: "(unknown — record the exact next action in PROGRESS.md)" }));
  const ev = evaluateHandoffReadiness(fs, "/project", FILES);
  assert.equal(ev.ok, false);
  assert.ok(ev.checks.some((c) => c.id === "next-action-recorded" && c.status === "fail"), JSON.stringify(ev.checks));
  const att = attestHandoff(fs, "/project", FILES, { sessionId: "sess-1" });
  assert.equal(att.ok, false, "attestation refused");
  assert.equal(att.written.length, 0, "nothing written");
  assert.equal(validateCheckpoint(fs, "/project", FILES).readiness.state, "unattested");
});

test("I10: a checkpoint that recorded nothing new is detectable (content-delta) and auto-checkpoints keep prior prose", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input({ kind: "auto", lastVerifiedState: "Phase 1b consolidation; 55/55 tests; real Pi RPC verification" }));
  const first = blocks(fs).h;
  assert.ok(first.includes("content-delta: initial"), "first checkpoint has no predecessor");

  const r = writeCheckpoint(fs, input({ kind: "auto", level: 3, remaining: 9000, lastVerifiedState: "guard level 3; checkpoint requested (auto)" }));
  assert.equal(r.contentDelta, "none", "no source state changed between the two checkpoints");
  const { h } = blocks(fs);
  assert.ok(h.includes("content-delta: none"));
  assert.ok(h.includes("Phase 1b consolidation; 55/55 tests"), "auto checkpoint must not erase the previous summary");
  assert.ok(!h.includes("guard level 3; checkpoint requested (auto)"), "generic auto text does not overwrite substantive state");

  const ev = evaluateHandoffReadiness(fs, "/project", FILES);
  assert.ok(ev.checks.some((c) => c.id === "content-delta" && c.status === "warn"), "no-new-content must be visible");

  // recording something new clears the warning
  fs.files.set("/project/LEARNINGS.md", DEFAULT_FILES["/project/LEARNINGS.md"] + "\n- [A-99] discovery. evidence: x. confidence: high.\n");
  const r2 = writeCheckpoint(fs, input({ kind: "manual", level: 3 }));
  assert.equal(r2.contentDelta, "new");
  assert.ok(evaluateHandoffReadiness(fs, "/project", FILES).checks.some((c) => c.id === "content-delta" && c.status === "pass"));
});

test("I11: an interrupted attestation leaves a detectable partial generation, never 'attested'", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  fs.failNext.set("/project/PROGRESS.md", 1);
  const att = attestHandoff(fs, "/project", FILES, { sessionId: "sess-1" });
  assert.equal(att.ok, false, "attestation reports the failure");
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.notEqual(f.readiness?.state, "attested", "must never report attested from mismatched blocks");
  assert.equal(f.partial, true, JSON.stringify(f));
});

test("I12: dry-run attestation and validation perform no writes", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  writeCheckpoint(fs, input());
  fs.writes.length = 0;
  const before = new Map(fs.files);
  validateCheckpoint(fs, "/project", FILES);
  evaluateHandoffReadiness(fs, "/project", FILES);
  const att = attestHandoff(fs, "/project", FILES, { sessionId: "s", dryRun: true });
  assert.equal(fs.writes.length, 0, `no writes expected, got ${fs.writes.join(",")}`);
  assert.deepEqual([...fs.files.keys()].sort(), [...before.keys()].sort());
  assert.ok(att.dryRun === true);
});

test("I13: generation counter advances monotonically from the blocks themselves (no clock, no randomness)", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  assert.equal(nextCheckpointGeneration(fs, "/project", FILES), 1, "no prior blocks");
  const a = writeCheckpoint(fs, input());
  assert.equal(a.identity.generation, 1);
  const b = writeCheckpoint(fs, input());
  assert.equal(b.identity.generation, 2);
  assert.notEqual(b.identity.id, a.identity.id, "distinct operations get distinct ids");
  // if only the HANDOFF block advanced (interrupted write), the next operation still moves forward
  const progress = fs.files.get("/project/PROGRESS.md")!;
  fs.files.set("/project/PROGRESS.md", replaceManagedSection(progress, "checkpoint", blocks(fs).p.split("\n").map((l) => (l.startsWith("checkpoint-generation:") ? "checkpoint-generation: 1" : l)).join("\n")));
  const c = writeCheckpoint(fs, input());
  assert.equal(c.identity.generation, 3, "generation = max(handoff, progress) + 1");
});

test("I14: recovery bundle reports currency and readiness separately", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  fs.files.delete("/project/HANDOFF.md");
  const missing = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(missing.checkpoint.kind, "missing");
  assert.equal(renewAuthorization(missing.checkpoint).authorized, false);
  fs.files.set("/project/HANDOFF.md", DEFAULT_FILES["/project/HANDOFF.md"]);
  writeCheckpoint(fs, input());
  attestHandoff(fs, "/project", FILES, { sessionId: "sess-1" });
  const bundle = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(bundle.nextActionSource, "handoff-prose", "manual prose still wins");
  assert.equal(bundle.checkpoint.kind, "current");
  assert.equal(bundle.checkpoint.readiness.state, "attested");
});
