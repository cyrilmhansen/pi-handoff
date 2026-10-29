# AGENTS.md — handoff prototype

Project: Pi 1.4.0 context-guard (Phase 1/1b). Experimental prototype.

Every fresh session:

1. Read `PROTOCOL.md` (working rules), `GOAL.md` (objective), `HANDOFF.md` (resume point),
   `PROGRESS.md` (state). In that order. Manual prose in HANDOFF/PROGRESS takes precedence
   over `guard:begin checkpoint` managed blocks; the guard reports checkpoint freshness
   (missing/corrupt/stale/current) at `session_start` and via `/handoff verify`.
2. Verify with `node --test test/` before touching code.
3. Never rewrite `GOAL.md`; propose goal changes in `LEARNINGS.md` (Proposed) instead.
4. Keep evidence for anything you claim; classify it (accepted / proposed / falsified).
5. Initiative is allowed: investigate and propose beyond the objective, but record
   evidence, expected value and cost in `LEARNINGS.md`, and do not adopt proposals as
   rules without explicit justification.
6. For non-mutating audit sessions use read-only mode: `CONTEXT_GUARD_READONLY=1
   CONTEXT_GUARD_STATE_DIR=/tmp/... pi -e .pi/extensions/context-guard/index.ts` —
   instruction alone does NOT make a session read-only (trusted project extensions write).

Hard scope limits: do not modify `pli80`, Rune CI, the global Pi install, or
compaction settings. Phase 2 (automatic session renewal) is not implemented yet.
