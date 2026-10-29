# Pi Handoff — Phase 1: context-guard

Minimal Pi 1.4.0 extension + durable working-memory files that monitor remaining context,
alert at configurable thresholds, enforce a closing phase, and persist crash-safe
checkpoints for handoff to a fresh session. No lossy compaction, no third-party
dependencies, no LLM involvement in the guard itself.

Environment this was built and verified against: Pi 1.4.0 (`/usr/lib/node_modules/@earendil-works/pi-coding-agent`),
Node v26.12.1, `PI_CODING_AGENT_DIR=/home/john/.sushibeta/pi`, automatic compaction disabled.

## Layout

```
.pi/extensions/context-guard/
  index.ts       extension adapter (events, commands, enforcement) — pi imported type-only
  core.ts        deterministic threshold state machine (pure)
  config.ts      defaults + JSON/env config merging (pure)
  checkpoint.ts  atomic writes, managed sections (schema v3: transactional identity +
                 source hashes), freshness/readiness validation, per-session state, v1
                 migration, inspection-only audit loads, dry runs
test/            node:test suites with mocked Pi API events + synthetic budgets
handoff.config.json   minimal configuration
GOAL.md PROGRESS.md LEARNINGS.md HANDOFF.md   durable working memory
AGENTS.md PROTOCOL.md  stable procedures
.pi-guard/sessions/<sessionId>.json            per-session runtime state (ephemeral)
```

## Install / load

During development (works without project trust):

```bash
pi -e .pi/extensions/context-guard/index.ts
```

Permanent: grant project trust for this directory (`.pi/extensions/` is auto-loaded once
trusted; trust store is `$PI_CODING_AGENT_DIR/trust.json`).

No packages are installed; the extension's runtime imports are Node built-ins plus its own
sibling modules. Pi loads it through `jiti` (verified).

## Run tests

```bash
node --test test/          # 103 tests (1 skipped: gated real-Pi e2e), no inference, no installs
node scripts/e2e-rpc-two-process.mjs   # real pi 1.4.0, 2+2 processes, zero inference (23 checks)
```

Node ≥ 23 runs the TypeScript sources directly (type stripping). Tests use mocks of
`ExtensionAPI`/`ExtensionContext` and synthetic token budgets.

## Configuration (`handoff.config.json`)

| Key | Default | Meaning |
|---|---|---|
| `thresholds` | 30000/20000/10000/5000 | remaining-token crossings for levels 1–4 |
| `generationReserve` | `"model"` | subtract `ctx.model.maxTokens` (or fixed number) from remaining |
| `safetyReserve` | `0` | extra reserve; effective reserve = `max(generationReserve, safetyReserve)` |
| `enforceClosing` | `true` | level 4 blocks new non-allowlisted tool calls |
| `closingAllowlist` | `["write","edit","read"]` | tools permitted during enforced closing |
| `protectGoal` | `true` | block write/edit to GOAL.md; detect goal drift |
| `autoCheckpointAtHandoffLevel` | `true` | checkpoint once per escalation to level ≥ 3 |
| `maxConsecutiveUnknown` | `3` | evaluations without a usable measurement before "degraded" |
| `stateDir` | `.pi-guard` | persisted guard state (atomic per-session `sessions/<id>.json`) |
| `readOnly` | `false` | audit mode: zero writes to the project tree (dry-run checkpoints) |
| `maxSessionStates` | `0` | retention cap for per-session state files; `0` disables pruning (deleting a file that may belong to a live process is unsafe without OS liveness data) |

## Generation reserve

`remaining` is measured as **usable** context, not raw context:

```
usable = contextWindow − estimatedTokensUsed − reserve
reserve = max(generationReserveResolved, safetyReserve)
generationReserveResolved = ctx.model.maxTokens when generationReserve === "model"
```

With Sushi's declared `contextWindow=220000` / `maxTokens=65536` and the default
`"generationReserve": "model"`, usable = `220000 − used − 65536`, so level 1 fires at
used ≥ 124 464, level 3 at ≥ 144 464 and enforced level 4 at ≥ **149 464 (~150k, not
220k)** — observed live and reproduced arithmetically (`test/budget.test.ts` B1,
LEARNINGS A-11).

Two things this reserve is **not**:

