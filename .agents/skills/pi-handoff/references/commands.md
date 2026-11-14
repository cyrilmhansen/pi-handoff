# context-guard — command, configuration and state reference

Version reference: **v0.1.0-dev.4** plus Lot F mission-instance support (Pi 1.4.0).
Historical D1–D9 details remain in the changelog; Rune CI service files remain external
to this extension. `renewal.successorTurn: "user"` and the documentation-cycle workflow
remain explicitly opt-in; real Sushi A/B and real-inference document-cycle validation
have not been performed. Behavior details live in `PROTOCOL.md`.

## Commands (extension slash-commands; handled without a model turn)

These slash commands are Pi operator-interface commands, not Bash commands. Agents
should call registered tools instead: `handoff_inspect` is read-only,
`handoff_finalize` closes without renewal, and `handoff_renew` requests a gated renewal.
`handoff_inspect` uses the same checkpoint/readiness report as `/handoff status` and
`/handoff verify`; it never writes files or state and does not verify scientific results.

| Command | Effect |
|---|---|
| `/guard status` | Full budget report: model, window + source, estimated used, raw remaining, reserve + source + fraction, usable remaining, level, next threshold, **escalation crossing points in estimated used tokens** (dev.2 D6: `window − reserve − threshold` per level, reserve provenance, enforced/advisory kind, `!! too tight` flag for crossings ≤ 0, honest "the guard never changes the model window" line), measurement provenance (real/synthetic/unknown), inconsistencies, checkpoint identity/readiness, renewal line, **recovery-cost meter** (dev.2 D4: full-set vs lean-tier chars and chars/4 estimates, A-1 caveat) |
| `/guard simulate <remainingTokens>` | Synthetic pressure for this session (state-machine testing, no inference) |
| `/guard reset` | Re-arm alerts, re-baseline GOAL hash, rebuild the machine (testing/re-baselining only) |
| `/guard verify-checkpoint` | Checkpoint classification + readiness + renewal authorization |
| `/guard events [n]` | Tail of `<stateDir>/diagnostics.jsonl` (dev.2 D5c): typed, bounded events — session_start/alert/revocation/renewal_request/renewal_result/finalize/tool_block/turn_aborted; never prompts/args/secrets; audit mode with in-tree stateDir reports "not persisted" |
| `/handoff status` | Read-only checkpoint/readiness/renewal report; writes no files or state |
| `/handoff instance status` | Show selected instance and resolved operational/state paths |
| `/handoff instance create <id> [--profile <id@version>]` | Create an identity manifest and empty operational docs; no project docs are copied |
| `/handoff instance select <id>` | Print explicit next-session selection instructions; current session does not switch |
| `/handoff verify` | Freshness: missing / corrupt / stale / current (names changed sources); also prints the recovery-cost meter (dev.2 D4) |
| `/handoff checkpoint [notes]` | Explicit checkpoint write (managed blocks only); bare `/handoff` remains the no-notes form |
| `/handoff ready` | Evaluate + attest readiness (bound to checkpoint id). `/handoff ready check` = evaluate only |
| `/handoff finalize [notes]` | Independent closing (dev.2 D2): refresh-if-stale + readiness + attest in one synchronous step; works with renewal disabled/capped/stopped; NEVER switches sessions or touches chain state; read-only mode = reported dry run |
| `/handoff renew [notes]` | Operator renewal: waitForIdle → refresh+attest → gate → persist chain state → new session |
| `/handoff renew --task "..."` | Operator renewal with a short new mission for the first successor turn |
| `/handoff renew --task-file <path>` | Read a Markdown mission inside the project (realpath-checked, 64 KiB UTF-8 maximum); content is not copied to checkpoint notes |
| `/handoff renew go` | Bridge used by the `handoff_renew` tool (model trigger); do not call manually mid-turn |
| `/handoff renew stop` \| `resume` | Durable operator stop flag in chain state (successors inherit) |
| `/handoff renew status` | Chain: enabled/autoRenew, renewalsDone/maxRenewals, stopped, pending authorization |
| `/handoff cycle status` | Read-only documentary workflow state and any explicit recovery token |
| `/handoff cycle plan` | Start one fresh read-only planning context at a capped, attested campaign boundary |
| `/handoff cycle approve <plan-sha256>` | Approve exactly the current plan and source/base fingerprints; edits nothing |
| `/handoff cycle apply` | Start one application context for the approved plan; it must use `durable_edit.py` |
| `/handoff cycle no-change <plan-sha256>` | Record an explicitly hashed `NO_CHANGE` plan without apply/review |
| `/handoff cycle review` | Start an independent fresh review context after application |
| `/handoff cycle accept-review <report-sha256>` | Accept an exact passing report bound to current docs and Git revision |
| `/handoff cycle continue` | After review or NO CHANGE, preserve old chain in the configured archive and initialize a new chain; starts no session |
| `/handoff cycle abort` \| `recover <token>` | Preserve artifacts and explicitly abandon a cycle, or clear a stale lock without replay |

