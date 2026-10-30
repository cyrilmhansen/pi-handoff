# AGENTS.md — handoff prototype (Pi context-guard)

Pi 1.4.0 context-guard extension + durable handoff files. **All development milestones
are COMPLETE:** Phases 1, 1b, 1c, 1d, Phase 2 increments A+B+C, the **v0.1.0-dev.2
reliability/recovery-efficiency mission** (D1-D6 + all dogfood proofs — LEARNINGS
A-28…A-36, CHANGELOG.md), the **D7 test-artifact lifecycle increment** (LEARNINGS
A-37) and the **D8 Rune CI integration** (async integration builds on the existing
Buildbot — LEARNINGS A-38/A-39; runner/test evidence in CHANGELOG §v0.1.0-dev.2 "D8"; the
CL7e dev-tree-dependency fix `435c294` came out of the first real CI build bs54), and
the **D9 final skill & release documentation audit** (seven-module recipes, lean-tier
wording, commands.md D4/D6/env refresh, guide obsolete examples, CHANGELOG D8 folded
under dev.2; regression test `test/docs.test.ts` DC1–DC5 — LEARNINGS A-41).
Current next action: **STOP — operator review of the dev.2 + D7 + D8 + D9 candidate**;
tagging/push, the authorized live-suite spend and `drpli` reuse each require
separate explicit authorization. No implementation work is pending.

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
2. Verify with `node --test test/` (expect **205 pass / 1 gated skip**) before touching
   code. Zero-inference real-runtime gates: `node scripts/e2e-rpc-two-process.mjs`
   (**38/38**, incl. the capped-chain finalize proof), `node scripts/check-skill-discovery.mjs`
   (8/8). `node scripts/e2e-renew.mjs` (**24/24**, last live run on the pre-D7 candidate
   `b07e29b` — A-36) spends REAL inference — re-run only after renewal-wiring changes in
   `index.ts` (the D7 driver changes are lifecycle-only and covered by
   `test/cleanup.test.ts` with a fake-pi stub, zero inference). The e2e scripts clean
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
