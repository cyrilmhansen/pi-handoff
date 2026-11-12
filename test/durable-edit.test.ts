/**
 * dev.2 D3: deterministic durable-document targeted editing (`scripts/durable_edit.py`).
 *
 * Spawns the REAL python3 CLI against temp dirs (zero inference). Covers the mission
 * requirements: dry-run + diff BEFORE writing; exact section targeting + ambiguity
 * rejection; expected-hash concurrency protection; atomic per-file replacement and
 * interrupted-write safety; byte-identical non-target content; evidence-reference
 * existence checks; managed-block refusal (reuse of the guard checkpoint transaction,
 * never a rebuild); no git involvement.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/durable_edit.py");
const PY = (() => {
  const r = spawnSync("python3", ["-c", "import sys; print(sys.version_info[:2]>=(3,9) and 'ok' or 'old')"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "ok" ? "python3" : null;
})();
const ownedTempDirs: string[] = [];

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-durable-edit-"));
  ownedTempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function run(dir: string, args: string[]) {
  return spawnSync("python3", [TOOL, ...args], { cwd: dir, encoding: "utf8" });
}

function apply(dir: string, file: string, args: string[], expectedHash = run(dir, ["hash", file]).stdout.trim()) {
  return run(dir, ["apply", file, ...args, "--expect-sha256", expectedHash]);
}

const DOC = `# DOC

## Alpha
alpha body

## Beta
beta body

\`\`\`bash
## PseudoHeading inside a fence
\`\`\`

still beta section

<!-- guard:begin checkpoint -->
checkpointed: x
<!-- guard:end checkpoint -->

## Gamma
gamma refs: spec/CLAIMS.md
`;

test("DE0: python3 available", { skip: PY ? false : "python3 not available" }, () => assert.ok(PY));

test("DE1: plan is a DRY RUN — prints diff + hashes, writes nothing", () => {
  const dir = tmpProject({ "DOC.md": DOC });
  const before = fs.readFileSync(path.join(dir, "DOC.md"));
  const r = run(dir, ["plan", "DOC.md", "--section", "## Beta", "--mode", "replace", "--text", "new beta"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PLAN replace DOC\.md :: section '## Beta'/);
  assert.match(r.stdout, /current sha256:\s+[0-9a-f]{64}/);
  assert.match(r.stdout, /proposed sha256:\s+[0-9a-f]{64}/);
  assert.match(r.stdout, /-beta body/);
  assert.match(r.stdout, /\+new beta/);
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(dir, "DOC.md"))) === 0, "plan must not touch the file");
});

test("DE2: apply replaces the section; NON-TARGET BYTES are byte-identical; managed block survives", () => {
  const dir = tmpProject({ "DOC.md": DOC });
  const r = apply(dir, "DOC.md", ["--section", "## Beta", "--mode", "replace", "--text", "new beta\nline2"]);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(path.join(dir, "DOC.md"), "utf8");
  assert.ok(after.startsWith("# DOC\n\n## Alpha\nalpha body\n\n## Beta\nnew beta\nline2\n"));
  assert.ok(!after.includes("## PseudoHeading inside a fence"), "fence block was INSIDE the Beta range (range ends at managed marker) and got replaced");
  assert.ok(after.includes("## Alpha\nalpha body"), "earlier section byte-identical");
  assert.ok(after.includes("<!-- guard:begin checkpoint -->\ncheckpointed: x\n<!-- guard:end checkpoint -->"), "managed block byte-intact");
  assert.ok(after.includes("## Gamma\ngamma refs: spec/CLAIMS.md\n"), "trailing section byte-identical");
  const h = run(dir, ["hash", "DOC.md"]);
  assert.equal(h.stdout.trim(), sha(after));
});

test("DE3: fenced pseudo-headings never terminate a section (## inside ``` stays content)", () => {
  const dir = tmpProject({ "F.md": "# F\n\n## S\nbefore\n```\n## NotAHeading\n```\nafter\n\n## T\ntail\n" });
  const r = apply(dir, "F.md", ["--section", "## S", "--mode", "replace", "--text", "REPLACED"]);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(path.join(dir, "F.md"), "utf8");
  assert.ok(after.includes("## S\nREPLACED\n"), "whole old section (incl. fence) replaced");
  assert.ok(after.includes("\n## T\ntail\n"), "next real heading section kept");
  assert.ok(!after.includes("## NotAHeading"), "pseudo-heading was INSIDE the replaced range");
});

test("DE4: AMBIGUOUS exact-match duplicate headings are REFUSED (no guessing); NOT_FOUND too", () => {
  const dir = tmpProject({ "A.md": "# A\n\n## Dup\none\n\n## Dup\ntwo\n" });
  const amb = run(dir, ["plan", "A.md", "--section", "## Dup", "--text", "x"]);
  assert.equal(amb.status, 3, amb.stdout + amb.stderr);
  assert.match(amb.stderr + amb.stdout, /AMBIGUOUS: 2 exact matches .* lines 3, 6/);
  const nf = run(dir, ["plan", "A.md", "--section", "### Dup", "--text", "x"]);
  assert.equal(nf.status, 3);
  assert.match(nf.stderr, /NOT_FOUND/);
  assert.ok(fs.readFileSync(path.join(dir, "A.md"), "utf8").includes("one"), "no writes on refusal");
});

test("DE5: --expect-sha256 CONFLICT rejects stale concurrent edits (nothing overwritten)", () => {
  const dir = tmpProject({ "C.md": "# C\n\n## S\nbody\n" });
  const h0 = run(dir, ["hash", "C.md"]).stdout.trim();
  fs.writeFileSync(path.join(dir, "C.md"), "# C\n\n## S\nbody edited by ANOTHER writer\n"); // concurrent change
  const r = run(dir, ["apply", "C.md", "--section", "## S", "--text", "mine", "--expect-sha256", h0]);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /CONFLICT/);
  assert.ok(fs.readFileSync(path.join(dir, "C.md"), "utf8").includes("ANOTHER writer"), "the concurrent write is NOT clobbered");
  // fresh hash succeeds
  const h1 = run(dir, ["hash", "C.md"]).stdout.trim();
  const ok = run(dir, ["apply", "C.md", "--section", "## S", "--text", "mine", "--expect-sha256", h1]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("DE6: managed checkpoint markers are OFF-LIMITS; trailing blocks are EXCLUDED from the range", () => {
  // (a) marker INSIDE the editable range (mid-document block before next heading, at the
  // section level) — the range stops at the marker, so prose edits stay allowed and the
  // block survives byte-intact:
  const dir = tmpProject({ "M.md": "# M\n\n## S\nprose\n\n<!-- guard:begin checkpoint -->\nx\n<!-- guard:end checkpoint -->\n\n## T\ntail\n" });
  const r = apply(dir, "M.md", ["--section", "## S", "--mode", "append", "--text", "added"]);
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(path.join(dir, "M.md"), "utf8");
  assert.ok(after.includes("prose\n\nadded\n") && after.includes("<!-- guard:begin checkpoint -->\nx\n<!-- guard:end checkpoint -->"), "managed block untouched");
  // (b) a heading whose own line embeds a marker is refused (defense-in-depth):
  fs.writeFileSync(path.join(dir, "M2.md"), "# M2\n\n## Bad <!-- guard:begin checkpoint -->\nbody\n");
  const bad = run(dir, ["plan", "M2.md", "--section", "## Bad <!-- guard:begin checkpoint -->", "--text", "x"]);
  assert.equal(bad.status, 4, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /MANAGED_BLOCK/);
});

test("DE7: evidence-reference existence check (--check-refs) without touching conclusions", () => {
  const dir = tmpProject({ "R.md": "# R\n\n## S\nold\n", "spec/CLAIMS.md": "# claims\n" });
  const miss = apply(dir, "R.md", ["--section", "## S", "--text", "see spec/CLAIMS.md and results/run-7.log", "--check-refs", "--root", "."]);
  assert.equal(miss.status, 6, miss.stdout + miss.stderr);
  assert.match(miss.stderr, /MISSING_REF[\s\S]*results\/run-7\.log/);
  assert.ok(!miss.stderr.match(/MISSING_REF[\s\S]*spec\/CLAIMS\.md/), "existing ref accepted");
  const ok = apply(dir, "R.md", ["--section", "## S", "--text", "see spec/CLAIMS.md", "--check-refs", "--root", "."]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("DE8: interrupted/failed write keeps the ORIGINAL intact (atomicity, no partial file, no leftover temp)", () => {
  const dir = tmpProject({ "W.md": "# W\n\n## S\nbody\n" });
  fs.chmodSync(dir, 0o500); // read-only dir: mkstemp must fail
  try {
    const r = apply(dir, "W.md", ["--section", "## S", "--text", "never written"]);
    assert.equal(r.status, 7, r.stdout + r.stderr);
    assert.match(r.stderr, /IO: apply failed/);
    assert.equal(fs.readFileSync(path.join(dir, "W.md"), "utf8"), "# W\n\n## S\nbody\n", "original byte-identical after failed apply");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith(".durable_edit-"));
  assert.deepEqual(leftovers, [], "temp file cleaned up on failure");
});

test("DE9: JSON output carries machine-readable hashes + diff", () => {
  const dir = tmpProject({ "J.md": "# J\n\n## S\nbody\n" });
  const r = run(dir, ["plan", "J.md", "--section", "## S", "--text", "new", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.cmd, "plan");
  assert.equal(j.current_sha256, sha(fs.readFileSync(path.join(dir, "J.md"))));
  assert.equal(j.proposed_sha256, sha("# J\n\n## S\nnew\n"));
  assert.match(j.diff, /-body\n\+new/);
});

test("DE10: round trip through the GUARD machinery — prose edit makes the checkpoint stale, /handoff refresh makes it current again (reuse, not rebuild)", async () => {
  const { createLocalFs, validateCheckpoint, writeCheckpoint, readRecoveryBundle } = await import("../.pi/extensions/context-guard/checkpoint.ts");
  const files = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };
  const dir = tmpProject({
    "GOAL.md": "# GOAL\n\n## Objective\nx\n\n## Acceptance criteria\n- y\n",
    "PROGRESS.md": "# PROGRESS\n\n## Current phase\np\n\n## Completed\n- [x] a\n\n## Pending\n- [ ] b\n\n## Verified evidence\n(none)\n\n## Blockers\n(none)\n\n## Next action\nold next\n",
    "LEARNINGS.md": "# LEARNINGS\n\n## Accepted\n(none)\n\n## Proposed\n(none)\n\n## Falsified or superseded\n(none)\n",
    "HANDOFF.md": "# HANDOFF\n\n## Recovery instructions\n- read files\n\n## Last verified state\nok\n\n## Unfinished operations\n- [ ] b\n\n## Next action\nold next\n\n## Discoveries not yet incorporated\n- (none)\n",
  });
  const fsOps = createLocalFs();
  // 1) baseline checkpoint through the guard transaction:
  const first = writeCheckpoint(fsOps, {
    cwd: dir, files, level: 0, sessionId: "s-de10", remaining: 100000, goalDrift: false,
    lastVerifiedState: "baseline", unfinishedOperations: [], nextAction: "old next", recoveryInstructions: [], kind: "manual",
  });
  assert.ok(first.ok, first.errors.join("; "));
  assert.equal(validateCheckpoint(fsOps, dir, files).kind, "current");
  // 2) targeted prose edit THROUGH the python tool (Next action in both docs):
  const h = sha(fs.readFileSync(path.join(dir, "HANDOFF.md")));
  const r = run(dir, ["apply", "HANDOFF.md", "--section", "## Next action", "--text", "NEW exact next action after the durable edit", "--expect-sha256", h]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STALE/);
  // 3) guard classifies the checkpoint as stale (prose fingerprint changed):
  const stale = validateCheckpoint(fsOps, dir, files);
  assert.equal(stale.kind, "stale");
  assert.ok(stale.kind === "stale" && stale.changed.includes("handoff"));
  // 4) recovery bundle prefers the NEW manual prose (prose always wins):
  const bundle = readRecoveryBundle(fsOps, dir, files);
  assert.equal(bundle.nextActionSource, "handoff-prose");
  assert.match(bundle.nextAction!, /NEW exact next action/);
  // 5) refresh via the SAME guard transaction -> current, prose byte-preserved:
  const second = writeCheckpoint(fsOps, {
    cwd: dir, files, level: 0, sessionId: "s-de10", remaining: 90000, goalDrift: false,
    lastVerifiedState: "after edit", unfinishedOperations: [], nextAction: bundle.nextAction!, recoveryInstructions: [], kind: "manual",
  });
  assert.ok(second.ok && second.identity.generation === first.identity.generation + 1);
  assert.equal(validateCheckpoint(fsOps, dir, files).kind, "current");
  assert.ok(fs.readFileSync(path.join(dir, "HANDOFF.md"), "utf8").includes("NEW exact next action after the durable edit"));
});

test("DE11: NO git side effects — the tool never stages, cleans or touches .git", () => {
  const dir = tmpProject({ "G.md": "# G\n\n## S\nbody\n", "untracked-data.bin": "raw campaign artifact — must survive" });
  const r = apply(dir, "G.md", ["--section", "## S", "--text", "new"]);
  assert.equal(r.status, 0, r.stderr);
  // the tool must never invoke git at all (source-level proof: no subprocess imports, no git calls)
  const src = fs.readFileSync(TOOL, "utf8");
  assert.ok(!/subprocess|os\.system|popen/i.test(src), "no subprocess machinery in durable_edit.py — git is never called");

  assert.ok(fs.existsSync(path.join(dir, "untracked-data.bin")), "untracked data untouched");
});

test("DE12: apply requires the reviewed source fingerprint and rejects a stale target", () => {
  const dir = tmpProject({ "A.md": "# A\n\n## S\nold\n" });
  const plan = run(dir, ["plan", "A.md", "--section", "## S", "--text", "new", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  const missing = run(dir, ["apply", "A.md", "--section", "## S", "--text", "new"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /requires --expect-sha256/);
  fs.writeFileSync(path.join(dir, "A.md"), "# A\n\n## S\nchanged concurrently\n");
  const stale = apply(dir, "A.md", ["--section", "## S", "--text", "new"], planned.current_sha256);
  assert.equal(stale.status, 5, stale.stdout + stale.stderr);
  assert.match(stale.stderr, /CONFLICT/);
  assert.equal(fs.readFileSync(path.join(dir, "A.md"), "utf8"), "# A\n\n## S\nchanged concurrently\n");
});

test("DE13: archive-plan previews both files; archive-apply preserves the old section and replacement", () => {
  const originalSection = "## Next action\nRun phase A exactly.\n\n- retain the failed prediction\n";
  const managed = "<!-- guard:begin checkpoint -->\ncheckpoint-id: g2-id\n<!-- guard:end checkpoint -->\n";
  const dir = tmpProject({
    "HANDOFF.md": `# HANDOFF\n\n${originalSection}\n## Other\nkeep me\n\n${managed}`,
    "docs/history/README.md": "# Archive index\n\nExisting record.\n",
  });
  const sourceBefore = fs.readFileSync(path.join(dir, "HANDOFF.md"));
  const archiveBefore = fs.readFileSync(path.join(dir, "docs/history/README.md"));
  const args = [
    "HANDOFF.md", "--section", "## Next action", "--archive-file", "docs/history/README.md",
    "--archive-heading", "### Phase A closed 2026-11-13", "--text", "Start phase B.", "--root", ".", "--json",
  ];
  const planned = run(dir, ["archive-plan", ...args]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.match(plan.source_diff, /-Run phase A exactly/);
  assert.match(plan.source_diff, /\+Start phase B/);
  assert.match(plan.archive_diff, /\+## Next action/);
  assert.match(plan.archive_diff, /retain the failed prediction/);
  assert.equal(plan.wrote, false);
  assert.deepEqual(fs.readFileSync(path.join(dir, "HANDOFF.md")), sourceBefore, "archive preview is read-only");
  assert.deepEqual(fs.readFileSync(path.join(dir, "docs/history/README.md")), archiveBefore);

  const applied = run(dir, ["archive-apply", ...args, "--expect-sha256", plan.source_sha256, "--expect-archive-sha256", plan.archive_sha256]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const sourceAfter = fs.readFileSync(path.join(dir, "HANDOFF.md"), "utf8");
  const archiveAfter = fs.readFileSync(path.join(dir, "docs/history/README.md"), "utf8");
  assert.match(sourceAfter, /## Next action\nStart phase B\./);
  assert.match(sourceAfter, /## Other\nkeep me/);
  assert.ok(sourceAfter.includes(managed), "Handoff's managed checkpoint bytes are untouched");
  assert.ok(!sourceAfter.includes("Run phase A exactly."));
  assert.ok(archiveAfter.includes(originalSection), "the original heading and body are preserved verbatim in the archive");
  assert.match(archiveAfter, /### Phase A closed 2026-11-13/);
});

test("DE14: stale source or archive hashes refuse the whole archive move before either file changes", () => {
  const dir = tmpProject({ "A.md": "# A\n\n## Old phase\nold material\n", "history.md": "# History\n" });
  const args = ["A.md", "--section", "## Old phase", "--archive-file", "history.md", "--archive-heading", "### Phase A archived"];
  const planRun = run(dir, ["archive-plan", ...args, "--json"]);
  assert.equal(planRun.status, 0, planRun.stderr);
  const plan = JSON.parse(planRun.stdout);
  const sourceBefore = fs.readFileSync(path.join(dir, "A.md"));
  fs.appendFileSync(path.join(dir, "history.md"), "concurrent archive entry\n");
  const archiveBefore = fs.readFileSync(path.join(dir, "history.md"));
  const stale = run(dir, ["archive-apply", ...args, "--expect-sha256", plan.source_sha256, "--expect-archive-sha256", plan.archive_sha256]);
  assert.equal(stale.status, 5, stale.stdout + stale.stderr);
  assert.match(stale.stderr, /CONFLICT/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "A.md")), sourceBefore);
  assert.deepEqual(fs.readFileSync(path.join(dir, "history.md")), archiveBefore);
});

test("DE15: archive staging failure leaves source and archive byte-identical and cleans staged temps", () => {
  const dir = tmpProject({
    "src/A.md": "# A\n\n## Old phase\nold material\n",
    "out/history.md": "# History\n",
  });
  const sourcePath = path.join(dir, "src/A.md");
  const archivePath = path.join(dir, "out/history.md");
  const sourceBefore = fs.readFileSync(sourcePath);
  const archiveBefore = fs.readFileSync(archivePath);
  const sourceDir = path.dirname(sourcePath);
  fs.chmodSync(sourceDir, 0o500);
  try {
    const planRun = run(dir, ["archive-plan", "src/A.md", "--section", "## Old phase", "--archive-file", "out/history.md", "--archive-heading", "### Phase A archived", "--json"]);
    assert.equal(planRun.status, 0, planRun.stderr);
    const plan = JSON.parse(planRun.stdout);
    const failed = run(dir, ["archive-apply", "src/A.md", "--section", "## Old phase", "--archive-file", "out/history.md", "--archive-heading", "### Phase A archived", "--expect-sha256", plan.source_sha256, "--expect-archive-sha256", plan.archive_sha256]);
    assert.equal(failed.status, 7, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /archive apply failed before completion/);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(fs.readFileSync(archivePath), archiveBefore);
    assert.deepEqual(fs.readdirSync(path.dirname(archivePath)).filter((name) => name.startsWith(".durable_edit-")), []);
  } finally {
    fs.chmodSync(sourceDir, 0o700);
  }
});

test("DE16: archive source replacement failure rolls back the already-installed archive", () => {
  const dir = tmpProject({ "A.md": "# A\n\n## Old phase\nold material\n" });
  const sourcePath = path.join(dir, "A.md");
  const archivePath = path.join(dir, "history.md");
  const sourceBefore = fs.readFileSync(sourcePath);
  const py = `
import os, sys, types
tool, root, source, archive = sys.argv[1:]
mod = types.ModuleType("durable_edit_test"); mod.__file__ = tool
exec(compile(open(tool, "rb").read(), tool, "exec"), mod.__dict__)
source_hash = mod.sha256_bytes(open(source, "rb").read())
args = mod.argparse.Namespace(file=source, section="## Old phase", archive_file=archive,
    archive_heading="### Phase A archived", text=None, text_file=None,
    expect_sha256=source_hash, expect_archive_sha256="absent", root=root)
plan = mod.archive_plan(args, apply=True)
replace = os.replace
def fail_source(src, dst):
    if os.path.abspath(dst) == plan["source_path"]:
        raise OSError("injected source rename failure")
    return replace(src, dst)
mod.os.replace = fail_source
try:
    mod.apply_archive(plan)
except SystemExit as exc:
    assert exc.code == 7, exc.code
else:
    raise AssertionError("injected failure was not reported")
`;
  const failed = spawnSync("python3", ["-c", py, TOOL, dir, "A.md", "history.md"], { cwd: dir, encoding: "utf8" });
  assert.equal(failed.status, 0, failed.stdout + failed.stderr);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
  assert.equal(fs.existsSync(archivePath), false, "new archive file rolled back after source replacement failed");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(".durable_edit-")), []);
});

test("DE17: document audit is read-only, reports NO CHANGE and separates managed metadata from its status", () => {
  const files = {
    "AGENTS.md": "# Agent\n\nRead code first.\n",
    "PROTOCOL.md": "# Protocol\n\nKeep evidence.\n",
    "GOAL.md": "# Goal\n\n## Objective\nA stable objective.\n",
    "HANDOFF.md": "# Handoff\n\n## Next action\nRun the targeted check.\n\n<!-- guard:begin checkpoint -->\ncheckpoint-generation: 2\ncheckpoint-id: g2-id\nreadiness: attested\n<!-- guard:end checkpoint -->\n",
    "PROGRESS.md": "# Progress\n\n## Next action\nRun the targeted check.\n",
    "LEARNINGS.md": "# Learnings\n\n## Falsified or superseded\nKeep the original prediction and result distinct.\n",
  };
  const dir = tmpProject(files);
  const before = Object.fromEntries(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const r = run(dir, ["audit", "--root", ".", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const audit = JSON.parse(r.stdout);
  assert.equal(audit.result, "NO CHANGE");
  assert.equal(audit.mutated, false);
  assert.equal(audit.active_next_action.status, "unique");
  assert.match(audit.active_next_action.matches[0].text, /Run the targeted check/);
  assert.equal(audit.documents["HANDOFF.md"].managed_checkpoint.generation, "2");
  assert.equal(audit.documents["HANDOFF.md"].managed_checkpoint.readiness, "attested");
  assert.ok(audit.documents["HANDOFF.md"].managed_checkpoint_bytes > 0);
  assert.ok(audit.documents["HANDOFF.md"].manual_prose_and_other_bytes > 0);
  assert.match(audit.recovery_cost_estimates.basis, /characters \/ 4; estimate/);
  for (const [name, content] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(dir, name)), content);
});

test("DE18: audit reports duplicate/stale instructions, possible conflicts, and missing archive references without edits", () => {
  const files = {
    "AGENTS.md": "# Agent\n",
    "PROTOCOL.md": "# Protocol\n",
    "GOAL.md": "# Goal\n",
    "HANDOFF.md": "# Handoff\n\n## Next action\nRun current verification.\n\n## Next action — old\nDo not run historical setup.\n\n## Archived phase\nSee docs/history/missing-phase.md.\n\n> ## Next action\nquoted mention only\n\n```md\n## Next action\nfenced mention only\n```\n",
    "PROGRESS.md": "# Progress\n\n## Next action\nRestart old campaign.\n\n## Blockers\nnone\n",
    "LEARNINGS.md": "# Learnings\n\n## Falsified or superseded\nPrediction: unsafe.\nObservation: rejected.\nOperator decision: preserve safety.\n",
  };
  const dir = tmpProject(files);
  const before = Object.fromEntries(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const r = run(dir, ["audit", "--root", ".", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const audit = JSON.parse(r.stdout);
  const kinds = audit.findings.map((finding: { kind: string }) => finding.kind);
  assert.ok(kinds.includes("active-next-action-ambiguous"));
  assert.ok(kinds.includes("duplicate-active-heading"));
  assert.ok(kinds.includes("possible-next-action-conflict"));
  assert.ok(kinds.includes("missing-archive-reference"));
  assert.ok(audit.archive_candidates.some((candidate: { heading: string }) => /Archived phase/.test(candidate.heading)));
  assert.equal(audit.active_next_action.matches.length, 2, "quotes and fenced headings do not count as active sections");
  assert.equal(audit.result, "REVIEW SUGGESTED");
  for (const [name, content] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(dir, name)), content);
});

test("DE19: archive destinations that escape the project root are refused without writes", () => {
  const dir = tmpProject({ "HANDOFF.md": "# Handoff\n\n## Old phase\nold\n" });
  const source = fs.readFileSync(path.join(dir, "HANDOFF.md"));
  const escaped = `../${path.basename(dir)}-escape.md`;
  const r = run(dir, ["archive-plan", "HANDOFF.md", "--section", "## Old phase", "--archive-file", escaped, "--archive-heading", "### Archived", "--root", "."]);
  assert.equal(r.status, 7, r.stdout + r.stderr);
  assert.match(r.stderr, /PATH_OUTSIDE_ROOT/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "HANDOFF.md")), source);
  assert.equal(fs.existsSync(path.resolve(dir, escaped)), false);
});

after(() => {
  for (const dir of ownedTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
