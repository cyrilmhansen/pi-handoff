# PROGRESS

## Current phase

Phase 2 (minimal automatic session renewal) — IN PROGRESS. Session 01a18713 completed
**increment A (design)**: verified Pi 1.4.0 replacement semantics (LEARNINGS A-17),
renewal design (P-6), reserve policy (P-7), open questions O-1/O-2/O-3. Test suite
verified green at baseline `39a2da9` (102/103, 1 gated skip). NO renewal code exists yet:
state machine + tests are the next increment (see HANDOFF "Next action").
Increment A design commit: `6da98d6` (on baseline `39a2da9`); suite green 102/103 at
both points; this session runs real Qwen/Sushi inference under the guard.

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

Implement Phase 2 increment A CODE: pure renewal decision module + config keys
(`autoRenew` default false, `renewal.maxRenewals`, `renewal.recoveryPrompt`) + mock
tests (`test/renewal.test.ts`), commit; then `/handoff renew` wiring (increment B),
then the 3-session real-Qwen RPC experiment (increment C). Details and exact API
constraints: HANDOFF.md "Next action" + LEARNINGS A-17/P-6.

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 1
checkpoint-id: g1-09c93f8608af
checkpoint-kind: manual
content-delta: new
readiness: attested
guard-level: 4
checkpointed: 2026-10-29T10:05:26.255Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: be99fc199e77471db2a579a43ebc85c2de423e4ace6299229d2b21912d4ed84a
source-handoff: 269b4e826ad159120442923fd9776541b2cbde575eb88f9a04a4544a8d8513cc
source-learnings: 452d4d4254d5f628e97c321649fcb4a4bca3c7fd575c5a5811a03bb31785e5b4
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083
next-action: **Phase 2 IN PROGRESS (session 01a18713, real Qwen/Sushi inference). No renewal code
written yet; durable docs updated (LEARNINGS A-17 verified Pi API facts, P-6 renewal
design, P-7 reserve policy, O-1/O-2/O-3 open questions). Increment A (API audit +
design) is DONE and being committed with this handoff; the renewal state machine code,
tests and wiring are NOT yet written.**

Concrete next steps for the following session, in order:

1. `node --test test/ 2>&1 | tail` → expect **103 tests, 102 pass, 0 fail, 1 skipped**;
   `git log --oneline -3` → expect a "Phase 2 increment A" commit (SHA recorded in
   PROGRESS.md "Current phase") on top of `39a2da9`.
2. **Increment A code**: implement the renewal decision as a pure deterministic module
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
readiness-by: session:01a18713-0257-728d-a259-9ab1c5662cf7
readiness-at: 2026-10-29T10:05:26.260Z
readiness-checkpoint: g1-09c93f8608af
<!-- guard:end checkpoint -->
