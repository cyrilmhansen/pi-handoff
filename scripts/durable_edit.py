#!/usr/bin/env python3
"""durable_edit.py — targeted, deterministic edits to durable markdown documents.

dev.2 D3 (pi-handoff v0.1.0-dev.2): successors in long renewal chains re-read and
REWRITE whole durable documents (DRPLi campaign: 583 609 chars of durable-doc read
results across 8 successors, A-27). This tool replaces that pattern with exact-section
edits that are cheap, reviewable and safe:

  * DRY RUN FIRST: `plan` prints a unified diff + current/proposed sha256; `apply`
    requires the reviewed current hash and performs the identical computation.
  * EXACT SECTION TARGETING: the target heading line must match EXACTLY
    (level + text). Zero matches -> NOT_FOUND; several -> AMBIGUOUS. Never guessed.
  * CONCURRENCY PROTECTION: --expect-sha256 (computed by `hash` at read time) must
    still match the file at apply time, else CONFLICT — a concurrent writer is
    refused, never silently overwritten.
  * ATOMIC REPLACEMENT: write to a temp file in the SAME directory, fsync, then
    os.replace(). An interrupted apply leaves the ORIGINAL byte-identical.
  * BYTE-IDENTICAL NON-TARGET CONTENT: the file is sliced around the section; lines
    outside the target are copied verbatim (no reformatting, no newline rewriting).
  * MANAGED BLOCKS ARE OFF-LIMITS: a section containing guard checkpoint markers is
    refused (MANAGED_BLOCK). The guard's OWN transaction (writeCheckpoint +
    attestHandoff via /handoff, /handoff ready, /handoff finalize) stays the single
    writer of managed content — this tool REUSES that machinery instead of rebuilding
    it; after a prose edit it prints the refresh hint.
  * EVIDENCE-REFERENCE EXISTENCE (--check-refs): path-like references inside the new
    text must exist under --root. This is an EXISTENCE check only — the tool never
    judges, edits or inventates scientific content ("without fabricating conclusions").
  * `audit` inventories durable files read-only and can return `NO CHANGE`; it never
    consolidates or edits based on its findings.
  * `archive-plan`/`archive-apply` move one exact section to an in-project archive,
    optionally replacing the source section, and show both diffs. Both source and
    archive hashes are required at apply time; both outputs are staged before either
    replacement, with archive rollback if the source replacement fails.
  * NO GIT SIDE EFFECTS: this tool never runs git (no staging, no clean, no
    checkout). Ignored/untracked data is not touched.

Not a general editor: markdown durable documents only, UTF-8 only, section granularity
only. Exit codes: 0 ok, 2 usage, 3 not-found/ambiguous, 4 managed-block target,
5 hash conflict, 6 missing evidence reference, 7 io error / atomicity preserved.
"""

import argparse
import difflib
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

GUARD_MARKER_RE = re.compile(r"<!--\s*guard:(begin|end)\b")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
# path-like evidence references: must contain a '/' and a known document extension.
REF_RE = re.compile(
    r"(?<![\w/.-])((?:[A-Za-z0-9_][A-Za-z0-9_.+-]*[/])+[A-Za-z0-9_][A-Za-z0-9_.+-]*"
    r"\.(?:md|markdown|json|jsonl|txt|log|csv|pli|py|mjs|js|sh|ebnf|ml|pdf|png|jpg|tar|gz|zst))\b"
)

EXIT_OK, EXIT_USAGE, EXIT_NOTFOUND, EXIT_MANAGED, EXIT_CONFLICT, EXIT_MISSING_REF, EXIT_IO = 0, 2, 3, 4, 5, 6, 7

