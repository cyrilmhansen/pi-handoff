# Changelog — context-guard

All notable changes. Versions are pre-1.0 development tags; the guard ships as
project-local files (`.pi/extensions/context-guard/`), no package registry.

## v0.1.0-dev.2 — RELEASE-READY CANDIDATE (pending operator review; NOT tagged/pushed)

Baseline: tag `v0.1.0-dev.1` (`2ea6219`). Operator-authorized mission: reliability and
recovery-efficiency work driven by the eight-renewal DRPLi campaign audit (evidence:
LEARNINGS A-26/A-27/P-10; metrics reproduced from the local read-only audit).

### Fixed

- **D1 — recovery prompt now honors configuration** (defect A-26): a configured
  `renewal.recoveryPrompt` reaches the successor message VERBATIM (mandatory identity
  header + safety trailer always kept); the hardcoded `node --test test/` build-verify
  line is GONE — it appears only when the project configures `renewal.testCommand`
  (new key). Regression RN10-RN15 + RB14/RB15 (byte-exact message assertions) and the
  live real-inference reconstruction check (24/24 candidate run, A-36).
- **D5a — level-4 alert wording matches live policy**: with `enforceClosing: false`
  the alert says enforcement is DISABLED and blocks nothing (advisory closing
  guidance); the enforced wording remains the default (`defaultThresholds(t,
  {enforceClosing})`, threaded through machine build AND restore).
- **D5b — honest renewal hint**: `RENEWAL AVAILABLE` at level ≥ 3 appears ONLY when a
  write-free preview of the REAL gate passes (live checkpoint identity +
  authorization + durable stop + cap + read-only + pending). Otherwise the alert
  names the refusal reason and concrete safe instructions (including
  `handoff_finalize` at the cap). Pressure alerts alone still never force a transition.
- **D5d — identity banner**: `context-guard (project-local, v<GUARD_VERSION>)`,
  env-overridable `GUARD_VERSION`; the stale hardcoded "Phase 2 increment B" milestone
  label is removed (P-9 resolved).
- **`scripts/e2e-renew.mjs` driver** (A-24 class): clone cap pinned to 2 for the
  bounded experiment; zero-inference attest-prep session so the D5b preview passes
  after the driver's config patch; lineage asserted structurally
  (`merge-base --is-ancestor`) instead of greping old commit messages.
- **D7 — test-artifact lifecycle** (operator-authorized cleanup increment; test scripts
  only, production guard untouched): four confirmed defect classes fixed —
  (1) temp directories created BEFORE the protecting `try/finally` leaked on early
  setup failures; (2) the optional `guard-e2e-llm-*` workspace from the opt-in
  `GUARD_E2E_LLM=1` branch was missing from `e2e-rpc-two-process.mjs`'s final cleanup
  list (leaked `/tmp/guard-e2e-llm-*` observed); (3) `check-skill-discovery.mjs` kept
  artifacts for ANY truthy `GUARD_E2E_KEEP` — `GUARD_E2E_KEEP=0` retained instead of
  removing, unlike the other drivers; (4) abrupt termination (SIGINT/SIGTERM/SIGHUP)
  could orphan both artifacts and live `pi` children. Now: every test-owned temp dir
  is registered at creation; cleanup covers setup errors, successes, failed
  assertions, timeouts and signals; tracked children are shut down BEFORE their
  workspaces are removed; removal is restricted to the exact directories the same
  invocation created (NO global `/tmp/guard-*` sweeper); `GUARD_E2E_KEEP === "1"` is
  the ONLY retention value; SIGKILL and machine crashes are stated as NOT coverable
  (LEARNINGS A-37).

### Added

- **D7 — `scripts/lib/e2e-cleanup.mjs`**: shared `ArtifactTracker` (exclusive-mkdtemp
  ownership registered at creation; child-process tracking with graceful
  stdin-close → SIGTERM → SIGKILL shutdown ordered BEFORE workspace removal; sync
  signal/exit safety-net path; prefix + tmpdir containment floor `guard-*`; injectable
  deps for testing) + `keepRequested()` + `onceExited()` (spawn-error-safe exit wait).
  `test/cleanup.test.ts` CL1–CL8: 13 zero-inference tests — worker subprocesses (real
  fs) for normal cleanup, setup crash, KEEP=0/KEEP=1, SIGTERM with live children,
  child-before-workspace ordering, ownership safety (same-prefix and foreign
  sentinels must survive: no-sweeper proof) — plus the THREE REAL driver scripts
  executed against a protocol-minimal FAKE-`pi` stub on PATH: the optional LLM
  workspace is cleaned with everything else; KEEP=1 retains all six artifacts
  (incl. `guard-e2e-llm-*`); SIGTERM mid-run of `e2e-rpc-two-process.mjs` exits 143
  with all fake-pi children dead and zero workspaces left; `e2e-renew.mjs` with git
  unreachable reports a setup failure and removes its clone parent;
  `check-skill-discovery.mjs` with KEEP=0 cleans up (the exact historical defect).
