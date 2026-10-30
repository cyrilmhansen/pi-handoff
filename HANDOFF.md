# HANDOFF

## Recovery instructions

0. **CURRENT STATE (2026-10-30): MISSION v0.1.0-dev.2 IN PROGRESS on top of tag
   `v0.1.0-dev.1` (`2ea6219`) — operator-authorized D1-D6 reliability/recovery-efficiency
   work from the eight-renewal DRPLi campaign audit (evidence: LEARNINGS A-26/A-27/P-10).
   D1 (recovery prompt) DONE `6e61967`; D2 (finalize) DONE `8674c90`; D3 tool
   (`scripts/durable_edit.py`) smoke+dogfood verified, node tests pending; D4-D6 pending.
   Hard limits: DRPLi READ-ONLY (fixtures only, it is not on this machine); no push/tag/
   release/deploy without operator authorization; raw campaign logs outside Git. See
   PROGRESS.md Current-phase table and this file's Next action.**

1. Read `AGENTS.md`, then `PROTOCOL.md`, then this file, then `PROGRESS.md`, then
   `GOAL.md`/`LEARNINGS.md`. Do not replay transcripts.
2. `GOAL.md` is the stable objective and is guard-protected; never rewrite it silently.
   It describes the ORIGINAL Phase 1 scope ("no automatic session switching") —
   historically correct and deliberately untouched; later phases extended the scope
   under explicit operator authorization (history: PROGRESS.md / LEARNINGS.md).
3. Checkpoint freshness: the `guard:begin checkpoint` blocks are schema **v3**
   (transactional identity + sha256 fingerprints of source state; v2/v1 blocks are
   recognized as historical and validate as `stale`). **Manual prose in this file always
   takes precedence over the managed block.** Run `/handoff verify` (or read the
   `session_start` notification) to see missing/corrupt/stale/current; if stale, refresh
   with `/handoff` (rewrites only managed blocks, never manual text). Attest with
   `/handoff ready`; renewal requires `current` ∧ identity-consistent ∧ attested.
4. Verify the build: `node --test test/` (expect 132 tests: 131 pass, 1 gated skip,
   Node 26, no installs); `node scripts/e2e-rpc-two-process.mjs` (27/27, real runtime,
   zero inference); `node scripts/check-skill-discovery.mjs` (8/8, real runtime, zero
   inference). `node scripts/e2e-renew.mjs` (20/20) SPENDS REAL INFERENCE — re-run only
   after a change to the renewal wiring in `index.ts`.
5. Load the guard explicitly (no trust dependency): `pi -e .pi/extensions/context-guard/index.ts`.
   For a non-mutating audit session: `CONTEXT_GUARD_READONLY=1 CONTEXT_GUARD_STATE_DIR=/tmp/guard-state pi -e ...`
   (read-only mode can also be enabled with `--guard-readonly 1`; it protects the project
   TREE only — not an OS-level read-only filesystem; Pi transcripts live under
   `$PI_CODING_AGENT_DIR`).

## Last verified state

- Documentation consolidation (committed on top of `06fbc71`): README retitled and
  de-scoped from "Phase 1"; schema v3 stated as current everywhere (v2 marked historical);
  HANDOFF/PROGRESS restructured current-first with obsolete Phase 1c repair instructions
  removed (original text preserved in git history); L4 allowlist wording corrected to
  "`closingAllowlist` — default write/edit/read, `handoff_renew` optional and listed in
  this project"; `renewal.enabled` vs `renewal.autoRenew` distinction stated in
  README/PROTOCOL/skill/guide; PROTOCOL §7 "tests are mock-only" invariant updated to
  reflect the real-runtime zero-inference e2e scripts and the real-inference renewal
  proof; P-6/P-8 (and P-1/P-3/P-4 adoption) made explicit against A-23 in LEARNINGS.
  Docs, skill text and checkpoint refresh only — no code, test or config change.
