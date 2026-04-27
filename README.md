# Send to Claude

Chrome extension that adds a **Send to Claude** button to ServiceNow case forms. One click downloads the case as a PDF, named by case number, directly into `~/my-claude-workspace`.

## Setup

**1. Create the workspace and symlink** (one-time, any machine):

```bash
mkdir -p ~/my-claude-workspace
ln -s ~/my-claude-workspace ~/Downloads/my-claude-workspace
```

The symlink lets Chrome write outside its default Downloads folder with zero runtime overhead. It will appear as an alias in Finder — that's expected.

**2. Load the extension:**

1. Open `chrome://extensions` and enable **Developer mode** (top right)
2. Click **Load unpacked** → select this folder
3. Open any ServiceNow case — the button appears in the navbar next to QuickSearch

**3. Chrome download setting:**

Go to **Settings → Downloads** and turn **off** "Ask where to save each file before downloading" so PDFs drop instantly with no prompt.

## Usage

Click **Send to Claude** on any case or task. The PDF will appear in `~/my-claude-workspace` named after the case number (e.g. `CS0001234.pdf`).
