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
flags a reserve above 25 % of the window. `/guard status` additionally prints the
escalation crossings in estimated used tokens (dev.2 D6, pure `crossingPoints`:
window − reserve − threshold, identical to the live budget arithmetic) with live reserve
provenance, the enforced/advisory kind under the CURRENT closing policy, a "too tight"
flag for crossings ≤ 0, and the honest statement that the guard never changes the model
window (it belongs to the model/provider). Example profiles: `docs/profiles/`.
Estimation comes from Pi's `ctx.getContextUsage()` (see README §verified API); it is an
estimate, so thresholds are advisory budgets, not guarantees.

| Level | Remaining (default) | Class | Meaning |
|---|---|---|---|
| 1 | ≤ 30 000 | advisory | inspect with `handoff_inspect`; update durable progress if needed. Checkpoint writes/attestation are operator slash commands, not Bash commands |
| 2 | ≤ 20 000 | advisory | finish the current substantial task; do not open new work |
| 3 | ≤ 10 000 | advisory | prioritize durable handoff: preserve evidence and update HANDOFF.md; inspect renewal readiness before choosing how to close |
| 4 | ≤ 5  000 | **enforced** (advisory when `enforceClosing:false`) | controlled closing: only tools in `closingAllowlist` run (default `write/edit/read`; renewal-enabled projects add `handoff_renew` so the model can still renew during closing). Finish bounded work; when the objective remains active and the tool is permitted/preparable, request `handoff_renew` at a safe boundary. Use `handoff_finalize` and stop only for intentional non-renewing closure or a terminal refusal. With enforcement off the alert says so explicitly and blocks nothing — the alert text always matches live policy (dev.2 D5a) |

