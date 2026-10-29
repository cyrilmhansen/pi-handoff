# HANDOFF

## Recovery instructions

0. **Session 01a18713 ended at enforced level 4 (real Qwen pressure ~155k used / 220k
   window; reserve "model"=65536 ⇒ usable <5k). Last commit `6ea1d64`; tree clean; suite
   102/103 green at that commit; checkpoint g1-09c93f8608af is STALE (docs changed after
   attestation) — refresh + re-attest FIRST (HANDOFF "Next action" step 1), then start
   increment A code at step 2. Closing scratch notes: `.pi-guard/close-notes.md`**
   (git-ignored; the essentials are already in HANDOFF/PROGRESS/LEARNINGS + commit msgs).

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

- [x] Phase 1c code: transactional checkpoint identity (schema v3), readiness gate +
      attestation, audit-mode inspection-only state load, normalized/symlink-aware
      containment and GOAL protection, detailed budget status, `/handoff ready`,
      `renewAuthorization`, pruning disabled by default, auto-checkpoint prose
      preservation — all implemented, 102/103 tests + 23/23 real-runtime e2e checks.
- [x] README + PROTOCOL documentation of Phase 1c.
- [x] Local commit of the completed milestone (`3cc2f31`; never pushed).
- [ ] Live real-model turn for alert delivery (opt-in `GUARD_E2E_LLM=1`; aborted attempt).
- [ ] **Phase 1d (planned, NOT started): Pi Handoff skill + long-project integration
      guide** — how to install and use context-guard in long-running projects, using the
      Digital Research PL/I-80 reverse-engineering project as the case study.
      Documentation/skill only; no Phase 2 renewal code.
- [ ] NOTE: after checkpoint `g1-09c93f8608af` was attested, AGENTS.md was edited
      (Phase 2 header + operator controls). Source hash of that checkpoint is therefore
      stale on `learnings/agents`-adjacent state — refresh + re-attest with `/handoff`
      and `/handoff ready` at the START of the next session (or after its first docs
      change), before relying on `renewAuthorization()`.
- [ ] Human review of the Phase 1b+1c consolidation (code + docs + LEARNINGS classifications).
- [ ] Phase 2 renewal — NOT implemented (contract: PROTOCOL §6); gate: real-session
      checkpoint/recovery verification, plus deciding on LEARNINGS P-4/P-5 proposals.
- [ ] Live interactive-session walkthrough of `/guard simulate` with a real Sushi model
      (token-accounting sanity check; do not spend tokens hunting thresholds).
- [ ] Real multi-process concurrency test of per-session state isolation (P-5) — the
      current tests are serial; do not claim concurrency is proven.

## Next action

**Phase 2 IN PROGRESS (session 01a18713, real Qwen/Sushi inference). No renewal code
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

## Phase 1c — what was verified in this session (repair session, extensions disabled)

- **Root cause of the load failure**: `index.ts` ended with
  `export { ContextPressureMachine, computeMeasurement, defaultThresholds };` while the
  Phase 1c import rewrite had replaced the `computeMeasurement` import with
  `computeBudget`/`syntheticBudget`/`BudgetBreakdown`. Re-exporting a name that is not a
  local binding is a module-level LinkError, so BOTH Node's type-stripping loader and
  pi's jiti loader refused the extension:
  `ParseError: Export 'computeMeasurement' is not defined. index.ts:560:33`
  (reproduced verbatim with `pi --mode rpc -e …`). Fix: re-export from the source module
  (`export { computeMeasurement } from "./core.ts";`) instead of through an unused import.
- Tests that demonstrate the correction: `test/budget.test.ts` B9/B11 (the detailed
  `/guard status` report, red before this session), the whole suite at 102/103, and the
  real-runtime e2e (23/23), which fails immediately if the extension cannot load.
2. In `.pi/extensions/context-guard/index.ts`, replace the one-line `/guard status`
   notification with a multi-line report built from `measure(ctx)` (now a
   `BudgetBreakdown`) containing exactly these labels: `model:`, `context window:`,
   `estimated used:`, `raw remaining:`, `generation reserve:`, `usable remaining:`,
   `guard level:`, `next threshold:` (use `g.machine.nextThreshold(m.remaining)`),
   `measurement:`, `provenance:`, plus the reserve source via the already-defined
   `RESERVE_LABEL` map (`model maxTokens`, `config generationReserve (fixed)`), the
   `m.inconsistencies` lines (large-reserve/fraction must appear), `unknown`/`no-model`,
   `synthetic`, and `READ-ONLY audit mode`. Keep the existing one-liner's info
   (alerted levels, checkpoint kind) as extra lines — tests R4/S6/A5 depend on them.
