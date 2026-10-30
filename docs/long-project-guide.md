# Long-project integration guide — Pi Handoff / context-guard

How to run a **weeks-long agent project** without lossy compaction and without
transcript-replay amnesia, using the context-guard extension + durable working-memory
files. Written for Pi 1.4.0; the case study is the Digital Research **PL/I-80
reverse-engineering** project (`~/projects/sushiworks/pli80`).

Scope note: this guide is a **blueprint**. Installing context-guard into pli80 (or any
other project — including reuse in `drpli`) is an operator action with explicit approval —
the handoff prototype never modified pli80, deployed nothing to `drpli`, and neither does
this document.

## 1. The problem this solves

An agent session dies three deaths on a long project:

1. **Context exhaustion** — the window fills; without protocol, the agent rambles or
   hallucinates its own state.
2. **Lossy compaction** — summarizing the transcript destroys pointers, evidence
   citations and exact next actions; a "continued" session is a different agent.
3. **Silent drift** — the objective mutates in prose, discoveries stay in the
   transcript, and nobody can say what was actually verified.

The answer is not a smarter summary. It is **durable files as the only truth** and a
guard that enforces keeping them fresh:

```
AGENTS.md        entry point: what/where/how to verify (Pi auto-loads it)
PROTOCOL.md      stable working rules (thresholds, checkpoints, evidence classes)
GOAL.md          objective + acceptance criteria      (guard-PROTECTED, never silently rewritten)
HANDOFF.md       resume point: recovery instructions + ## Next action (manual prose WINS)
PROGRESS.md      current state: completed / pending / blockers
LEARNINGS.md     classified knowledge: accepted / proposed / falsified (guard never writes it)
handoff.config.json   guard policy
.pi/extensions/context-guard/   the extension (7 TS modules, zero dependencies)
.pi-guard/       ephemeral per-session runtime state + renewal chain state (gitignored)
```

A fresh session recovers by **reading these files** — never by replaying a transcript.
Renewal (Phase 2) automates the session replacement itself: the old session closes, a
brand-new session starts with only AGENTS.md + the durable files + a deterministic
recovery instruction. Zero compaction, zero transcript copy.

## 2. Install into an existing project

Six steps; the skill ships the same procedure in
`.agents/skills/pi-handoff/references/bootstrap.md`:

1. Copy `.pi/extensions/context-guard/` (index.ts, core.ts, config.ts, checkpoint.ts,
   renewal.ts, recovery.ts, diagnostics.ts) into the target. No build step — Pi loads
   TS through jiti; Node ≥ 23. The list is machine-checked: `test/docs.test.ts` DC3
   fails if the guide and the runtime's import closure ever diverge again (A-41 —
   this recipe carried the obsolete five-module list through dev.2 D4/D5c).
2. Copy `handoff.config.json` and **tune the budget** (§4) for the model in use.
   Renewal stays `enabled: false` until recovery has been walked through manually;
   set `renewal.testCommand` explicitly (dev.2 D1: unset means NO build-verify line in
   the successor prompt) and decide on lean recovery tiers (§3, `recovery.lean`).
3. Write the six durable files (§3). Keep them small: they are prefilled into every
   fresh session.
4. Optionally copy the skill directory (`.agents/skills/pi-handoff/`) into the target.
5. **Verify in the real runtime** — `pi -e <target>/.pi/extensions/context-guard/index.ts`
   then `/guard status` (a module-load error makes the guard silently absent; mock
   tests cannot catch it — this bit us as LEARNINGS A-15: an invalid re-export made the
   whole extension refuse to load while all unit tests "passed").
6. Walk the synthetic ladder once (`/guard simulate 30000/10000/4000/120000`), start a
   genuinely fresh session and have it follow HANDOFF → verify command → next action.

## 3. Writing the durable files well

The files are the interface; garbage in, garbage recovery out. The rules that matter:

- **`## Next action` is a command + expected output**, not a mood. Every session ends
  by making the next session's first five minutes deterministic.
- **Manual prose wins** over managed blocks. `<!-- guard:begin checkpoint -->` blocks
  are machine-managed (transactional identity, source hashes, freshness); everything
  outside the markers survives checkpoint rewrites byte-for-byte and takes precedence
  on recovery.
- **LEARNINGS is a ledger, not a diary**: accepted (verified here, safe to rely on),
  proposed (evidence + expected value + cost, explicitly *not a rule*), falsified
  (kept — they are the map of traps). Promotion is explicit, never silent.
