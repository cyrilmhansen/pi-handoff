# PROGRESS

## Current phase

**Mission v0.1.0-dev.2 — COMPLETE, release-ready candidate, STOPPED at operator review
(2026-10-30).** All six increments committed on tag `v0.1.0-dev.1` (`2ea6219`): D1
`6e61967`, D2 `8674c90`, D3 `1d48de3`, pre-D5 adjustments `fcea69c`+`b6445aa`
(A-31/A-32/RN15), D5 `05379b0` (A-33), D4 `b86b0fe` (A-34), D6 `d77ef48` (A-35), plus
checkpoint refreshes. D4 was verified green by the parent session (01a18baa) but L4
closed bash before the commit; successor 01a18bef re-ran the suite FIRST (184/185
pass) and committed it with explicit paths — the class of interruption this project
exists to survive. DOGFOOD PROOF ALL DONE: real-inference `scripts/e2e-renew.mjs`
**24/24 on the candidate** (model-initiated hop 1 under the D5b write-free preview
gate — with a zero-inference attest-prep driver pass, since patching the clone config
legitimately stales the checkpoint; BYTE-EXACT recovery message vs reconstruction
incl. configured recoveryPrompt + testCommand — A-26 class proven fixed live;
productive successor commits X-1/X-2, suite 187 in the clone; cap 2/2 pinned for the
experiment, refusal verified; zero replay/compaction; D6 numeric crossings observed
LIVE: 185k/195k/205k/210k at window 220k − reserve 5k) — A-36; capped-chain
finalization proof in the REAL runtime, zero inference (e2e-rpc CAP section: renew
refused `(capped)` BEFORE waitForIdle; finalize FINALIZED, chain bytes identical
8/8, no switch) — A-35; recovery-cost comparison vs A-27 recorded (A-36). Release
docs: CHANGELOG.md (dev.2 + migration + rollback + release readiness). Gates: suite
187/1 skip, e2e-rpc 38/38, probe 8/8. Renewals 2/8 used (this session), chain
chain:01a18a1a…; guard here = tree candidate pre-D6 load (A-31); a session restart
picks up the tip.

**Mission v0.1.0-dev.2 (COMPLETE, started 2026-10-30).** Operator-authorized development
mission on top of tag `v0.1.0-dev.1` (`2ea6219`): implement D1-D6 from the eight-renewal
DRPLi campaign audit (evidence reproduced in LEARNINGS A-26/A-27). Priority: useful
scientific work per token + reliable unsupervised continuation. Hard limits (Held):
DRPLi was READ-ONLY for this mission (not on this machine — isolated fixtures/clone
only); nothing pushed/tagged/released/deployed; raw campaign logs stay outside Git.

Increments:

| # | Work | State |
|---|---|---|
| D1 | Recovery prompt: configured `renewal.recoveryPrompt` reaches the successor message (mandatory identity/safety kept); project-configured `renewal.testCommand`; hardcoded `node --test test/` removed; exact-message tests | DONE — commit `6e61967` (unit 137/138; real-runtime zero-inference 28/28; byte-exact real-inference check EXECUTED on the candidate: 24/24, A-36) |
| D2 | `/handoff finalize` + `handoff_finalize` tool: independent finalization (capped/disabled/stopped OK; never switches, never touches chain state, never bypasses readiness; no waitForIdle) | DONE — FZ1-FZ9 9/9; commit `8674c90`; real-runtime capped-chain proof later completed (CAP 38/38, A-35) |
| D3 | `scripts/durable_edit.py` targeted durable-doc editing | DONE — DE0-DE11 (12 tests: dry-run, byte-identity, fences, AMBIGUOUS/NOT_FOUND/CONFLICT/MANAGED/MISSING_REF, failed-write atomicity, JSON, guard round-trip stale→refresh, no-git); suite 158/159 |
| D4 | Compact recovery (lean tiers ≤10-12k est. tokens, opt-in, schema v3 compatible, DRPLi-sized fixture) | DONE — recovery.ts + config recovery.lean (default false) + tiers + cost meter in status/verify/finalize; RC1-RC6 6/6; commit `b86b0fe` (successor committed after parent L4 closed bash; suite 184/185 verified green BEFORE commit) |
| D5 | Accurate level-4 text under enforceClosing:false; honest RENEWAL AVAILABLE (cap/stop/read-only/auth preview); safe instructions at cap; structured diagnostics (no prompts/args/secrets); NO auto-retry | DONE — test/d5.test.ts 19/19 (D5a/b, DG1-9, D5d), suite 178/179, e2e-rpc 32/32, skill probe 8/8; A-33; P-9 resolved (GUARD_VERSION banner) |
| D6 | 95k/5k experimental profile: crossings 70k/78k/82k/85k in /guard status, reserve+provenance, honest window ownership | DONE — core.ts crossingPoints + status line + docs/profiles/experimental-95k.json; D6x1-3; suite 187/188, e2e-rpc 38/38 (CAP finalize proof + crossing-line check), probe 8/8; numeric line observed LIVE with real model (A-36); commit `d77ef48` |

