# Consolidate durable files after a phase or strategy change

This is an **operator-approved manual document workflow**, NOT a Pi command, an
automatic Handoff feature, or transcript compaction. Nothing here authorizes an
agent to delete evidence, rewrite GOAL.md, or start archiving when a pressure
threshold fires. Prefer doing it with adequate context **before** L3/L4.

## 1. Decide whether a consolidation is warranted

Use it when a phase is finished/abandoned, the implementation direction changes,
active documents contain competing "next actions", instructions become obsolete,
or `/guard status` shows growing recovery cost. `recovery.lean` only **defers**
reading methodology and archives; it does not shorten the active files.

Separate three classes of information:

| Material | Active authority | Historical location |
| --- | --- | --- |
| Current resume point, immediate blockers | HANDOFF.md, including **one** exact `## Next action` | Older phase resumes in reviewed archive |
| Current phase, verified milestones | PROGRESS.md, with short pointers to evidence | Detailed closed/abandoned phase records in archive |
| Lessons and failed hypotheses | LEARNINGS.md: accepted / proposed / falsified, with evidence and explicit supersession | Large explanations may be archived **with IDs, classifications and references preserved** |
| Operating procedures | AGENTS.md and PROTOCOL.md: procedures that still apply | Replaced procedures with dates/decision references |
| Project objective | GOAL.md (guard-protected) | Prior goal and separate human decision record; **operator must explicitly approve any GOAL change** |
| Domain science / golden evidence | Project-specific authoritative ledgers and artifacts | Do not move, rewrite, demote or silently consolidate these |

For example, DRPLi `spec/CLAIMS.md`, oracle transcripts and golden `.REL`
artifacts remain independently authoritative. LEARNINGS.md describes working
methods, not a replacement scientific claims ledger.

## 2. Prepare a non-mutating consolidation proposal

**Before editing anything**, report:

1. **Scope and reason**: phase, strategic choice, desired new current direction,
   and whether GOAL.md or any domain-specific truth is affected.
2. **Baseline**: `git status --short` (preserve pre-existing changes), the exact
   starting Git commit, `/guard status` full/lean recovery-cost estimates (chars/4,
   **not exact tokens**) and `/handoff verify` checkpoint classification.
3. **Move map**: for each paragraph/section, source file and heading/ID, proposed
   active replacement or removal, archive destination, source commit and the
   references to keep/update. Identify duplicate, obsolete and contradictory
   instructions explicitly, not by silent inference.
4. **Preservation guarantees**: retained evidence IDs, classifications
   (accepted/proposed/falsified), negative results, superseded-by links,
   reproduction commands and stable artifact references. Mark unresolved disputes;
   do not promote a proposal to an accepted fact.
5. **Expected recovery change**: operational-tier and full-set chars/4 estimates,
   estimated savings, readability/tradeoffs, and a short validation/rollback plan.

Show the planned changes or diff **without performing them**, and request explicit
operator approval for the specified moves, rewrites and archive location. Silence
is not consent. Any **GOAL.md** change needs separate explicit approval and
operator-controlled action; `protectGoal` still guards against agent writes.
A goal pivot must not be disguised as a PROGRESS/HANDOFF tidy-up.

## 3. Apply only the approved plan

1. Work on a reviewable Git branch with a clean or explicitly inventoried worktree.
   Preserve unrelated dirty changes. No automatic pruning, bulk deletion,
   force-push, history rewrite or blind replacement of references.
2. Create an in-repository archive such as
   `docs/history/YYYY-MM-DD-<phase-or-decision>.md` and a discoverable
   `docs/history/README.md` index (or the project's agreed equivalent).
   Archive the former direction and evidence faithfully. Each record identifies
   original file/heading, prior Git commit, decision/status/date, rationale,
   superseding active section (if any), and original evidence/IDs. Git history is
   a fallback, **not** a substitute for navigable pointers. Do not put long-term
   archives in ignored `stateDir` or ephemeral session transcripts.
3. Revise **manual prose only** in HANDOFF.md and PROGRESS.md: there must be one
   coherent current plan, an exact next action (command and expected result),
   current blockers and concise verified milestones. Link older experiments and
   abandoned directions to the archive rather than leaving competing instructions.
   Consolidate PROTOCOL.md/AGENTS.md only when their procedures actually changed.
4. Keep LEARNINGS.md a classification ledger: retain a short active index entry
   for archived accepted/proposed/**falsified** material with its exact ID, status,
   evidence and archive link. Record `superseded-by` explicitly rather than
   silently changing or deleting a previous conclusion. Domain claims ledgers,
   goldens and oracle evidence are outside this procedure.
5. **Never edit the `<!-- guard:begin checkpoint -->` managed blocks manually.**
   Do not edit GOAL.md as part of this consolidation. An approved goal change
   must use the project's separate operator-controlled procedure.

## 4. Verify, attest and record the result

1. Review `git diff --check` and the full diff. Verify every moved ID, evidence
   pointer, local link, required durable heading and unique active `## Next action`.
   Confirm that no historical evidence was invented/lost or silently reclassified.
2. Run the **project-specific** verification gate; for scientific work, retain the
   oracle/golden comparison outcome. Record failures or skipped checks honestly.
3. Commit the approved manual/archive changes. They legitimately make any previous
   Handoff checkpoint **stale**; this is expected. Then run `/handoff`,
   `/handoff verify`, `/handoff ready`, and `/guard status`. The desired result
   is checkpoint **current** + readiness **attested**. Commit the refreshed managed
   blocks separately if they changed. If readiness fails, fix it before renewal.
4. Compare **before/after** full and lean recovery estimates (chars/4), state
   whether the active next action and preserved evidence links were verified, and
   report remaining risks. Smaller documents alone do not establish success.
5. Keep the existing `renewal-state.json` chain (counters, cap, durable stop)
   intact. This documentation workflow is **not** `/guard reset`, a session
   reset, a new renewal, or permission to bypass readiness.

### Rejection and rollback

If approval is missing, the archive destination is not agreed, the proposed
edits lose evidence/IDs, or verification fails, **stop without destructive edits**.
For an applied but defective consolidation, revert the relevant Git commit(s)
through normal review, restore correct source pointers, then refresh and attest
a new checkpoint. Do not rewrite Git history or claim that a prior checkpoint
remains current after content changes.

## Example: pivot without changing the objective

A compiler project abandons an emitter strategy after falsifying a byte-exact
assumption. Keep the falsifying probe and golden comparison in the authoritative
evidence ledger. Archive the old emitter plan with its tested result and commit
reference. Update PROGRESS.md to the new implementation path and HANDOFF.md to
a single executable next action. Keep a falsified entry in LEARNINGS.md pointing
to the archive. No GOAL.md edit is implied; the new strategy still serves the
same accepted objective.
