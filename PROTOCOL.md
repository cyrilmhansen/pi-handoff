# PROTOCOL.md — durable working protocol

The single source of procedure. Working files reference this; they do not duplicate it.

## 1. Context thresholds

Measured as **remaining usable context**:
`remaining = contextWindow − estimatedTokensUsed − max(generationReserveResolved, safetyReserve)`,
where `generationReserveResolved` is `ctx.model.maxTokens` for `"generationReserve": "model"`
and the literal number otherwise. The reserve is a **policy budget for the next completion,
not an output cap**: Pi 1.4.0 clamps `max_tokens = min(model.maxTokens, window − estimate − 4096)`
per request (`pi-ai` `clampMaxTokensToContext`), so a long generation is truncated by the
provider instead of overflowing the window. With Sushi's 220 000/65 536 that puts enforced
closing at ≈150 k used, not 220 k — `/guard status` reports every component (raw remaining,
reserve and its source, usable remaining, reserve fraction, provenance, inconsistencies) and
flags a reserve above 25 % of the window.
Estimation comes from Pi's `ctx.getContextUsage()` (see README §verified API); it is an
estimate, so thresholds are advisory budgets, not guarantees.

| Level | Remaining (default) | Class | Meaning |
|---|---|---|---|
| 1 | ≤ 30 000 | advisory | checkpoint: update PROGRESS.md (completed, blockers, exact next action) |
| 2 | ≤ 20 000 | advisory | finish the current substantial task; do not open new work |
| 3 | ≤ 10 000 | advisory | prioritize durable handoff: write HANDOFF.md before anything else |
| 4 | ≤ 5  000 | **enforced** | controlled closing: only tools in `closingAllowlist` run (default `write/edit/read`; renewal-enabled projects add `handoff_renew` so the model can still renew during closing); finish checkpoints and stop |

Configuration: `handoff.config.json` (`thresholds`, `enforceClosing`, `closingAllowlist`,
`generationReserve`, `safetyReserve`, `protectGoal`, `maxConsecutiveUnknown`, `stateDir`,
`readOnly`, `maxSessionStates`, `renewal` — Phase 2 policy block, see §6).
Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<n>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>`, `CONTEXT_GUARD_AUTO_RENEW=1|0` (force-enable/disable
the renewal policy for this process); CLI flags `--guard-synthetic <n>`, `--guard-readonly <1>`.

Alert semantics:
- One alert per threshold crossing per session (even if headroom later returns).
- Several crossings in one step are combined into one message.
- Alerts are appended as custom transcript messages with `triggerTurn:false`, i.e. they
  never interrupt an in-flight tool call, and they never modify the system prompt.
- If measurements are unavailable for `maxConsecutiveUnknown` evaluations, the guard
  reports "degraded" and holds the last known level (fail-safe: enforcement is never
  silently released by missing data).

Advisory vs enforced: levels 1–3 change agent *guidance* only; level 4 blocks new
non-checkpoint tool calls (`tool_call` gate) when `enforceClosing` is true. GOAL.md is
protected at all levels when `protectGoal` is true.

## 2. Checkpoint semantics

- Checkpoints are written by `/handoff [notes]` or automatically once per escalation to
  level ≥ 3. They update **managed sections only** (`<!-- guard:begin ... -->` blocks) of
  `HANDOFF.md` and `PROGRESS.md`; all agent-authored text outside markers is preserved
  byte-for-byte. `LEARNINGS.md` and `GOAL.md` are never written by the guard. Managed
  blocks carry source-state content hashes (§2.1).
- Writes are atomic (temp file + rename). Guard state (level, spent alerts, goal hash,
  checkpoint freshness) is persisted to per-session files
  `<stateDir>/sessions/<sessionId>.json` (§2.2); alerts are once per threshold
  **per session**, and a new session re-arms them.
- A checkpoint is validated two ways: structurally (each durable file must contain its
  required sections — `checkpoint.ts` `REQUIRED_SECTIONS`) **and** for freshness against
  source-state hashes (§2.1). Failures are reported, never thrown.
- Synthetic testing: `/guard simulate <remainingTokens>`, `--guard-synthetic`, or
  `CONTEXT_GUARD_SYNTHETIC_REMAINING` — thresholds must be provable without spending
  tens of thousands of real model tokens. Synthetic runs prove state-machine behavior,
  never real-token accuracy.

### 2.1 Checkpoint contents and freshness validation

A checkpoint rewrites the **managed blocks** of HANDOFF.md and PROGRESS.md (schema v3).
Each block embeds `checkpoint-schema: 3`, a **transactional identity**
(`checkpoint-generation`, monotonic `max(existing)+1`, no clock/no randomness; and
`checkpoint-id`, derived from generation + source fingerprint + session), `checkpoint-kind`
(`auto|manual`), `content-delta` (`initial|none|new`) and `readiness`, plus a
`checkpointed:` timestamp and **sha256 fingerprints of the relevant source state**: `source-goal`, `source-progress`,
`source-handoff`, `source-learnings`, `source-config`. PROGRESS/HANDOFF are fingerprinted
as *manual prose only* (their managed blocks stripped before hashing); GOAL/LEARNINGS are
hashed whole; missing files and files containing nothing but managed blocks hash to
`"absent"`. This makes the fingerprint non-circular: no block ever hashes its own content,
so re-writing a checkpoint over unchanged prose preserves all source hashes.

Both blocks must prove they came from **one** operation: an interrupted two-file write, an
obsolete generation, a forged id, a missing twin or disagreeing readiness lines make the
checkpoint `stale` with `partial: true` — never `current` (Phase 1c repro: two checkpoints
over unchanged source state had byte-identical hashes, so an interrupted second write
looked current).

Automatic checkpoints (level ≥ 3, no notes) **preserve** the previous block's substantive
`### Last verified state` and `### Guard notes` bodies; generic guard text never overwrites
a real summary (Phase 1b information-loss bug).