Dogfooding (corrected 2026-10-30, A-31): the pi process hosting this mission was
RESTARTED at 08:15+01:00 (session 01a18a1a resumed → renewal into 01a18baa), so the
ACTIVE guard in the development sessions is the TREE CANDIDATE (dev.2: D1+D2+D3 code —
proved by the live `handoff_finalize` tool registration). The pinned dev.1 copy at
`/home/john/pi-handoff-pinned-v0.1.0-dev.1` is byte-identical to tag `v0.1.0-dev.1`
(A-31) and remains the recovery infrastructure for the post-commit refresh ritual
(`/tmp/refresh-pinned.mjs`, `pi --mode rpc -ne -e <pinned>`, P-12) — dev.1 has NO
finalize; never claim it in pinned sessions. Candidate validation COMPLETED in
separate real Pi sessions: zero-inference e2e-rpc 38/38 (incl. the capped-chain
finalize proof, A-35) + skill probe 8/8, and the real-inference e2e-renew 24/24 on
the candidate (model-initiated hop 1 + byte-exact recovery checks + productive
continuation, A-36).
## Completed

Phase 1 (original, `b2ccdac`):
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint
      module, extension adapter, mock harness; 36/36; jiti + real Pi 1.4.0 RPC verified.

Phase 1b:
- [x] Reproduced and fixed the two audit defects (A-6 stale-checkpoint blindness →
      source-hash freshness + prose-first precedence; A-7 single-slot state overwrite →
      per-session `sessions/<id>.json` + newest-wins v1 migration).
- [x] Read-only audit mode (A-8/A-10: instruction and "zero-writes" claims were false
      until tree-containment and inspection-only loads were built); 55/55 at the time.

Phase 1c (`3cc2f31`):
- [x] Transactional checkpoint identity (schema 3): interrupted/mixed/obsolete
      generations validate as stale+partial, never current.
- [x] `evaluateHandoffReadiness()` + `attestHandoff()` + `renewAuthorization()`;
      auto-checkpoints preserve substantive prose (Phase 1b information-loss bug).
- [x] Extension-load LinkError (A-15) found ONLY in the real runtime; detailed
      `/guard status`; pruning disabled by default; harness defects A-14.

Phase 2 (increments A+B+C, `d90f016`):
- [x] Renewal contract implemented per PROTOCOL §6 (`renewal.ts`, chain state, gates,
      recovery prompt naming only durable files).
- [x] `/handoff renew` (operator), `handoff_renew` tool + `/handoff renew go` bridge
      (fire-and-forget, P-8), durable stop/resume, cap, idempotence, lineage, banner.
- [x] Real-inference A→B→C proof (A-23): model hop 1, operator hop 2, cap refusal;
      fresh successors, zero replay, zero compaction; both successors committed work.
      Driver-bug class honestly recorded (A-24: run 1 was 18/20 due to driver, guard OK).