- it is not an output cap. It is a policy budget for the *next* completion. Pi 1.4.0
  already bounds output per request: `pi-ai`'s `clampMaxTokensToContext()` sets
  `max_tokens = min(model.maxTokens, contextWindow − estimateContextTokens(context).tokens − 4096)`
  before every request, so an over-long generation is truncated by the provider
  (`stopReason: "length"`) rather than overflowing the window (LEARNINGS A-12);
- it is not exact accounting. `getContextUsage().tokens` is an estimate (last trustworthy
  assistant usage + chars/4 for trailing messages), so thresholds are advisory budgets.

`/guard status` therefore prints every component (raw remaining, reserve **and its
source**, usable remaining, reserve fraction, provenance, inconsistencies) and flags a
reserve above 25 % of the window. A fixed reserve is available via
`"generationReserve": 20000` — **not adopted here**; the project keeps `"model"`
(20 k would only move the closing point from ~150 k to ~195 k used).

Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<tokens>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>` (may point outside the project).
CLI flags: `--guard-synthetic <n>`, `--guard-readonly 1`.

## Manually triggering each threshold (synthetic mode — no token spend)

In a Pi session with the extension loaded (or with `--guard-synthetic 30000` at startup):

```
/guard status                # level, remaining, spent alerts, checkpoint status
/guard simulate 30000        # → level 1 advisory (checkpoint PROGRESS.md)
/guard simulate 20000        # → level 2 advisory (wrap up)
/guard simulate 10000        # → level 3 advisory + automatic checkpoint (HANDOFF.md)
/guard simulate 4000         # → levels 1–4 crossed at once: one combined alert;
                             #   enforced closing: bash/grep/etc. blocked, write/edit/read allowed
/guard simulate 120000       # level relaxes to 0; alerts stay spent (once per session)
/guard reset                 # re-arm alerts, re-baseline GOAL.md hash (testing only)
```

To test real measurement instead of synthetic: run `/guard status` during ordinary work;
remaining is computed as `contextWindow − ctx.getContextUsage().tokens − max(model.maxTokens, safetyReserve)`.

## Checkpoint validation (how a checkpoint is validated)

Two independent checks, both read-only, both reported and never thrown:

1. **Structure** (`validateFile`/`validateAll`): each durable file must contain its
   required `##` sections.
2. **Freshness** (`validateCheckpoint`): the managed checkpoint blocks (schema v2) embed
   sha256 fingerprints of the relevant source state — GOAL.md and LEARNINGS.md whole;
   the *manual prose* of PROGRESS.md and HANDOFF.md (their managed blocks stripped before
   hashing, so no block ever hashes itself → non-circular); plus `handoff.config.json`.
   Schema **v3** additionally stamps one transactional identity into both blocks
   (`checkpoint-generation`, `checkpoint-id`, `checkpoint-kind`, `content-delta`,
   `readiness`), so an interrupted two-file write, an obsolete generation or a forged id
   is detected even when every source hash still matches (Phase 1c repro: a second
   checkpoint over unchanged source state validated as `current` before the fix).
   Result is exactly one of:
   - `missing` — no managed block in HANDOFF.md;
   - `corrupt` — block present but invalid (no `checkpointed:` timestamp, unknown
     `checkpoint-schema`, missing/garbage source hashes);
   - `stale` — structurally valid, but a fingerprint differs from the files now (names
     the changed sources), a legacy unversioned v1 block (`legacy: true`), a schema-v2
     block without transactional identity (`legacyIdentity: true`), or a partial/
     inconsistent generation (`partial: true`: mixed ids/generations, missing twin,
     disagreeing readiness);
   - `current` — all hashes match, both blocks share one `checkpoint-id`, and the
     PROGRESS.md twin is in sync. `content-delta` (`initial|none|new`) says whether the
     checkpoint captured anything new; `readiness` (`attested|unattested|invalid`) says
     whether it is a *complete* handoff. These are separate axes: a fresh, valid block can
     still be semantically empty, and only `renewAuthorization()` combines them into the
     Phase 2 renewal gate (`current` ∧ identity-consistent ∧ attested).

Recovery precedence: manual prose wins; the checkpoint block's next action is used only
when there is no manual `## Next action` **and** the block is `current`; a stale block is
a labelled last resort. Conflicts are never resolved by overwriting hand-authored text:
`/handoff` refreshes only the managed blocks (temp+rename, atomically), everything
outside markers survives byte-for-byte, and LEARNINGS.md/GOAL.md are never written.
`/handoff verify` (or `/guard verify-checkpoint`) reports the classification; a fresh
session gets a staleness notification at `session_start`.

