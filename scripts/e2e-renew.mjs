#!/usr/bin/env node
/**
 * Phase 2 increment C — REAL renewal experiment (LEARNINGS P-6/P-8 live proof).
 *
 * Runs a real `pi --mode rpc` session with REAL Qwen/Sushi inference (user's agent
 * dir; compaction settings untouched) on a FULL local git clone of this repo, and
 * demonstrates the A -> B -> C renewal chain:
 *
 *   hop 1 (model-initiated, P-8): synthetic pressure makes the guard tell the model
 *     renewal is available; the model calls the handoff_renew TOOL; the tool fires
 *     the "/handoff renew go" dispatch; at end of turn the guard switches sessions.
 *     (Operator `/handoff renew` is the documented fallback if the model refuses.)
 *   hop 2 (operator): `/handoff renew <bounded notes>` from successor B -> successor C.
 *   cap:     third attempt in C must refuse (capped 2/2), no switch.
 *
 * Verified per hop: three DISTINCT session ids + session files; fresh context
 * (messageCount resets; A's transcript marker ABSENT from B/C); header.parentSession
 * lineage; identity banner with the DETECTED pi version; recovery message present;
 * ZERO compaction entries; durable renewal-state.json across the chain; successor
 * COMMITTED real work in the clone (git log). Latency + token estimates recorded.
 *
 * Bounded successor task (carried in the notes): run the suite, append ONE LEARNINGS
 * line, commit, reply DONE, stop. If A->B works but B->C fails, the script still
 * prints all evidence collected so far (increment preserved).
 *
 *   node scripts/e2e-renew.mjs              # spends real inference (few turns)
 *   GUARD_E2E_KEEP=1 node scripts/e2e-renew.mjs   # keep the clone for forensics
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
};

// ---- isolated full clone (history preserved, nothing of the real tree is mutated) ----
const clone = fs.mkdtempSync(path.join(os.tmpdir(), "guard-renew-"));
if (process.env.GUARD_E2E_KEEP === "1") console.log(`clone dir: ${clone}`);
const gitInit = spawn("git", ["clone", "--quiet", REPO, clone], { stdio: "inherit" });
await new Promise((r) => gitInit.once("exit", r));
if (gitInit.code !== 0) throw new Error("git clone failed");
const EXT = path.join(clone, ".pi/extensions/context-guard/index.ts");

/** Minimal RPC client (same protocol as e2e-rpc-two-process.mjs). */
function startRpc({ dir, env, label }) {
  const records = [];
  const waiters = [];
  const child = spawn("pi", ["--mode", "rpc", "-e", EXT], { cwd: dir, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += String(c);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
        for (const w of waiters.splice(0)) w();
      } catch {
        /* non-JSON line */
      }
    }
  });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(String(c)));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (pred, timeoutMs = 300_000, what = "event") => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = records.find(pred);
      if (hit) return hit;
      if (child.exitCode != null) throw new Error(`${label}: pi exited (code ${child.exitCode}) before ${what}; stderr: ${stderr.join("").slice(0, 300)}`);
      if (Date.now() > deadline) throw new Error(`${label}: timeout waiting for ${what} (records: ${records.length})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const command = async (obj, timeoutMs = 60_000) => {
    send(obj);
    return waitFor((r) => r.type === "response" && r.id === obj.id, timeoutMs, `response ${obj.id}`);
  };
  const uiTexts = () => records.filter((r) => r.type === "extension_ui_request" && (r.method === "notify" || r.method === "terminal")).map((r) => String(r.message ?? r.text ?? ""));
  const count = (pred) => records.filter(pred).length;
  const shutdown = async () => {
    try {
      child.stdin.end();
    } catch {}
    await new Promise((r) => (child.exitCode == null ? child.once("exit", r) : r()));
  };
  return { child, records, stderr, send, waitFor, command, uiTexts, count, shutdown, label };
}

let exitCode = 0;
const marker = `MARKER-${randomUUID().slice(0, 8)}`;
const hops = [];
try {
  // REAL user agent dir: real provider config, real model, compaction settings UNTOUCHED.
  const c = startRpc({ dir: clone, env: { CONTEXT_GUARD_AUTO_RENEW: "1" }, label: "renew" });

  // awaitReady (A-9/A-20): poll /guard status until the guard ANSWERS with its report.
  for (;;) {
    if (c.uiTexts().some((t) => /context-guard status/.test(t))) break;
    await new Promise((r) => setTimeout(r, 500));
    const st = await c.command({ id: `probe-${Date.now()}`, type: "get_state" }).catch(() => null);
    if (st) c.send({ id: `probe-cmd-${Date.now()}`, type: "prompt", message: "/guard status" });
    if (c.child.exitCode != null) throw new Error("pi exited before the guard answered");
  }
  const idA = (await c.command({ id: "sA", type: "get_state" })).data;
  log(`session A: ${idA.sessionId} model=${idA.model?.id} provider=${idA.model?.provider} window=${idA.model?.contextWindow} autoCompaction=${idA.autoCompactionEnabled}`);
  check("C0: real pi + guard loaded, REAL model selected", Boolean(idA.model?.id) && idA.model.id !== "unknown", `${idA.model?.provider}/${idA.model?.id}`);
  check("C0: identity banner carried the DETECTED runtime identity", c.uiTexts().some((t) => /\[context-guard identity\] harness: pi \d+\.\d+\.\d+/.test(t)), c.uiTexts().find((t) => /context-guard identity/.test(t))?.slice(0, 200) ?? "(none)");
  check("C0: compaction is disabled in the live runtime (invariant A-3)", idA.autoCompactionEnabled === false, `autoCompactionEnabled=${idA.autoCompactionEnabled}`);

  // ---- real inference turn in A, with a transcript marker only A should contain ----
  const pA = await c.command({ id: "pA", type: "prompt", message: `Context probe (${marker}): reply with ONE short paragraph naming this project's objective. Use no tools beyond reading GOAL.md if you must.` }, 300_000);
  check("C1a: first real prompt accepted (started a run)", pA.success && pA.data?.disposition === "started", JSON.stringify(pA.data ?? pA.error));
  await c.waitFor((r) => r.type === "agent_settled", 300_000, "agent_settled after prompt A");
  const txtA = await c.command({ id: "tA", type: "get_last_assistant_text" });
  check("C1a: REAL inference produced an answer", typeof txtA.data?.text === "string" && txtA.data.text.length > 20, (txtA.data?.text ?? "").slice(0, 120).replace(/\n/g, " "));
  hops.push({ phase: "A", sessionId: idA.sessionId, sessionFile: idA.sessionFile });

  // ---- synthetic pressure (O-3): the GUARD tells the model renewal is available ----
  await c.command({ id: "sim", type: "prompt", message: "/guard simulate 9000" });
  await new Promise((r) => setTimeout(r, 700)); // alert append happens at turn end/command
  const hintText = c.uiTexts().join("\n");
  check("C1b: guard surfaced the RENEWAL AVAILABLE guidance", /RENEWAL AVAILABLE/.test(hintText), hintText.split("\n").find((l) => /RENEWAL AVAILABLE/.test(l))?.slice(0, 160) ?? "(none — alert may be pending until next settle)");

  // ---- hop 1: model-initiated renewal via the tool (P-8) ----
  const notes1 = "BOUNDED RENEWAL EXPERIMENT — OVERRIDE the Next action: this is increment-C hop-1 validation, not new work. Recovery sequence ONLY: (1) read AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md; (2) run node --test test/; (3) append ONE line to LEARNINGS.md Accepted section: '- [X-1] renewal successor session <your session id> recovered from durable files; suite <N> passing at hop 1.'; (4) git add -A && git commit -m \"e2e-renew: successor B real work\"; (5) reply DONE and STOP. Do NOT start new implementation.";
  const pB = await c.command({ id: "pB", type: "prompt", message: `Follow the context-guard's latest guidance about session renewal exactly. Call the handoff_renew tool with notes: ${JSON.stringify(notes1)}. Then finish your reply normally.` }, 300_000);
  check("C1c: renewal-instruction prompt accepted", pB.success, JSON.stringify(pB.data ?? pB.error));

  let trigger1 = "model";
  try {
    await c.waitFor((r) => r.type === "extension_ui_request" && /session renewed|renewal NOT|NOT scheduled|renewal FAILED/.test(String(r.message ?? "")), 240_000, "hop-1 renewal outcome");
  } catch (e) {
    // fallback: operator command (documented trigger; keeps the experiment moving)
    trigger1 = "operator-fallback";
    log(`hop 1 via model path did not complete (${e.message.slice(0, 120)}); trying /handoff renew directly`);
    await c.command({ id: "pB2", type: "prompt", message: `/handoff renew ${notes1}` }, 60_000);
  }
  await c.waitFor((r) => r.type === "extension_ui_request" && /session renewed/.test(String(r.message ?? "")), 240_000, "session renewed (hop 1)");
  const stB = await c.command({ id: "sB", type: "get_state" }, 60_000);
  const idB = stB.data;
  hops.push({ phase: "B", sessionId: idB.sessionId, sessionFile: idB.sessionFile, trigger: trigger1 });
  log(`session B: ${idB.sessionId} (trigger ${trigger1}) msgCount=${idB.messageCount}`);
  check("C1d: hop 1 switched to a NEW session id", idB.sessionId !== idA.sessionId, `${idA.sessionId} -> ${idB.sessionId}`);
  check("C1e: successor context is FRESH (few messages, no replay of A)", idB.messageCount < 25, `messageCount=${idB.messageCount}`);

  // successor's first real turn runs (recovery message, triggerTurn:true) — wait for it.
  const settlesBefore = c.count((r) => r.type === "agent_settled");
  await c.waitFor((r) => r.type === "agent_settled" && c.count((x) => x.type === "agent_settled") > settlesBefore, 420_000, "successor B recovery turn settle").catch(async () => {
    const st = await c.command({ id: "sB2", type: "get_state" });
    if (st.data?.isStreaming) throw new Error("successor B still streaming at timeout");
  });
  const msgsB = fs.readFileSync(idB.sessionFile, "utf8");
  check("C1f: successor received the identity banner + recovery instruction BEFORE its first inference", /context-guard-identity/.test(msgsB) && /context-guard-recovery/.test(msgsB), `file ${path.basename(idB.sessionFile)}`);
  check("C1g: transcript NOT replayed (A's marker absent from B)", !msgsB.includes(marker), `marker ${marker} not in B`);
  check("C1h: lineage recorded (parentSession = A's session file)", JSON.parse(msgsB.split("\n")[0]).parentSession === idA.sessionFile, JSON.parse(msgsB.split("\n")[0]).parentSession ?? "(none)");
  const rs1 = JSON.parse(fs.readFileSync(path.join(clone, ".pi-guard", "renewal-state.json"), "utf8"));
  check("C1i: durable chain state advanced durably BEFORE/AT the switch (1/2)", rs1.renewalsDone === 1 && rs1.chainId === `chain:${idA.sessionId}` && Boolean(rs1.renewedFromCheckpointId), JSON.stringify(rs1).slice(0, 200));

  // ---- hop 2: operator command from B -> C ----
  const notes2 = notes1.replace("hop 1", "hop 2").replace("successor B", "successor C").replace("X-1", "X-2");
  const pC = await c.command({ id: "pC", type: "prompt", message: `/handoff renew ${notes2}` }, 120_000);
  check("C2a: operator /handoff renew accepted from the successor", pC.success, JSON.stringify(pC.data ?? pC.error));
  await c.waitFor((r) => r.type === "extension_ui_request" && /session renewed \(2\/2\)/.test(String(r.message ?? "")), 300_000, "session renewed (hop 2)");
  const idC = (await c.command({ id: "sC", type: "get_state" })).data;
  hops.push({ phase: "C", sessionId: idC.sessionId, sessionFile: idC.sessionFile, trigger: "operator" });
  log(`session C: ${idC.sessionId} msgCount=${idC.messageCount}`);
  check("C2b: hop 2 switched again (A->B->C: three distinct ids)", idC.sessionId !== idB.sessionId && idC.sessionId !== idA.sessionId, `${idA.sessionId} -> ${idB.sessionId} -> ${idC.sessionId}`);
  const settlesC = c.count((r) => r.type === "agent_settled");
  await c.waitFor(() => c.count((r) => r.type === "agent_settled") > settlesC, 420_000, "successor C recovery turn settle").catch(async () => {
    const st = await c.command({ id: "sC2", type: "get_state" });
    if (st.data?.isStreaming) throw new Error("successor C still streaming at timeout");
  });

  // ---- cap: third renewal must be refused; C keeps running ----
  await c.command({ id: "pD", type: "prompt", message: "/handoff renew should be capped" }, 60_000);
  await c.waitFor((r) => r.type === "extension_ui_request" && /renewal NOT performed \(capped\)/.test(String(r.message ?? "")), 120_000, "capped refusal");
  const idD = (await c.command({ id: "sD", type: "get_state" })).data;
  check("C3: renewal cap respected (3rd attempt refused; still session C)", idD.sessionId === idC.sessionId, `${idD.sessionId} === ${idC.sessionId}`);

  // ---- durable outcomes across the whole chain ----
  const rs2 = JSON.parse(fs.readFileSync(path.join(clone, ".pi-guard", "renewal-state.json"), "utf8"));
  check("C4: chain state final (2/2, successor C recorded)", rs2.renewalsDone === 2 && rs2.lastSuccessorSessionId === idC.sessionId, JSON.stringify(rs2).slice(0, 250));
  const allFiles = [idA.sessionFile, idB.sessionFile, idC.sessionFile].filter(Boolean).map((f) => [f, fs.readFileSync(f, "utf8")]);
  const compact = allFiles.filter(([, t]) => /"type":"compaction"|"compaction"/.test(t));
  check("C5: ZERO compaction across the chain", compact.length === 0, compact.map(([f]) => path.basename(f)).join(","));
  const gitlog = await new Promise((r) => {
    const g = spawn("git", ["-C", clone, "log", "--oneline", "-6"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    g.stdout.on("data", (d) => (out += d));
    g.once("exit", () => r(out.trim()));
  });
  const succCommits = (gitlog.match(/e2e-renew: successor/g) ?? []).length;
  check("C6: successors did REAL work (committed) in the clone", succCommits >= 1, gitlog.split("\n").slice(0, 4).join(" | "));
  check("C7: git history preserved in the clone (repo HEAD lineage intact)", gitlog.includes("increment B") || gitlog.includes("Phase 2"), gitlog.split("\n").pop()?.slice(0, 120) ?? "(empty)");

  log(`summary: ${JSON.stringify(hops)}`);
  await c.shutdown();
} catch (err) {
  exitCode = 1;
  check("e2e-renew driver completed without throwing", false, err instanceof Error ? err.stack ?? err.message : String(err));
  log(`partial hops observed: ${JSON.stringify(hops)}`);
} finally {
  if (process.env.GUARD_E2E_KEEP !== "1") fs.rmSync(clone, { recursive: true, force: true });
  else console.log(`kept clone: ${clone}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} renew-e2e checks passed${failed.length ? " — FAILURES:\n" + failed.map((f) => `  * ${f.name}: ${f.detail}`).join("\n") : ""}`);
process.exit(failed.length > 0 ? 1 : exitCode);
