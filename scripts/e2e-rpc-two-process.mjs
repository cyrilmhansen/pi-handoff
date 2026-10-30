#!/usr/bin/env node
/**
 * Phase 1c real-runtime verification (out-of-band; NOT part of `node --test`).
 *
 * Drives two (or three) REAL `pi --mode rpc -e <extension>` processes against one
 * temp project copy with an ISOLATED PI_CODING_AGENT_DIR, then asserts the durable
 * invariants that unit tests can only simulate:
 *
 *   1. distinct session ids per process, each owning exactly one `.pi-guard/sessions/<id>.json`;
 *   2. concurrent checkpoint writers leave both managed blocks parseable and, if
 *      `current`, sharing ONE transactional checkpoint-id (mixed generations are detected);
 *   3. a read-only audit session running beside the normal ones leaves its audited tree
 *      byte-for-byte identical — including legacy/corrupt/temp state it must NOT repair;
 *   4. readiness attestation and the renewal gate behave as specified in the real runtime.
 *
 * Zero inference by default: only `get_state` + extension slash-commands (disposition
 * "handled") are dispatched. Set GUARD_E2E_LLM=1 to additionally spend ONE minimal turn
 * and observe when a guard alert actually reaches the model (LEARNINGS A-2/A-13).
 *
 *   node scripts/e2e-rpc-two-process.mjs          # deterministic, no token spend
 *   GUARD_E2E=1 node --test test/processes.test.ts  # runs this file from the suite
 *
 * Artifact lifecycle (D7): every temp workspace (tree/audit/audit-intree/capped AND
 * the optional guard-e2e-llm-* workspace) is registered with the shared ArtifactTracker
 * AT CREATION, so cleanup covers setup errors, assertion failures, timeouts, normal
 * termination and SIGINT/SIGTERM/SIGHUP (tracked pi children are shut down BEFORE
 * their workspaces are removed). GUARD_E2E_KEEP === "1" is the ONLY retention value
 * ("0" removes, like every other value). SIGKILL and machine crashes cannot be
 * handled by any in-process code — a killed run may leak artifacts; later runs
 * deliberately do NOT sweep them (scripts/lib/e2e-cleanup.mjs).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactTracker, onceExited } from "./lib/e2e-cleanup.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(REPO, ".pi/extensions/context-guard/index.ts");
const tracker = new ArtifactTracker({ prefix: "guard-e2e-" });
tracker.installHandlers(); // SIGINT/SIGTERM/SIGHUP + 'exit' safety net, before any artifact exists
const { createLocalFs, validateCheckpoint, renewAuthorization, extractManagedSection, readBlockIdentity } = await import(path.join(REPO, ".pi/extensions/context-guard/checkpoint.ts"));

const DURABLE = ["GOAL.md", "PROGRESS.md", "LEARNINGS.md", "HANDOFF.md", "AGENTS.md", "handoff.config.json"];
const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function makeProject(tag) {
  // Registered with the tracker AT CREATION: if a validation below throws, the
  // half-built workspace is still owned and will be removed (D7 — previously dirs
  // created before the try/finally leaked on setup errors).
  const dir = tracker.createTempDir(tag);
  for (const f of DURABLE) {
    const src = path.join(REPO, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  if (!fs.existsSync(path.join(dir, "GOAL.md"))) throw new Error("temp project has no GOAL.md — cannot test GOAL protection");
  if (!fs.existsSync(path.join(dir, "handoff.config.json"))) throw new Error("temp project has no handoff.config.json — the guard would use fallback defaults");
  fs.mkdirSync(path.join(dir, ".pi-guard", "sessions"), { recursive: true });
  // pre-existing messy runtime state + a stale legacy checkpoint, so the audit run has
  // repairs it MUST suppress (LEARNINGS A-10) and staleness it must not silently fix.
  fs.writeFileSync(path.join(dir, ".pi-guard", "state.json"), JSON.stringify({ version: 1, sessionId: "foreign-legacy", updatedAt: 1, snapshot: { currentLevel: 1, alertedLevels: [1], unknownStreak: 0, degraded: false, lastRemaining: 29000, evaluations: 4 } }));
  fs.writeFileSync(path.join(dir, ".pi-guard", "state.json.tmp-9999-1111"), "junk");
  fs.writeFileSync(path.join(dir, ".pi-guard", "sessions", "zombie.json.tmp-1-1"), "junk");
  fs.writeFileSync(path.join(dir, ".pi-guard", "sessions", "corruptme.json"), '{"version":2,"sess');
  return dir;
}

function manifest(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`link ${path.relative(dir, p)} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** Minimal RPC client: JSONL on stdout, LF framing, correlated by request id.
 *  Children are tracked so cleanup shuts them down before removing workspaces. */
