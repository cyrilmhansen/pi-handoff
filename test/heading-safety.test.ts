/**
 * Issue #8: real Markdown heading identity must drive recovery, checkpoint
 * recording, structural validation and the renewal attestation gate.
 * Zero-inference memory-fs tests; no Pi process required.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  attestHandoff,
  evaluateHandoffReadiness,
  extractManagedSection,
  readRecoveryBundle,
  renewAuthorization,
  validateCheckpoint,
  validateFile,
  writeCheckpoint,
} from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, DEFAULT_FILES } from "./helpers.ts";

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };
const HANDOFF = "/project/HANDOFF.md";
const action = "Run the byte-exact gate; expect 1120/1120 and no source mutations.";

function input() {
  return {
    cwd: "/project",
    files: FILES,
    level: 0,
    sessionId: "heading-safety-test",
    remaining: 50000,
    goalDrift: false,
    lastVerifiedState: "verified",
    unfinishedOperations: [],
    nextAction: "obsolete caller suggestion",
    recoveryInstructions: [],
  };
}

test("HS1: inline, list, quote and fenced mentions cannot capture the Next action; suffix heading is valid", () => {
  const base = DEFAULT_FILES[HANDOFF];
  const source = base.replace(
    "## Recovery instructions",
    [
      "This file has exactly ONE active `## Next action` section.",
      "- Historical heading: `## Next action`",
      "> ## Next action",
      "```md",
      "## Next action",
      "fake code example",
      "```",
      "~~~md",
      "## Next action",
      "fake tilde example",
      "~~~",
      "    ## Next action",
      "",
      "## Recovery instructions",
    ].join("\n"),
  ).replace("## Next action\nRun the test suite.", "## Next action — E2E-48/P2e: LOWER arms\n" + action);
  const fs = createMemoryFs({ ...DEFAULT_FILES, [HANDOFF]: source });
  assert.equal(validateFile(fs, HANDOFF, "handoff").ok, true);
  const bundle = readRecoveryBundle(fs, "/project", FILES);
  assert.equal(bundle.nextAction, action);
  const written = writeCheckpoint(fs, input());
  assert.ok(written.ok, written.errors.join("; "));
  assert.match(extractManagedSection(fs.readFile(HANDOFF)!, "checkpoint")!, /### Next action\nRun the byte-exact gate/);
  assert.match(extractManagedSection(fs.readFile("/project/PROGRESS.md")!, "checkpoint")!, /next-action: Run the byte-exact gate/);
  const attested = attestHandoff(fs, "/project", FILES, { sessionId: "heading-safety-test" });
  assert.ok(attested.ok, JSON.stringify(attested.checks));
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
  assert.equal(renewAuthorization(validateCheckpoint(fs, "/project", FILES)).authorized, true);
});

test("HS2: a lone inline heading mention cannot satisfy structural validation or attest renewal", () => {
  const broken = DEFAULT_FILES[HANDOFF].replace("## Next action\nRun the test suite.", "The active `## Next action` section is missing.");
  const fs = createMemoryFs({ ...DEFAULT_FILES, [HANDOFF]: broken });
  assert.ok(!validateFile(fs, HANDOFF, "handoff").ok);
  writeCheckpoint(fs, input());
  const ready = evaluateHandoffReadiness(fs, "/project", FILES);
  assert.ok(!ready.ok);
  assert.ok(ready.checks.some((c) => c.id === "next-action-recorded" && c.status === "fail"));
  assert.equal(attestHandoff(fs, "/project", FILES, { sessionId: "heading-safety-test" }).ok, false);
});

test("HS3: duplicate genuine Next action headings fail closed instead of choosing one", () => {
  const fs = createMemoryFs({
    ...DEFAULT_FILES,
    [HANDOFF]: DEFAULT_FILES[HANDOFF] + "\n## Next action — historical\nDo not run this old command.\n",
  });
  const v = validateFile(fs, HANDOFF, "handoff");
  assert.equal(v.ok, false);
  assert.ok(v.missingSections.some((s) => /Next action.*duplicate/.test(s)));
  writeCheckpoint(fs, input());
  assert.equal(evaluateHandoffReadiness(fs, "/project", FILES).ok, false);
  assert.equal(attestHandoff(fs, "/project", FILES, { sessionId: "heading-safety-test" }).ok, false);
});

test("HS4: previously attested but semantically wrong managed action is rejected on read-only revalidation", () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const first = writeCheckpoint(fs, input());
  assert.ok(first.ok);
  const ready = attestHandoff(fs, "/project", FILES, { sessionId: "heading-safety-test" });
  assert.ok(ready.ok);
  assert.equal(validateCheckpoint(fs, "/project", FILES).kind, "current");
  const old = fs.readFile(HANDOFF)!;
  const mutated = old.replace("### Next action\nRun the test suite.", "### Next action\n`. Closed-phase history is archived.");
  assert.notEqual(mutated, old, "test fixture must poison only the managed checkpoint body");
  fs.files.set(HANDOFF, mutated);
  const before = JSON.stringify([...fs.files.entries()].sort());
  const writes = fs.writes.length;
  const status = validateCheckpoint(fs, "/project", FILES);
  assert.equal(status.kind, "stale", "valid hashes alone must not authorize a wrong prior parser result");
  assert.equal(renewAuthorization(status).authorized, false);
  assert.equal(fs.writes.length, writes, "revalidation is read-only");
  assert.equal(JSON.stringify([...fs.files.entries()].sort()), before);
  // The real manual action still wins in recovery, even when the poisoned block is stale.
  assert.equal(readRecoveryBundle(fs, "/project", FILES).nextAction, "Run the test suite.");
});

test("HS5: other required headings cannot be satisfied by inline references alone", () => {
  const fs = createMemoryFs({
    ...DEFAULT_FILES,
    "/project/GOAL.md": "# GOAL\n\nRead the `## Objective` reference.\n\n## Acceptance criteria\n- tests pass\n",
  });
  const v = validateFile(fs, "/project/GOAL.md", "goal");
  assert.equal(v.ok, false);
  assert.ok(v.missingSections.includes("## Objective"));
});
