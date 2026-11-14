# AGENTS.md — Pi Handoff release candidate

Pi context-guard extension + durable handoff files. RC `v0.1.0-rc.1` is prepared from
`f4206dbc9fcab89b666bc8623cbe8477f8bd7c95` and includes Lots A–I plus the Q2 fail-closed
correction: checkpoint/renewal reliability, operator tasks, document editing and supervised
cycles, isolated/owned/closable mission instances, and operator-approved shared knowledge
publication. This is an experimental prerelease for a reversible, supervised pilot, not a
production-ready claim. Do not tag, publish, push or deploy without separate explicit
authorization. No scientific-state migration or cleanup is part of this work.

**Q1 restore defect and Q2 correction:** Q1 historically reproduced a fail-open renewal
when `<stateDir>/renewal-state.json` was absent/corrupt. Q2 on `qual/predeploy-a-i`
classifies state as valid/missing/corrupt; renewal, stop/resume, and document-cycle
transitions now refuse absent, corrupt, incomplete, cross-instance, or generation-incoherent
state. Updates cannot create or replace a missing/corrupt chain. Explicit operator
creation of a new mission initializes its mission-bound zero-count chain exclusively.
If creation is interrupted before that state is written, preserve the partial identity
and use a new mission ID; never retry initialization over an existing identity. See Q2
results in `docs/qualification/predeploy-a-i.md`. Pi 1.4.0 remains unqualified in this
environment; Q2's real RPC proof uses the installed Pi version documented there.

Renewal ships **disabled by default**: `renewal.enabled`/`renewal.autoRenew` defaults are
false; this project sets `enabled: true, autoRenew: false, maxRenewals: 8` with
`generationReserve: 5000` and an explicit `renewal.testCommand` (model-initiated renewal
needs `autoRenew: true` — enabling it by default is an operator decision; experiments use
`CONTEXT_GUARD_AUTO_RENEW=1`). `GOAL.md` describes the original Phase 1 scope; later
phases extended it under explicit authorization — the file stays untouched.

Every fresh session:

1. Read `AGENTS.md`, `PROTOCOL.md`, `GOAL.md`, and the operational documents selected by
   the current Pi process (legacy mode: project-root `HANDOFF.md`, `PROGRESS.md`,
   `LEARNINGS.md`; mission-instance mode: `.pi-handoff/instances/<id>/` versions).
   Manual prose in HANDOFF/PROGRESS wins over managed checkpoint blocks (schema v3);
   freshness is reported at `session_start` and via `/handoff verify`. Never infer or
   change the active instance from document contents.
2. Verify with `node --test test/` before touching code. Latest measured baseline:
   **305 pass / 1 gated skip (306 total)**.
   Zero-inference real-runtime gates: `node scripts/e2e-rpc-two-process.mjs` (**60/60**,
   including fail-closed missing-chain refusal and explicit mission bootstrap/restart;
   Pi 1.5.2 only, not a Pi 1.4.0 qualification), `node scripts/check-skill-discovery.mjs`
   (8/8). Q2 restoration scenarios were measured and refused missing/corrupt chain state.
   Real renewals with this RC code and the documentation cycle with inference remain
   unqualified; see the changelog and qualification report.
   `node scripts/e2e-renew.mjs` (**24/24**, last live run on the pre-D7 candidate
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
