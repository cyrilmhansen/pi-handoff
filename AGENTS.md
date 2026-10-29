# AGENTS.md — handoff prototype

Project: Pi 1.4.0 context-guard. **Phase 2 (automatic session renewal) is the current
milestone — in progress**: increment A (renewal decision module, config wiring, durable
chain state, tests RN1–RN10) is done and committed; the session-switch wiring
(increment B) is NOT yet implemented — nothing switches sessions yet. Earlier:
Phases 1/1b/1c complete; Phase 1d (skill + long-project guide) deferred behind Phase 2.

Renewal status this milestone: **NO automatic renewal has run yet.** Operator controls
once implemented (`/handoff renew`): trigger = `/handoff renew` in the session UI or via
RPC `prompt`; stop = `/handoff renew stop` (disables further auto-renewals for the run);
cancel any pending switch = `session_before_switch` `{cancel:true}` (guard's stop flag).
Before then nothing switches sessions.

Every fresh session:

1. Read `PROTOCOL.md` (working rules), `GOAL.md` (objective), `HANDOFF.md` (resume point),
   `PROGRESS.md` (state). In that order. Manual prose in HANDOFF/PROGRESS takes precedence
   over `guard:begin checkpoint` managed blocks; the guard reports checkpoint freshness
   (missing/corrupt/stale/current) at `session_start` and via `/handoff verify`.
2. Verify with `node --test test/` before touching code.
3. Never rewrite `GOAL.md`; propose goal changes in `LEARNINGS.md` (Proposed) instead.
   The guard never writes `LEARNINGS.md`, and every threshold level tells the agent to keep
   discoveries there (accepted / proposed / falsified).
4. Keep evidence for anything you claim; classify it (accepted / proposed / falsified).
5. Initiative is allowed: investigate and propose beyond the objective, but record
   evidence, expected value and cost in `LEARNINGS.md`, and do not adopt proposals as
   rules without explicit justification.
6. For non-mutating audit sessions use read-only mode: `CONTEXT_GUARD_READONLY=1
   CONTEXT_GUARD_STATE_DIR=/tmp/... pi -e .pi/extensions/context-guard/index.ts` —
   instruction alone does NOT make a session read-only (trusted project extensions write).

Hard scope limits: do not modify `pli80`, Rune CI, the global Pi install, or
compaction settings. Phase 2 (automatic session renewal) is not implemented — the readiness
gate exists (`/handoff ready`, `renewAuthorization()`) but nothing switches sessions.
After editing the extension, ALWAYS load it in the real runtime (`pi --mode rpc -e
.pi/extensions/context-guard/index.ts` or `node scripts/e2e-rpc-two-process.mjs`): mock
tests do not catch module-load errors (LEARNINGS A-9, A-15).