- Baselines re-run on this tree: suite 131/132 (1 skip), zero-inference e2e 27/27,
  skill-discovery probe 8/8. Prior committed evidence: real-inference renewal
  chain 20/20 (A-23), Phase 1d trust-gated skill discovery (A-25).
- Project config: `generationReserve: 20000` (EXPERIMENTAL policy — nominal closing
  ≈195 k used is arithmetic only, not live-observed under real token accounting, P-7
  open), `closingAllowlist: [write, edit, read, handoff_renew]`,
  `renewal: enabled true / autoRenew false / maxRenewals 2`.
- pli80, Rune CI, global Pi install, compaction settings and `drpli` untouched.

## Unfinished operations

Completed milestones (history; evidence in LEARNINGS.md, code in git):

- [x] Phase 1 original: guard + durable files + mock harness, 36/36 (`b2ccdac`).
- [x] Phase 1b: checkpoint schema v2 freshness, manual-prose-first recovery, per-session
      runtime state, read-only audit mode — 55/55 at the time (historical baseline; the
      55-test figure is NO LONGER current). Defects A-6/A-7/A-8/A-9.
- [x] Phase 1c: schema v3 transactional identity, readiness gate + attestation,
      inspection-only audit loads, `/handoff ready`, detailed `/guard status`; fixed the
      module-load LinkError class (A-15) found only in the real runtime; 102/103 + real
      e2e. Commit `3cc2f31`.
- [x] Measurement-revocation fix (A-18) — suite 108/109.
- [x] Phase 2 increment A: `renewal.ts` decision module + durable chain state + RN tests
      — suite 118/119.
- [x] Phase 2 increment B: `/handoff renew` switch wiring + `handoff_renew` tool bridge
      + identity banner + lineage — RB1–RB13, suite 131/132, e2e 27/27.
- [x] Phase 2 increment C: real-inference A→B→C renewal PROVEN LIVE (A-23), 20/20 checks;
      driver-bug class documented honestly (A-24). Commit `d90f016`.
- [x] Phase 1d: `.agents/skills/pi-handoff/` + `docs/long-project-guide.md` (PL/I-80
      blueprint — pli80 inspected read-only, NOT modified); skill discovery proven live,
      trust-gating documented (A-25); probe 8/8. Commits `61ed9be`, `06fbc71`.
- [x] Documentation consolidation pass (this milestone) — README/PROTOCOL/AGENTS/HANDOFF/
      PROGRESS/LEARNINGS/skill/guide reconciled with the implementation; GOAL.md left
      untouched by design.

Outstanding (operator decisions and open proofs — NOT development tasks):

- [ ] **Operator review** of the documentation consolidation.
- [ ] **`drpli` reuse: separate, explicitly authorized operator action. Nothing has been
      deployed there.**
- [ ] Operator decision: `renewal.autoRenew` project default (currently false; enabling
      hands session-death timing to the model — mechanism proven, policy not decided).
- [ ] P-5: generalized concurrent renewal safety — only the specific two-process
      invariants of A-16 were tested; do NOT claim concurrency is proven.
- [ ] P-7: live observation of the ≈195 k closing point under real token accounting
      (the renewal experiment triggered with synthetic pressure).
- [ ] Live interactive-session walkthrough of `/guard simulate` with a real Sushi model
      (token-accounting sanity check; do not spend tokens hunting thresholds).
- [ ] A-22 follow-up: "config-changed-since-session-start" notice (proposal, unbuilt).

