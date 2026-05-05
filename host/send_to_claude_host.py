#!/usr/bin/env python3
"""
send_to_claude_host.py — Chrome native messaging host for the
"Send to Claude" extension.

Responsibilities (per docs/case-ingestion-architecture.md §12):
  - Receive a single JSON request from the extension.
  - Write delivered files (case PDF, attachments, task PDFs+attachments,
    KB PDFs, reference snapshots) into the workspace per the routing
    rules in §4 / §9.
  - Shell out to the BUNDLED parser at host/parser.py (next to this file).
    The workspace's copy of the parser is not on the runtime path.
  - Populate cases/CS<n>/tracker.md frontmatter from the parser output.
  - Append an Activity Log line for the operation.
  - Reply to the extension with a JSON status envelope, then exit.

The host is one-shot per call: open port, read one message, reply, exit.

Critical constraints (per arch doc §2 / G1, G3, G4):
  - Reads workspace_root and partner_tse_email from
    ~/my-claude-workspace/.claude/config.json. No paths hardcoded.
  - Reference mode (G4) never creates or updates a tracker. Snapshots
    land under cases/CS<primary>/refs/ verbatim.
  - parser.py output is the source of truth for has_work_notes,
    activity entries, and PDF hash. We do not re-derive them here.
  - Bundled parser is invoked via CLI arg + stdout capture. We never
    pipe JSON into a heredoc.
"""

from __future__ import annotations

import sys
import os
import json
import struct
import base64
import hashlib
import re
import subprocess
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path

# --- Debug log -----------------------------------------------------------
# Chrome swallows the host's stderr when it reports "Native host has
# exited" — there's no way to see what crashed. Mirror everything to
# /tmp/send_to_claude_host.log so we have something to read.

LOG_PATH = Path("/tmp/send_to_claude_host.log")


def _log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            ts = datetime.now().isoformat(timespec="seconds")
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _log_exception(prefix: str, exc: BaseException) -> None:
    _log(f"{prefix}: {exc}\n{traceback.format_exc()}")

# Pacific TZ — handles PDT/PST transition correctly when zoneinfo is
# available (Python ≥ 3.9). Falls back to fixed -07:00 otherwise.
try:
    from zoneinfo import ZoneInfo  # type: ignore
    PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:
    PACIFIC = timezone(timedelta(hours=-7))


# --- Native messaging frame protocol -------------------------------------
# Chrome native messaging: 4-byte little-endian length, then JSON body.
# Outgoing messages capped at 1 MB by Chrome.