`validateCheckpoint()` classifies the durable checkpoint into exactly one of:
- **missing** — no managed block in HANDOFF.md;
- **corrupt** — block present but structurally invalid (no `checkpointed:` timestamp,
  unsupported `checkpoint-schema`, missing/garbage source hashes);
- **stale** — structurally valid but a fingerprint differs from the current files
  (`changed` names the sources), *or* an unversioned legacy block whose freshness is
  unverifiable (`legacy: true`);
- **current** — schema-**v3** block whose source hashes match the files, whose PROGRESS.md
  twin block is in sync, and whose transactional identity is consistent. (Schema **v2**
  is the historical Phase 1b format — source hashes but no identity: it validates as
  `stale` with `legacyIdentity: true` until refreshed by `/handoff`; unversioned v1
  blocks are `stale` with `legacy: true`.)

Precedence on recovery (Phase 1b fix): **manual prose always wins.**
`readRecoveryBundle()` returns `nextActionSource: "handoff-prose"` when a manual
`## Next action` section exists; the checkpoint block supplies the next action only when
no manual section exists and the block is verified *current*; a stale block is a
last-resort, clearly-labelled fallback (`"stale-checkpoint"`).

Technical currency is **not** handoff completeness. `evaluateHandoffReadiness()` reports
blocking checks (`checkpoint-current`, `identity-consistent`, `next-action-recorded` —
placeholders and block-only next actions fail) and warnings (`content-delta=none`,
`learnings-updated`: LEARNINGS.md unchanged since session start). `attestHandoff()` rewrites
only the readiness lines of both blocks in one operation, bound to the current
`checkpoint-id`; it refuses (zero writes) unless every blocking check passes, and is a
reported dry run in audit mode. `renewAuthorization()` is the Phase 2 gate: current ∧
identity-consistent ∧ attested. A new generation resets readiness to unattested.

Validation is read-only and never "fixes" anything: a stale checkpoint is reported
(session_start warning + `/guard status` + `/handoff verify`) and must be refreshed
explicitly via `/handoff`, which rewrites only managed blocks and preserves all
hand-authored text byte-for-byte. Conflicts between managed blocks and manual prose are
resolved in favour of the prose, never by overwriting discoveries.

### 2.2 Runtime state

Guard state is persisted to **per-session files** `<stateDir>/sessions/<sessionId>.json`
(schema version 2, atomic writes): sessions cannot overwrite each other's runtime state.
The state file also carries the audit fields `checkpointId`, `handoffReady` and
`learningsHash` (the LEARNINGS.md baseline for the readiness warning).
Retention: `maxSessionStates` defaults to **0 = pruning disabled** — without OS-level
process liveness, deleting another session's state while that process is still running is
unsafe; when opted in, only foreign files older than the `updatedAt`/mtime age floor
(1 h) are pruned (current session never pruned; durable checkpoints are markdown files and
are never pruned). Migration of the legacy single-slot `state.json` (version 1): on load, the
legacy file is attributed to the `sessionId` it names and reconciled
**newest-`updatedAt`-wins** against the per-session file, so a still-running v1 writer
cannot lose its snapshot; a foreign owner's state is preserved under its own name and
never applied to another session.

### 2.3 Read-only audit mode

Three different things must not be conflated:
1. **A model instructed not to edit project files** — behavioral guidance only; nothing
   prevents the *runtime* (pi itself, extensions, tools) from writing.
