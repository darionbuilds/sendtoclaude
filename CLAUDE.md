# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What This Is

Chrome MV3 extension that ingests ServiceNow records (cases, tasks, KB articles) into a local Claude workspace at `~/my-claude-workspace/`. Read-only against ServiceNow.

## Repo Layout (flat — do not change)

The extension repo root **is** the loaded extension. `Load unpacked → select this folder` must continue to work. Do not move `manifest.json`, `background.js`, `content.js`, `options.html`, `options.js`, or `icons/` into a subfolder.

```
SendToClaudeExtension/        ← Chrome loads THIS folder
├── manifest.json             ← MV3 manifest (module service worker)
├── background.js             ← service worker, ES module
├── content.js                ← content script (IIFE; not a module)
├── options.html
├── options.js
├── icons/{16,48,128}.png     ← Darion's. Do not regenerate.
├── lib/                      ← ES modules imported by background.js
│   ├── sn-api.js             ← SN REST helpers (GET only — G1)
│   ├── messaging.js          ← native host bridge
│   └── url-detect.js         ← URL → record context
├── host/                     ← native messaging host (Python)
│   ├── send_to_claude_host.py
│   ├── parser.py             ← BUNDLED copy of case-pdf-parse.py
│   └── com.servicenow.send_to_claude.json   ← manifest template
├── setup.sh                  ← one-command installer
├── uninstall.sh
├── README.md
└── REFACTOR_PLAN.md          ← v1 → v2 design history
```

## No Build Step

Pure JavaScript + Python. No bundler, no compilation. Reload via `chrome://extensions/` after any change.

## Critical Invariants

These were broken by a previous refactor and reverted. Do not break them again.

1. **Flat repo layout** — extension root is the loaded folder.
2. **Existing icons** at `icons/icon{16,48,128}.png` are not regenerated.
3. **Content script `matches`** — case + task + KB patterns are listed explicitly; do not collapse into `*://*.service-now.com/*`.
4. **DOM probe in `getCaseInfo()`** in `content.js` is preserved character-for-character (works empirically on real SN forms).
5. **Four-state button** (`ready` / `sending` / `ok` / `error`) injected into `.navbar_ui_actions`, with 4 s auto-reset. A 5th `setup` state was added for host-not-available; the four base states are unchanged.
6. **`/<table>.do?PDF&sys_id=<id>`** URL pattern for record PDF export — proven on `support.servicenow.com`.
7. **`chrome.storage.sync`** for any persisted settings.
8. **Read-only against ServiceNow** — only GET requests in `lib/sn-api.js`. Verified by `rg -n "method:\\s*['\"](POST\|PUT\|PATCH\|DELETE)['\"]" *.js lib/*.js` returning zero.

## Architecture

Three layers, message-passing between them:

```
content.js   ──sendMessage──▶  background.js   ──connectNative──▶  host/send_to_claude_host.py
   ▲                                ▲                                       │
   │                                │                                       ▼
   └──── window.prompt ─────────────┘                            host/parser.py
                                                                            │
                                                                            ▼
                                                              ~/my-claude-workspace/
                                                                cases/CS<n>/...
```

### `content.js`
Injects the button into `.navbar_ui_actions`. Detects page type (case/task vs KB). Reads case info from the DOM (preserved). Sends `{kind: 'ingest', url, dom}` to background on click. Handles the reference-mode prompt round-trip via `window.prompt()`.

### `background.js`
ES module. Resolves the case record via SN REST. Determines primary vs reference based on `partner_tse_email` from workspace config + case state. Fetches the full envelope (case PDF, attachments, tasks, task PDFs, task attachments) for primary-mode pulls. Calls the native host with a single bundled payload.

### `host/send_to_claude_host.py`
Native messaging host. Reads workspace config from `~/my-claude-workspace/.claude/config.json`. Writes files. Shells out to **the bundled parser** at `host/parser.py` (not the workspace's copy). Populates `cases/CS<n>/tracker.md` frontmatter.

### `host/parser.py`
Bundled snapshot of the workspace's `case-pdf-parse.py`. The host always uses this copy so a parser-version drift in the workspace cannot break ingest. **When the workspace parser meaningfully changes, manually copy it here:** `cp ~/my-claude-workspace/.claude/scripts/case-pdf-parse.py host/parser.py`.

## Workspace Contract

The extension reads from (never writes to):

- `~/my-claude-workspace/.claude/config.json`:
  - `workspace_root` — absolute path
  - `partner_tse_email` — used for primary/reference decision

It writes to:

- `~/my-claude-workspace/cases/CS<n>/...`
- `~/my-claude-workspace/knowledge/KB<n>.pdf`

It never writes outside `workspace_root`. Setup never auto-creates the workspace; the user must set it up per KB2948102 first.

## Configuration

Two pieces of state:

- **`chrome.storage.sync`** — currently unused by the new code paths but reserved per invariant 7. Older versions stored `downloadDirectory` / `workspacePath` here; new code reads workspace config from the host instead.
- **`~/my-claude-workspace/.claude/config.json`** — sourced via the host's `read_config` op.

## URL Patterns

Content script runs on:

- `support.servicenow.com/sn_customerservice_case.do*` (+ `nav_to.do?uri=...` variant)
- `support.servicenow.com/sn_customerservice_task.do*` (+ `nav_to.do?uri=...` variant)
- `support.servicenow.com/kb_view.do*` (+ `nav_to.do?uri=...` variant)
- `support.servicenow.com/kb_knowledge.do*` (+ `nav_to.do?uri=...` variant)

`all_frames: true` to handle iframe-embedded forms. `host_permissions` is just `https://support.servicenow.com/*`.

## Permissions

- `downloads` — retained from v1; harmless and may be used for future fallback paths.
- `storage` — settings.
- `nativeMessaging` — required for `chrome.runtime.connectNative`.
- `host_permissions: https://support.servicenow.com/*` — for SN REST + PDF endpoint.

## When You Edit

- **Don't broaden `content_scripts.matches`.** Add new specific patterns if needed.
- **Don't add SN write-method calls.** All `fetch()` calls live in `lib/sn-api.js` and use the `COMMON_OPTS` GET-only object. Do not bypass it.
- **Don't change `getCaseInfo()` in `content.js`** without testing on a real SN form.
- **Don't auto-create the workspace** in `setup.sh`. Reference KB2948102 instead.
- **Bundled parser drift:** if you change the workspace parser, manually re-copy to `host/parser.py`.

## Testing

Automatable:
```bash
# G1 — no SN write methods
rg -n "method:\\s*['\"](POST|PUT|PATCH|DELETE)['\"]" *.js lib/*.js

# Manifest validity
python3 -m json.tool manifest.json > /dev/null

# Host smoke
python3 -c "
import json, struct, subprocess
msg = json.dumps({'op':'ping'}).encode()
proc = subprocess.run(['python3','host/send_to_claude_host.py'],
  input=struct.pack('<I',len(msg))+msg, capture_output=True, timeout=15)
out = proc.stdout
n = struct.unpack('<I', out[:4])[0]
print(out[4:4+n].decode())
"
```

Manual matrix lives in `REFACTOR_PLAN.md` §7.