## Read-only audit mode

Distinguish: (1) *a model instructed not to edit* — behavioral only, extensions can still
write; (2) *an extension that writes runtime state* — the guard's per-session state was
exactly this problem in the audit; (3) *a genuinely immutable snapshot* — only OS-level
(read-only mount/snapshot); the guard does not provide that.

`CONTEXT_GUARD_READONLY=1` (or `--guard-readonly 1`, or `"readOnly": true`) ⇒ zero writes
inside the audited tree: monitoring, alerts, threshold enforcement and GOAL protection
stay active; auto-checkpoints are suppressed with a notification and `/handoff` runs as a
reported dry run (attestation included: `/handoff ready` says so and writes nothing).
Ephemeral state may still persist when `CONTEXT_GUARD_STATE_DIR` points outside the tree.
In audit mode the runtime-state load is **inspection only** (`inspectGuardState`): no
quarantine of corrupt files, no v1 migration, no temp-file cleanup, and nothing is claimed
about state the guard does not own — with an external stateDir the tree's stale
`.pi-guard/` is never inspected; with an in-tree stateDir the guard reports each repair it
suppressed (`LEARNINGS A-10`, proven on a real filesystem by `test/audit-tree.test.ts`
A1/A2/A4/A5 and by `scripts/e2e-rpc-two-process.mjs`). Pi's own session transcript always lives under `$PI_CODING_AGENT_DIR`,
not the project tree.

Verified live in real Pi 1.4.0 RPC mode against a temp copy of this project: the tree was
byte-for-byte identical after a full audit session (startup + status + simulate + handoff).

## Invoking a checkpoint

```
/handoff optional notes
```

Writes the managed checkpoint block in `HANDOFF.md` + `PROGRESS.md` (agent text outside
markers preserved), embeds fresh source-state fingerprints, validates required sections
of all four durable files, persists guard state to the per-session file, and reports via
notification. `/handoff verify` validates freshness without writing. Phase 1 does **not**
switch sessions.

## Verified Pi 1.4.0 API contract

Inspected in `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`,
`docs/extensions.md`, `docs/compaction.md`, `examples/extensions/handoff.ts`:

- **Context usage**: `ctx.getContextUsage(): ContextUsage | undefined` where
  `ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null }`
  (types.d.ts:197,248). `tokens` is an *estimate*: last trustworthy assistant `Usage`
  (`calculateContextTokens`) plus a chars/4 heuristic (`estimateTokens`) for trailing
  messages; `null` after compaction until a fresh assistant response; `undefined` when no
  model/contextWindow. There is **no exact remaining-context API** in 1.4.0.
- **Token accounting source of truth**: `Usage { input, output, cacheRead, cacheWrite, totalTokens, ... }`
  from provider responses; model capacities from `ctx.model.contextWindow` / `ctx.model.maxTokens`.
- **Turn lifecycle**: `turn_start`, `turn_end` (actionable `BoundaryResult` boundary),
  `agent_start`/`agent_end`, `agent_before_settle`/`agent_settled` (settled = no automatic
  continuation remains). Model-request hooks: `context`, `context_with_system`,
  `before_provider_request`.
- **Steering / messaging**: `pi.sendMessage(customMessage, { triggerTurn, deliverAs: "steer"|"followUp"|"nextTurn" })`
  and `pi.sendUserMessage(content, { deliverAs: "steer"|"followUp" })`. Verified behavior
  (agent-session.js `sendCustomMessage`): while streaming with `triggerTurn:false` the
  append is **deferred to end of turn** — used so alerts never interrupt in-flight tools.
- **Registration/loading**: default-export factory `(pi: ExtensionAPI)`; user dir
  `$PI_CODING_AGENT_DIR/extensions/`, project `.pi/extensions/` (trust-gated), explicit
  `pi --extension <path>` / `-e`; multi-file extension = directory with `index.ts`;
  loaded by `jiti` (no build step). `pi.registerCommand`, `pi.registerFlag`,
  `pi.appendEntry` (persisted, excluded from model context) verified in types.d.ts.