3. Add `/handoff ready` subcommand → `evaluateHandoffReadiness(fs, g.cwd, g.config.files,
   { learningsHashAtSessionStart: g.learningsHash })` printed as `id: status — detail`,
   and `attestHandoff(..., { sessionId: g.sessionId, dryRun: !canWriteProjectTree() })`;
   refuse writes in audit mode. Include readiness + `renewAuthorization(g.checkpoint).reason`
   in `/handoff verify` and `/guard verify-checkpoint`. Set `g.checkpointId` /
   `g.handoffReady` there (persisted already by `persistState`).
4. Delete now-unused `isUnder()` and `resolveComparable()`/`goalPath()` if unreferenced
   (`tsc`-free project; keep imports clean — `Measurement` import may be unused).
5. Re-run the suite to 98/98, then README §"Generation reserve", PROTOCOL §1/§2.1/§2.2/§2.3,
   PROGRESS/LEARNINGS/HANDOFF, `scripts/e2e-rpc-two-process.mjs` (GUARD_E2E=1), commit locally.

Never weaken a failing regression test to get green; the four test-fixture fixes already
applied in this session were plumbing only (documented in LEARNINGS A-14).

## Discoveries not yet incorporated

### Phase 1c (INCOMPLETE — suite is RED; do NOT commit, do NOT push)

**Step 1 (start here, deterministic):** `.pi/extensions/context-guard/checkpoint.ts` — finish
`writeCheckpoint` so BOTH managed blocks carry one transactional identity:
`checkpoint-schema: 3`, `checkpoint-generation: nextCheckpointGeneration(fs,cwd,files)`,
`checkpoint-id: makeCheckpointId(gen, sources.fingerprint, sessionId)`, `checkpoint-kind: auto|manual`,
`content-delta: initial|none|new` (compare the replaced HANDOFF block's `blockFingerprint()` with
`checkpointSources().fingerprint`), `readiness: unattested`; keep the existing status/timestamp/
source-hash lines; return `identity`+`contentDelta` in `CheckpointResult`; for `kind:"auto"` without
notes PRESERVE the previous block's `### Last verified state` and `### Guard notes` bodies (observed
Phase 1b information-loss bug: the level-3 auto-checkpoint replaced "Phase 1b consolidation …
55/55 tests; real Pi 1.4.0 RPC verification" with "guard level 3; checkpoint requested (end of
current iteration /handoff verify)" — see `git diff HANDOFF.md` at baseline).
**Step 2:** add `evaluateHandoffReadiness(fs,cwd,files,opts)` + `attestHandoff(fs,cwd,files,opts)`.
Blocking checks: `checkpoint-current`, `identity-consistent`, `next-action-recorded` (reject
placeholders/`nextFromCheckpoint` alone), `durable-files-valid`; warnings: `content-delta` (=none ⇒
checkpoint recorded nothing new), `learnings-updated` (LEARNINGS hash unchanged since session start).
Attestation = rewrite only the readiness lines in both blocks in one operation (no new generation),
bound to the current `checkpoint-id`; `dryRun` ⇒ zero writes.
**Step 3:** `index.ts` — detailed `/guard status` (model id, effective window, estimated used, raw
remaining, reserve+its source, usable remaining, level, next threshold+tokensUntil, provenance
real/synthetic/unknown, inconsistencies), readOnly → `loadGuardState(...,{readOnly:true})` and
announce `repairsSuppressed`, stateDir containment via `isInsideTree(fs, resolved, cwd)`, GOAL
protection via `fs.realpath`+`isLexicallyInside`, `/handoff ready` subcommand, readiness +
`renewAuthorization().reason` in `/handoff verify`/`/guard verify-checkpoint`, persist
`checkpointId`/`handoffReady` in the v2 state file.
**Step 4:** `config.ts` — `maxSessionStates: 0` default (pruning disabled) and accept `0` in
`mergeConfig`.
**Step 5:** `node --test test/` to green (no failures), then update README (new "Generation
reserve" section explaining `usable = window - used - max(modelMaxTokens, safetyReserve)`, the
150k consequence, that a policy reserve is NOT an output cap, and that Pi clamps
`max_tokens = min(model.maxTokens, window - estimate - 4096)` via pi-ai `clampMaxTokensToContext`),
PROTOCOL §1/§2.1/§2.2/§2.3, PROGRESS/LEARNINGS/HANDOFF, then commit locally (never push).
**Step 6 (real runtime):** write+run `scripts/e2e-rpc-two-process.mjs` — two `pi --mode rpc -e
<path>/index.ts` processes, isolated `PI_CODING_AGENT_DIR` under /tmp, temp project copy, zero
inference: distinct session ids, concurrent `.pi-guard/sessions/*.json` writes, no cross-overwrite,
read-only audit session beside a normal one with the audited snapshot byte-identical, checkpoint
consistency under controlled concurrency; plus one minimal local Sushi turn to confirm an alert
lands at end of turn without interrupting a running tool and reaches the model only on the next
inference turn. Document honestly what could not be exercised.