def _read_exact(n: int) -> bytes:
    """Read exactly n bytes from stdin, looping past short reads."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
    return bytes(buf)


def _read_message():
    raw_len = _read_exact(4)
    if len(raw_len) < 4:
        _log(f"_read_message: short header ({len(raw_len)} bytes)")
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    _log(f"_read_message: incoming length = {msg_len:,} bytes")
    body = _read_exact(msg_len)
    if len(body) < msg_len:
        _log(f"_read_message: truncated body ({len(body):,} / {msg_len:,})")
        return None
    return json.loads(body.decode("utf-8"))


def _send_message(obj):
    body = json.dumps(obj, default=str).encode("utf-8")
    if len(body) >= 1024 * 1024:
        # Chrome's host→extension limit is 1 MB. Trim verbose fields so the
        # caller still gets a meaningful reply instead of a hard crash.
        _log(f"_send_message: response too large ({len(body):,} bytes); trimming")
        if isinstance(obj, dict) and "result" in obj and isinstance(obj["result"], dict):
            r = obj["result"]
            for k in ("attachments", "tasks"):
                if k in r and isinstance(r[k], list):
                    r[k] = [{"_trimmed": True, "count": len(r[k])}]
            body = json.dumps(obj, default=str).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


# --- Workspace config ----------------------------------------------------

DEFAULT_CONFIG_PATH = Path.home() / "my-claude-workspace" / ".claude" / "config.json"


def _config_path() -> Path:
    p = os.environ.get("SEND_TO_CLAUDE_CONFIG")
    return Path(p) if p else DEFAULT_CONFIG_PATH


def _read_config() -> dict:
    cp = _config_path()
    if not cp.is_file():
        raise RuntimeError(
            f"Workspace config not found at {cp}. Set up the workspace per KB2948102."
        )
    with open(cp, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "workspace_root" not in cfg:
        raise RuntimeError(f"{cp} is missing 'workspace_root'")
    cfg["workspace_root"] = str(Path(cfg["workspace_root"]).expanduser())
    return cfg


# --- Time helpers --------------------------------------------------------

def _now_pacific() -> datetime:
    return datetime.now(PACIFIC).replace(microsecond=0)


def _iso_pacific() -> str:
    return _now_pacific().isoformat()


# --- File-system helpers -------------------------------------------------

def _safe_mkdir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def _write_b64(dst: Path, b64: str) -> None:
    _safe_mkdir(dst.parent)
    data = base64.b64decode(b64)
    with open(dst, "wb") as f:
        f.write(data)


def _attach_filename(sys_id: str, name: str) -> str:
    """sys_id-prefixed filename to prevent collisions and enable lookup."""
    safe = (name or "file").replace("/", "_").replace("\\", "_").strip()
    return f"{sys_id}-{safe}"


# --- Parser shellout (BUNDLED parser, not workspace parser) --------------

BUNDLED_PARSER = Path(__file__).resolve().parent / "parser.py"


def _run_parser(pdf_path: Path, since: str | None = None) -> dict:
    if not BUNDLED_PARSER.is_file():
        raise RuntimeError(
            f"Bundled parser not found at {BUNDLED_PARSER}. "
            "The extension repo is incomplete."
        )
    cmd = ["python3", str(BUNDLED_PARSER), str(pdf_path)]
    if since:
        cmd += ["--since", since]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=180,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"parser timed out on {pdf_path}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"parser failed (rc={proc.returncode}) on {pdf_path}: "
            f"{proc.stderr.strip()[:400]}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"parser stdout was not JSON: {e}: {proc.stdout[:300]}")


# --- Tracker read / write ------------------------------------------------

FRONT_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)


def _tracker_path(case_dir: Path) -> Path:
    return case_dir / "tracker.md"


def _read_tracker(case_dir: Path):
    p = _tracker_path(case_dir)
    if not p.is_file():
        return None, ""
    txt = p.read_text(encoding="utf-8")
    m = FRONT_RE.match(txt)
    if not m:
        return None, txt
    front_yaml = m.group(1)
    body = txt[m.end():]
    front = _parse_simple_yaml(front_yaml)
    return front, body


def _parse_simple_yaml(s: str) -> dict:
    """Tolerant single-pass YAML parser for our flat tracker frontmatter shape."""
    out: dict = {}
    cur_list_key = None
    cur_obj_key = None
    for raw in s.split("\n"):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("  - "):
            item_str = line[4:].strip()
            if cur_list_key is None:
                continue
            out.setdefault(cur_list_key, []).append(_parse_flow_obj(item_str))
            continue
        if line.startswith("  ") and ":" in line:
            k, _, v = line.strip().partition(":")
            if cur_obj_key is not None:
                out[cur_obj_key][k.strip()] = _unquote(v.strip())
            continue
        if ":" in line and not line.startswith(" "):
            k, _, v = line.partition(":")
            k = k.strip(); v = v.strip()
            if v == "":
                cur_list_key = k
                if k == "case_pdf":
                    cur_obj_key = k
                    out[k] = {}
                else:
                    cur_obj_key = None
            else:
                out[k] = _coerce_scalar(_unquote(v))
                cur_list_key = None
                cur_obj_key = None
    return out


def _coerce_scalar(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        if v.lower() in ("true", "false"):
            return v.lower() == "true"
        if re.fullmatch(r"-?\d+", v):
            return int(v)
    return v


def _unquote(s: str) -> str:
    s = s.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    return s


def _parse_flow_obj(s: str) -> dict:
    """Parse a single-line flow-style mapping like '{ k: v, k2: v2 }'."""
    s = s.strip()
    if s.startswith("{") and s.endswith("}"):
        s = s[1:-1]
    out: dict = {}
    # Naive comma split — values in our schema don't contain commas (we
    # strip/escape them in _yaml_quote_value when emitting).
    for part in s.split(","):
        if ":" not in part:
            continue
        k, _, v = part.partition(":")
        out[k.strip()] = _coerce_scalar(_unquote(v.strip()))
    return out


def _yaml_quote_value(v) -> str:
    """Emit a value safe for our flat YAML schema. Quote when the value
    contains a colon, hash, leading whitespace, or matches reserved words."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    s = str(v)
    needs_quote = (
        not s
        or s != s.strip()
        or any(c in s for c in (":", "#", "{", "}", "[", "]", ","))
        or s.lower() in ("true", "false", "null", "yes", "no", "on", "off")
    )
    if needs_quote:
        # Use double quotes, escape internal double quotes and backslashes.
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _emit_yaml(front: dict) -> str:
    """Tiny YAML emitter matching the tracker schema in arch §5.1."""
    lines = ["---"]
    scalar_keys = [
        "case", "customer", "priority", "state", "assigned_to", "opened",
        "last_synced", "has_work_notes",
    ]
    for k in scalar_keys:
        if k in front:
            lines.append(f"{k}: {_yaml_quote_value(front[k])}")
    if "sessions" in front:
        lines.append("sessions:")
        for s in front["sessions"]:
            lines.append("  - " + _emit_flow_obj(s))
    if "case_pdf" in front:
        lines.append("case_pdf:")
        for k, v in front["case_pdf"].items():
            lines.append(f"  {k}: {_yaml_quote_value(v)}")
    if "attachments" in front:
        lines.append("attachments:")
        for a in front["attachments"]:
            lines.append("  - " + _emit_flow_obj(a))
    if "tasks" in front:
        lines.append("tasks:")
        for t in front["tasks"]:
            lines.append("  - " + _emit_flow_obj(t))
    lines.append("---\n")
    return "\n".join(lines)


