(function () {
  if (document.getElementById('send-to-claude-btn')) return;

  function getCaseInfo() {
    const isTask = !!document.getElementById('sys_readonly.sn_customerservice_task.number');
    const tableName = isTask ? 'sn_customerservice_task' : 'sn_customerservice_case';

    const caseNum =
      document.getElementById('sys_readonly.' + tableName + '.number')?.value?.trim();

    // Try standard hidden sys_id field first, then fall back to URL
    let sysId = document.getElementById('sys_uniqueValue')?.value?.trim();
    if (!sysId) {
      const url = new URL(window.location.href);
      sysId = url.searchParams.get('sys_id');
      if (!sysId) {
        const uri = url.searchParams.get('uri');
        if (uri) {
          const inner = new URLSearchParams(decodeURIComponent(uri).split('?')[1] || '');
          sysId = inner.get('sys_id');
        }
      }
    }

    return { caseNum, sysId, tableName };
  }

  function setButtonState(btn, state) {
    const states = {
      ready:   { label: 'Send to Claude', bg: '#cc6600', disabled: false },
      sending: { label: 'Sending…',       bg: '#995500', disabled: true  },
      ok:      { label: 'Sent ✓',         bg: '#006600', disabled: true  },
      error:   { label: 'Failed ✗',       bg: '#cc0000', disabled: true  },
    };
    const s = states[state];
    btn.innerHTML = '<b>' + s.label + '</b>';
    btn.style.backgroundColor = s.bg;
    btn.disabled = s.disabled;
  }

  function injectButton() {
    // Only inject in the frame that actually has the case form
    const { caseNum, sysId, tableName } = getCaseInfo();
    if (!caseNum) return false;

    const navbarActions = document.querySelector('.navbar_ui_actions');
    if (!navbarActions) return false;

    const btn = document.createElement('button');
    btn.id = 'send-to-claude-btn';
    btn.style.cssText =
      'color:white;margin-left:1em;display:inline-block;background-color:#cc6600;' +
      'font-family:inherit;cursor:pointer;padding:4px 12px;border:none;border-radius:3px;';
    setButtonState(btn, 'ready');

    btn.addEventListener('click', () => {
      const info = getCaseInfo(); // re-read in case DOM updated

      if (!info.caseNum || !info.sysId) {
        alert('Send to Claude: could not read case number or sys_id from this page.');
        return;
      }

      setButtonState(btn, 'sending');

      chrome.runtime.sendMessage(
        { action: 'downloadCasePDF', ...info },
        (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            setButtonState(btn, 'error');
            setTimeout(() => setButtonState(btn, 'ready'), 4000);
            alert('Send to Claude error:\n' + msg);
          } else if (response?.success) {
            setButtonState(btn, 'ok');
            setTimeout(() => setButtonState(btn, 'ready'), 4000);
          } else {
            const msg = response?.error || 'Unknown error';
            setButtonState(btn, 'error');
            setTimeout(() => setButtonState(btn, 'ready'), 4000);
            alert('Send to Claude error:\n' + msg);
          }
        }
      );
    });

    navbarActions.prepend(btn);
    return true;
  }

  if (!injectButton()) {
    const observer = new MutationObserver(() => {
      if (injectButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Give up after 15 s to avoid leaking observers on non-case pages
    setTimeout(() => observer.disconnect(), 15000);
  }

  // Receives async failure notifications from the background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'downloadFailed') return;
    const btn = document.getElementById('send-to-claude-btn');
    if (btn) {
      setButtonState(btn, 'error');
      setTimeout(() => setButtonState(btn, 'ready'), 4000);
    }
    alert('Send to Claude — download failed:\n' + message.error);
  });
})();
