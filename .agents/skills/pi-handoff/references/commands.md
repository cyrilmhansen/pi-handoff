# context-guard — command, configuration and state reference

Verified against pi-handoff (Pi 1.4.0, context-guard Phase 2 increments A+B+C).
Everything below exists in the installed extension; behavior details live in the
project's `PROTOCOL.md`.

## Commands (extension slash-commands; handled without a model turn)

| Command | Effect |
|---|---|
| `/guard status` | Full budget report: model, window + source, estimated used, raw remaining, reserve + source + fraction, usable remaining, level, next threshold, measurement provenance (real/synthetic/unknown), inconsistencies, checkpoint identity/readiness, renewal line |
| `/guard simulate <remainingTokens>` | Synthetic pressure for this session (state-machine testing, no inference) |
| `/guard reset` | Re-arm alerts, re-baseline GOAL hash, rebuild the machine (testing/re-baselining only) |
| `/guard verify-checkpoint` | Checkpoint classification + readiness + renewal authorization |
| `/handoff [notes]` | Write checkpoint (managed blocks of HANDOFF.md + PROGRESS.md only) |
| `/handoff verify` | Freshness: missing / corrupt / stale / current (names changed sources) |
| `/handoff ready` | Evaluate + attest readiness (bound to checkpoint id). `/handoff ready check` = evaluate only |
| `/handoff finalize [notes]` | Independent closing (dev.2 D2): refresh-if-stale + readiness + attest in one synchronous step; works with renewal disabled/capped/stopped; NEVER switches sessions or touches chain state; read-only mode = reported dry run |
| `/handoff renew [notes]` | Operator renewal: waitForIdle → refresh+attest → gate → persist chain state → new session |
| `/handoff renew go` | Bridge used by the `handoff_renew` tool (model trigger); do not call manually mid-turn |
| `/handoff renew stop` \| `resume` | Durable operator stop flag in chain state (successors inherit) |
| `/handoff renew status` | Chain: enabled/autoRenew, renewalsDone/maxRenewals, stopped, pending authorization |

Tool: `handoff_renew` (model-initiated renewal; requires `renewal.autoRenew: true`;
dispatches `/handoff renew go` fire-and-forget — the switch happens when the turn
settles; awaiting it inside the tool would deadlock). Registered whenever the guard
loads, but every call re-checks the full gate and refuses with a named reason (cheap
refusals never write); during enforced level-4 closing the model can only call it if
`handoff_renew` is listed in `closingAllowlist`.

Tool: `handoff_finalize` (dev.2 D2) — model-driven closing without a switch: same
synchronous refresh + attest machinery, no waitForIdle, no dispatch, no chain-state
writes; callable during enforced closing regardless of `closingAllowlist` (it writes only
managed blocks). At the exhausted renewal cap this is the safe path: finalize, then stop.

## Configuration — `handoff.config.json` (project root; read once per `session_start`)

| Key | Default | Meaning |
|---|---|---|
| `thresholds` | `{advisory:30000, wrapUp:20000, handoff:10000, closing:5000}` | usable-remaining crossings for levels 1–4 |
| `generationReserve` | `"model"` (or number) | budget subtracted for the next completion; `"model"` = `ctx.model.maxTokens` |
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
| `files` | GOAL/PROGRESS/LEARNINGS/HANDOFF.md | durable file names |

Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<n>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>` (may live outside the tree),
`CONTEXT_GUARD_AUTO_RENEW=1|0`. CLI flags: `--guard-synthetic <n>`,
`--guard-readonly 1` (flags require an explicit value).

## Budget arithmetic

```
usable remaining = contextWindow − estimatedTokensUsed − max(generationReserveResolved, safetyReserve)
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

## State locations

- `<stateDir>/sessions/<sessionId>.json` — per-session runtime state (schema v2, atomic
  writes; `checkpointId`, `handoffReady`, `learningsHash` audit fields; corrupt files
  are quarantined per-session; legacy single `state.json` migrates newest-wins).
- `<stateDir>/renewal-state.json` — durable chain state (`chainId`, `renewalsDone`,
  `renewedFromCheckpointId`, `stopped`); survives session replacement and process
  restart; carries the operator stop.
- Pi session transcripts live under `$PI_CODING_AGENT_DIR/sessions/`, never in the
  project tree.

## Checkpoint classes and the renewal gate

`validateCheckpoint` → exactly one of `missing | corrupt | stale | current`
(read-only, never "fixes"). `stale` names the changed sources; interrupted two-file
writes / mixed generations / forged ids ⇒ `stale` with `partial: true`.
`attestHandoff` refuses unless every blocking check passes; a new generation resets
readiness to unattested.

`renewAuthorization()` = current ∧ identity-consistent ∧ attested. `decideRenewal()`
refusals in precedence order: stop > read-only > disabled > auto-disabled > pending >
capped > not-authorized > already-renewed.
