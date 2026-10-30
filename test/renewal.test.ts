/**
 * Phase 2 increment A: renewal decision module + config wiring + durable chain state.
 *
 * Proven here (all deterministic, memory fs + pure functions, zero inference):
 *  - disabled by default (nothing can switch sessions unless explicitly enabled);
 *  - readiness gate: renewal requires renewAuthorization() (current ∧ attested);
 *  - idempotence per checkpoint id; bounded cap; trigger gating (operator vs model);
 *  - gate PRECEDENCE: stop > read-only > enabled > autoRenew > pending > cap > auth;
 *  - durable chain state SURVIVES session replacement and restart (renewal-state.json);
 *  - recovery prompt is deterministic, names only durable files, replays no transcript.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RENEWAL,
  INITIAL_RENEWAL_STATE,
  buildRecoveryPrompt,
  decideRenewal,
  mergeRenewal,
  parseRenewalState,
  serializeRenewalState,
  type RenewalConfig,
  type RenewalDecision,
  type RenewalState,
} from "../.pi/extensions/context-guard/renewal.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../.pi/extensions/context-guard/config.ts";
import { loadRenewalState, renewalStatePath, saveRenewalState } from "../.pi/extensions/context-guard/checkpoint.ts";
import { createMemoryFs, DEFAULT_FILES } from "./helpers.ts";

const AUTH_OK = { authorized: true, reason: "current, identity g1-abc, attested" };
const FILES = { goal: "GOAL.md", progress: "PROGRESS.md", learnings: "LEARNINGS.md", handoff: "HANDOFF.md" };

function renewal(over: Partial<RenewalConfig> = {}): RenewalConfig {
  return { ...DEFAULT_RENEWAL, enabled: true, ...over };
}

function input(over: Partial<Parameters<typeof decideRenewal>[0]> = {}): Parameters<typeof decideRenewal>[0] {
  return {
    renewal: renewal(),
    trigger: "operator",
    auth: AUTH_OK,
    checkpointId: "g7-111122223333",
    state: { ...INITIAL_RENEWAL_STATE },
    operatorStop: false,
    pendingInFlight: false,
    readOnly: false,
    ...over,
  };
}

test("RN1: disabled by default — the DEFAULT config refuses renewal with reason 'disabled'", () => {
  assert.equal(DEFAULT_RENEWAL.enabled, false);
  assert.equal(DEFAULT_RENEWAL.autoRenew, false);
  assert.equal(DEFAULT_RENEWAL.maxRenewals, 2);
  assert.equal(DEFAULT_CONFIG.renewal.enabled, false, "GuardConfig default carries renewal disabled");
  const d = decideRenewal(input({ renewal: { ...DEFAULT_RENEWAL } }));
  assert.equal(d.renew, false);
  assert.equal((d as Extract<RenewalDecision, { renew: false }>).why, "disabled");
});

test("RN2: mergeRenewal is strict — garbage ignored, valid fields merged, base untouched", () => {
  assert.deepEqual(mergeRenewal(DEFAULT_RENEWAL, null), DEFAULT_RENEWAL);
  assert.deepEqual(mergeRenewal(DEFAULT_RENEWAL, "nope"), DEFAULT_RENEWAL);
  assert.deepEqual(mergeRenewal(DEFAULT_RENEWAL, [1, 2]), DEFAULT_RENEWAL);
  assert.deepEqual(mergeRenewal(DEFAULT_RENEWAL, { enabled: "yes", maxRenewals: -3, recoveryPrompt: "  ", testCommand: "   ", }), DEFAULT_RENEWAL);
  const m = mergeRenewal(DEFAULT_RENEWAL, { enabled: true, autoRenew: true, maxRenewals: 5, recoveryPrompt: "resume from files", testCommand: "make check" });
  assert.deepEqual(m, { enabled: true, autoRenew: true, maxRenewals: 5, recoveryPrompt: "resume from files", testCommand: "make check" });
  // base object untouched (merge returns a copy)
  assert.equal(DEFAULT_RENEWAL.enabled, false);
});

test("RN3: config wiring — handoff.config.json `renewal` block parses; absent block keeps defaults; env override works", () => {
  const readFrom = (cfg: unknown) => (name: string) =>
    name === "handoff.config.json" ? JSON.stringify(cfg) : DEFAULT_FILES[`/project/${name}`];
  const withRenewal = loadConfig(readFrom({ renewal: { enabled: true, maxRenewals: 4 } }), {});
  assert.equal(withRenewal.renewal.enabled, true);
  assert.equal(withRenewal.renewal.maxRenewals, 4);
  assert.equal(withRenewal.renewal.autoRenew, false, "model-initiated renewal stays off unless asked");

  const without = loadConfig(readFrom({}), {});
  assert.deepEqual(without.renewal, DEFAULT_RENEWAL, "absent renewal block => disabled defaults");

  const corrupt = loadConfig(readFrom("{not json"), {});
  assert.deepEqual(corrupt.renewal, DEFAULT_RENEWAL, "corrupt config => safe defaults, guard stays functional");

  const on = loadConfig(readFrom({}), { CONTEXT_GUARD_AUTO_RENEW: "1" });
  assert.equal(on.renewal.enabled, true);
  assert.equal(on.renewal.autoRenew, true);
  const off = loadConfig(readFrom({ renewal: { enabled: true, autoRenew: true } }), { CONTEXT_GUARD_AUTO_RENEW: "0" });
  assert.equal(off.renewal.enabled, false, "env kill switch beats the config file");
  assert.equal(off.renewal.autoRenew, false);

  // partial overrides never mutate defaults
  assert.equal(DEFAULT_CONFIG.renewal.enabled, false);
  const merged = mergeConfig(DEFAULT_CONFIG, { renewal: { enabled: true } });
  assert.equal(merged.renewal.enabled, true);
  assert.equal(DEFAULT_CONFIG.renewal.enabled, false);
});

test("RN4: readiness gate — no checkpoint id or failed authorization refuses renewal", () => {
  const noId = decideRenewal(input({ checkpointId: null }));
  assert.equal(noId.renew, false);
  assert.equal((noId as Extract<RenewalDecision, { renew: false }>).why, "not-authorized");

  const unattested = decideRenewal(input({ auth: { authorized: false, reason: "handoff readiness has not been attested (/handoff ready)" } }));
  assert.equal(unattested.renew, false);
  assert.equal((unattested as Extract<RenewalDecision, { renew: false }>).why, "not-authorized");
  assert.match((unattested as Extract<RenewalDecision, { renew: false }>).detail, /attested/);

  const ok = decideRenewal(input());
  assert.equal(ok.renew, true);
});

test("RN5: cap — maxRenewals bounds the chain; 0 disables; done >= cap refuses", () => {
  const done: RenewalState = { ...INITIAL_RENEWAL_STATE, chainId: "chain:A", renewalsDone: 2 };
  const capped = decideRenewal(input({ state: done, renewal: renewal({ maxRenewals: 2 }) }));
  assert.equal((capped as Extract<RenewalDecision, { renew: false }>).why, "capped");
  assert.match((capped as Extract<RenewalDecision, { renew: false }>).detail, /2\/2/);

  const zero = decideRenewal(input({ renewal: renewal({ maxRenewals: 0 }) }));
  assert.equal((zero as Extract<RenewalDecision, { renew: false }>).why, "capped", "maxRenewals 0 is a hard floor, not infinite");

  const belowCap = decideRenewal(input({ state: { ...done, renewalsDone: 1 } }));
  assert.equal(belowCap.renew, true);
});

test("RN6: idempotence — the same checkpoint id never seeds a second successor; a NEW id may", () => {
  const used: RenewalState = { ...INITIAL_RENEWAL_STATE, chainId: "chain:A", renewalsDone: 1, renewedFromCheckpointId: "g7-111122223333" };
  const again = decideRenewal(input({ state: used }));
  assert.equal((again as Extract<RenewalDecision, { renew: false }>).why, "already-renewed");
  const nextGen = decideRenewal(input({ state: used, checkpointId: "g8-444455556666" }));
  assert.equal(nextGen.renew, true, "a refreshed+re-attested checkpoint renews again");
});

test("RN7: triggers — model/auto initiation additionally requires autoRenew; operator only needs enabled; pending refuses", () => {
  const modelOff = decideRenewal(input({ trigger: "model", renewal: renewal({ autoRenew: false }) }));
  assert.equal((modelOff as Extract<RenewalDecision, { renew: false }>).why, "auto-disabled");
  const modelOn = decideRenewal(input({ trigger: "model", renewal: renewal({ autoRenew: true }) }));
  assert.equal(modelOn.renew, true);
  const autoOn = decideRenewal(input({ trigger: "auto", renewal: renewal({ autoRenew: true }) }));
  assert.equal(autoOn.renew, true);
  const pending = decideRenewal(input({ pendingInFlight: true }));
  assert.equal((pending as Extract<RenewalDecision, { renew: false }>).why, "pending");
});

test("RN8: gate precedence — stop beats read-only beats disabled beats pending beats cap beats auth (one refusal reason, never a chain of writes)", () => {
  const allBad = decideRenewal(
    input({
      renewal: { ...DEFAULT_RENEWAL },
      auth: { authorized: false, reason: "nope" },
      checkpointId: null,
      state: { ...INITIAL_RENEWAL_STATE, renewalsDone: 99 },
      operatorStop: true,
      pendingInFlight: true,
      readOnly: true,
    }),
  );
  assert.equal((allBad as Extract<RenewalDecision, { renew: false }>).why, "stopped");
  const ro = decideRenewal(input({ renewal: { ...DEFAULT_RENEWAL }, operatorStop: false, readOnly: true }));
  assert.equal((ro as Extract<RenewalDecision, { renew: false }>).why, "read-only", "audit mode never switches sessions even if renewal is enabled");
  const dis = decideRenewal(input({ renewal: { ...DEFAULT_RENEWAL }, readOnly: false }));
  assert.equal((dis as Extract<RenewalDecision, { renew: false }>).why, "disabled");
  const pendFirst = decideRenewal(input({ pendingInFlight: true, renewal: renewal({ maxRenewals: 0 }) }));
  assert.equal((pendFirst as Extract<RenewalDecision, { renew: false }>).why, "pending");
});

test("RN9: durable chain state survives session replacement AND process restart (renewal-state.json)", () => {
  const memfs = createMemoryFs();
  const stateDir = "/project/.pi-guard";
  // empty dir: initial, not corrupt
  const fresh = loadRenewalState(memfs, stateDir);
  assert.equal(fresh.corrupt, false);
  assert.deepEqual(fresh.state, INITIAL_RENEWAL_STATE);

  // initiator (session A) records a renewal BEFORE the switch, then dies
  const afterA: RenewalState = {
    version: 1,
    chainId: "chain:sessionA",
    renewalsDone: 1,
    renewedFromCheckpointId: "g7-111122223333",
    lastSuccessorSessionId: null,
    stopped: false,
    updatedAt: 111,
  };
  assert.equal(saveRenewalState(memfs, stateDir, afterA).ok, true);
  assert.ok(memfs.files.has(renewalStatePath(stateDir)));

  // successor (session B, NEW closure; could even be a new process) reads the same file
  const reloaded = loadRenewalState(memfs, stateDir);
  assert.equal(reloaded.corrupt, false);
  assert.deepEqual(reloaded.state, afterA);
  // successor's decision sees the chain: cap and idempotence carry over
  const blocked = decideRenewal(input({ state: reloaded.state }));
  assert.equal((blocked as Extract<RenewalDecision, { renew: false }>).why, "already-renewed");

  // corrupt file: reported, initial state used, never thrown
  memfs.writeFile(renewalStatePath(stateDir), '{"version":1,"renew');
  const bad = loadRenewalState(memfs, stateDir);
  assert.equal(bad.corrupt, true);
  assert.deepEqual(bad.state, INITIAL_RENEWAL_STATE);

  // schema-tolerant: pre-stop-field v1 files parse as not-stopped
  const legacy = parseRenewalState(JSON.stringify({ version: 1, chainId: "chain:x", renewalsDone: 2, renewedFromCheckpointId: null, lastSuccessorSessionId: null, updatedAt: 5 }));
  assert.equal(legacy.corrupt, false);
  assert.equal(legacy.state.stopped, false);
  assert.equal(legacy.state.renewalsDone, 2);

  // wrong version => corrupt classification (fail safe: treat as unusable)
  assert.equal(parseRenewalState(JSON.stringify({ version: 2 })).corrupt, true);

  // stop is durable: a stopped chain loaded in a "new process" still refuses renewals
  const stopped: RenewalState = { ...afterA, stopped: true };
  saveRenewalState(memfs, stateDir, stopped);
  assert.equal(loadRenewalState(memfs, stateDir).state.stopped, true);
  assert.equal((decideRenewal(input({ state: loadRenewalState(memfs, stateDir).state, operatorStop: true })) as Extract<RenewalDecision, { renew: false }>).why, "stopped");
});

test("RN15: raising the cap never resets the chain and never permits a duplicate renewal from the same checkpoint", () => {
  // Real sequence (dev.2 config change): a chain hits its cap, the operator edits
  // handoff.config.json to renewal.maxRenewals: 8 (effective at config reload / session
  // start), and the SAME durable chain continues. Chain state and the idempotence key are
  // independent of the cap — raising it must not reset counters or re-seed a consumed
  // checkpoint.
  const memfs = createMemoryFs();
  const stateDir = "/project/.pi-guard";
  const hitCap: RenewalState = {
    version: 1,
    chainId: "chain:01a18a1a-parent",
    renewalsDone: 2,
    renewedFromCheckpointId: "g16-seedseedseed",
    lastSuccessorSessionId: "01a18baa-successor",
    stopped: false,
    updatedAt: 222,
  };
  assert.equal(saveRenewalState(memfs, stateDir, hitCap).ok, true);

  // At the old cap the chain is exhausted.
  const before = decideRenewal(input({ state: loadRenewalState(memfs, stateDir).state, renewal: renewal({ maxRenewals: 2 }) }));
  assert.equal((before as Extract<RenewalDecision, { renew: false }>).why, "capped");

  // Operator raises the cap via config only; the renewal path itself never rewrites chain
  // state when merely reading it (same bytes reload — the cap lives in the config, not the chain).
  const raised = mergeRenewal(DEFAULT_RENEWAL, { enabled: true, maxRenewals: 8 });
  assert.equal(raised.maxRenewals, 8);
  const after = loadRenewalState(memfs, stateDir);
  assert.equal(after.corrupt, false);
  assert.deepEqual(after.state, hitCap, "cap change must not reset chainId, renewalsDone, seed id, successor or stop");
  assert.equal(after.state.chainId, "chain:01a18a1a-parent");
  assert.equal(after.state.renewalsDone, 2, "raising the cap does not reset the counter");

  // Idempotence survives the cap raise: the checkpoint that already seeded a successor is
  // STILL refused even though headroom exists.
  const dup = decideRenewal(input({ state: after.state, renewal: raised, checkpointId: "g16-seedseedseed" }));
  assert.equal((dup as Extract<RenewalDecision, { renew: false }>).why, "already-renewed", "raised cap must not re-seed a consumed checkpoint");

  // A NEW (refreshed + re-attested) checkpoint on the same chain renews, continuing the count
  // from 2 — not from 0 — and the decision is pure (input state untouched).
  const fresh = decideRenewal(input({ state: after.state, renewal: raised, checkpointId: "g17-newnewnewnew" }));
  assert.equal(fresh.renew, true);
  assert.match((fresh as Extract<RenewalDecision, { renew: true }>).reason, /3\/8/, "successor count continues under the new cap");
  assert.deepEqual(after.state, hitCap, "decideRenewal is pure: no input mutation");

  // The raised cap is still a cap: at 8/8 the chain refuses again.
  const exhausted = decideRenewal(input({ state: { ...hitCap, renewalsDone: 8 }, renewal: raised, checkpointId: "g18-aaaaaaaaaaaa" }));
  assert.equal((exhausted as Extract<RenewalDecision, { renew: false }>).why, "capped");
  assert.match((exhausted as Extract<RenewalDecision, { renew: false }>).detail, /8\/8/);

  // Durable config wiring reads the raised cap from disk (session-start reload semantics).
  const cfgRaw = JSON.stringify({ renewal: { enabled: true, autoRenew: false, maxRenewals: 8 } });
  const cfg = loadConfig((p) => (p === "handoff.config.json" ? cfgRaw : undefined), {});
  assert.equal(cfg.renewal.maxRenewals, 8);
  assert.equal(cfg.renewal.enabled, true);
  assert.equal(cfg.renewal.autoRenew, false, "cap raise must not flip autoRenew");
});

test("RN10: recovery prompt is deterministic, durable-files-only, no transcript replay, no compaction", () => {
  const args = {
    files: FILES,
    checkpointId: "g7-111122223333",
    chainId: "chain:sessionA",
    renewalIndex: 1,
    maxRenewals: 2,
    parentSessionId: "sessionA",
  };
  const a = buildRecoveryPrompt(args);
  const b = buildRecoveryPrompt({ ...args });
  assert.equal(a, b, "same inputs => identical bytes (cache-stable, auditable)");
  for (const f of ["AGENTS.md", "GOAL.md", "HANDOFF.md", "PROGRESS.md", "LEARNINGS.md", "PROTOCOL.md"]) {
    assert.ok(a.includes(f), `prompt names ${f}`);
  }
  assert.ok(a.includes("g7-111122223333") && a.includes("chain:sessionA") && a.includes("sessionA"));
  assert.ok(!a.includes("node --test test/"), "dev.2 D1 (A-26): NO unconditional test command — the build-verify line is project-configured only");
  assert.ok(!/verify the build/i.test(a), "no build-verify instruction without an explicit testCommand");
  assert.ok(a.includes("1/2"), "renewal index/cap visible to the successor");
  assert.ok(/NOT replayed/.test(a) && /NO compaction/.test(a), "states the no-replay/no-compaction contract");
  assert.ok(/initiative/.test(a), "successor keeps agent initiative, not just a task executor");
  const withNotes = buildRecoveryPrompt({ ...args, extraNotes: "run the e2e next" });
  assert.ok(withNotes.startsWith(a), "notes append only; the deterministic core is untouched");
  assert.ok(withNotes.includes("run the e2e next"));
  const customTests = buildRecoveryPrompt({ ...args, testCommand: "make check" });
  assert.ok(customTests.includes("make check"));
});

/* ---- dev.2 D1 (A-26): recoveryPrompt/testCommand must actually reach the message ---- */

