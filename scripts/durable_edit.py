#!/usr/bin/env python3
"""durable_edit.py — targeted, deterministic edits to durable markdown documents.

dev.2 D3 (pi-handoff v0.1.0-dev.2): successors in long renewal chains re-read and
REWRITE whole durable documents (DRPLi campaign: 583 609 chars of durable-doc read
results across 8 successors, A-27). This tool replaces that pattern with exact-section
edits that are cheap, reviewable and safe:

  * DRY RUN FIRST: `plan` prints a unified diff + current/proposed sha256; `apply`
    performs the identical computation and writes.
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

    args = ap.parse_args(argv)

    if args.cmd == "hash":
        try:
            with open(args.file, "rb") as f:
                print(sha256_bytes(f.read()))
        except OSError as exc:
            fail(EXIT_IO, f"IO: {exc}")
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
        fd, tmp_path = tempfile.mkstemp(prefix=".durable_edit-", dir=directory)
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