- **GOAL.md is immutable by the agent.** Goal changes go to LEARNINGS (Proposed) +
  HANDOFF for human review. The guard blocks writes/edits targeting it and warns on
  drift (§6).
- Commit after every increment; then `/handoff` + `/handoff ready` (refresh + attest
  **after** the commit), and commit the managed-block refresh separately when it
  dirties the tree.
- **Reading tiers (dev.2 D4):** by default every fresh session reads all six files
  eagerly; with `recovery.lean: true` the successor recovery instruction is tiered —
  operational (`HANDOFF`/`PROGRESS`, read NOW) → methodology (`AGENTS`/`PROTOCOL`, on
  need) → archive (`GOAL`/`LEARNINGS`, by reference). All six stay authoritative;
  tiering defers reading, never drops authority. `/guard status` meters the cost
  (chars/4 estimates).

### Consolidating after a phase or strategy pivot

Long-lived operational documents require a **reviewed lifecycle**, not automatic
summarization or deletions. The bundled skill includes
[`references/consolidation.md`](../.agents/skills/pi-handoff/references/consolidation.md):
first plan the move/rewrite/archive map without edits, preserve accepted/proposed/
falsified evidence and any project-specific scientific claims ledger, then obtain
operator approval. A change of GOAL.md needs separate authorization. Archive the
old direction under a stable in-repository path and leave a single exact next action
in active HANDOFF.md. Never hand-edit transactional checkpoint blocks. After the
manual/archive commit, regenerate and attest the checkpoint, commit that refresh,
and compare full/lean chars/4 recovery-cost estimates before and after. This is
not a Pi command, not context compaction, and never a threshold-triggered action.

## 4. Budget tuning (read this before trusting thresholds)

The guard measures **usable remaining**:

```
usable = contextWindow − estimatedTokensUsed − max(generationReserve, safetyReserve)
```

- `estimatedTokensUsed` is Pi's estimate (`getContextUsage().tokens`: last trustworthy
  assistant usage + chars/4 for trailing messages). Pi 1.4.0 has **no exact
  remaining-context API** — thresholds are advisory budgets, not accounting.
- `generationReserve` is a **policy budget for the next completion, not an output cap**.
  Pi already clamps `max_tokens = min(model.maxTokens, window − estimate − 4096)` per
  request (`clampMaxTokensToContext`), so generations get provider-truncated instead of
  overflowing the window.
- Consequence: with Sushi's declared 220 000 window and `"generationReserve": "model"`
  (= 65 536), enforced closing lands at ≈**150 k** used, not 220 k. Observed live.
  A fixed `"generationReserve": 20000` moves closing to ≈**195 k** used — more
  productive window, less headroom. This project's dev.2 config went further (5 000
  ⇒ nominal crossings 185k/195k/205k/210k used, printed by `/guard status` since D6);
  the exact live closing point under real accounting remains unobserved (P-7).
  All of these are policy choices; state the choice in PROTOCOL.md so successors
  inherit the *reason*, not just the number.
- Config is read once at `session_start`; a running session keeps its old budget
  (mid-session edits do not re-baseline — LEARNINGS A-22). After changing config:
  `/reload` or new session; `/guard reset` re-arms alerts when measurements disagree
  with the operator's reality (the operator is right; the guard is policy).

## 5. The daily rhythm

```
start      read AGENTS→PROTOCOL→GOAL→HANDOFF→PROGRESS→LEARNINGS; run verify command
work       normal agent work; guard appends one alert per threshold crossing (never
           mid-tool-call — alerts ride the end-of-turn boundary)
L1 (≤30k)  update PROGRESS.md precisely (completed, blockers, exact next action)
L2 (≤20k)  finish the current substantial task; open nothing new
L3 (≤10k)  HANDOFF.md first; auto-checkpoint fires once
L4 (≤5k)   enforced closing: only tools in closingAllowlist run (default write/edit/read;
           add handoff_renew when renewal is enabled); finish checkpoints, stop
close      commit → /handoff → /handoff ready → (commit refresh) → renew or
           /handoff finalize (synchronous close without a switch, dev.2 D2) or stop
```

Test the whole ladder without spending tokens: `/guard simulate <n>`. Prove *load* in
the real runtime (`pi -e …` or a scripted RPC probe); synthetic runs prove the state
machine only.

## 6. Audits, protection, honesty

- **Review/audit sessions** run read-only: `CONTEXT_GUARD_READONLY=1
  CONTEXT_GUARD_STATE_DIR=/tmp/guard-state pi -e <ext>` → zero writes inside the tree;
  checkpoints become reported dry runs; monitoring and GOAL protection stay active.
  "I instruct the model not to edit" is **not** read-only — trusted extensions write;
  only this mode (or OS snapshots) gives the tree-level guarantee.