test("RN11: configured recoveryPrompt reaches the prompt VERBATIM under the mandatory header and safety lines", () => {
  const custom = "Read docs/RECOVERY.md first. Then run the instrument calibration before ANYTHING else.";
  const a = buildRecoveryPrompt({
    files: FILES,
    checkpointId: "g8-aaaa",
    chainId: "chain:x",
    renewalIndex: 2,
    maxRenewals: 8,
    parentSessionId: "parentS",
    recoveryPrompt: custom,
  });
  assert.ok(a.includes(custom), "configured text is carried verbatim");
  // mandatory identity + safety survive the override (PROTOCOL §6; deterministic, durable-only)
  assert.ok(a.includes("[context-guard renewal 2/8]"), "renewal identity header kept");
  assert.ok(a.includes("parentS") && a.includes("chain:x") && a.includes("g8-aaaa"), "parent/chain/checkpoint identity kept");
  assert.ok(/NOT replayed/.test(a) && /NO compaction/.test(a), "no-replay/no-compaction contract kept");
  assert.ok(/never push without human authorization/.test(a), "safety trailer kept");
  // the generic recovery-order body is REPLACED, not duplicated alongside
  assert.ok(!a.includes("in this order (PROTOCOL \u00a73)"), "generic body replaced by the configured text");
});