Phase 1d (`61ed9be`, `06fbc71`):
- [x] `.agents/skills/pi-handoff/` (SKILL.md + commands/config + bootstrap) and
      `docs/long-project-guide.md`; project skills are TRUST-GATED (A-25);
      `scripts/check-skill-discovery.mjs` 8/8 in real Pi 1.4.0 RPC, zero inference.

Documentation consolidation (this pass):
- [x] All confirmed inconsistencies corrected (see Current phase); verification
      baselines re-run green; managed checkpoint refreshed + re-attested after commit.

## Pending

- [ ] **v0.1.0-dev.2 mission: COMPLETE** (D1-D6 + all proofs, A-28…A-36; CHANGELOG.md);
      operator review + tag/push authorization + drpli-reuse authorization pending.
- [ ] Operator review of the documentation consolidation, then separately
      authorized `drpli` integration (nothing deployed; blueprint = guide + bootstrap).
- [ ] Operator decision: `renewal.autoRenew` default (stays OFF until decided).
- [ ] P-5: generalized concurrent renewal safety (only A-16's specific two-process
      invariants tested; atomic rename ≠ concurrency proof). Do not claim it.
- [ ] P-7: live observation of ≈195 k nominal closing under real token accounting
      (experiment used synthetic triggering).
- [ ] Live `/guard simulate` walkthrough on a real Sushi model (accounting sanity only).
- [ ] A-22: "config-changed-since-session-start" notice (proposal, unbuilt).
- [ ] Finding (docs pass): identity banner hardcodes "Phase 2 increment B"
      (index.ts:311) although increment C is complete — code change, out of scope here;
      proposed in LEARNINGS.

## Verified evidence

Current (dev.2 completion, this successor session):
- Real inference (A-36): `node scripts/e2e-renew.mjs` on the CANDIDATE → **24/24**
  (clone `b07e29b`, sushi/Qwen3.8-Flash-Next; model-initiated hop 1 under D5b, byte-exact
  recovery message, cap 2/2 pinned + refusal, productive successors, zero replay/compaction,
  D6 numeric crossings live). Driver fixes in the same commit (A-24 class).
- Recovery-cost comparison (chars/4 ESTIMATES, A-36): campaign 13,077→100,563 chars/hop,
  583,609 chars ≈ 145.9k est. tokens across 8 successors; fixture RC2 ≈ 30.3k vs
  lean 10k; this tree full ≈ 28,710 vs lean operational ≈ 8,802 est. tokens.

Earlier this milestone (zero inference):
- `node --test test/` → **188 tests: 187 pass, 0 fail, 1 skipped** (incl. test/d6.test.ts
  D6x1-3; Node v26.12.1, no installs).
- `node scripts/e2e-rpc-two-process.mjs` → **38/38** (real Pi 1.4.0 RPC; NEW: CAP section
  — capped-chain finalization proof, renewal refused at the no-write pre-gate BEFORE
  waitForIdle, finalize FINALIZED with chain bytes identical, no switch — plus the
  crossing-line presence check; the isolated env observes the honest `unavailable`
  branch because no model is declared).
- `node scripts/check-skill-discovery.mjs` → **8/8**.
- Recovery meter on this tree (A-35): full 114,839 chars ≈ 28,710 est. tokens; lean
  operational 35,206 chars ≈ 8,802 est. tokens (chars/4 estimates).

Historical (docs-consolidation pass, zero inference):
- `node --test test/` → **132 tests: 131 pass, 0 fail, 1 skipped** (gated real-LLM
  branch), Node v26.12.1, no installs.
- `node scripts/e2e-rpc-two-process.mjs` → **27/27** (real Pi 1.4.0 RPC, isolated
  agent dir: two-process state isolation, audit byte-identity, suppressed-repair
  reporting, renewal stop/resume/status, no switch without inference).
- `node scripts/check-skill-discovery.mjs` → **8/8** (real Pi 1.4.0 RPC: project skill
  advertised via trust, guard auto-loads, `/guard status` answered).