- **Freshness classification**: `missing | corrupt | stale | current`, computed from
  sha256 fingerprints of the *source state* (non-circular: blocks never hash
  themselves) + a transactional identity shared by HANDOFF and PROGRESS blocks.
  Validation only reports; it never "fixes" — refresh explicitly with `/handoff`.
- **Renewal gate**: a session may only be replaced from a checkpoint that is current ∧
  identity-consistent ∧ attested (`renewAuthorization()`), below the chain cap, not
  already used (one successor per checkpoint id), with no durable operator stop
  (`/handoff renew stop`, inherited by successors). Refusals name their reason.
- What is **proven live** (A→B→C, real inference): model-initiated hop via
  `handoff_renew` (no deadlock — the tool fire-and-forgets `/handoff renew go`),
  operator hop `/handoff renew`, cap enforcement, fresh successor context, zero replay,
  zero compaction; dev.2 added the byte-exact recovery-message check on the candidate
  (A-36) and the real-runtime capped-chain **finalize** proof (A-35, zero inference).
  What is **not proven**: real-concurrent multi-process state racing
  (P-5), the nominal closing point under real token accounting (P-7 — 195 k at reserve
  20 000; this project's dev.2 config reserves 5 000 ⇒ ≈210 k — the experiments
  triggered with synthetic pressure). Say so in your own projects; overclaiming is the
  failure mode this whole protocol exists to prevent.

## 7. Case study — PL/I-80 (Digital Research compiler reverse-engineering)

**Profile** (observed read-only in `~/projects/sushiworks/pli80`): multi-month goal —
reverse-engineer the CP/M-80 PL/I-80 compiler v1.4 and reimplement it in OCaml. Method
is scientific: *no claim about compiler behavior is accepted without an experiment
against the original binaries*; live truth is `spec/CLAIMS.md` (ledger of claims
`C###`, statuses `confirmed/[TBD]`, each carrying byte-level evidence and gate
results). A neutral oracle (z80pack `cpmsim -8`) runs the real compiler; `golden/`
holds captured compilations; `artefacts/` is READ-ONLY ground truth. Verification is
tiered (`tools/e2e_gate.py`: ~2 s byte panel — editing path; `--runtime` ~10 min — CI
standard gate; `--link-run` ~90 min / 817 arms — CI audit, pinned by Rune CI with
SHA-256-pinned emulator + disks). The README itself already schedules
"revisited priorities every ~10 turns". Tree ≈2.3 GB, git-tracked.

**Why it needs exactly this protocol.** Compiler RE sessions burn context on oracle
transcripts and hex dumps; the interesting state (which claim is confirmed on which
specimens, which `[TBD]` is fail-loud by design vs. a gap) lives in files, not in any
one transcript. Compaction would sever the evidence pointers — a summarized session
would "remember" conclusions without the specimen IDs that justify them, which in a
scientific project is fabrication risk, not inconvenience.

**Mapping existing pli80 practice → context-guard:**

| pli80 today | context-guard equivalent |
|---|---|
| `spec/CLAIMS.md` (domain evidence ledger, confirmed/probable/[TBD]) | stays authoritative for *compiler* claims; `LEARNINGS.md` holds *working-method* knowledge (oracle quirks, tool bugs, procedure). Cross-reference ids, never merge the ledgers |
| "no claim without experiment" | PROTOCOL.md evidence classes + acceptance rule: promotion requires reproduction run in this environment |
| rolling "Current status" section in README | `PROGRESS.md` (completed/pending/blockers) + `## Next action` in `HANDOFF.md` — the guard keeps them fresh-or-flagged instead of vibes |
| "revisited priorities every ~10 turns" | L1/L2 alerts are the machine-enforced version of exactly this rhythm |
| fail-loud `[TBD]` gates | the guard's own philosophy: refusal names its reason; validation reports, never silently "fixes" |
| `artefacts/` read-only ground truth | GOAL.md protection + read-only audit sessions; same discipline, mechanically |
| Rune CI pinned audits | keep DRPLi's gates untouched; since D8 the handoff repo runs its OWN suites (unit + real-runtime e2e, zero inference) as async `handoff-integration` builds on the same Buildbot via tac-injected builders — the guard code itself never touches CI; context-guard's own e2e drivers (`scripts/e2e-*.mjs`) stay the synchronous analogue |

