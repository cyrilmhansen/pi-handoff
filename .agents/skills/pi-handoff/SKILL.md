---
name: pi-handoff
description: Operate a project equipped with the Pi context-guard extension and its durable handoff files (AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md, handoff.config.json). Use when a session reports context pressure levels or checkpoint freshness, when writing or verifying a checkpoint (/handoff), when attesting handoff readiness, when closing a session down or renewing it into a fresh successor session, when running a read-only audit, when testing thresholds without spending tokens, or when installing context-guard into a new long-running project.
compatibility: Pi >= 1.4.0; requires the context-guard extension loaded (pi -e <path>/.pi/extensions/context-guard/index.ts, or project trust) and the durable files at the project root.
---

# Pi Handoff — operating a context-guard project

Context-guard monitors remaining context, alerts at thresholds, enforces a closing
phase, and persists crash-safe checkpoints so a **fresh session can recover from files
alone** — no transcript replay, no lossy compaction.

## At session start

1. Read the durable files in the order the project prescribes (typically
   `AGENTS.md` → `PROTOCOL.md` → `GOAL.md` → `HANDOFF.md` → `PROGRESS.md` → `LEARNINGS.md`).
   In `HANDOFF.md`/`PROGRESS.md`, **manual prose always wins** over the
   `<!-- guard:begin checkpoint -->` managed block.
2. Heed the guard's `session_start` notice (identity banner, checkpoint freshness:
   missing/corrupt/stale/current). If stale, refresh with `/handoff` — it rewrites only
   managed blocks; hand-authored text survives byte-for-byte.
3. Run the project's verification command (named in HANDOFF/AGENTS) before touching code.

## During work — react to alert levels

Alerts are advisory budgets, not exact accounting. Levels are measured on **usable
remaining** = window − estimated used − max(generationReserve, safetyReserve).

| Level | Meaning | Do |
|---|---|---|
| 1 (~≤30k remaining) | checkpoint | update PROGRESS.md (completed, blockers, exact next action) |
| 2 (~≤20k) | wrap up | finish the current substantial task; open no new work |
| 3 (~≤10k) | handoff | prioritize durable handoff: update HANDOFF.md before anything else; the guard also auto-checkpoints |
| 4 (~≤5k) | **enforced closing** | only allowlisted tools (write/edit/read) run; finish checkpoints and stop |

A revocation notice means pressure dropped and a previous closing instruction is
**historical**, not current policy.

## Checkpoints and readiness

- `/handoff [notes]` — write the managed checkpoint (both HANDOFF.md and PROGRESS.md get
  one transactional identity: generation, id, content-delta, readiness).
- `/handoff verify` — freshness classification without writing.
- `/handoff ready` — evaluate + attest handoff completeness (blocking:
  checkpoint-current, identity-consistent, next-action-recorded, durable-files-valid;
  warnings: content-delta=none, learnings-updated). Renewal requires attestation.
- Ritual: **commit first**, then refresh + attest the checkpoint; commit the managed-block
  refresh separately when it dirties the tree.
- The guard never writes LEARNINGS.md or GOAL.md. Keep discoveries classified there
  (accepted / proposed / falsified). Never rewrite GOAL.md silently — propose in
  LEARNINGS.md instead.

## Renewal (Phase 2, if configured)

- `/handoff renew [notes]` (operator) or the `handoff_renew` tool (model; needs
  `renewal.autoRenew: true`): waits for a safe boundary, refreshes + attests, persists
  chain state, then replaces the session. The successor starts **fresh** — identity
  banner + deterministic recovery naming only durable files.
- `/handoff renew stop|resume|status` — durable operator stop (inherited by successors),
  resume, chain state view. Hard cap `maxRenewals` per chain; each checkpoint seeds at
  most one successor (idempotence); pending switches are cancellable.
- Nothing renews unless `renewal.enabled` is true in `handoff.config.json`; defaults are
  OFF everywhere.

## Testing and audit without token spend

- `/guard simulate <remainingTokens>` forces a threshold crossing; `/guard reset`
  re-arms alerts and re-baselines the GOAL hash (testing only).
- `/guard status` prints the full budget breakdown, provenance, identity/readiness,
  renewal line.
- Read-only audit session: `CONTEXT_GUARD_READONLY=1 CONTEXT_GUARD_STATE_DIR=/tmp/...
  pi -e <ext>` — zero writes inside the project tree; checkpoints become reported dry
  runs. Instructing the model not to edit is NOT read-only; this mode is.

## Integrating context-guard into a new long-running project

Read `references/bootstrap.md` for the step-by-step equip procedure and minimal file
templates. Full command/config/state reference: `references/commands.md`.

## Honesty rules

- Synthetic runs prove state-machine behavior only, never real-token accuracy.
- Report what was verified and what was not; classify claims with evidence; a green mock
  suite does not prove the extension loads in the real runtime — load it there
  (`pi -e …` or the project's e2e script) after any edit.
