# HANDOFF

## Recovery instructions

0. **CURRENT STATE (documentation consolidation complete, 2026-10-29): all development
   milestones are COMPLETE — Phases 1, 1b, 1c, 1d and Phase 2 increments A+B+C. Session
   renewal is proven live with real inference (LEARNINGS A-23: one model-initiated hop 1
   via the `handoff_renew` tool, one operator-initiated hop 2, cap refusal at 2/2, zero
   transcript replay, zero compaction). No implementation work is pending. The next step
   is OPERATOR REVIEW of the docs consolidation, then separately authorized reuse in
   `drpli` — nothing has been deployed there and `pli80` was never modified.**

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

**Documentation consolidation is COMPLETE. Exact next action: operator review of this
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
checkpoint-generation: 9
checkpoint-id: g9-1655aaba5cf2
checkpoint-kind: manual
content-delta: new
readiness: attested
status: checkpoint (guard level 0, remaining ~199902, session 01a1881f-91b1-71c8-9606-aabc3647d0eb)
checkpointed: 2026-10-29T14:45:33.715Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: 083cf0c14a81263006fb63f72701ed1c3fc9c7decdec2e4cb384205d9b7cd505
source-handoff: 1e99be1f38057b0f550f24210da2c0a4caa08c70db8c26a7bee75c585705b357
source-learnings: 1b30baa67114f9d39d73ad926ec838bcf12e3cf90ef236758281d8abb3aed3a8
source-config: 0b1e162bdbf7ec9946afab3d1dd8b0fa35b4e3972ba77214f68c9a55276fe606


readiness-by: session:01a1881f-91b1-71c8-9606-aabc3647d0eb
readiness-at: 2026-10-29T14:45:33.815Z
readiness-checkpoint: g9-1655aaba5cf2
### Last verified state
guard level 0; checkpoint requested (Phase 1d post-commit refresh: skill + guide + A-25 committed (61ed9be))

### Unfinished operations
- [x] Inspected installed Pi 1.4.0 types/docs; contract recorded in README.md.
- [x] Deterministic state machine (`core.ts`), config loader, crash-safe checkpoint module,
- [x] Reproduced both audit defects deterministically: (A) the legacy schema-v1 managed
- [x] Checkpoint schema v2: managed blocks embed sha256 fingerprints of source state
- [x] Recovery precedence fixed: manual prose always wins; the checkpoint block supplies
- [x] Per-session runtime state `sessions/<sessionId>.json` (version 2) + newest-wins
- [x] Read-only audit mode (`readOnly` / `CONTEXT_GUARD_READONLY=1` / `--guard-readonly`):
- [x] Tests extended: 55/55 pass (`test/freshness.test.ts`, `test/sessions.test.ts`,
- [x] Phase 2 increment B: `/handoff renew` switch wiring + `handoff_renew` tool bridge
- [x] Phase 2 increment C: real-inference A -> B -> C renewal experiment + evidence
- [ ] Human review of Phase 1b consolidation.
- [x] Phase 1d: Pi Handoff skill + long-project integration guide (COMPLETE this

### Next action
**Phase 2 (increments A+B+C) AND Phase 1d are COMPLETE. Nothing in the guard's code
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

### Guard notes
Phase 1d post-commit refresh: skill + guide + A-25 committed (61ed9be)
<!-- guard:end checkpoint -->