`--task` and `--task-file` are operator-only slash-command options. Quote a complete
short mission for `--task`; `--task-file` reads the file without executing it and rejects
paths or symlink targets outside the project. Missions are capped at 64 KiB UTF-8 and
remain separate from predecessor notes, durable `Next action`, checkpoint blocks, and
diagnostics. Refusal or canceled replacement does not send a mission to a successor.
`renewal.successorTurn: "user"` is experimental; its user-role message states that
Handoff generated it and grants no authority beyond the explicit renewal/task. It sends
one structured non-triggering origin marker and one triggering user message, with no
custom `triggerTurn: true` fallback.

Tool: `handoff_renew` (model-initiated renewal; requires `renewal.autoRenew: true`;
dispatches `/handoff renew go` fire-and-forget — the switch happens when the turn
settles; awaiting it inside the tool would deadlock). Registered whenever the guard
loads, but every call re-checks the full gate and refuses with a named reason (cheap
refusals never write); during enforced level-4 closing the model can only call it if
`handoff_renew` is listed in `closingAllowlist`.

Tool: `handoff_finalize` (dev.2 D2) — model-driven closing without a switch: same
synchronous refresh + attest machinery, no waitForIdle, no dispatch, no chain-state
writes; callable during enforced closing regardless of `closingAllowlist` (it writes only
managed blocks). It is NOT a substitute for renewal of an active, permitted chain:
finish the bounded operation, preserve durable evidence, then call `handoff_renew` at a
safe boundary if the objective continues. A missing/stale checkpoint may be prepared
by that tool before the final gate. At the exhausted cap, finalize and stop.

Tool: `handoff_inspect` — read-only structured freshness, attestation, next-action,
changed-source and renewal-gate report. It is callable during enforced closing because
it cannot mutate state. The renewal field distinguishes `ready-now`,
`preparation-required`, and `refused`.

### Durable document editing and audit

`scripts/durable_edit.py` is a repository CLI for agents with Bash access, not a Pi slash
command. It targets exact Markdown sections and is optional alongside ordinary file
tools. Use `python3 scripts/durable_edit.py audit --root .` for a read-only inventory;
it reports the authoritative HANDOFF next action, duplicate/stale operational titles,
possible HANDOFF/PROGRESS action conflicts, missing archive links, document sizes and
chars/4 recovery estimates. It can return **NO CHANGE** and never edits or consolidates.

The `plan` command prints a diff and current/proposed hash for `append`, `replace`, or
`prepend`; `apply` now requires the reviewed `--expect-sha256`. `archive-plan` and
`archive-apply` show and validate both source and archive diffs/hashes, preserve the
archived section content, and replace the active section when supplied. See
`references/durable-edit.md` for exact recipes, conflict behavior and limits. The editor
refuses ambiguous/stale anchors and never edits checkpoint-managed blocks.

Document prose and machine blocks remain different sources. Use `git diff` to inspect
actual prose/managed-block changes, `handoff_inspect` for verified checkpoint freshness
and attestation, and `git status --short` for staged/unstaged worktree state. An attested
checkpoint does not claim source code is committed, validated or pushed.

## Configuration — `handoff.config.json` (project root; read once per `session_start`)

