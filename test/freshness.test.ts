/**
 * Phase 1b — checkpoint freshness validation (pure checkpoint module level).
 *
 * Reproduces the recovery-audit defect: a managed checkpoint block whose prose
 * was superseded by newer manual text, previously accepted by the validator as
 * a valid handoff. Freshness classes: missing / corrupt / stale / current.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkpointSources,
  extractManagedSection,
  readRecoveryBundle,
  validateCheckpoint,
  writeCheckpoint,
  type FsOps,
} from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };
const HANDOFF_PATH = "/project/HANDOFF.md";
const PROGRESS_PATH = "/project/PROGRESS.md";

function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "/project/GOAL.md": "# GOAL\n\n## Objective\nShip the guard.\n\n## Acceptance criteria\n- Tests.\n",
    "/project/PROGRESS.md":
      "# PROGRESS\n\n## Current phase\np\n\n## Completed\n- [x] a\n\n## Pending\n- [ ] b\n\n## Verified evidence\ne\n\n## Blockers\nn\n\n## Next action\nrun tests\n",
    "/project/LEARNINGS.md": "# LEARNINGS\n\n## Accepted\n- [A-1] x\n\n## Proposed\n- [P-1] y\n\n## Falsified or superseded\n- [F-1] z\n",
    "/project/HANDOFF.md":
      "# HANDOFF\n\n## Recovery instructions\n- Read AGENTS.md.\n\n## Last verified state\ns\n\n## Unfinished operations\nu\n\n## Next action\nmanual next\n\n## Discoveries not yet incorporated\n- keep me\n",
    "/project/handoff.config.json": "{}",
    ...extra,
  };
}

function input(over: Partial<Parameters<typeof writeCheckpoint>[0]> = {}): Parameters<typeof writeCheckpoint>[0] {
  return {
    cwd: "/project",
    files: FILES,
    level: 2,
    sessionId: "sess-1",
    remaining: 15000,
    goalDrift: false,
    lastVerifiedState: "tests green",
    unfinishedOperations: ["b"],
    nextAction: "finish phase 1b",
    recoveryInstructions: [],
    ...over,
  };
}

function snapshot(fs: FsOps): string {
  const map = fs as unknown as { files: Map<string, string> };
  return JSON.stringify([...map.files.entries()].sort());
}

/* ------------------------------------------------------------------ */

test("F1: a freshly written checkpoint validates as current; validation itself performs no writes", () => {
  const fs = createMemoryFs(baseFiles());
  const result = writeCheckpoint(fs, input());
  assert.equal(result.dryRun, false);
  assert.equal(result.ok, true);

  const writesBefore = fs.writes.length;
  const filesBefore = snapshot(fs);
  const freshness = validateCheckpoint(fs, "/project", FILES);
  assert.equal(freshness.kind, "current");
  assert.equal(fs.writes.length, writesBefore, "validateCheckpoint must not write");
  assert.equal(snapshot(fs), filesBefore, "validation must not mutate any file");
});

test("F2: no circularity — source hashes are stable across refreshes and never include the block itself", () => {
  const fs = createMemoryFs(baseFiles());
  const r1 = writeCheckpoint(fs, input());
  const block1 = extractManagedSection(fs.readFile(HANDOFF_PATH)!, "checkpoint")!;
  const r2 = writeCheckpoint(fs, input({ level: 3, notes: "different content now" }));
  const block2 = extractManagedSection(fs.readFile(HANDOFF_PATH)!, "checkpoint")!;

  assert.equal(r2.fingerprint, r1.fingerprint, "fingerprint depends only on source state, not on block text");
  assert.notEqual(block1, block2, "block content did change between the two writes");
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
});

test("F3: stale detection — editing manual prose after a checkpoint marks it stale and names the source", () => {
  const fs = createMemoryFs(baseFiles());
  writeCheckpoint(fs, input());
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");

  // The audit scenario: manual HANDOFF prose updated, managed block left behind.
  const handoff = fs.readFile(HANDOFF_PATH)!;
  fs.writeFile(HANDOFF_PATH, handoff.replace("manual next", "PHASE 1 VERIFICATION COMPLETE — human review next"));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "stale");
  if (f.kind === "stale") {
    assert.equal(f.legacy, false);
    assert.deepEqual(f.changed, ["handoff"]);
    assert.match(f.detail, /source state changed after the checkpoint/);
  }

  // PROGRESS prose, LEARNINGS, GOAL and config each make it stale too.
  const fs2 = createMemoryFs(baseFiles());
  writeCheckpoint(fs2, input());
  fs2.writeFile(PROGRESS_PATH, fs2.readFile(PROGRESS_PATH)!.replace("run tests", "review with human"));
  const f2 = validateCheckpoint(fs2, "/project", FILES);
  assert.equal(f2.kind, "stale");
  if (f2.kind === "stale") assert.deepEqual(f2.changed, ["progress"]);

  const fs3 = createMemoryFs(baseFiles());
  writeCheckpoint(fs3, input());
  fs3.writeFile("/project/LEARNINGS.md", fs3.readFile("/project/LEARNINGS.md")! + "\n- [A-9] new discovery\n");
  const f3 = validateCheckpoint(fs3, "/project", FILES);
  assert.equal(f3.kind, "stale");
  if (f3.kind === "stale") assert.deepEqual(f3.changed, ["learnings"]);

  const fs4 = createMemoryFs(baseFiles());
  writeCheckpoint(fs4, input());
  fs4.writeFile("/project/GOAL.md", "# GOAL\n\n## Objective\nChanged objective!\n\n## Acceptance criteria\n- Tests.\n");
  const f4 = validateCheckpoint(fs4, "/project", FILES);
  assert.equal(f4.kind === "stale" && f4.changed.includes("goal"), true);

  const fs5 = createMemoryFs(baseFiles());
  writeCheckpoint(fs5, input());
  fs5.writeFile("/project/handoff.config.json", '{"thresholds":{"closing":6000}}');
  const f5 = validateCheckpoint(fs5, "/project", FILES);
  assert.equal(f5.kind === "stale" && f5.changed.includes("config"), true);
});