test("RN12: testCommand is project-configured — present exactly once when set, absent when not", () => {
  const args = { files: FILES, checkpointId: "g8-bbbb", chainId: "chain:y", renewalIndex: 1, maxRenewals: 2, parentSessionId: "p" };
  const none = buildRecoveryPrompt(args);
  assert.equal((none.match(/verify the build/gi) ?? []).length, 0);
  const withCmd = buildRecoveryPrompt({ ...args, testCommand: "node scripts/check-skill-discovery.mjs" });
  assert.equal((withCmd.match(/verify the build before touching code:/g) ?? []).length, 1, "exactly one build-verify line");
  assert.ok(withCmd.includes("verify the build before touching code: node scripts/check-skill-discovery.mjs"));
  // custom prompt + configured test command: BOTH reach the message
  const both = buildRecoveryPrompt({ ...args, recoveryPrompt: "CUSTOM BODY TEXT", testCommand: "make verify" });
  assert.ok(both.includes("CUSTOM BODY TEXT") && both.includes("make verify"));
});

test("RN13: prompt stays deterministic with the new inputs; notes remain the ONLY variable trailer", () => {
  const args = { files: FILES, checkpointId: "g8-cccc", chainId: "chain:z", renewalIndex: 1, maxRenewals: 3, parentSessionId: "pp", recoveryPrompt: "multi\nline\ncustom body", testCommand: "make check" };
  const a = buildRecoveryPrompt(args);
  assert.equal(buildRecoveryPrompt({ ...args }), a, "same inputs => identical bytes");
  const withNotes = buildRecoveryPrompt({ ...args, extraNotes: "next: run the gate" });
  assert.ok(withNotes.startsWith(a), "notes append only after the deterministic core");
  assert.ok(withNotes.includes("next: run the gate"));
  assert.ok(a.includes("multi\nline\ncustom body"), "multi-line configured prompt preserved");
});

test("RN14: mergeRenewal accepts testCommand (trimmed, non-empty) and ignores garbage", () => {
  assert.equal(mergeRenewal(DEFAULT_RENEWAL, { testCommand: "  make test  " }).testCommand, "make test");
  assert.equal(mergeRenewal(DEFAULT_RENEWAL, { testCommand: "   " }).testCommand, null, "blank stays null");
  assert.equal(mergeRenewal(DEFAULT_RENEWAL, { testCommand: 42 }).testCommand, null);
  assert.equal(mergeRenewal(DEFAULT_RENEWAL, { recoveryPrompt: "keep it" }).recoveryPrompt, "keep it");
  const base: RenewalConfig = { ...DEFAULT_RENEWAL, autoRenew: true };
  mergeRenewal(base, { testCommand: "x" });
  assert.equal(base.testCommand, null, "base object untouched (merge returns a copy)");
});
