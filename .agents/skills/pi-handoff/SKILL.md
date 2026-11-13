---
name: pi-handoff
description: Operate a project equipped with the Pi context-guard extension and its durable handoff files (AGENTS.md, PROTOCOL.md, GOAL.md, HANDOFF.md, PROGRESS.md, LEARNINGS.md, handoff.config.json). Use when a session reports context pressure levels or checkpoint freshness, when writing or verifying a checkpoint (/handoff), when attesting handoff readiness, when closing a session down or renewing it into a fresh successor session, when running a read-only audit, when testing thresholds without spending tokens, or when installing context-guard into a new long-running project.
compatibility: Pi >= 1.4.0; requires the context-guard extension loaded (pi -e <path>/.pi/extensions/context-guard/index.ts, or project trust) and the durable files at the project root.
---

# Pi Handoff — operating a context-guard project

Context-guard monitors remaining context, alerts at thresholds, enforces a closing
phase, and persists crash-safe checkpoints so a **fresh session can recover from files
alone** — no transcript replay, no lossy compaction.

## Who can do what

| Actor | Capability |
|---|---|
| Operator | Pi `/handoff` and `/guard` slash commands |
| Agent | Tools actually registered in Pi, including its normal file tools |
| Agent | `handoff_inspect` — read-only checkpoint and renewal inspection |
| Agent | `handoff_finalize` — checkpoint and attest without renewing |
| Agent | `handoff_renew` — request renewal through the controlled gate |

Slash commands are Pi interface commands, **not Bash commands**. The agent must not
try to run `/handoff verify` in a shell; use `handoff_inspect` for inspection and the
registered handoff tools for agent actions. Inspection does not verify scientific
results or mutate project/state files.

## At session start

1. Read the durable files in the order the project prescribes. Two recovery modes:
   - **Full recovery (default, `recovery.lean: false`)** — read ALL six eagerly,
     typically `AGENTS.md` → `PROTOCOL.md` → `GOAL.md` → `HANDOFF.md` → `PROGRESS.md`
     → `LEARNINGS.md`.
   - **Lean tiers (opt-in, dev.2 D4: `recovery.lean: true` or `CONTEXT_GUARD_LEAN=1`)**
     — read the OPERATIONAL tier NOW (`HANDOFF.md`, `PROGRESS.md`); the METHODOLOGY
     tier (`AGENTS.md`, `PROTOCOL.md`) when a procedure question arises; the ARCHIVE
     tier (`GOAL.md`, `LEARNINGS.md`) by reference, on demand. Tiering DEFERS reading,
     never drops authority: all six files stay authoritative and named, and an
     explicit `renewal.recoveryPrompt` still overrides the successor body either way.
   In `HANDOFF.md`/`PROGRESS.md`, **manual prose always wins** over the
   `<!-- guard:begin checkpoint -->` managed block. The successor of a renewal receives
   the matching recovery instruction automatically (tiered only when lean is on).
2. Heed the guard's `session_start` notice (identity banner, checkpoint freshness:
   missing/corrupt/stale/current). The agent can call `handoff_inspect` to check
   freshness and renewal preconditions. If a checkpoint is stale, update the durable
   prose and ask the operator to use `/handoff checkpoint`; it refreshes only managed
   blocks, and hand-authored text survives byte-for-byte. If it is current, do not ask
   for a redundant checkpoint/attestation ritual; a consumed identity can be refreshed
   only by its recorded successor when continuing the chain.
3. Run the project's verification command (named in HANDOFF/AGENTS) before touching code.

## During work — react to alert levels

Alerts are advisory budgets, not exact accounting. Levels are measured on **usable
remaining** = working window − estimated used − max(generationReserve, safetyReserve).
The working window is `min(Pi's physical contextWindow, recovery-independent workingContextWindow ?? Pi's physical contextWindow)`; this is a Handoff policy ceiling, never a Pi/Sushi model change.

| Level | Meaning | Do |
|---|---|---|
| 1 (~≤30k remaining) | checkpoint | call `handoff_inspect` to review freshness and gates; update PROGRESS.md (completed, blockers, exact next action) |
| 2 (~≤20k) | wrap up | call `handoff_inspect`; finish the current substantial task; open no new work |
| 3 (~≤10k) | handoff | prioritize durable handoff: update HANDOFF.md before anything else; the guard also auto-checkpoints |
| 4 (~≤5k) | **enforced closing** | only tools in `closingAllowlist` run (default write/edit/read; renewal-enabled projects add `handoff_renew`); preserve the durable state; if the objective continues and renewal is allowed/preparable, request `handoff_renew` at a safe boundary; otherwise finalize and stop. With `enforceClosing:false` the same crossing alerts with ADVISORY wording and blocks nothing — alert text always matches live policy |