test("F4: refreshing re-validates as current after source-state changes", () => {
  const fs = createMemoryFs(baseFiles());
  writeCheckpoint(fs, input());
  fs.writeFile(HANDOFF_PATH, fs.readFile(HANDOFF_PATH)!.replace("manual next", "newer manual next"));
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "stale");
  writeCheckpoint(fs, input({ nextAction: "newer manual next" }));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "current");
});

test("F5: legacy (schema v1) managed block is stale-with-reason, not corrupt — the real audit scenario", () => {
  const legacyBlock = [
    "<!-- guard:begin checkpoint -->",
    "status: checkpoint (guard level 0, remaining unknown, session 01a1865b-f48c-76ee-9fe0-a7bb1fff3303)",
    "checkpointed: 2026-10-29T06:32:15.862Z",
    "",
    "### Next action",
    "stale live-walkthrough instructions",
    "<!-- guard:end checkpoint -->",
  ].join("\n");
  const fs = createMemoryFs(baseFiles({ [HANDOFF_PATH]: `# HANDOFF\n\n## Recovery instructions\n- Read AGENTS.md.\n\n## Last verified state\ns\n\n## Unfinished operations\nu\n\n## Next action\nmanual next\n\n## Discoveries not yet incorporated\n- keep me\n\n${legacyBlock}\n` }));
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "stale");
  if (f.kind === "stale") {
    assert.equal(f.legacy, true);
    assert.match(f.detail, /unversioned/);
    assert.equal(f.session, "01a1865b-f48c-76ee-9fe0-a7bb1fff3303");
  }
  // and the Phase 1a defect itself: the stale block used to win the next action
  const bundle = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(bundle.nextAction, "manual next");
  assert.equal(bundle.nextActionSource, "handoff-prose");
});

test("F6: structurally invalid blocks are corrupt (not stale, not current)", () => {
  const mk = (inner: string) => {
    const fs = createMemoryFs(baseFiles());
    writeCheckpoint(fs, input());
    const c = fs.readFile(HANDOFF_PATH)!;
    const cur = extractManagedSection(c, "checkpoint")!;
    fs.writeFile(HANDOFF_PATH, c.replace(cur, inner));
    return fs;
  };
  assert.equal(validateCheckpoint(mk("status: checkpoint\nno timestamp here"), "/project", FILES).kind, "corrupt");
  assert.equal(validateCheckpoint(mk("checkpoint-schema: 99\ncheckpointed: 2026-01-01T00:00:00.000Z"), "/project", FILES).kind, "corrupt");
  assert.equal(
    validateCheckpoint(
      mk("checkpoint-schema: 2\ncheckpointed: 2026-01-01T00:00:00.000Z\nsource-goal: notahash\nsource-progress: absent\nsource-handoff: absent\nsource-learnings: absent\nsource-config: absent"),
      "/project",
      FILES,
    ).kind,
    "corrupt",
  );
});

test("F7: missing checkpoint block is its own class; partial twin (PROGRESS block removed) is stale", () => {
  const fs = createMemoryFs(baseFiles());
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "missing");
  writeCheckpoint(fs, input());
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
  // simulate a crash that dropped the PROGRESS twin block: handoff hashes still match,
  // but the checkpoint is incomplete -> stale (needs refresh), never "current".
  const withProgress = fs.readFile(PROGRESS_PATH)!;
  const stripped = withProgress.replace(/<!-- guard:begin checkpoint -->[\s\S]*<!-- guard:end checkpoint -->/, "");
  fs.writeFile(PROGRESS_PATH, stripped);
  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "stale");
  if (f.kind === "stale") assert.ok(f.changed.some((c) => c.startsWith("progress")));
});

test("F8: dry run (audit mode) computes sources and plans writes without touching any file", () => {
  const fs = createMemoryFs(baseFiles());
  const before = snapshot(fs);
  const result = writeCheckpoint(fs, input(), { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.planned, ["HANDOFF.md", "PROGRESS.md"]);
  assert.equal(result.fingerprint, checkpointSources(fs, "/project", FILES).fingerprint);
  assert.equal(snapshot(fs), before);
  assert.equal(fs.writes.length, 0);
});
