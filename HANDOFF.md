# HANDOFF

## Recovery instructions

1. Read `AGENTS.md`, then this file, then `PROGRESS.md`, then `GOAL.md`/`LEARNINGS.md`.
   Do not replay transcripts.
2. `GOAL.md` is the stable objective; never rewrite it silently (guard blocks write/edit).
3. Checkpoint freshness: the `guard:begin checkpoint` blocks are schema v2 and embed
   sha256 fingerprints of the source state. **Manual prose in this file always takes
   precedence over the managed block.** Run `/handoff verify` (or read the
   `session_start` notification) to see missing/corrupt/stale/current; if stale, refresh
   with `/handoff` (rewrites only managed blocks, never manual text).
4. Verify the build: `node --test test/` (expect 55 passing, Node 26, no installs).
5. Load the guard explicitly (no trust dependency): `pi -e .pi/extensions/context-guard/index.ts`.
   For a non-mutating audit session: `CONTEXT_GUARD_READONLY=1 CONTEXT_GUARD_STATE_DIR=/tmp/guard-state pi -e ...`
   (read-only mode can also be enabled with `--guard-readonly 1`).

## Last verified state

- Phase 1b consolidation complete in this tree: checkpoint schema v2 with source hashes
  and 4-class freshness validation; manual-prose-first recovery precedence; per-session
  runtime state (`sessions/<id>.json`, v2) with newest-wins migration of legacy
  `state.json` (executed live); read-only audit mode; retention pruning.
- `node --test test/` → 55/55 pass. Real Pi 1.4.0 RPC (isolated agent dir, zero
  inference): staleness warning surfaced on the pre-fix legacy block; read-only audit run
  on a temp copy left the tree byte-for-byte unchanged; readonly flag crash (const
  reassignment, mock-masked) found and fixed via the real runtime (LEARNINGS A-9).
- pli80, Rune CI, global Pi install and compaction settings untouched.

## Unfinished operations

- [ ] Human review of the Phase 1b consolidation (code + docs + LEARNINGS classifications).
- [ ] Phase 2 renewal — NOT implemented (contract: PROTOCOL §6); gate: real-session
      checkpoint/recovery verification, plus deciding on LEARNINGS P-4/P-5 proposals.
- [ ] Live interactive-session walkthrough of `/guard simulate` with a real Sushi model
      (token-accounting sanity check; do not spend tokens hunting thresholds).
- [ ] Real multi-process concurrency test of per-session state isolation (P-5) — the
      current tests are serial; do not claim concurrency is proven.

## Next action

STOP for human review. If accepted: run a live interactive session (`pi -e
.pi/extensions/context-guard/index.ts`, observe `/guard status` remaining values under
real work), then scope Phase 2 per PROTOCOL §6 and LEARNINGS P-1/P-4/P-5.

## Discoveries not yet incorporated

- `sendMessage` deferral semantics (LEARNINGS A-2) are asserted only with mocks; confirm
  in a live session.
- Real context accuracy caveat: `getContextUsage().tokens` is an estimate (last usage +
  chars/4 heuristic); synthetic threshold tests do NOT validate real token accounting.
- Audit-mode limitation: it protects the project TREE only — Pi transcripts still persist
  under `$PI_CODING_AGENT_DIR`; full immutability needs OS-level snapshots (out of scope).
- RPC-mode startup race: commands dispatched before `session_start` hit an uninitialized
  extension (LEARNINGS A-9); scripted RPC verification needs a warm-up delay.

<!-- guard:begin checkpoint -->
checkpoint-schema: 2
status: checkpoint (guard level 3, remaining ~9774, session 01a18668-993a-7721-a1c6-cd06f69cf145)
checkpointed: 2026-10-29T07:19:50.811Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: e1193cecb8be053b96e6d27f77fdac8b2a73e48a7ae54cddadc72c9c0e811a27
source-handoff: eb1d64b632ec075bf3ad887a8278d42e9a6db778ca96b825f0009d24ddac8f5f
source-learnings: 32fc639828d55aed054d3ebd9e55712b4787794cbe2350b28d4f9ee7930c0846
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083


### Last verified state
guard level 3; Phase 1b consolidation (freshness validation, per-session state, audit mode); 55/55 tests; real Pi 1.4.0 RPC verification incl. zero-write audit run

### Unfinished operations
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.md.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint module,
- [x] Reproduced both audit defects deterministically: (A) the legacy schema-v1 managed
- [x] Checkpoint schema v2: managed blocks embed sha256 fingerprints of source state
- [x] Recovery precedence fixed: manual prose always wins; the checkpoint block supplies
- [x] Per-session runtime state `sessions/<sessionId>.json` (version 2) + newest-wins
- [x] Read-only audit mode (`readOnly` / `CONTEXT_GUARD_READONLY=1` / `--guard-readonly`):
- [x] Tests extended: 55/55 pass (`test/freshness.test.ts`, `test/sessions.test.ts`,
- [ ] Human review of Phase 1b consolidation.
- [ ] Phase 2 renewal — deliberately NOT started (see PROTOCOL §6).
- [ ] Live interactive-session walkthrough of `/guard simulate` on a real Sushi model
- [ ] Real multi-process concurrency test of per-session state (NOT done; serial mocks only).

### Next action
STOP for human review. If accepted: run a live interactive session (`pi -e
.pi/extensions/context-guard/index.ts`, observe `/guard status` remaining values under
real work), then scope Phase 2 per PROTOCOL §6 and LEARNINGS P-1/P-4/P-5.

### Guard notes
phase1b consolidation — schema v2 checkpoint; manual prose wins recovery; refresh via /handoff
<!-- guard:end checkpoint -->
