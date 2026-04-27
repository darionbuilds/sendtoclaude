# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Chrome MV3 extension that adds a "Send to Claude" button to ServiceNow case and task forms. Clicking the button downloads the case as a PDF into a configurable workspace folder (default: `~/my-claude-workspace/`), named by case number (e.g. `CS0001234.pdf`).

## No Build Step

Pure vanilla JavaScript — no package.json, bundler, or compilation. Load unpacked via `chrome://extensions` → Developer mode → Load unpacked → select this directory. After any file change, click the refresh icon on the extension card and reload the ServiceNow tab.

## Configuration

An options page (`options.html` + `options.js`) lets users configure two settings stored in `chrome.storage.sync`:

- **Your browser's configured download folder** (default: `~/Downloads`) — must match what Chrome already has set in Settings → Downloads → Location. Chrome provides no API to read this programmatically, so the user enters it manually. Used only for the live path preview and symlink command; it does not affect the actual download (Chrome controls that).
- **Workspace subfolder** (default: `my-claude-workspace`) — subfolder relative to the download directory where PDFs land. This is the only value `background.js` uses.

The options page warns that most users should leave defaults unchanged — deviating requires manually re-running the setup command, and a mismatch between the symlink and the configured paths will silently break delivery. It shows a live **"Files will save to:"** preview combining both values, and a ready-to-run `mkdir`/`ln -s` setup command that adapts to the user's actual paths.

Access via right-click extension icon → Options, or `chrome://extensions` → Details → Extension options.

## Architecture

Three scripts plus an options page; scripts communicate via Chrome message passing:

**`content.js`** — injected into ServiceNow case/task pages at `document_end`
- Reads case metadata from the DOM (`getCaseInfo`): case number, `sys_id`, and table name
- Injects a button into `.navbar_ui_actions` (uses a `MutationObserver` with a 15 s timeout if the element isn't ready yet)
- On click: sends `downloadCasePDF` message to the background worker, then updates a 4-state button (ready → sending → ok/error → auto-reset)
- Also listens for async `downloadFailed` messages from the background worker for mid-flight failures

**`background.js`** — service worker (MV3)
- Receives `downloadCasePDF`, reads `workspaceFolder` from `chrome.storage.sync`, then calls `chrome.downloads.download()` with the URL `https://support.servicenow.com/{tableName}.do?PDF&sys_id={sysId}` and filename `{workspaceFolder}/{caseNum}.pdf`
- Tracks in-flight downloads in `pendingDownloads` (Map of downloadId → tabId) to forward async interruption errors back to the content script

**`options.html` / `options.js`** — settings UI
- Persists `downloadDirectory` (default: `~/Downloads`) and `workspaceFolder` (default: `my-claude-workspace`) to `chrome.storage.sync`
- Sanitizes input: strips trailing slashes, normalizes backslashes to forward slashes
- Shows a live "Files will save to:" preview and a generated `mkdir`/`ln -s` setup command as both fields change

**Why the split:** content scripts cannot access `chrome.downloads`; only the service worker can.

## URL Patterns

Content script runs on four `https://support.servicenow.com/` patterns covering direct case/task URLs and `nav_to.do` redirect variants, with `all_frames: true` to handle iframe-embedded forms.

## Workspace Path

Chrome extensions cannot read or change the browser's configured download directory — `chrome.downloads.download()` filenames are always relative to it. The `downloadDirectory` setting exists only for display purposes (path preview + symlink command generation). The `workspaceFolder` setting is the only value passed to `chrome.downloads.download()`. The README symlink setup routes the download subfolder to the actual Claude workspace on disk.