| Key | Default | Meaning |
|---|---|---|
| `thresholds` | `{advisory:30000, wrapUp:20000, handoff:10000, closing:5000}` | usable-remaining crossings for levels 1–4 |
| `generationReserve` | `"model"` (or number) | budget subtracted for the next completion; `"model"` = `ctx.model.maxTokens` |
| `workingContextWindow` | `null` | optional guard-only positive integer work ceiling; clamped at the physical Pi window; no change to model config or Sushi |
| `safetyReserve` | `0` | extra floor; effective reserve = `max(generationReserveResolved, safetyReserve)` |
| `enforceClosing` | `true` | level 4 gates non-allowlisted tool calls |
| `closingAllowlist` | `["write","edit","read"]` | tools permitted during enforced closing (add `handoff_renew` for renewal projects) |
| `protectGoal` | `true` | block write/edit to GOAL.md; warn on goal drift |
| `autoCheckpointAtHandoffLevel` | `true` | one auto-checkpoint per escalation to level ≥ 3 |
| `maxConsecutiveUnknown` | `3` | evaluations without usable measurement before "degraded" (holds last level — fail-safe) |
| `stateDir` | `.pi-guard` | runtime state location |
| `readOnly` | `false` | audit mode (zero writes in the tree) |
| `maxSessionStates` | `0` | per-session state retention; `0` = pruning disabled (safe default) |
| `renewal.enabled` | `false` | master switch: operator `/handoff renew` needs true; the tool and hint stay refused otherwise |
| `renewal.autoRenew` | `false` | *additionally* authorizes model-initiated renewal (`handoff_renew` tool + `RENEWAL AVAILABLE` hint at level ≥ 3); alerts alone never force a transition |
| `renewal.maxRenewals` | `2` | hard cap per renewal chain |
| `renewal.recoveryPrompt` | (built-in) | replaces the generic recovery body; the mandatory identity header and safety trailer of the successor message are always kept (dev.2 D1) |
| `renewal.testCommand` | `null` | project-configured build-verify command in the successor prompt; `null` = no build-verify line at all (never assume a generic one) |
| `renewal.successorTurn` | `"custom"` | `"custom"` preserves the existing custom-message trigger; opt-in `"user"` uses one generated, provenance-labelled `sendUserMessage()` trigger |
| `recovery.lean` | `false` | dev.2 D4 opt-in: successor recovery instruction uses TIERS — operational (HANDOFF/PROGRESS, read NOW) → methodology (AGENTS/PROTOCOL, on procedure need) → archive (GOAL/LEARNINGS, by reference, on demand). All six files stay authoritative and named; tiering defers reading, never drops authority. An explicit `renewal.recoveryPrompt` still wins |
| `documentation.enabled` | `false` | Optional, operator-supervised documentary campaign workflow. It does not edit/approve/reset automatically and does not consume renewal quota |
| `documentation.archiveDir` | `docs/history` | In-project destination for the archived old renewal-chain JSON |
| `documentation.planPrompt` / `applyPrompt` / `reviewPrompt` | bundled v1 prompts | Optional in-project prompt overrides; their contents are included in the source fingerprint |
| `recovery.budgetTokens` | `12000` | target budget for the operational tier, in chars/4 ESTIMATED tokens (the meter reports estimates, not accounting — A-1) |
| `files` | GOAL/PROGRESS/LEARNINGS/HANDOFF.md | durable file names |
| `missionInstance.id` | `null` | Explicit selected instance; `null` keeps legacy root docs and state path |
| `missionInstance.workProfile` | `null` | Optional versioned `{id, version}` reference, checked against the instance manifest |

Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<n>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>` (may live outside the tree),
`CONTEXT_GUARD_AUTO_RENEW=1|0`, `CONTEXT_GUARD_LEAN=1|0` (force lean recovery tiers
for one process, dev.2 D4), `GUARD_VERSION=<string>` (identity-banner version override
for probes/forensics, dev.2 D5d). CLI flags: `--guard-synthetic <n>`,
`--guard-readonly 1` (flags require an explicit value).

## Budget arithmetic

```
usable remaining = min(Pi physical contextWindow, workingContextWindow ?? Pi physical contextWindow) − estimatedTokensUsed − max(generationReserveResolved, safetyReserve)
```

- Pi 1.4.0 has **no exact remaining-context API**; `getContextUsage().tokens` is an
  estimate (last trustworthy assistant usage + chars/4 for trailing messages).
  Thresholds are advisory budgets.
- A reserve is a **policy budget, not an output cap**: Pi clamps
  `max_tokens = min(model.maxTokens, window − estimate − 4096)` per request, so an
  over-long generation is provider-truncated, never overflows the window.
- Consequence to internalize at install time: with a large `maxTokens` model and
  `"generationReserve": "model"`, enforced closing fires far before the window edge
  (e.g. 220 000 − 65 536 − 5 000 ⇒ closing at ≈150 k used). A fixed smaller reserve
  (e.g. 20 000) moves closing to ≈195 k used but leaves less headroom to the true edge.
- Mid-session config edits do NOT re-baseline a running session (config is read at
  `session_start`); use `/reload` or a new session, and `/guard reset` to re-arm.
- Crossing points (dev.2 D6) are the same arithmetic as the live budget, expressed in
  estimated USED tokens: `used ≥ window − reserve − threshold` per level. They are
  advisory policy budgets over Pi's estimate — the guard never changes the model
  window (model/provider-owned). A crossing ≤ 0 means that level would already be
  active at session start; `/guard status` flags it `!! too tight` instead of hiding
  it. Example profile: `docs/profiles/experimental-95k.json` (window 95k, reserve 5k,
  thresholds 20k/12k/8k/5k → crossings 70k/78k/82k/85k used).

## State locations

When `missionInstance.id` is set (or `CONTEXT_GUARD_MISSION_INSTANCE` selects an ID for
this process), `HANDOFF.md`, `PROGRESS.md`, and `LEARNINGS.md` resolve under
`.pi-handoff/instances/<id>/`; the project `GOAL.md` remains shared and protected. Guard
runtime, checkpoint generation history, renewal chain and documentation-cycle state use
`.pi-guard/instances/<id>/`. The instance ID is included in checkpoint and chain identity
generation. Each Pi process reads its selection only at session start; no shared active
pointer or live context switch exists. Missing/corrupt manifests and paths resolving
outside the project fail closed. With no ID selected, all pre-Lot-F paths remain intact.
An optional `missionInstance.workProfile` must match the instance manifest and a valid
`.pi-handoff/work-profiles/<id>/<version>.json` containing `schema: 1`, `id`, `version`,
`instructions` and `knowledgeRefs`. The identity banner names this file for the agent to
read; it is guidance, not an operator authorization channel.

- `<stateDir>/sessions/<sessionId>.json` — per-session runtime state (schema v2, atomic
  writes; `checkpointId`, `handoffReady`, `learningsHash` audit fields; corrupt files
  are quarantined per-session; legacy single `state.json` migrates newest-wins).
- `<stateDir>/renewal-state.json` — durable chain state (`chainId`, `renewalsDone`,
  `renewedFromCheckpointId`, `stopped`); survives session replacement and process
  restart; carries the operator stop.
- `<stateDir>/diagnostics.jsonl` — dev.2 D5c structured event trail (JSONL, ISO+epoch;
  closed type vocabulary: session_start/alert/revocation/renewal_request/
  renewal_result/finalize/tool_block/turn_aborted; allowlisted fields only — never
  prompts, tool arguments or secrets; rotation ~500; audit mode with an in-tree
  stateDir persists nothing, an external one is allowed). Read with `/guard events [n]`.
- Pi session transcripts live under `$PI_CODING_AGENT_DIR/sessions/`, never in the
  project tree.

## Checkpoint classes and the renewal gate

`validateCheckpoint` → exactly one of `missing | corrupt | stale | current`
(read-only, never "fixes"). `stale` names the changed sources; interrupted two-file
writes / mixed generations / forged ids ⇒ `stale` with `partial: true`.
`attestHandoff` refuses unless every blocking check passes; a new generation resets
readiness to unattested.

After upgrading from a parser that searched for `## Next action` as plain text, an
older schema-v3 checkpoint can be reclassified `stale` even when its source hashes
match: hashes prove byte freshness, not that its attested action came from the real
manual heading. Review the manual `## Next action`, refresh with `/handoff checkpoint [notes]`,
then attest with `/handoff ready`. Never edit either managed checkpoint block by hand.
Duplicate or missing real headings must be corrected in manual prose before
attestation.

