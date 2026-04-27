# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Chrome MV3 extension that adds a "Send to Claude" button to ServiceNow case and task forms. Clicking the button downloads the case as a PDF into `~/my-claude-workspace/` (named by case number, e.g. `CS0001234.pdf`).

## No Build Step

Pure vanilla JavaScript — no package.json, bundler, or compilation. Load unpacked via `chrome://extensions` → Developer mode → Load unpacked → select this directory. After any file change, click the refresh icon on the extension card and reload the ServiceNow tab.

## Architecture

Two scripts communicate via Chrome message passing:

**`content.js`** — injected into ServiceNow case/task pages at `document_end`
- Reads case metadata from the DOM (`getCaseInfo`): case number, `sys_id`, and table name
- Injects a button into `.navbar_ui_actions` (uses a `MutationObserver` with a 15 s timeout if the element isn't ready yet)
- On click: sends `downloadCasePDF` message to the background worker, then updates a 4-state button (ready → sending → ok/error → auto-reset)
- Also listens for async `downloadFailed` messages from the background worker for mid-flight failures

**`background.js`** — service worker (MV3)
- Receives `downloadCasePDF` and calls `chrome.downloads.download()` with the URL `https://support.servicenow.com/{tableName}.do?PDF&sys_id={sysId}` and filename `my-claude-workspace/{caseNum}.pdf`
- Tracks in-flight downloads in `pendingDownloads` (Map of downloadId → tabId) to forward async interruption errors back to the content script

**Why the split:** content scripts cannot access `chrome.downloads`; only the service worker can.

## URL Patterns

Content script runs on four `https://support.servicenow.com/` patterns covering direct case/task URLs and `nav_to.do` redirect variants, with `all_frames: true` to handle iframe-embedded forms.

## Workspace Path

The download path `my-claude-workspace/` is relative to Chrome's default download directory. The README setup uses a symlink: `~/Downloads/my-claude-workspace` → `~/my-claude-workspace`, so files land in `~/my-claude-workspace/`.