## Next action
**Pre-D5 adjustments DONE and committed (A-31 runtime audit — active guard is the TREE
candidate, pinned dev.1 byte-identical to `v0.1.0-dev.1` and reserved for the refresh
ritual; A-32 cap-raise verification + RN15 regression; config `maxRenewals: 8`,
`generationReserve: 5000`). Executing D5 test-first** — (a) honest level-4 wording under
`enforceClosing:false`; (b) `RENEWAL AVAILABLE` only behind a write-free preview gate,
safe instructions otherwise (finalize at cap); (c) `diagnostics.ts` +
`<stateDir>/diagnostics.jsonl` + `/guard events [n]`, `agent_settled.aborted` recorded,
NEVER auto-retried; (d) banner `GUARD_VERSION` (P-9). Then D4, D6, dogfood proofs
(e2e-renew on the candidate + capped-chain finalize + recovery-cost vs A-27), release
docs; STOP for operator review. Gates after any extension edit: suite, e2e-rpc (32/32),
skill probe (8/8); e2e-renew only as the scheduled candidate proof. Post-commit ritual:
prose via `scripts/durable_edit.py`; refresh via `node /tmp/refresh-pinned.mjs "notes"`
(PINNED dev.1, `pi --mode rpc -ne -e <pinned>`); commit managed blocks. NEVER
push/tag/release; DRPLi untouched; raw logs outside Git.

Historical successor sequence (D4/D6 details; D5 superseded by the above):

1. Gates first: `node --test test/` (expect **158 pass / 1 skip**),
   `node scripts/e2e-rpc-two-process.mjs` (**32/32**), `node scripts/check-skill-discovery.mjs`
   (**8/8**). Suite baseline moved 131→158 during dev.2 (D1 +6, D2 +9, D3 +12, DE fixes).
2. **D5** (test-first): (a) level-4 alert must NOT claim blocking when
   `enforceClosing:false` — parameterize `defaultThresholds(t,{enforceClosing})` and pass
   config in `buildMachine`/restore; (b) `RENEWAL AVAILABLE` hint only when a full
   WRITE-FREE preview passes (`decideRenewal` with live checkpointId + renewAuthorization +
   durable stop + cap + readOnly); otherwise safe instructions incl. finalize-at-cap;
   (c) `diagnostics.ts` + `<stateDir>/diagnostics.jsonl` (JSONL, ISO+epoch, types
   session_start/alert/revocation/renewal_request/renewal_result/finalize/tool_block/
   turn_aborted; NO prompts/tool args/secrets; rotation ~500; external-stateDir rule in
   audit mode; `/guard events [n]`); `agent_settled.aborted` is the interruption signal —
   record it, NEVER retry automatically. (d) banner label: drop hardcoded "Phase 2
   increment B", add `GUARD_VERSION` (P-9).
3. **D4**: lean-recovery tiers (operational/methodology/archive), opt-in
   `recovery.lean:false` default, schema v3 compatible, cost meter in
   verify/finalize/status, DRPLi-shaped fixture GENERATED in tests (six docs ~121,312
   chars; assert full mandatory set >> budget, lean tier ≤ 12k est tokens, archive refs
   exist; `spec/CLAIMS.md` authority preserved by reference).
4. **D6**: pure `crossingPoints` in core.ts (window 95k, reserve 5k → used 70/78/82/85k),
   `/guard status` crossing line + provenance + honest "guard never changes the model
   window" wording; `docs/profiles/experimental-95k.json` example.
5. Dogfood + measures: real-inference `node scripts/e2e-renew.mjs` on the CANDIDATE
   (hop-1 model-initiated, byte-exact recovery-message checks, successor commits real
   work); capped-chain finalize proof (zero inference); recovery-cost before/after vs
   A-27; CHANGELOG dev.2 + migration/rollback from v0.1.0-dev.1; release-readiness
   assessment. Then STOP for operator review.
6. Post-commit ritual: update prose via `scripts/durable_edit.py`; refresh via
   `node /tmp/refresh-pinned.mjs "notes"` (PINNED dev.1 guard; `pi --mode rpc -ne -e
   <pinned>` — `-ne` required, else auto-load conflicts P-12); commit managed blocks.
7. NEVER push/tag/release; DRPLi untouched; raw logs outside Git.
## Discoveries not yet incorporated

Open caveats (durable knowledge lives in LEARNINGS.md):

- `sendMessage` deferral semantics (A-2/A-13) are source-verified and mock-asserted;
  full live turn-delivery observation is still opt-in (`GUARD_E2E_LLM=1`, aborted
  attempt in Phase 1c era).