def _emit_flow_obj(d: dict) -> str:
    parts = []
    for k, v in d.items():
        parts.append(f"{k}: {_yaml_quote_value(v)}")
    return "{ " + ", ".join(parts) + " }"


def _write_tracker(case_dir: Path, front: dict, body: str) -> None:
    p = _tracker_path(case_dir)
    if "## Activity Log" not in body:
        body = (
            "\n## Activity Log\n"
            "<!-- All timestamps Pacific Time -->\n"
            + body.lstrip("\n")
        )
    p.write_text(_emit_yaml(front) + "\n" + body.lstrip("\n"), encoding="utf-8")


def _append_activity(case_dir: Path, line: str) -> None:
    """Append a one-line, timestamp-prefixed entry just below the
    ## Activity Log header."""
    front, body = _read_tracker(case_dir)
    ts = _now_pacific().strftime("%Y-%m-%d %H:%M")
    entry = f"{ts} — {line}"
    if front is None:
        # No tracker — caller bug. Don't lose the entry.
        with open(case_dir / "activity-orphan.log", "a", encoding="utf-8") as f:
            f.write(entry + "\n")
        return
    if "## Activity Log" in body:
        lines = body.split("\n")
        out_lines = []
        inserted = False
        for ln in lines:
            out_lines.append(ln)
            if not inserted and ln.startswith("## Activity Log"):
                # Insert right after the header. If the next line is the
                # comment marker, append after that instead so the comment
                # stays adjacent to the header.
                inserted = "pending"
                continue
            if inserted == "pending":
                if ln.lstrip().startswith("<!--"):
                    out_lines.append(entry)
                    inserted = True
                    continue
                # No comment line — insert before this line.
                out_lines.insert(-1, entry)
                inserted = True
        if inserted != True:
            out_lines.append(entry)
        body = "\n".join(out_lines)
    else:
        body = (
            "\n## Activity Log\n"
            "<!-- All timestamps Pacific Time -->\n"
            f"{entry}\n" + body
        )
    _write_tracker(case_dir, front, body)


# --- Path helpers --------------------------------------------------------

def _case_dir(cfg: dict, case_number: str) -> Path:
    return Path(cfg["workspace_root"]) / "cases" / case_number