Baseline evidence (this session): HEAD `b2ccdac`, 55/55 pass. Repros: `/tmp/repro-audit.ts` →
read-only audit session on a real temp tree with legacy `state.json` + corrupt session file +
stale `*.tmp-*` changed **6 manifest entries** (quarantine `.bak` written, legacy migrated/removed,
foreign session file created, tmps deleted); `/tmp/repro-identity.ts` → interrupted 2nd checkpoint
over unchanged source state validated as **`current`** (identical hashes, no generation proof).
Live budget proof: my own guard hit level 1 at ~127k used with ~93k raw remaining and level 4 at
~150k used = `220000 - used - 65536`.

Already implemented and green-ish: `core.ts` (complete: `selectGenerationReserve`, `computeBudget`/
`BudgetBreakdown` with provenance + rawRemaining + usableRemaining + reserve source + fraction +
inconsistencies, `syntheticBudget`, `measurementFromBudget`, `computeMeasurement` as a wrapper with
unchanged semantics, `nextThresholds`, machine `thresholdList`/`nextThreshold`, and all four
threshold guidance strings now naming LEARNINGS.md with accepted/proposed/falsified classification);
`checkpoint.ts` (`FsOps.realpath?`/`mtimeMs?`, `normalizePath`, `isLexicallyInside`,
`isInsideTree`, `inspectGuardState`, read-only `loadGuardState`, safe `pruneSessionStates` with
`keep<=0` disabled + 1h age floor, identity constants, `readBlockIdentity`,
`nextCheckpointGeneration`, `makeCheckpointId`, `blockFingerprint`, `resolveReadiness`,
`renewAuthorization`, rewritten `validateCheckpoint`).
New spec-tests present (currently failing until the above is done): `test/budget.test.ts` B1–B11
(8/11 pass; B9/B11 need the index.ts status), `test/audit-tree.test.ts` A1–A8 (real fs,
byte-for-byte manifests), `test/identity.test.ts` I1–I14, `test/guidance.test.ts` G1–G5 (4/5;
G3 asserts alerts name LEARNINGS.md and never fabricate discoveries), `test/processes.test.ts`
P1–P5 (real child processes; P5 skips unless `GUARD_E2E=1`).
- `sendMessage` deferral semantics (LEARNINGS A-2) are asserted only with mocks; confirm
  in a live session.
- Real context accuracy caveat: `getContextUsage().tokens` is an estimate (last usage +
  chars/4 heuristic); synthetic threshold tests do NOT validate real token accounting.
- Audit-mode limitation: it protects the project TREE only — Pi transcripts still persist
  under `$PI_CODING_AGENT_DIR`; full immutability needs OS-level snapshots (out of scope).
- RPC-mode startup race: commands dispatched before `session_start` hit an uninitialized
  extension (LEARNINGS A-9); scripted RPC verification needs a warm-up delay.

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 1
checkpoint-id: g1-09c93f8608af
checkpoint-kind: manual
content-delta: new
readiness: attested
status: checkpoint (guard level 4, remaining ~5000, session 01a18713-0257-728d-a259-9ab1c5662cf7)
checkpointed: 2026-10-29T10:05:26.255Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: be99fc199e77471db2a579a43ebc85c2de423e4ace6299229d2b21912d4ed84a
source-handoff: 269b4e826ad159120442923fd9776541b2cbde575eb88f9a04a4544a8d8513cc
source-learnings: 452d4d4254d5f628e97c321649fcb4a4bca3c7fd575c5a5811a03bb31785e5b4
source-config: 1434a935d372556e4e35b72497f8d7dcc7e63adc25ebd0c30b905cfff0496083


readiness-by: session:01a18713-0257-728d-a259-9ab1c5662cf7
readiness-at: 2026-10-29T10:05:26.260Z
readiness-checkpoint: g1-09c93f8608af
### Last verified state
Phase 2 increment A (design) committed at 6da98d6; suite 102/103 (1 gated skip); Pi renewal API verified (LEARNINGS A-17); renewal code NOT yet written.

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
**Phase 2 IN PROGRESS (session 01a18713, real Qwen/Sushi inference). No renewal code
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

### Guard notes
Phase 2 renewal milestone: API audit done; next = renewal state machine + tests (HANDOFF Next action step 2).
<!-- guard:end checkpoint -->
