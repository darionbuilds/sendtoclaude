# Send to Claude — Additive Refactor Plan

> **Status:** Approved 2026-05-05. Implementation in progress.
> **Author:** Claude (this session), 2026-05-05
> **Predecessor mistake:** previous agent rebuilt from scratch in `extension/`, replaced icons, broke URL match patterns, broke button injection. Darion reverted. This plan is *additive only* on the existing flat repo.

---

## 0. TL;DR

- Keep `manifest.json`, `background.js`, `content.js`, `options.html`, `options.js`, `icons/` exactly where they are. Repo root stays loadable.
- Add a `host/` subfolder (Python native messaging host + bundled parser) and a `setup.sh` at the repo root (one-command installer).
- **Architecture: Option A** — host owns all writes. No fallback path. Failure modes are eliminated up front by the installer (see §1).
- Eight hard invariants audited in §3. None broken.

---

## 1. Architecture: Option A with up-front prereq elimination

The new features (attachments, tasks, tracker frontmatter) require a native messaging host. Option A means the host owns all file writes — there is no fallback `chrome.downloads.download()` path. The simplification choice is to **eliminate failure modes at install time** rather than handle them at runtime:

| Failure mode | How the installer eliminates it |
|---|---|
| Workspace not set up | `setup.sh` checks for `~/my-claude-workspace/.claude/config.json`. Missing → prints **"Set up your Claude workspace first: KB2948102"** and exits. Never auto-creates a workspace. |
| Parser missing from workspace | Bundled at `host/parser.py` in this repo. Host calls the bundled copy. Workspace's parser is not on the runtime path. |
| `pdfplumber` not installed | `setup.sh` runs `python3 -m pip install --user pdfplumber` automatically. |
| Wrong extension ID in native messaging manifest | `setup.sh` auto-detects extension ID by scanning `~/Library/Application Support/Google/Chrome/*/Extensions/` for the unpacked dir whose path matches this repo. Falls back to a clear `read -p` prompt only if detection fails. |
| Python 3 missing | `setup.sh` checks first. If missing, prints OS-specific install instructions and exits. |

After the installer, the only runtime errors that can fire are:
- Workspace deleted *after* install (rare, user surfaces it themselves)
- Live SN session expired (`fetch` returns 401)
- Network failure mid-fetch

These three surface as the existing `Failed ✗` state with the error message in an alert. No new UX.

### Coworker setup (target experience)

1. Set up Claude workspace per **KB2948102** (one-time, separate)
2. Load extension unpacked
3. Run `./setup.sh` from the repo root
4. Done — clicking the button on a case page does full deep-ingest

If they skip step 1, `setup.sh` tells them in plain language and stops. No half-installed state.

---

## 2. File-by-file change list

| Path | Disposition | Why |
|---|---|---|
| `manifest.json` | Extend | Add `nativeMessaging` permission; bump version to 2.0; keep all four URL match patterns; keep `host_permissions`; keep `icons` block. |
| `background.js` | Replace contents | New ops: detect context, fetch case envelope from SN REST, route to host. Replaces the existing `chrome.downloads.download()` path entirely (Option A). |
| `content.js` | Extend (do not rewrite) | Keep `getCaseInfo()` and 4-state button verbatim. Add probe message handler (background asks "what's on this page"). Add a 5th button state `setup ⚠` for host-not-available. |
| `options.html` | Extend | Add a one-line host status row. Add a setup-needed panel that shows the exact `cd <repo> && ./setup.sh` command with the auto-detected repo path. Keep existing settings. |
| `options.js` | Extend | Wire host status (`ping` op) on load + a Re-check button. |
| `icons/icon{16,48,128}.png` | **Keep untouched** | Darion's. The previous refactor regenerated these — that mistake is not repeated. |
| `README.md` | Extend | Document `setup.sh` flow + KB2948102 workspace prereq. |
| `CLAUDE.md` | Extend | Document host architecture, bundled parser, install path, workspace contract. |