def _knowledge_dir(cfg: dict) -> Path:
    return Path(cfg["workspace_root"]) / "knowledge"


def _disp(v):
    if isinstance(v, dict):
        return v.get("display_value") or v.get("value") or ""
    return v or ""


def _value(v):
    if isinstance(v, dict):
        return v.get("value") or ""
    return v or ""


# --- Operation handlers --------------------------------------------------

HOST_VERSION = "2.0.0"


def op_ping(cfg, payload):
    return {
        "ok": True,
        "workspace_root": cfg["workspace_root"],
        "partner_tse_email": cfg.get("partner_tse_email"),
        "host_version": HOST_VERSION,
    }


def op_read_config(cfg, payload):
    return _read_config()


def op_ingest_case(cfg, payload):
    """PRIMARY ingest. Routes:
        cases/CS<n>/CS<n>.pdf
        cases/CS<n>/attachments/<sys_id>-<name>
        cases/CS<n>/tasks/CSTASK<m>.pdf
        cases/CS<n>/tasks/CSTASK<m>/attachments/<sys_id>-<name>

    Then runs parser.py on the case PDF (and each task PDF) and populates
    the tracker frontmatter from the parser output.
    """
    case_info = payload["case"]
    case_number = case_info["number"]
    record = case_info.get("record", {}) or {}
    case_dir = _case_dir(cfg, case_number)
    is_first_pull = not case_dir.exists()
    _safe_mkdir(case_dir)
    _safe_mkdir(case_dir / "attachments")
    _safe_mkdir(case_dir / "tasks")

    # 1. Case PDF
    case_pdf_dst = case_dir / payload["case_pdf"]["filename"]
    _write_b64(case_pdf_dst, payload["case_pdf"]["base64"])

    # 2. Case attachments — write only ones we don't already have by sys_id.
    attach_results = []
    existing_attach_ids: set[str] = set()
    if (case_dir / "attachments").exists():
        for entry in (case_dir / "attachments").iterdir():
            if entry.is_file():
                prefix = entry.name.split("-", 1)[0]
                if len(prefix) == 32:
                    existing_attach_ids.add(prefix)

    for a in payload.get("attachments", []) or []:
        sid = a["sys_id"]
        fname = _attach_filename(sid, a["file_name"])
        dst = case_dir / "attachments" / fname
        if sid in existing_attach_ids and dst.exists():
            attach_results.append({
                "sys_id": sid, "file_name": a["file_name"], "skipped": True,
            })
            continue
        _write_b64(dst, a["base64"])
        attach_results.append({
            "sys_id": sid,
            "file_name": a["file_name"],
            "path": str(dst.relative_to(cfg["workspace_root"])),
            "hash": _sha256_file(dst),
        })

    # 3. Tasks
    task_results = []
    for t in payload.get("tasks", []) or []:
        t_number = t["number"]
        t_dir = case_dir / "tasks" / t_number
        _safe_mkdir(t_dir / "attachments")
        t_pdf_dst = None
        t_parsed = None
        if t.get("pdf"):
            t_pdf_dst = case_dir / "tasks" / f"{t_number}.pdf"
            _write_b64(t_pdf_dst, t["pdf"]["base64"])
            try:
                t_parsed = _run_parser(t_pdf_dst)
            except Exception as e:
                t_parsed = {"error": str(e)}

        t_attach_results = []
        for a in t.get("attachments", []) or []:
            sid = a["sys_id"]
            fname = _attach_filename(sid, a["file_name"])
            dst = t_dir / "attachments" / fname
            _write_b64(dst, a["base64"])
            t_attach_results.append({
                "sys_id": sid, "file_name": a["file_name"],
                "path": str(dst.relative_to(cfg["workspace_root"])),
                "hash": _sha256_file(dst),
            })
        task_results.append({
            "number": t_number,
            "sys_id": t["sys_id"],
            "pdf_path": (str(t_pdf_dst.relative_to(cfg["workspace_root"]))
                         if t_pdf_dst else None),
            "pdf_hash": _sha256_file(t_pdf_dst) if t_pdf_dst else None,
            "internal_flagged": bool(
                t_parsed and t_parsed.get("internal_flagged")
            ) if t_parsed else False,
            "internal_match": (t_parsed or {}).get("internal_match"),
            "last_activity": t.get("sys_updated_on"),
            "attachments": t_attach_results,
        })

    # 4. Parse the case PDF — gives us has_work_notes, header, hash.
    case_parsed = _run_parser(case_pdf_dst)

    # 5. Build / update tracker
    front, body = _read_tracker(case_dir)
    if front is None:
        front = {}
        body = ""

    front["case"] = case_number
    front["customer"] = _disp(record.get("account") or record.get("company"))
    front["priority"] = _disp(record.get("priority"))
    front["state"] = _disp(record.get("state"))
    front["assigned_to"] = _disp(record.get("assigned_to"))
    opened_raw = _disp(record.get("opened_at"))
    if opened_raw:
        front["opened"] = opened_raw.split(" ")[0]
    elif "opened" not in front:
        front["opened"] = ""
    front["last_synced"] = _iso_pacific()
    front["has_work_notes"] = bool(case_parsed.get("has_work_notes"))

    sessions = front.get("sessions") or []
    if is_first_pull and not sessions:
        sessions = [{"id": case_number, "started": _iso_pacific()}]
    front["sessions"] = sessions

    front["case_pdf"] = {
        "filename": case_pdf_dst.name,
        "hash": _sha256_file(case_pdf_dst),
        "export_ts": case_parsed.get("export_ts") or "",
    }

    # Attachments: merge by sys_id; mark removed_from_source on missing.
    live_sids = {a["sys_id"] for a in (payload.get("attachments") or [])}
    merged: dict = {}
    for a in (front.get("attachments") or []):
        sid = a.get("sys_id")
        if sid:
            merged[sid] = a
    for a in payload.get("attachments", []) or []:
        sid = a["sys_id"]
        local = case_dir / "attachments" / _attach_filename(sid, a["file_name"])
        merged[sid] = {
            "sys_id": sid,
            "name": a["file_name"],
            "hash": _sha256_file(local) if local.exists() else "",
            "removed_from_source": False,
        }
    for sid, entry in merged.items():
        if sid not in live_sids:
            entry["removed_from_source"] = True
    front["attachments"] = list(merged.values())

    # Tasks: same merge pattern.
    task_merged: dict = {}
    for t in (front.get("tasks") or []):
        sid = t.get("sys_id")
        if sid:
            task_merged[sid] = t
    for tr in task_results:
        sid = tr["sys_id"]
        task_merged[sid] = {
            "number": tr["number"],
            "sys_id": sid,
            "last_activity": tr.get("last_activity") or "",
            "pdf_hash": tr.get("pdf_hash") or "",
            "internal_flagged": bool(tr.get("internal_flagged")),
        }
    front["tasks"] = list(task_merged.values())

    _write_tracker(case_dir, front, body)
    summary = (
        f"Pulled case via Send to Claude — {len(attach_results)} attachments, "
        f"{len(task_results)} tasks, has_work_notes={front['has_work_notes']}"
    )
    _append_activity(case_dir, summary)

    return {
        "ok": True,
        "case_dir": str(case_dir),
        "first_pull": is_first_pull,
        "case_pdf": str(case_pdf_dst.relative_to(cfg["workspace_root"])),
        "case_pdf_hash": front["case_pdf"]["hash"],
        "has_work_notes": front["has_work_notes"],
        "attachments": attach_results,
        "tasks": task_results,
        "tracker_path": str(_tracker_path(case_dir).relative_to(cfg["workspace_root"])),
    }