Configuration: `handoff.config.json` (`thresholds`, `enforceClosing`, `closingAllowlist`,
`generationReserve`, `safetyReserve`, `protectGoal`, `maxConsecutiveUnknown`, `stateDir`,
`readOnly`, `maxSessionStates`, `renewal` — Phase 2 policy block, see §6).
Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<n>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>`, `CONTEXT_GUARD_AUTO_RENEW=1|0` (force-enable/disable
the renewal policy for this process), `GUARD_VERSION=<string>` (banner version override
for probes/forensics); CLI flags `--guard-synthetic <n>`, `--guard-readonly <1>`.

Alert semantics:
- One alert per threshold crossing per session (even if headroom later returns).
- Several crossings in one step are combined into one message.
- Alerts are appended as custom transcript messages with `triggerTurn:false`, i.e. they
  never interrupt an in-flight tool call, and they never modify the system prompt.
- If measurements are unavailable for `maxConsecutiveUnknown` evaluations, the guard
  reports "degraded" and holds the last known level (fail-safe: enforcement is never
  silently released by missing data).

Advisory vs enforced: levels 1–3 change agent *guidance* only; level 4 blocks new
non-checkpoint tool calls (`tool_call` gate) when `enforceClosing` is true — and when it
is false the level-4 alert is worded as advisory and blocks nothing
(`defaultThresholds(t,{enforceClosing})`).. GOAL.md is
protected at all levels when `protectGoal` is true.

## 2. Checkpoint semantics

- Checkpoints are written by `/handoff checkpoint [notes]` (bare `/handoff` remains the
  no-notes compatibility form) or automatically once per escalation to level ≥ 3. They
  update **managed sections only** (`<!-- guard:begin ... -->` blocks) of
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

A checkpoint generation writes the **managed blocks** of HANDOFF.md and PROGRESS.md (schema v3).
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

The runtime reuses an already-current identity when a checkpoint request adds no
`Guard notes`; automatic threshold crossings also reuse it while source fingerprints and
twin blocks remain current. This avoids two managed-file writes and a new unattested
generation for identical state. Stale/missing/corrupt checkpoints or substantive new
notes still create a fresh generation. If the current identity was consumed, only its
recorded successor may create a fresh generation (including `content-delta: none`) to
continue; a no-note request from the predecessor or another session reuses the existing
identity without writes. A repeated valid attestation is also a no-op and preserves its
original attestation bytes.

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
Repeating `/handoff ready` on a current, already-attested checkpoint leaves both the
managed blocks and runtime state untouched.

Validation is read-only and never "fixes" anything: a stale checkpoint is reported
(session_start warning + `/guard status` + `/handoff verify`) and must be refreshed
explicitly via `/handoff`, which rewrites only managed blocks and preserves all
hand-authored text byte-for-byte. Conflicts between managed blocks and manual prose are
resolved in favour of the prose, never by overwriting discoveries.

Correctly formed schema-v3 checkpoints remain compatible without migration. Semantic
validation is also required: a historical v3 block whose saved `Next action` disagrees
with the unique real manual heading is stale for authorization even when its source hashes
match. Inspect with `handoff_inspect` (agent) or `/handoff verify` (operator), confirm the
manual action, refresh with `/handoff`, then attest with `/handoff ready`; confirm the
reported action before renewal. Never hand-edit managed blocks or treat the old attestation
as valid merely because its hashes match.

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

## 6. Renewal contract (default custom-turn path live-proven; `user` turn remains experimental)

The model-callable `handoff_inspect` tool and operator `/handoff status`, `/handoff verify`,
and `/guard verify-checkpoint` share the same read-only inspection path. It reports
checkpoint freshness, identity, attestation, action validation, changed sources, and the
model renewal gate as ready-now, preparation-required, or refused. Inspection does not
write project/state files or mutate checkpoint, attestation, chain, or stop state; it
does not verify scientific claims. Pi slash commands are operator interface commands,
not shell commands available to the model.
On a healthy, attested checkpoint, `handoff_inspect` returns a concise summary by default;
pass `{ "details": true }` for the full report. Anomalies always include the detailed
reason. `git status` and `git diff` remain the source of truth for worktree state; an
attested checkpoint says nothing about whether software work was committed, validated,
or published.

Renewal policy lives in `renewal.ts` (pure) + `handoff.config.json` `renewal`
(`enabled` default **false**, `autoRenew` default **false**, `maxRenewals` default 2,
`recoveryPrompt` override, `recovery` policy block — dev.2 D4 lean tiers, see below). Chain state (`chainId`, `renewalsDone`,
`renewedFromCheckpointId`, `stopped`) persists at `<stateDir>/renewal-state.json`: it survives
session replacement and process restart, bounds the chain, makes each checkpoint seed
at most one successor (idempotence), and carries the durable operator stop.
The recorded successor (`lastSuccessorSessionId`) may make an explicit later renewal
request against an unchanged inherited checkpoint: Handoff creates a new generation
with `content-delta: none`, attests it, and rechecks the same stop/cap/read-only/pending
gates before dispatch. The consumed checkpoint ID is never reused, and ordinary status
or inspection never creates this generation.
`decideRenewal()` refuses with a named reason in precedence order
(stop > read-only > disabled > auto-disabled > pending > capped > not-authorized >
already-renewed); the authorization input is `renewAuthorization()` (current ∧
identity-consistent ∧ attested). `buildRecoveryPrompt()` is deterministic: a mandatory
identity header (renewal index, parent/chain/checkpoint ids, no-replay/no-compaction
contract), then the project recovery body — the GENERIC one names ONLY durable files
(AGENTS/PROTOCOL/GOAL/HANDOFF/PROGRESS/LEARNINGS), or the configured
`renewal.recoveryPrompt` verbatim — then a build-verify line ONLY when
`renewal.testCommand` is explicitly configured (the dev.1 hardcoded `node --test test/`
was removed, LEARNINGS A-26), then an optional operator mission in its own
provenance-labelled section (before the mandatory safety trailer), separate from the
durable Next action and predecessor notes. It is never copied to managed checkpoint
blocks or diagnostics. It does not authorize protected-goal edits, evidence
reclassification, protocol bypass, push, or chain reset. No transcript replay, LLM
summarization, or compaction.

Operators may supply that mission on the explicit command invocation as
`/handoff renew --task "short mission"` or `/handoff renew --task-file path/to/mission.md`.
The file is read only, relative to the project root, after lexical and realpath checks;
path traversal and symlinks resolving outside the project are refused. The mission limit
is 64 KiB UTF-8, with a direct error before checkpoint writes or session replacement.
Task content remains in the command invocation and successor prompt; it is not checkpoint
notes, predecessor notes, a durable-file update, or diagnostic data. A refusal or
`newSession` cancellation sends nothing to a successor and does not persist/consume the
mission. File task content is read, never executed.

`renewal.successorTurn` selects the first-turn trigger (`"custom"` by default, preserving
the existing behavior; experimental `"user"` is opt-in). User mode appends a structured,
non-triggering extension-origin marker, then calls `ReplacedSessionContext.sendUserMessage`
once with the recovery instruction and optional task. The visible message says it was
generated by Handoff and not typed by a human; its user role adds no authorization. No
custom `triggerTurn: true` is sent in that mode. A dispatch failure is reported and never
falls back to a second trigger.

`renewal.enabled` and `renewal.autoRenew` mean DIFFERENT things: `enabled` switches the
whole mechanism on (operator `/handoff renew` becomes possible); `autoRenew` *additionally*
authorizes the **model-initiated** path — the `handoff_renew` tool and the
`RENEWAL AVAILABLE` hint (dev.2 D5b: surfaced at level ≥ 3 ONLY when a full WRITE-FREE
PREVIEW of the real gate passes — `decideRenewal` with the live checkpoint identity,
`renewAuthorization()`, durable stop, cap, read-only and pending state, zero writes;
otherwise the alert carries `RENEWAL NOT AVAILABLE (<reason>)` plus concrete safe
instructions, including `handoff_finalize` at the cap — never a promise the gate would
break) ∧ no pending renewal). **Pressure alerts alone never force a transition**;
transition always requires a gate pass and an explicit trigger (command or tool call).
The `handoff_renew` tool is registered whenever the guard loads, but its pre-gate refuses
cheaply (zero writes, no schedule) unless the policy allows model renewal; during enforced
level-4 closing it is callable only if listed in `closingAllowlist`.

**Structured diagnostics (dev.2 D5c)** persist a bounded, typed trail at
`<stateDir>/diagnostics.jsonl` (JSONL, ISO+epoch; types `session_start`, `alert`,
`revocation`, `renewal_request`, `renewal_result`, `finalize`, `tool_block`,
`turn_aborted`; allowlisted fields only — NEVER prompts, tool arguments or secrets;
rotation keeps the last ~500 entries; read-only audit mode records NOTHING with an
in-tree `stateDir` and persists only under an external one — the §2.3 rule). `agent_settled.aborted`
is the interruption signal: it is RECORDED for later attribution, and the guard NEVER
retries an aborted generation automatically (P-10 constraint). `/guard events [n]` shows
the tail. The identity banner carries `GUARD_VERSION` (env-overridable) instead of any
hardcoded milestone label (P-9).

**Finalization (dev.2 D2)** is independent of the renewal contract: `/handoff finalize
[notes]` (operator) and the `handoff_finalize` tool (model) run refresh + readiness
evaluation + attestation in ONE synchronous step, reusing `writeCheckpoint` /
`attestHandoff`. It works with renewal disabled, capped or durably stopped; it never
switches sessions, never writes chain state (cap/idempotence/stop byte-identical), never
calls `waitForIdle` (deadlock-free by construction), never bypasses readiness, and is
idempotent. Read-only mode: reported dry run, zero tree writes. During enforced closing
`handoff_finalize` is implicitly permitted (managed-block writes only — weaker than the
default-allowed `write`); `handoff_renew` remains allowlist-gated because it schedules a
switch. At the exhausted cap, finalization is the safe closing path; raising the cap or
resetting chain state stays an explicit operator decision.

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
- E2E test artifacts (D7): every temp workspace created by the out-of-band scripts is
  registered with `scripts/lib/e2e-cleanup.mjs` AT creation and removed on success,
  failure, timeout, setup error and SIGINT/SIGTERM/SIGHUP; tracked child processes are
  shut down before their workspaces are deleted. `GUARD_E2E_KEEP=1` is the only
  retention value; removal covers ONLY the exact directories the same invocation
  created — no global `/tmp/guard-*` sweeper ever (a sweeper could destroy a
  concurrent run's artifacts or retained forensics). SIGKILL and machine crashes are
  NOT coverable by in-process code and may leave artifacts (stated honestly, never
  "guaranteed").

## 8. Durable document maintenance

`scripts/durable_edit.py` is the optional, agent-callable section editor and read-only
inventory. Use `audit --root .` to identify the active HANDOFF next action, duplicate or
historical operational headings, possible HANDOFF/PROGRESS action conflicts, missing
archive references and document/recovery-cost estimates. It can report `NO CHANGE`; it
never consolidates or writes during an audit. These findings are heuristics for review,
not authority to change a plan.

For structured edits, preview with `plan` or `archive-plan`, inspect the diff, then apply
with the exact source hash (and archive hash for a move). The utility refuses ambiguous
or stale targets, preserves non-target content and does not write checkpoint-managed
blocks. A prose edit to HANDOFF/PROGRESS makes checkpoint freshness stale; refresh and
attest through the guard only after reviewing the result. Historical predictions,
disconfirming observations and subsequent operator decisions stay separate and traceable.

Keep four reports distinct: manual prose and managed blocks are separate file regions;
`handoff_inspect` reports verified checkpoint identity/freshness/attestation; `git status`
and staged/unstaged `git diff` report actual local worktree state. An attested checkpoint
does not mean software work is committed, validated or published. Audit does not infer
scientific correctness, authorize consolidation, modify GOAL.md or alter the renewal
chain. For archival and strategy pivots, the operator-approved process in the skill's
`references/consolidation.md` still applies.

## 9. Supervised documentation cycles (Lot E)

The optional campaign-boundary workflow is controlled by `documentation.enabled`
(default `false`) and is distinct from the renewal chain. `/handoff cycle plan` requires
an explicitly configured, capped development chain plus a current, attested checkpoint;
it opens one fresh read-only planning context and records its base Git revision and
source fingerprints. The mission writes only a bounded plan artifact. Operator approval
must name its exact SHA-256, and approval is refused if the source fingerprint, protected
GOAL fingerprint, Git revision, plan metadata, or plan bytes no longer match.

Only `/handoff cycle apply` after approval opens an application context. It must use
`scripts/durable_edit.py` for approved edits and archives. Application is not automatic;
crashes or uncertain dispatches retain their stage marker and require explicit
inspection, correction or abort. `/handoff cycle review` opens a separate fresh context;
its report is bound to the review revision/fingerprint and exact report hash. A passing
document review does not attest scientific claims. `NO_CHANGE` is an explicit plan result
and can skip apply/review without changing documents.

Only the separate operator command `/handoff cycle continue`, after a passing review or
an approved `NO_CHANGE`, archives the old renewal-state bytes in the configured in-project
archive and initializes the next chain. It never starts a new session, deletes session
history, or cleans artifacts. A crash during this multi-write transition leaves a journal
and preserved source state; retry is explicit and validates the journal/archive before
finishing. Repeated or concurrent stage commands cannot dispatch twice. `/handoff cycle
status` is read-only, and `/handoff cycle recover <token>` clears only the displayed
stale transition lock; it never replays a stage. Slash commands remain Pi operator
commands, not Bash commands.

## 10. v0.1.0-dev.4 release boundary

Lots A–E are available together in this development version. `renewal.successorTurn`
defaults to `"custom"`; `"user"` is an opt-in experiment, not a measured improvement.
`documentation.enabled` defaults to `false`; documentary stages and the new-chain
transition require explicit operator commands. Authority is provenance-bound: operator
commands, agent-callable tools and extension-generated messages are separate. Neither a
generated custom turn nor a generated user-role turn grants operator approval or extra
authority. Handoff does not automatically migrate, rewrite, archive or clean scientific
evidence, claims ledgers, session history or other project state.

The deterministic suites and Rune CI passed for their respective lot commits. The real
Sushi custom-versus-user A/B and a complete documentation-cycle workflow using real
inference were not run; their outcomes remain unverified. No inference test is part of
the dev.4 release validation.

## 11. Mission instances (Lot F)

Project state is shared; mutable mission progress belongs to one explicitly selected
mission instance. Create one with `/handoff instance create <id> [--profile <id@version>]`.
The command creates an identity manifest and empty operational documents under
`.pi-handoff/instances/<id>/`; it copies no root documents and does not migrate existing
state. Select a created instance for a Pi process with
`CONTEXT_GUARD_MISSION_INSTANCE=<id>` or `missionInstance.id` in the project config.
Selection is read at session start; an existing context never switches instances in
place. The per-process environment selector permits two Pi processes in one checkout to
use different instances without changing a shared active pointer.

Instance-owned documents are `HANDOFF.md`, `PROGRESS.md` and `LEARNINGS.md`; its
checkpoint identity is namespaced by instance, and guard sessions, renewal chain and
documentation-cycle state use `.pi-guard/instances/<id>/`. `GOAL.md`, `AGENTS.md`,
`PROTOCOL.md`, code and canonical scientific evidence remain project-shared. Instance
findings are not automatically published to those shared sources. An optional work
profile is a versioned JSON config at
`.pi-handoff/work-profiles/<id>/<version>.json`, containing its matching schema/id/version
plus `instructions` and `knowledgeRefs` string arrays. The identity banner names the
profile for the agent to read; Handoff does not inject its text or grant it operator
authority. No profile publication or knowledge merge is performed.

The instance ID is restricted to safe path characters. Startup verifies the manifest
and that the storage path resolves within the project; invalid selection disables
project-tree writes and renewal rather than falling back to shared files. With no
instance ID selected, legacy project-root files and the configured `.pi-guard` path are
unchanged. Creating or changing a mission instance is separate from renewing a session
or resetting a renewal chain. A checkpoint attests recovery state only; it is not
scientific validation or knowledge publication.

## 12. Mission-instance process ownership (Lot G)

An explicitly selected mission instance has one Handoff writer per Pi OS process. At
`session_start`, after validating the instance manifest and path but before session,
checkpoint, attestation, renewal or document-cycle state can be persisted, the extension
creates `.pi-handoff/instances/<id>/.owner.lock` with exclusive file creation. The lock
records a random owner token, PID, host, platform, Pi session ID and process start identity
when Linux exposes it. A process keeps the same lock across successor sessions. Every
Handoff-controlled write checks that the lock still contains the process's own token and
PID. On normal process exit, Handoff removes it only if those values still match. A Pi
session shutdown alone does not release process ownership.

If another Pi process owns the selected instance, the new process stays read-only for
Handoff. Checkpoint writes, attestations, renewals and documentation-cycle transitions
are refused. The owner PID/host/session is shown only when valid lock metadata supplies
those values. `/handoff instance status` reports whether this process holds ownership.
Different instance IDs have different locks and may run concurrently. Legacy mode with no
selected instance has no new lock and retains its historical paths and behavior.

A crash leaves the owner file in place. Handoff never steals a lock based on age. On Linux,
`/handoff instance recover <id>` may remove it only when the local PID is demonstrably
absent or the PID's boot ID/process start ticks prove it has been reused. On macOS, a live
PID cannot be distinguished safely from a reused PID with Node's portable APIs, so a PID
that still exists is treated as possibly active. Corrupt metadata, a different host,
permission uncertainty or an interrupted `.owner.lock.recovery` claim also refuse automatic
recovery. If recovery refuses, stop/quiesce every Pi process that could select that ID,
confirm the intended host/processes are stopped, inspect the exact instance directory, then
remove only the abandoned `.owner.lock` and/or interrupted `.owner.lock.recovery` as an
explicit operator repair and restart Pi. Never remove a lock while its owner could still
run. Do not edit the lock while any process may be acquiring or recovering it.

The exclusion guarantee depends on the local filesystem honoring atomic `O_EXCL` creation
(for example, ordinary local APFS and Linux filesystems). Node documents weaker guarantees
on some network filesystems; Handoff does not claim cross-host/NFS safety. The lock covers
Handoff-controlled operations and Pi tools that this extension can intercept, including
its standard `bash`, `write` and `edit` gates for a losing instance process. It cannot
prevent arbitrary external programs, unrecognized third-party tools, or another checkout
from directly editing files. Keep the instance selection fixed for the whole Pi process;
changing it requires a restart. Ownership prevents concurrent Handoff authorization; it
does not attest external filesystem writers or scientific results.

## 13. Mission-instance closure (Lot H)

Closing an explicitly selected mission is a separate, terminal lifecycle operation. It is
not task completion, `/handoff finalize`, a Pi session renewal, a documentation-cycle
continuation, process shutdown, or a renewal-chain reset. Legacy mode without a selected
instance never seals project-root files.

Review `/handoff instance close plan` first. The read-only plan reports the retained
instance and state paths, current checkpoint and attestation, renewal-chain state,
documentation-cycle phase, blockers, and an approval fingerprint over the inspected
state. A normal close requires a current, attested checkpoint, but that attestation only
proves Handoff readiness; it is not evidence of scientific success or software
validation. A clean Git worktree is not required. Git revision is recorded for reference
and does not participate in approval. Confirm with
`/handoff instance close --confirm <fingerprint> --reason "..."`. Handoff rechecks the
fingerprint and blockers and requires this process to still own the Lot G lock.

The close record is created in place at
`.pi-handoff/instances/<id>/closure.json`; it records schema version, mission/profile
identity, operator reason, time and operation identity, SHA-256 hashes of mission and
instance state files, checkpoint identity/attestation, terminal renewal state, and the
informational Git revision. Files and histories are not moved, copied, deleted, or
rewritten. An exclusive pending marker plus same-filesystem atomic no-replace publication
prevents overwriting a prior seal. A crash or error that leaves `closure.pending`, an
incomplete/corrupt record, or another ambiguous state is **uncertain**: the instance is
read-only through Handoff. Preserve all bytes and inspect with
`/handoff instance close status`; do not delete markers or retry by assumption. Quiesce
all processes, make an external backup of both the instance and state directories, and
have an operator inspect the exact files before any manual repair. If a complete closure
record validates, all recorded hashes match, and the pending marker names the same
operation, an operator may explicitly complete sealing by removing only that matching
pending marker while all Pi processes are stopped; restart then reports `CLOSED`. If the
record is absent, malformed, mismatched or its hashes differ, do not infer that closing
was cancelled and do not clear the marker to reactivate the ID; preserve the backup and
continue under a new instance ID. Handoff has no automatic repair or reactivation path.

A valid closure permanently blocks Handoff mutations for that ID, including checkpoint,
attestation, renewal, chain state, document-cycle state, and instance creation/reuse.
Read-only inspection and audits remain available. `/handoff instance close status` checks
the recorded file hashes and reports missing or externally changed files. This is a
protocol guard, not filesystem immutability: external programs can still alter files, and
such changes are reported rather than repaired. To resume an old objective, create a new
instance ID and explicitly consult the old sealed record. New instances retain the
project's shared code, protocol and evidence access, but start with their own empty
operational documents and state; no Next action or LEARNINGS content is inherited.

## 14. Selective shared knowledge publication (Lot I)

Project knowledge is an append-only registry under `.pi-handoff/knowledge/`. An agent or
operator may prepare a bounded JSON proposal in `proposals/`; a proposal names one source
mission document and project-relative evidence files with raw-byte SHA-256 digests. Paths
must remain inside the project and may not traverse symlinks. Handoff verifies source and
evidence bytes, the selected mission/profile, its checkpoint or closure identity when
available, and the current registry before presenting a plan fingerprint. Planning and
all list/show/verify operations are read-only.

Only an operator slash command may publish, after confirming the exact plan fingerprint.
The project-wide publication lock is separate from each Lot G mission lock, so different
mission instances serialize writes to the shared registry. Publication rechecks the plan
under lock and creates one immutable record atomically without replacement. Identical
content is idempotent. A changed publication for the same logical ID requires an explicit
supersession relation and reason. Existing records, including `falsified` and superseded
records, remain unchanged and consultable. Handoff detects identity conflicts, not
scientific contradictions between different statements; those require human review.

Each record preserves the source mission and optional work profile, statement,
classification and rationale, source locator, evidence paths and hashes, checkpoint or
closure provenance, publication time, operator decision and publication fingerprint.
Evidence is referenced rather than copied. Classifications (`accepted`, `proposed`,
`falsified`, `superseded`) are documented decisions, not independent scientific
validation. A publication grants no operator authority and does not edit `GOAL.md`,
scientific ledgers, mission documents or `Next action`. The registry is not injected into
new-session context; no proposal is promoted or published automatically. Sealed missions
may be cited without being modified. Legacy operation without an explicitly selected
mission cannot publish.

The registry lock coordinates cooperating Handoff processes in one local project tree;
network filesystems and separate checkouts are outside the guarantee. A potentially
abandoned lock requires explicit inspection and recovery after proving its owner absent;
recovery never retries a publication. Interrupted temporary artifacts are preserved and
reported for operator inspection; their presence blocks further publication until an
operator has backed up and explicitly inspected/resolved the artifact. Corruption,
unknown registry files and uncertain publication state fail closed. No automatic
migration, cleanup, evidence rewrite or scientific-state change occurs.

## 15. Pre-deployment restore qualification (Q1 historical finding)

**Q1 snapshot only: deployment status was BLOCKED by a measured renewal-state restore defect.** The renewal
decision currently treats an absent `<stateDir>/renewal-state.json` as an initial chain;
malformed JSON also parses to an initial state, and the renewal execution path does not
refuse on the returned `corrupt` flag. If a current, attested checkpoint remains, a
checkout-only restore can therefore forget `renewalsDone`, `renewedFromCheckpointId` and
`stopped`, and the real Pi inspection path reports renewal as ready. See
`docs/qualification/predeploy-a-i.md` and its Q1 reproducers. Do not continue an existing
mission after detecting missing/corrupt chain state, and do not infer that a green unit
suite resolves this finding.

For a coherent recovery, quiesce all Pi processes and preserve the project tree plus the
entire configured `stateDir` (inside the project by default, external when configured).
Pi session transcripts are stored separately and are neither read nor replayed by
Handoff. They may be retained for forensic recordkeeping but do not reconstruct renewal
authority. A Git-only checkout is not a complete operational restore. Until a
fail-closed correction and requalification land, an ambiguous old chain must remain
blocked; do not synthesize a zero-count state or reuse its checkpoint. Start a genuinely
new, explicitly approved mission only under a new mission ID after its operational and
transactional state is initialized separately.

The text above records the pre-correction Q1 behavior. Section 16 documents the Q2
correction and current refusal/bootstrap rules.

## 16. Q2 fail-closed renewal-state recovery

Q2 supersedes Q1's observed behavior; Q1 remains the historical defect record. Renewal
state has an explicit `valid | missing | corrupt` classification. A missing file is not
an initial chain, and malformed, incomplete, inconsistent, or cross-instance state is
not repaired or replaced automatically. Model/operator renewal, L3/L4 readiness,
stop/resume, and documentation-cycle transitions refuse unavailable state and explain
that the operator must restore a coherent project plus configured `stateDir` backup.
Checkpoint attestations do not initialize chain authority.

`saveRenewalState` updates only an existing valid chain and refuses identity changes or
counter rollback. A new explicitly created mission gets a zero-count chain through
exclusive creation, bound by the `mission:<id>:` chain identity. A retry against an
existing mission whose bootstrap state is absent refuses; preserve the partial files and
use a different mission ID after operator review. The supervised documentation-cycle
transition is the sole controlled chain replacement path: its journal must archive the
exact valid old state and its new chain must have a distinct identity.

Valid schema-v1 states remain supported, including the historical omission of the
`stopped` field. Required quota/idempotence fields must be present and consistent. If a
consumed checkpoint is newer than or at the same generation as the current checkpoint
but has a different identity, renewal refuses and asks for a coherent documents/state
restore. No state file, checkpoint, or scientific result is deleted during recovery.
