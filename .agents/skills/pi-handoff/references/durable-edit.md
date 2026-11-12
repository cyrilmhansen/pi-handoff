# Safe edits and read-only document audit

Use the repository's `scripts/durable_edit.py` directly from the agent's Bash tool;
do not construct a one-off Python replacement script. It reuses exact Markdown
heading boundaries and preserves bytes outside the selected section. These
operations are optional: ordinary file tools remain available for exceptional
edits.

## Read-only inventory

```bash
python3 scripts/durable_edit.py audit --root .
```

Add `--json` for a structured report. The audit reports the unique active `HANDOFF.md`
`## Next action` (or missing/ambiguous state), duplicated active headings, possible
HANDOFF/PROGRESS action conflicts, missing archive links, likely historical headings,
document sizes and chars/4 recovery estimates. A clean inventory says `NO CHANGE`.
The audit only suggests review; it never edits, archives, consolidates, checkpoints or
attests. Its archive and conflict findings are heuristics, not decisions about project
truth. Checkpoint labels are metadata only: call `handoff_inspect` for verified
freshness/attestation and renewal status.

The report labels `chars / 4` as an estimate, not model token accounting. To distinguish
document prose from Handoff's generated Markdown and from live Git state, inspect each
source separately:

```bash
git status --short -- HANDOFF.md PROGRESS.md LEARNINGS.md
git diff -- HANDOFF.md PROGRESS.md LEARNINGS.md
git diff --cached -- HANDOFF.md PROGRESS.md LEARNINGS.md
handoff_inspect
```

The diff shows manual prose and `guard:begin checkpoint` blocks in their file regions;
`handoff_inspect` reports checkpoint identity, freshness, attestation and renewal gate;
Git status reports staged/unstaged worktree state. Attestation does not mean code is
committed, validated or pushed. Do not infer publication from checkpoint state or a
clean worktree.

## Append or replace one exact section

1. Read the target section from the current file. Use `hash` to capture the source
   fingerprint and `plan` to review the diff:

   ```bash
   python3 scripts/durable_edit.py hash HANDOFF.md
   python3 scripts/durable_edit.py plan HANDOFF.md --section '## Next action' \
     --mode replace --text-file /path/to/replacement.md --json
   ```

   `--mode append` adds to a selected section; `replace` replaces only its body.
   `--text-file` preserves multiline text, indentation and Unicode. Use `--check-refs`
   with `--root .` when adding path-like evidence references; this checks existence only.

2. Apply only the reviewed result and pass the exact `current_sha256` shown by `plan`:

   ```bash
   python3 scripts/durable_edit.py apply HANDOFF.md --section '## Next action' \
     --mode replace --text-file /path/to/replacement.md \
     --expect-sha256 <reviewed-current-sha256>
   ```

   Apply refuses a missing or stale hash. Missing or duplicate anchors fail closed.
   The unified diff and proposed hash make the changed section reviewable; non-target
   bytes stay unchanged. A Handoff managed block is never an editable target. Editing
   manual HANDOFF/PROGRESS prose makes its checkpoint stale until the guard refreshes it.

## Archive a closed section

Archiving is a two-file, preview-first move into an ordinary in-repository Markdown
archive. The source and archive must both be inside `--root`; the archive's parent
directory must already exist. Give every archive entry a unique heading. For an active
`## Next action`, provide the replacement body so the source retains one current action.

```bash
python3 scripts/durable_edit.py archive-plan HANDOFF.md \
  --section '## Next action' \
  --archive-file docs/history/decisions.md \
  --archive-heading '### E2E-49/P4 closed 2026-11-13' \
  --text-file /path/to/new-next-action.md --root . --json
```

Review **both** diffs. The plan prints the source and archive hashes; an absent archive
is reported as `absent`. Apply those same arguments and both exact hashes:

```bash
python3 scripts/durable_edit.py archive-apply HANDOFF.md \
  --section '## Next action' \
  --archive-file docs/history/decisions.md \
  --archive-heading '### E2E-49/P4 closed 2026-11-13' \
  --text-file /path/to/new-next-action.md --root . \
  --expect-sha256 <source-hash> --expect-archive-sha256 <archive-hash-or-absent>
```

The archived heading and body are copied as-is under the archive entry, with source path
and hash. Conflicts are checked before either write. Both output files are staged before
replacement; if the source replacement fails after the archive is installed, the tool
rolls the archive back and reports any rollback failure explicitly. It refuses an
ambiguous source, duplicate archive entry, managed-block archive target, or a stale
hash. Inspect both files and the Git diff after apply.

For any historical/scientific record, keep the original preregistered prediction, the
observation that falsified it, and the later operator decision distinct and traceable.
Never rewrite a falsified hypothesis as if it had always been correct. This utility does
not judge claims or grant authority to change `GOAL.md`; follow the separate operator
approval procedure in `consolidation.md` before archival or strategy consolidation.
Auditing alone never authorizes edits.