2. **An extension that still writes runtime state** — before Phase 1b, the guard wrote
   `.pi-guard/state.json` on every evaluation even in "read-only" audit sessions, and
   Pi auto-loads it from `.pi/extensions/` once the project is trusted, so an audit
   session was never mutation-free just by instruction.
3. **A genuinely immutable snapshot** — only an OS-level guarantee (read-only bind
   mount, snapshot volume, permissions). The guard does not and cannot provide this; it
   is out of Phase 1 scope.

Audit mode (`readOnly: true` / `CONTEXT_GUARD_READONLY=1` / `--guard-readonly 1`) gives
the strongest guarantee the extension itself can offer: **zero writes inside the project
 tree** — no checkpoints (auto and `/handoff` become reported dry runs), no managed-block
 stamps; monitoring, alerts, enforcement and GOAL protection stay active. Runtime state
may still persist only if `stateDir` resolves **outside** the audited directory
(`CONTEXT_GUARD_STATE_DIR=/some/other/path`). Containment is realpath- and `..`-aware
(`isInsideTree`): a sneaky `../<name>/.pi-guard` or a tree-resident symlink to an external
directory is still part of the audited tree.

Audit mode also makes runtime-state loading **inspection only** (`inspectGuardState` via
`loadGuardState(…, { readOnly: true })`): no quarantine of corrupt files, no legacy
migration, no temp-file cleanup inside the tree — and every repair that was suppressed is
reported. With an external stateDir the tree's stale `.pi-guard/` is not the guard's state
directory at all, so nothing there is inspected, claimed or changed (verified on real
filesystems: `test/audit-tree.test.ts` A1/A2/A4/A5, `scripts/e2e-rpc-two-process.mjs`). Pi's own session transcripts live under
`$PI_CODING_AGENT_DIR`, not the project tree; an OS-level snapshot remains the only
full-immutability option (hence "audited tree", not "audited universe").

## 3. Recovery after interruption