def op_ingest_reference(cfg, payload):
    """REFERENCE mode (§4.4 / G4). One-shot snapshot. NO tracker writes
    for the reference case. Touch the primary tracker's activity log only
    when it already exists."""
    primary = payload["primary_case"].upper()
    if not re.fullmatch(r"CS\d+", primary):
        raise ValueError(f"primary_case must look like CS<n>, got '{primary}'")
    case_dir = _case_dir(cfg, primary)
    refs_dir = case_dir / "refs"
    _safe_mkdir(refs_dir)
    ref = payload["reference"]
    ref_number = ref.get("reference_case_number") or "REF"
    f = ref["file"]
    orig = f["filename"]
    upper_orig = orig.upper()
    upper_ref = ref_number.upper()
    if upper_orig.startswith(upper_ref):
        rest = orig[len(ref_number):].lstrip("-_. ")
        out_name = f"{ref_number}-{rest}" if rest else f"{ref_number}{Path(orig).suffix}"
    else:
        out_name = f"{ref_number}-{orig}"
    dst = refs_dir / out_name
    _write_b64(dst, f["base64"])

    # G4: the reference case never gets a tracker. The primary's tracker
    # gets one log line iff it already exists.
    if _tracker_path(case_dir).exists():
        _append_activity(case_dir, f"Added reference snapshot: {out_name}")

    return {
        "ok": True,
        "primary_case": primary,
        "wrote": str(dst.relative_to(cfg["workspace_root"])),
        "tracker_touched": False,
    }


