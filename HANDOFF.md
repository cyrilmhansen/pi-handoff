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
**Mission v0.1.0-dev.2 IN PROGRESS (session 01a18a1a…, started 2026-10-30; supersedes the
docs-consolidation next action, which was operator review — that review is folded into the
release assessment deliverable).** Exact continuation sequence (full brief in
PROGRESS.md "Next action"; state in the table there):

1. `node --test test/` (expect 146 pass / 1 skip; more after D3 tests),
   `node scripts/e2e-rpc-two-process.mjs` (32/32), `node scripts/check-skill-discovery.mjs`
   (8/8) — establish the tree is green before anything else.
2. D3: write `test/durable-edit.test.ts` (spawn python3; plan-dry-run, byte-identity,
   AMBIGUOUS/NOT_FOUND/CONFLICT/MANAGED_BLOCK/MISSING_REF, fenced headings, read-only-dir
   IO failure, stale-prose -> /handoff refresh round trip); gates again; commit.
3. D5 (accuracy + diagnostics), D4 (lean recovery + fixture), D6 (95k profile display) —
   test-first per increment, local commits, real-runtime gates after each extension edit.
4. Before release: real-inference `node scripts/e2e-renew.mjs` on the CANDIDATE (hop-1
   model-initiated, byte-exact D1 recovery-message checks, productive successor commits) +
   capped-chain finalization proof; recovery-cost before/after vs A-27 baseline; CHANGELOG
   dev.2, migration/rollback doc from `v0.1.0-dev.1`, release readiness assessment.
5. NEVER push/tag/release/deploy without operator authorization; DRPLi untouched (not on
   this machine; fixtures only); raw campaign logs stay outside Git.

Session guard note: this project's live sessions run the dev.1 guard (loaded at startup).
Routine post-commit refresh uses the PINNED dev.1 wrapper: `node /tmp/refresh-pinned.mjs
"notes"` (spawns `pi --mode rpc -ne -e <pinned index.ts>` — `-ne` is REQUIRED because
project auto-load + explicit pinned copy otherwise conflict on tool/flag names; see
LEARNINGS P-12). Validate the CANDIDATE only in separate explicit real-runtime runs.
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
checkpoint-generation: 13
checkpoint-id: g13-541624fd80ea
checkpoint-kind: manual
content-delta: new
readiness: attested
status: checkpoint (guard level 0, remaining ~199902, session 01a18a3c-4296-77af-9942-55360c8db910)
checkpointed: 2026-10-30T00:36:08.499Z
source-goal: 96199893488f5709e3292ad97f98aa259566ecaa6d6e20bc8c018ef8e0ba729c
source-progress: d32ddf81ae261527dea21c7619cf26db8f787692f1988c9846976301587384a2
source-handoff: dadb4650b381f077a1ccf1e9048de8797c8b2bd24ae944845d640b826bfd4fe6
source-learnings: a6a1533afca4206da93b06db8f40cdcea54eec371563f4e35c87b62a4f649b1a
source-config: 90397c2d23f26540ef43dceb7d38ec5adbe0b6609fae6d6609049fd591e1443d


readiness-by: session:01a18a3c-4296-77af-9942-55360c8db910
readiness-at: 2026-10-30T00:36:08.599Z
readiness-checkpoint: g13-541624fd80ea
### Last verified state
guard level 0; checkpoint requested (dev.2 refresh: HANDOFF/PROGRESS prose updated through durable_edit.py (D3 dogfood); pinned-guard refresh uses pi -ne (P-12))

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
**Mission v0.1.0-dev.2 IN PROGRESS (session 01a18a1a…, started 2026-10-30; supersedes the
docs-consolidation next action, which was operator review — that review is folded into the
release assessment deliverable).** Exact continuation sequence (full brief in
PROGRESS.md "Next action"; state in the table there):

1. `node --test test/` (expect 146 pass / 1 skip; more after D3 tests),
   `node scripts/e2e-rpc-two-process.mjs` (32/32), `node scripts/check-skill-discovery.mjs`
   (8/8) — establish the tree is green before anything else.
2. D3: write `test/durable-edit.test.ts` (spawn python3; plan-dry-run, byte-identity,
   AMBIGUOUS/NOT_FOUND/CONFLICT/MANAGED_BLOCK/MISSING_REF, fenced headings, read-only-dir
   IO failure, stale-prose -> /handoff refresh round trip); gates again; commit.
3. D5 (accuracy + diagnostics), D4 (lean recovery + fixture), D6 (95k profile display) —
   test-first per increment, local commits, real-runtime gates after each extension edit.
4. Before release: real-inference `node scripts/e2e-renew.mjs` on the CANDIDATE (hop-1
   model-initiated, byte-exact D1 recovery-message checks, productive successor commits) +
   capped-chain finalization proof; recovery-cost before/after vs A-27 baseline; CHANGELOG
   dev.2, migration/rollback doc from `v0.1.0-dev.1`, release readiness assessment.
5. NEVER push/tag/release/deploy without operator authorization; DRPLi untouched (not on
   this machine; fixtures only); raw campaign logs stay outside Git.

Session guard note: this project's live sessions run the dev.1 guard (loaded at startup).
Routine post-commit refresh uses the PINNED dev.1 wrapper: `node /tmp/refresh-pinned.mjs
"notes"` (spawns `pi --mode rpc -ne -e <pinned index.ts>` — `-ne` is REQUIRED because
project auto-load + explicit pinned copy otherwise conflict on tool/flag names; see
LEARNINGS P-12). Validate the CANDIDATE only in separate explicit real-runtime runs.

### Guard notes
dev.2 refresh: HANDOFF/PROGRESS prose updated through durable_edit.py (D3 dogfood); pinned-guard refresh uses pi -ne (P-12)
<!-- guard:end checkpoint -->
