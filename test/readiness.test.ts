/**
 * Phase 1c — item 5/7 at the ADAPTER level: the readiness gate and the renewal
 * authorization must be reachable through the extension commands, and attestation must
 * be impossible in read-only audit mode.
 *
 * The module-level behaviour (identity, attestation, interrupted writes) is specified in
 * test/identity.test.ts I1–I14; this file proves the index.ts wiring only, with mocked
 * Pi events + memory fs + synthetic budgets (zero inference).
 */

import test from "node:test";
import assert from "node:assert/strict";

import contextGuard from "../.pi/extensions/context-guard/index.ts";
import { renewAuthorization, validateCheckpoint } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, createMockCtx, createMockPi, DEFAULT_FILES } from "./helpers.ts";

/** Audited TREE only: runtime state outside /project may legitimately change (§2.3). */
const treeOf = (fs: ReturnType<typeof createMemoryFs>) =>
  JSON.stringify([...fs.files.entries()].filter(([k]) => k.startsWith("/project")).sort());

const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function session(fs: ReturnType<typeof createMemoryFs>, sessionId: string, options: { env?: Record<string, string | undefined>; flags?: Record<string, string> } = {}) {
  const pi = createMockPi(options.flags ?? {});
  const ctx = createMockCtx({ cwd: "/project", sessionId, mode: "tui" });
  contextGuard(pi.pi as never, { fs, env: options.env ?? {} });
  return {
    pi,
    ctx,
    fs,
    start: async () => {
      await pi.emit({ type: "session_start", reason: "startup" } as never, ctx.ctx as never);
    },
    command: (name: string, args: string) => pi.runCommand(name, args, ctx.ctx),
    text: () => ctx.notifications.map((n) => n.text).join("\n"),
  };
}

test("RD1: /handoff ready attests the current generation and opens the renewal gate", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const s = session(fs, "sess-ready");
  await s.start();
  await s.command("handoff", "phase 1c readiness demo");

  // before attestation: technically current but semantically unattested
  await s.command("handoff", "verify");
  assert.match(s.text(), /readiness: unattested/);
  assert.match(s.text(), /renewal authorization \(Phase 2, not implemented\): NOT authorized — handoff readiness has not been attested/);

  const before = new Map(fs.files);
  await s.command("handoff", "ready");
  const text = s.text();
  assert.match(text, /handoff readiness: READY/);
  assert.match(text, /\[PASS\] checkpoint-current/);
  assert.match(text, /\[PASS\] identity-consistent/);
  assert.match(text, /\[PASS\] next-action-recorded/);
  assert.match(text, /\[PASS\] durable-files-valid/);
  assert.match(text, /attested g1-/);
  assert.match(text, /renewal authorization \(Phase 2, not implemented\): would be authorized/);

  const f = validateCheckpoint(fs, "/project", FILES);
  assert.equal(f.kind, "current");
  if (f.kind === "current") {
    assert.equal(f.readiness.state, "attested");
    assert.equal(f.readiness.checkpointId, f.identity!.id, "attestation is bound to the checkpoint id");
  }
  assert.equal(renewAuthorization(f).authorized, true);

  // attestation must not change the checkpoint's CONTENT or generation, only readiness
  assert.equal(before.get("/project/HANDOFF.md")!.split("### Last verified state")[1].split("<!-- guard:end")[0], fs.files.get("/project/HANDOFF.md")!.split("### Last verified state")[1].split("<!-- guard:end")[0], "managed body unchanged");
  const state = JSON.parse(fs.readFile("/project/.pi-guard/sessions/sess-ready.json")!);
  assert.equal(state.handoffReady, "attested", "readiness persisted in the v2 state file");
  assert.match(state.checkpointId, /^g1-/, "checkpoint id persisted");
});

test("RD2: readiness refuses a placeholder next action and writes nothing", async () => {
  const fs = createMemoryFs({
    ...DEFAULT_FILES,
    "/project/HANDOFF.md": DEFAULT_FILES["/project/HANDOFF.md"].replace("## Next action\nRun the test suite.", "## Next action\n(unknown — record the exact next action in PROGRESS.md)"),
  });
  const s = session(fs, "sess-placeholder");
  await s.start();
  await s.command("handoff", "auto-ish");
  // only DURABLE files matter here: runtime state persistence is legitimate
  const durableWrites = () => fs.writes.filter((w) => !w.startsWith("/project/.pi-guard")).length;
  const writesBefore = durableWrites();
  await s.command("handoff", "ready");
  assert.match(s.text(), /handoff readiness: NOT READY/);
  assert.match(s.text(), /\[FAIL\] next-action-recorded/);
  assert.match(s.text(), /ATTESTATION REFUSED/);
  assert.equal(durableWrites(), writesBefore, "a refused attestation writes no durable file");
  assert.equal(validateCheckpoint(fs, "/project", FILES).readiness.state, "unattested");
});

