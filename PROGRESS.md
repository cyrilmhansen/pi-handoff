# PROGRESS

## Current phase

Phase 1c — recovery + completion (transactional checkpoint identity, audit-mode
non-mutation, budget observability, readiness gate). Implemented and verified in the
repair session (extensions disabled); README/PROTOCOL/PROGRESS/LEARNINGS/HANDOFF
updated and committed locally as `3cc2f31` (tree clean, nothing pushed). Session renewal (Phase 2) is still NOT implemented.

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

STOP for human review of Phases 1b+1c (commit `3cc2f31`, 102/103 tests + 23/23 real-Pi e2e
checks). Then either Phase 1d (Pi Handoff skill + long-project integration guide; PL/I-80
case study; documentation only) or Phase 2 scoping behind `renewAuthorization()`.
Optional open item: `GUARD_E2E_LLM=1 node scripts/e2e-rpc-two-process.mjs` for live
alert-delivery evidence. Details: HANDOFF.md "Next action".


<!-- guard:begin checkpoint -->
checkpoint-schema: 3
guard-level: 4
checkpointed: 2026-10-29T08:39:30.368Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: e1193cecb8be053b96e6d27f77fdac8b2a73e48a7ae54cddadc72c9c0e811a27
source-handoff: fcfbee5c407702629bf0e8917526a61a36bab65a9724718ac31d79085e7df700
source-learnings: e2b1cc565934e001cb75c6499b5d5271f172bdf51535780d59d99004ee3588f9
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083
next-action: STOP for human review. If accepted: run a live interactive session (`pi -e
.pi/extensions/context-guard/index.ts`, observe `/guard status` remaining values under
real work), then scope Phase 2 per PROTOCOL §6 and LEARNINGS P-1/P-4/P-5.
<!-- guard:end checkpoint -->
