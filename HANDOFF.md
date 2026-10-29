# HANDOFF

## Recovery instructions

0. **Phase 2 renewal: increment A (pure module + config wiring + durable chain state +
   tests RN1–RN10) is COMPLETE and committed this session. Suite 118/119 (1 gated skip),
   real-runtime e2e 23/23. Nothing switches sessions YET — `/handoff renew` wiring
   (increment B) and the A→B→C experiment (increment C) are next. Checkpoint freshness:
   run `/handoff verify`; refresh + re-attest after docs changes.**

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

**Phase 2 IN PROGRESS (renewal session, real Qwen/Sushi inference). Increments A AND B
are DONE and committed (B: `/handoff renew`, `handoff_renew` bridge, stop/resume,
lineage, identity banner, RB1-RB13, e2e 27/27): `renewal.ts` (decideRenewal + durable RenewalState incl. operator
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
3. ~~Increment B (the switch)~~ **DONE this session** (wired per P-6/A-17; details below kept for review):
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
checkpoint-generation: 7
checkpoint-id: g7-3dc709544bdb
checkpoint-kind: auto
content-delta: none
readiness: unattested
status: checkpoint (guard level 4, remaining ~4380, session 01a18770-fee7-7655-8bbe-498d9e641f6c)
checkpointed: 2026-10-29T12:07:37.177Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: b93286bd600255125b94ad2df37a22e7dcb9c1e845155f1a891ff4fc19e3983d
source-handoff: f21d7b735ba0c7b5709cfff261ee73d20f1ec525113978c9934344c9b5b45cc3
source-learnings: 13a1487be9fd1eacb11677c7745bc97e932adf7d4c60694f88d8ad7c95d9bdba
source-config: 0b1e162bdbf7ec9946afab3d1dd8b0fa35b4e3972ba77214f68c9a55276fe606


### Last verified state
Phase 2: revocation fix a42d223 (A-18/A-19/P-8) + renewal decision module renewal.ts committed (increment A partial, smoke-verified; suite 108/109, e2e 23/23). Renewal NOT wired: config parsing, renewal tests, index.ts B, experiment C remain — HANDOFF Next action.

### Unfinished operations
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.md.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint module,
- [x] Reproduced both audit defects deterministically: (A) the legacy schema-v1 managed
- [x] Checkpoint schema v2: managed blocks embed sha256 fingerprints of source state
- [x] Recovery precedence fixed: manual prose always wins; the checkpoint block supplies
- [x] Per-session runtime state `sessions/<sessionId>.json` (version 2) + newest-wins
- [x] Read-only audit mode (`readOnly` / `CONTEXT_GUARD_READONLY=1` / `--guard-readonly`):
- [x] Tests extended: 55/55 pass (`test/freshness.test.ts`, `test/sessions.test.ts`,
- [ ] Phase 2 increment B: `/handoff renew` switch wiring + `handoff_renew` tool bridge.
- [ ] Phase 2 increment C: real-inference A -> B -> C renewal experiment + evidence.
- [ ] Human review of Phase 1b consolidation.
- [ ] Phase 2 renewal — deliberately NOT started (see PROTOCOL §6).

### Next action
**Phase 2 IN PROGRESS (renewal session, real Qwen/Sushi inference). Increment A is
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

### Guard notes
Session ending at level 3; next session: HANDOFF step 1b remainder (config.ts renewal key + test/renewal.test.ts), then increment B (A-17/A-19/P-6/P-8) — never await renewal inside a tool execute (deadlock).
<!-- guard:end checkpoint -->
