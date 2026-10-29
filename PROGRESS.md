# PROGRESS

## Current phase

Phase 1b — recovery-audit consolidation (checkpoint freshness, session isolation, audit
mode). Session renewal (Phase 2) is still NOT implemented.

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

Finish docs (README/LEARNINGS/HANDOFF), regenerate the project's managed checkpoint blocks
with schema v2 (last write), re-run `node --test test/`, then stop for human review.


<!-- guard:begin checkpoint -->
checkpoint-schema: 2
guard-level: 3
checkpointed: 2026-10-29T07:19:50.811Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: e1193cecb8be053b96e6d27f77fdac8b2a73e48a7ae54cddadc72c9c0e811a27
source-handoff: eb1d64b632ec075bf3ad887a8278d42e9a6db778ca96b825f0009d24ddac8f5f
source-learnings: 32fc639828d55aed054d3ebd9e55712b4787794cbe2350b28d4f9ee7930c0846
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083
next-action: STOP for human review. If accepted: run a live interactive session (`pi -e
.pi/extensions/context-guard/index.ts`, observe `/guard status` remaining values under
real work), then scope Phase 2 per PROTOCOL §6 and LEARNINGS P-1/P-4/P-5.
<!-- guard:end checkpoint -->