A revocation notice means pressure dropped and a previous closing instruction is
**historical**, not current policy.

## Checkpoints and readiness

- Operator `/handoff checkpoint [notes]` — refresh the managed checkpoint when state is
  stale or notes are supplied (both HANDOFF.md and PROGRESS.md share one transactional
  identity: generation, id, content-delta, readiness). With unchanged current state and
  no notes, it reuses the existing identity without writing.
- Operator `/handoff verify` — freshness classification without writing. Agent:
  `handoff_inspect` returns the same freshness/readiness view plus renewal preconditions.
- `/handoff ready` — evaluate + attest handoff completeness (blocking:
  checkpoint-current, identity-consistent, next-action-recorded, durable-files-valid;
  warnings: content-delta=none, learnings-updated). Renewal requires attestation; repeating
  it on an already-attested current checkpoint does not change files or runtime state.
- `/handoff finalize [notes]` or the `handoff_finalize` tool (dev.2 D2) — independent
  closing: refresh-if-stale + readiness + attest in ONE synchronous step. Works with
  renewal disabled, capped (8/8) or stopped; never switches sessions, touches chain
  state, waits for idle, or bypasses readiness. At the cap this is the safe closing path.
- Bare `/handoff` remains the operator's compatible no-notes checkpoint request; when its
  identity is already current it reports reuse without writing. `/handoff status` is
  read-only and concise on the healthy path. Unknown verbs show usage and never become
  checkpoint notes.
- When source prose changes, **commit first**, then refresh + attest the checkpoint;
  commit the managed-block refresh separately only when the refresh writes. A current,
  attested checkpoint needs no repeat ritual before renewal.
- The guard never writes LEARNINGS.md or GOAL.md. Keep discoveries classified there
  (accepted / proposed / falsified). Never rewrite GOAL.md silently — propose in
  LEARNINGS.md instead.

## Consolidation and strategy pivots (operator-approved)

- When a phase is finished/abandoned, instructions conflict, the strategy changes,
  or recovery-cost estimates grow, **propose** a reviewable consolidation plan.
  Read `references/consolidation.md` before any such edit. This is a **manual
  workflow, not a guard command or automatic cleanup**; never trigger it merely
  because a pressure threshold was crossed.
- Keep `HANDOFF.md` focused on **one current next action**, `PROGRESS.md` on the
  active phase and concise verified milestones, and `LEARNINGS.md` on
  evidence-linked accepted/proposed/falsified knowledge (including archived or
  superseded entries). Archive former strategies with stable pointers, not silent
  deletion. Keep project-specific scientific ledgers and goldens authoritative.
- Obtain explicit operator approval for the plan; a change to `GOAL.md` requires
  **separate** authorization and an operator-controlled update. Never edit
  checkpoint managed blocks by hand. After approved edits: verify references and
  the project gate, commit, refresh via `/handoff`, attest via `/handoff ready`,
  and compare before/after recovery cost. Do not reset the renewal chain.

## Structured document edits and audit

- Use `python3 scripts/durable_edit.py audit --root .` for a read-only inventory; it
  reports the active Next action, duplicate/stale headings, possible action conflicts,
  missing archive links, file sizes and chars/4 estimates. It may say **NO CHANGE** and
  never consolidates or writes.
- For a scoped edit, use the provided CLI directly: `plan` first, inspect its diff and
  source hash, then `apply` with that reviewed `--expect-sha256`. It supports exact
  section append/replace and preview-first archival; see
  `references/durable-edit.md`. Do not create an ad-hoc replacement script.
- Keep audit, checkpoint and Git facts separate: audit findings are review suggestions;
  `handoff_inspect` verifies checkpoint identity/freshness/attestation; `git status` and
  staged/unstaged `git diff` show actual local work. Attestation says nothing about
  whether source work is committed, validated or pushed.
- Preserve checkpoint-managed blocks and historical provenance. Keep a falsified
  prediction, the observation that disproved it and the later operator decision distinct.
  Archival/consolidation follows the explicit approval procedure above; the audit never
  grants that approval. Never change `GOAL.md` or scientific evidence implicitly.

## Renewal (Phase 2, if configured)

