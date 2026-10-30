# PROGRESS

## Current phase

**Mission v0.1.0-dev.2 (IN PROGRESS, started 2026-10-30).** Operator-authorized development
mission on top of tag `v0.1.0-dev.1` (`2ea6219`): implement D1-D6 from the eight-renewal
DRPLi campaign audit (evidence reproduced in LEARNINGS A-26/A-27). Priority: useful
scientific work per token + reliable unsupervised continuation. Hard limits: DRPLi is
READ-ONLY for this mission (not on this machine — isolated fixtures only); no
push/tag/release/deploy without operator authorization; raw campaign logs stay outside Git.

Increments:

| # | Work | State |
|---|---|---|
| D1 | Recovery prompt: configured `renewal.recoveryPrompt` reaches the successor message (mandatory identity/safety kept); project-configured `renewal.testCommand`; hardcoded `node --test test/` removed; exact-message tests | DONE — commit `6e61967` (unit 137/138; real-runtime zero-inference 28/28; byte-exact real-inference check added to e2e-renew, live run scheduled) |
| D2 | `/handoff finalize` + `handoff_finalize` tool: independent finalization (capped/disabled/stopped OK; never switches, never touches chain state, never bypasses readiness; no waitForIdle) | IMPLEMENTED — FZ1-FZ9 9/9, suite 146/147, real runtime 32/32; docs updated; committing now |
| D3 | `scripts/durable_edit.py` targeted durable-doc editing | DONE — DE0-DE11 (12 tests: dry-run, byte-identity, fences, AMBIGUOUS/NOT_FOUND/CONFLICT/MANAGED/MISSING_REF, failed-write atomicity, JSON, guard round-trip stale→refresh, no-git); suite 158/159 |
| D4 | Compact recovery (lean tiers ≤10-12k est. tokens, opt-in, schema v3 compatible, DRPLi-sized fixture) | pending |
| D5 | Accurate level-4 text under enforceClosing:false; honest RENEWAL AVAILABLE (cap/stop/read-only/auth preview); safe instructions at cap; structured diagnostics (no prompts/args/secrets); NO auto-retry | IN PROGRESS (test-first) — pre-D5 adjustments committed: cap 8 verified chain-safe (A-32, RN15), runtime identified (A-31) |
| D6 | 95k/5k experimental profile: crossings 70k/78k/82k/85k in /guard status, reserve+provenance, honest window ownership | pending |

Dogfooding (corrected 2026-10-30, A-31): the pi process hosting this mission was
RESTARTED at 08:15+01:00 (session 01a18a1a resumed → renewal into 01a18baa), so the
ACTIVE guard in the development sessions is the TREE CANDIDATE (dev.2: D1+D2+D3 code —
proved by the live `handoff_finalize` tool registration). The pinned dev.1 copy at
`/home/john/pi-handoff-pinned-v0.1.0-dev.1` is byte-identical to tag `v0.1.0-dev.1`
(A-31) and remains the recovery infrastructure for the post-commit refresh ritual
(`/tmp/refresh-pinned.mjs`, `pi --mode rpc -ne -e <pinned>`, P-12) — dev.1 has NO
finalize; never claim it in pinned sessions. The candidate is validated in separate
real Pi sessions: zero-inference e2e scripts now, plus the scheduled real-inference
e2e-renew (model-initiated hop 1 + byte-exact recovery checks + productive continuation)
and the capped-chain finalize proof before release.
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

- [ ] **v0.1.0-dev.2 mission**: D1-D3 DONE and committed; pre-D5 adjustments (cap raise
      verification A-32, runtime audit A-31, RN15) committed; D5 in progress (test-first);
      D4, D6, deliverables 4-5 (recovery-cost measurements, migration/rollback docs,
      dev.2 changelog + release readiness) pending.
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

Current (this docs-consolidation pass, zero inference):
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
**Pre-D5 adjustments DONE (A-31 runtime audit, A-32 cap-raise verification + RN15;
config maxRenewals 8 + generationReserve 5000 committed).** Now executing D5
(test-first): (a) level-4 alert wording under `enforceClosing:false`;
(b) `RENEWAL AVAILABLE` only behind a full write-free preview gate (decideRenewal with
live checkpointId + renewAuthorization + durable stop + cap + readOnly), otherwise safe
instructions incl. finalize-at-cap; (c) `diagnostics.ts` + `<stateDir>/diagnostics.jsonl`
(JSONL, ISO+epoch, types session_start/alert/revocation/renewal_request/renewal_result/
finalize/tool_block/turn_aborted; NO prompts/tool args/secrets; rotation ~500;
external-stateDir rule in audit mode; `/guard events [n]`); `agent_settled.aborted`
recorded, NEVER auto-retried; (d) banner label: drop hardcoded "Phase 2 increment B",
add `GUARD_VERSION` (P-9). Gates after index.ts/core.ts edits: suite, e2e-rpc-two-process
(32/32), skill probe (8/8); e2e-renew ONLY as the scheduled candidate proof.
Then D4, D6, dogfood proofs, release docs; STOP for operator review.
Post-commit ritual: prose via `scripts/durable_edit.py`; refresh via
`node /tmp/refresh-pinned.mjs "notes"` (PINNED dev.1; `pi --mode rpc -ne -e <pinned>`);
commit managed blocks. NEVER push/tag/release; DRPLi untouched; raw logs outside Git.

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
checkpoint-generation: 18
checkpoint-id: g18-38efc751253c
checkpoint-kind: manual
content-delta: new
readiness: attested
guard-level: 0
checkpointed: 2026-10-30T07:29:06.020Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: c649bfad06ac135b94327c4118375c0445373913f725a52c0b2261829c4203c2
source-handoff: f05c050da628bde264f0dcfff75f478f3235ed7a720e0480a17daaa7ce0bb159
source-learnings: 20c7278acf6b30220a3eb8a94e34cc374c4dcde2467ba93429ec8994a4932e64
source-config: 0e1d558f99398890048c7319d998914290193337deaa6eb651db33b6c9e4fa18
next-action: **Pre-D5 adjustments DONE and committed (A-31 runtime audit — active guard is the TREE
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
readiness-by: session:01a18bb6-55ce-7471-b466-9db059e05998
readiness-at: 2026-10-30T07:29:06.122Z
readiness-checkpoint: g18-38efc751253c
<!-- guard:end checkpoint -->
