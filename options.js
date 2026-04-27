const DEFAULTS = {
  downloadDirectory: '~/Downloads',
  workspaceFolder: 'my-claude-workspace',
};

function sanitizeFolder(raw) {
  return raw
    .trim()
    .replace(/\\/g, '/')   // normalize backslashes
    .replace(/\/+$/, '')   // strip trailing slashes
    .replace(/^\/+/, '');  // strip leading slashes
}

function sanitizeDir(raw) {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');  // strip trailing slashes only
}

function updatePreview() {
  const dir = sanitizeDir(document.getElementById('downloadDirectory').value) || '~/Downloads';
  const folder = sanitizeFolder(document.getElementById('workspaceFolder').value);

  const fullPath = folder ? `${dir}/${folder}/` : `${dir}/`;
  document.getElementById('previewPath').textContent = fullPath;

  const symlinkSection = document.getElementById('symlinkSection');
  const symlinkCmd = document.getElementById('symlinkCmd');

  if (folder) {
    // Suggest a symlink from the download subfolder to ~/my-claude-workspace
    // (user may want a different target, but this matches the README convention)
    const target = `~/${folder}`;
    const link = `${dir}/${folder}`;
    symlinkCmd.textContent = `mkdir -p ${target} && ln -s ${target} ${link}`;
    symlinkSection.style.display = '';
  } else {
    symlinkSection.style.display = 'none';
  }
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    document.getElementById('downloadDirectory').value = items.downloadDirectory;
    document.getElementById('workspaceFolder').value = items.workspaceFolder;
    updatePreview();
  });
}

function save() {
  const downloadDirectory = sanitizeDir(document.getElementById('downloadDirectory').value) || DEFAULTS.downloadDirectory;
  const workspaceFolder = sanitizeFolder(document.getElementById('workspaceFolder').value);

  document.getElementById('downloadDirectory').value = downloadDirectory;
  document.getElementById('workspaceFolder').value = workspaceFolder;

  chrome.storage.sync.set({ downloadDirectory, workspaceFolder }, () => {
    updatePreview();
    const status = document.getElementById('status');
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('downloadDirectory').addEventListener('input', updatePreview);
  document.getElementById('workspaceFolder').addEventListener('input', updatePreview);
  document.getElementById('save').addEventListener('click', save);
});