`renewAuthorization()` = current ∧ identity-consistent ∧ attested. `decideRenewal()`
refusals in precedence order: stop > read-only > disabled > auto-disabled > pending >
capped > not-authorized > already-renewed.

### Instance ownership and crash recovery (Lot G)

`/handoff instance status` reports whether this Pi process owns the selected instance.
The exclusive lock is `.pi-handoff/instances/<id>/.owner.lock`. A conflicting process
cannot checkpoint, attest, renew or mutate a documentation cycle; its ordinary `bash`,
`write` and `edit` calls are also blocked for the selected instance's operational/state
paths. The lock remains across renewal successor sessions and releases only on normal
process exit with a matching owner token. Different IDs remain independent. No ID selected
preserves the legacy layout.

After a crash, run `/handoff instance recover <id>` only when the owner is provably gone.
Automatic recovery is limited to local Linux evidence (PID absent or boot ID/process start
ticks changed). macOS live PIDs, corrupt locks, foreign hosts, permissions errors and an
interrupted recovery marker are refused. For those cases, stop every Pi process that could
select the ID, confirm they are stopped, inspect the exact instance directory, then remove
only the abandoned `.owner.lock` and/or `.owner.lock.recovery` and restart Pi. Do not use
age as proof or remove artifacts while acquisition could still be active. These guarantees
cover local filesystems honoring exclusive creation and Handoff/intercepted Pi operations;
they do not lock arbitrary external processes, other checkouts, or network filesystems.

