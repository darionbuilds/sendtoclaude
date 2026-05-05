// options.js — surfaces native host status + workspace contract.

function setText(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls || '';
}

function showSetupNeeded(detail) {
  document.getElementById('setup-card').style.display = '';
  document.getElementById('setup-detail').textContent = detail || '';
}

function hideSetupNeeded() {
  document.getElementById('setup-card').style.display = 'none';
}

async function pingHost() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind: 'ping_host' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'no response' });
    });
  });
}

async function refresh() {
  setText('host-status', 'checking…', 'pend');
  setText('workspace-path', '—', 'pend');
  setText('partner-email', '—', 'pend');
  setText('host-version', '—', 'pend');

  const r = await pingHost();
  if (r.ok && r.result && r.result.ok) {
    const inner = r.result;
    setText('host-status', 'ok ✓', 'ok');
    setText('workspace-path', inner.workspace_root || '—', '');
    setText('partner-email', inner.partner_tse_email || '—', '');
    setText('host-version', inner.host_version || '—', '');
    hideSetupNeeded();
    return;
  }

  const err = (r.error || (r.result && r.result.error) || 'host unreachable');
  setText('host-status', 'not connected ✗', 'bad');
  showSetupNeeded(err);
}

document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill the setup command with the extension's loaded path if we can
  // resolve it (Chrome doesn't expose the unpacked path, but extension ID
  // gives us a hint for users to find it).
  const setupCmd = document.getElementById('setup-cmd');
  if (setupCmd) {
    setupCmd.textContent =
      'cd <path-to-SendToClaudeExtension>\n' +
      './setup.sh';
  }

  refresh();
  document.getElementById('recheck').addEventListener('click', async () => {
    const status = document.getElementById('recheck-status');
    status.textContent = '';
    await refresh();
    status.textContent = 'Refreshed.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
