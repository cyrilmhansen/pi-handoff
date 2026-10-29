#!/usr/bin/env node
/**
 * Phase 1d real-runtime verification (out-of-band; zero inference).
 *
 * Proves, in the installed Pi 1.4.0 runtime, that:
 *   1. the project-local skill `.agents/skills/pi-handoff/SKILL.md` is DISCOVERED and
 *      advertised (`get_commands` lists it with source "skill", name "skill:pi-handoff",
 *      a description, and a project-scope sourceInfo path inside this repo);
 *   2. the frontmatter is valid enough that Pi loaded the skill at all (malformed
 *      SKILL.md files are silently not loaded — discovery IS the validation signal);
 *   3. the bundled reference files exist and are non-empty (the skill instructs the
 *      model to read them relative to the skill directory);
 *   4. the context-guard extension auto-loads from the TRUSTED project's
 *      `.pi/extensions/` (no -e needed) and its commands answer — the same check
 *      proves the permanent-install path documented in the guide (A-15 load class).
 *
 * Uses an ISOLATED PI_CODING_AGENT_DIR under /tmp: no user state touched, no model,
 * no inference. Extension commands are dispatched via `prompt` (handled without a
 * turn — A-19); we only read responses and ui notifications.
 *
 *   node scripts/check-skill-discovery.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(REPO, ".pi/extensions/context-guard/index.ts");
const SKILL_DIR = path.join(REPO, ".agents/skills/pi-handoff");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-skill-home-"));
// Project skills (and .pi/extensions auto-load) are TRUST-GATED:
// package-manager.js loads .agents/skills only when settingsManager.isProjectTrusted();
// trust store = <agentDir>/trust.json, keys canonicalized via realpath (trust-manager.js).
// We grant trust to THIS repo in the isolated dir only — the user's real trust store
// is untouched.
fs.writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify({ [fs.realpathSync(REPO)]: true }, null, 2) + "\n");
// No `-e`: the trusted project auto-loads .pi/extensions/context-guard/ — exactly the
// permanent-install path the guide documents.
const child = spawn("pi", ["--mode", "rpc"], {
  cwd: REPO,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const records = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* non-JSON */
    }
  }
});
const stderr = [];
child.stderr.on("data", (c) => stderr.push(String(c)));
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const waitFor = async (pred, ms, what) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = records.find(pred);
    if (hit) return hit;
    if (child.exitCode != null) throw new Error(`pi exited early (code ${child.exitCode}):\n${stderr.join("")}`);
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

let exitCode = 0;
try {
  // get_commands (core RPC command; safe before session_start): skills + extension commands must both be advertised.
  let cmds = null;
  for (let n = 0; n < 20 && !cmds; n++) {
    send({ id: `cmds-${n}`, type: "get_commands" });
    try {
      const res = await waitFor((r) => r.type === "response" && r.id === `cmds-${n}`, 5_000, "get_commands response");
      if (res.success) cmds = res.data?.commands ?? [];
    } catch {
      /* retry */
    }
  }
  if (!cmds) throw new Error("get_commands never succeeded");

  const skill = cmds.find((c) => c.source === "skill" && c.name === "skill:pi-handoff");
  check("skill discovered: skill:pi-handoff advertised by get_commands", !!skill, skill ? `description ${String(skill.description).length} chars` : "NOT LISTED");
  check("skill description present (routing signal; <=1024 chars)", !!skill && typeof skill.description === "string" && skill.description.length > 40 && skill.description.length <= 1024, skill ? `${String(skill.description).length} chars` : "");
  check("skill scope is project + path inside this repo", !!skill?.sourceInfo && String(skill.sourceInfo.path).startsWith(REPO), skill?.sourceInfo?.path ?? "");
  for (const f of ["SKILL.md", "references/commands.md", "references/bootstrap.md"]) {
    const p = path.join(SKILL_DIR, f);
    const st = fs.existsSync(p) ? fs.statSync(p) : null;
    check(`bundled file present + non-empty: ${f}`, !!st && st.size > 300, st ? `${st.size} bytes` : "missing");
  }

  const extCmds = cmds.filter((c) => c.source === "extension").map((c) => c.name);
  check("extension commands present (guard, handoff)", extCmds.includes("guard") && extCmds.includes("handoff"), extCmds.join(","));

  // The guard must actually answer (load proven beyond registration): poll /guard status.
  let answered = false;
  for (let n = 0; n < 20 && !answered; n++) {
    send({ id: `st-${n}`, type: "prompt", message: "/guard status" });
    try {
      await waitFor((r) => r.type === "response" && r.id === `st-${n}`, 5_000, "status response");
    } catch {
      /* continue polling */
    }
    answered = records.some((r) => r.type === "extension_ui_request" && r.method === "notify" && /context-guard status/.test(String(r.message ?? r.text ?? "")));
    if (!answered) await new Promise((r) => setTimeout(r, 500));
  }
  check("guard loaded in real runtime: /guard status answered with its report", answered);

  // /skill:pi-handoff must be dispatchable as a handled command (expands the skill
  // instructions into a user turn ONLY if a model ran — we send NOTHING that starts a
  // turn: extension/prompt commands with no model configured stay handled/no-op).
  // Discovery + file presence is the Phase 1d claim; model loading of the skill body
  // is documented Pi behavior (docs/skills.md) — NOT claimed here without inference.
} catch (e) {
  check("probe completed", false, String(e?.message ?? e).slice(0, 300));
  exitCode = 1;
} finally {
  try {
    child.stdin.end();
  } catch {}
  await new Promise((r) => (child.exitCode == null ? child.once("exit", r) : r()));
  if (!process.env.GUARD_E2E_KEEP) {
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
    } catch {}
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
process.exit(failed ? 1 : exitCode);
