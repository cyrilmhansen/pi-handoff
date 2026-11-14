# Installation and supervised pilot deployment

`v0.1.0-rc.1` is an **experimental prerelease** for supervised pilot use. It is not a
production-ready claim. The package is a set of project-local files; there is no npm
package or automatic installer. Installation, skill discovery and project configuration
are separate operations.

## Obtain and verify the published candidate

The tag does not exist until the RC is published. After publication, a clean source copy
can be obtained with:

```bash
git clone --branch v0.1.0-rc.1 --depth 1 \
  https://github.com/cyrilmhansen/pi-handoff.git \
  /tmp/pi-handoff-rc1
```

Compare the checked-out commit to the commit named by the GitHub Release and verify the
tag points to that exact commit. Substitute the published commit for `EXPECTED_COMMIT`:

```bash
cd /tmp/pi-handoff-rc1
test "$(git rev-parse HEAD)" = "EXPECTED_COMMIT"
test "$(git rev-parse 'v0.1.0-rc.1^{commit}')" = "EXPECTED_COMMIT"
git describe --tags --exact-match HEAD | grep -Fx 'v0.1.0-rc.1'
grep -F 'DEFAULT_GUARD_VERSION = "0.1.0-rc.1"' .pi/extensions/context-guard/index.ts
```

Do not use a moving branch as the installation source. Keep the verified clone read-only
as the source for copying files.

## Install the extension

Install only these **12 TypeScript modules** together, as one versioned directory:

```text
.pi/extensions/context-guard/index.ts
.pi/extensions/context-guard/core.ts
.pi/extensions/context-guard/config.ts
.pi/extensions/context-guard/checkpoint.ts
.pi/extensions/context-guard/renewal.ts
.pi/extensions/context-guard/recovery.ts
.pi/extensions/context-guard/diagnostics.ts
.pi/extensions/context-guard/documentation-cycle.ts
.pi/extensions/context-guard/mission-instance.ts
.pi/extensions/context-guard/mission-lock.ts
.pi/extensions/context-guard/mission-lifecycle.ts
.pi/extensions/context-guard/knowledge.ts
```

The list is the complete local TypeScript import closure of `index.ts` in this RC. Do not
combine it with modules from another version. Pi loads TypeScript directly; no build step
or extension-specific dependency installation is required. Node must support the
repository's TypeScript test/runtime requirements (Node 23 or newer is used here).

`docs/upgrade.md` describes staging, backups, hash manifests and replacement for an
existing installation. The extension is loaded explicitly with
`pi -e <project>/.pi/extensions/context-guard/index.ts`, or through Pi project trust.
Trust and extension loading are runtime configuration choices; copying files alone does
not select the project or instance.

## Install the skill separately

Copy the complete `.agents/skills/pi-handoff/` directory, including `SKILL.md` and all
`references/`. Pi skill discovery is separately gated by project trust. The skill gives
the agent operational guidance; it is not the extension and does not provide any
operator authorization.

## Configure the target project separately

Do not copy `handoff.config.json` over the target project's configuration. Review and
merge keys manually only when needed. In particular, keep the pilot on
`renewal.successorTurn: "custom"` and `documentation.enabled: false`; leave
`renewal.autoRenew` disabled until an operator has observed a successful operator-triggered
renewal and explicitly decides to enable the model path. Existing valid legacy renewal
state v1 is supported. Missing/corrupt/incoherent chain state is refused; it must be
restored from a coherent backup, never initialized by installation.

The optional structured document editor is `scripts/durable_edit.py` (Python standard
library only). Install it at the same relative path if the target project uses the
structured edit/audit workflows. It is not needed to load the extension. Do not copy the
rest of the repository into the project merely to install Handoff.

Never replace target project files or data during installation. This includes
`GOAL.md`, `PROTOCOL.md`, `AGENTS.md`, `HANDOFF.md`, `PROGRESS.md`, `LEARNINGS.md`,
`handoff.config.json`, `.pi-guard/`, external `stateDir` contents, `.pi-handoff/`, work
profiles, mission instances, knowledge records, goldens, claims, sources, tests and other
scientific or project evidence. Do not migrate, reset, clean or initialize them as part of
installation.

## DRPLi pilot procedure

This procedure is for a later, operator-approved pilot. **No DRPLi files are modified by
this RC preparation.** The release qualification supports cautious observation, not an
unattended deployment:

1. Stop all Pi processes using the DRPLi checkout. Make a cold, verified backup of the
   complete project and every Handoff `stateDir`, including any external path. Record
   the Git revision, ignored/untracked state and SHA-256 manifest. See `docs/upgrade.md`.
2. Install the 12 extension modules and the complete skill directory using the staged
   procedure. Preserve project configuration and all operational/scientific data. Do not
   force a new mission instance if the existing historical mode and valid transaction
   state work.
3. Start Pi without sending a model prompt. Confirm the identity banner reports
   `0.1.0-rc.1` and the actual Pi version. Run `/guard status`, `/handoff status`,
   `/handoff verify`, and `/handoff renew status`; if an explicit instance is selected,
   also run `/handoff instance status`. Confirm the selected project/instance, checkpoint,
   attestation, chain counter and state classification. Missing/corrupt/incoherent state
   is a legitimate refusal: stop and restore a coherent backup; do not bootstrap it.
4. Begin one short, bounded real task under operator supervision. Keep
   `renewal.successorTurn: "custom"` and `documentation.enabled: false`. Finish a safe
   durable checkpoint and attestation using the existing project protocol.
5. Make the first renewal operator-triggered. Verify the new Pi session, same mission
   owner, chain counter, consumed checkpoint identity and durable-only recovery before
   continuing. Real renewals with the RC code were not qualified by Q3, so observe and
   review this transition directly.
6. Only after an operator-triggered renewal has been observed and reviewed as successful
   may the operator separately enable `renewal.autoRenew`. Do not enable it by default or
   as part of installation. Keep the documentation cycle disabled for this first pilot;
   its inference-driven workflow was not qualified.
7. At the end of the bounded task, record the runtime versions, observed transitions,
   refusals, test/recovery outcomes and any discrepancies in a reviewable pilot report.
   Do not claim scientific validation from checkpoint attestation.

If a new mission instance is specifically desired, create it explicitly through
`/handoff instance create <new-id>` while in the operator bootstrap context, then select
that ID for a new Pi process. Creation gives it its own empty operational documents and
chain; it does not inherit `Next action` or `LEARNINGS.md`. Do not use this path to repair
or replace a historical mission whose transaction state is missing.