- `getContextUsage().tokens` is an estimate (A-1); synthetic threshold tests do NOT
  validate real token accounting (A-18/A-22 record real estimate swings and the
  operator-is-right re-baselining procedure).
- Audit mode protects the project TREE only; Pi transcripts persist under
  `$PI_CODING_AGENT_DIR`; full immutability needs an OS-level snapshot (A-8, §2.3).
- RPC-mode startup race: commands dispatched before `session_start` hit an
  uninitialized extension; liveness probes must trigger a response (`/guard status`
  polling — A-9/A-20).
- The identity banner in `index.ts` still self-describes as "Phase 2 increment B"
  (hardcoded label, index.ts:311) although increment C is complete. Cosmetic
  implementation-layer doc inconsistency; OUT OF SCOPE for this docs-only pass —
  recorded here and in LEARNINGS (Proposed) as a finding.
- Historical note: before the consolidation, this file carried obsolete Phase 1c
  repair instructions ("suite is RED, do NOT commit", 55-test baseline, step lists)
  that could have misled a fresh session into re-doing completed work. The
  root-cause lesson of that era (invalid re-export → module-link failure at load,
  A-15) remains in LEARNINGS; the obsolete prose was removed in the consolidation
  commits and survives verbatim in git history up to `06fbc71`.

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 18
checkpoint-id: g18-38efc751253c
checkpoint-kind: manual
content-delta: new
readiness: attested
status: checkpoint (guard level 0, remaining ~214902, session 01a18bb6-55ce-7471-b466-9db059e05998)
checkpointed: 2026-10-30T07:29:06.020Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: c649bfad06ac135b94327c4118375c0445373913f725a52c0b2261829c4203c2
source-handoff: f05c050da628bde264f0dcfff75f478f3235ed7a720e0480a17daaa7ce0bb159
source-learnings: 20c7278acf6b30220a3eb8a94e34cc374c4dcde2467ba93429ec8994a4932e64
source-config: 0e1d558f99398890048c7319d998914290193337deaa6eb651db33b6c9e4fa18


readiness-by: session:01a18bb6-55ce-7471-b466-9db059e05998
readiness-at: 2026-10-30T07:29:06.122Z
readiness-checkpoint: g18-38efc751253c
### Last verified state
guard level 0; checkpoint requested (pre-D5 adjustments committed fcea69c (cap 8 chain-safe A-32/RN15, runtime audit A-31); D5 in progress)

