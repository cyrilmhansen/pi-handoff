# HANDOFF

## Recovery instructions

0. **CURRENT STATE (2026-10-30): MISSION v0.1.0-dev.2 + D7 + D8 COMPLETE — release-ready
   candidate STOPPED at operator review; NOT tagged, NOT pushed. D8 = Pi Handoff builders
   on the Rune CI Buildbot (`rune-ci-handoff submit <sha> --suite integration`; evidence
   bs54–bs57, LEARNINGS A-38/A-39, rune-ci README §14; CL7e fix commit `435c294`;
   Rune CI touched ONLY inside the D8 handoff files, DRPLi fingerprint byte-stable;
   live-suite spend still requires explicit operator authorization).** All six dev.2
   increments committed on tag `v0.1.0-dev.1` (`2ea6219`): D1 `6e61967`, D2
   `8674c90`, D3 `1d48de3`, pre-D5 adjustments `fcea69c`+`b6445aa` (A-31/A-32/RN15), D5
   `05379b0` (A-33), D4 `b86b0fe` (A-34 — committed by successor 01a18bef after the
   parent L4 closed bash), D6 `d77ef48` (A-35) + checkpoint refreshes; then the
   operator-authorized **D7 test-artifact lifecycle increment** (all four e2e cleanup
   defects fixed via `scripts/lib/e2e-cleanup.mjs`; 13 new zero-inference tests in
   `test/cleanup.test.ts`; A-37). ALL dogfood proofs
   DONE: real-inference e2e-renew **24/24 on the candidate** (model-initiated hop 1
   under the D5b preview gate; byte-exact recovery message incl. configured prompt +
   testCommand; productive successor commits; cap refusal; zero replay/compaction; D6
   numeric crossings observed live) — A-36; capped-chain finalize proof in the REAL
   runtime zero-inference (e2e-rpc CAP section, 38/38) — A-35; recovery-cost
   comparison vs A-27 (this tree: full ≈ 28.7k vs lean operational ≈ 8.8k est.
   tokens, chars/4) — A-36. Release docs: **CHANGELOG.md** (dev.2 + migration/
   rollback + release readiness). Gates after D7: suite 200/1 skip (201 tests),
   real-pi e2e-rpc 38/38, probe 8/8 (both re-run green on the REFACTORED drivers);
   e2e-renew live re-run NOT spent post-D7 (lifecycle-only change; A-37). Hard
   limits held: DRPLi untouched (fixtures/clone proofs only); nothing pushed;
   raw campaign logs outside Git.**

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
4. Verify the build: `node --test test/` (expect **201 tests: 200 pass, 0 fail, 1
   gated skip**, Node 26, no installs; incl. D7 `test/cleanup.test.ts` — 13
   zero-inference lifecycle tests that drive the REAL e2e scripts against a fake-pi
   stub on PATH); `node scripts/e2e-rpc-two-process.mjs`
   (**38/38**, real runtime, zero inference); `node scripts/check-skill-discovery.mjs`
   (8/8, real runtime, zero inference). `node scripts/e2e-renew.mjs` (**24/24** at the
   dev.2 candidate `b07e29b` — A-36; lifecycle-only D7 driver changes are covered
   zero-inference, the live re-run awaits an authorized real-inference pass) SPENDS
   REAL INFERENCE — re-run only after a change to the renewal wiring in `index.ts`.
   E2E artifacts self-clean (scripts/lib/e2e-cleanup.mjs; `GUARD_E2E_KEEP=1` is the
   ONLY retention value; SIGKILL/crashes may leak and are NOT swept).
5. Load the guard explicitly (no trust dependency): `pi -e .pi/extensions/context-guard/index.ts`.
   For a non-mutating audit session: `CONTEXT_GUARD_READONLY=1 CONTEXT_GUARD_STATE_DIR=/tmp/guard-state pi -e ...`
   (read-only mode can also be enabled with `--guard-readonly 1`; it protects the project
   TREE only — not an OS-level read-only filesystem; Pi transcripts live under
   `$PI_CODING_AGENT_DIR`).

## Last verified state

- **D7 (2026-10-30, this session): test-artifact lifecycle increment COMPLETE.**
  `scripts/lib/e2e-cleanup.mjs` (ArtifactTracker: register-at-creation, child shutdown
  BEFORE workspace removal, signal + 'exit' safety nets, per-invocation ownership —
  no sweeper, `GUARD_E2E_KEEP=1`-only retention) wired into all three e2e scripts;
  `test/cleanup.test.ts` CL1–CL8 (13 tests, zero inference incl. real scripts driven
  by a fake-pi stub: LLM-workspace cleanup, KEEP=0/1 semantics, SIGTERM mid-run, setup
  failure, sentinel/no-sweeper proofs). Two harness defects found en route (TDZ in a
  synchronous-exit cleanup callback; unref needed for the exit-safety-net worker) —
  A-37. Production guard, renewal wiring, scientific evidence and DRPLi NOT touched.
  Gates: suite 200 pass / 1 skip; real-pi e2e-rpc 38/38; probe 8/8.
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
- [x] Documentation consolidation pass — README/PROTOCOL/AGENTS/HANDOFF/
      PROGRESS/LEARNINGS/skill/guide reconciled with the implementation; GOAL.md left
      untouched by design.
