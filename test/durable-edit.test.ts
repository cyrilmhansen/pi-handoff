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

import test from "node:test";
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

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-edit-"));
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
  const r = run(dir, ["apply", "DOC.md", "--section", "## Beta", "--mode", "replace", "--text", "new beta\nline2"]);
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
  const r = run(dir, ["apply", "F.md", "--section", "## S", "--mode", "replace", "--text", "REPLACED"]);
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
  const r = run(dir, ["apply", "M.md", "--section", "## S", "--mode", "append", "--text", "added"]);
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
  const miss = run(dir, ["apply", "R.md", "--section", "## S", "--text", "see spec/CLAIMS.md and results/run-7.log", "--check-refs", "--root", "."]);
  assert.equal(miss.status, 6, miss.stdout + miss.stderr);
  assert.match(miss.stderr, /MISSING_REF[\s\S]*results\/run-7\.log/);
  assert.ok(!miss.stderr.match(/MISSING_REF[\s\S]*spec\/CLAIMS\.md/), "existing ref accepted");
  const ok = run(dir, ["apply", "R.md", "--section", "## S", "--text", "see spec/CLAIMS.md", "--check-refs", "--root", "."]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("DE8: interrupted/failed write keeps the ORIGINAL intact (atomicity, no partial file, no leftover temp)", () => {
  const dir = tmpProject({ "W.md": "# W\n\n## S\nbody\n" });
  fs.chmodSync(dir, 0o500); // read-only dir: mkstemp must fail
  try {
    const r = run(dir, ["apply", "W.md", "--section", "## S", "--text", "never written"]);
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
  const r = spawnSync("python3", [TOOL, "apply", "G.md", "--section", "## S", "--text", "new"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // the tool must never invoke git at all (source-level proof: no subprocess imports, no git calls)
  const src = fs.readFileSync(TOOL, "utf8");
  assert.ok(!/subprocess|os\.system|popen/i.test(src), "no subprocess machinery in durable_edit.py — git is never called");

  assert.ok(fs.existsSync(path.join(dir, "untracked-data.bin")), "untracked data untouched");
});