- **Continuation precedence (issue #1):** when the objective remains unfinished, a live, permitted renewal takes precedence over terminal finalization. L3/L4 mean finish current bounded work and preserve evidence, then request `handoff_renew` at a safe boundary if permitted or safely preparable. A stale checkpoint may be refreshed and attested by that tool; a preview refusal means NOT authorized now, not necessarily permanently impossible. Use `handoff_finalize` for intentional non-renewing closure (disabled/stopped/capped/irreparable refusal). No threshold forces a switch.
- `/handoff renew [notes]` (operator) or the `handoff_renew` tool (model; needs
  `renewal.autoRenew: true`): waits for a safe boundary, refreshes + attests, persists
  chain state, then replaces the session. The successor starts **fresh** — identity
  banner + deterministic recovery naming only durable files; the recovery body is the
  full six-file read unless `recovery.lean` is enabled (D4 tiers) or a
  `renewal.recoveryPrompt` overrides it.
- An operator may attach a new mission with `/handoff renew --task "short mission"` or
  `/handoff renew --task-file path/to/mission.md`. Task files are read only from inside
  the project after symlink resolution, capped at 64 KiB UTF-8, and never copied to
  checkpoint blocks. The successor sees a separate operator-task section; predecessor
  notes and durable `Next action` retain their own provenance. Refusal/cancellation sends
  no mission to a successor.
- `renewal.successorTurn` defaults to `"custom"`. Experimental `"user"` emits a
  structured non-triggering origin marker then exactly one `sendUserMessage()` trigger.
  Its visible content says Handoff generated it, not a human; the user role grants no
  extra authority. A failed send is reported without a second trigger.
- `/handoff renew stop|resume|status` — durable operator stop (inherited by successors),
  resume, chain state view. Hard cap `maxRenewals` per chain; each checkpoint seeds at
  most one successor (idempotence); pending switches are cancellable.
- Policy meanings are distinct: `renewal.enabled` (default **false**) switches the whole
  mechanism on — operator `/handoff renew` only; `renewal.autoRenew` (default **false**)
  *additionally* authorizes the model path (permits the `handoff_renew` tool and the
  level-≥3 renewal hint — which since dev.2 D5b only appears as `RENEWAL AVAILABLE` when
  a full WRITE-FREE preview of the real gate passes, otherwise as `RENEWAL NOT AVAILABLE
  (<reason>)` with concrete safe instructions, `handoff_finalize` at the cap). Pressure
  alerts alone NEVER force a transition. The `handoff_renew` tool exists whenever the
  guard loads but refuses with a named reason unless policy + gates allow; to be callable
  during enforced closing it must be listed in `closingAllowlist`.

## Testing and audit without token spend

- `/guard simulate <remainingTokens>` forces a threshold crossing; `/guard reset`
  re-arms alerts and re-baselines the GOAL hash (testing only).
- `/guard status` prints the full budget breakdown, provenance, identity/readiness,
  renewal line, the escalation crossing points in estimated used tokens (dev.2 D6) and
  the recovery-cost meter (full vs lean tiers, chars/4 estimates, dev.2 D4).
  `/guard events [n]` tails the structured diagnostics trail
  (`<stateDir>/diagnostics.jsonl`; typed, bounded, never prompts/args/secrets;
  `agent_settled.aborted` is recorded for attribution and NEVER auto-retried).
- Read-only audit session: `CONTEXT_GUARD_READONLY=1 CONTEXT_GUARD_STATE_DIR=/tmp/...
  pi -e <ext>` — zero writes inside the project tree; checkpoints become reported dry
  runs. Instructing the model not to edit is NOT read-only; this mode is. Audit mode is
  still NOT an OS-level read-only filesystem (Pi transcripts live elsewhere, and tools
  may write outside the tree).

## Integrating context-guard into a new long-running project

Read `references/bootstrap.md` for the step-by-step equip procedure and minimal file
templates. Full command/config/state reference: `references/commands.md`.

## Honesty rules

- Synthetic runs prove state-machine behavior only, never real-token accuracy; a
  synthetic-trigger experiment proves the switch mechanics, not where real pressure
  lands (e.g. a reserve-driven nominal closing point stays unproven until observed
  under real accounting).
- Report what was verified and what was not; classify claims with evidence; a green mock
  suite does not prove the extension loads in the real runtime — load it there
  (`pi -e …` or the project's e2e script) after any edit.
- State renewal proof scope precisely: one model-initiated hop + one operator-initiated
  hop is what live experiments verified; generalized concurrent renewal safety is not
  proven (only specific two-process invariants are).
