# Upgrade an existing Pi Handoff installation

This procedure updates project-local extension files while preserving the project's
operational and scientific state. Perform it during a maintenance window with all Pi
processes for the checkout stopped. Do not use `git clean`, `git reset --hard`,
`rsync --delete`, or broad directory deletion.

## 1. Preflight

Record the target project path and identify:

- Installed Handoff version from the identity banner / `DEFAULT_GUARD_VERSION` in
  `.pi/extensions/context-guard/index.ts`.
- `pi --version`, the resolved Pi executable, and `node --version`.
- Project Git checkout, `git rev-parse HEAD`, `git status --short --ignored`, and whether
  the process uses legacy root documents or an explicit `missionInstance.id` /
  `CONTEXT_GUARD_MISSION_INSTANCE`.
- The effective `stateDir`: inspect `handoff.config.json`, process environment and any
  launch wrapper. Resolve relative paths from the project root. Record and separately
  identify every external state directory.
- All Pi processes using this checkout/instance. Stop them normally and verify they have
  exited before copying, replacing modules or examining a lock as abandoned.
- `.owner.lock`, `.owner.lock.recovery`, `.publish.lock`, `closure.pending`, cycle state,
  and any transaction journal or temporary publication/closure records. An uncertain or
  interrupted lock/transaction must be inspected and handled by its documented operator
  recovery procedure before upgrade; never remove it to make the upgrade proceed.

If the source version or active instance cannot be determined, stop before changing any
file.

## 2. Cold backup and manifest

Store the backup outside the project checkout on storage with sufficient capacity and
appropriate access controls. A cold backup must preserve tracked, ignored and untracked
project data relevant to recovery, including operational documents, `.pi-handoff/`, the
project configuration, `.pi-guard/`, and all external `stateDir` contents. Preserve
symlinks and file metadata. Pi transcripts are stored separately by Pi; include their
storage in the cold backup if they are needed for operator audit, though Handoff recovery
does not replay them.

Example using a backup directory that already exists on a suitable backup volume:

```bash
PROJECT=/absolute/path/to/project
BACKUP=/absolute/path/to/backup/rc1-pre-upgrade
mkdir -m 700 "$BACKUP"
printf '%s\n' "$(git -C "$PROJECT" rev-parse HEAD)" > "$BACKUP/git-head.txt"
git -C "$PROJECT" status --short --ignored > "$BACKUP/git-status.txt"
tar -cpf "$BACKUP/project.tar" -C "$(dirname "$PROJECT")" "$(basename "$PROJECT")"
# Repeat with an explicit archive for each external stateDir, using a unique archive name.
find "$BACKUP" -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 sha256sum > "$BACKUP/SHA256SUMS"
```

Do not place `BACKUP` inside `PROJECT`. Record each external state path next to its archive.
Verify the manifest and test that the archives can be listed/read before proceeding. Do
not edit or prune the source after taking the backup. A backup is useful only if the
project documents and transaction state are from the same cold snapshot.

## 3. Stage, verify and replace

Obtain the published RC from the immutable tag using `docs/deployment.md`. Extract the
extension, skill and (if used) `scripts/durable_edit.py` into a staging location first.
Keep the staging location on the same filesystem as the target directories for rename
operations. Verify the staged extension has exactly the 12 `.ts` modules listed in
`docs/deployment.md`, with no extra or missing module. Record SHA-256 hashes for the
staged modules, the skill tree and utility. Compare the staged files to the verified RC
checkout and retain that hash manifest with the backup.

Before replacing anything, make a separate copy of the old extension and old skill in
the backup. Then, with Pi stopped:

1. Rename the old extension directory to a versioned backup name beside it; rename the
   complete staged extension directory into `.pi/extensions/context-guard/`.
2. Repeat for `.agents/skills/pi-handoff/`. If the project uses `scripts/durable_edit.py`,
   back it up and replace only that file.
3. Verify the installed module list and hashes against the staging manifest. Confirm no
   files from the previous extension version remain mixed into the replacement.
4. If a rename or verification fails, stop and restore the just-backed-up old directory
   before starting Pi. Keep both copies until post-upgrade checks pass.

Do not replace or copy the candidate's `handoff.config.json`. Merge any desired setting
manually after separately reviewing its effect. Do not modify project protocols or state
as part of file installation.

The replacement is recoverable because the old complete directories are retained and
Pi is stopped. Do not delete those copies after a failed or uncertain install.

## 4. Restart and inspect

Start Pi with the installed extension, initially without a model prompt. Verify the
identity banner's version and the actual Pi/Node versions. Then check:

```text
/guard status
/handoff status
/handoff verify
/handoff renew status
```

When an explicit mission instance is selected, also check `/handoff instance status`.
Confirm the expected project and instance, checkpoint freshness, attestation, chain
identity/counter, and valid/missing/corrupt transaction classification. A missing,
corrupt, incomplete, cross-instance or generation-incoherent state is a legitimate
fail-closed refusal. Stop and restore a coherent cold backup or investigate through the
operator procedure; do not initialize state, attest a checkpoint to manufacture
permission, or treat installation as a new chain.

Valid historical renewal-state schema v1 records remain compatible, including valid
records from before the optional `stopped` field. Checkpoint schema v3 is unchanged.
A historical chain whose state is missing does not become a new/empty chain after this
upgrade; restore the coherent state backup or make a separate, explicit operator
decision to create a different mission identity for new work, preserving the old
identity and evidence.

## 5. Rollback

### Before the RC has mutated new state

If no new checkpoint, attestation, renewal, closure, publication or cycle transition has
occurred, an operator may stop Pi, verify and retain the cold backup, then restore the
previous extension and skill directories. Preserve the RC files and logs for diagnosis.
Verify the old runtime loads and that the restored transaction state matches the backup
before resuming.

### After the RC has written new operational or transaction state

Do not simply reinstall old modules and continue on the newer state. First stop all Pi
processes and preserve the entire post-incident project, `.pi-handoff/`, internal and
external `stateDir`, and relevant Pi transcripts as a separate forensic snapshot with a
new manifest. Then restore the pre-upgrade cold backup in an isolated copy and verify
compatibility and transaction integrity there. Compare the post-incident snapshot to the
backup; manually review and re-integrate any new scientific evidence or work only after
checking provenance and conflicts. A checkpoint, closure or publication is not itself
scientific validation.

Never delete the post-incident state to make rollback appear clean. Do not reuse a
consumed checkpoint, reset a chain, remove a closure/publication, or overwrite new work
silently. If restoration cannot establish a coherent project and state directory, keep
both snapshots and stop for operator review.