- [x] **v0.1.0-dev.2 mission (COMPLETE 2026-10-30):** D1-D6
      reliability + recovery-efficiency increments from the DRPLi campaign audit —
      recovery-prompt fix (D1), finalize (D2), durable_edit.py (D3), lean tiers +
      cost meter (D4), honest alerts + write-free preview + diagnostics (D5), crossing
      points + 95k profile (D6); all dogfood proofs green incl. real-inference 24/24
      on the candidate and the real-runtime capped-chain finalize proof (LEARNINGS
      A-28…A-36; CHANGELOG.md).
- [x] **D7 test-artifact lifecycle (COMPLETE 2026-10-30, operator-authorized):** four
      e2e cleanup defects fixed (creation-before-try leaks, missing `guard-e2e-llm-*`
      in the cleanup list, `GUARD_E2E_KEEP=0` truthiness bug, orphaned children/artifacts
      on signals); shared `scripts/lib/e2e-cleanup.mjs`; 13 lifecycle tests;
      LEARNINGS A-37; CHANGELOG.md. NOT tagged, NOT pushed.

- [x] **D9 final skill & release documentation audit (COMPLETE 2026-10-30,
      operator-authorized):** pre-tag docs pass — seven-module install recipes, SKILL.md
      full-vs-lean recovery wording, commands.md dev.2 refresh (D4 config, D6 crossings,
      env overrides, version), guide obsolete examples, CHANGELOG D8 folded under
      v0.1.0-dev.2 (external Rune-CI files explicitly NOT claimed as packaged here),
      README status/reserve corrections, regression guard `test/docs.test.ts` DC1–DC5
      (LEARNINGS A-41). Docs + one test file; production guard untouched.

Outstanding (operator decisions and open proofs — NOT development tasks):

- [ ] **Operator review** of the v0.1.0-dev.2 candidate (incl. D7, D8, D9 and the
      earlier documentation consolidation).
- [ ] **`drpli` reuse: separate, explicitly authorized operator action. Nothing has been
      deployed there.**
- [ ] Operator decision: `renewal.autoRenew` project default (currently false; enabling
      hands session-death timing to the model — mechanism proven, policy not decided).
- [ ] Operator decision: `recovery.lean` (dev.2 D4 tiers default OFF; measured
      projection ≈69 % less first-turn reading on this tree — A-36 — not activated).
- [ ] P-5: generalized concurrent renewal safety — only the specific two-process
      invariants of A-16 were tested; do NOT claim concurrency is proven.
- [ ] P-7: live observation of the nominal closing point under real token accounting
      (≈195 k at the earlier reserve 20 000; dev.2 config reserves 5 000 ⇒ ≈210 k;
      the renewal experiments triggered with synthetic pressure).
- [ ] Live interactive-session walkthrough of `/guard simulate` with a real Sushi model
      (token-accounting sanity check; do not spend tokens hunting thresholds).
- [ ] A-22 follow-up: "config-changed-since-session-start" notice (proposal, unbuilt).

## Next action
**STOP — dev.2 + D7 + D8 + D9 COMPLETE, awaiting OPERATOR REVIEW (A-36/A-37/A-38/
A-39/A-41, CHANGELOG.md §v0.1.0-dev.2 incl. D8 + D9). No further implementation
without operator direction.** D9 closed the pre-tag documentation audit; the candidate
docs now match the runtime surface (machine-checked by DC1–DC5). D8 adds
decision points: authorize a `--suite live` spend (real inference; do not run it
alongside interactive Pi sessions on Sushi), decide whether to keep/extend the
tac-injection design, and optionally greenlight A-40 (unit-fixture /tmp cleanup).
A handoff CI build can now be requested with
`/home/john/services/rune-ci/bin/rune-ci-handoff submit $(git rev-parse HEAD) --suite integration`. Operator decision points: (1)
review the dev.2+D7 range `4df08a8..HEAD` (one commit per increment + refreshes);
(2) authorize or withhold tag `v0.1.0-dev.2` + push (NEITHER is done; D7 is included
in the candidate); (3) separately authorize `drpli`
reuse (blueprint: docs/long-project-guide.md §7 + skill bootstrap; CHANGELOG migration/
rollback sections are the install notes); (4) optional policy calls: enable
`recovery.lean`, raise `renewal.autoRenew`, adjust caps; (5) optional authorized
real-inference pass: re-run `node scripts/e2e-renew.mjs` (24/24) to move the live
renewal proof onto the post-D7 tip — not required by D7 (renewal wiring unchanged).
Open caveats that travel with any release claim: P-5 concurrency NOT generalized; P-7 live closing point NOT observed
under real accounting (nominal crossings printed live, never reached); lean-tier benefit
is fixture/meter projection (chars/4), not campaign re-run. Historical `/tmp/guard-*`
leaks from pre-D7 interrupted runs remain on this machine (A-37 evidence; deleting them
is an operator action — scripts never sweep). Successors: if woken without
operator input, verify gates (`node --test test/`, e2e-rpc, probe), do NOT open new
implementation, keep docs/checkpoints current.

