# PROGRESS

## Current phase

**Mission v0.1.0-dev.2 (IN PROGRESS, started 2026-10-30).** Operator-authorized development
mission on top of tag `v0.1.0-dev.1` (`2ea6219`): implement D1-D6 from the eight-renewal
DRPLi campaign audit (evidence reproduced in LEARNINGS A-26/A-27). Priority: useful
scientific work per token + reliable unsupervised continuation. Hard limits: DRPLi
(`cyrilmhansen/drpli` @ `364ef5c`) is READ-ONLY for this mission and NOT on this machine —
DRPLi-sized behavior is tested with isolated fixtures only; no push/tag/release/deploy
without operator authorization; raw campaign logs stay outside Git
(`/home/john/drpli-handoff-audit-20261030/`, `/tmp/pi-handoff-drpli-audit.json`).

Increments (P0 first):

| # | Work | State |
|---|---|---|
| D1 | Recovery prompt: fix ignored `renewal.recoveryPrompt`; project-configured `renewal.testCommand`; remove hardcoded `node --test test/`; assert exact successor message | DONE (unit 137/138; real-runtime e2e 28/28; real-inference byte-exact check added to e2e-renew, re-run scheduled after D2) |
| D2 | `/handoff finalize` + `handoff_finalize` tool: independent finalization (works capped/disabled/stopped; never switches, never touches chain state, never bypasses readiness) | planned |
| D3 | Deterministic durable-document targeted editing (Python stdlib CLI): dry-run+diff, exact section targeting, ambiguity rejection, expected-hash concurrency guard, atomic replace, byte-identical non-target content, evidence-reference existence checks, no Git side effects; reuses guard checkpoint transaction for managed blocks (refuses to touch them) | planned |
| D4 | Compact recovery: operational state vs methodology vs intact archives; ≤10-12k est. tokens mandatory material; opt-in `recovery.lean`; schema v3 compatible; DRPLi-sized fixture generated in tests | planned |
| D5 | Accurate pressure messages (`enforceClosing:false` must not claim blocking; honest RENEWAL AVAILABLE incl. cap/stop/read-only/authorization preview; safe closing instructions when renewal unavailable) + structured diagnostic events (no prompts/args/secrets, no auto-retry) | planned |
| D6 | Experimental 95k/5k profile: crossings 70k/78k/82k/85k used shown in `/guard status`, reserve + provenance, honest window-ownership wording | planned |

Dogfooding (mandatory): this session runs the dev.1 guard loaded at startup; pinned
independent copy at `/home/john/pi-handoff-pinned-v0.1.0-dev.1` (git archive of the tag);
post-commit checkpoint refresh runs against the PINNED extension, never the edited tree.
Candidate validation after each P0 increment: separate real Pi process (`pi --mode rpc -e
.pi/extensions/context-guard/index.ts` + e2e scripts). Before release: one genuine
model-initiated renewal with productive continuation (real inference, `scripts/e2e-renew.mjs`
extended), and the capped-chain finalization proof (zero inference). Baselines to compare
against: dev.1 campaign numbers (A-27).

**Previous milestone — documentation consolidation (COMPLETE, 2026-10-29).** A docs-only
pass reconciled
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

- [ ] **v0.1.0-dev.2 mission**: D1-D6 as tabled above; deliverables 1-5 (confirmed defects
      vs hypotheses, corrections + regression tests, before/after recovery-cost
      measurements, migration/rollback docs from dev.1, dev.2 changelog + release
      readiness assessment) — none yet started in code.
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

**v0.1.0-dev.2 D1 first**: write failing regression tests for the confirmed recovery-prompt
defect (A-26) — custom `recoveryPrompt` must reach the successor message verbatim under the
mandatory identity/safety header; generic prompt must NOT contain `node --test test/`
unless `renewal.testCommand` is configured; then implement, run `node --test test/`, and
validate in the real runtime. Full mission brief: operator prompt of session
01a18a1a… (2026-10-30); evidence: LEARNINGS A-26/A-27/P-10.

(Previous milestone next action — operator review of the docs consolidation — remains
valid in parallel; nothing deployed to `drpli`.)

<!-- guard:begin checkpoint -->
checkpoint-schema: 3
checkpoint-generation: 11
checkpoint-id: g11-69cf72e56bdd
checkpoint-kind: manual
content-delta: none
readiness: attested
guard-level: 0
checkpointed: 2026-10-29T15:23:52.744Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: a9260cd606ed9b6129196ac1938a52de7a4e3de44cd3a6f4580448e5f1eb57e1
source-handoff: f0a8eb66f2f9c08fc4b462672e315dfa794f1239d9ee8c063399e888f80d88db
source-learnings: d9f5081486a8ea96d4e6da5076e5cf560b5b9a3ff60052d25d12c60237f4edb5
source-config: 0b1e162bdbf7ec9946afab3d1dd8b0fa35b4e3972ba77214f68c9a55276fe606
next-action: **Documentation consolidation is COMPLETE. Exact next action: operator review of this
consolidation, then — separately — explicitly authorized `drpli` integration.**

For the reviewing session:

1. `git log --oneline 06fbc71..HEAD` — inspect the consolidation commits; read README,
   HANDOFF, PROGRESS, PROTOCOL, `.agents/skills/pi-handoff/`, `docs/long-project-guide.md`.
2. Re-run the zero-inference gate: `node --test test/` → **131 pass / 1 skip**;
   `node scripts/e2e-rpc-two-process.mjs` → **27/27**;
   `node scripts/check-skill-discovery.mjs` → **8/8**. Do NOT re-run
   `scripts/e2e-renew.mjs` (spends inference; nothing touched renewal wiring).
3. Outstanding operator decisions: `renewal.autoRenew` default (stays OFF), and whether
   to authorize the `drpli` integration (guide §7 + `references/bootstrap.md` are the
   templates; applying them anywhere requires explicit approval).
4. Commit ritual: commit first, then `/handoff` + `/handoff ready`; commit the
   managed-block refresh separately if it dirties the tree. Never push — the operator
   publishes.
readiness-by: session:01a18842-a65e-7045-8cb0-5e63c293eb3a
readiness-at: 2026-10-29T15:23:52.846Z
readiness-checkpoint: g11-69cf72e56bdd
<!-- guard:end checkpoint -->