test("RD3: read-only audit mode never attests — an audit session with nothing to attest refuses, and one facing an existing checkpoint dry-runs with zero writes", async () => {
  // (a) audit session on a tree with NO checkpoint: the checkpoint itself is a dry run,
  //     so readiness legitimately FAILS and attestation is refused (nothing is written).
  const fs1 = createMemoryFs(DEFAULT_FILES);
  const snap1 = treeOf(fs1);
  const a1 = session(fs1, "audit-nockpt", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/tmp/guard-ready-state-a" } });
  await a1.start();
  await a1.command("handoff", "would-be checkpoint");
  await a1.command("handoff", "ready");
  assert.match(a1.text(), /readiness: NOT READY/);
  assert.match(a1.text(), /ATTESTATION REFUSED: checkpoint-current: checkpoint is missing/);
  assert.deepEqual(fs1.writes.filter((w) => w.startsWith("/project")), [], "no writes inside the audited tree (external state may persist)");
  assert.equal(treeOf(fs1), snap1, "audited tree byte-for-byte unchanged");

  // (b) a REAL checkpoint exists (written by a normal session); the audit session must
  //     report what it would attest without touching the audited tree.
  const fs2 = createMemoryFs(DEFAULT_FILES);
  const w = session(fs2, "writer");
  await w.start();
  await w.command("handoff", "written before the audit");
  await w.command("handoff", "ready");
  assert.match(w.text(), /\[PASS\] checkpoint-current/);
  const ckpt = validateCheckpoint(fs2, "/project", FILES);
  assert.equal(ckpt.kind, "current");
  const snap2 = treeOf(fs2);
  fs2.writes.length = 0;
  const a2 = session(fs2, "audit-withckpt", { env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: "/tmp/guard-ready-state-b" } });
  await a2.start();
  await a2.command("handoff", "ready");
  assert.match(a2.text(), /\[PASS\] checkpoint-current/, "the existing checkpoint evaluates as current");
  assert.match(a2.text(), /read-only audit mode: attestation NOT written \(dry run\)/);
  assert.deepEqual(fs2.writes.filter((w) => w.startsWith("/project")), [], "a dry-run attestation writes nothing inside the tree");
  assert.equal(treeOf(fs2), snap2, "audited tree byte-for-byte unchanged");
  assert.equal(validateCheckpoint(fs2, "/project", FILES).readiness.state, "attested", "attestation from the writing session survives the audit");
});

test("RD4: a new checkpoint generation voids the attestation; verify shows both classes", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const s = session(fs, "sess-void");
  await s.start();
  await s.command("handoff", "first");
  await s.command("handoff", "ready");
  assert.match(s.text(), /renewal authorization \(Phase 2, not implemented\): would be authorized/);
  await s.command("handoff", "second"); // new generation => readiness resets
  await s.command("guard", "verify-checkpoint");
  assert.match(s.text(), /readiness: unattested/);
  assert.match(s.text(), /NOT authorized — handoff readiness has not been attested/);
  assert.match(s.text(), /identity: g2-/, "verify names the transactional identity");
});

test("RD5: /guard status reports identity, readiness, provenance and the learnings warning", async () => {
  const fs = createMemoryFs(DEFAULT_FILES);
  const s = session(fs, "sess-status");
  await s.start();
  await s.command("handoff", "status demo");
  await s.command("guard", "status");
  const text = s.text();
  assert.match(text, /checkpoint: current g1-/);
  assert.match(text, /readiness unattested/);
  assert.match(text, /provenance: real/);
  assert.match(text, /usable remaining: \d+ = window - used - reserve/);
  assert.match(text, /NOT authorized/);
  // LEARNINGS.md untouched, and its unchanged baseline is visible as an inconsistency-free warning path
  assert.equal(fs.files.get("/project/LEARNINGS.md"), DEFAULT_FILES["/project/LEARNINGS.md"]);
  await s.command("handoff", "ready check");
  assert.match(s.text(), /\[WARN\] learnings-updated: LEARNINGS\.md unchanged since session start/);
  assert.match(s.text(), /evaluation only/, "/handoff ready check never attests");
});
