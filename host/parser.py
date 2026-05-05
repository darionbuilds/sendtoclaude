#!/usr/bin/env python3
"""
case-pdf-parse.py — Parse a ServiceNow case (or task) PDF.

Outputs JSON to stdout with:
  - export_ts:    cover-page "Run Date and Time" (Pacific)
  - header:       case header fields (number, opened, priority, state, assigned_to,
                  customer/company, contact, subject, ...)
  - activity:     [ {timestamp, author, type, body, hash} ... ]
                  type ∈ { "Comments", "Work notes", "Field changes",
                           "Additional comments" }
  - has_work_notes: True if any activity entry has type "Work notes"
                    (consumed by Task-Origin Audit — false negatives = leak risk)
  - internal_flagged: True if PDF body contains internal-marker keywords
                      (word-boundary matched; populated for task PDFs)
  - internal_match: matched line if flagged
  - parse_status: "ok" | "fallback_full_pdf"
                  Fallback fires when <2 activity entries detected in a PDF
                  >5 pages — assume parse failure, set has_work_notes: true,
                  emit raw text as a single block. Better to over-audit than leak.

CLI:
  case-pdf-parse.py <pdf_path> [--since <ISO-8601>]
    --since: only emit activity entries newer than the given timestamp.

Hash: sha256(timestamp + author + first 80 chars of body) — keyed for delta
diffing against tracker's stored hashes.
"""
import sys
import os
import re
import json
import argparse
import hashlib
from datetime import datetime

try:
    import pdfplumber
except ImportError:
    sys.stderr.write(
        "ERROR: pdfplumber not installed. Run: python3 -m pip install pdfplumber\n"
    )
    sys.exit(2)


# Activity entry header pattern — anchors on a date-prefix line.
# Format observed in SN exports:
#   2026-05-04 14:44:31 - Author Name (NOW) (Work notes)
ACTIVITY_HEADER = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - "
    r"(?P<author>.+?) "
    r"\((?P<type>Comments|Work notes|Field changes|Additional comments)\)\s*$"
)

# Header field patterns from the cover page.
HEADER_FIELDS = {
    "number": re.compile(r"Number:\s*(CS\d+|CSTASK\d+|PRB\d+|INC\d+)"),
    "opened": re.compile(r"Opened:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"),
    "updated": re.compile(r"Updated:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"),
    "priority": re.compile(r"Priority:\s*(\d+\s*-\s*\S+|P\d+)"),
    "state": re.compile(r"State:\s*(.+?)$", re.MULTILINE),
    "assigned_to": re.compile(r"Assigned to:\s*(.+?)$", re.MULTILINE),
    "assignment_group": re.compile(r"Assignment group:\s*(.+?)$", re.MULTILINE),
    # Two-column rows ("Company: X Updated: Y") — stop at the next field label.
    "company": re.compile(
        r"Company:\s*(.+?)(?:\s+Updated:|\s+Updated by:|$)", re.MULTILINE
    ),
    "contact": re.compile(
        r"Contact:\s*(.+?)(?:\s+Opened by:|\s+Updated:|$)", re.MULTILINE
    ),
    "channel": re.compile(r"Channel:\s*(.+?)$", re.MULTILINE),
    "subject": re.compile(r"Subject:\s*\n(.+?)(?:\n[A-Z][a-z]|\n\n)", re.DOTALL),
}

EXPORT_TS = re.compile(
    r"Run Date and Time:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"
)

# Internal-marker keywords — word-boundary matched, case-insensitive.
# "internal-only" is matched as the literal phrase (hyphen is a non-word
# boundary, so we match it explicitly without \b on the right side).
# "international" must NOT match "internal".
INTERNAL_MARKERS = [
    (r"\binternal\b(?!-only)", "internal"),
    (r"\binternal-only\b", "internal-only"),
    (r"\bdo not share\b", "do not share"),
    (r"\bconfidential\b", "confidential"),
    (r"\bNDA\b", "NDA"),
]
INTERNAL_MARKER_RES = [
    (re.compile(pat, re.IGNORECASE), label) for pat, label in INTERNAL_MARKERS
]


def hash_entry(ts: str, author: str, body: str) -> str:
    """sha256(timestamp + author + first 80 chars of body)."""
    h = hashlib.sha256()
    h.update(ts.encode("utf-8"))
    h.update(author.encode("utf-8"))
    h.update(body[:80].encode("utf-8"))
    return "sha256:" + h.hexdigest()


def hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def extract_text(pdf_path: str):
    """Returns (full_text, page_count)."""
    with pdfplumber.open(pdf_path) as pdf:
        pages = [p.extract_text() or "" for p in pdf.pages]
    return "\n".join(pages), len(pages)


def parse_header(text: str) -> dict:
    out = {}
    for key, pat in HEADER_FIELDS.items():
        m = pat.search(text)
        if m:
            val = m.group(1).strip()
            # Subject can contain newlines — collapse.
            if key == "subject":
                val = re.sub(r"\s+", " ", val).strip()
            out[key] = val
    return out


def parse_activity(text: str):
    """Walk lines; on activity-header line, start a new entry; subsequent
    lines until the next header are the body."""
    lines = text.split("\n")
    entries = []
    current = None
    for line in lines:
        m = ACTIVITY_HEADER.match(line)
        if m:
            if current is not None:
                current["body"] = current["body"].strip()
                current["hash"] = hash_entry(
                    current["timestamp"], current["author"], current["body"]
                )
                entries.append(current)
            current = {
                "timestamp": m.group("ts"),
                "author": m.group("author").strip(),
                "type": m.group("type"),
                "body": "",
            }
        else:
            if current is not None:
                current["body"] += line + "\n"
    if current is not None:
        current["body"] = current["body"].strip()
        current["hash"] = hash_entry(
            current["timestamp"], current["author"], current["body"]
        )
        entries.append(current)
    return entries


def scan_internal(text: str):
    """Word-boundary internal-marker scan. Returns (flagged, matched_line)."""
    for line in text.split("\n"):
        for rx, label in INTERNAL_MARKER_RES:
            if rx.search(line):
                return True, line.strip()[:200]
    return False, None


def filter_since(entries, since_iso: str):
    try:
        cutoff = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
    except ValueError:
        sys.stderr.write(f"WARNING: --since '{since_iso}' is not ISO-8601\n")
        return entries
    out = []
    for e in entries:
        try:
            ets = datetime.fromisoformat(e["timestamp"].replace(" ", "T"))
        except ValueError:
            continue
        if ets > cutoff.replace(tzinfo=None) if cutoff.tzinfo else ets > cutoff:
            out.append(e)
    return out


def main():
    ap = argparse.ArgumentParser(description="Parse a ServiceNow case PDF.")
    ap.add_argument("pdf_path", help="Path to the case or task PDF")
    ap.add_argument(
        "--since", default=None,
        help="ISO-8601 timestamp; only emit activity entries newer than this",
    )
    args = ap.parse_args()

    if not os.path.isfile(args.pdf_path):
        sys.stderr.write(f"ERROR: {args.pdf_path} not found\n")
        sys.exit(2)

    try:
        text, page_count = extract_text(args.pdf_path)
    except Exception as e:
        sys.stderr.write(f"ERROR extracting text from PDF: {e}\n")
        sys.exit(2)

    export_match = EXPORT_TS.search(text)
    export_ts = export_match.group(1) if export_match else None

    header = parse_header(text)
    activity = parse_activity(text)
    internal_flagged, internal_match = scan_internal(text)

    parse_status = "ok"
    has_work_notes = any(e["type"] == "Work notes" for e in activity)

    # Fallback: parser confidence is low → treat whole PDF as one block,
    # over-audit by setting has_work_notes True.
    if len(activity) < 2 and page_count > 5:
        parse_status = "fallback_full_pdf"
        has_work_notes = True
        activity = [{
            "timestamp": export_ts or "",
            "author": "fallback",
            "type": "fallback_full_pdf",
            "body": text,
            "hash": hash_entry(export_ts or "", "fallback", text),
        }]

    if args.since and parse_status == "ok":
        activity = filter_since(activity, args.since)

    out = {
        "pdf_path": os.path.abspath(args.pdf_path),
        "pdf_hash": hash_file(args.pdf_path),
        "page_count": page_count,
        "export_ts": export_ts,
        "header": header,
        "has_work_notes": has_work_notes,
        "internal_flagged": internal_flagged,
        "internal_match": internal_match,
        "parse_status": parse_status,
        "activity": activity,
        "activity_count": len(activity),
    }
    json.dump(out, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