- `node scripts/e2e-renew.mjs` → 20/20 (prior committed proof, A-23; NOT re-run here —
  docs-only pass, real inference).

Historical pointers (details in LEARNINGS.md): 36/36 (Phase 1), 55/55 (Phase 1b —
obsolete baseline, kept as history), 102/103 (1c), 118/119 (2A), 131/132 (2B); A-16
two-process evidence; A-23 kept-clone forensics (`GUARD_E2E_KEEP=1`); pli80 facts
sourced read-only from README.md, spec/CLAIMS.md, tools/e2e_gate.py, SOURCES.md.

Caveats that travel with every claim above: synthetic runs prove state-machine
behavior only, never real-token accuracy (A-1/A-18/A-22); mocks once masked real
defects (A-9/A-10/A-15) — real-runtime loads are part of every gate.

## Blockers

(none)

## Next action
**STOP — dev.2 COMPLETE; awaiting operator review (A-36 + CHANGELOG.md). No new
implementation without operator direction.** If woken without operator input:
1. Verify gates: `node --test test/` (187 pass / 1 skip),
   `node scripts/e2e-rpc-two-process.mjs` (38/38),
   `node scripts/check-skill-discovery.mjs` (8/8). Do NOT re-run
   `scripts/e2e-renew.mjs` unless renewal wiring in `index.ts` changed (real inference).
2. Operator decision points (HANDOFF "Next action"): dev.2 review; tag
   `v0.1.0-dev.2` + push authorization; `drpli` reuse authorization (separate);
   optional policy flips (`recovery.lean`, `renewal.autoRenew`, caps).
3. Ritual if anything changes: prose via scripts/durable_edit.py or direct edits;
   refresh via `node /tmp/refresh-pinned.mjs "notes"` (PINNED dev.1, `pi --mode rpc
   -ne -e <pinned>`, P-12 — finalize NOT available there); commit managed blocks.
NEVER push/tag/release; DRPLi untouched; raw campaign logs outside Git.

Historical successor sequence (D4/D6 remain as stated; D5 above supersedes item 2):

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
<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 24
checkpoint-id: g24-c07d154786d9
checkpoint-kind: manual
content-delta: new
readiness: attested
guard-level: 0
checkpointed: 2026-10-30T09:09:30.833Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: 4766ab3849f660c230db88b76a929193f84023ea51e996596a1024be93ff39a5
source-handoff: 49d63f50ce70a592a597baed7ffdf0223b9b1bc5e720c5bef656dfd65bb820df
source-learnings: 0a7985f28fb241574a6077334c10b45dcf0c92a816aee7f696b08473edbdafc8
source-config: 0e1d558f99398890048c7319d998914290193337deaa6eb651db33b6c9e4fa18
next-action: **STOP — dev.2 COMPLETE, awaiting OPERATOR REVIEW (A-36, CHANGELOG.md). No further
implementation without operator direction.** Operator decision points: (1) review the
dev.2 range `4df08a8..HEAD` (one commit per increment + refreshes); (2) authorize or
withhold tag `v0.1.0-dev.2` + push (NEITHER is done); (3) separately authorize `drpli`
reuse (blueprint: docs/long-project-guide.md §7 + skill bootstrap; CHANGELOG migration/
rollback sections are the install notes); (4) optional policy calls: enable
`recovery.lean`, raise `renewal.autoRenew`, adjust caps. Open caveats that travel with
any release claim: P-5 concurrency NOT generalized; P-7 live closing point NOT observed
under real accounting (nominal crossings printed live, never reached); lean-tier benefit
is fixture/meter projection (chars/4), not campaign re-run. Successors: if woken without
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
readiness-by: session:01a18c12-4417-769d-84ab-10b7579ec82f
readiness-at: 2026-10-30T09:09:30.933Z
readiness-checkpoint: g24-c07d154786d9
<!-- guard:end checkpoint -->
