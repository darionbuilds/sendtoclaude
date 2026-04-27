# Send to Claude

Chrome extension that adds a **Send to Claude** button to ServiceNow case forms. One click downloads the case as a PDF, named by case number, into your configured workspace folder.

## Setup

**1. Create your workspace and symlink** (one-time, any machine):

```bash
mkdir -p ~/my-claude-workspace
ln -s ~/my-claude-workspace ~/Downloads/my-claude-workspace
```

The symlink lets Chrome write outside its default Downloads folder with zero runtime overhead. It will appear as an alias in Finder — that's expected.

> **Non-default download folder?** If Chrome is configured to download somewhere other than `~/Downloads`, use that path instead. The Options page will show you the exact command to run once you've entered your paths.

**2. Load the extension:**

1. Open `chrome://extensions` and enable **Developer mode** (top right)
2. Click **Load unpacked** → select this folder
3. Open any ServiceNow case — the button appears in the navbar next to QuickSearch

**3. Chrome download setting:**

Go to **Settings → Downloads** and turn **off** "Ask where to save each file before downloading" so PDFs drop instantly with no prompt.

## Usage

Click **Send to Claude** on any case or task. The PDF will appear in your configured workspace folder, named after the case number (e.g. `CS0001234.pdf`).

## Settings

Right-click the extension icon → **Options** (or go to `chrome://extensions` → Details → Extension options).

> **Most users should leave these at their defaults.** Changing them requires manually re-running the Terminal setup command. If your symlink and download folder get out of sync, PDFs will not reach your Claude workspace.

| Setting | Default | Description |
|---|---|---|
| Your browser's configured download folder | `~/Downloads` | Must match what's set in Chrome **Settings → Downloads → Location**. This extension cannot read or change that setting — keep this field in sync manually. Used only to display the full resolved path and generate the setup command. |
| Workspace subfolder | `my-claude-workspace` | Folder created inside your download folder where PDFs land. Use forward slashes for nested paths, e.g. `Work/claude-cases`. Leave blank to save directly into the download folder. |

The Options page shows a live **"Files will save to:"** preview and a one-time Terminal setup command that updates as you type.

Settings sync across Chrome profiles via `chrome.storage.sync`.