- **D2 — finalization**: `/handoff finalize [notes]` (operator) and the
  `handoff_finalize` tool (model): refresh-if-stale + readiness evaluation +
  attestation in ONE synchronous step. Works with renewal disabled, capped or durably
  stopped; NEVER switches sessions, NEVER writes chain state (byte-identity asserted),
  never bypasses readiness, no `waitForIdle` (deadlock-free by construction),
  idempotent; read-only mode = reported dry run. Implicitly permitted during enforced
  closing (managed-block writes only). FZ1-FZ9 + REAL-RUNTIME capped-chain proof:
  renew refused `(capped)` BEFORE any idle wait; finalize FINALIZED with
  `renewalsDone` 8/8 and chain bytes identical (e2e-rpc CAP section, zero inference).
- **D3 — `scripts/durable_edit.py`**: stdlib-only targeted durable-doc section editor
  (plan/apply with unified diff + hashes, exact heading matching respecting fences and
  managed blocks, `NOT_FOUND`/`AMBIGUOUS`/`CONFLICT`/`MANAGED_BLOCK`/`MISSING_REF`
  exits, atomic same-directory replace, reference-existence checks, zero git).
  DE0-DE11 spawn the real CLI.
- **D4 — lean recovery tiers** (`recovery.ts`, opt-in `recovery.lean: false`,
  `recovery.budgetTokens: 12000`, env `CONTEXT_GUARD_LEAN=1|0`): successor body
  tiered OPERATIONAL (read NOW) / METHODOLOGY (on need) / ARCHIVE (by reference) —
  ALL six durable files stay named and authoritative; tiering DEFERS reading, never
  drops authority; an explicit `renewal.recoveryPrompt` still wins; identity header +
  safety trailer byte-identical between variants. Recovery-cost meter
  (`/guard status`, `/handoff verify`, `/handoff finalize`) reporting chars and
  chars/4 ESTIMATES with the A-1 caveat. RC1-RC6 incl. a generated DRPLi-shaped
  fixture (121,312 chars; full ≈ 30.3k vs lean operational ≈ 10k est. tokens).
- **D5c — structured diagnostics**: `<stateDir>/diagnostics.jsonl` (JSONL, ISO+epoch;
  closed type vocabulary; allowlisted fields only — NEVER prompts, tool arguments or
  secrets; rotation ~500; audit-mode §2.3 rule; `/guard events [n]`);
  `agent_settled.aborted` is RECORDED for attribution and NEVER auto-retried (P-10).
- **D6 — crossing points** (`crossingPoints`/`crossingPointsLine` in `core.ts`):
  `/guard status` prints the escalation crossings in estimated used tokens
  (arithmetic `window − reserve − threshold`, identical to the live budget), with
  reserve provenance, the enforced/advisory kind of the CURRENT closing policy, a
  `!! too tight` flag for crossings ≤ 0, and the honest statement that the guard
  NEVER changes the model window (model/provider-owned; advisory budgets over Pi's
  estimate). Example profile `docs/profiles/experimental-95k.json` (window 95k,
  reserve 5k, thresholds 20k/12k/8k/5k → crossings 70k/78k/82k/85k), self-consistency
  asserted through the real config merge. D6x1-3; numeric line observed live with a
  real model (A-36).
- **Project config (operator decisions, chain-safe per A-32 + RN15)**:
  `renewal.maxRenewals` 2→8; `generationReserve` 20000→5000; explicit
  `renewal.testCommand`.

### Compatibility

- Checkpoint schema remains **v3**; runtime state schema unchanged; dev.1 checkpoints
  validate `current` under dev.2 — NO migration of durable files or state is required.
- All new behaviors are default-OFF or additive: `recovery.lean:false`; renewal stays
  disabled by default globally (this project enables it, `autoRenew:false`).
