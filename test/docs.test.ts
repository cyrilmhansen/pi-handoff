/**
 * D9 — skill & release documentation regression tests (LEARNINGS A-41).
 *
 * Baseline evidence: the bundled skill (references/bootstrap.md) and
 * docs/long-project-guide.md documented a FIVE-module extension long after dev.2 D4/D5c
 * added recovery.ts and diagnostics.ts (seven local modules); commands.md missed the D4
 * config keys and the D4/D5d env overrides. Root cause: nothing checked the DOCUMENTED
 * surface against the RUNTIME surface. These tests compute the extension's real local
 * dependency closure from the entry point and require every documented module list and
 * env-override list to match it exactly — the docs class of the A-15 "mocks never catch
 * load-time reality" lesson, applied to prose.
 *
 * Zero inference, real files, no fixture tree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(REPO, ".pi/extensions/context-guard");
const SKILL_DIR = path.join(REPO, ".agents/skills/pi-handoff");
const GUIDE = path.join(REPO, "docs/long-project-guide.md");
const README = path.join(REPO, "README.md");
const BOOTSTRAP = path.join(SKILL_DIR, "references/bootstrap.md");
const COMMANDS = path.join(SKILL_DIR, "references/commands.md");

/** Strip line comments and JSDoc-ish lines so prose mentions never count as imports. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/** Transitive closure of "./x.ts" imports starting at the runtime entry point. */
function localModuleClosure(entry = "index.ts"): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  const re = /(?:from|import)\s+"(\.\/[A-Za-z0-9_-]+\.ts)"/g;
  while (stack.length > 0) {
    const mod = stack.pop()!;
    if (seen.has(mod)) continue;
    seen.add(mod);
    const src = codeOnly(fs.readFileSync(path.join(EXT_DIR, mod), "utf8"));
    for (const m of src.matchAll(re)) stack.push(path.basename(m[1]));
  }
  return seen;
}

function sortedUnion(...sets: Iterable<string>[]): string[] {
  return [...new Set(sets.flatMap((s) => [...s]))].sort();
}

const closure = localModuleClosure();

test("DC1: the runtime entry point transitively imports exactly the .ts modules shipped in the extension dir", () => {
  const onDisk = fs
    .readdirSync(EXT_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  assert.ok(onDisk.length >= 1, "extension directory must contain modules");
  // Every shipped module must be reachable from index.ts (no dead files that a docs
  // list could faithfully omit while the runtime still loads them).
  assert.deepEqual(sortedUnion(closure), onDisk, "reachable import closure must equal the shipped module set");
});

test("DC2: bootstrap.md §1 lists EXACTLY the extension's local module dependencies", () => {
  const md = fs.readFileSync(BOOTSTRAP, "utf8");
  const sec = md.slice(md.indexOf("## 1."));
  const fence = sec.match(/```([\s\S]*?)```/);
  assert.ok(fence, "bootstrap §1 must contain the fenced module list");
  const listed = [...fence![1].matchAll(/\b([a-z][a-z0-9-]*\.ts)\b/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, "fenced block must name the modules");
  assert.deepEqual(
    [...new Set(listed)].sort(),
    sortedUnion(closure),
    `bootstrap §1 documents ${listed.join(" ")} but the runtime imports ${[...closure].sort().join(" ")}`,
  );
});

test("DC3: long-project-guide §2 step 1 lists EXACTLY the module closure and the §1 count matches", () => {
  const md = fs.readFileSync(GUIDE, "utf8");
  const listMatch = md.match(/\((index\.ts,[^)]*?\.ts)\)/);
  assert.ok(listMatch, "guide §2 step 1 must carry the parenthesized module list");
  const listed = listMatch![1].split(",").map((s) => s.trim());
  assert.deepEqual(
    [...new Set(listed)].sort(),
    sortedUnion(closure),
    `guide §2 documents ${listed.join(" ")} but the runtime imports ${[...closure].sort().join(" ")}`,
  );
  const count = md.match(/\((\d+) TS modules\b/);
  assert.ok(count, "guide §1 file map must state the module count");
  assert.equal(Number(count![1]), closure.size, "guide §1 module count must match the runtime closure");
});

test("DC4: README Layout block lists EXACTLY the module closure", () => {
  const md = fs.readFileSync(README, "utf8");
  const fence = md.match(/```\n\.pi\/extensions\/context-guard\/([\s\S]*?)```/);
  assert.ok(fence, "README Layout must contain the fenced extension listing starting with .pi/extensions/context-guard/");
  const listed = [...fence![1].matchAll(/^ {2}([a-z][a-z0-9-]*\.ts)\s/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(listed)].sort(),
    sortedUnion(closure),
    `README Layout documents ${listed.join(" ")} but the runtime imports ${[...closure].sort().join(" ")}`,
  );
});

test("DC5: commands.md + README document every env override the extension actually reads", () => {
  const envs = new Set<string>();
  for (const mod of closure) {
    const src = codeOnly(fs.readFileSync(path.join(EXT_DIR, mod), "utf8"));
    for (const m of src.matchAll(/\b(CONTEXT_GUARD_[A-Z_]+|GUARD_VERSION)\b/g)) envs.add(m[1]);
  }
  // Dev.2 additions that MUST be present explicitly (defect class: silently missing rows).
  for (const must of ["CONTEXT_GUARD_LEAN", "GUARD_VERSION"]) {
    assert.ok(envs.has(must), `source must read ${must} (test premise) — if removed, update this test`);
  }
  const commands = fs.readFileSync(COMMANDS, "utf8");
  const readme = fs.readFileSync(README, "utf8");
  for (const env of [...envs].sort()) {
    assert.ok(commands.includes(env), `references/commands.md must document ${env}`);
    assert.ok(readme.includes(env), `README env overrides must document ${env}`);
  }
});
