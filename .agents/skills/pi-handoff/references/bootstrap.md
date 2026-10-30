# Equip a new long-running project with context-guard

Goal: a project where any fresh agent session can recover from **files alone**.
Do this from the context-guard source project (this repo), into the target project.

## 1. Copy the extension (self-contained, zero dependencies)

```
<target>/.pi/extensions/context-guard/
  index.ts core.ts config.ts checkpoint.ts renewal.ts recovery.ts diagnostics.ts
```

Seven modules as of dev.2 (`recovery.ts` = D4 lean tiers + cost meter,
`diagnostics.ts` = D5c event trail); the list is machine-checked against the runtime's
local import closure by `test/docs.test.ts` DC2 — if a release adds a module, this file
must be updated or the suite fails.

Runtime imports are Node built-ins + sibling modules; Pi loads them through `jiti`
(no build step). Node ≥ 23 is required for type-stripping.

## 2. Copy + tune `handoff.config.json` (target root)

Start from the defaults; then tune for the model actually used (see commands.md
§Budget arithmetic):

- `"generationReserve"`: `"model"` is the conservative default (closing very early on
  large-maxTokens models). A fixed number (e.g. 20000) buys window at the cost of
  headroom — decide, don't inherit blindly.
- `"closingAllowlist"`: add `"handoff_renew"` only if renewal will be used.
- `"renewal"`: keep `enabled: false` until Phase-1-style recovery has been walked
  through manually at least once; `autoRenew` stays `false` unless the operator
  explicitly accepts model-initiated session switching; set `maxRenewals` (default 2).
  Configure `renewal.testCommand` explicitly (default `null` = NO build-verify line in
  the successor prompt — dev.2 D1 never assumes one) and optionally
  `renewal.recoveryPrompt` (replaces the generic body; identity header + safety
  trailer are always kept).
- `"recovery"` (dev.2 D4): `lean: false` by default — a fresh session reads all six
  durable files; `lean: true` (or env `CONTEXT_GUARD_LEAN=1`) switches the successor
  recovery instruction to tiers (operational → methodology → archive). All six files
  stay authoritative either way; tiering defers reading, never drops authority.
  `budgetTokens` (default 12000) is the chars/4-estimated operational-tier budget.

## 3. Create the six durable files (target root)

Keep them SMALL — they are prefilled into every fresh session.

- `GOAL.md` — objective + acceptance criteria. This is the protected file; the guard
  blocks write/edit to it and warns on drift. Never let an agent rewrite it silently.
- `PROTOCOL.md` — stable working rules (thresholds semantics, checkpoint rules,
  evidence classification…). Copy this repo's as a starting point and adapt.
- `AGENTS.md` — 10-line entry point: what the project is, read order, verify command,
  hard scope limits. Pi auto-loads it as a context file.
- `HANDOFF.md` — recovery instructions + "Last verified state" + "Unfinished
  operations" + `## Next action` (manual prose wins over the managed block).
- `PROGRESS.md` — current phase, completed list, pending list, blockers.
- `LEARNINGS.md` — accepted / proposed / falsified entries with evidence. The guard
  never writes it; only the agent does.

Minimal `## Next action` discipline: every session ends with the **exact next
action** a fresh session must take (command + expected output), not a vibe.

## 4. Install the skill (optional but recommended)

Copy `.agents/skills/pi-handoff/` (this directory) to the target's
`.agents/skills/` (project scope) or `~/.agents/skills/` (user scope). Pi discovers
`SKILL.md` directories recursively; review skill files before granting project trust
(skills can instruct the model to run scripts).

## 5. Verify in the REAL runtime (mock tests are not enough)

```
pi -e <target>/.pi/extensions/context-guard/index.ts        # explicit load: works without trust
```

In the session:

1. `/guard status` → must print the full budget report (proves the module loaded —
   a load failure silently disables everything; see LEARNINGS A-15).
2. `/guard simulate 30000` → level 1 alert; `10000` → level 3 + auto-checkpoint
   (managed blocks appear in HANDOFF.md/PROGRESS.md); `4000` → combined alert +
   enforced closing (tools outside `closingAllowlist` blocked; by default only
   write/edit/read pass — add `handoff_renew` if renewal will be used).
3. `/handoff verify` → `current`; `/handoff ready` → READY + attested.
4. `/guard simulate 120000` → level relaxes; alerts stay spent (once per session).
5. Exit; start a fresh session in the target; confirm the session_start banner +
   recovery instructions + that a new agent can follow HANDOFF → tests → next action.
6. Trust the project (`.pi/extensions/` then auto-loads) or keep loading with `-e`.

## 6. Commit

Commit the equip as one commit; then run `/handoff` + `/handoff ready` and commit the
managed-block refresh separately (standard ritual). Add the guard's own checks
(`node --test test/` of the source repo) to the target's verify command if the target
vendors the extension sources.

## Adaptation notes for research/reverse-engineering projects

Projects with their own evidence ledgers (claims files, golden gates, oracle
transcripts) map cleanly:

- Domain evidence stays in the project's own ledger (e.g. `spec/CLAIMS.md`);
  `LEARNINGS.md` holds *working-method* knowledge (tooling, environment, procedure).
  Cross-reference, never merge.
- The verify command must be the project's real gate (byte-exact gate, corpus run),
  not a placeholder.
- Ground-truth directories (original binaries, goldens) deserve the same treatment as
  `GOAL.md`: never edited; audit sessions use `CONTEXT_GUARD_READONLY=1` with an
  external `CONTEXT_GUARD_STATE_DIR`.