### Unfinished operations
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint
- [x] Reproduced and fixed the two audit defects (A-6 stale-checkpoint blindness →
- [x] Read-only audit mode (A-8/A-10: instruction and "zero-writes" claims were false
- [x] Transactional checkpoint identity (schema 3): interrupted/mixed/obsolete
- [x] `evaluateHandoffReadiness()` + `attestHandoff()` + `renewAuthorization()`;
- [x] Extension-load LinkError (A-15) found ONLY in the real runtime; detailed
- [x] Renewal contract implemented per PROTOCOL §6 (`renewal.ts`, chain state, gates,
- [x] `/handoff renew` (operator), `handoff_renew` tool + `/handoff renew go` bridge
- [x] Real-inference A→B→C proof (A-23): model hop 1, operator hop 2, cap refusal;
- [x] `.agents/skills/pi-handoff/` (SKILL.md + commands/config + bootstrap) and
- [x] All confirmed inconsistencies corrected (see Current phase); verification

### Next action
**Pre-D5 adjustments DONE and committed (A-31 runtime audit — active guard is the TREE
candidate, pinned dev.1 byte-identical to `v0.1.0-dev.1` and reserved for the refresh
ritual; A-32 cap-raise verification + RN15 regression; config `maxRenewals: 8`,
`generationReserve: 5000`). Executing D5 test-first** — (a) honest level-4 wording under
`enforceClosing:false`; (b) `RENEWAL AVAILABLE` only behind a write-free preview gate,
safe instructions otherwise (finalize at cap); (c) `diagnostics.ts` +
`<stateDir>/diagnostics.jsonl` + `/guard events [n]`, `agent_settled.aborted` recorded,
NEVER auto-retried; (d) banner `GUARD_VERSION` (P-9). Then D4, D6, dogfood proofs
(e2e-renew on the candidate + capped-chain finalize + recovery-cost vs A-27), release
docs; STOP for operator review. Gates after any extension edit: suite, e2e-rpc (32/32),
skill probe (8/8); e2e-renew only as the scheduled candidate proof. Post-commit ritual:
prose via `scripts/durable_edit.py`; refresh via `node /tmp/refresh-pinned.mjs "notes"`
(PINNED dev.1, `pi --mode rpc -ne -e <pinned>`); commit managed blocks. NEVER
push/tag/release; DRPLi untouched; raw logs outside Git.

Historical successor sequence (D4/D6 details; D5 superseded by the above):

1. Gates first: `node --test test/` (expect **158 pass / 1 skip**),
   `node scripts/e2e-rpc-two-process.mjs` (**32/32**), `node scripts/check-skill-discovery.mjs`
   (**8/8**). Suite baseline moved 131→158 during dev.2 (D1 +6, D2 +9, D3 +12, DE fixes).
2. **D5** (test-first): (a) level-4 alert must NOT claim blocking when
   `enforceClosing:false` — parameterize `defaultThresholds(t,{enforceClosing})` and pass
   config in `buildMachine`/restore; (b) `RENEWAL AVAILABLE` hint only when a full
   WRITE-FREE preview passes (`decideRenewal` with live checkpointId + renewAuthorization +
   durable stop + cap + readOnly); otherwise safe instructions incl. finalize-at-cap;
   (c) `diagnostics.ts` + `<stateDir>/diagnostics.jsonl` (JSONL, ISO+epoch, types
   session_start/alert/revocation/renewal_request/renewal_result/finalize/tool_block/
   turn_aborted; NO prompts/tool args/secrets; rotation ~500; external-stateDir rule in
   audit mode; `/guard events [n]`); `agent_settled.aborted` is the interruption signal —
   record it, NEVER retry automatically. (d) banner label: drop hardcoded "Phase 2
   increment B", add `GUARD_VERSION` (P-9).
3. **D4**: lean-recovery tiers (operational/methodology/archive), opt-in
   `recovery.lean:false` default, schema v3 compatible, cost meter in
   verify/finalize/status, DRPLi-shaped fixture GENERATED in tests (six docs ~121,312
   chars; assert full mandatory set >> budget, lean tier ≤ 12k est tokens, archive refs
   exist; `spec/CLAIMS.md` authority preserved by reference).
4. **D6**: pure `crossingPoints` in core.ts (window 95k, reserve 5k → used 70/78/82/85k),
   `/guard status` crossing line + provenance + honest "guard never changes the model
   window" wording; `docs/profiles/experimental-95k.json` example.
5. Dogfood + measures: real-inference `node scripts/e2e-renew.mjs` on the CANDIDATE
   (hop-1 model-initiated, byte-exact recovery-message checks, successor commits real
   work); capped-chain finalize proof (zero inference); recovery-cost before/after vs
   A-27; CHANGELOG dev.2 + migration/rollback from v0.1.0-dev.1; release-readiness
   assessment. Then STOP for operator review.
6. Post-commit ritual: update prose via `scripts/durable_edit.py`; refresh via
   `node /tmp/refresh-pinned.mjs "notes"` (PINNED dev.1 guard; `pi --mode rpc -ne -e
   <pinned>` — `-ne` required, else auto-load conflicts P-12); commit managed blocks.
7. NEVER push/tag/release; DRPLi untouched; raw logs outside Git.

### Guard notes
pre-D5 adjustments committed fcea69c (cap 8 chain-safe A-32/RN15, runtime audit A-31); D5 in progress
<!-- guard:end checkpoint -->
