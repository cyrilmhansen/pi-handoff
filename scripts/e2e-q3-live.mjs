#!/usr/bin/env node
/**
 * Q3 bounded live qualification. Uses a disposable local clone, an isolated Pi
 * agent directory, an explicitly selected Sushi model, and Bubblewrap. Inside Pi,
 * the project is read-only except the selected mission, its state directory, and
 * (only in the operator publication phase) the shared knowledge registry. /home is
 * hidden, so DRPLi, the operator's Pi state, and credentials are not reachable.
 *
 * No fallback provider or operator fallback exists in the autonomous R1 leg. This
 * script is intentionally interactive only through fixed, logged RPC prompts; it
 * never runs git add/commit, never edits shared scientific files, and never alters
 * compaction settings. Use only after reviewing docs/qualification/predeploy-q3-live.md.
 *
 * Required: Q3_BASE_URL and Q3_MODEL matching a loaded /v1/models entry.
 * Optional: Q3_MAX_OUTPUT (default 2048; per completion), Q3_RUN (default all).
 * Planned budget: R1 max 4 prompts / 10 completions / 20,480 output tokens; D1
 * max 3 stages / 6 completions / 12,288 output tokens. The 2048 maxTokens setting
 * is per response. Aggregate completions/tokens are measured after a settled phase
 * where the session record exposes them; the aggregate plan is not a live kill switch.
 * The provider context is physically capped by its advertised context length.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactTracker, onceExited } from "./lib/e2e-cleanup.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "f4206dbc9fcab89b666bc8623cbe8477f8bd7c95";
const MODEL_MAX = Number(process.env.Q3_MAX_OUTPUT ?? 2048);
const MODEL = process.env.Q3_MODEL;
const BASE_URL = process.env.Q3_BASE_URL;
const RUN = process.env.Q3_RUN ?? "all";
const PREFIX = "Q3-R1-DURABLE-MARKER-7C91";
const EXPECTED_NEXT = `Read RESULT.txt and report its sole marker: ${PREFIX}.`;
const q = (s) => JSON.stringify(s);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const results = [];
const check = (name, ok, detail = "") => {
  const row = { name, ok: Boolean(ok), detail: String(detail).slice(0, 500) };
  results.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${row.detail}` : ""}`);
};

if (!BASE_URL || !MODEL || !Number.isSafeInteger(MODEL_MAX) || MODEL_MAX < 256 || MODEL_MAX > 4096) {
  console.error("Set Q3_BASE_URL, Q3_MODEL, and Q3_MAX_OUTPUT (256..4096); no inference was attempted.");
  process.exit(2);
}
if (process.env.GUARD_E2E_KEEP === "1") {
  console.error("Q3 does not retain temporary trees; preserve evidence in its report instead.");
  process.exit(2);
}
const requested = new Set(RUN === "all" ? ["r1", "r2", "d1", "m1"] : RUN.split(",").map((x) => x.trim()).filter(Boolean));
if ([...requested].some((x) => !["preflight", "r1", "r2", "d1", "m1"].includes(x))) throw new Error(`unknown Q3 phase: ${RUN}`);

// Put every nested ArtifactTracker directory below this task-owned /tmp/atlas root.
const taskTmp = path.resolve(os.tmpdir());
if (!path.basename(taskTmp).startsWith("atlas-q3-live-")) {
  console.error("Run with TMPDIR set to a task-owned /tmp/atlas-q3-live-<random> directory; no experiment was started.");
  process.exit(2);
}
const tracker = new ArtifactTracker({ prefix: "guard-q3-" });
tracker.installHandlers();
let root = "";
let agentDir = "";
let projectR1 = "";
let projectR2 = "";
let projectD1 = "";
let failureArtifactRoot = "";
let activeRpc = null;
let modelInfo = null;
let r1Outcome = { autonomous: "UNTESTED", operator: "UNTESTED", successor: "UNTESTED" };
let d1Outcome = "UNTESTED";
let r2Outcome = { missing: "UNTESTED", corrupt: "UNTESTED" };
let m1Outcome = "UNTESTED";
const observations = { sourceCommit: null, runtime: null, model: null, compaction: null, budgets: null, r1: {}, r2: {}, d1: {}, m1: {} };

function preserveFailedPhase(phase, project, error) {
  if (!project || !fs.existsSync(project)) return;
  failureArtifactRoot ||= fs.mkdtempSync(path.join("/var/tmp", `atlas-q3-failures-${process.pid}-`));
  const target = path.join(failureArtifactRoot, `${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  const missionId = phase === "d1" ? "q3-doc" : phase === "r1" ? "q3-r1" : "q3-r1";
  const candidates = [
    "handoff.config.json",
    `.pi-handoff/instances/${missionId}/mission.json`,
    `.pi-handoff/instances/${missionId}/HANDOFF.md`,
    `.pi-handoff/instances/${missionId}/PROGRESS.md`,
    `.pi-handoff/instances/${missionId}/LEARNINGS.md`,
    `.pi-guard/q3/instances/${missionId}/renewal-state.json`,
    `.pi-guard/q3/instances/${missionId}/documentation-cycle/state.json`,
  ];
  const hashes = Object.fromEntries(candidates.flatMap((rel) => {
    const full = path.join(project, rel);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? [[rel, hash(fs.readFileSync(full))]] : [];
  }));
  let cycleState;
  const cyclePath = path.join(project, `.pi-guard/q3/instances/${missionId}/documentation-cycle/state.json`);
  if (fs.existsSync(cyclePath)) {
    try {
      const value = readJson(cyclePath);
      cycleState = { phase: value.phase, cycleId: value.cycleId, baseRevision: value.baseRevision, baseFingerprint: value.baseFingerprint, goalFingerprint: value.goalFingerprint, updatedAt: value.updatedAt, planFile: value.planFile };
    } catch { cycleState = { corrupt: true }; }
  }
  fs.writeFileSync(path.join(target, "trace.json"), JSON.stringify({
    sourceCommit: BASE,
    phase,
    runtime: observations.runtime,
    model: observations.model,
    budgets: observations.budgets,
    errorClass: error instanceof Error ? error.name : "Error",
    errorCategory: /timeout/i.test(String(error?.message ?? error)) ? "timeout" : /refus|unavailable|corrupt/i.test(String(error?.message ?? error)) ? "refusal-or-state" : "other",
    rpcTrace: observations[phase]?.rpcTrace ?? [],
    stateFileHashes: hashes,
    documentationCycle: cycleState,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(`Q3_PRESERVED_FAILURE_ARTIFACTS ${target}`);
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, value) { fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n"); }
function chainPath(project, id) { return path.join(project, ".pi-guard", "q3", "instances", id, "renewal-state.json"); }
function missionPath(project, id) { return path.join(project, ".pi-handoff", "instances", id); }
function statePath(project, id) { return path.join(project, ".pi-guard", "q3", "instances", id); }
function sourceSessionPath(file) {
  const prefix = "/tmp/q3/agent";
  if (!file?.startsWith(prefix + "/")) throw new Error(`unexpected sandbox session path: ${file}`);
  return path.join(agentDir, file.slice(prefix.length + 1));
}

async function git(args, cwd = REPO) {
  return await new Promise((resolve, reject) => {
    const child = tracker.trackChild(spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }));
    let out = "", err = "";
    child.stdout.on("data", (x) => out += x);
    child.stderr.on("data", (x) => err += x);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(" ")} failed (${code}): ${err.slice(0, 500)}`)));
  });
}

async function capture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = tracker.trackChild(spawn(command, args, { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] }));
    let out = "", err = "";
    child.stdout.on("data", (x) => out += x);
    child.stderr.on("data", (x) => err += x);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${err.slice(0, 300)}`)));
  });
}

async function cloneProject(name) {
  const dir = path.join(root, name);
  const result = await git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", REPO, dir]);
  void result;
  await git(["checkout", "--quiet", "--detach", BASE], dir);
  return dir;
}

async function verifyProvider() {
  const url = new URL("models", BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Sushi model list returned HTTP ${response.status}`);
  const body = await response.json();
  modelInfo = (body.data ?? []).find((m) => m.id === MODEL && m.loaded === true && m.state === "ready");
  if (!modelInfo) throw new Error(`requested model ${MODEL} is not reported loaded/ready by ${url}`);
  if (!Number.isSafeInteger(modelInfo.context_length) || modelInfo.context_length <= MODEL_MAX) throw new Error("provider did not report a usable physical context length");
  observations.model = { provider: "sushi", endpoint: url.origin, id: modelInfo.id, contextLength: modelInfo.context_length, maxOutput: MODEL_MAX, state: modelInfo.state, loaded: modelInfo.loaded };
}

function prepareAgent(name = "agent-r1") {
  agentDir = path.join(root, name);
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "sushi", defaultModel: MODEL, hideThinkingBlock: true }, null, 2) + "\n");
  // No credential file or global agent config is copied. The isolated model entry
  // contains only the local Sushi sentinel key used by the existing reverse proxy.
  writeJson(path.join(agentDir, "models.json"), { providers: { sushi: {
    baseUrl: BASE_URL, api: "openai-completions", apiKey: "sushi",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    models: [{ id: MODEL, name: `${MODEL} (Q3 isolated)`, input: ["text"], contextWindow: modelInfo.context_length,
      maxTokens: MODEL_MAX, reasoning: true, thinkingLevelMap: { off: "off", minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" } }],
  } } });
}

function setupProject(project, id, { maxRenewals = 2, documentation = false } = {}) {
  const cfgPath = path.join(project, "handoff.config.json");
  const cfg = readJson(cfgPath);
  cfg.stateDir = ".pi-guard/q3";
  cfg.missionInstance = { id: null, workProfile: null };
  cfg.renewal = { ...(cfg.renewal ?? {}), enabled: true, autoRenew: true, maxRenewals, successorTurn: "custom" };
  cfg.documentation = { ...(cfg.documentation ?? {}), enabled: documentation, archiveDir: "docs/history" };
  writeJson(cfgPath, cfg);
  fs.mkdirSync(path.join(project, ".pi-handoff", "instances", id), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi-handoff", "knowledge", "proposals"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi-handoff", "knowledge", "records"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi-guard", "q3", "instances", id), { recursive: true });
}

function piArgs(project, options = {}) {
  const ids = new Set([...(options.ids ?? []), ...(options.id ? [options.id] : [])]);
  const readonlyIds = new Set(options.readonlyIds ?? []);
  const args = ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/home", "--tmpfs", "/tmp", "--dir", "/tmp/q3", "--dir", "/tmp/q3/agent", "--dir", "/tmp/q3/project",
    "--bind", agentDir, "/tmp/q3/agent", "--ro-bind", project, "/tmp/q3/project"];
  if (options.bootstrap) args.push("--bind", path.join(project, ".pi-guard", "q3"), "/tmp/q3/project/.pi-guard/q3");
  for (const id of ids) {
    const bind = readonlyIds.has(id) ? "--ro-bind" : "--bind";
    args.push(bind, missionPath(project, id), `/tmp/q3/project/.pi-handoff/instances/${id}`);
    if (!options.bootstrap) args.push(bind, statePath(project, id), `/tmp/q3/project/.pi-guard/q3/instances/${id}`);
  }
  if (options.knowledgeWritable) args.push("--bind", path.join(project, ".pi-handoff", "knowledge"), "/tmp/q3/project/.pi-handoff/knowledge");
  else if (fs.existsSync(path.join(project, ".pi-handoff", "knowledge"))) args.push("--ro-bind", path.join(project, ".pi-handoff", "knowledge"), "/tmp/q3/project/.pi-handoff/knowledge");
  args.push("--chdir", "/tmp/q3/project", "--setenv", "HOME", "/tmp/q3/agent", "--setenv", "PI_CODING_AGENT_DIR", "/tmp/q3/agent", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8");
  if (options.id) args.push("--setenv", "CONTEXT_GUARD_MISSION_INSTANCE", options.id);
  args.push("pi", "--mode", "rpc", "--model", `sushi/${MODEL}`, "--thinking", "low", "-e", "/tmp/q3/project/.pi/extensions/context-guard/index.ts", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,write,edit,bash,handoff_renew,handoff_inspect,handoff_knowledge");
  return args;
}

function startPi(project, options = {}) {
  const child = tracker.trackChild(spawn("bwrap", piArgs(project, options), { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] }));
  const records = [];
  const trace = [];
  const waiters = [];
  const stderr = [];
  const processStartedAt = performance.now();
  let firstStreamingEvent = false;
  const traceEvent = (event, fields = {}) => trace.push({ event, elapsedMs: Math.round(performance.now() - processStartedAt), ...fields });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line);
        records.push(record);
        if (record.type !== "response") {
          const event = { type: record.type };
          if (record.type === "message_start" || record.type === "message_end") event.role = record.message?.role;
          if (record.type === "message_update") {
            event.streamEvent = record.assistantMessageEvent?.type;
            const usage = record.usage;
            if (usage) event.usage = { input: usage.input, output: usage.output, totalTokens: usage.totalTokens };
            if (!firstStreamingEvent) { firstStreamingEvent = true; traceEvent("first_stream_event", { streamEvent: event.streamEvent }); }
          }
          if (record.type === "tool_execution_start" || record.type === "tool_execution_end") event.toolName = record.toolName;
          if (record.type === "agent_settled") event.aborted = record.aborted;
          if (record.type === "agent_end") event.willRetry = record.willRetry;
          if (record.type === "extension_ui_request") event.method = record.method;
          traceEvent("pi_event", event);
        }
        for (const wake of waiters.splice(0)) wake();
      } catch {}
    }
  });
  child.stderr.on("data", (x) => stderr.push(String(x)));
  child.on("error", (x) => stderr.push(`spawn error: ${x.message}`));
  const send = (data) => child.stdin.write(JSON.stringify(data) + "\n");
  const waitFor = async (pred, timeoutMs = 60000, description = "event", start = 0) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = records.slice(start).find(pred);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi exited before ${description}: ${stderr.join("").slice(0, 500)}`);
      await new Promise((resolve) => { const timer = setTimeout(resolve, 100); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    throw new Error(`timeout waiting for ${description}; Pi stderr: ${stderr.join("").slice(0, 500)}`);
  };
  let nextId = 0;
  const request = async (type, extra = {}, timeoutMs = 60000) => {
    const id = `q3-${++nextId}-${randomUUID().slice(0, 8)}`;
    const start = records.length;
    traceEvent("rpc_request_sent", { id, command: type, timeoutMs });
    send({ id, type, ...extra });
    try {
      const response = await waitFor((r) => r.type === "response" && r.id === id, timeoutMs, `RPC ${type}`, start);
      traceEvent("rpc_response_received", { id, command: type, success: response.success, disposition: response.data?.disposition });
      return response;
    } catch (error) {
      traceEvent("rpc_timeout", { id, command: type, timeoutMs, processAlive: child.exitCode === null && child.signalCode === null });
      throw error;
    }
  };
  const texts = () => records.filter((r) => r.type === "extension_ui_request" && ["notify", "terminal"].includes(r.method)).map((r) => String(r.message ?? r.text ?? ""));
  const command = async (text, pattern, timeoutMs = 60000) => {
    const start = records.length;
    const response = await request("prompt", { message: text }, timeoutMs);
    if (!response.success || response.data?.disposition !== "handled") throw new Error(`operator command was not handled: ${text} => ${JSON.stringify(response.data ?? response.error)}`);
    if (pattern) await waitFor((r) => r.type === "extension_ui_request" && pattern.test(String(r.message ?? "")), timeoutMs, `command notification /${text}`, start);
    return response;
  };
  const state = async () => {
    const response = await request("get_state");
    if (!response.success) throw new Error(`get_state failed: ${JSON.stringify(response.error)}`);
    return response.data;
  };
  const infer = async (message, timeoutMs = 120000) => {
    const settled = records.filter((r) => r.type === "agent_settled").length;
    const response = await request("prompt", { message }, timeoutMs);
    if (!response.success || response.data?.disposition !== "started") throw new Error(`inference was not started: ${JSON.stringify(response.data ?? response.error)}`);
    traceEvent("model_turn_accepted", { disposition: response.data.disposition });
    try {
      await waitFor((r) => r.type === "agent_settled" && records.filter((x) => x.type === "agent_settled").length > settled, timeoutMs, "model turn settle");
    } catch (error) {
      const diagnostics = await diagnosticSnapshot();
      error.q3Diagnostics = diagnostics;
      throw error;
    }
    return response;
  };
  const diagnosticSnapshot = async () => {
    let currentState = null;
    let stateError = null;
    try {
      const response = await request("get_state", {}, 2500);
      currentState = response.success ? { isStreaming: response.data?.isStreaming, isCompacting: response.data?.isCompacting, messageCount: response.data?.messageCount, sessionId: response.data?.sessionId } : null;
    } catch (error) { stateError = String(error.message ?? error); }
    return { processAlive: child.exitCode === null && child.signalCode === null, exitCode: child.exitCode, signalCode: child.signalCode, state: currentState, stateError, trace: [...trace], stderrClass: /401|unauthorized|api.?key/i.test(stderr.join("")) ? "authentication" : /ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(stderr.join("")) ? "transport" : stderr.length ? "other" : "empty" };
  };
  const shutdown = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.stdin.end(); } catch {}
    const exited = await Promise.race([onceExited(child).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
    if (!exited) { child.kill("SIGTERM"); await Promise.race([onceExited(child), new Promise((r) => setTimeout(r, 2000))]); }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const sessionText = async (st) => fs.readFileSync(sourceSessionPath(st.sessionFile), "utf8");
  const lastText = async () => (await request("get_last_assistant_text")).data?.text ?? "";
  return { child, records, trace, stderr, send, waitFor, request, command, state, infer, shutdown, texts, sessionText, lastText, diagnosticSnapshot, label: options.id ?? "bootstrap" };
}

async function rpcReady(rpc) {
  await rpc.waitFor((r) => r.type === "extension_ui_request" && /\[context-guard identity\]/.test(String(r.message ?? "")), 30000, "identity banner");
  const st = await rpc.state();
  const id = st.model?.id;
  if (id !== MODEL || st.model?.provider !== "sushi") throw new Error(`Pi selected an unexpected model: ${st.model?.provider}/${id}`);
  const identity = rpc.texts().find((t) => t.includes("[context-guard identity]")) ?? "";
  const piVersion = /harness: pi ([0-9.]+)/.exec(identity)?.[1] ?? "unknown";
  observations.runtime = { pi: piVersion };
  observations.compaction = { enabled: st.autoCompactionEnabled, isCompacting: st.isCompacting };
  check("isolated Pi RPC selected the requested Sushi model without inference", true, `${st.model.provider}/${id}; ${st.model.contextWindow} context; maxOutput=${st.model.maxTokens}`);
  check("Pi compaction setting observed and left unchanged", !st.isCompacting, `autoCompactionEnabled=${st.autoCompactionEnabled}; isCompacting=${st.isCompacting}`);
  return st;
}

function usage(sessionText) {
  const out = { measuredInput: 0, measuredOutput: 0, providerRecords: 0, completions: 0, compactions: 0 };
  for (const line of sessionText.split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "compaction" || row.compaction) out.compactions++;
    const message = row.message ?? row;
    if (message.role !== "assistant") continue;
    const u = message.usage ?? row.usage;
    if (!u || typeof u !== "object") continue;
    const input = u.input ?? u.inputTokens ?? u.prompt_tokens;
    const output = u.output ?? u.outputTokens ?? u.completion_tokens;
    if (Number.isFinite(input) || Number.isFinite(output)) {
      out.completions++;
      out.providerRecords++;
      out.measuredInput += Number.isFinite(input) ? input : 0;
      out.measuredOutput += Number.isFinite(output) ? output : 0;
    }
  }
  return out;
}

function extractChain(project, id) { return readJson(chainPath(project, id)); }
function extractNextAction(project, id) {
  const handoff = fs.readFileSync(path.join(missionPath(project, id), "HANDOFF.md"), "utf8");
  const lines = handoff.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Next action\s*$/.test(line));
  if (start < 0) return "";
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}
function extractCheckpointId(project, id) {
  const handoff = fs.readFileSync(path.join(missionPath(project, id), "HANDOFF.md"), "utf8");
  return /checkpoint-id:\s*([^\s]+)/.exec(handoff)?.[1] ?? null;
}

async function createMission(project, id, maxRenewals, documentation, prepareFiles) {
  setupProject(project, id, { maxRenewals, documentation });
  const bootstrap = startPi(project, { bootstrap: true, ids: [id] }); activeRpc = bootstrap;
  await rpcReady(bootstrap);
  await bootstrap.command(`/handoff instance create ${id}`, /created; initialized missing empty operational documents/);
  const initial = readJson(chainPath(project, id));
  check(`${id}: Q2 explicit bootstrap created a mission-bound initial chain`, initial.chainId.startsWith(`mission:${id}:`) && initial.renewalsDone === 0, `${initial.chainId} ${initial.renewalsDone}/${maxRenewals}`);
  await bootstrap.shutdown(); activeRpc = null;
  if (prepareFiles) prepareFiles(project, id);
  return startPi(project, { id });
}

async function checkMissionReady(rpc, project, id) {
  const st = await rpcReady(rpc);
  await rpc.command("/handoff status");
  const status = rpc.texts().join("\n");
  const chain = extractChain(project, id);
  check(`${id}: owner and initialized mission-bound chain visible before inference`, status.includes(`mission instance: ${id}`) && chain.chainId.startsWith(`mission:${id}:`) && chain.renewalsDone === 0, `${chain.chainId} ${chain.renewalsDone}`);
  return st;
}

async function runR1() {
  prepareAgent("agent-r1");
  projectR1 = await cloneProject("r1");
  setupProject(projectR1, "q3-r1", { maxRenewals: 2 });
  const rpc = await createMission(projectR1, "q3-r1", 2, false); activeRpc = rpc;
  const startState = await checkMissionReady(rpc, projectR1, "q3-r1");
  const sessionA = startState.sessionId;
  const ownerPath = path.join(missionPath(projectR1, "q3-r1"), ".owner.lock");
  const ownerA = fs.readFileSync(ownerPath, "utf8");

  const task = `Perform one bounded fixture task in mission q3-r1. Create RESULT.txt containing exactly "${PREFIX}\\n". Add one Completed bullet in this mission's PROGRESS.md citing RESULT.txt. Replace only the manual HANDOFF.md section "## Next action" with exactly: "${EXPECTED_NEXT}". Do not modify GOAL.md, project-root documents, LEARNINGS.md, code, config, Git, checkpoint blocks, or renewal state. Do not use git. After those durable edits, report the marker and stop.`;
  await rpc.infer(task, 120000);
  const resultPath = path.join(missionPath(projectR1, "q3-r1"), "RESULT.txt");
  const resultFile = fs.readFileSync(resultPath, "utf8");
  const nextAction = extractNextAction(projectR1, "q3-r1");
  check("R1 A: real Sushi turn created bounded durable work and set the manual Next action", resultFile === `${PREFIX}\n` && nextAction === EXPECTED_NEXT, `${resultFile.trim()} | ${nextAction}`);
  await rpc.command("/handoff checkpoint Q3 live R1 durable fixture", /context-guard \/handoff:/);
  await rpc.command("/handoff ready", /attested|READY/);
  const checkpointId = extractCheckpointId(projectR1, "q3-r1");
  if (!checkpointId) throw new Error("attested checkpoint has no persisted identity in the mission document");
  const verify = await rpc.command("/handoff verify", /checkpoint/);
  const cp = rpc.texts().slice(-3).join("\n");
  check("R1 A: checkpoint is current and attested before pressure", /current/.test(cp) && /attested/.test(cp), cp.slice(-300));
  const sessionAText = await rpc.sessionText(startState);
  const uA = usage(sessionAText);
  observations.r1.sessionA = { sessionId: sessionA, checkpointId, usage: uA, compaction: uA.compactions };
  if (uA.completions > 10 || uA.measuredOutput > 10 * MODEL_MAX) throw new Error("R1 exceeded its completion/output budget after task A; preserved by immediate reporting");
  void verify;

  await rpc.command("/guard simulate 9000");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const hint = fs.readFileSync(sourceSessionPath(startState.sessionFile), "utf8").split("\n").find((line) => line.includes("RENEWAL AVAILABLE")) ?? "";
  check("R1 L3/L4: the delivered model hint agrees with the real renewal gate", /RENEWAL AVAILABLE/.test(hint) && /customType/.test(hint), hint.slice(0, 350));

  const promptBefore = rpc.records.length;
  const requested = await rpc.infer("Follow the immediately preceding Handoff pressure guidance. For this single operator-authorized qualification, call handoff_renew exactly once with a short note that says this is the Q3 model-triggered transition. Do not edit files, do not call any other transition tool, and do not claim that the successor ran until it actually runs.", 120000);
  void requested;
  let renewOutcome;
  try { renewOutcome = await rpc.waitFor((r) => r.type === "extension_ui_request" && /session renewed|renewal NOT performed|renewal ABORTED/.test(String(r.message ?? "")), 120000, "autonomous renewal outcome", promptBefore); }
  catch (err) { throw new Error(`R1 autonomous request had no observed outcome; no operator fallback was attempted: ${err.message}`); }
  if (!/session renewed/.test(String(renewOutcome.message ?? ""))) {
    r1Outcome.autonomous = "FAIL";
    observations.r1.autonomousRefusal = String(renewOutcome.message).slice(0, 600);
    throw new Error(`R1 model-initiated renewal refused; preserving this result and not falling back: ${renewOutcome.message}`);
  }
  const stateB = await rpc.state();
  const sessionB = stateB.sessionId;
  const sessionBText = await rpc.sessionText(stateB);
  const chainB = extractChain(projectR1, "q3-r1");
  const recCountB = (sessionBText.match(/context-guard-recovery/g) ?? []).length;
  const ownerB = fs.readFileSync(ownerPath, "utf8");
  check("R1 A→B: observed Pi session switch, same chain, checkpoint consumed once, same mission owner", sessionB !== sessionA && chainB.renewalsDone === 1 && chainB.renewedFromCheckpointId === checkpointId && ownerB === ownerA, `${sessionA} -> ${sessionB}; ${chainB.renewalsDone}/2; consumed=${chainB.renewedFromCheckpointId}; owner-identical=${ownerA === ownerB}`);
  const userAEntriesB = sessionBText.split("\n").filter((line) => line.includes('"role":"user"')).join("\n");
  check("R1 B: recovery arrived once in a fresh, non-replayed context", recCountB === 1 && !userAEntriesB.includes(PREFIX) && stateB.messageCount < 30, `recovery=${recCountB}; messageCount=${stateB.messageCount}; replay-marker=${userAEntriesB.includes(PREFIX)}`);
  const textB = await rpc.lastText();
  check("R1 B: first successor turn executed the durable Next action", textB.includes(PREFIX), textB.slice(0, 240).replace(/\n/g, " "));
  observations.r1.sessionB = { sessionId: sessionB, consumedCheckpointId: chainB.renewedFromCheckpointId, ownerUnchanged: ownerA === ownerB, recoveryMessageCount: recCountB, messageCount: stateB.messageCount, lastAssistantText: textB.slice(0, 500), usage: usage(sessionBText) };
  r1Outcome.autonomous = "PASS";
  r1Outcome.successor = textB.includes(PREFIX) && recCountB === 1 ? "PASS" : "FAIL";

  const uB = usage(sessionBText);
  if (uA.completions + uB.completions >= 10 || uA.measuredOutput + uB.measuredOutput >= 10 * MODEL_MAX) {
    throw new Error("R1 reached its completion/output budget before B→C; operator transition was not started");
  }

  const operatorTask = `Q3 operator task: read the existing mission RESULT.txt, report the exact marker ${PREFIX}, and make no file changes. This operator instruction supplements the durable Next action; it does not grant authority beyond this fixture.`;
  const chainBeforeB = chainB;
  await rpc.command(`/handoff renew --task ${q(operatorTask)}`, /session renewed \(2\/2\)/, 120000);
  const stateC = await rpc.state();
  const sessionC = stateC.sessionId;
  const sessionCText = await rpc.sessionText(stateC);
  const chainC = extractChain(projectR1, "q3-r1");
  const ownerC = fs.readFileSync(ownerPath, "utf8");
  const recoveryC = (sessionCText.match(/context-guard-recovery/g) ?? []).length;
  check("R1 B→C: operator renewal reached cap 2/2 in a distinct session, preserving owner", sessionC !== sessionB && sessionC !== sessionA && chainC.renewalsDone === 2 && ownerC === ownerA, `${sessionB} -> ${sessionC}; ${chainC.renewalsDone}/2; owner-identical=${ownerC === ownerA}`);
  const textC = await rpc.lastText();
  check("R1 C: operator task and recovery provenance are present exactly once", recoveryC === 1 && sessionCText.includes(PREFIX) && textC.includes(PREFIX), `recovery=${recoveryC}; operator task observed=${sessionCText.includes("Q3 operator task")}; output=${textC.slice(0, 160)}`);
  const uC = usage(sessionCText);
  observations.r1.sessionC = { sessionId: sessionC, consumedCheckpointId: chainC.renewedFromCheckpointId, ownerUnchanged: ownerC === ownerA, recoveryMessageCount: recoveryC, operatorTaskObserved: sessionCText.includes("Q3 operator task"), lastAssistantText: textC.slice(0, 500), usage: uC };
  if (uC.completions + uA.completions + uB.completions > 10 || uC.measuredOutput + uA.measuredOutput + uB.measuredOutput > 10 * MODEL_MAX) throw new Error("R1 exceeded 10 completion/output budget");
  await rpc.command("/handoff renew Q3 third transition must be refused", /renewal NOT performed \(capped\)/);
  const stateAfterCap = await rpc.state();
  check("R1 cap: third request refused without a fourth session", stateAfterCap.sessionId === sessionC && extractChain(projectR1, "q3-r1").renewalsDone === 2, `${stateAfterCap.sessionId} ${extractChain(projectR1, "q3-r1").renewalsDone}/2`);
  r1Outcome.operator = sessionC !== sessionB && chainC.renewalsDone === 2 ? "PASS" : "FAIL";
  await rpc.shutdown(); activeRpc = null;
  observations.r1 = { ...observations.r1, sessionAUsage: uA, sessionBUsage: uB, sessionCUsage: uC, chainId: chainC.chainId, renewalsDone: chainC.renewalsDone, finalCheckpointId: chainC.renewedFromCheckpointId, compactions: uA.compactions + uB.compactions + uC.compactions, ownerTokenStable: ownerC === ownerA };
  if (observations.r1.compactions) throw new Error("R1 observed an automatic compaction; no more inference is allowed");
  check("R1: no compaction records across A→B→C", observations.r1.compactions === 0, `compactions=${observations.r1.compactions}; autoCompactionEnabled=${observations.compaction.enabled}`);
}

async function runR2() {
  if (!projectR2) {
    // R2 is independently runnable without depending on R1's partial project or
    // repeating its paid campaign. Build a
    // fresh Q2-bootstrapped source and attest a checkpoint using operator RPC only.
    prepareAgent("agent-r2-source");
    projectR2 = await cloneProject("r2-source");
    setupProject(projectR2, "q3-r2", { maxRenewals: 2 });
    const sourceRpc = await createMission(projectR2, "q3-r2", 2, false); activeRpc = sourceRpc;
    await sourceRpc.command("/handoff checkpoint Q3 R2 isolated source fixture", /context-guard \/handoff:/);
    await sourceRpc.command("/handoff ready", /attested|READY/);
    await sourceRpc.command("/handoff verify");
    const verification = sourceRpc.texts().slice(-3).join("\n");
    check("R2 source: independently bootstrapped checkpoint is current and attested", /current/.test(verification) && /attested/.test(verification), verification.slice(-300));
    if (!/current/.test(verification) || !/attested/.test(verification)) throw new Error("R2 source checkpoint did not verify current+attested");
    await sourceRpc.shutdown(); activeRpc = null;
  }
  const missing = path.join(root, "r2-missing");
  const corrupt = path.join(root, "r2-corrupt");
  fs.cpSync(projectR2, missing, { recursive: true, dereference: false });
  fs.cpSync(projectR2, corrupt, { recursive: true, dereference: false });
  const docsPaths = [".pi-handoff/instances/q3-r2/HANDOFF.md", ".pi-handoff/instances/q3-r2/PROGRESS.md"];
  for (const p of docsPaths) fs.chmodSync(path.join(missing, p), 0o644);
  const missState = chainPath(missing, "q3-r2");
  const beforeMissingDocs = docsPaths.map((p) => fs.readFileSync(path.join(missing, p), "utf8"));
  fs.unlinkSync(missState);
  prepareAgent("agent-r2-missing");
  const rpc = startPi(missing, { id: "q3-r2" }); activeRpc = rpc; const st = await rpcReady(rpc);
  await rpc.command("/handoff renew Q3 missing-state refusal", /renewal NOT performed|state-unavailable|MUTATIONS REFUSED/);
  const afterSt = await rpc.state();
  const missingUntouched = !fs.existsSync(missState) && docsPaths.every((p, i) => fs.readFileSync(path.join(missing, p), "utf8") === beforeMissingDocs[i]) && afterSt.sessionId === st.sessionId;
  check("R2 missing: attested checkpoint refuses renewal without new checkpoint/state/session", missingUntouched, `state remains absent; session ${afterSt.sessionId}`);
  r2Outcome.missing = missingUntouched ? "PASS" : "FAIL";
  observations.r2.missingDiagnostic = rpc.texts().filter((t) => /renewal|state unavailable|state-unavailable/i.test(t)).slice(-3);
  await rpc.shutdown(); activeRpc = null;

  const corruptState = chainPath(corrupt, "q3-r2");
  const badBytes = "{\"version\":1,\"renewalsDone\":0,\"broken\":true}\n";
  fs.writeFileSync(corruptState, badBytes);
  const docsBefore = docsPaths.map((p) => fs.readFileSync(path.join(corrupt, p), "utf8"));
  prepareAgent("agent-r2-corrupt");
  const rpc2 = startPi(corrupt, { id: "q3-r2" }); activeRpc = rpc2; const st2 = await rpcReady(rpc2);
  await rpc2.command("/handoff renew Q3 corrupt-state refusal", /renewal NOT performed|state-unavailable|MUTATIONS REFUSED/);
  const after2 = await rpc2.state();
  const corruptUntouched = fs.readFileSync(corruptState, "utf8") === badBytes && docsPaths.every((p, i) => fs.readFileSync(path.join(corrupt, p), "utf8") === docsBefore[i]) && after2.sessionId === st2.sessionId;
  check("R2 corrupt: original bytes retained; no checkpoint rewrite or successor", corruptUntouched, `state byte-identical=${fs.readFileSync(corruptState, "utf8") === badBytes}; session=${after2.sessionId}`);
  r2Outcome.corrupt = corruptUntouched ? "PASS" : "FAIL";
  observations.r2.corruptDiagnostic = rpc2.texts().filter((t) => /renewal|corrupt|state-unavailable/i.test(t)).slice(-3);
  await rpc2.shutdown(); activeRpc = null;
  observations.r2 = { ...observations.r2, stateWasCorrupt: badBytes, missingRefusal: r2Outcome.missing, corruptRefusal: r2Outcome.corrupt };
}

async function closeAndPublish() {
  let fixtureOnly = false;
  let rpc;
  if (!projectR1) {
    // M1 is runnable without inference on a disposable completed-work fixture.
    // This validates lifecycle/publication mechanics, not agent task quality.
    fixtureOnly = true;
    prepareAgent("agent-m1");
    projectR1 = await cloneProject("m1-fixture");
    setupProject(projectR1, "q3-r1", { maxRenewals: 2 });
    rpc = await createMission(projectR1, "q3-r1", 2, false, (project, id) => {
      const dir = missionPath(project, id);
      fs.writeFileSync(path.join(dir, "RESULT.txt"), `${PREFIX}\n`);
      const handoffFile = path.join(dir, "HANDOFF.md");
      const handoff = fs.readFileSync(handoffFile, "utf8").replace(/^## Next action\s*$/m, `## Next action\nRead RESULT.txt and report its sole marker: ${PREFIX}.`);
      fs.writeFileSync(handoffFile, handoff);
      const progressFile = path.join(dir, "PROGRESS.md");
      const progress = fs.readFileSync(progressFile, "utf8")
        .replace(/^## Completed\s*$/m, `## Completed\n- Recorded isolated Q3 fixture ${PREFIX} in RESULT.txt.`)
        .replace(/^## Next action\s*$/m, `## Next action\nRead RESULT.txt and report its sole marker: ${PREFIX}.`);
      fs.writeFileSync(progressFile, progress);
      const learningsFile = path.join(dir, "LEARNINGS.md");
      fs.writeFileSync(learningsFile, fs.readFileSync(learningsFile, "utf8").replace(/^## Proposed\s*$/m, `## Proposed\n\n- [Q3-M1] Isolated fixture marker is recorded in RESULT.txt; source is a disposable test artifact.\n`));
    }); activeRpc = rpc;
    await rpc.command("/handoff checkpoint Q3 M1 completed fixture", /context-guard \/handoff:/);
    await rpc.command("/handoff ready", /attested|READY/);
    await rpc.command("/handoff verify");
    const verified = rpc.texts().slice(-3).join("\n");
    check("M1 fixture: completed-work checkpoint current and attested", /current/.test(verified) && /attested/.test(verified), verified.slice(-300));
  }
  if (!rpc) {
    prepareAgent("agent-r1");
    // Re-open the coherent R1 copy after its prior process released its owner lock.
    rpc = startPi(projectR1, { id: "q3-r1", knowledgeWritable: true }); activeRpc = rpc; await rpcReady(rpc);
  }
  await rpc.command("/handoff finalize Q3 fixture complete", /FINALIZED|already finalized|checkpoint/);
  // Finalization may advance the checkpoint generation; attest that exact state
  // before planning the irreversible seal.
  await rpc.command("/handoff ready", /attested|READY/);
  await rpc.command("/handoff verify");
  await rpc.command("/handoff instance close plan");
  const closeText = rpc.texts().slice(-1)[0] ?? "";
  const closeFp = /approval fingerprint: ([a-f0-9]{64})/.exec(closeText)?.[1];
  if (!closeFp) throw new Error(`M1 close plan has no fingerprint: ${closeText}`);
  await rpc.command(`/handoff instance close --confirm ${closeFp} --reason ${q("Q3 isolated lifecycle fixture")}`);
  check("M1: explicit state-bound closure sealed the R1 mission", fs.existsSync(path.join(missionPath(projectR1, "q3-r1"), "closure.json")), fs.readFileSync(path.join(missionPath(projectR1, "q3-r1"), "closure.json"), "utf8").slice(0, 180));
  await rpc.shutdown(); activeRpc = null;

  // Bubblewrap bind mounts require existing source directories. These empty
  // directories carry no mission identity/state; the explicit command below
  // creates and initializes the new instance through the normal Q2 bootstrap.
  fs.mkdirSync(missionPath(projectR1, "q3-next"), { recursive: true });
  fs.mkdirSync(statePath(projectR1, "q3-next"), { recursive: true });
  const reader = startPi(projectR1, { id: "q3-r1", knowledgeWritable: true, ids: ["q3-next"], readonlyIds: ["q3-r1"] }); activeRpc = reader;
  await rpcReady(reader);
  await reader.command("/handoff instance status");
  const closedStatus = reader.texts().slice(-1)[0] ?? "";
  check("M1: Pi restart observes the sealed source as closed", /closed/i.test(closedStatus), closedStatus.slice(0, 300));

  const learnings = fs.readFileSync(path.join(missionPath(projectR1, "q3-r1"), "LEARNINGS.md"), "utf8");
  const evidence = fs.readFileSync(path.join(missionPath(projectR1, "q3-r1"), "RESULT.txt"), "utf8");
  const proposal = { schema: 1, id: "q3-fixture-result", missionId: "q3-r1", classification: "proposed",
    statement: `Disposable Q3 fixture file contains the exact marker ${PREFIX}.`,
    rationale: "This publication verifies source and evidence provenance only; it is not a scientific result.",
    source: { path: ".pi-handoff/instances/q3-r1/LEARNINGS.md", locator: "## Proposed", sha256: hash(learnings) },
    evidence: [{ path: ".pi-handoff/instances/q3-r1/RESULT.txt", sha256: hash(evidence), description: "isolated Q3 marker fixture" }] };
  const proposalPath = path.join(projectR1, ".pi-handoff/knowledge/proposals/q3-fixture.json");
  writeJson(proposalPath, proposal);
  await reader.command("/handoff knowledge plan q3-fixture");
  const planText = reader.texts().slice(-1)[0] ?? "";
  const fp = /approval fingerprint: ([a-f0-9]{64})/.exec(planText)?.[1];
  if (!fp || !/classification: proposed/.test(planText) || !/references verified/.test(planText) && !/evidence references=1/.test(planText)) throw new Error(`M1 knowledge plan failed source checks: ${planText}`);
  await reader.command(`/handoff knowledge publish q3-fixture --confirm ${fp}`);
  const publication = fs.readdirSync(path.join(projectR1, ".pi-handoff/knowledge/records", "q3-fixture-result"));
  check("M1: operator-approved publication from sealed source exists and is immutable", publication.length === 1, publication.join(","));

  // Create from an unselected bootstrap process. An active mission has an already
  // scoped stateDir; appending another mission id there would be the wrong path.
  // The source mission remains sealed/read-only, and no source Next action is copied.
  await reader.shutdown(); activeRpc = null;
  fs.mkdirSync(missionPath(projectR1, "q3-next"), { recursive: true });
  const bootstrap = startPi(projectR1, { bootstrap: true, ids: ["q3-next"], knowledgeWritable: true }); activeRpc = bootstrap;
  await rpcReady(bootstrap);
  await bootstrap.command("/handoff instance create q3-next");
  const newIdentity = path.join(missionPath(projectR1, "q3-next"), "mission.json");
  if (!fs.existsSync(newIdentity) || !fs.existsSync(chainPath(projectR1, "q3-next"))) {
    throw new Error(`M1 new mission bootstrap did not persist its identity and chain: ${bootstrap.texts().slice(-2).join(" | ")}`);
  }
  await bootstrap.shutdown(); activeRpc = null;
  check("M1: new mission starts with no inherited Next action", extractNextAction(projectR1, "q3-next") === "" && extractNextAction(projectR1, "q3-r1") === EXPECTED_NEXT, `new="${extractNextAction(projectR1, "q3-next")}"; source="${extractNextAction(projectR1, "q3-r1")}"`);
  await reader.shutdown(); activeRpc = null;
  const newReader = startPi(projectR1, { id: "q3-next", ids: ["q3-r1"], readonlyIds: ["q3-r1"] }); activeRpc = newReader;
  await rpcReady(newReader);
  await newReader.command("/handoff status");
  const newStatus = newReader.texts().join("\n");
  await newReader.command("/handoff knowledge list --mission q3-r1");
  const knowledgeText = newReader.texts().slice(-1)[0] ?? "";
  check("M1: new/other mission can consult published provenance", knowledgeText.includes("q3-fixture-result") && knowledgeText.includes("q3-r1"), knowledgeText.slice(0, 240));
  check("M1: new mission reports an empty independent Next action", extractNextAction(projectR1, "q3-next") === "" && /mission instance: q3-next/.test(newStatus), `${newStatus.slice(0, 200)}; next="${extractNextAction(projectR1, "q3-next")}"`);
  const chainNew = readJson(chainPath(projectR1, "q3-next"));
  observations.m1 = { fixtureOnly, closureFingerprint: closeFp, publicationId: publication[0].replace(/\.json$/, ""), newMissionChain: chainNew.chainId, newNextAction: extractNextAction(projectR1, "q3-next"), sourceNextAction: extractNextAction(projectR1, "q3-r1") };
  m1Outcome = chainNew.chainId.startsWith("mission:q3-next:") && observations.m1.newNextAction !== observations.m1.sourceNextAction ? "PASS" : "FAIL";
  await newReader.shutdown(); activeRpc = null;
}

async function runD1() {
  prepareAgent("agent-d1");
  projectD1 = await cloneProject("d1");
  setupProject(projectD1, "q3-doc", { maxRenewals: 0, documentation: true });
  const rpc = await createMission(projectD1, "q3-doc", 0, true, (project, id) => {
    const files = missionPath(project, id);
    const handoffFile = path.join(files, "HANDOFF.md");
    const progressFile = path.join(files, "PROGRESS.md");
    const next = "Audit this disposable documentation fixture; report NO_CHANGE if no justified consolidation exists.";
    const insert = (file) => {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      const index = lines.findIndex((line) => /^## Next action\s*$/.test(line));
      if (index < 0) throw new Error(`starter document has no Next action section: ${file}`);
      lines.splice(index + 1, 0, next);
      fs.writeFileSync(file, lines.join("\n"));
    };
    insert(handoffFile);
    insert(progressFile);
  }); activeRpc = rpc;
  const state = await checkMissionReady(rpc, projectD1, "q3-doc");
  await rpc.command("/handoff checkpoint Q3 documentation boundary", /context-guard \/handoff:/);
  await rpc.command("/handoff ready", /attested|READY/);
  const before = extractChain(projectD1, "q3-doc");
  check("D1: capped chain is at its configured boundary before the plan", before.renewalsDone === 0 && readJson(path.join(projectD1, "handoff.config.json")).renewal.maxRenewals === 0, `${before.renewalsDone}/0`);
  const planBase = await git(["rev-parse", "HEAD"], projectD1);
  const planBeforeSettled = rpc.records.filter((r) => r.type === "agent_settled").length;
  await rpc.command("/handoff cycle plan", /documentation cycle: plan mission started|cycle/, 180000);
  await rpc.waitFor((r) => r.type === "agent_settled" && rpc.records.filter((x) => x.type === "agent_settled").length > planBeforeSettled, 180000, "real documentation plan model turn");
  const chainAfterPlan = extractChain(projectD1, "q3-doc");
  const cycleStatePath = path.join(projectD1, ".pi-guard/q3/instances/q3-doc/documentation-cycle/state.json");
  const cycle = readJson(cycleStatePath);
  const artifact = fs.readFileSync(path.isAbsolute(cycle.planFile) ? cycle.planFile : path.join(projectD1, cycle.planFile), "utf8");
  const artHash = hash(artifact);
  const noChange = /^Result: NO_CHANGE$/m.test(artifact) && /^Target-Files: none$/mi.test(artifact);
  const metaGood = artifact.includes(`Cycle-ID: ${cycle.cycleId}`) && artifact.includes(`Base-Revision: ${cycle.baseRevision}`) && cycle.baseRevision === planBase && cycle.baseFingerprint.length === 64;
  const gitAfter = await git(["rev-parse", "HEAD"], projectD1);
  check("D1 plan: genuine Pi turn produced a base-bound, hashable plan", metaGood && artHash.length === 64 && gitAfter === planBase, `${cycle.phase} ${cycle.cycleId}; sha256=${artHash}; Git ${gitAfter}`);
  if (!noChange) {
    d1Outcome = "FAIL";
    observations.d1 = { phase: cycle.phase, planSha256: artHash, result: artifact.slice(0, 4000), reason: "plan was not the predefined NO_CHANGE fixture; approval/application stopped" };
    await rpc.shutdown(); activeRpc = null;
    throw new Error("D1 model proposed a change or malformed plan; no plan was approved or applied");
  }
  const targetNoChange = /^Target-Files: none$/mi.test(artifact) && /^Result: NO_CHANGE$/m.test(artifact);
  const planText = rpc.texts().join("\n");
  check("D1 approval gate: only exact NO_CHANGE plan with no targets is eligible", targetNoChange && metaGood, artifact.split("\n").slice(0, 6).join(" | "));
  await rpc.command(`/handoff cycle no-change ${artHash}`, /NO CHANGE recorded/);
  const beforeContinue = fs.readFileSync(chainPath(projectD1, "q3-doc"), "utf8");
  await rpc.command("/handoff finalize Q3 no-change boundary", /FINALIZED|already finalized|checkpoint/);
  await rpc.command("/handoff cycle continue", /new development chain|cycle complete|new chain/);
  const cycleDone = readJson(cycleStatePath);
  const chainFinal = readJson(chainPath(projectD1, "q3-doc"));
  const archive = path.isAbsolute(cycleDone.archivePath) ? cycleDone.archivePath : path.join(projectD1, cycleDone.archivePath);
  const preserved = fs.existsSync(archive) && JSON.parse(fs.readFileSync(archive, "utf8")).archivedRenewalState;
  const unchangedQuota = chainFinal.chainId === cycleDone.nextChainId && chainFinal.renewalsDone === 0 && chainFinal.renewedFromCheckpointId === null && beforeContinue !== fs.readFileSync(chainPath(projectD1, "q3-doc"), "utf8");
  check("D1 continue: explicit NO_CHANGE archived old chain and started a distinct zeroed chain", cycleDone.phase === "complete" && Boolean(preserved) && unchangedQuota, `${cycleDone.phase}; ${chainFinal.chainId}; old=${cycle.archivedRenewalState ?? "archived"}`);
  check("D1: documentation planning did not consume development renewal quota", chainAfterPlan.renewalsDone === before.renewalsDone, `${before.renewalsDone} -> ${chainAfterPlan.renewalsDone}`);
  const afterSt = await rpc.state();
  const planTextFile = fs.readFileSync(sourceSessionPath(afterSt.sessionFile), "utf8");
  const stats = usage(planTextFile);
  if (stats.completions > 6 || stats.measuredOutput > 6 * MODEL_MAX) throw new Error("D1 exceeded its completion/output budget; no subsequent stage was started");
  observations.d1 = { cycleId: cycle.cycleId, phase: cycleDone.phase, planSha256: artHash, planResult: "NO_CHANGE", revision: planBase, oldChain: cycleDone.archivedRenewalState ? JSON.parse(cycleDone.archivedRenewalState).chainId : null, newChain: chainFinal.chainId, oldCounter: before.renewalsDone, newCounter: chainFinal.renewalsDone, usage: stats, compactions: stats.compactions, quotaUnchangedDuringPlan: chainAfterPlan.renewalsDone === before.renewalsDone };
  d1Outcome = cycleDone.phase === "complete" && unchangedQuota && stats.compactions === 0 ? "PASS" : "FAIL";
  await rpc.shutdown(); activeRpc = null;
}

let exitCode = 0;
try {
  observations.sourceCommit = await git(["rev-parse", "HEAD"]);
  if (observations.sourceCommit !== BASE) throw new Error(`source commit mismatch: expected ${BASE}, got ${observations.sourceCommit}`);
  if (await git(["branch", "--show-current"]) !== "qual/predeploy-q3-live") throw new Error("not on qual/predeploy-q3-live");
  if (!fs.existsSync("/usr/bin/bwrap")) throw new Error("Bubblewrap is required to prevent access to DRPLi and operator state");
  observations.runtime = { node: process.version, pi: await capture("pi", ["--version"]) };
  await verifyProvider();
  root = tracker.createTempDir("artifacts-");
  observations.budgets = { nature: "planned aggregate limits; per-response maxTokens is enforced, cumulative usage is measured only after settlement and is not a live kill switch", R1: { maxPrompts: 4, maxCompletions: 10, maxOutputTokens: 10 * MODEL_MAX }, D1: { maxStages: 3, maxCompletions: 6, maxOutputTokens: 6 * MODEL_MAX }, modelMaxOutputPerCompletion: MODEL_MAX, contextLength: modelInfo.context_length };
  console.log(`Q3_BUDGET_BEFORE_INFERENCE ${JSON.stringify(observations.budgets)}`);
  if (requested.has("preflight")) {
    prepareAgent("agent-preflight");
    const project = await cloneProject("preflight");
    const rpc = await createMission(project, "q3-preflight", 2, false); activeRpc = rpc;
    await rpcReady(rpc);
    await rpc.command("/handoff status");
    const initial = readJson(chainPath(project, "q3-preflight"));
    check("Q3 no-inference preflight: Q2 bootstrap, mission chain, and status are readable", initial.chainId.startsWith("mission:q3-preflight:") && initial.renewalsDone === 0, `${initial.chainId} ${initial.renewalsDone}/2`);
    await rpc.shutdown(); activeRpc = null;
  }
  if (requested.has("r1")) {
    try { await runR1(); }
    catch (error) {
      if (r1Outcome.autonomous === "UNTESTED" && /autonomous|renewal outcome|renewal refused|tool/.test(String(error))) r1Outcome.autonomous = "FAIL";
      observations.r1.error = error instanceof Error ? error.message : String(error);
      observations.r1.rpcTrace = error?.q3Diagnostics?.trace ?? activeRpc?.trace ?? [];
      observations.r1.timeoutState = error?.q3Diagnostics ?? (activeRpc ? await activeRpc.diagnosticSnapshot().catch(() => null) : null);
      console.error(`Q3_R1_PARTIAL ${JSON.stringify(observations.r1)}`);
      if (activeRpc) { await activeRpc.shutdown().catch(() => {}); activeRpc = null; }
      try { preserveFailedPhase("r1", projectR1, error); } catch (saveError) { console.error(`Q3_R1_EVIDENCE_COPY_FAILED ${saveError instanceof Error ? saveError.message : String(saveError)}`); }
    }
  }
  if (requested.has("r2")) {
    try { await runR2(); }
    catch (error) { observations.r2.error = error instanceof Error ? error.message : String(error); console.error(`Q3_R2_PARTIAL ${JSON.stringify(observations.r2)}`); if (activeRpc) { await activeRpc.shutdown().catch(() => {}); activeRpc = null; } }
  }
  if (requested.has("m1")) {
    // Never seal or publish from an incomplete/failed R1 mission. Use the
    // deterministic completed-work fixture unless every R1 live stage passed.
    if (![r1Outcome.autonomous, r1Outcome.operator, r1Outcome.successor].every((status) => status === "PASS")) projectR1 = "";
    try { await closeAndPublish(); }
    catch (error) { m1Outcome = "FAIL"; observations.m1.error = error instanceof Error ? error.message : String(error); observations.m1.rpcTrace = activeRpc?.trace ?? []; observations.m1.timeoutState = activeRpc ? await activeRpc.diagnosticSnapshot().catch(() => null) : null; console.error(`Q3_M1_PARTIAL ${JSON.stringify(observations.m1)}`); if (activeRpc) { await activeRpc.shutdown().catch(() => {}); activeRpc = null; } try { preserveFailedPhase("m1", projectR1, error); } catch (saveError) { console.error(`Q3_M1_EVIDENCE_COPY_FAILED ${saveError instanceof Error ? saveError.message : String(saveError)}`); } }
  }
  if (requested.has("d1")) {
    try { await runD1(); }
    catch (error) { if (d1Outcome === "UNTESTED" && /model proposed|malformed plan/.test(String(error))) d1Outcome = "FAIL"; observations.d1.error ??= error instanceof Error ? error.message : String(error); observations.d1.rpcTrace = activeRpc?.trace ?? []; observations.d1.timeoutState = activeRpc ? await activeRpc.diagnosticSnapshot().catch(() => null) : null; console.error(`Q3_D1_PARTIAL ${JSON.stringify(observations.d1)}`); if (activeRpc) { await activeRpc.shutdown().catch(() => {}); activeRpc = null; } try { preserveFailedPhase("d1", projectD1, error); } catch (saveError) { console.error(`Q3_D1_EVIDENCE_COPY_FAILED ${saveError instanceof Error ? saveError.message : String(saveError)}`); } }
  }
  observations.r1Outcome = r1Outcome;
  observations.r2Outcome = r2Outcome;
  observations.d1Outcome = d1Outcome;
  observations.m1Outcome = m1Outcome;
  const completeSetRequested = ["r1", "r2", "d1", "m1"].every((phase) => requested.has(phase));
  const requiredStatuses = [
    r1Outcome.autonomous, r1Outcome.operator, r1Outcome.successor,
    r2Outcome.missing, r2Outcome.corrupt, d1Outcome, m1Outcome,
  ];
  const hasFailure = requiredStatuses.includes("FAIL");
  const allPass = requiredStatuses.every((status) => status === "PASS");
  observations.overallQualification = !completeSetRequested ? "UNTESTED" : hasFailure || !allPass ? "BLOCKED" : "PASS";
  if (!completeSetRequested) observations.overallQualificationReason = "partial Q3_RUN; required A–I live qualification remains untested";
  else if (!allPass) observations.overallQualificationReason = "one or more required phases failed or remained UNTESTED";
  console.log(`Q3_RESULT ${JSON.stringify(observations)}`);
  if (hasFailure || (completeSetRequested && observations.overallQualification !== "PASS")) exitCode = 1;
} catch (error) {
  exitCode = 1;
  observations.error = error instanceof Error ? error.stack ?? error.message : String(error);
  observations.r1Outcome = r1Outcome;
  observations.r2Outcome = r2Outcome;
  observations.d1Outcome = d1Outcome;
  observations.m1Outcome = m1Outcome;
  observations.overallQualification = ["r1", "r2", "d1", "m1"].every((phase) => requested.has(phase)) ? "BLOCKED" : "UNTESTED";
  observations.overallQualificationReason = "a required phase did not complete; no partial run is a Q3 qualification PASS";
  observations.budgets = { nature: "planned aggregate limits, not a live kill switch", R1: { maxPrompts: 4, maxCompletions: 10, maxOutputTokens: 10 * MODEL_MAX }, D1: { maxStages: 3, maxCompletions: 6, maxOutputTokens: 6 * MODEL_MAX }, modelMaxOutputPerCompletion: MODEL_MAX, contextLength: modelInfo?.context_length ?? null };
  console.error(`Q3_PARTIAL ${JSON.stringify(observations)}`);
} finally {
  if (activeRpc) await activeRpc.shutdown().catch(() => {});
  const report = await tracker.cleanup();
  if (report.errors.length) { console.error(`Q3_CLEANUP ${report.errors.join("; ")}`); exitCode = 1; }
  try { fs.rmSync(taskTmp, { recursive: true, force: true }); } catch (error) { console.error(`Q3 temp cleanup failed: ${error}`); exitCode = 1; }
}
process.exitCode = exitCode;
