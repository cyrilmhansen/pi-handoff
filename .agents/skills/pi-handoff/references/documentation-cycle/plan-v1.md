# Documentation cycle plan mission — v1

This is Mission 1, a read-only audit in a fresh Pi context. Do not edit, archive,
approve, attest, commit, push, or alter any renewal state. Read the project procedure
and relevant durable files, including the `pi-handoff` skill's `references/consolidation.md`.

Cycle: `{{CYCLE_ID}}`
Base Git revision: `{{BASE_REVISION}}`
Base source fingerprint: `{{BASE_FINGERPRINT}}`
Protected GOAL fingerprint: `{{GOAL_FINGERPRINT}}`
Write only the audit/plan artifact to: `{{PLAN_FILE}}`

Use `python3 scripts/durable_edit.py audit --root . --json` as a read-only inventory.
Inspect the relevant source documents and Git baseline. Identify outdated or duplicate
operational instructions, conflicting active Next actions, broken/missing archive
references, and estimated full/lean recovery costs. Distinguish observations from
recommendations. Preserve rejected hypotheses, negative results, operator decisions,
scientific evidence and provenance. Do not infer scientific correctness from a Handoff
attestation. GOAL.md is protected and must not be a target.

The artifact must begin with exactly these metadata lines (replace bracketed values):

```text
Cycle-ID: {{CYCLE_ID}}
Base-Revision: {{BASE_REVISION}}
Base-Fingerprint: {{BASE_FINGERPRINT}}
Result: CHANGE
Target-Files: HANDOFF.md, PROGRESS.md, LEARNINGS.md, docs/history/...
```

Set `Result: NO_CHANGE` and `Target-Files: none` only when the audit finds no justified
document change. Otherwise use `CHANGE` and provide a bounded, ordered operation list.
For each proposed edit/archive, name the exact document and heading, intended operation,
source SHA-256, archive path if relevant, and evidence/reference checks. Include projected
cost changes as estimates; do not claim token savings without observed measurements.

End with unresolved questions and an explicit statement that this is a proposal only.
Never write the durable documents during this mission.