def op_ingest_kb(cfg, payload):
    kb_number = payload["number"]
    if not re.fullmatch(r"KB\d+", kb_number):
        raise ValueError(f"number must look like KB<n>, got '{kb_number}'")
    knowledge = _knowledge_dir(cfg)
    _safe_mkdir(knowledge)
    f = payload["file"]
    dst = knowledge / f"{kb_number}.pdf"
    _write_b64(dst, f["base64"])
    return {
        "ok": True,
        "wrote": str(dst.relative_to(cfg["workspace_root"])),
    }


def op_single_file(cfg, payload):
    """Single attachment routed into an existing case's attachments/."""
    case_number = payload["case_number"].upper()
    case_dir = _case_dir(cfg, case_number)
    if not case_dir.exists():
        raise ValueError(
            f"case folder {case_dir} does not exist; pull case first"
        )
    f = payload["file"]
    sid = payload.get("sys_id") or hashlib.sha256(
        f["base64"][:200].encode()
    ).hexdigest()[:32]
    fname = _attach_filename(sid, f["filename"])
    dst = case_dir / "attachments" / fname
    _write_b64(dst, f["base64"])
    if _tracker_path(case_dir).exists():
        _append_activity(
            case_dir,
            f"Added single attachment via Send to Claude: {f['filename']}",
        )
    return {"ok": True, "wrote": str(dst.relative_to(cfg["workspace_root"]))}


OPS = {
    "ping": op_ping,
    "read_config": op_read_config,
    "ingest_case": op_ingest_case,
    "ingest_reference": op_ingest_reference,
    "ingest_kb": op_ingest_kb,
    "single_file": op_single_file,
}


def main():
    _log("---- host invoked ----")
    try:
        msg = _read_message()
    except Exception as e:
        _log_exception("read_message failed", e)
        try:
            _send_message({"ok": False, "error": f"read_message: {e}"})
        except Exception:
            pass
        return
    if msg is None:
        _send_message({"ok": False, "error": "no input"})
        return
    op = msg.get("op")
    payload = msg.get("payload", {}) or {}
    _log(f"op={op}; payload top-level keys={list(payload.keys()) if isinstance(payload, dict) else type(payload)}")

    try:
        cfg = _read_config()
    except Exception as e:
        _log_exception("config read failed", e)
        _send_message({"ok": False, "error": f"config error: {e}"})
        return

    handler = OPS.get(op)
    if not handler:
        _send_message({"ok": False, "error": f"unknown op: {op}"})
        return

    try:
        result = handler(cfg, payload)
        _send_message({"ok": True, "result": result})
        _log(f"op={op} ok")
    except Exception as e:
        _log_exception(f"op={op} handler failed", e)
        try:
            _send_message({
                "ok": False,
                "error": str(e),
                "trace": traceback.format_exc(),
            })
        except Exception as e2:
            _log_exception("failed to send error reply", e2)


if __name__ == "__main__":
    try:
        main()
    except BaseException as e:
        _log_exception("top-level crash", e)
        # Best-effort exit; Chrome already saw "host exited".
        raise
