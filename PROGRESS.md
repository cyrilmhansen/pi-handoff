# PROGRESS

## Current phase

Phase 2 (minimal automatic session renewal) — IN PROGRESS. **Increment A is COMPLETE**
(renewal session): `renewal.ts` decision module + durable chain state + config wiring
(`renewal` block via mergeRenewal, env CONTEXT_GUARD_AUTO_RENEW) + chain-state
persistence (`loadRenewalState`/`saveRenewalState` -> `<stateDir>/renewal-state.json`,
survives session replacement AND process restart) + formal `test/renewal.test.ts`
RN1-RN10: disabled-by-default, readiness gate (renewAuthorization), idempotence per
checkpoint id, cap, trigger gating, gate precedence (stop > read-only > enabled >
autoRenew > pending > cap > auth > idempotence), durability round-trips, recovery-prompt
determinism. Suite 118/119 (1 gated skip), real-runtime e2e 23/23.

Earlier this milestone: revocation fix (A-18) + renewal model-trigger path (A-19/P-8)
source-verified; increment-A design audit (A-17). **NOTHING SWITCHES SESSIONS YET**:
`/handoff renew` wiring (increment B) and the real A->B->C Qwen experiment
(increment C) are the remaining Phase 2 work — see HANDOFF "Next action".

## Completed

Phase 1 (original):
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.md.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint module,
  extension adapter, mock test harness; 36/36 tests; jiti + real Pi 1.4.0 RPC runtime
  verification (zero inference).

Phase 1b (this session):
- [x] Reproduced both audit defects deterministically: (A) the legacy schema-v1 managed
  block was unverifiable and `readRecoveryBundle` preferred it over newer manual prose
  (`nextFromCheckpoint ?? nextFromHandoff`) while `validateFile` only checked section
  headings — stale block + fresh prose both accepted as a valid handoff; (B) single-slot
  `.pi-guard/state.json` — audit session 01a18668 overwrote checkpoint session 01a1865b;
  live re-confirmed mid-session (auto-loaded trusted extension writes the tree every turn).
- [x] Checkpoint schema v2: managed blocks embed sha256 fingerprints of source state
  (goal, manual prose of progress/handoff with their own block stripped — non-circular,
  learnings, config); `validateCheckpoint()` classifies missing/corrupt/stale/current;
  stale names the changed sources; legacy v1 blocks are stale-with-reason.