### Mission-instance closure (Lot H)

- `/handoff instance close plan` — read-only state-bound plan and approval fingerprint.
- `/handoff instance close --confirm <fingerprint> --reason "..."` — terminally seal the
  selected instance after rechecking the plan, current attestation, blockers and owner
  lock. A clean worktree is not required.
- `/handoff instance close status` — inspect the closure record and verify retained-file
  hashes, including after process restart.

Closure requires a current, attested checkpoint; attestation is a Handoff readiness proof,
not scientific/software validation. The record remains alongside the instance's documents
and state, without moving or deleting anything. `closure.pending` or a corrupt record
means uncertain and immutable: preserve all bytes and request explicit operator
inspection. A sealed instance cannot be reactivated or reused; create a new ID. External
filesystem changes cannot be prevented but are reported by status. Session finalize,
renewal, chain reset, process exit and documentation-cycle continuation do not close a
mission.

### Shared knowledge publication (Lot I)

The model-callable `handoff_knowledge` tool only supports `list`, `show` and `verify`.
It cannot prepare/publish a record or approve a classification. Slash commands below are
Pi operator commands, not shell commands.

Prepare a bounded JSON proposal under `.pi-handoff/knowledge/proposals/`. It must identify
one source document in the named mission, a non-empty locator, the raw-byte SHA-256 of
that source and at least one project-relative evidence file with its SHA-256 and a short
description. Evidence paths cannot leave the project or traverse symlinks. Proposal
maximum is 128 KiB; each evidence file is limited to 16 MiB and total evidence to 64 MiB.
Use one of `accepted`, `proposed`, `falsified`, or `superseded`; the classification and
rationale document a decision and do not establish scientific validity.

```json
{
  "schema": 1,
  "id": "method-observation-01",
  "missionId": "mission-2026-11",
  "classification": "proposed",
  "statement": "Precise, bounded statement of a reusable finding.",
  "rationale": "Why this classification is recorded.",
  "source": {
    "path": ".pi-handoff/instances/mission-2026-11/LEARNINGS.md",
    "locator": "P-12",
    "sha256": "<64 lowercase hex characters>"
  },
  "evidence": [{
    "path": "artifacts/run-summary.txt",
    "sha256": "<64 lowercase hex characters>",
    "description": "Run summary supporting the finding."
  }]
}
```

For a revision, add `supersedes: {"publicationId":"<old publication id>","reason":"new evidence, refutation, correction, or replacement"}`. Do not edit old records. An identical proposal is idempotent; a different use of the same logical ID needs explicit supersession. Handoff detects duplicate identities, not semantic scientific contradictions.

- `/handoff knowledge status` — record count, lock state and registry warnings.
- `/handoff knowledge plan <proposal-name>` — read-only checks and state-bound approval fingerprint.
- `/handoff knowledge publish <proposal-name> --confirm <fingerprint>` — operator-only approval and atomic append; rechecks proposal, references and registry while holding the shared registry lock.
- `/handoff knowledge list [--classification <class>] [--mission <id>] [--id <id>]`, `/handoff knowledge show <id>`, `/handoff knowledge verify <id>` — read-only consultation.
- `/handoff knowledge recover` — explicit recovery only when the registry lock owner is proven absent; it never replays a publication. Re-plan and reconfirm afterward.

The record links source mission/profile, checkpoint or closure identity, evidence hashes,
operator decision, time and integrity fingerprints. A closed mission can be cited without
changing it. Publications are not injected into mission prompts, do not alter Next action,
GOAL or scientific evidence, and confer no operator authority. Registry serialization
covers cooperating processes in one local project tree, not network filesystems or other
checkouts. Temporary artifacts and uncertain state are preserved for operator inspection.
An interrupted atomic temporary artifact also blocks new plans until the operator has
backed it up and explicitly inspected/resolved it; Handoff never cleans or replays it.
