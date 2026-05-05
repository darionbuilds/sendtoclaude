// messaging.js — Native messaging host bridge.
//
// One-shot per call: extension opens a port, sends one JSON request, expects
// one JSON response, closes the port. Host process exits after replying.

const HOST_NAME = "com.servicenow.send_to_claude";

export function callHost(op, payload, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      reject(new Error(
        `Native host not available: ${e.message}. ` +
        `Run ./setup.sh from the extension repo to install the host.`
      ));
      return;
    }

    const t = setTimeout(() => {
      try { port.disconnect(); } catch (_) {}
      reject(new Error(`Native host call timed out after ${timeoutMs}ms (op=${op})`));
    }, timeoutMs);

    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { port.disconnect(); } catch (_) {}
      fn(val);
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") {
        settle(reject, new Error(`Host returned non-object: ${JSON.stringify(msg)}`));
        return;
      }
      if (msg.ok) settle(resolve, msg.result);
      else settle(reject, new Error(msg.error || "host error"));
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = err.message || "";
        // Translate the most common Chrome native-messaging error into something actionable.
        if (/not found/i.test(msg) || /not installed/i.test(msg)) {
          settle(reject, new Error(
            "Native host not installed. Run ./setup.sh from the extension repo."
          ));
        } else if (/forbidden/i.test(msg)) {
          settle(reject, new Error(
            "Native host install is stale (extension ID mismatch). Re-run ./setup.sh."
          ));
        } else {
          settle(reject, new Error(`Native host disconnected: ${msg}`));
        }
      } else {
        settle(reject, new Error("Native host disconnected without reply"));
      }
    });

    try {
      port.postMessage({ v: 1, op, payload: payload || {} });
    } catch (e) {
      settle(reject, new Error(`postMessage to host failed: ${e.message}`));
    }
  });
}

export async function ping() { return callHost("ping", {}); }
export async function readConfig() { return callHost("read_config", {}); }
