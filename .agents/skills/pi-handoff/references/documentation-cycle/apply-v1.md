# Documentation cycle apply mission — v1

This is the approved application stage in a fresh Pi context. Operator approval is bound
to the exact plan SHA-256 `{{PLAN_SHA256}}`, cycle `{{CYCLE_ID}}`, base revision
`{{BASE_REVISION}}`, and source fingerprint `{{BASE_FINGERPRINT}}`. Read the plan at
`{{PLAN_FILE}}` and check its hash before doing anything. If it differs, stop and report
the conflict. The configured archive destination is `{{ARCHIVE_DIR}}`.

Apply only the operations explicitly listed in the approved plan. Use
`python3 scripts/durable_edit.py plan` / `archive-plan` to preview each operation, inspect
the diff and exact hashes, then use the matching `apply` / `archive-apply` command with
those hashes. Never build an ad-hoc second editor or rewrite whole documents. Do not
change GOAL.md, scientific evidence, falsified hypotheses, operator instructions or
checkpoint-managed blocks. Do not stage, commit, push, clean, delete unrelated files, or
reset renewal state. Preserve every original excerpt in its approved archive target.

If a conflict, stale hash, ambiguous heading, missing reference or partial multi-step
application occurs, stop. Keep all existing data and report the completed operations and
the exact repair needed; do not retry destructively. Do not claim that the work is
scientifically validated.
