# AGENTS.md — handoff prototype (Pi context-guard)

Pi 1.4.0 context-guard extension + durable handoff files. **All development milestones are
COMPLETE:** Phases 1, 1b, 1c, 1d, and Phase 2 increments A+B+C — session renewal is proven
live with real inference (LEARNINGS A-23). Documentation consolidation is complete
(2026-10-29). No implementation work is pending. Current next action: **operator review,
then separately authorized reuse in `drpli`** (see HANDOFF.md).

Renewal ships **disabled by default**: `renewal.enabled`/`renewal.autoRenew` defaults are
false; this project sets `enabled: true, autoRenew: false` (model-initiated renewal needs
`autoRenew: true` — enabling it by default is an operator decision; experiments use
`CONTEXT_GUARD_AUTO_RENEW=1`). `GOAL.md` describes the original Phase 1 scope; later
phases extended it under explicit authorization — the file stays untouched.

Every fresh session:

1. Read `AGENTS.md`, `PROTOCOL.md`, `GOAL.md`, `HANDOFF.md`, `PROGRESS.md` (in that
   order; manual prose in HANDOFF/PROGRESS wins over `guard:begin checkpoint` managed
   blocks — schema v3; freshness is reported at `session_start` and via `/handoff verify`).
2. Verify with `node --test test/` (expect 131 pass / 1 gated skip) before touching code.
   Zero-inference real-runtime gates: `node scripts/e2e-rpc-two-process.mjs` (27/27),
   `node scripts/check-skill-discovery.mjs` (8/8). `node scripts/e2e-renew.mjs` (20/20)
   spends REAL inference — re-run only after renewal-wiring changes in `index.ts`.
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

Hard scope limits: do not modify `pli80`, `drpli`, Rune CI, the global Pi install, or
compaction settings. Reusing the guard elsewhere (e.g. `drpli`) requires separate explicit
operator authorization; `docs/long-project-guide.md` §7 is a blueprint, not an install.
After editing the extension, ALWAYS load it in the real runtime (`pi --mode rpc -e
.pi/extensions/context-guard/index.ts` or `node scripts/e2e-rpc-two-process.mjs`); mock
tests do not catch module-load errors (LEARNINGS A-9, A-15). After any change to the
renewal wiring in `index.ts`, also re-run `node scripts/e2e-renew.mjs` (real inference —
the only live proof of the switch path, A-23). After editing `.agents/skills/` or the
guide, re-run `node scripts/check-skill-discovery.mjs` (zero inference, real runtime;
project skills are trust-gated, A-25).
