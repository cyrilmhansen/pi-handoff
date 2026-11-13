# Documentation cycle independent review mission — v1

This is Mission 2 in a distinct fresh Pi context. Independently reconstruct the result;
do not trust the apply mission's summary. Cycle `{{CYCLE_ID}}`; approved plan
SHA-256 `{{PLAN_SHA256}}`; original Git revision `{{BASE_REVISION}}`; review revision
`{{REVIEW_REVISION}}`; review source fingerprint `{{REVIEW_FINGERPRINT}}`.

Read the approved plan and compare the current documents and archives with the original
files at `{{BASE_REVISION}}` (for example, `git show REV:PATH`). Check every approved
operation, archive links and preserved excerpts, active Next action uniqueness,
instructions, provenance, and recovery-cost estimates. Specifically compare accepted,
proposed and falsified findings; negative evidence and later operator decisions must not
be deleted or rewritten as if they never happened. Verify GOAL.md is byte-identical to
its protected baseline. Handoff attestation does not validate scientific claims; report
that limitation explicitly.

Write only the independent report to `{{REVIEW_FILE}}`. It must begin with exactly:

```text
Cycle-ID: {{CYCLE_ID}}
Review-Revision: {{REVIEW_REVISION}}
Review-Fingerprint: {{REVIEW_FINGERPRINT}}
Review-Result: PASS
```

Use `Review-Result: NEEDS_CORRECTION` if any check fails or remains unclear. Include
measured versus estimated recovery costs separately, findings with document/heading and
archive paths, links checked, conclusions preserved, and unresolved work. A NO CHANGE
campaign is valid only when the approved audit itself says NO_CHANGE; it does not require
an apply or review mission. Do not edit files, repair a problem, attest, commit or change
the renewal chain from this review context.
