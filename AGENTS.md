# AGENTS.md — handoff prototype (Pi context-guard)

Pi 1.4.0 context-guard extension + durable handoff files. Original
Phase 1 and Phase 2, the released `v0.1.0-dev.3`, and Lot A reliability
improvements (#8, #12, #1, #13) are integrated in `main` at `2f2c630`.
Documentation guidance for #4 (PR #5) is also integrated. See CHANGELOG
`v0.1.0-dev.4` candidate for scope, compatibility and exact verification status.
**Do not claim dev.4 has been tagged or its renewed Pi/Sushi inference path
revalidated.** Operator-reported Rune CI was green on final Lot A tree
`5312ae6` (byte-identical to the merged main tree).

**Current authorized work:** prepare and validate the dev.4 release candidate,
then implement **Lot B** as separate reviewable increments: #10's
operator-authored next-task-on-renew capability, and #9's experimental,
explicitly provenance-labelled successor start turn. Read those GitHub
issues and comments before implementation. Do not silently turn operator
text into model/predecessor notes or vice versa. Keep default renewal gates,
attestation, no-transcript-replay, stop/cap/idempotence, and never-push
boundaries intact. No release tag or publication without a separate explicit
operator decision. No cross-project deployment authorized.

Renewal ships **disabled by default**: `renewal.enabled`/`renewal.autoRenew` defaults are
false; this project sets `enabled: true, autoRenew: false, maxRenewals: 8` with
`generationReserve: 5000` and an explicit `renewal.testCommand` (model-initiated renewal
needs `autoRenew: true` — enabling it by default is an operator decision; experiments use
`CONTEXT_GUARD_AUTO_RENEW=1`). `GOAL.md` describes the original Phase 1 scope; later
phases extended it under explicit authorization — the file stays untouched.

Every fresh session:

1. Read `AGENTS.md`, `PROTOCOL.md`, `GOAL.md`, `HANDOFF.md`, `PROGRESS.md` (in that
   order; manual prose in HANDOFF/PROGRESS wins over `guard:begin checkpoint` managed
   blocks — schema v3; freshness is reported at `session_start` and via `/handoff verify`).
2. Verify with `node --test test/` (last Lot A report **223 pass / 1 gated skip**) before touching
   code. Zero-inference real-runtime gates: `node scripts/e2e-rpc-two-process.mjs`
   (**38/38**, incl. the capped-chain finalize proof), `node scripts/check-skill-discovery.mjs`
   (8/8). `node scripts/e2e-renew.mjs` (**24/24**, last live run on the pre-D7 candidate
   `b07e29b` — A-36) spends REAL inference — re-run only after renewal-wiring changes in
   `index.ts` (the D7 driver changes are lifecycle-only and covered by
   `test/cleanup.test.ts` with a fake-pi stub, zero inference). NEVER run `node --test
   test/` while a handoff Rune-CI build is active on this machine: the CL7 leak
   assertions snapshot shared /tmp and race with concurrent driver runs (bs58;
   LEARNINGS P-14 — interim serialization rule, no code change). The e2e scripts clean
   their own /tmp artifacts via `scripts/lib/e2e-cleanup.mjs`; `GUARD_E2E_KEEP=1` (and
   ONLY `1`) retains them for forensics.
3. Never rewrite `GOAL.md`; propose goal changes in `LEARNINGS.md` (Proposed) instead.
   The guard never writes `LEARNINGS.md`; keep discoveries there, classified
   (accepted / proposed / falsified).
4. Initiative is allowed: investigate and propose beyond the objective, but record
   evidence, expected value and cost in `LEARNINGS.md`; never adopt a proposal as a
   rule without explicit justification.
5. For non-mutating audit sessions use read-only mode: `CONTEXT_GUARD_READONLY=1
   CONTEXT_GUARD_STATE_DIR=/tmp/... pi -e .pi/extensions/context-guard/index.ts` —
   instruction alone does NOT make a session read-only (trusted project extensions
   write; audit mode protects the project TREE only, not an OS-level snapshot).

Hard scope limits: do not modify `pli80`, `drpli`, the global Pi install, or
compaction settings. **Rune CI (D8 exception, operator-authorized 2026-10-30):** the
handoff builders/suites may be extended ONLY inside the handoff files
(`ci/handoff_*.py`, `master/handoff_builders.py`, `master/buildbot.tac`,
`bin/handoff_ci_lib.py`, `bin/rune-ci-handoff`, `tests/test_handoff.py`); the DRPLi
fingerprint inputs (`master/master.cfg`, the four hashed `ci/*.py`, `fixtures/`) and
the scientific gate semantics stay byte-identical — `tests/test_handoff.py` fails if
that is ever broken. Reusing the guard elsewhere (e.g. `drpli`) requires separate explicit
operator authorization; `docs/long-project-guide.md` §7 is a blueprint, not an install.
After editing the extension, ALWAYS load it in the real runtime (`pi --mode rpc -e
.pi/extensions/context-guard/index.ts` or `node scripts/e2e-rpc-two-process.mjs`); mock
tests do not catch module-load errors (LEARNINGS A-9, A-15). After any change to the
renewal wiring in `index.ts`, also re-run `node scripts/e2e-renew.mjs` (real inference —
the only live proof of the switch path, A-23). After editing `.agents/skills/` or the
guide, re-run `node scripts/check-skill-discovery.mjs` (zero inference, real runtime;
project skills are trust-gated, A-25).
