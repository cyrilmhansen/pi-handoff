#!/usr/bin/env node
/**
 * Bounded Q3 transport diagnostic: at most one direct Sushi generation and, only
 * if that passes, one Pi RPC generation. Logs event metadata only, never prompts,
 * tool arguments, credentials, or transcript contents.
 *
 * Required: Q3_BASE_URL and Q3_MODEL. Use Q3_DIAG_LEG=all for the bounded direct
 * then Pi flow, or Q3_DIAG_LEG=pi with Q3_PRIOR_DIRECT_HTTP=200 to spend only the
 * Pi leg after an already observed direct HTTP 200. Run with TMPDIR set to a task-owned
 * /tmp/atlas-q3diag-<random> directory. Direct request: 24 output tokens / 20 s.
 * Pi RPC request: 24 output tokens / 30 s; retries are disabled for that session.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.Q3_BASE_URL;
const modelId = process.env.Q3_MODEL;
const leg = process.env.Q3_DIAG_LEG ?? "all";
const maxTokens = 24;
const directTimeoutMs = 20_000;
const piTimeoutMs = 30_000;
const expected = "Q3_SMOKE_OK";
const taskTmp = path.resolve(os.tmpdir());
if (!baseUrl || !modelId) throw new Error("Q3_BASE_URL and Q3_MODEL are required");
if (!path.basename(taskTmp).startsWith("atlas-q3diag-")) throw new Error("set TMPDIR to a task-owned /tmp/atlas-q3diag-<random> directory");
const trace = { piVersion: null, nodeVersion: process.version, modelId, maxTokens, direct: { events: [] }, pi: { events: [] } };
const startedAt = performance.now();
const add = (leg, event, fields = {}) => {
  trace[leg].events.push({ event, elapsedMs: Math.round(performance.now() - startedAt), ...fields });
};

async function smokeDirect() {
  const url = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  add("direct", "rpc_request_sent", { endpoint: url.origin, operation: "chat/completions", maxTokens, timeoutMs: directTimeoutMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), directTimeoutMs);
  const t0 = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer sushi", "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: `Return exactly ${expected}.` }],
        max_tokens: maxTokens,
        temperature: 0,
        reasoning_effort: "off",
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    add("direct", "provider_response_received", { status: response.status, headersMs: Math.round(performance.now() - t0), contentType: response.headers.get("content-type") });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      add("direct", "provider_error", { status: response.status });
      return { httpOk: false, passed: false };
    }
    if (!response.body) { add("direct", "provider_error", { reason: "response has no body" }); return { httpOk: false, passed: false }; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = null;
    let finishReason = null;
    let firstChunk = false;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!firstChunk) { firstChunk = true; add("direct", "first_stream_chunk", { msFromHeaders: Math.round(performance.now() - t0) }); }
      buffer += decoder.decode(part.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const item = JSON.parse(data);
          const delta = item.choices?.[0]?.delta?.content;
          if (typeof delta === "string") content += delta;
          if (item.usage) usage = item.usage;
          if (item.choices?.[0]?.finish_reason) finishReason = item.choices[0].finish_reason;
        } catch { add("direct", "provider_stream_parse_error"); }
      }
    }
    const ok = content.trim() === expected;
    add("direct", "provider_turn_completed", {
      durationMs: Math.round(performance.now() - t0),
      exactReply: ok,
      replyChars: content.length,
      finishReason,
      usage: usage && { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
    });
    return { httpOk: true, passed: ok, finishReason, usage };
  } catch (error) {
    add("direct", "provider_request_aborted_or_failed", { durationMs: Math.round(performance.now() - t0), error: String(error?.name ?? "Error"), message: String(error?.message ?? error).slice(0, 300) });
    return { httpOk: false, passed: false };
  } finally { clearTimeout(timer); }
}

function rpcPiArgs(agentDir) {
  const args = [
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/home", "--tmpfs", "/tmp", "--dir", "/tmp/q3", "--dir", "/tmp/q3/agent", "--dir", "/tmp/q3/project", "--dir", "/tmp/q3/state",
    "--bind", agentDir, "/tmp/q3/agent", "--ro-bind", repo, "/tmp/q3/project",
    "--chdir", "/tmp/q3/project", "--setenv", "HOME", "/tmp/q3/agent", "--setenv", "PI_CODING_AGENT_DIR", "/tmp/q3/agent",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "CONTEXT_GUARD_READONLY", "1", "--setenv", "CONTEXT_GUARD_STATE_DIR", "/tmp/q3/state",
    "pi", "--mode", "rpc", "--model", `sushi/${modelId}`, "--thinking", "off",
    "-e", "/tmp/q3/project/.pi/extensions/context-guard/index.ts", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--guard-readonly", "1",
  ];
  return args;
}

async function smokePi() {
  const agentDir = path.join(taskTmp, "agent");
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "sushi", defaultModel: modelId }, null, 2) + "\n");
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { sushi: {
    baseUrl, api: "openai-completions", apiKey: "sushi",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    models: [{ id: modelId, name: "Q3 isolated diagnostic", input: ["text"], contextWindow: 180000, maxTokens,
      thinkingLevelMap: { off: "off", minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" } }],
  } } }, null, 2) + "\n");

  const child = spawn("bwrap", rpcPiArgs(agentDir), { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  const stderr = [];
  const waiters = [];
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
          const compact = compactEvent(record);
          add("pi", "pi_event", compact);
          if (record.type === "message_update" && !trace.pi.firstStreamEvent) {
            trace.pi.firstStreamEvent = { elapsedMs: Math.round(performance.now() - startedAt), streamEvent: compact.streamEvent };
          }
        }
        for (const wake of waiters.splice(0)) wake();
      } catch { add("pi", "unparsed_stdout_line"); }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk).slice(0, 1000)));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  let seq = 0;
  const request = async (type, extra = {}, timeoutMs = 8000) => {
    const id = `q3diag-${++seq}-${randomUUID().slice(0, 6)}`;
    add("pi", "rpc_request_sent", { id, command: type });
    send({ id, type, ...extra });
    const response = await waitFor((r) => r.type === "response" && r.id === id, timeoutMs, `RPC ${type}`);
    add("pi", "rpc_response_received", { id, command: type, success: response.success, disposition: response.data?.disposition });
    return response;
  };
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = records.find(predicate);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi process exited waiting for ${label}`);
      await new Promise((resolve) => { const timer = setTimeout(resolve, 50); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const t0 = performance.now();
  let sessionFile = null;
  try {
    const ready = await waitFor((r) => r.type === "extension_ui_request" && String(r.message ?? "").includes("[context-guard identity]"), 10_000, "Pi identity banner");
    trace.pi.piVersion = /harness: pi ([0-9.]+)/.exec(String(ready.message ?? ""))?.[1] ?? "unknown";
    const state = await request("get_state");
    if (!state.success || state.data?.model?.id !== modelId || state.data?.model?.provider !== "sushi") throw new Error("Pi did not select the requested Sushi model");
    trace.pi.piModel = `${state.data.model.provider}/${state.data.model.id}`;
    trace.pi.sessionId = state.data.sessionId;
    trace.pi.compaction = { enabled: state.data.autoCompactionEnabled, isCompacting: state.data.isCompacting };
    sessionFile = state.data.sessionFile;
    await request("set_auto_retry", { enabled: false });
    const settledBefore = records.filter((r) => r.type === "agent_settled").length;
    const promptAt = performance.now();
    const prompt = await request("prompt", { message: `Reply exactly ${expected}; do not use tools.` }, 10_000);
    trace.pi.promptDisposition = prompt.data?.disposition ?? null;
    if (!prompt.success || prompt.data?.disposition !== "started") throw new Error(`Pi did not start the smoke prompt: ${prompt.data?.disposition ?? prompt.error}`);
    try {
      await waitFor((r) => r.type === "agent_settled" && records.filter((x) => x.type === "agent_settled").length > settledBefore, piTimeoutMs, "agent_settled");
      trace.pi.turnSettled = true;
    } catch (error) {
      trace.pi.turnSettled = false;
      add("pi", "turn_wait_expired", { timeoutMs: piTimeoutMs, error: String(error.message ?? error) });
      try {
        const current = await request("get_state", {}, 2500);
        trace.pi.stateAfterTimeout = { isStreaming: current.data?.isStreaming, isCompacting: current.data?.isCompacting, messageCount: current.data?.messageCount };
      } catch (stateError) { trace.pi.stateAfterTimeoutError = String(stateError.message ?? stateError); }
      trace.pi.processAliveAfterTimeout = child.exitCode === null && child.signalCode === null;
      try { await request("abort", {}, 2000); } catch { /* bounded shutdown follows */ }
    }
    trace.pi.turnDurationMs = Math.round(performance.now() - promptAt);
    if (sessionFile) trace.pi.sessionSummary = summarizeSessionFile(agentDir, sessionFile);
    trace.pi.expectedReplyObserved = records.some((r) => r.type === "message_end" && r.message?.role === "assistant" && contentText(r.message.content).trim() === expected);
    trace.pi.stderrClass = stderrClass(stderr.join(""));
  } catch (error) {
    trace.pi.setupOrRpcError = String(error.message ?? error);
    trace.pi.processAliveAtError = child.exitCode === null && child.signalCode === null;
    trace.pi.stderrClass = stderrClass(stderr.join(""));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await new Promise((resolve) => { const timer = setTimeout(resolve, 1500); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise((resolve) => { const timer = setTimeout(resolve, 1000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    trace.pi.exitCode = child.exitCode;
    trace.pi.signalCode = child.signalCode;
    trace.pi.elapsedMs = Math.round(performance.now() - t0);
  }
}

function compactEvent(record) {
  const event = { type: record.type };
  if (record.type === "message_start" || record.type === "message_end") event.role = record.message?.role;
  if (record.type === "message_update") {
    event.streamEvent = record.assistantMessageEvent?.type;
    event.deltaChars = typeof record.assistantMessageEvent?.delta === "string" ? record.assistantMessageEvent.delta.length : undefined;
    const u = record.usage;
    if (u) event.usage = { input: u.input, output: u.output, totalTokens: u.totalTokens };
  }
  if (record.type === "tool_execution_start" || record.type === "tool_execution_end") event.toolName = record.toolName;
  if (record.type === "agent_settled") event.aborted = record.aborted;
  if (record.type === "agent_end") event.willRetry = record.willRetry;
  if (record.type === "auto_retry_start" || record.type === "auto_retry_end") { event.attempt = record.attempt; event.success = record.success; }
  return event;
}
function contentText(content) { return Array.isArray(content) ? content.filter((x) => x.type === "text").map((x) => x.text ?? "").join("") : typeof content === "string" ? content : ""; }
function stderrClass(raw) {
  if (!raw.trim()) return "empty";
  if (/401|unauthorized|api.?key/i.test(raw)) return "authentication";
  if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(raw)) return "transport";
  if (/model.*not found|unknown model/i.test(raw)) return "model-selection";
  return "other";
}
function summarizeSessionFile(agentDir, sessionFile) {
  const pathInAgent = sessionFile?.replace(/^\/tmp\/q3\/agent\//, "");
  if (!pathInAgent || pathInAgent === sessionFile) return { available: false, reason: "session file path outside isolated agent directory" };
  const full = path.join(agentDir, pathInAgent);
  if (!fs.existsSync(full)) return { available: false, reason: "transcript absent" };
  const summary = { available: true, assistantMessages: 0, measuredInput: 0, measuredOutput: 0, errorMessages: 0 };
  for (const line of fs.readFileSync(full, "utf8").split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const message = row.message ?? row;
    if (message.role === "assistant") {
      summary.assistantMessages++;
      if (message.stopReason === "error" || message.stopReason === "aborted") summary.errorMessages++;
      const u = message.usage;
      if (Number.isFinite(u?.input)) summary.measuredInput += u.input;
      if (Number.isFinite(u?.output)) summary.measuredOutput += u.output;
    }
  }
  return summary;
}

let exitCode = 0;
try {
  if (!["all", "pi"].includes(leg)) throw new Error("Q3_DIAG_LEG must be all or pi");
  const modelUrl = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const modelResponse = await fetch(modelUrl, { signal: AbortSignal.timeout(5000) });
  const modelData = await modelResponse.json();
  const model = (modelData.data ?? []).find((row) => row.id === modelId && row.loaded === true && row.state === "ready");
  trace.providerReadiness = { status: modelResponse.status, modelReady: Boolean(model), contextLength: model?.context_length ?? null };
  if (!modelResponse.ok || !model) throw new Error("selected Sushi model is not loaded/ready; no generation attempted");
  let directResult = null;
  if (leg === "all") {
    directResult = await smokeDirect();
    trace.direct.passed = directResult.passed;
    trace.direct.httpOk = directResult.httpOk;
  } else {
    if (process.env.Q3_PRIOR_DIRECT_HTTP !== "200") throw new Error("Pi-only leg requires an already observed direct HTTP 200 and must not be used to bypass a direct provider failure");
    trace.direct.priorObservation = "HTTP 200, then finish_reason=length at max_tokens=24 with no visible text; direct request used provider default reasoning effort";
  }
  // A direct transport-level failure gates Pi. An HTTP-successful but output-
  // truncated direct smoke is inconclusive, not a provider transport failure;
  // the single Pi smoke is still allowed, but no Handoff transition is run.
  if (leg === "pi" || directResult?.httpOk) await smokePi();
  else trace.pi.skipped = "direct provider request did not return HTTP success; no Pi generation attempted";
  const piPassed = trace.pi.turnSettled === true && trace.pi.expectedReplyObserved === true;
  if (leg === "all" && directResult && !directResult.httpOk) trace.classification = "PROVIDER FAILURE";
  else if (leg === "all" && directResult && !directResult.passed && piPassed) trace.classification = "Q3 DRIVER FAILURE";
  else trace.classification = "INCONCLUSIVE";
  trace.pi.passed = piPassed;
  if ((leg === "all" && (!directResult?.passed || !piPassed)) || (leg === "pi" && !piPassed)) exitCode = 1;
} catch (error) {
  trace.classification = "INCONCLUSIVE";
  trace.setupError = String(error.message ?? error);
  exitCode = 1;
} finally {
  console.log(`Q3_DIAG_TRACE ${JSON.stringify(trace)}`);
}
process.exitCode = exitCode;
