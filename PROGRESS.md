# PROGRESS

## Current phase

**Documentation consolidation (COMPLETE, 2026-10-29).** A docs-only pass reconciled
README/PROTOCOL/AGENTS/HANDOFF/PROGRESS/LEARNINGS/skill/guide with the implemented
system. No code, test, E2E or config file was changed. Key corrections: README retitled
off "Phase 1"; schema v3 stated as current (v2/v1 = historical, validate as `stale`);
obsolete Phase 1c "INCOMPLETE / suite RED" operational notes removed from HANDOFF
(git history preserves them); current baselines stated everywhere (131/132 + skip,
27/27, 8/8, 20/20); L4 allowlist described as configurable `closingAllowlist` with the
optional `handoff_renew` entry (this project lists it); `renewal.enabled` (mechanism) vs
`renewal.autoRenew` (model-initiated authorization) distinguished; live-proof scope
stated precisely (one model-initiated hop + one operator-initiated hop, synthetic
triggering — the ≈195 k closing point remains unproven under real accounting, P-7);
PROTOCOL §7 no longer claims tests are mock-only; GOAL.md untouched by design (its
Phase 1 wording is historical; later phases extended the scope under operator
authorization).

**Project milestone status (all COMPLETE):**

| Milestone | Result | Evidence |
|---|---|---|
| Phase 1 | guard + durable files + mock harness, 36/36 | `b2ccdac` |
| Phase 1b | schema-v2 freshness, prose-first recovery, per-session state, audit mode (55/55 then) | A-6…A-9 |
| Phase 1c | schema-v3 identity, readiness + attestation, real-runtime load fix | `3cc2f31`, A-10…A-16 |
| Revocation | non-monotonic measurement retraction (A-18) | 108/109 |
| Phase 2 A | renewal decision module + durable chain state | 118/119, A-17 |
| Phase 2 B | `/handoff renew` wiring + `handoff_renew` tool + banner + lineage | 131/132, e2e 27/27 |
| Phase 2 C | **real-inference A→B→C renewal proven live** | 20/20, A-23, `d90f016` |
| Phase 1d | pi-handoff skill + long-project guide (PL/I-80 blueprint; pli80 untouched) | 8/8, A-25, `61ed9be` |
| Docs consolidation | current/historical/deferred separated across all documents | this milestone |

Open OPERATOR decisions (not development tasks): `renewal.autoRenew` project default
(currently false; `CONTEXT_GUARD_AUTO_RENEW=1` env switch proven for experiments);
`drpli` reuse requires separate explicit authorization; `pli80` blueprint application
likewise.

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

- [ ] **Operator review** of the documentation consolidation, then separately
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

**Operator review** of the consolidated documentation (git log since `06fbc71`;
re-run the three zero-inference gates: 131/132, 27/27, 8/8), **then separately
authorized `drpli` integration** (`.agents/skills/pi-handoff/references/bootstrap.md`
+ `docs/long-project-guide.md` §7 are the templates; applying them is an explicit
operator approval, never agent initiative).

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
