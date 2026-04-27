// Maps downloadId → tabId for in-flight downloads initiated by this extension
const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'downloadCasePDF') return false;

  const { sysId, tableName, caseNum } = message;
  const tabId = sender.tab?.id;
  const pdfUrl = `https://support.servicenow.com/${tableName}.do?PDF&sys_id=${sysId}`;
  const filename = caseNum ? `my-claude-workspace/${caseNum}.pdf` : undefined;

  chrome.downloads.download(
    { url: pdfUrl, saveAs: false, conflictAction: 'uniquify', filename },
    (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message ?? 'Download failed to start' });
      } else {
        if (tabId !== undefined) pendingDownloads.set(downloadId, tabId);
        sendResponse({ success: true });
      }
    }
  );

  return true; // keep message channel open for async response
});

// Catch failures that happen after the download is already in-flight
chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id)) return;

  const state = delta.state?.current;
  if (state === 'complete') {
    pendingDownloads.delete(delta.id);
  } else if (state === 'interrupted') {
    const tabId = pendingDownloads.get(delta.id);
    const error = delta.error?.current ?? 'Download interrupted';
    pendingDownloads.delete(delta.id);
    chrome.tabs.sendMessage(tabId, { action: 'downloadFailed', error }, () => {
      void chrome.runtime.lastError; // swallow if tab/context is already gone
    });
  }
});
