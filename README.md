# Send to Claude

Chrome extension that adds a **Send to Claude** button to ServiceNow case, task, and KB pages on `support.servicenow.com`. One click ingests the record into your local Claude workspace — case PDF, attachments, CSTASKs (with their PDFs and attachments), and a populated `tracker.md`.

Read-only against ServiceNow. The extension never writes upstream.

## Prerequisites

- **Claude workspace set up** per **KB2948102**. The workspace lives at `~/my-claude-workspace/` and contains `.claude/config.json`.
- **Python 3** on your system (macOS ships it; Linux: `apt install python3 python3-pip`).
- **Chrome / Chromium / Edge** on macOS or Linux. (Windows install script is a stub for v1.)

If the workspace isn't set up, `setup.sh` will tell you and stop.

## Install

1. Clone or download this repo.
2. **Load unpacked:**
   1. Open `chrome://extensions/`
   2. Enable **Developer mode** (top right)
   3. Click **Load unpacked** → select this folder (the repo root)
3. **Run setup once:**
   ```bash
   ./setup.sh
   ```
   The script auto-detects your extension ID, creates an isolated Python venv at `host/.venv/`, installs `pdfplumber` into it, writes the native messaging manifest, and smoke-tests the host. It will not modify your workspace.
4. **Reload the extension** in `chrome://extensions/` so the new permissions take effect.
5. **Verify:** right-click the extension icon → Options. The Status card should show **Host: ok ✓** with your workspace path and partner TSE email.

## Usage

Click **Send to Claude** on any case, task, or KB page. The button cycles through:

- **Send to Claude** (orange) — ready
- **Sending…** (dark orange) — fetch + host write in flight
- **Sent ✓** (green) — done; auto-resets after 4 s
- **Failed ✗** (red) — error; alert shows details
- **Setup needed ⚠** (yellow) — host not installed or stale; open the Options page

### Primary vs Reference mode

The extension reads `partner_tse_email` from your workspace config. When you click on a case:

- If the case is **assigned to you** and not in a closed state → **Primary mode**: full pull (case PDF + attachments + tasks + task attachments + populated tracker).
- Otherwise → **Reference mode**: a prompt asks which primary case this should be filed under. The single record's PDF lands at `cases/CS<primary>/refs/CS<reference>-<name>.pdf`. **No tracker is created or updated** for the reference case (G4).

### Subsequent clicks (delta sync)

Re-clicking a case you've already pulled does an incremental sync: only new attachments are downloaded, removed-from-source attachments get flagged in the tracker (the local file is preserved), and the tracker's `last_synced` advances.

## Where files land

```
~/my-claude-workspace/
├── cases/
│   └── CS<n>/
│       ├── CS<n>.pdf
│       ├── tracker.md           ← populated by the host from parser output
│       ├── attachments/
│       │   └── <sys_id>-<file>
│       ├── tasks/
│       │   └── CSTASK<m>.pdf
│       │   └── CSTASK<m>/attachments/<sys_id>-<file>
│       └── refs/                ← reference-mode snapshots (no tracker)
│           └── CS<n>-<file>
└── knowledge/
    └── KB<n>.pdf                ← KB articles
```

## Settings

Right-click the extension icon → **Options**. The Options page shows:

- **Host status** — green ok / red not connected
- **Workspace path** — sourced from `~/my-claude-workspace/.claude/config.json`
- **Partner TSE email** — same source
- **Host version**

If the host is not connected, the page shows a setup-needed panel with the exact `./setup.sh` command to run.

## Uninstall

Remove the native messaging host:
```bash
./uninstall.sh
```
Then remove the extension via `chrome://extensions/`. Your workspace is untouched.

## Troubleshooting

**Button doesn't appear on the case form.** The form's `.navbar_ui_actions` element isn't ready yet. Wait a couple of seconds; the content script retries via MutationObserver for 15 s. If it still doesn't appear, reload the page.

**"Native host not installed."** Run `./setup.sh` from the repo root.

**"Native host install is stale (extension ID mismatch)."** The extension was reloaded with a new ID. Re-run `./setup.sh`.

**"Workspace config not found at ..."** Set up the workspace per KB2948102, then re-click.

**Setup script can't auto-detect extension ID.** It will prompt you to paste it. Find it in `chrome://extensions/` — the 32-char string under the extension name.

## Architecture

Three components:

1. **Content script** (`content.js`) — injects the button onto SN forms; reads case info from the DOM (preserved verbatim from the v1 extension); sends the click to background.
2. **Background service worker** (`background.js` + `lib/`) — fetches the case envelope from SN REST (read-only, GET only), bundles it as base64, calls the native host.
3. **Native messaging host** (`host/send_to_claude_host.py`) — writes files into the workspace, shells out to the bundled parser (`host/parser.py`), populates `tracker.md`.

Read `docs/case-ingestion-architecture.md` in the workspace for the full design.
