# PROGRESS

## Current phase

Phase 2 (minimal automatic session renewal) — **COMPLETE (increments A+B+C)**;
Phase 1d (skill + long-project guide) — **COMPLETE (this session)**. **Increment A was
COMPLETE** (renewal session): `renewal.ts` decision module + durable chain state + config wiring
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
no switch without inference). **Increment C is COMPLETE (real-inference A→B→C proven):**
`scripts/e2e-renew.mjs` on a full git clone with REAL sushi/Qwen inference and
CONTEXT_GUARD_AUTO_RENEW=1 — hop 1 MODEL-initiated via `handoff_renew` (P-8 live,
no deadlock), hop 2 operator `/handoff renew`, 3rd attempt refused (cap 2/2).
Three distinct sessions, fresh successor contexts (messageCount=3), first successor
action = read all six durable files, identity banner + recovery before first inference,
zero transcript replay (user-role scan), zero compaction, durable chain 2/2
(g9→g10), both successors committed real work (suite 131 passing; LEARNINGS X-1/X-2).
20/20 checks (run 1 18/20 — both fails were driver bugs, see A-24; fixed, rerun clean).
**Renewal is now PROVEN live (LEARNINGS A-23).** `renewal.autoRenew` stays false in
handoff.config.json (the experiment drives it via the env switch); enabling it by
default is an operator decision.

**Phase 1d is COMPLETE (this session; docs/skill increment, guard code untouched):**
Pi Handoff skill at `.agents/skills/pi-handoff/` — SKILL.md (operating procedure:
start order, level reactions, checkpoints/readiness, renewal, synthetic tests, audit
mode, honesty rules) + `references/commands.md` (full command/config/state reference,
verified against index.ts registrations) + `references/bootstrap.md` (equip-a-new-
project procedure). Long-project integration guide at `docs/long-project-guide.md`
(problem, install, file-writing discipline, budget tuning, daily rhythm, audits,
anti-patterns) with the Digital Research PL/I-80 reverse-engineering project as the
case study — inspected READ-ONLY (claims ledger spec/CLAIMS.md, tiered
tools/e2e_gate.py gates, oracle discipline, artefacts/ read-only); the blueprint is
§7; pli80 itself was NOT modified (hard scope). New real-runtime probe
`scripts/check-skill-discovery.mjs` (zero inference, isolated agent dir): first run
failed 3/8 because project skills are TRUST-GATED (package-manager.js loads
`.agents/skills` only when isProjectTrusted); probe fixed by granting trust in the
isolated trust.json → 8/8 (skill advertised in get_commands + guard auto-loads from
the trusted tree). Evidence: LEARNINGS A-25.

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
- [x] Phase 2 increment C: real-inference A -> B -> C renewal experiment + evidence
  (20/20 checks, LEARNINGS A-23; driver fixed in A-24).

- [ ] Human review of Phase 1b consolidation.
- [x] Phase 1d: Pi Handoff skill + long-project integration guide (COMPLETE this
      session — see Current phase; guide is a blueprint, pli80 untouched).
- [ ] Phase 2 — auto-renew-by-default decision (config `autoRenew` stays OFF; env switch
      proven live) + operator UX polish.
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

Phase 1d (this session): `node --test test/` → 131/132 (1 gated skip, unchanged —
guard code untouched); `node scripts/e2e-rpc-two-process.mjs` → 27/27; `node
scripts/check-skill-discovery.mjs` → 8/8 in real Pi 1.4.0 RPC with an isolated
PI_CODING_AGENT_DIR + programmatic trust (skill `skill:pi-handoff` advertised by
`get_commands` with project-scope sourceInfo; references bundled and non-empty;
guard commands registered AND `/guard status` answered via trusted auto-load, no `-e`).
pli80 evidence: read-only inspection of README.md, spec/CLAIMS.md, tools/e2e_gate.py,
SOURCES.md (guide §7 facts sourced from those files; no write ever targeted pli80).

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

Phase 1d complete; next is **human review** of increments A–C + Phase 1d docs, then
the operator decisions: `renewal.autoRenew` default (stays OFF), and — separately —
whether to apply the pli80 blueprint (guide §7) as an explicit, approved install.
Verification set: `node --test test/` (131/1+skip), `scripts/e2e-rpc-two-process.mjs`
(27/27), `scripts/check-skill-discovery.mjs` (8/8); `scripts/e2e-renew.mjs` (20/20)
only after renewal-wiring changes. Exact details: HANDOFF.md "Next action".

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 9
checkpoint-id: g9-1655aaba5cf2
checkpoint-kind: manual
content-delta: new
readiness: attested
guard-level: 0
checkpointed: 2026-10-29T14:45:33.715Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: 083cf0c14a81263006fb63f72701ed1c3fc9c7decdec2e4cb384205d9b7cd505
source-handoff: 1e99be1f38057b0f550f24210da2c0a4caa08c70db8c26a7bee75c585705b357
source-learnings: 1b30baa67114f9d39d73ad926ec838bcf12e3cf90ef236758281d8abb3aed3a8
source-config: 0b1e162bdbf7ec9946afab3d1dd8b0fa35b4e3972ba77214f68c9a55276fe606
next-action: **Phase 2 (increments A+B+C) AND Phase 1d are COMPLETE. Nothing in the guard's code
changed in the Phase 1d increment — docs, skill, and one new zero-inference probe
script.** Phase 1d delivered: `.agents/skills/pi-handoff/` (operating skill +
commands/config reference + bootstrap procedure), `docs/long-project-guide.md`
(long-project integration guide, PL/I-80 case study as blueprint only — pli80 was
inspected read-only and NOT modified), `scripts/check-skill-discovery.mjs` (real-
runtime skill discovery probe; found + documented the trust-gating of project skills,
LEARNINGS A-25).

Concrete next steps, in order:

1. `node --test test/` → expect **132 tests, 131 pass, 0 fail, 1 skipped**;
   zero-inference e2e `node scripts/e2e-rpc-two-process.mjs` → 27/27;
   skill probe `node scripts/check-skill-discovery.mjs` → 8/8; real-inference renewal
   e2e `node scripts/e2e-renew.mjs` (spends inference) → 20/20 — re-run the latter only
   after a change to the renewal wiring in index.ts.
2. **Human review** of increments A–C + Phase 1d docs (code + guide + LEARNINGS
   classifications; P-7's ~195k closing point is still NOT live-observed — the renewal
   experiment triggered with synthetic pressure).
3. Operator decision: set `renewal.autoRenew: true` in `handoff.config.json` as the
   project default (model-initiated renewal then works WITHOUT the env switch) — NOT
   done here; config stays OFF until the operator says so. Likewise: applying the
   pli80 blueprint (guide §7) is a separate, explicitly-approved operator action.
4. Optional follow-ups: P-5 real two-process concurrency proof; live token-accounting
   sanity walk-through; "config-changed-since-session-start" notice (A-22).
5. Commit after every increment (local only, never push). Refresh + attest the
   checkpoint AFTER committing; commit the managed-block refresh separately when it
   dirties the tree.
readiness-by: session:01a1881f-91b1-71c8-9606-aabc3647d0eb
readiness-at: 2026-10-29T14:45:33.815Z
readiness-checkpoint: g9-1655aaba5cf2
<!-- guard:end checkpoint -->
