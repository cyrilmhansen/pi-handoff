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

**Priority 2 DONE (experimental reserve):** handoff.config.json now uses
`generationReserve: 20000` (thresholds unchanged) + a `renewal` block (enabled for this
project's experiments, autoRenew OFF until proven, maxRenewals 2) and `handoff_renew` in
closingAllowlist. Budget verified through computeBudget + ContextPressureMachine:
crossings at used >= 170k/180k/190k/195k(L4) with the declared 220k window — nominal
closing moved from ~150k to ~195k (LEARNINGS P-7 adopted experimentally, project-local;
global Pi/Sushi config untouched).

Earlier this milestone: revocation fix (A-18) + renewal model-trigger path (A-19/P-8)
source-verified; increment-A design audit (A-17). **Increment B is COMPLETE** (this session): `/handoff renew` (operator),
`handoff_renew` tool + `/handoff renew go` (model bridge P-8), durable operator
stop/resume, `session_before_switch` cancels ONLY guard-pending switches, successor
lineage recording (P-4), renewal line in `/guard status`, runtime-derived identity
banner (operator + model, no invented values). Adapter tests RB1-RB13 (suite
131/132, 1 gated skip) + real-runtime e2e 27/27 (renewal status/stop/attempt/resume,
no switch without inference). **The live A->B->C real-inference demo (increment C) is
what remains before renewal can be called proven.**

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

- [x] Phase 2 increment B: `/handoff renew` switch wiring + `handoff_renew` tool bridge
  (RB1-RB13; operator surface proven in real RPC; the switch itself awaits increment C).
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
checkpoint-generation: 7
checkpoint-id: g7-3dc709544bdb
checkpoint-kind: auto
content-delta: none
readiness: unattested
guard-level: 4
checkpointed: 2026-10-29T12:07:37.177Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: b93286bd600255125b94ad2df37a22e7dcb9c1e845155f1a891ff4fc19e3983d
source-handoff: f21d7b735ba0c7b5709cfff261ee73d20f1ec525113978c9934344c9b5b45cc3
source-learnings: 13a1487be9fd1eacb11677c7745bc97e932adf7d4c60694f88d8ad7c95d9bdba
source-config: 0b1e162bdbf7ec9946afab3d1dd8b0fa35b4e3972ba77214f68c9a55276fe606
next-action: **Phase 2 IN PROGRESS (renewal session, real Qwen/Sushi inference). Increment A is
DONE and committed: `renewal.ts` (decideRenewal + durable RenewalState incl. operator
stop + deterministic buildRecoveryPrompt), config wiring (`renewal` block +
CONTEXT_GUARD_AUTO_RENEW env), chain-state persistence in checkpoint.ts
(`load/saveRenewalState` at `<stateDir>/renewal-state.json` — survives session
replacement AND restart), formal `test/renewal.test.ts` RN1–RN10 (disabled-by-default,
readiness gate, idempotence, cap, gate precedence, durability, prompt determinism).
Suite 118/119; real e2e 23/23 (harness probe fixed, LEARNINGS A-20). STILL NOT
IMPLEMENTED: the actual session switch (increment B) and the A→B→C experiment
(increment C). Nothing switches sessions yet.**

Concrete next steps, in order:

1. `node --test test/` → expect **119 tests, 118 pass, 0 fail, 1 skipped**; e2e
   `node scripts/e2e-rpc-two-process.mjs` → 23/23.
2. **Priority 2 (reserve)**: set `handoff.config.json` `"generationReserve": 20000`
   (experimental LEARNINGS P-7: with the declared 220k window this moves enforced
   closing from ~150k to ~195k used; thresholds unchanged), verify the budget math,
   document, add the `renewal` block (enabled for THIS project's experiments; defaults
   stay OFF), add `handoff_renew` to closingAllowlist, commit.
3. **Increment B (the switch)**: wire `/handoff renew` in index.ts per P-6/A-17:
   module-scope pending + stop markers (jiti module cache survives replacement, A-17.4;
   closures per factory invocation do NOT); handler = waitForIdle → refresh+attest
   checkpoint → renewAuthorization → decideRenewal → persist chain state BEFORE the
   switch (crash-safe) → `ctx.newSession({parentSession, withSession})` → inside
   withSession send the recovery prompt FIRE-AND-TRACK (`void
   nctx.sendMessage(...,{triggerTurn:true}).catch(...)`) — awaiting blocks newSession
   until the successor's first turn completes (settle O-1 live); report ONLY via nctx
   (old ctx invalidated, A-17.5). Successor records lineage at session_start
   (`previousSessionFile` + pending marker). Operator stop `/handoff renew stop`
   (durable `stopped` field) + `/handoff renew resume`; `session_before_switch` returns
   `{cancel:true}` ONLY while the guard has a pending renewal AND stop is set — never
   cancels human switches. `/guard status` renewal line. Runtime-derived identity
   banner at session_start (pi version via process.argv[1]→package.json walk; model
   provider/id from ctx.model; project from cwd; session id from sessionManager) —
   operator notify + model custom message (triggerTurn:false) + appendEntry audit.
   Model trigger (P-8): register tool `handoff_renew` — gates+checkpoint+attest
   synchronously, then `pi.sendUserMessage("/handoff renew go",
   {expandPromptTemplates:true})` — NEVER await anything that waits for idle inside
   execute (deadlock on own tool result; pi's API-level sendUserMessage is void/fire-
   and-forget by contract). Add tool name to closingAllowlist so L4 closing can renew.
4. **Increment C**: real-Qwen RPC experiment (`scripts/e2e-renew.mjs`): drive session A
   to renewal (synthetic pressure acceptable for triggering; the model's continuation
   must be REAL inference), verify A→B→C: three distinct session ids, two transitions,
   fresh contexts, recovery from durable files, meaningful work after renewal, zero
   compaction/transcript replay, cap (maxRenewals=2) respected, git history preserved.
   Record measurements honestly; if real inference cannot be exercised, SAY SO.
5. Commit after every increment (local only, never push). Refresh + attest the
   checkpoint AFTER committing; commit the managed-block refresh separately when it
   dirties the tree.
<!-- guard:end checkpoint -->
