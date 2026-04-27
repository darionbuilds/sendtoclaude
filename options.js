const DEFAULTS = {
  workspaceFolder: 'my-claude-workspace',
};

function sanitizeFolder(raw) {
  return raw
    .trim()
    .replace(/\\/g, '/')       // normalize backslashes
    .replace(/\/+$/, '')       // strip trailing slashes
    .replace(/^\/+/, '');      // strip leading slashes
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    document.getElementById('workspaceFolder').value = items.workspaceFolder;
  });
}

function save() {
  const raw = document.getElementById('workspaceFolder').value;
  const workspaceFolder = sanitizeFolder(raw);

  chrome.storage.sync.set({ workspaceFolder }, () => {
    document.getElementById('workspaceFolder').value = workspaceFolder;
    const status = document.getElementById('status');
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', load);
document.getElementById('save').addEventListener('click', save);