function startRpc({ dir, agentDir, env, label }) {
  const records = [];
  const waiters = [];
  const stderr = [];
  let spawnFailed = false;
  const child = tracker.trackChild(spawn("pi", ["--mode", "rpc", "-e", EXT], {
    cwd: dir,
    // agentDir === null => inherit the user's real PI_CODING_AGENT_DIR (needed for the
    // optional real-model branch); never mutated, only used to create a session.
    env: { ...process.env, ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }));
  child.on("error", (e) => {
    spawnFailed = true;
    stderr.push(`spawn error: ${e?.message ?? e}`);
  });
  const dead = () => child.exitCode != null || child.signalCode != null || spawnFailed;
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      records.push(rec);
      for (const w of waiters.splice(0)) w();
    }
  });
  child.stderr.on("data", (c) => stderr.push(String(c)));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = records.find(pred);
      if (hit) return hit;
      if (dead()) throw new Error(`${label}: pi exited (code ${child.exitCode ?? "spawn-failed"}) while waiting; stderr: ${stderr.join("").slice(0, 300)}`);
      if (Date.now() > deadline) throw new Error(`${label}: timeout waiting for ${pred.toString().slice(0, 60)}; got ${records.map((r) => r.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const command = async (obj) => {
    send(obj);
    return waitFor((r) => r.type === "response" && r.id === obj.id);
  };
  const uiTexts = () => records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message ?? r.text ?? ""));
  const shutdown = async () => {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    await onceExited(child);
  };
  return { child, records, stderr, send, waitFor, command, uiTexts, shutdown, label };
}

// LEARNINGS A-9: RPC commands dispatched before session_start complete hit an
// uninitialized extension. Poll /guard status until the guard ANSWERS with its report
// ("not initialized" is the pre-session_start answer; "context-guard status" proves
// session_start ran). This must not depend on any incidental startup notification:
// with a current checkpoint and no repairs to report, a session_start may notify nothing.
async function awaitReady(c) {
  const deadline = Date.now() + 90_000;
  let n = 0;
  for (;;) {
    if (c.uiTexts().some((t) => /context-guard status/.test(t))) return true;
    if (c.child.exitCode != null || c.child.signalCode != null) throw new Error(`${c.label}: pi exited early (code ${c.child.exitCode} signal ${c.child.signalCode}):\n${c.stderr.join("")}`);
    if (Date.now() > deadline) throw new Error(`${c.label}: guard never answered /guard status within 90s; stderr:\n${c.stderr.join("")}`);
    if (n++ % 8 === 0) {
      try {
        c.send({ id: `${c.label}-probe-${n}`, type: "prompt", message: "/guard status" });
      } catch {
        /* stdin closing */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

let exitCode = 0;
try {
  // All artifacts are created INSIDE the try and registered with the tracker at
  // creation (D7): a setup throw (missing GOAL.md, mkdir failure) can no longer
  // leak a directory that predates the try/finally.
  const root = tracker.createTempDir("home");
  const agentA = path.join(root, "agent-a");
  const agentB = path.join(root, "agent-b");
  const agentAudit = path.join(root, "agent-audit");
  const auditState = path.join(root, "audit-state");

  for (const d of [agentA, agentB, agentAudit, auditState]) fs.mkdirSync(d, { recursive: true });

  const tree = makeProject("tree");
  const auditTree = makeProject("audit");
  // ---- two normal sessions racing on ONE tree ----
  const a = startRpc({ dir: tree, agentDir: agentA, label: "A" });
  const b = startRpc({ dir: tree, agentDir: agentB, label: "B" });
  const [readyA, readyB] = [await awaitReady(a), await awaitReady(b)];
  check("A/B: guard loaded and initialized in real pi 1.4.0 (session_start done, /guard status answered)", readyA && readyB);

  const stA = await a.command({ id: "a-state", type: "get_state" });
  const stB = await b.command({ id: "b-state", type: "get_state" });
  const idA = stA.data?.sessionId;
  const idB = stB.data?.sessionId;
  check("A/B: real pi assigns distinct session ids", Boolean(idA) && Boolean(idB) && idA !== idB, `${idA} vs ${idB}`);

  // concurrent checkpoint writes from two processes
  const [hA, hB] = await Promise.all([
    a.command({ id: "a-ckpt", type: "prompt", message: "/handoff e2e session A" }),
    b.command({ id: "b-ckpt", type: "prompt", message: "/handoff e2e session B" }),
  ]);
  check("A/B: /handoff dispatched without starting a run (zero inference)", hA.success && hB.success, `${JSON.stringify(hA.data)} ${JSON.stringify(hB.data)}`);

  const [rA, rB] = await Promise.all([
    a.command({ id: "a-ready", type: "prompt", message: "/handoff ready" }),
    b.command({ id: "b-ready", type: "prompt", message: "/handoff ready check" }),
  ]);
  check("A/B: /handoff ready and /handoff ready check handled", rA.success && rB.success);

  await Promise.all([
    a.command({ id: "a-verify", type: "prompt", message: "/handoff verify" }),
    b.command({ id: "b-verify", type: "prompt", message: "/guard status" }),
    b.command({ id: "b-sim", type: "prompt", message: "/guard simulate 9000" }),
    a.command({ id: "a-sim", type: "prompt", message: "/guard simulate 4000" }),
    a.command({ id: "a-renew-status", type: "prompt", message: "/handoff renew status" }),
    a.command({ id: "a-renew-stop", type: "prompt", message: "/handoff renew stop" }),
    a.command({ id: "a-renew-try", type: "prompt", message: "/handoff renew e2e attempt" }),
    a.command({ id: "a-renew-resume", type: "prompt", message: "/handoff renew resume" }),
  ]);
  await new Promise((r) => setTimeout(r, 1500)); // let end-of-turn persistence settle

  const renewTexts = a.uiTexts().join("\n");
  check("RENEW(e2e): /handoff renew status reports policy + durable chain", /renewal status/.test(renewTexts) && /policy: enabled=/.test(renewTexts) && /renewalsDone=\d+\/\d+/.test(renewTexts));
  check("RENEW(e2e): renew status reports the PROJECT-CONFIGURED test command (dev.2 D1)", /testCommand=/.test(renewTexts), renewTexts.split("\n").find((l) => /testCommand=/.test(l))?.slice(0, 160) ?? "(no testCommand line)");
  check("RENEW(e2e): stop is durable and blocks the attempt; resume clears", /STOPPED/.test(renewTexts) && /NOT performed \(stopped\)/.test(renewTexts) && /RESUMED/.test(renewTexts));
  check("RENEW(e2e): no session switched without inference (session id unchanged)", (await a.command({ id: "a-state2", type: "get_state" })).data?.sessionId === idA);

  // ---- dev.2 D2: independent finalization in the REAL runtime, zero inference ----
  const renewStatePathTree = path.join(tree, ".pi-guard", "renewal-state.json");
  const renewStateBefore = fs.existsSync(renewStatePathTree) ? fs.readFileSync(renewStatePathTree, "utf8") : null;
  const fin = await a.command({ id: "a-fin", type: "prompt", message: "/handoff finalize e2e independent finalization" });
  await new Promise((r) => setTimeout(r, 800));
  const finTexts = a.uiTexts().join("\n");
  check("FINALIZE(e2e): /handoff finalize handled without a turn", fin.success && fin.data?.disposition === "handled", JSON.stringify(fin.data ?? fin.error));
  check("FINALIZE(e2e): compact structured report with ISO timestamp, checkpoint id, UNTOUCHED chain", /FINALIZE \(session .+, 20\d\d-\d\d-\d\dT\d\d:.+Z\): checkpoint g\d+-[0-9a-f]+ readiness .+ -> (FINALIZED|NOT READY)/.test(finTexts) && /UNTOUCHED/.test(finTexts), finTexts.split("\n").find((l) => /FINALIZE/.test(l))?.slice(0, 200) ?? "(no FINALIZE line)");
  check("FINALIZE(e2e): no session switch and chain state untouched", (await a.command({ id: "a-state3", type: "get_state" })).data?.sessionId === idA && (fs.existsSync(renewStatePathTree) ? fs.readFileSync(renewStatePathTree, "utf8") : null) === renewStateBefore);
  check("FINALIZE(e2e): readiness attested after finalize (authorization gate satisfied)", /readiness attested -> FINALIZED/.test(finTexts));
  check("RENEW(e2e): renewal-state.json persisted durably", fs.existsSync(path.join(tree, ".pi-guard", "renewal-state.json")) && /"stopped": false/.test(fs.readFileSync(path.join(tree, ".pi-guard", "renewal-state.json"), "utf8")));

  await a.shutdown();
  await b.shutdown();

  const sessions = fs.readdirSync(path.join(tree, ".pi-guard", "sessions")).filter((f) => f.endsWith(".json")).sort();
  check("A/B: each process owns exactly one per-session state file", sessions.includes(`${idA}.json`) && sessions.includes(`${idB}.json`), sessions.join(","));
  const own = (id) => JSON.parse(fs.readFileSync(path.join(tree, ".pi-guard", "sessions", `${id}.json`), "utf8"));
  check("A/B: no cross-overwrite (file contents name their own session)", own(idA).sessionId === idA && own(idB).sessionId === idB, `${own(idA).sessionId} / ${own(idB).sessionId}`);
  check("A/B: state files carry the Phase 1c audit fields", "checkpointId" in own(idA) && "handoffReady" in own(idA) && "learningsHash" in own(idA), JSON.stringify({ checkpointId: own(idA).checkpointId, handoffReady: own(idA).handoffReady }));
  const legacyGone = !fs.existsSync(path.join(tree, ".pi-guard", "state.json"));
  const foreign = fs.existsSync(path.join(tree, ".pi-guard", "sessions", "foreign-legacy.json"));
  const tmps = fs.readdirSync(path.join(tree, ".pi-guard")).concat(fs.readdirSync(path.join(tree, ".pi-guard", "sessions"))).filter((f) => f.includes(".tmp-"));
  check("A/B: normal mode still migrates legacy state and cleans temp files", legacyGone && foreign && tmps.length === 0, `legacyGone=${legacyGone} foreignPreserved=${foreign} tmps=${tmps.length}`);

  const handoff = fs.readFileSync(path.join(tree, "HANDOFF.md"), "utf8");
  const progress = fs.readFileSync(path.join(tree, "PROGRESS.md"), "utf8");
  check("A/B: no torn managed blocks under concurrency", (handoff.match(/<!-- guard:begin checkpoint -->/g) ?? []).length === 1 && (progress.match(/<!-- guard:end checkpoint -->/g) ?? []).length === 1);
  const f = validateCheckpoint(createLocalFs(), tree, FILES);
  const idH = readBlockIdentity(handoff).id;
  const idP = readBlockIdentity(progress).id;
  if (f.kind === "current") {
    check("A/B: 'current' implies one shared transactional id", idH === idP && f.partial === false, `${idH} / ${idP}`);
  } else {
    check("A/B: mixed generations are detected, never reported current", f.kind === "stale" && (f.partial === true || f.changed.length > 0), `${f.kind}: ${f.detail}`);
  }
  const auth = renewAuthorization(f);
  check("A/B: renewal authorization reflects readiness (Phase 2 gate)", auth.authorized === (f.kind === "current" && f.readiness?.state === "attested"), JSON.stringify(auth));
  const texts = a.uiTexts().concat(b.uiTexts()).join("\n");
  check("A/B: real runtime prints the detailed budget report", /usable remaining:/.test(texts) && /generation reserve:/.test(texts) && /provenance:/.test(texts));
  check("A/B: dev.2 D6 crossing line present with honest window ownership (crossings when known, explicit unavailable otherwise)", /threshold crossings/.test(texts) && /never changes/.test(texts), texts.split("\n").find((l) => /threshold crossings/.test(l))?.slice(0, 220) ?? "(no crossing line)");
  check("A/B: enforced closing reported at level 4", /ENFORCED closing/.test(texts) || /level 4/.test(texts));
  check("A/B: no extension errors in the real runtime", !/extension_error|ParseError|not defined/.test(texts + "\n" + a.stderr.join("") + b.stderr.join("")), (a.stderr.join("") + b.stderr.join("")).slice(0, 200));

  // ---- read-only audit session beside the (now finished) normal ones ----
  const before = manifest(auditTree);
  const audit = startRpc({ dir: auditTree, agentDir: agentAudit, env: { CONTEXT_GUARD_READONLY: "1", CONTEXT_GUARD_STATE_DIR: auditState }, label: "AUDIT" });
  await awaitReady(audit);
  await audit.command({ id: "au-state", type: "get_state" });
  await audit.command({ id: "au-status", type: "prompt", message: "/guard status" });
  await audit.command({ id: "au-ho", type: "prompt", message: "/handoff audit notes" });
  await audit.command({ id: "au-ready", type: "prompt", message: "/handoff ready" });
  await audit.command({ id: "au-sim", type: "prompt", message: "/guard simulate 4000" });
  await new Promise((r) => setTimeout(r, 1200));
  await audit.shutdown();
  const after = manifest(auditTree);
  check("AUDIT: audited tree byte-for-byte unchanged (no quarantine/migration/tmp cleanup)", JSON.stringify(before) === JSON.stringify(after), before.filter((l, i) => l !== after[i]).concat(after.filter((l, i) => l !== before[i])).join(" | ").slice(0, 300));
  const atexts = audit.uiTexts().join("\n");
  // With an EXTERNAL stateDir the guard never inspects the tree's stale `.pi-guard`,
  // so there is nothing to suppress here — the suppression reporting is proven by the
  // AUDIT-IN-TREE case below. What must hold here: no repair happens either way.
  check("AUDIT: external stateDir => no repair activity claimed for the audited tree", !/repair\(s\) suppressed/.test(atexts));
  check("AUDIT: checkpoint and attestation stay dry runs", /NOT written \(dry run/.test(atexts), atexts.split("\n").filter((l) => /dry run/.test(l))[0] ?? "(none)");
  check("AUDIT: pre-existing legacy/corrupt state inside the tree is left untouched", fs.existsSync(path.join(auditTree, ".pi-guard", "state.json")) && fs.existsSync(path.join(auditTree, ".pi-guard", "sessions", "corruptme.json")));
  check("AUDIT: runtime state persisted OUTSIDE the tree", fs.readdirSync(path.join(auditState, "sessions")).some((f) => f.endsWith(".json")));
  check("AUDIT: no extension errors in the real runtime", !/extension_error|ParseError|not defined/.test(atexts + audit.stderr.join("")), audit.stderr.join("").slice(0, 200));

  // ---- read-only audit session whose stateDir is INSIDE the audited tree: the
  // guard must neither repair nor announce a write (LEARNINGS A-10, real runtime) ----
  const intree = makeProject("audit-intree");
  const beforeIntree = manifest(intree);
  const audit2 = startRpc({ dir: intree, agentDir: path.join(root, "agent-audit2"), env: { CONTEXT_GUARD_READONLY: "1" }, label: "AUDIT-IN-TREE" });
  await awaitReady(audit2);
  await audit2.command({ id: "a2-status", type: "prompt", message: "/guard status" });
  await audit2.command({ id: "a2-ho", type: "prompt", message: "/handoff notes" });
  await audit2.command({ id: "a2-ready", type: "prompt", message: "/handoff ready" });
  await new Promise((r) => setTimeout(r, 1200));
  await audit2.shutdown();
  const t2 = audit2.uiTexts().join("\n");
  check("AUDIT-IN-TREE: tree byte-for-byte unchanged (no quarantine, migration or tmp cleanup)", JSON.stringify(beforeIntree) === JSON.stringify(manifest(intree)));
  check("AUDIT-IN-TREE: suppressed repairs are reported, not performed", /suppressed/.test(t2) && /repair/i.test(t2), t2.split("\n").find((l) => /repair/i.test(l))?.slice(0, 160) ?? "(no repair line: " + t2.slice(0, 120) + ")");
  check("AUDIT-IN-TREE: /guard status names the in-tree state dir as unpersistable", /READ-ONLY audit mode/.test(t2));

  // ---- dev.2 D2 dogfood proof: CAPPED-CHAIN FINALIZATION in the real runtime, zero ----
  // ---- inference. The exact DRPLi campaign closing scenario (A-27): cap 8/8        ----
  // ---- exhausted, obsolete checkpoint. Renewal must refuse at the cap BEFORE        ----
  // ---- waitForIdle (so the refusal itself is provably zero-inference), and finalize  ----
  // ---- must succeed anyway WITHOUT touching chain bytes or switching sessions.       ----
  const capTree = makeProject("capped");
  const capAgent = path.join(root, "agent-cap");
  fs.mkdirSync(capAgent, { recursive: true });
  const capStatePath = path.join(capTree, ".pi-guard", "renewal-state.json");
  const capSeed = JSON.stringify({ version: 1, chainId: "chain:capped-e2e", renewalsDone: 8, renewedFromCheckpointId: "g1-000000000000", lastSuccessorSessionId: null, stopped: false, updatedAt: 1 });
  fs.writeFileSync(capStatePath, capSeed);
  const cap = startRpc({ dir: capTree, agentDir: capAgent, label: "CAP" });
  await awaitReady(cap);
  const capId = (await cap.command({ id: "cap-state", type: "get_state" })).data?.sessionId;
  await cap.command({ id: "cap-renew", type: "prompt", message: "/handoff renew capped proof" });
  await new Promise((r) => setTimeout(r, 800));
  const capTexts = cap.uiTexts().join("\n");
  check("CAP: /handoff renew refused at the cap BEFORE any idle-wait or switch (zero inference)", /NOT performed \(capped\)/.test(capTexts) && /cap reached \(8\/8\)/.test(capTexts), capTexts.split("\n").find((l) => /NOT performed/.test(l))?.slice(0, 180) ?? "(no refusal line)");
  const finCap = await cap.command({ id: "cap-fin", type: "prompt", message: "/handoff finalize capped-chain proof" });
  await new Promise((r) => setTimeout(r, 800));
  const capFinTexts = cap.uiTexts().join("\n");
  check("CAP: finalize SUCCEEDS on an exhausted 8/8 chain (FINALIZED, chain UNTOUCHED, no switch claim)", finCap.success && finCap.data?.disposition === "handled" && /-> FINALIZED/.test(capFinTexts) && /UNTOUCHED/.test(capFinTexts) && /no session switch/.test(capFinTexts), capFinTexts.split("\n").find((l) => /FINALIZE/.test(l))?.slice(0, 200) ?? "(no finalize line)");
  check("CAP: renewal-state.json byte-identical after the whole capped closing (done stays 8/8, seed preserved)", fs.readFileSync(capStatePath, "utf8") === capSeed);
  check("CAP: same session at the end (finalize never switches)", (await cap.command({ id: "cap-state2", type: "get_state" })).data?.sessionId === capId);
  const rsBefore = cap.uiTexts().length;
  await cap.command({ id: "cap-rs", type: "prompt", message: "/handoff renew status" });
  await new Promise((r) => setTimeout(r, 500));
  const rsTexts = cap.uiTexts().slice(rsBefore).join("\n");
  check("CAP: renew status reports the exhausted chain 8/8", /renewalsDone=8\/8/.test(rsTexts), rsTexts.split("\n").find((l) => /renewalsDone=/.test(l))?.slice(0, 180) ?? "(no renewalsDone line)");
  await cap.shutdown();

  // ---- optional: ONE minimal real turn (spends inference; off by default) ----
  if (process.env.GUARD_E2E_LLM === "1") {
    // LIVE delivery check (spends real inference; opt-in only). Uses the user's real
    // agent dir read-only (a new session file is created; no settings are touched).
    // makeProject registers the guard-e2e-llm-* workspace with the tracker, so the
    // D7 cleanup removes it too (it was missing from the old hardcoded list).
    const llmTree = makeProject("llm");
    const llm = startRpc({ dir: llmTree, agentDir: null, label: "LLM" });
    await awaitReady(llm);
    await llm.command({ id: "l-reset", type: "prompt", message: "/guard reset" });
    const p = await llm.command({ id: "l-prompt", type: "prompt", message: "Call the bash tool exactly once with the command `echo ok`, then reply with the single word DONE." });
    check("LLM: prompt accepted", p.success, JSON.stringify(p.data ?? p.error));
    // dispatch the alert WHILE the run is streaming (extension commands execute
    // immediately during a run) — this is what must NOT interrupt the tool call.
    const mid = await llm.command({ id: "l-mid", type: "prompt", message: "/guard simulate 29000" });
    check("LLM: mid-run /guard simulate handled", mid.success && mid.data?.disposition === "handled", JSON.stringify(mid.data ?? mid.error));
    await llm.waitFor((r) => r.type === "agent_settled", 240_000);
    await new Promise((r) => setTimeout(r, 1000));
    const msgs = await llm.command({ id: "l-msgs", type: "get_messages" });
    const list = Array.isArray(msgs.data) ? msgs.data : (msgs.data?.messages ?? []);
    const flat = JSON.stringify(list);
    const toolRan = /echo ok/.test(flat) && /"ok"/.test(flat);
    const alertIdx = list.findIndex((m) => /CONTEXT PRESSURE/.test(JSON.stringify(m)));
    const toolIdx = list.findIndex((m) => /toolCall|tool_call|toolResult|bash/.test(JSON.stringify(m)));
    check("LLM: the in-flight tool call completed (alert never interrupted it)", toolRan, toolRan ? "" : "no echo ok/bash result in transcript");
    check("LLM: alert was appended to the transcript", alertIdx >= 0, `alertIdx=${alertIdx} of ${list.length}`);
    check("LLM: alert appended at/after the tool activity (boundary append, not preemption)", alertIdx < 0 || toolIdx < 0 || alertIdx >= toolIdx, `alertIdx=${alertIdx} toolIdx=${toolIdx}`);
    // Does the model actually SEE it on the next inference turn? (A-13)
    const ask = await llm.command({ id: "l-ask", type: "prompt", message: "Quote verbatim the most recent message you were given that begins with CONTEXT PRESSURE or CONTEXT CRITICAL. Reply with only the quote, or NONE if you never received one." });
    check("LLM: second prompt accepted", ask.success, JSON.stringify(ask.data ?? ask.error));
    await llm.waitFor((r) => r.type === "agent_settled", 240_000);
    const last = await llm.command({ id: "l-last", type: "get_last_assistant_text" });
    const reply = String(last.data?.text ?? "");
    check("LLM: the alert reached the model on a later turn (quoted back)", /CONTEXT PRESSURE|CONTEXT CRITICAL/.test(reply), reply.slice(0, 140).replace(/\n/g, " ") || "(empty)");
    await llm.shutdown();
  } else {
    console.log("SKIP  LLM turn (set GUARD_E2E_LLM=1 to spend one minimal real inference turn)");
  }
} catch (err) {
  exitCode = 1;
  check("e2e driver completed without throwing", false, err instanceof Error ? err.stack ?? err.message : String(err));
}
{
  // D7: single cleanup owner — shuts down any still-live tracked pi child BEFORE
  // removing the invocation-owned workspaces (tree, audit, audit-intree, capped,
  // llm-optional, home-root — ALL registered at creation, no hardcoded list);
  // GUARD_E2E_KEEP === "1" retains them for forensics.
  const report = await tracker.cleanup();
  if (report.kept && report.retained.length) console.log(`kept artifacts: ${report.retained.join(" ")}`);
  if (report.errors.length) console.log(`cleanup errors: ${report.errors.join("; ")}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed${failed.length ? " — FAILURES:\n" + failed.map((f) => `  * ${f.name}: ${f.detail}`).join("\n") : ""}`);
process.exit(failed.length > 0 ? 1 : exitCode);
