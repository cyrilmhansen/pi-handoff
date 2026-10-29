# PROTOCOL.md — durable working protocol

The single source of procedure. Working files reference this; they do not duplicate it.

## 1. Context thresholds

Measured as **remaining usable context**:
`remaining = contextWindow − estimatedTokensUsed − max(modelMaxTokens, safetyReserve)`.
Estimation comes from Pi's `ctx.getContextUsage()` (see README §verified API); it is an
estimate, so thresholds are advisory budgets, not guarantees.

| Level | Remaining (default) | Class | Meaning |
|---|---|---|---|
| 1 | ≤ 30 000 | advisory | checkpoint: update PROGRESS.md (completed, blockers, exact next action) |
| 2 | ≤ 20 000 | advisory | finish the current substantial task; do not open new work |
| 3 | ≤ 10 000 | advisory | prioritize durable handoff: write HANDOFF.md before anything else |
| 4 | ≤ 5  000 | **enforced** | controlled closing: only allowlisted tools (write/edit/read) run; finish checkpoints and stop |

Configuration: `handoff.config.json` (`thresholds`, `enforceClosing`, `closingAllowlist`,
`generationReserve`, `safetyReserve`, `protectGoal`, `maxConsecutiveUnknown`, `stateDir`,
`readOnly`, `maxSessionStates`).
Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<n>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>`; CLI flags `--guard-synthetic <n>`, `--guard-readonly <1>`.

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

A checkpoint rewrites the **managed blocks** of HANDOFF.md and PROGRESS.md (schema v2).
Each block embeds `checkpoint-schema: 2`, a `checkpointed:` timestamp, and **sha256
fingerprints of the relevant source state**: `source-goal`, `source-progress`,
`source-handoff`, `source-learnings`, `source-config`. PROGRESS/HANDOFF are fingerprinted
as *manual prose only* (their managed blocks stripped before hashing); GOAL/LEARNINGS are
hashed whole; missing files and files containing nothing but managed blocks hash to
`"absent"`. This makes the fingerprint non-circular: no block ever hashes its own content,
so re-writing a checkpoint over unchanged prose preserves all source hashes.

`validateCheckpoint()` classifies the durable checkpoint into exactly one of:
- **missing** — no managed block in HANDOFF.md;
- **corrupt** — block present but structurally invalid (no `checkpointed:` timestamp,
  unsupported `checkpoint-schema`, missing/garbage source hashes);
- **stale** — structurally valid but a fingerprint differs from the current files
  (`changed` names the sources), *or* an unversioned legacy block whose freshness is
  unverifiable (`legacy: true`);
- **current** — schema-v2 block whose source hashes match the files and whose PROGRESS.md
  twin block is in sync.

Precedence on recovery (Phase 1b fix): **manual prose always wins.**
`readRecoveryBundle()` returns `nextActionSource: "handoff-prose"` when a manual
`## Next action` section exists; the checkpoint block supplies the next action only when
no manual section exists and the block is verified *current*; a stale block is a
last-resort, clearly-labelled fallback (`"stale-checkpoint"`).

Validation is read-only and never "fixes" anything: a stale checkpoint is reported
(session_start warning + `/guard status` + `/handoff verify`) and must be refreshed
explicitly via `/handoff`, which rewrites only managed blocks and preserves all
hand-authored text byte-for-byte. Conflicts between managed blocks and manual prose are
resolved in favour of the prose, never by overwriting discoveries.

### 2.2 Runtime state

Guard state is persisted to **per-session files** `<stateDir>/sessions/<sessionId>.json`
(schema version 2, atomic writes): sessions cannot overwrite each other's runtime state.
Retention: the `maxSessionStates` most recently updated foreign session files are kept
(current session never pruned; durable checkpoints are markdown files and are never
pruned). Migration of the legacy single-slot `state.json` (version 1): on load, the
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
(`CONTEXT_GUARD_STATE_DIR=/some/other/path`). Pi's own session transcripts live under
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

## 6. Renewal contract (Phase 2 — future, not yet active)

When checkpoint + recovery tests pass in real sessions, a fresh-session renewal may be
added with this contract:

- Triggered explicitly (`/handoff --renew`) or at enforced level 4 after a successful
  checkpoint — never while a tool call is in flight; the guard waits via `waitForIdle()`.
- New session receives ONLY: AGENTS.md (auto context file) + GOAL.md + latest HANDOFF.md
  + PROGRESS.md. The transcript is not carried over; no lossy compaction is used.
- Implementation must use Pi's verified replacement path
  (`ctx.newSession({parentSession, withSession})` / `switchSession`); the old extension
  context is invalid after replacement, so only plain data crosses the boundary.
- Renewal must be cancellable and must append an audit entry naming the checkpoint hash
  it restored from.

## 7. Invariants

- No automatic compaction; no `ctx.compact()` calls.
- Stable system prompt: the guard never returns `systemPrompt` overrides and never uses
  `context_with_system`; transcript changes are append-only deltas (cache-friendly).
- No third-party installs; no writes outside this project directory by the guard.
- Tests run with mocked Pi events and synthetic budgets only (no paid inference).