| **New** path | Purpose |
|---|---|
| `host/send_to_claude_host.py` | Native messaging host. Stdin/stdout JSON protocol. Calls bundled parser; writes case PDF / attachments / tasks / tracker. |
| `host/parser.py` | Bundled copy of `~/my-claude-workspace/.claude/scripts/case-pdf-parse.py`. Source-of-truth lives in the workspace; this is a frozen copy at extension version time. |
| `host/com.servicenow.send_to_claude.json` | Native messaging host manifest template. `__HOST_BIN__` and `__EXTENSION_ID__` substituted at install time. |
| `lib/sn-api.js` | SN REST helpers (GET-only) used by background.js. Has zero non-GET methods — banned by convention + grep test. |
| `lib/messaging.js` | `callHost(op, payload)` wrapper around `chrome.runtime.connectNative`. |
| `setup.sh` | One-command installer. No args. Auto-detects extension ID, installs deps + manifest, smoke-tests, prints summary. Bails to KB2948102 if workspace missing. |
| `uninstall.sh` | Removes the native messaging manifest. Does not touch the workspace. |

No files deleted. No files moved. Repo root layout unchanged.

---

## 3. Invariant audit

| # | Invariant | How preserved |
|---|---|---|
| 1 | Flat repo layout | No source files leave the root. `host/`, `lib/` are new additions — `lib/` holds JS modules referenced from `background.js`, but `manifest.json` itself stays at the root. Chrome's `Load unpacked → select this folder` continues to work. |
| 2 | Existing icons untouched | `icons/` not modified. Diff for `icons/*` is empty. |
| 3 | URL match patterns | `manifest.json` keeps the four-pattern array verbatim. No `*://*.service-now.com/*` introduced. `nav_to.do?uri=` redirect variants stay matched explicitly. |
| 4 | DOM probe in `getCaseInfo()` | Preserved character-for-character. New code is added alongside, not replaced. |
| 5 | Four-state button + `.navbar_ui_actions` injection + 4s auto-reset | Button injection logic preserved. State machine extended with a 5th `setup` state for host-not-available; the four base states (`ready/sending/ok/error`) are unchanged. |
| 6 | `support.servicenow.com/{tableName}.do?PDF&sys_id={sysId}` | Used unchanged for case + task PDF fetches in `lib/sn-api.js`. |
| 7 | `chrome.storage.sync` for settings | Unchanged. |
| 8 | No write API calls to ServiceNow | All SN fetches in `lib/sn-api.js` use `method: "GET"` only. README + CLAUDE.md state the rule. Test plan §7 includes a grep that fails if a non-GET method appears anywhere in JS sources. |

**Behavior change adjacent to invariants:** with Option A, the host writes nested paths directly. The workspace-side `case-pdf-detect.sh` (root-PDF mover) and `case-scaffold.sh` (folder-insert tracker populate) **do not fire** on host writes — the host populates the tracker itself, so end state is correct, but Trigger 1/2 enforcement is now host-side. `case-tracker-update.sh` (PostToolUse on Claude Code Write/Edit) likewise won't fire on host writes since they're filesystem-direct. All workspace hooks remain in place; they just don't fire on this code path. This is consistent with arch doc §12 (the host *is* the file-write mechanism for v1).

---

## 4. Manifest delta

**Current** → **Proposed:** add `"nativeMessaging"` to `permissions`, bump `version` to `"2.0"`, update `description`. Everything else identical. Full proposed manifest:

```json
{
  "manifest_version": 3,
  "name": "Send to Claude",
  "version": "2.0",
  "description": "One-click ingest of ServiceNow cases into Claude workspace — case PDF, attachments, CSTASKs, tracker.",
  "permissions": ["downloads", "storage", "nativeMessaging"],
  "options_page": "options.html",
  "host_permissions": ["https://support.servicenow.com/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": [
      "https://support.servicenow.com/sn_customerservice_case.do*",
      "https://support.servicenow.com/nav_to.do?uri=sn_customerservice_case.do*",
      "https://support.servicenow.com/sn_customerservice_task.do*",
      "https://support.servicenow.com/nav_to.do?uri=sn_customerservice_task.do*"
    ],
    "js": ["content.js"], "all_frames": true, "run_at": "document_end"
  }],
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

`downloads` permission retained — content scripts may still need it for KB / attachment-page scenarios that don't go through the host (single-file mode is host-mediated, but keeping `downloads` costs nothing).

---

## 5. Native messaging host design

### Where it lives
- `host/send_to_claude_host.py` — single-file Python 3, stdlib only. Shellouts to the bundled parser.
- `host/parser.py` — bundled copy of `case-pdf-parse.py`. Pinned to extension version. Updated when the workspace parser meaningfully changes (manual sync; tracked in CLAUDE.md).

### Wire format
Chrome native messaging: 4-byte little-endian length-prefixed JSON. One request per process invocation.

### Ops

| Op | Request | Response | Notes |
|---|---|---|---|
| `ping` | `{}` | `{ workspace_root, partner_tse_email, host_version }` | Used by options page on load. |
| `read_config` | `{}` | full `.claude/config.json` | So extension reads `partner_tse_email` without duplicating it in `chrome.storage.sync`. |
| `ingest_case` | `{ case, case_pdf, attachments[], tasks[] }` | `{ case_dir, first_pull, has_work_notes, attachments, tasks, tracker_path }` | PRIMARY pull. Host decides delta vs full from existence of `cases/CS<n>/`. |
| `ingest_reference` | `{ primary_case, reference: {kind, reference_case_number, file} }` | `{ wrote, tracker_touched: false }` | One-shot snapshot in `cases/CS<primary>/refs/`. Never creates/updates a tracker (G4). |
| `ingest_kb` | `{ number, file }` | `{ wrote }` | `knowledge/KB<n>.pdf`. |
| `single_file` | `{ case_number, sys_id, file }` | `{ wrote }` | One attachment into existing case folder. |

### Host responsibilities
- Reads `~/my-claude-workspace/.claude/config.json` for `workspace_root` + `partner_tse_email`. No paths hardcoded.
- Reference mode does **not** create or update a tracker (G4).
- Calls bundled `host/parser.py` — never the workspace's copy.
- Marks `removed_from_source: true` on attachments missing from the live SN list; never deletes local files.
- `case_pdf` hash, `has_work_notes`, `internal_flagged` all sourced from parser output.
- Pacific-time tracker timestamps via `zoneinfo.ZoneInfo("America/Los_Angeles")` (handles DST correctly).

### Error envelope
```json
{ "ok": false, "error": "<short message>" }
```
No `error_code`, no `remediation_cmd` field. Errors at runtime are rare (installer eliminated the common ones); when they fire, the message is enough.

---

## 6. Setup script (`setup.sh`)

### Behavior

```
$ ./setup.sh

Checking prerequisites...
  ✓ Python 3 found (3.11.9)
  ✓ Workspace found at /Users/darionwilliams/my-claude-workspace
  ✓ Workspace config valid
  ✓ Bundled parser at host/parser.py

Detecting extension ID...
  ✓ Extension ID: abcdefghijklmnopqrstuvwxyzabcdef

Installing Python dependencies...
  ✓ pdfplumber installed

Installing native messaging manifest...
  ✓ Wrote ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.servicenow.send_to_claude.json

Smoke test...
  ✓ Host responded to ping

Setup complete. Reload the extension in chrome://extensions/ to activate.
```

### Bail conditions
- `python3` not found → print "Install Python 3: https://python.org/downloads or `brew install python`. Then re-run." Exit 1.
- Workspace not found → print "Set up your Claude workspace first: KB2948102. Then re-run `./setup.sh`." Exit 1.
- `.claude/config.json` missing/unparseable → same as above.
- Extension ID auto-detect fails → fall back to interactive prompt with clear instructions on how to find the ID in `chrome://extensions/`.