DEFAULT_AUDIT_DOCS = (
    ("AGENTS.md", "methodology"),
    ("PROTOCOL.md", "methodology"),
    ("GOAL.md", "goal"),
    ("HANDOFF.md", "operational"),
    ("PROGRESS.md", "operational"),
    ("LEARNINGS.md", "archive"),
)
ARCHIVE_HEADER = "# Archived operational sections\n\n"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_lines(data: bytes):
    """Split bytes into lines keeping terminators; UTF-8 only (fail safe)."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        fail(EXIT_IO, f"E_ENCODING: not valid UTF-8: {exc}")
    return text, text.splitlines(keepends=True)


def fail(code: int, msg: str):
    print(msg, file=sys.stderr)
    sys.exit(code)


def heading_level(line: str):
    m = re.match(r"^(#{1,6}) +(\S.*)$", line.rstrip("\r\n"))
    if not m:
        return None, None
    return len(m.group(1)), m.group(2).strip()


def find_sections(lines, section_heading):
    """All exact-match heading indices (level + text) for `section_heading`."""
    want = section_heading.strip()
    wl, wt = heading_level(want)
    if wl is None:
        wl, wt = heading_level("# " + want)
    hits = []
    fence = False
    for i, ln in enumerate(lines):
        if FENCE_RE.match(ln):
            fence = not fence
            continue
        if fence:
            continue
        level, text = heading_level(ln)
        if level == wl and text == wt:
            hits.append(i)
    return wl, hits


def section_bounds(lines, start_idx, level):
    """Section = heading line up to (excluding) the next heading of level <= `level`
    OR the first guard checkpoint marker (managed content is NEVER in the editable
    range: a trailing managed block after the last prose heading stays untouched)."""
    fence = False
    for j in range(start_idx + 1, len(lines)):
        if FENCE_RE.match(lines[j]):
            fence = not fence
            continue
        if fence:
            continue
        if GUARD_MARKER_RE.search(lines[j]):
            return start_idx, j  # exclusive end (before the managed block)
        l, _ = heading_level(lines[j])
        if l is not None and l <= level:
            return start_idx, j  # exclusive end
    return start_idx, len(lines)


def check_managed(lines, a, b, path):
    for i in range(a, b):
        if GUARD_MARKER_RE.search(lines[i]):
            fail(
                EXIT_MANAGED,
                f"MANAGED_BLOCK: {path}:{i + 1} lies inside a guard checkpoint block. "
                "Managed content belongs to the guard transaction ONLY: run /handoff "
                "(or /handoff finalize) to refresh + attest; edit the MANUAL prose outside markers instead.",
            )


def check_refs(body_text, root):
    refs = sorted(set(REF_RE.findall(body_text)))
    missing = [r for r in refs if not os.path.exists(os.path.join(root, r))]
    return refs, missing


def build_new_section(mode, heading_line, old_section_lines, body):
    """Compose the replacement lines: exact bytes outside the section are untouched."""
    body_lines = body.splitlines(keepends=True)
    if body_lines and not body_lines[-1].endswith(("\n", "\r")):
        body_lines[-1] += "\n"
    if mode == "replace":
        return [heading_line] + body_lines
    if mode == "append":
        out = list(old_section_lines)
        if out and not out[-1].endswith(("\n", "\r")):
            out[-1] += "\n"
        if out and out[-1].strip():  # blank separator line between old body and new body
            out.append("\n")
        return out + body_lines
    if mode == "prepend":
        # heading, then new body, then the old body (skip the old heading line itself)
        rest = list(old_section_lines[1:])
        return [heading_line] + body_lines + rest
    fail(EXIT_USAGE, f"USAGE: unknown mode {mode!r}")


def realpath_inside(path, root):
    """Resolve an existing path, or a new file below an existing parent, under root."""
    root_real = os.path.realpath(root)
    absolute = os.path.abspath(path)
    if os.path.lexists(absolute):
        resolved = os.path.realpath(absolute)
    else:
        parent = os.path.realpath(os.path.dirname(absolute) or ".")
        resolved = os.path.join(parent, os.path.basename(absolute))
    try:
        inside = os.path.commonpath((root_real, resolved)) == root_real
    except ValueError:
        inside = False
    if not inside:
        fail(EXIT_IO, f"PATH_OUTSIDE_ROOT: {path!r} resolves outside {root_real}")
    return resolved


def markdown_headings(lines):
    """Return real Markdown headings, ignoring fenced-code examples."""
    out = []
    fence = None
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if m:
            marker = m.group(1)
            if fence is None:
                fence = marker[:3]
            elif marker.startswith(fence[0]):
                fence = None
            continue
        if fence is not None:
            continue
        level, title = heading_level(line)
        if level is not None:
            out.append({"line": i + 1, "index": i, "level": level, "title": title})
    return out


def strip_managed_checkpoint(text):
    """Remove complete checkpoint blocks for prose-only document analysis."""
    pattern = re.compile(r"<!--\s*guard:begin checkpoint\s*-->[\s\S]*?<!--\s*guard:end checkpoint\s*-->\s*", re.I)
    return pattern.sub("", text)


def managed_checkpoint_summary(text):
    begin = "<!-- guard:begin checkpoint -->"
    end = "<!-- guard:end checkpoint -->"
    start = text.find(begin)
    if start < 0:
        return {"present": False, "valid_pair": False, "bytes": 0, "generation": None, "id": None, "readiness": None}
    stop = text.find(end, start + len(begin))
    if stop < 0:
        return {"present": True, "valid_pair": False, "bytes": len(text[start:].encode("utf-8")), "generation": None, "id": None, "readiness": None}
    block = text[start:stop + len(end)]
    def field(name):
        m = re.search(rf"(?m)^{re.escape(name)}:\s*(.*?)\s*$", block)
        return m.group(1) if m else None
    return {
        "present": True,
        "valid_pair": True,
        "bytes": len(block.encode("utf-8")),
        "generation": field("checkpoint-generation"),
        "id": field("checkpoint-id"),
        "readiness": field("readiness"),
    }


def section_body(lines, heading_index, level):
    _, end = section_bounds(lines, heading_index, level)
    return "".join(lines[heading_index + 1:end]).strip()


def audit_documents(root):
    """Read-only operational-document inventory; findings are prompts for review, never edits."""
    metrics = {}
    findings = []
    candidates = []
    known_active = {"next action", "current phase", "pending", "blockers", "unfinished operations"}
    stale_words = re.compile(r"\b(?:archive|archived|historical|obsolete|superseded|abandoned|completed|legacy)\b", re.I)
    archive_words = re.compile(r"\b(?:archive|archived|history|historical|superseded)\b", re.I)
    next_actions = {}

    for relative, tier in DEFAULT_AUDIT_DOCS:
        path = os.path.join(root, relative)
        try:
            with open(path, "rb") as source:
                raw = source.read()
        except FileNotFoundError:
            findings.append({"kind": "missing-document", "file": relative})
            continue
        except OSError as exc:
            findings.append({"kind": "unreadable-document", "file": relative, "detail": str(exc)})
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            findings.append({"kind": "invalid-utf8", "file": relative})
            continue
        prose = strip_managed_checkpoint(text) if relative in ("HANDOFF.md", "PROGRESS.md") else text
        _, lines = read_lines(prose.encode("utf-8"))
        headings = markdown_headings(lines)
        managed = managed_checkpoint_summary(text) if relative in ("HANDOFF.md", "PROGRESS.md") else None
        metrics[relative] = {
            "bytes": len(raw),
            "characters": len(text),
            "chars_div_4_estimate": len(text) / 4,
            "recovery_tier": tier,
            "managed_checkpoint": managed,
            "managed_checkpoint_bytes": managed["bytes"] if managed else 0,
            "manual_prose_and_other_bytes": len(raw) - (managed["bytes"] if managed else 0),
        }

        counts = {}
        for heading in headings:
            canonical = re.sub(r"\s+", " ", heading["title"]).strip().casefold()
            semantic = "next action" if re.match(r"^next action(?:$|\s+[—:-].*)$", canonical) else canonical
            counts.setdefault(semantic, []).append(heading)
            standard_learnings = relative == "LEARNINGS.md" and canonical in {"accepted", "proposed", "falsified or superseded"}
            if not standard_learnings and stale_words.search(heading["title"]):
                candidates.append({"file": relative, "heading": "#" * heading["level"] + " " + heading["title"], "line": heading["line"], "reason": "historical/closed wording in heading; review for archival"})
        for title, hits in counts.items():
            if len(hits) > 1 and title in known_active:
                findings.append({"kind": "duplicate-active-heading", "file": relative, "heading": title, "lines": [h["line"] for h in hits]})

        if relative in ("HANDOFF.md", "PROGRESS.md"):
            actions = [h for h in headings if h["level"] == 2 and re.match(r"^next action(?:$|\s+[—:-].*)$", h["title"], re.I)]
            next_actions[relative] = [
                {"heading": "## " + h["title"], "line": h["line"], "text": section_body(lines, h["index"], h["level"])}
                for h in actions
            ]

        for line_no, line in enumerate(prose.splitlines(), 1):
            if not archive_words.search(line):
                continue
            for ref in REF_RE.findall(line):
                target = os.path.join(root, ref)
                if not os.path.exists(target):
                    findings.append({"kind": "missing-archive-reference", "file": relative, "line": line_no, "reference": ref})

    handoff_actions = next_actions.get("HANDOFF.md", [])
    progress_actions = next_actions.get("PROGRESS.md", [])
    if len(handoff_actions) == 0:
        findings.append({"kind": "active-next-action-missing", "file": "HANDOFF.md"})
    elif len(handoff_actions) > 1:
        findings.append({"kind": "active-next-action-ambiguous", "file": "HANDOFF.md", "lines": [a["line"] for a in handoff_actions]})
    if len(progress_actions) > 1:
        findings.append({"kind": "duplicate-active-next-action", "file": "PROGRESS.md", "lines": [a["line"] for a in progress_actions]})
    if handoff_actions and len(progress_actions) == 1:
        ptext = re.sub(r"\s+", " ", progress_actions[0]["text"]).strip()
        for action in handoff_actions:
            htext = re.sub(r"\s+", " ", action["text"]).strip()
            if htext and ptext and htext.casefold() != ptext.casefold():
                findings.append({
                    "kind": "possible-next-action-conflict",
                    "handoff_candidate": {"file": "HANDOFF.md", **action},
                    "comparison": {"file": "PROGRESS.md", **progress_actions[0]},
                    "detail": "manual wording differs; review whether the two operational files describe the same next step",
                })

    full_chars = sum(metrics[name]["characters"] for name, tier in DEFAULT_AUDIT_DOCS if tier in ("methodology", "goal", "operational", "archive") and name in metrics)
    operational_chars = sum(metrics[name]["characters"] for name in ("HANDOFF.md", "PROGRESS.md") if name in metrics)
    summary = {
        "documents": metrics,
        "recovery_cost_estimates": {
            "basis": "characters / 4; estimate, not measured model tokens",
            "full_six_characters": full_chars,
            "full_six_chars_div_4_estimate": full_chars / 4,
            "lean_operational_characters": operational_chars,
            "lean_operational_chars_div_4_estimate": operational_chars / 4,
        },
        "active_next_action": {
            "authoritative_file": "HANDOFF.md",
            "status": "unique" if len(handoff_actions) == 1 else "missing" if not handoff_actions else "ambiguous",
            "matches": handoff_actions,
        },
        "findings": findings,
        "archive_candidates": candidates,
        "result": "NO CHANGE" if not findings and not candidates else "REVIEW SUGGESTED",
        "mutated": False,
    }
    return summary


def archive_plan(args, apply=False):
    """Build a two-file move plan, preserving the original section in an archive."""
    root = os.path.realpath(args.root)
    source_input = args.file if os.path.isabs(args.file) else os.path.join(root, args.file)
    archive_input = args.archive_file if os.path.isabs(args.archive_file) else os.path.join(root, args.archive_file)
    source_path = realpath_inside(source_input, root)
    archive_path = realpath_inside(archive_input, root)
    if source_path == archive_path:
        fail(EXIT_USAGE, "USAGE: --archive-file must differ from the source file")
    if not os.path.isdir(os.path.dirname(archive_path)):
        fail(EXIT_IO, f"IO: archive parent directory does not exist: {os.path.dirname(archive_path)}")
    try:
        with open(source_path, "rb") as source:
            source_bytes = source.read()
        if os.path.exists(archive_path):
            with open(archive_path, "rb") as archive:
                archive_bytes = archive.read()
        else:
            archive_bytes = None
    except OSError as exc:
        fail(EXIT_IO, f"IO: cannot read archive source/destination: {exc}")
    source_hash = sha256_bytes(source_bytes)
    archive_hash = sha256_bytes(archive_bytes) if archive_bytes is not None else "absent"
    if args.expect_sha256 and args.expect_sha256.strip().lower() != source_hash:
        fail(EXIT_CONFLICT, f"CONFLICT: {args.file} expected {args.expect_sha256.strip().lower()[:12]}…, actual {source_hash[:12]}…; re-read and re-plan")
    if apply and not args.expect_sha256:
        fail(EXIT_USAGE, "USAGE: archive-apply requires --expect-sha256 from the reviewed archive-plan")
    if apply and not args.expect_archive_sha256:
        fail(EXIT_USAGE, "USAGE: archive-apply requires --expect-archive-sha256 from the reviewed archive-plan (use 'absent' for a new archive)")
    if args.expect_archive_sha256 and args.expect_archive_sha256.strip().lower() != archive_hash:
        fail(EXIT_CONFLICT, f"CONFLICT: archive destination expected {args.expect_archive_sha256.strip().lower()[:12]}…, actual {archive_hash[:12]}…; re-read and re-plan")

    _, source_lines = read_lines(source_bytes)
    _, archive_lines = read_lines(archive_bytes or b"")
    level, hits = find_sections(source_lines, args.section)
    if not hits:
        fail(EXIT_NOTFOUND, f"NOT_FOUND: no exact heading {args.section!r} in {args.file}")
    if len(hits) > 1:
        fail(EXIT_NOTFOUND, f"AMBIGUOUS: {len(hits)} exact matches for {args.section!r} in {args.file}; refuse (no guessing)")
    start, end = section_bounds(source_lines, hits[0], level)
    check_managed(source_lines, start, end, args.file)
    source_heading_title = heading_level(source_lines[start])[1] or ""
    is_next_action = level == 2 and re.match(r"^next action(?:$|\s+[—:-].*)$", source_heading_title, re.I)
    if is_next_action and args.text is None and args.text_file is None:
        fail(EXIT_USAGE, "USAGE: archiving the active Next action requires --text or --text-file with its replacement")
    archive_level, archive_hits = find_sections(archive_lines, args.archive_heading)
    if archive_level is None:
        fail(EXIT_USAGE, f"USAGE: --archive-heading must be a Markdown heading, e.g. '### Closed phase 2026-11-13'")
    if archive_hits:
        fail(EXIT_NOTFOUND, f"AMBIGUOUS: archive entry heading {args.archive_heading!r} already exists in {args.archive_file}; choose a unique archive label")
    if archive_bytes and GUARD_MARKER_RE.search(archive_bytes.decode("utf-8", errors="replace")):
        fail(EXIT_MANAGED, f"MANAGED_BLOCK: refusing archive destination {args.archive_file} because it contains Handoff checkpoint markers")

    original_section = "".join(source_lines[start:end])
    if not original_section.endswith(("\n", "\r")):
        original_section += "\n"
    try:
        replacement_body = read_body(args) if args.text is not None or args.text_file is not None else None
    except SystemExit:
        raise
    if replacement_body is None:
        new_source_text = "".join(source_lines[:start] + source_lines[end:])
    else:
        replacement_lines = build_new_section("replace", source_lines[start], source_lines[start:end], replacement_body)
        new_source_text = "".join(source_lines[:start] + replacement_lines + source_lines[end:])

    source_name = os.path.relpath(source_path, root)
    archive_record = (
        f"{args.archive_heading.strip()}\n\n"
        f"> Archived from `{source_name}` section `{args.section.strip()}`.\n"
        f"> Source file sha256: `{source_hash}`.\n\n"
        f"{original_section}"
    )
    archive_prefix = archive_bytes.decode("utf-8") if archive_bytes is not None else ARCHIVE_HEADER
    if archive_prefix and not archive_prefix.endswith(("\n", "\r")):
        archive_prefix += "\n"
    if archive_prefix and not archive_prefix.endswith("\n\n"):
        archive_prefix += "\n"
    new_archive_text = archive_prefix + archive_record
    source_new_bytes = new_source_text.encode("utf-8")
    archive_new_bytes = new_archive_text.encode("utf-8")
    source_new_hash = sha256_bytes(source_new_bytes)
    archive_new_hash = sha256_bytes(archive_new_bytes)
    source_diff = "".join(difflib.unified_diff(source_bytes.decode("utf-8").splitlines(keepends=True), new_source_text.splitlines(keepends=True), fromfile=f"{args.file} (current {source_hash[:12]})", tofile=f"{args.file} (proposed {source_new_hash[:12]})"))
    old_archive_text = archive_bytes.decode("utf-8") if archive_bytes is not None else ""
    archive_diff = "".join(difflib.unified_diff(old_archive_text.splitlines(keepends=True), new_archive_text.splitlines(keepends=True), fromfile=f"{args.archive_file} (current {archive_hash[:12] if archive_hash != 'absent' else 'absent'})", tofile=f"{args.archive_file} (proposed {archive_new_hash[:12]})"))
    return {
        "source_path": source_path,
        "archive_path": archive_path,
        "source_bytes": source_bytes,
        "archive_bytes": archive_bytes,
        "source_new_bytes": source_new_bytes,
        "archive_new_bytes": archive_new_bytes,
        "source_sha256": source_hash,
        "archive_sha256": archive_hash,
        "source_new_sha256": source_new_hash,
        "archive_new_sha256": archive_new_hash,
        "source_diff": source_diff,
        "archive_diff": archive_diff,
    }


def stage_bytes(path, data):
    directory = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".durable_edit-", dir=directory)
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else 0o644
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        return tmp_path
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def apply_archive(plan):
    """Stage both files first; if source replacement fails, roll back the archive."""
    archive_tmp = None
    source_tmp = None
    try:
        archive_tmp = stage_bytes(plan["archive_path"], plan["archive_new_bytes"])
        source_tmp = stage_bytes(plan["source_path"], plan["source_new_bytes"])
        try:
            with open(plan["source_path"], "rb") as current_source:
                source_hash = sha256_bytes(current_source.read())
            current_archive = None
            if os.path.exists(plan["archive_path"]):
                with open(plan["archive_path"], "rb") as current_archive_file:
                    current_archive = sha256_bytes(current_archive_file.read())
            archive_hash = current_archive or "absent"
        except OSError as exc:
            fail(EXIT_IO, f"IO: cannot re-check archive inputs immediately before replacement: {exc}")
        if source_hash != plan["source_sha256"] or archive_hash != plan["archive_sha256"]:
            fail(EXIT_CONFLICT, "CONFLICT: source or archive changed after the reviewed plan; both files are still untouched, re-read and re-plan")
        os.replace(archive_tmp, plan["archive_path"])
        archive_tmp = None
        try:
            os.replace(source_tmp, plan["source_path"])
            source_tmp = None
        except OSError as source_error:
            try:
                if plan["archive_bytes"] is None:
                    os.unlink(plan["archive_path"])
                else:
                    rollback_tmp = stage_bytes(plan["archive_path"], plan["archive_bytes"])
                    os.replace(rollback_tmp, plan["archive_path"])
            except OSError as rollback_error:
                fail(EXIT_IO, f"IO: source replacement failed ({source_error}); archive rollback also failed ({rollback_error}); inspect both reported paths before retry")
            fail(EXIT_IO, f"IO: source replacement failed ({source_error}); archive destination rolled back")
    except OSError as exc:
        fail(EXIT_IO, f"IO: archive apply failed before completion ({exc}); source and archive remain unchanged")
    finally:
        for tmp_path in (archive_tmp, source_tmp):
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


def print_archive_result(plan, as_json=False, applied=False):
    obj = {
        "cmd": "archive-apply" if applied else "archive-plan",
        "source_sha256": plan["source_sha256"],
        "source_proposed_sha256": plan["source_new_sha256"],
        "archive_sha256": plan["archive_sha256"],
        "archive_proposed_sha256": plan["archive_new_sha256"],
        "wrote": applied,
        "source_diff": plan["source_diff"],
        "archive_diff": plan["archive_diff"],
    }
    if as_json:
        print(json.dumps(obj, indent=2))
        return
    print(("ARCHIVE PLAN" if not applied else "ARCHIVED") + f" {plan['source_path']} -> {plan['archive_path']}")
    print(f"  source sha256: {plan['source_sha256']} -> {plan['source_new_sha256']}")
    print(f"  archive sha256: {plan['archive_sha256']} -> {plan['archive_new_sha256']}")
    print("--- source diff ---\n" + (plan["source_diff"] or "(no source diff)"))
    print("--- archive diff ---\n" + (plan["archive_diff"] or "(no archive diff)"))


def read_body(args):
    if args.text is not None:
        # CLI-level escape decoding: keep literal \n usable from one-liners.
        return args.text.replace("\\n", "\n")
    if args.text_file is not None:
        try:
            with open(args.text_file, "rb") as f:
                data = f.read()
        except OSError as exc:
            fail(EXIT_IO, f"IO: cannot read --text-file: {exc}")
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as exc:
            fail(EXIT_IO, f"E_ENCODING: --text-file is not UTF-8: {exc}")
    fail(EXIT_USAGE, "USAGE: --text or --text-file is required")


def emit(out_obj, human_lines, as_json):
    if as_json:
        print(json.dumps(out_obj, indent=2))
    else:
        for line in human_lines:
            print(line)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="durable_edit.py", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    ph = sub.add_parser("hash", help="print the sha256 of a file (use as --expect-sha256)")
    ph.add_argument("file")

    pa = sub.add_parser("audit", help="read-only inventory of durable handoff documents")
    pa.add_argument("--root", default=".", help="project root containing the six durable documents")
    pa.add_argument("--json", action="store_true")

    for name in ("plan", "apply"):
        p = sub.add_parser(name, help="dry-run diff" if name == "plan" else "atomic write")
        p.add_argument("file")
        p.add_argument("--section", required=True, help='exact heading line, e.g. "## Next action"')
        p.add_argument("--mode", choices=["replace", "append", "prepend"], default="replace")
        p.add_argument("--text", help="new body text (\\n decoded)")
        p.add_argument("--text-file", help="read new body from this file (verbatim)")
        p.add_argument("--expect-sha256", help="refuse unless the CURRENT file hash matches")
        p.add_argument("--check-refs", action="store_true", help="every path-like reference in the new body must exist under --root")
        p.add_argument("--root", default=".", help="base dir for evidence-reference checks (default: cwd)")
        p.add_argument("--json", action="store_true")

    for name in ("archive-plan", "archive-apply"):
        p = sub.add_parser(name, help="preview or atomically move an exact section into an archive document")
        p.add_argument("file", help="source Markdown file")
        p.add_argument("--section", required=True, help='exact source heading, e.g. "## Completed phase"')
        p.add_argument("--archive-file", required=True, help="archive Markdown file under --root; its parent directory must exist")
        p.add_argument("--archive-heading", required=True, help='unique entry heading, e.g. "### E2E-49/P4 (2026-11-13)"')
        p.add_argument("--text", help="replacement body for the source section (\\n decoded)")
        p.add_argument("--text-file", help="read replacement body from this file (verbatim)")
        p.add_argument("--expect-sha256", help="source hash from the reviewed plan")
        p.add_argument("--expect-archive-sha256", help="archive hash from the reviewed plan, or 'absent'")
        p.add_argument("--root", default=".", help="project root; source and archive must resolve inside it")
        p.add_argument("--json", action="store_true")

    args = ap.parse_args(argv)

    if args.cmd == "hash":
        try:
            with open(args.file, "rb") as f:
                print(sha256_bytes(f.read()))
        except OSError as exc:
            fail(EXIT_IO, f"IO: {exc}")
        return EXIT_OK

    if args.cmd == "audit":
        root = os.path.realpath(args.root)
        report = audit_documents(root)
        if args.json:
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print(f"DURABLE DOCUMENT AUDIT — {report['result']} (read-only; no consolidation or edits performed)")
            action = report["active_next_action"]
            print(f"  active Next action: {action['status']} in {action['authoritative_file']}")
            for match in action["matches"]:
                excerpt = " ".join(match["text"].split())[:240] or "(empty)"
                print(f"    {match['heading']} at line {match['line']}: {excerpt}")
            costs = report["recovery_cost_estimates"]
            print(f"  recovery estimate: full six {costs['full_six_characters']} chars / 4 = {costs['full_six_chars_div_4_estimate']:.1f}; lean operational {costs['lean_operational_characters']} chars / 4 = {costs['lean_operational_chars_div_4_estimate']:.1f} (estimates, not measured tokens)")
            print("  documents:")
            for name, metric in report["documents"].items():
                managed = metric["managed_checkpoint"]
                suffix = f"; manual/outside block {metric['manual_prose_and_other_bytes']} bytes; managed block {managed['bytes']} bytes, generation {managed['generation'] or 'unknown'}, attestation {managed['readiness'] or 'unknown'} (metadata only)" if managed else ""
                print(f"    {name}: {metric['bytes']} bytes, {metric['characters']} chars, chars/4 {metric['chars_div_4_estimate']:.1f}, tier={metric['recovery_tier']}{suffix}")
            for finding in report["findings"]:
                print("  FINDING " + json.dumps(finding, ensure_ascii=False))
            for candidate in report["archive_candidates"]:
                print("  ARCHIVE CANDIDATE " + json.dumps(candidate, ensure_ascii=False))
            print("  checkpoint freshness/attestation: use handoff_inspect; this inventory only reads managed-block labels")
            print("  Git worktree/publication: inspect separately with git status --short and git diff")
        return EXIT_OK

    if args.cmd in ("archive-plan", "archive-apply"):
        applying = args.cmd == "archive-apply"
        plan = archive_plan(args, apply=applying)
        if applying:
            apply_archive(plan)
        print_archive_result(plan, args.json, applied=applying)
        return EXIT_OK

    # ---- locate + target ----
    try:
        with open(args.file, "rb") as f:
            original = f.read()
    except OSError as exc:
        fail(EXIT_IO, f"IO: cannot read {args.file}: {exc}")
    cur_hash = sha256_bytes(original)
    text, lines = read_lines(original)

    level, hits = find_sections(lines, args.section)
    if not hits:
        fail(EXIT_NOTFOUND, f"NOT_FOUND: no exact heading {args.section!r} in {args.file} (headings are matched level+text, never fuzzy)")
    if len(hits) > 1:
        nums = ", ".join(str(i + 1) for i in hits)
        fail(EXIT_NOTFOUND, f"AMBIGUOUS: {len(hits)} exact matches for {args.section!r} at lines {nums} in {args.file}; refuse (no guessing)")
    a, b = section_bounds(lines, hits[0], level)
    check_managed(lines, a, b, args.file)

    if args.expect_sha256 is not None and args.expect_sha256.strip().lower() != cur_hash:
        fail(
            EXIT_CONFLICT,
            f"CONFLICT: {args.file} changed since the expected hash was taken "
            f"(expected {args.expect_sha256.strip().lower()[:12]}…, actual {cur_hash[:12]}…). "
            "Re-read, re-plan, then apply with the fresh --expect-sha256.",
        )

    if args.cmd == "apply" and not args.expect_sha256:
        fail(EXIT_USAGE, "USAGE: apply requires --expect-sha256 from the reviewed plan")

    body = read_body(args)
    if args.check_refs:
        refs, missing = check_refs(body, args.root)
        if missing:
            fail(
                EXIT_MISSING_REF,
                "MISSING_REF: evidence references do not exist under --root ({}):\n  {}".format(
                    args.root, "\n  ".join(missing)
                )
                + "\nFix the reference or drop it. This tool only checks EXISTENCE; it never edits conclusions.",
            )
    else:
        refs = []

    new_section = build_new_section(args.mode, lines[a], lines[a:b], body)
    new_text = "".join(lines[:a]) + "".join(new_section) + "".join(lines[b:])
    new_bytes = new_text.encode("utf-8")
    new_hash = sha256_bytes(new_bytes)

    diff = list(
        difflib.unified_diff(
            text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=f"{args.file} (current {cur_hash[:12]})",
            tofile=f"{args.file} (proposed {new_hash[:12]})",
        )
    )
    no_change = new_bytes == original

    if args.cmd == "plan":
        human = [f"PLAN {args.mode} {args.file} :: section {args.section!r}"]
        human.append(f"  current sha256:  {cur_hash}")
        human.append(f"  proposed sha256: {new_hash}" + ("  (identical — nothing to write)" if no_change else ""))
        if refs:
            human.append("  evidence refs checked: " + ", ".join(refs))
        human.extend(diff if diff else ["  (empty diff)"])
        emit(
            {"cmd": "plan", "file": args.file, "section": args.section, "mode": args.mode, "current_sha256": cur_hash, "proposed_sha256": new_hash, "no_change": no_change, "refs_checked": refs, "diff": "".join(diff)},
            human,
            args.json,
        )
        return EXIT_OK

    # ---- apply: atomic replacement, interrupted-write safety ----
    if no_change:
        emit({"cmd": "apply", "file": args.file, "current_sha256": cur_hash, "proposed_sha256": new_hash, "wrote": False, "reason": "no-change"}, [f"NOCHANGE: {args.file} already matches the proposed bytes"], args.json)
        return EXIT_OK
    directory = os.path.dirname(os.path.abspath(args.file)) or "."
    tmp_path = None
    try:
        try:
            with open(args.file, "rb") as check_file:
                latest_hash = sha256_bytes(check_file.read())
        except OSError as exc:
            fail(EXIT_IO, f"IO: cannot re-check {args.file} immediately before replacement: {exc}")
        if latest_hash != cur_hash:
            fail(EXIT_CONFLICT, f"CONFLICT: {args.file} changed after planning (expected {cur_hash[:12]}…, actual {latest_hash[:12]}…); re-read and re-plan")
        fd, tmp_path = tempfile.mkstemp(prefix=".durable_edit-", dir=directory)
        os.fchmod(fd, stat.S_IMODE(os.stat(args.file).st_mode))
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(new_bytes)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, args.file)  # atomic on POSIX
        tmp_path = None
        try:  # best-effort durability of the rename itself
            dfd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
    except OSError as exc:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        # the ORIGINAL file is guaranteed untouched by an interrupted temp write;
        # os.replace is atomic — it either fully happened or not at all.
        after = None
        try:
            with open(args.file, "rb") as f:
                after = sha256_bytes(f.read())
        except OSError:
            pass
        fail(EXIT_IO, f"IO: apply failed ({exc}); original still present at hash {after}")

    hint = ""
    if os.path.basename(args.file).upper() in ("HANDOFF.MD", "PROGRESS.MD"):
        hint = "\n  NOTE: the managed checkpoint block is now STALE relative to this edit — refresh + attest through the guard (/handoff finalize, or /handoff + /handoff ready). This tool never touches managed blocks itself."
    emit(
        {"cmd": "apply", "file": args.file, "section": args.section, "mode": args.mode, "current_sha256": cur_hash, "proposed_sha256": new_hash, "wrote": True},
        [f"APPLIED {args.mode} {args.file} :: section {args.section!r}\n  new sha256: {new_hash}{hint}"],
        args.json,
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
