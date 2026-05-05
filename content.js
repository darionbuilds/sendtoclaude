(function () {
  if (document.getElementById('send-to-claude-btn')) return;

  // ---- Page-type detection ---------------------------------------------

  function isKbPage() {
    return /\/kb_(view|knowledge)\.do/.test(window.location.pathname);
  }

  // PRESERVED VERBATIM (invariant 4): the DOM probe that empirically
  // works on real SN forms for case + task pages.
  function getCaseInfo() {
    const isTask = !!document.getElementById('sys_readonly.sn_customerservice_task.number');
    const tableName = isTask ? 'sn_customerservice_task' : 'sn_customerservice_case';

    const caseNum =
      document.getElementById('sys_readonly.' + tableName + '.number')?.value?.trim();

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

  function getKbInfo() {
    const url = new URL(window.location.href);
    let kbNumber = url.searchParams.get('sysparm_article');
    if (kbNumber && /^KB\d+$/i.test(kbNumber)) {
      return { kbNumber: kbNumber.toUpperCase() };
    }
    // Try a couple of common DOM placements for KB number on the form.
    const candidates = [
      'sys_readonly.kb_knowledge.number',
      'kb_knowledge.number',
    ];
    for (const id of candidates) {
      const el = document.getElementById(id);
      const v = el?.value?.trim();
      if (v && /^KB\d+$/i.test(v)) return { kbNumber: v.toUpperCase() };
    }
    // Heading text fallback (KB record-view page).
    const h = document.querySelector('h1, .form_action_buttons')?.textContent || '';
    const m = h.match(/\bKB\d+\b/);
    if (m) return { kbNumber: m[0].toUpperCase() };
    return { kbNumber: null };
  }

  function pageProbe() {
    if (isKbPage()) {
      return { type: 'kb', ...getKbInfo() };
    }
    const info = getCaseInfo();
    return { type: 'case_or_task', ...info };
  }

  // ---- Button state machine --------------------------------------------

  function setButtonState(btn, state, customLabel) {
    const states = {
      ready:    { label: 'Send to Claude',   bg: '#cc6600', disabled: false },
      sending:  { label: 'Sending…',         bg: '#995500', disabled: true  },
      ok:       { label: 'Sent ✓',           bg: '#006600', disabled: true  },
      error:    { label: 'Failed ✗',         bg: '#cc0000', disabled: true  },
      setup:    { label: 'Setup needed ⚠',   bg: '#aa7700', disabled: false },
    };
    const s = states[state];
    btn.innerHTML = '<b>' + (customLabel || s.label) + '</b>';
    btn.style.backgroundColor = s.bg;
    btn.disabled = s.disabled;
  }

  function showError(btn, message) {
    setButtonState(btn, 'error');
    setTimeout(() => setButtonState(btn, 'ready'), 4000);
    alert('Send to Claude — ' + message);
  }

  // ---- Click handler ---------------------------------------------------

  function onClick(btn) {
    const probe = pageProbe();
    if (probe.type === 'case_or_task' && (!probe.caseNum || !probe.sysId)) {
      alert('Send to Claude: could not read case number or sys_id from this page.');
      return;
    }
    if (probe.type === 'kb' && !probe.kbNumber) {
      alert('Send to Claude: could not read KB number from this page.');
      return;
    }

    setButtonState(btn, 'sending');

    chrome.runtime.sendMessage(
      { kind: 'ingest', url: window.location.href, dom: probe },
      (response) => {
        if (chrome.runtime.lastError) {
          showError(btn, chrome.runtime.lastError.message);
          return;
        }
        if (!response || !response.ok) {
          const err = (response && response.error) || 'Unknown error';
          // Detect host-not-installed / setup needed cases for a softer state.
          if (/Native host not installed|setup\.sh|extension ID mismatch/.test(err)) {
            setButtonState(btn, 'setup');
            alert('Send to Claude — setup needed:\n\n' + err);
            return;
          }
          showError(btn, err);
          return;
        }

        if (response.mode === 'reference_prompt') {
          handleReferencePrompt(btn, response, probe);
          return;
        }

        // Success (primary, kb).
        setButtonState(btn, 'ok');
        setTimeout(() => setButtonState(btn, 'ready'), 4000);
      }
    );
  }

  function handleReferencePrompt(btn, response, probe) {
    const suggested = response.suggested_primary || '';
    const reasonText = response.reason === 'case_closed'
      ? 'This case is in a closed/SP state; ingesting as reference.'
      : (response.reason === 'not_assigned_to_owner'
          ? 'This case is not assigned to you; ingesting as reference.'
          : 'Ingesting as reference.');
    const promptMsg =
      reasonText + '\n\nWhich PRIMARY case is this a reference for?\n' +
      '(Press OK to confirm — defaults to the same case for peer-overflow.)';
    const primaryCase = window.prompt(promptMsg, suggested);
    if (primaryCase === null) {
      // User cancelled.
      setButtonState(btn, 'ready');
      return;
    }
    const trimmed = primaryCase.trim().toUpperCase();
    if (!/^CS\d+$/.test(trimmed)) {
      showError(btn, `Invalid primary case number: ${trimmed}`);
      return;
    }

    chrome.runtime.sendMessage(
      {
        kind: 'ingest_reference_confirmed',
        url: window.location.href,
        dom: probe,
        primaryCase: trimmed,
      },
      (response2) => {
        if (chrome.runtime.lastError) {
          showError(btn, chrome.runtime.lastError.message);
          return;
        }
        if (!response2 || !response2.ok) {
          showError(btn, (response2 && response2.error) || 'Unknown error');
          return;
        }
        setButtonState(btn, 'ok');
        setTimeout(() => setButtonState(btn, 'ready'), 4000);
      }
    );
  }

  // ---- Button injection ------------------------------------------------

  function injectButton() {
    const probe = pageProbe();
    if (probe.type === 'case_or_task' && !probe.caseNum) return false;
    if (probe.type === 'kb' && !probe.kbNumber) return false;

    const navbarActions = document.querySelector('.navbar_ui_actions');
    if (!navbarActions) return false;

    const btn = document.createElement('button');
    btn.id = 'send-to-claude-btn';
    btn.style.cssText =
      'color:white;margin-left:1em;display:inline-block;background-color:#cc6600;' +
      'font-family:inherit;cursor:pointer;padding:4px 12px;border:none;border-radius:3px;';
    setButtonState(btn, 'ready');

    btn.addEventListener('click', () => onClick(btn));
    navbarActions.prepend(btn);
    return true;
  }

  if (!injectButton()) {
    const observer = new MutationObserver(() => {
      if (injectButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