**Blueprint for equipping pli80** (operator applies; nothing here was written into it):

```
pli80/AGENTS.md          ~10 lines: goal pointer, read order, verify command:
                         `python3 tools/e2e_gate.py` (fast tier) expected GREEN;
                         hard limits: artefacts/ + golden/ + oracle/disks READ-ONLY,
                         Rune CI untouched, never push
pli80/GOAL.md            objective + acceptance criteria (OCaml reimpl reproducing DR
                         bytes per claim; each phase gated)   [protectGoal: true]
pli80/PROTOCOL.md        oracle quickstart (batch.py usage), evidence rules, claim-id
                         discipline, checkpoint rules (adapted from this repo)
pli80/HANDOFF.md         recovery order + ## Next action (e.g. "widen codegen to
                         RTL-call arithmetic; gate must stay 51/51")
pli80/PROGRESS.md        phase tracker (front-end DONE/gates cited; $V IR ~90 ops;
                         codegen $C phase; next: DEC/FLOAT, control flow, I/O)
pli80/LEARNINGS.md       method knowledge; domain truth stays in spec/CLAIMS.md
pli80/handoff.config.json
                         generationReserve tuned (§4: "model" on Sushi ⇒ closing
                         ≈150k of 220k; fixed reserves trade headroom: 20000 ⇒ ≈195k,
                         this repo's dev.2 5000 ⇒ ≈210k — pick per cost policy),
                         thresholds default, renewal.enabled false at first;
                         maxSessionStates 0; stateDir .pi-guard (gitignore it)
```

Special fits for a RE project: (a) the L3 auto-checkpoint preserves substantive "Last
verified state" prose — the gate counts and claim ids survive; (b) enforced closing
(allowlist write/edit/read — plus `handoff_renew` when listed, so the model can renew
even during closing) is exactly what an oracle-heavy session needs to end safely
mid-experiment: it can still write the HANDOFF describing the dangling simulator run;
(c) read-only audit mode lets a review session inspect a candidate snapshot of the tree
byte-for-byte unchanged; (d) renewal, once the operator enables it, converts "context
full" from a project risk into a scheduled, *audited* event — chain state persists
across the switch, so a week-long renewal trail is inspectable in one JSON file.

Risks specific to pli80, stated honestly: the tree is 2.3 GB with binary artefacts —
`CONTEXT_GUARD_STATE_DIR` should stay in-tree (tiny JSON) and gitignored; oracle runs
leave `disks/` churn (already gitignored); renewal switching mid-emulator-run would
abandon a child `cpmsim` — the waitForIdle boundary does not cover *tool-spawned*
processes, so operator-triggered renewal (`/handoff renew`) is the safe default there
until proven otherwise; and token estimates over oracle transcripts can swing (A-18:
the chars/4 heuristic vs. provider-reported usage) — trust the operator's correction,
re-baseline with `/guard reset`.

## 8. Anti-patterns

- Storing durable state only in the transcript (or a compaction summary). Files are
  truth; transcripts are scratch.
- Letting the agent edit GOAL.md, or silently "tidying" the goal in HANDOFF prose.
- Treating a green mock suite as proof the guard works: **load it in the real runtime**
  after every edit (A-9/A-15 are earned lessons).
- Hunting thresholds with real inference. Synthetic mode proves the state machine;
  one live alert observation is enough for accounting sanity.
- Enabling `autoRenew` without thinking: it hands session-death timing to the model.
  The mechanism is proven; the *policy* is an operator decision (this project keeps it
  OFF by default and env-gates experiments with `CONTEXT_GUARD_AUTO_RENEW=1`).
- Claiming concurrency-safety or unobserved closing points as proven. The guard names
  its unproven edges (P-5, P-7); your PROTOCOL should too.

## 9. Reference index

- Working rules: `PROTOCOL.md` (§1 thresholds, §2 checkpoints, §2.3 audit, §6 renewal)
- API contract + config + limits: `README.md`
- Evidence per claim: `LEARNINGS.md` (key entries A-11/A-12/A-15/A-16/A-17/A-18/A-22/A-23;
  dev.2 A-26…A-36; D7 A-37; D8 A-38/A-39; docs drift A-41; open caveats P-5/P-7)
- Live proofs: `scripts/e2e-rpc-two-process.mjs` (zero inference), `scripts/e2e-renew.mjs`
  (real-inference A→B→C), `scripts/refresh-checkpoint.mjs` (post-commit ritual)
- Skill: `.agents/skills/pi-handoff/` (SKILL.md + references/commands.md + references/bootstrap.md)