Historical successor sequence (superseded for D5/D4 by the above; D6 details live in
PROGRESS.md):

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
- The identity banner in `index.ts` once self-described as "Phase 2 increment B"
  (hardcoded label; recorded as a finding in the pre-dev.2 docs pass). RESOLVED in
  dev.2 D5d (commit `05379b0`): the banner is now `context-guard (project-local,
  v<GUARD_VERSION>)` with an env-overridable `GUARD_VERSION` (P-9 resolved). Kept
  here so this file's history stays honest about what was known when.
- Historical note: before the consolidation, this file carried obsolete Phase 1c
  repair instructions ("suite is RED, do NOT commit", 55-test baseline, step lists)
  that could have misled a fresh session into re-doing completed work. The
  root-cause lesson of that era (invalid re-export → module-link failure at load,
  A-15) remains in LEARNINGS; the obsolete prose was removed in the consolidation
  commits and survives verbatim in git history up to `06fbc71`.

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 27
checkpoint-id: g27-b82ddbb7eb86
checkpoint-kind: manual
content-delta: none
readiness: attested
status: checkpoint (guard level 0, remaining ~214902, session 01a18ca9-56f9-7533-9c67-70ee25910022)
checkpointed: 2026-10-30T11:54:31.569Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: 67f820070b265cb39a8ec67cc0a1d365cb31bfa8d831941d7484c47c6bce0968
source-handoff: d36b5cfa90e2eee2d390d689fc93df129104f0a027c0903592fe48ad592b3a81
source-learnings: 4fd55adc56216d341ccc9377174eec10d52479f963ed5ce7eb485d6d8bce3a25
source-config: 0e1d558f99398890048c7319d998914290193337deaa6eb651db33b6c9e4fa18


readiness-by: session:01a18ca9-56f9-7533-9c67-70ee25910022
readiness-at: 2026-10-30T11:54:31.670Z
readiness-checkpoint: g27-b82ddbb7eb86
### Last verified state
guard level 0; checkpoint requested (D8 COMPLETE: handoff CI on Rune Buildbot (rune-ci-handoff; bs54 defect-find, bs55 FAILED-probe failed-not-infra, bs56 green+reused on 435c294, bs57 DRPLi smoke no-fp-warning; DRPLi fp 6729fc4b byte-stable via buildbot.tac injection; live suite stub-proven, spend = operator decision; STOP for operator review))

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
**STOP — dev.2 + D7 + D8 COMPLETE, awaiting OPERATOR REVIEW (A-36/A-37/A-38/A-39,
CHANGELOG.md). No further implementation without operator direction.** D8 adds
decision points: authorize a `--suite live` spend (real inference; do not run it
alongside interactive Pi sessions on Sushi), decide whether to keep/extend the
tac-injection design, and optionally greenlight A-40 (unit-fixture /tmp cleanup).
A handoff CI build can now be requested with
`/home/john/services/rune-ci/bin/rune-ci-handoff submit $(git rev-parse HEAD) --suite integration`. Operator decision points: (1)
review the dev.2+D7 range `4df08a8..HEAD` (one commit per increment + refreshes);
(2) authorize or withhold tag `v0.1.0-dev.2` + push (NEITHER is done; D7 is included
in the candidate); (3) separately authorize `drpli`
reuse (blueprint: docs/long-project-guide.md §7 + skill bootstrap; CHANGELOG migration/
rollback sections are the install notes); (4) optional policy calls: enable
`recovery.lean`, raise `renewal.autoRenew`, adjust caps; (5) optional authorized
real-inference pass: re-run `node scripts/e2e-renew.mjs` (24/24) to move the live
renewal proof onto the post-D7 tip — not required by D7 (renewal wiring unchanged).
Open caveats that travel with any release claim: P-5 concurrency NOT generalized; P-7 live closing point NOT observed
under real accounting (nominal crossings printed live, never reached); lean-tier benefit
is fixture/meter projection (chars/4), not campaign re-run. Historical `/tmp/guard-*`
leaks from pre-D7 interrupted runs remain on this machine (A-37 evidence; deleting them
is an operator action — scripts never sweep). Successors: if woken without
operator input, verify gates (`node --test test/`, e2e-rpc, probe), do NOT open new
implementation, keep docs/checkpoints current.

Historical successor sequence (superseded for D5/D4 by the above; D6 details live in
PROGRESS.md):

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
D8 COMPLETE: handoff CI on Rune Buildbot (rune-ci-handoff; bs54 defect-find, bs55 FAILED-probe failed-not-infra, bs56 green+reused on 435c294, bs57 DRPLi smoke no-fp-warning; DRPLi fp 6729fc4b byte-stable via buildbot.tac injection; live suite stub-proven, spend = operator decision; STOP for operator review)
<!-- guard:end checkpoint -->