### What it writes
- Pip-installs `pdfplumber` to user site (`--user`, no sudo).
- Writes one file: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.servicenow.send_to_claude.json` (and Chromium / Edge equivalents if those dirs exist).
- Marks `host/send_to_claude_host.py` executable.

### What it does NOT write
- Anything inside `~/my-claude-workspace/`.
- Any files outside the dirs listed above.

---

## 7. Test plan

### Automatable (one-shot greps + script smoke)

| Check | How |
|---|---|
| G1 — no SN write methods | `rg -n "method:\\s*['\"](POST\|PUT\|PATCH\|DELETE)['\"]" *.js lib/*.js` returns zero |
| Manifest validity | `python3 -m json.tool manifest.json > /dev/null` |
| URL match patterns intact | `grep -c "sn_customerservice_case.do" manifest.json` returns 2 |
| Icons unchanged | `git diff --stat icons/` is empty |
| Host ping smoke | `printf '%s' "$(printf 'ping' \| python3 -c '...frame...')" \| python3 host/send_to_claude_host.py` returns ok |
| Bundled parser runs | `python3 host/parser.py --help` returns 0 |

### Manual (Darion, real Chrome, real SN)

| ID | Test | Expected |
|---|---|---|
| M1 | First click on an unseen primary case | `cases/CS<n>/` created with PDF, attachments/, tasks/, tracker.md populated. Activity log has one line. |
| M2 | Second click on same case | `last_synced` advances; new attachment appears if added in SN; no duplicates in tracker. |
| M3 | Open a case assigned to teammate, click | Reference-mode prompt fires. Confirm with current case → file lands in `refs/`. No tracker for the reference case. |
| M4 | Open a closed case (Solution Proposed/Closed/Resolved), click | Reference-mode prompt regardless of assignment. |
| M5 | Delete an attachment from SN, re-pull | Local file remains. Tracker entry has `removed_from_source: true`. |
| M6 | Open a KB article page, click | KB PDF lands at `knowledge/KB<n>.pdf`. |
| M7 | DevTools Network during pull | Zero non-GET requests to SN. |
| M8 | Button still appears on case form (regression) | Button injects on `sn_customerservice_case.do?...` and `nav_to.do?uri=...` variants. |
| M9 | Workspace dir deleted post-install | Click → `Failed ✗` alert with parser-error message. (Recovery: re-run KB2948102 setup.) |

---

## 8. Risks and unknowns

1. **Reference-mode UX:** v1 uses `window.prompt()` (no popup). Adds zero manifest surface. If the prompt UX is rough, add `chrome.action.default_popup` in v2.
2. **`partner_tse_email` resolution from `assigned_to`:** SN REST may need a follow-up `/sys_user/<sys_id>?sysparm_fields=email` lookup. Background.js does the lookup as a fallback when `assigned_to.email` isn't returned in the case record.
3. **Bulk attachment fetches:** sequential, no rate-limit data. Per-blob timeout 60s; total 600s. If observed too slow, parallelize.
4. **Service worker lifetime during long ingest:** MV3 service workers can be killed mid-fetch. `chrome.runtime.connectNative()` keeps the worker alive while the port is open. If a 600s host call gets killed, surface the error and let user retry.
5. **Bundled parser drift:** `host/parser.py` is a copy of the workspace parser. CLAUDE.md notes this; manual sync when the workspace parser meaningfully changes.

---

## 9. Implementation order (in flight)

1. **REFACTOR_PLAN.md** updated to reflect approved shape ✓
2. `manifest.json` + `host/com.servicenow.send_to_claude.json` template
3. `setup.sh` + `uninstall.sh`
4. `host/send_to_claude_host.py` + `host/parser.py` (bundled)
5. `lib/sn-api.js`, `lib/messaging.js`, `background.js` (replace)
6. `content.js` (extend)
7. `options.html` + `options.js` (extend)
8. `README.md` + `CLAUDE.md`
9. Run automatable tests; manual matrix M1–M9 with Darion

Commits at logical breakpoints (1, 2+3, 4, 5+6, 7, 8). **No push.**

---

## 10. What I will not do

- Move source files into a subfolder.
- Replace icons.
- Broaden URL match patterns.
- Replace the DOM probe.
- Add SN write API calls.
- Auto-create the workspace.
- Bypass the bundled parser.
