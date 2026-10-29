#!/usr/bin/env node
/**
 * Zero-inference checkpoint refresh+attest on the CURRENT tree (post-commit ritual,
 * HANDOFF step 5). Spawns `pi --mode rpc -e <ext>` in the project dir, waits until the
 * guard answers /guard status (A-9/A-20 probe), dispatches /handoff <notes>,
 * /handoff ready, /handoff verify, prints the notifications, exits. NO prompts to the
 * model (extension commands are handled without starting a turn — A-19).
 *
 *   node scripts/refresh-checkpoint.mjs ["notes"]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(REPO, ".pi/extensions/context-guard/index.ts");
const notes = process.argv[2] ?? "post-commit checkpoint refresh";
const child = spawn("pi", ["--mode", "rpc", "-e", EXT], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const records = [];
child.stdout.on("data", (c) => {
  buf += String(c);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line.trim()) {
      try { records.push(JSON.parse(line)); } catch { /* non-JSON */ }
    }
  }
});
const stderr = [];
child.stderr.on("data", (c) => stderr.push(String(c)));
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const uiTexts = () => records.filter((r) => r.type === "extension_ui_request" && (r.method === "notify" || r.method === "terminal")).map((r) => String(r.message ?? r.text ?? ""));
const waitFor = async (pred, ms, what) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = records.find(pred);
    if (hit) return hit;
    if (child.exitCode != null) throw new Error(`pi exited (code ${child.exitCode}) before ${what}; stderr: ${stderr.join("").slice(0, 400)}`);
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const command = async (obj, ms = 60_000) => {
  send(obj);
  return waitFor((r) => r.type === "response" && r.id === obj.id, ms, `response ${obj.id}`);
};

// A-9: RPC startup race — probe until the guard ANSWERS.
for (;;) {
  if (uiTexts().some((t) => /context-guard status/.test(t))) break;
  await new Promise((r) => setTimeout(r, 500));
  const st = await command({ id: `probe-${Date.now()}`, type: "get_state" }).catch(() => null);
  if (st) send({ id: `pc-${Date.now()}`, type: "prompt", message: "/guard status" });
  if (child.exitCode != null) throw new Error("pi exited before the guard answered");
}
const before = uiTexts().length;
await command({ id: "ck", type: "prompt", message: `/handoff ${notes}` });
// wait for the checkpoint result notification
await waitFor(() => uiTexts().slice(before).some((t) => /context-guard \/handoff:/.test(t)), 60_000, "checkpoint notification");
const b2 = uiTexts().length;
await command({ id: "rd", type: "prompt", message: "/handoff ready" });
await waitFor(() => uiTexts().slice(b2).some((t) => /readiness|attest/i.test(t)), 60_000, "ready notification");
const b3 = uiTexts().length;
await command({ id: "vf", type: "prompt", message: "/handoff verify" });
await waitFor(() => uiTexts().slice(b3).some((t) => /freshness|checkpoint/i.test(t)), 60_000, "verify notification");
console.log(uiTexts().slice(before).map((t) => "NOTIFY: " + t.replace(/\n/g, "\n        ")).join("\n"));
child.stdin.end();
await new Promise((r) => (child.exitCode == null ? child.once("exit", r) : r()));
console.log("refresh-checkpoint done (zero inference)");