1. Crash/interruption leaves `sessions/<id>.json` possibly truncated. On `session_start`
   the guard quarantines **that session's** corrupt state to
   `sessions/<id>.json.corrupt-<ts>.bak` (other sessions' files are never touched),
   removes stale `*.tmp-*` files, and starts a fresh machine (safe default, alerts
   re-armed). Legacy `state.json` is migrated/reconciled as in §2.2.
2. A fresh session follows `HANDOFF.md` → `PROGRESS.md` → `GOAL.md` and runs the test
   suite before doing anything else. Manual prose wins over the managed checkpoint block
   (§2.1); a stale/corrupt/missing checkpoint is announced at session_start so the agent
   knows the block may be behind the prose.
3. If GOAL.md changed since the guard's baseline hash, a goal-drift warning is issued;
   the human decides. The guard never rewrites the goal.

## 4. Knowledge and evidence classification (`LEARNINGS.md`)

- **Accepted** — verified against installed sources/tests; safe to rely on.
- **Proposed** — promising but unverified or unadopted; carries evidence, expected
  value, cost, confidence. Proposals are *not* rules.
- **Falsified or superseded** — mistakes and disproven hypotheses; kept for context.
- Promotion of a proposal to an accepted procedure requires: reproduction steps run in
  this environment, evidence recorded, and explicit adoption noted. Nothing is promoted
  silently. LEARNINGS.md is not a transcript summary: only durable, reusable knowledge.

## 5. Initiative

Agents may investigate beyond the immediate objective when justified: time available
(check level 1–2 headroom), plausible value, and reversibility. Every such exploration
ends as a `Proposed` entry with evidence/value/cost, or a `Falsified` entry. Scope creep
into a general orchestration framework is out of contract.

## 6. Renewal contract (Phase 2 — IMPLEMENTED and live-proven: increments A+B+C, LEARNINGS A-23)

Renewal policy lives in `renewal.ts` (pure) + `handoff.config.json` `renewal`
(`enabled` default **false**, `autoRenew` default **false**, `maxRenewals` default 2,
`recoveryPrompt` override). Chain state (`chainId`, `renewalsDone`,
`renewedFromCheckpointId`, `stopped`) persists at `<stateDir>/renewal-state.json`: it survives
session replacement and process restart, bounds the chain, makes each checkpoint seed
at most one successor (idempotence), and carries the durable operator stop.
`decideRenewal()` refuses with a named reason in precedence order
(stop > read-only > disabled > auto-disabled > pending > capped > not-authorized >
already-renewed); the authorization input is `renewAuthorization()` (current ∧
identity-consistent ∧ attested). `buildRecoveryPrompt()` is deterministic: a mandatory
identity header (renewal index, parent/chain/checkpoint ids, no-replay/no-compaction
contract), then the project recovery body — the GENERIC one names ONLY durable files
(AGENTS/PROTOCOL/GOAL/HANDOFF/PROGRESS/LEARNINGS), or the configured
`renewal.recoveryPrompt` verbatim — then a build-verify line ONLY when
`renewal.testCommand` is explicitly configured (the dev.1 hardcoded `node --test test/`
was removed, LEARNINGS A-26), then the mandatory safety trailer (initiative,
never-push). No transcript replay, no LLM summarization, no compaction.

`renewal.enabled` and `renewal.autoRenew` mean DIFFERENT things: `enabled` switches the
whole mechanism on (operator `/handoff renew` becomes possible); `autoRenew` *additionally*
authorizes the **model-initiated** path — the `handoff_renew` tool and the
`RENEWAL AVAILABLE` hint (surfaced at level ≥ 3 only when enabled ∧ autoRenew ∧ no
operator stop ∧ no pending renewal). **Pressure alerts alone never force a transition**;
transition always requires a gate pass and an explicit trigger (command or tool call).
The `handoff_renew` tool is registered whenever the guard loads, but its pre-gate refuses
cheaply (zero writes, no schedule) unless the policy allows model renewal; during enforced
level-4 closing it is callable only if listed in `closingAllowlist`.

Live-proof scope (A-23, stated precisely): the real-inference experiment verified
**one** model-initiated renewal followed by **one** operator-initiated renewal (third
attempt refused at the cap) — not two independently spontaneous renewals. Generalized
concurrent renewal safety is NOT proven (P-5; only the specific two-process invariants of
A-16 were tested).

The switch (increments B+C, implemented; proven live A→B→C with real inference) follows this contract:

- Triggered explicitly (`/handoff renew`, operator command context) — never while a
  tool call is in flight; the guard waits via `waitForIdle()`. A model-initiated path
  (P-8) may only DISPATCH the command fire-and-forget (deadlock rule, A-19).
- The successor starts with a **fresh, empty transcript**. What crosses the boundary is
  only: Pi's own project context (AGENTS.md auto-loaded as a context file), the
  runtime-derived identity banner, and the deterministic recovery instruction (a custom
  message carrying predecessor notes when given) that NAMES the six durable files
  (AGENTS/PROTOCOL/GOAL/HANDOFF/PROGRESS/LEARNINGS) plus the test command. The files'
  **contents are not transferred** — the successor reads them itself afterwards (proven
  in A-23: the successor's first action was reading all six). The predecessor transcript
  is not carried over; no lossy compaction is used.
- Implementation must use Pi's verified replacement path
  (`ctx.newSession({parentSession, withSession})`); the old extension context is invalid
  after replacement, so only plain data crosses the boundary (A-17.5).
- Renewal must be cancellable (`/handoff renew stop` → `session_before_switch`
  `{cancel:true}` for GUARD-pending switches only) and must append an audit entry
  naming the checkpoint id it transitioned from; the successor records the lineage
  (`previousSessionFile`) in the durable renewal state.

## 7. Invariants

- No automatic compaction; no `ctx.compact()` calls.
- Stable system prompt: the guard never returns `systemPrompt` overrides and never uses
  `context_with_system`; transcript changes are append-only deltas (cache-friendly).
- No third-party installs. The guard's own writes stay inside this project directory,
  with exactly one sanctioned exception: its runtime state (per-session files + renewal
  chain state) persists under `stateDir` — `.pi-guard/` inside the tree by default, but
  deliberately OUTSIDE it when `stateDir` / `CONTEXT_GUARD_STATE_DIR` names an external
  path (required for zero-write audit mode; containment is realpath-checked, §2.3).
  Nothing else is ever written outside the tree by the guard. Separately, **Pi itself**
  persists session transcripts under `$PI_CODING_AGENT_DIR` — that is Pi's storage, not
  guard activity, and it continues even in read-only audit sessions (§2.3).
- The unit suite (`node --test test/`) runs with mocked Pi events and synthetic budgets
  only — zero inference. Real-runtime verification uses the zero-inference scripts
  (`scripts/e2e-rpc-two-process.mjs`, `scripts/check-skill-discovery.mjs`). The ONLY
  script that spends real inference is the explicit renewal-chain proof
  `scripts/e2e-renew.mjs` (LEARNINGS A-23), re-run solely after changes to the renewal
  wiring in `index.ts`. Mock-only tests once masked a real-runtime crash (A-9) and a
  module-load failure (A-15): a green suite never substitutes for a real-runtime load.
