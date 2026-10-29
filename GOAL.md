# GOAL

<!-- This file is protected by the context-guard extension (write/edit tool calls
     targeting it are blocked). Proposed changes to the objective go to
     LEARNINGS.md (Proposed) and HANDOFF.md for human review — never a silent rewrite. -->

## Objective

Build a minimal, testable Pi 1.4.0 extension ("context-guard") that monitors remaining
context, warns the agent at configurable thresholds, and supports durable handoff to a
fresh session without lossy compaction. Phase 1 scope only: guard, state files,
checkpoint validation, test harness. No unattended agent launching, no automatic
session switching.

## Acceptance criteria

- Extension loads in the real Pi 1.4.0 runtime (jiti) from this project.
- Thresholds 30k/20k/10k/5k remaining are configurable; one alert per crossing per session.
- Multiple thresholds crossed in one turn produce one combined alert.
- Missing/stale token measurements are handled safely (no alerts, enforcement held).
- Reserved generation capacity is subtracted from remaining context.
- Advisory levels (1–3) are distinguishable from enforced closing (level 4 tool gating).
- Synthetic test mode exercises all thresholds without real inference.
- Four durable files (GOAL/PROGRESS/LEARNINGS/HANDOFF) with atomic, crash-safe writes;
  partial checkpoint recovery works.
- `node --test test/` passes with zero third-party installs.
- No modification to pli80, Rune CI, the global Pi install, or compaction settings.