- **Session management**: `session_start(reason)`/`session_shutdown`, cancellable
  `session_before_switch`/`session_before_compact`; command-only `ctx.waitForIdle()`,
  `ctx.newSession({parentSession, setup, withSession})`, `ctx.switchSession()`, `ctx.fork()`.
  Session replacement invalidates old contexts — only plain data crosses via
  `ReplacedSessionContext`. Sessions stored under `$PI_CODING_AGENT_DIR/sessions/` (per-cwd).
- **Config dir in use**: `/home/john/.sushibeta/pi` (via `PI_CODING_AGENT_DIR`); its
  `settings.json` has `compaction.enabled=false`, `reserveTokens=20000`.
- **Not assumed**: no newer upstream APIs were relied on; everything above exists in the
  installed 1.4.0 `dist`.

## Design notes

- **Deterministic state machine** (`core.ts`): level = current thresholds under remaining
  budget; alerts = monotonic per-session set; unknown measurements never alert and never
  relax enforcement (fail-safe); `degraded` after N consecutive unknowns; snapshot/restore
  round-trips across reloads; garbage snapshot values are clamped/rejected.
- **Cache-friendly**: the guard never returns `systemPrompt` overrides, never uses
  `context_with_system`, and only appends transcript deltas at turn boundaries, so the
  stable prompt + message prefix stays byte-identical for provider prompt caching. Durable
  state lives in files + `appendEntry` (outside model context), not in prompt churn.
- **Advisory vs enforced** is explicit in threshold `kind` and in enforcement (`tool_call`
  gate only at level 4 with `enforceClosing`).
- **Crash safety**: all guard writes are temp-file + atomic rename; corrupt per-session
  state files are quarantined with a timestamped backup (other sessions untouched) and
  the guard restarts with safe defaults; legacy `state.json` migrates newest-wins.
- **Session isolation**: runtime state lives in `sessions/<sessionId>.json`; parallel
  sessions cannot overwrite each other. Durable checkpoints live in the markdown files
  and are independent of ephemeral counters (pruning never touches them).
- **Audit mode**: `readOnly` blocks every write inside the tree; state optional via an
  external `stateDir`; checkpoints become dry runs (see above).

## Limitations

- Pi 1.4.0 gives no exact tokenizer: `getContextUsage().tokens` mixes provider-reported
  usage with a chars/4 estimate; thresholds are approximate. Synthetic tests exercise the
  state machine only and **do not prove real context usage is accurate**.
- No Phase 2 behavior: unattended/recursive agent launching is NOT implemented; automatic
  session switching is NOT enabled; the working session is never replaced. `/handoff`
  checkpoints but leaves the human to start/switch the fresh session (`pi --new`, then the
  AGENTS.md/HANDOFF.md recovery ritual).
- Alerts are transcript appends; Pi exposes no "inject without a message" channel, so each
  alert permanently adds one small custom message (bounded: ≤ 4 per session).
- Enforcement blocks *new* tool calls only after crossing; a running long tool call cannot
  be paused by the guard (deliberately — no arbitrary interruption).
- `agent_settled` evaluation is best-effort freshness; the authoritative signal is `turn_end`.
- JSON config is read once per `session_start`; edit files then `/reload` (or restart).
- **Concurrency is not proven**: per-session isolation and migration are tested serially
  (mocked events, one process). Real simultaneous Pi processes hammering one `.pi-guard`
  directory have not been exercised; atomic rename makes each file safe individually,
  but no multi-process test exists (tracked in LEARNINGS P-5).
- Audit mode guarantees *tree*-immutability only. Pi still writes session transcripts
  under `$PI_CODING_AGENT_DIR`; a truly immutable snapshot needs OS-level enforcement
  (out of Phase 1 scope).
- A running pi session keeps its already-loaded extension code; after editing the guard,
  `/reload` or a new session is required for changes to take effect (old and new writers
  coexist via the newest-wins migration rule).

## Phase 2 feasibility

Safe to add renewal **after** real-session checkpoint/recovery verification passes:
Pi 1.4.0 provides the needed primitives (`waitForIdle`, `newSession` with
`parentSession` + `withSession(ReplacedSessionContext)`, `session_before_switch`
cancellation). The renewal contract is specified in `PROTOCOL.md` §6. It should carry only
the durable files into the fresh session — no transcript copy, no LLM summarization —
which also minimizes Sushi prefill churn (fresh session prefills AGENTS.md context file +
four small markdown files once; no repeated system-prompt regeneration, no compaction
summary calls).
