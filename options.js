const DEFAULTS = {
  downloadDirectory: '~/Downloads',
  workspacePath: '~/my-claude-workspace',
};

function sanitizePath(raw) {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

function folderName(workspacePath) {
  return workspacePath.split('/').pop();
}

function updatePreview() {
  const dir = sanitizePath(document.getElementById('downloadDirectory').value);
  const workspace = sanitizePath(document.getElementById('workspacePath').value);

  document.getElementById('previewPath').textContent =
    workspace ? `${workspace}/` : '—';

  const symlinkSection = document.getElementById('symlinkSection');
  const symlinkCmd = document.getElementById('symlinkCmd');
  const folder = workspace ? folderName(workspace) : '';

  if (workspace && dir && folder) {
    symlinkCmd.textContent = `mkdir -p ${workspace} && ln -s ${workspace} ${dir}/${folder}`;
    symlinkSection.style.display = '';
  } else {
    symlinkSection.style.display = 'none';
  }
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    document.getElementById('downloadDirectory').value = items.downloadDirectory;
    document.getElementById('workspacePath').value = items.workspacePath;
    updatePreview();
  });
}

function save() {
  const downloadDirectory = sanitizePath(document.getElementById('downloadDirectory').value) || DEFAULTS.downloadDirectory;
  const workspacePath = sanitizePath(document.getElementById('workspacePath').value) || DEFAULTS.workspacePath;

  document.getElementById('downloadDirectory').value = downloadDirectory;
  document.getElementById('workspacePath').value = workspacePath;

  chrome.storage.sync.set({ downloadDirectory, workspacePath }, () => {
    updatePreview();
    const status = document.getElementById('status');
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('downloadDirectory').addEventListener('input', updatePreview);
  document.getElementById('workspacePath').addEventListener('input', updatePreview);
  document.getElementById('save').addEventListener('click', save);
});