- Unknown `handoff.config.json` keys are ignored (whitelist merge), so profiles and
  forward-compatible keys are safe to keep in the file.

### Migration v0.1.0-dev.1 → v0.1.0-dev.2

1. Replace `.pi/extensions/context-guard/` with the new directory (two new pure
   modules: `recovery.ts`, `diagnostics.ts`).
2. To reproduce dev.1's successor message EXACTLY, set
   `"renewal": { "testCommand": "node --test test/" }` (dev.1 hardcoded that line;
   dev.2 prints it only when configured). A configured `renewal.recoveryPrompt` now
   actually takes effect (it was silently ignored in dev.1 — the A-26 defect).
3. Optional: enable lean recovery tiers (`recovery.lean: true` or
   `CONTEXT_GUARD_LEAN=1`); leave false for the dev.1 read-all body.
4. Existing `.pi-guard/` (sessions/, renewal-state.json) carries over unchanged;
   chain counts, caps and the durable stop survive.
5. Restart sessions; the banner must show `v0.1.0-dev.2` (or your `GUARD_VERSION`).

### Rollback v0.1.0-dev.2 → v0.1.0-dev.1

Restore the extension directory from tag `v0.1.0-dev.1` (`git archive v0.1.0-dev.1`;
the pinned copy `/home/john/pi-handoff-pinned-v0.1.0-dev.1` is byte-identical to the
tag — A-31). No state or document migration is needed: everything dev.2 wrote is
plain schema-v3 + version-1 chain state that dev.1 reads; `diagnostics.jsonl` is
disposable; dev.1 ignores the new config keys (whitelist merge skips unknowns).

### Release readiness

- Gates on the candidate (zero inference): unit suite **200 pass / 1 gated skip**
  (incl. D7 `test/cleanup.test.ts`); real-runtime
  `scripts/e2e-rpc-two-process.mjs` **38/38**; skill discovery probe **8/8** — both
  re-run green AFTER the D7 driver refactor with the REAL pi.
- Real inference: `scripts/e2e-renew.mjs` **24/24** on the pre-D7 candidate `b07e29b`
  — model-initiated hop 1 under the D5b preview gate, byte-exact recovery message
  (D1), productive successor commits, cap refusal, zero replay, zero compaction
  (A-36). D7 changed only the driver's artifact lifecycle, NOT the renewal wiring;
  the live 24-check re-run after D7 has NOT been spent (operator decision — the
  real-inference budget rule applies).
- Evidence trail: LEARNINGS A-28…A-37; commits `6e61967` (D1), `8674c90` (D2),
  `1d48de3` (D3), `fcea69c`/`b6445aa` (pre-D5 adjustments), `05379b0` (D5),
  `b86b0fe` (D4), `d77ef48` (D6) + checkpoint refreshes + D7.
- NOT claimed (open, stated honestly): P-5 generalized concurrent renewal safety;
  P-7 live closing point under real token accounting (nominal crossings are printed
  live but were never REACHED); scripted full-audit procedure (P-3 gap); live campaign
  benefit of lean tiers (fixture + meter projection only); the dev.2 candidate as the
  dogfooding guard of THIS session series (this session loaded the pre-D6 candidate —
  A-31 mechanics; a session restart picks up the tip).
- Operator actions outstanding: review, then (separately authorized) tag/reuse in
  `drpli`. Nothing pushed; DRPLi untouched.

## v0.1.0-dev.1 (tag `2ea6219`)

Phases 1, 1b, 1c, 1d + Phase 2 increments A+B+C, then documentation consolidation:
threshold guard (30k/20k/10k/5k remaining, enforced closing level 4), synthetic mode,
per-session runtime state + crash-safe atomic checkpoints, checkpoint schema v3
(transactional identity + source fingerprints), readiness + attestation gate,
read-only audit mode (tree-zero-writes, external stateDir), durable handoff files,
renewal contract (`renewal.ts`, chain state, cap/idempotence/stop), `/handoff renew`
+ `handoff_renew` tool (fire-and-forget bridge), real-inference A→B→C renewal proof
(A-23), detailed `/guard status`, measurement-revocation notices (A-18),
`.agents/skills/pi-handoff/` + `docs/long-project-guide.md` (trust-gated discovery,
A-25), full documentation consolidation (2026-10-29). Suite at consolidation:
131 pass / 1 skip; e2e-rpc 27/27; probe 8/8.
