# Pi Handoff — context-guard for Pi 1.4.0

Minimal Pi 1.4.0 extension + durable working-memory files that monitor remaining context,
alert at configurable thresholds, enforce a closing phase, persist crash-safe
checkpoints, and — since Phase 2 — renew a session in-place into a fresh successor that
recovers from files alone (no transcript replay, no lossy compaction). No third-party
dependencies, no LLM involvement in the guard itself.

**Current status.** Phases 1, 1b, 1c, 1d and Phase 2 (increments A+B+C) are COMPLETE;
renewal is proven live with real inference (LEARNINGS A-23). Verification baselines:
`node --test test/` → 131 pass / 0 fail / 1 gated skip; `node
scripts/e2e-rpc-two-process.mjs` → 27/27 (real runtime, zero inference); `node
scripts/check-skill-discovery.mjs` → 8/8 (real runtime, zero inference); `node
scripts/e2e-renew.mjs` → 20/20 (spends real inference — re-run only after renewal-wiring
changes). `GOAL.md` still describes the *original* Phase 1 scope ("no automatic session
switching"): that is historically correct, the file is protected, and it is deliberately
left untouched — subsequent phases (1b/1c/1d and Phase 2) extended the original scope
under explicit operator authorization; the history lives in `PROGRESS.md` /
`LEARNINGS.md`, never in a silent goal rewrite. Reuse in another project (`drpli`) is a
separate, operator-authorized action: this repository has deployed nothing anywhere.

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
docs/long-project-guide.md  Phase 1d: integration guide for long-running projects (PL/I-80 case study)
.agents/skills/pi-handoff/  Phase 1d: Pi skill (SKILL.md + references/commands.md + references/bootstrap.md)
.pi-guard/sessions/<sessionId>.json            per-session runtime state (ephemeral)
```

## Install / load

During development (works without project trust):

```bash
pi -e .pi/extensions/context-guard/index.ts
```

Permanent: grant project trust for this directory (`.pi/extensions/` is auto-loaded once
trusted; trust store is `$PI_CODING_AGENT_DIR/trust.json`). Project trust also gates
`.agents/skills/` discovery in Pi 1.4.0 — an untrusted project's skill is silently
absent from `get_commands` (LEARNINGS A-25, proven by `scripts/check-skill-discovery.mjs`).

No packages are installed; the extension's runtime imports are Node built-ins plus its own
sibling modules. Pi loads it through `jiti` (verified).

## Run tests

```bash
node --test test/          # 132 tests (1 skipped: gated real-Pi e2e), no inference, no installs
node scripts/e2e-rpc-two-process.mjs   # real pi 1.4.0, 2+2 processes, zero inference (27 checks)
node scripts/check-skill-discovery.mjs # real pi 1.4.0: project skill discovery + trust-gated extension auto-load, zero inference (8 checks)
node scripts/e2e-renew.mjs             # REAL inference: A→B→C renewal chain proof (20 checks); re-run after any renewal-wiring change
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
| `closingAllowlist` | `["write","edit","read"]` | tools permitted during enforced closing. Renewal-enabled projects should add `"handoff_renew"` so the model can still trigger renewal during closing (this project's config does); without it, closing leaves only checkpoint writes + the operator `/handoff renew` command |
| `protectGoal` | `true` | block write/edit to GOAL.md; detect goal drift |
| `autoCheckpointAtHandoffLevel` | `true` | checkpoint once per escalation to level ≥ 3 |
| `maxConsecutiveUnknown` | `3` | evaluations without a usable measurement before "degraded" |
| `stateDir` | `.pi-guard` | persisted guard state (atomic per-session `sessions/<id>.json`) |
| `readOnly` | `false` | audit mode: zero writes to the project tree (dry-run checkpoints) |
| `maxSessionStates` | `0` | retention cap for per-session state files; `0` disables pruning (deleting a file that may belong to a live process is unsafe without OS liveness data) |
| `renewal.enabled` | `false` | master switch: nothing switches sessions unless true (commands and the tool still exist — they refuse with a named reason) |
| `renewal.autoRenew` | `false` | *additionally* required for **model**-initiated renewal (`handoff_renew` tool and the `RENEWAL AVAILABLE` alert at level ≥ 3). `enabled` alone only permits the operator `/handoff renew`. Pressure alerts never force a transition by themselves |
| `renewal.maxRenewals` | `2` | hard cap per renewal chain (chain state in `<stateDir>/renewal-state.json`) |
| `renewal.recoveryPrompt` | built-in | replaces the GENERIC body of the successor recovery instruction; the mandatory identity header (renewal index, parent/chain/checkpoint ids, no-replay/no-compaction contract) and the safety trailer (initiative, never-push) are always kept (dev.2 D1) |
| `renewal.testCommand` | `null` | project-configured build-verify command carried into the successor recovery message. Default `null`: the prompt contains NO build-verify line — generic test commands are never assumed (dev.2 D1, LEARNINGS A-26) |
| `files` | GOAL/PROGRESS/LEARNINGS/HANDOFF.md | durable-file names used by checkpointing/validation |

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
reserve above 25 % of the window.

**Experimental policy change (Phase 2, adopted for this project):** this project now uses
`"generationReserve": 20000` (LEARNINGS P-7, adopted experimentally for renewal work).
With the declared 220 000 window and default thresholds this moves nominal closing from
≈150 k to ≈195 k estimated tokens used — level crossings at used ≥ 170 000 (L1),
180 000 (L2), 190 000 (L3), **195 000 (L4 enforced)** — verified arithmetically through
`computeBudget` + `ContextPressureMachine` (220000 − 20000 − 5000 = 195000). This is a
BUDGET change only: it does NOT modify global Pi or Sushi settings and does NOT cap
output; per A-12 Pi still clamps `max_tokens` per request, so a generation that outruns
the reserve is provider-truncated, the estimate grows, and the guard escalates. Trade-off
accepted for Phase 2: longer productive window per session before renewal, at the cost of
less headroom between the L4 alert and the true window edge. **Accuracy caveat:** the
real-inference renewal experiment (A-23) triggered with *synthetic* pressure, so the
≈195 k closing point is arithmetically verified but has NOT been live-observed under real
token accounting (LEARNINGS P-7 — live confirmation still open).

Env overrides: `CONTEXT_GUARD_DISABLED=1`, `CONTEXT_GUARD_ENFORCE=0`,
`CONTEXT_GUARD_SYNTHETIC_REMAINING=<tokens>`, `CONTEXT_GUARD_READONLY=1`,
`CONTEXT_GUARD_STATE_DIR=<path>` (may point outside the project),
`CONTEXT_GUARD_AUTO_RENEW=1|0` (force-enable/disable the renewal policy for one process).
CLI flags: `--guard-synthetic <n>`, `--guard-readonly 1`.

## Renewal (Phase 2 — complete; proven live with real inference A→B→C)

`handoff.config.json` may carry a `renewal` block: `enabled` (default **false** — nothing
switches sessions unless you say so), `autoRenew` (default **false** — model-initiated
renewal needs this ON), `maxRenewals` (hard cap per chain, default 2), `recoveryPrompt`
(overrides the generic recovery body; mandatory identity/safety parts of the message are
always kept) and `testCommand` (project-configured build-verify line; with no explicit
command the successor prompt carries NONE — the dev.1 hardcoded `node --test test/` was
removed, LEARNINGS A-26). Chain state persists at
`<stateDir>/renewal-state.json` and survives session replacement and process restarts;
`/handoff renew stop` writes a DURABLE stop flag that successor sessions inherit.
Renewal requires the full Phase 1c gate: current checkpoint ∧ consistent identity ∧
attested readiness (`renewAuthorization()`) ∧ below cap ∧ checkpoint not already used
(idempotence). See PROTOCOL §6.

Two triggers, both implemented and live-verified (LEARNINGS A-23):

- `/handoff renew [notes]` — operator command; safe boundary first (`waitForIdle`), then
  refresh + attest the checkpoint, persist chain state BEFORE the switch, then
  `ctx.newSession({parentSession, withSession})`.
- `handoff_renew` tool — model-initiated. Its `execute()` gates, refreshes and attests
  synchronously, then fire-and-forgets `/handoff renew go` and returns; the switch happens
  when the turn settles (awaiting idle inside the tool would deadlock on its own result).

The successor starts with a **fresh context**: identity banner + deterministic recovery
instruction (durable files only), no transcript replay, no compaction. Scope of the live
proof (A-23), stated precisely: the experiment verified **one** model-initiated renewal
(synthetic pressure → `handoff_renew`) followed by **one** operator-initiated renewal,
then a cap refusal — not two independently spontaneous renewals, and not real-pressure
threshold accuracy. Verify the whole chain yourself with `node scripts/e2e-renew.mjs`
(spends real inference on an isolated git clone; `GUARD_E2E_KEEP=1` keeps the clone for
forensics).

## Manually triggering each threshold (synthetic mode — no token spend)

In a Pi session with the extension loaded (or with `--guard-synthetic 30000` at startup):

```
/guard status                # level, remaining, spent alerts, checkpoint status
/guard simulate 30000        # → level 1 advisory (checkpoint PROGRESS.md)
/guard simulate 20000        # → level 2 advisory (wrap up)
/guard simulate 10000        # → level 3 advisory + automatic checkpoint (HANDOFF.md)
/guard simulate 4000         # → levels 1–4 crossed at once: one combined alert;
                             #   enforced closing: bash/grep/etc. blocked, only tools in
                             #   closingAllowlist run (default write/edit/read; this
                             #   project also lists handoff_renew)
/guard simulate 120000       # level relaxes to 0; alerts stay spent (once per session)
/guard reset                 # re-arm alerts, re-baseline GOAL.md hash (testing only)
```

To test real measurement instead of synthetic: run `/guard status` during ordinary work;
remaining is computed as `contextWindow − ctx.getContextUsage().tokens − max(model.maxTokens, safetyReserve)`.

## Checkpoint validation (how a checkpoint is validated)

Two independent checks, both read-only, both reported and never thrown:

1. **Structure** (`validateFile`/`validateAll`): each durable file must contain its
   required `##` sections.
2. **Freshness** (`validateCheckpoint`): the managed checkpoint blocks (current format:
   **schema v3**) embed sha256 fingerprints of the relevant source state — GOAL.md and
   LEARNINGS.md whole; the *manual prose* of PROGRESS.md and HANDOFF.md (their managed
   blocks stripped before hashing, so no block ever hashes itself → non-circular); plus
   `handoff.config.json`.
   Schema **v3** stamps one transactional identity into both blocks
   (`checkpoint-generation`, `checkpoint-id`, `checkpoint-kind`, `content-delta`,
   `readiness`), so an interrupted two-file write, an obsolete generation or a forged id
   is detected even when every source hash still matches (Phase 1c repro: a second
   checkpoint over unchanged source state validated as `current` before the fix).
   Older formats are recognized but never treated as current: unversioned **v1** blocks
   are `stale` (`legacy: true`), and **v2** blocks (source hashes only, no transactional
   identity — the Phase 1b historical format) are `stale` with `legacyIdentity: true`
   until refreshed by `/handoff`.
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
notification. `/handoff verify` validates freshness without writing. The original Phase 1
build did **not** switch sessions; in-place session replacement arrived with Phase 2
(§Renewal above, PROTOCOL §6).

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
  state machine only and **do not prove real context usage is accurate**. The unit suite
  and all default verification scripts spend zero inference; the ONLY real-inference run
  is the explicit `scripts/e2e-renew.mjs` proof.
- **Renewal (Phase 2) is implemented and proven live** (A→B→C with real inference,
  LEARNINGS A-23), but it is **off by default**: `renewal.enabled` and `renewal.autoRenew`
  gate it, and `autoRenew` is deliberately false in this project's config — the
  increment-C experiments enabled it per-process with `CONTEXT_GUARD_AUTO_RENEW=1`.
  Enabling it as the project default is an operator decision.
  What the live experiment proved *precisely*: **one** model-initiated renewal followed
  by **one** operator-initiated renewal (then a cap refusal) — NOT two independently
  spontaneous model renewals, and not unbounded auto-chaining.
  Pressure alerts alone never force a transition: the `RENEWAL AVAILABLE` hint appears
  only at level ≥ 3 when `renewal.enabled` ∧ `autoRenew` ∧ no operator stop, and renewal
  still requires a gate pass (current ∧ identity-consistent ∧ attested ∧ below cap ∧
  unseen checkpoint id). Unattended/recursive agent
  *launching* (spawning new pi processes) is still NOT implemented: renewal replaces the
  session inside the running process only.
- Alerts are transcript appends; Pi exposes no "inject without a message" channel, so each
  alert permanently adds one small custom message (bounded: ≤ 4 per session).
- Enforcement blocks *new* tool calls only after crossing; a running long tool call cannot
  be paused by the guard (deliberately — no arbitrary interruption).
- `agent_settled` evaluation is best-effort freshness; the authoritative signal is `turn_end`.
- JSON config is read once per `session_start`; edit files then `/reload` (or restart).
- **Concurrent renewal safety is not proven**: real *two-process* runs tested specific
  invariants (two `pi --mode rpc` processes on one tree: distinct session ids, each
  writing only its own `sessions/<id>.json`, no cross-overwrite, one intact managed
  block per file after concurrent checkpoints — LEARNINGS A-16). What has NOT been
  exercised: simultaneous interleaved writes under load beyond that scale, and two
  sessions racing to renew one chain (P-5). Atomic rename makes each file individually
  safe; that is not a concurrency proof.
- Audit mode guarantees *tree*-immutability only. Pi still writes session transcripts
  under `$PI_CODING_AGENT_DIR`; a truly immutable snapshot needs OS-level enforcement
  (read-only mount/snapshot). It is **not** equivalent to an OS-level read-only
  filesystem.
- This project never modified `pli80`; the PL/I-80 material in
  `docs/long-project-guide.md` §7 is a **blueprint only**. Reusing context-guard in
  another project (e.g. `drpli`) is a separate, explicitly operator-authorized action.
- A running pi session keeps its already-loaded extension code; after editing the guard,
  `/reload` or a new session is required for changes to take effect (old and new writers
  coexist via the newest-wins migration rule).

## Phase 2 feasibility (settled — historical analysis, superseded by the implementation)

**This section is the pre-Phase-2 feasibility note, kept as history because it records
*why* the renewal design ended up as it did. It no longer describes open work: renewal
is implemented (increments A+B+C) and proven live (LEARNINGS A-23, A-17); the operative
contract is §Renewal above and PROTOCOL §6.**

Renewal was built on the primitives listed below and verified in a real session
(LEARNINGS A-23): Pi 1.4.0 provides `waitForIdle`, `newSession` with `parentSession` +
`withSession(ReplacedSessionContext)`, and `session_before_switch` cancellation.

Safe to add renewal **after** real-session checkpoint/recovery verification passes:
Pi 1.4.0 provides the needed primitives (`waitForIdle`, `newSession` with
`parentSession` + `withSession(ReplacedSessionContext)`, `session_before_switch`
cancellation). The renewal contract is specified in `PROTOCOL.md` §6. It should carry only
the durable files into the fresh session — no transcript copy, no LLM summarization —
which also minimizes Sushi prefill churn (fresh session prefills AGENTS.md context file +
four small markdown files once; no repeated system-prompt regeneration, no compaction
summary calls).