- [x] Recovery precedence fixed: manual prose always wins; the checkpoint block supplies
  the next action only when verified current and no manual section exists; a stale block
  is a labelled last resort. Fixed heading-substring bug (`## Next action` matched inside
  the block's `### Next action`) and `sectionBody` stop-regex.
- [x] Per-session runtime state `sessions/<sessionId>.json` (version 2) + newest-wins
  migration of legacy `state.json`; retention pruning (`maxSessionStates`); corrupt-state
  quarantine is per-session. Migration executed on the real `.pi-guard/`.
- [x] Read-only audit mode (`readOnly` / `CONTEXT_GUARD_READONLY=1` / `--guard-readonly`):
  zero writes to the audited tree; checkpoints become reported dry runs; state can go
  outside the tree via `CONTEXT_GUARD_STATE_DIR`. Verified live against real Pi 1.4.0 RPC
  on a temp copy of the tree (byte-identical after the session) — and fixed a
  const-reassignment crash in the flag path found ONLY by the real-runtime run (the mock
  getFlag masked it in unit tests).
- [x] Tests extended: 55/55 pass (`test/freshness.test.ts`, `test/sessions.test.ts`,
  updated existing suites).

## Pending

- [ ] Phase 2 increment B: `/handoff renew` switch wiring + `handoff_renew` tool bridge.
- [ ] Phase 2 increment C: real-inference A -> B -> C renewal experiment + evidence.

- [ ] Human review of Phase 1b consolidation.
- [ ] Phase 2 renewal — deliberately NOT started (see PROTOCOL §6).
- [ ] Live interactive-session walkthrough of `/guard simulate` on a real Sushi model
  (RPC no-model verification done; real token-accounting observation still open).
- [ ] Real multi-process concurrency test of per-session state (NOT done; serial mocks only).

Phase 1c (completion session):
- [x] Diagnosed and fixed the extension load failure (`ParseError: Export
  'computeMeasurement' is not defined`, index.ts:560) — re-exported from `./core.ts`
  instead of through a removed import; verified in real Pi 1.4.0 RPC.
- [x] `writeCheckpoint` stamps ONE transactional identity (schema 3: generation, id, kind,
      content-delta, readiness) into BOTH managed blocks; interrupted/mixed/obsolete
      generations now validate as stale+partial, never current.
- [x] Automatic checkpoints preserve the previous substantive `Last verified state` /
      `Guard notes` (Phase 1b information-loss bug) and record `content-delta`.
- [x] `evaluateHandoffReadiness()` + `attestHandoff()` (blocking: checkpoint-current,
      identity-consistent, next-action-recorded, durable-files-valid; warnings:
      content-delta, learnings-updated); readiness is bound to the checkpoint id and is
      separate from technical currency; `renewAuthorization()` is the Phase 2 gate.
- [x] Audit mode is genuinely non-mutating on the REAL filesystem: `loadGuardState(…,
      {readOnly:true})` inspects only and reports `repairsSuppressed`; stateDir containment
      via realpath-aware `isInsideTree`; GOAL protection via realpath + `isLexicallyInside`.
- [x] `/guard status` full budget report (model, window+source, estimated used, raw
      remaining, reserve+source+fraction, usable remaining, level, next threshold/alert,
      measurement, provenance, inconsistencies, identity/readiness/renewal authorization).
- [x] Pruning disabled by default (`maxSessionStates: 0`, 1h age floor when opted in);
      `checkpointId`, `handoffReady`, `learningsHash` persisted in the v2 state file.
- [x] Four harness/fixture defects fixed (plumbing only, assertions untouched — A-14);
      new `test/readiness.test.ts` RD1–RD5 adapter tests.

## Verified evidence

- Phase 2 increment A (renewal session): `node --test test/` -> 118 pass / 0 fail /
  1 skipped (RN1-RN10 renewal suite added); `node scripts/e2e-rpc-two-process.mjs` ->
  23/23 on the CURRENT extension (module load proven in real Pi 1.4.0 per A-15).

- `node --test test/` -> 55 pass, 0 fail (Node v26.12.1).
- Real Pi 1.4.0 RPC (isolated PI_CODING_AGENT_DIR, zero inference): session_start staleness
  warning on the live HANDOFF.md legacy block; `/guard status` reports `checkpoint stale`;
  `/handoff verify` names the original session + timestamp; `--guard-readonly 1` on a temp
  tree copy left the tree byte-for-byte unchanged (no `.pi-guard/` created);
  `CONTEXT_GUARD_READONLY=1` + `CONTEXT_GUARD_STATE_DIR=/tmp/guard-audit-state` persisted
  v2 per-session state outside the tree with `checkpointFreshness: "stale"` audit field.
- Migration evidence: `.pi-guard/state.json` (owner 01a18668, evaluations 58) moved to
  `.pi-guard/sessions/01a18668-993a-7721-a1c6-cd06f69cf145.json` (version 2).
- NOTE: simulated thresholds prove state-machine behavior only, not real provider token
  accuracy; per-session isolation is proven serially, not with real concurrent processes.

## Blockers

(none)

## Next action

Priority 2: experimental reserve (`generationReserve: 20000` in handoff.config.json,
documented as policy change: enforced closing ~150k -> ~195k used at the declared 220k
window; thresholds unchanged) + the project `renewal` config block; then increment B
(`/handoff renew` + `handoff_renew` tool + operator stop/resume + identity banner),
then increment C (real-Qwen A->B->C experiment). Exact API constraints: HANDOFF.md
"Next action" + LEARNINGS A-17/A-19/P-6/P-8.

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 5
checkpoint-id: g5-16c8440d5756
checkpoint-kind: auto
content-delta: none
readiness: unattested
guard-level: 4
checkpointed: 2026-10-29T10:32:47.719Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: f802b5f6871aa8a5cc8d15ca1eabef5c13eae9b0a8ddf127679d685f8ec06f12
source-handoff: e79a9dd7eade5fc12a6fff30aa3e89e985078bc35e860a3f113e59f09fa4ccc5
source-learnings: a0a68b471ff18dbf448d9d9289ef78ed74fdd6c429dc5f98c7f69b702d2c17fb
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083
next-action: **Phase 2 IN PROGRESS (session 01a18713, real Qwen/Sushi inference). No renewal code
written yet; durable docs updated (LEARNINGS A-17 verified Pi API facts, P-6 renewal
design, P-7 reserve policy, O-1/O-2/O-3 open questions). Increment A (API audit +
design) is DONE and being committed with this handoff; the renewal state machine code,
tests and wiring are NOT yet written.**

Revocation fix LANDED (A-18/A-19/P-8 in LEARNINGS; `test/revoke.test.ts`): alerts
stay spent, one revocation notice per level, gate follows live level.

Concrete next steps for the following session, in order:

1. `node --test test/ 2>&1 | tail` → expect **103 tests, 102 pass, 0 fail, 1 skipped**;
   `git log --oneline -3` → expect a "Phase 2 increment A" commit (SHA recorded in
   PROGRESS.md "Current phase") on top of `39a2da9`.
1b. **Increment A code — PARTIAL (committed this session)**: `renewal.ts` exists
   (decideRenewal, RenewalState parse/serialize, buildRecoveryPrompt, DEFAULT_RENEWAL
   disabled-by-default) with all decision paths smoke-verified manually (see commit
   message); NOT yet wired: (a) config.ts must parse/merge `renewal` via mergeRenewal
   + env CONTEXT_GUARD_AUTO_RENEW; (b) formal `test/renewal.test.ts` (RN1-RN8 mirroring
   the smoke checks); (c) index.ts increment B below. Suite remained 108/109 green.
2. **Increment A code (rest)**: config wiring + renewal tests, then
   (extend `core.ts` or add `renewal.ts`): config keys `autoRenew` (default **false**),
   `renewal.maxRenewals` (cap), `renewal.recoveryPrompt` (default deterministic text
   naming AGENTS.md/GOAL.md/HANDOFF.md/PROGRESS.md); decision function
   `decideRenewal({config, auth: renewAuthorization(checkpoint), renewalsDone,
   checkpointId, renewedFrom})` → `renew | blocked:<reason> | disabled | capped |
   already-renewed`. Mock tests first (`test/renewal.test.ts`): disabled-by-default,
   readiness gate blocks, idempotence per checkpoint-id, cap respected.
3. **Increment B**: wire `/handoff renew` (plus an operator stop: `/handoff renew stop`)
   in index.ts per LEARNINGS P-6 / A-17 exactly: `ctx.waitForIdle()` → gate on
   `renewAuthorization()` → final checkpoint + attestation → `ctx.newSession({
   parentSession: <current session file>, withSession })` → inside `withSession(nctx)`
   send the recovery instruction via `nctx.sendMessage(..., {triggerTurn:true})`.
   O-1: the idle path AWAITS `_startRun` (agent-session.js sendCustomMessage), so
   awaiting the send inside withSession blocks the command until the successor's first
   turn completes — decide fire-and-track vs await empirically in the real runtime.
   Record renewal lineage (`previousSessionFile` arrives on the successor's
   session_start event; persist it + parent session id per P-4); extend `/guard status`
   with renewal state. NEVER use the old ctx after newSession (invalidated — A-17.5).
3b. **Model trigger (A-19/P-8)**: register tool `handoff_renew` (gates+checkpoint+attest
   synchronously, then `void pi.sendUserMessage("/handoff renew go",
   {expandPromptTemplates:true})` — NEVER await it inside execute: waitForIdle would
   deadlock on the tool's own result). Add the tool name to closingAllowlist in
   handoff.config.json so renewal is possible during enforced closing. Operator stop:
   `/handoff renew stop` sets a flag honored by the pending dispatch and by
   `session_before_switch` (cancel ONLY guard-pending switches, never human ones).
4. **Increment C**: real-Pi experiment — new `scripts/e2e-renew.mjs` (or extend the
   two-process script): RPC session with real Qwen/Sushi turn(s), drive to renewal
   (real pressure if affordable, else `/guard simulate 4900` + agent-invoked
   `/handoff renew`), verify: distinct session ids, fresh context, zero compaction,
   successor resumes work from durable files; chain A→B→C (3 sessions, maxRenewals=2).
   Record measurements honestly (tokens before renewal, latency, init overhead,
   increments completed). If genuine inference cannot be exercised, SAY SO — do not
   claim autonomous renewal.
5. Commit after every increment (local only, never push). Refresh + attest the
   checkpoint AFTER committing, then commit the managed-block refresh separately if it
   dirties the tree (avoids the freshness↔commit circularity warned about in the task).

**Reserve decision (task §6, open):** config still uses `"generationReserve": "model"`
(65536 ⇒ enforced closing at ~150k used). A fixed 20000 would extend sessions to ~195k
used (LEARNINGS P-7, NOT adopted). First working renewal > threshold tuning.
<!-- guard:end checkpoint -->
