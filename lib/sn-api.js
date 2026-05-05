// sn-api.js — Read-only ServiceNow REST helpers.
//
// G1 (Permanent Guardrail per docs/case-ingestion-architecture.md §2):
// READ-ONLY against ServiceNow. Every helper here uses fetch with method GET
// only. There are zero POST/PUT/PATCH/DELETE calls.
//
// IMPORTANT — execution context:
//
// Service worker fetches don't carry the user's HI session cookies because
// of SameSite=Lax restrictions on support.servicenow.com cookies (the
// service worker's origin is chrome-extension://..., which is cross-site
// to support.servicenow.com). Instead, every fetch here is routed through
// chrome.scripting.executeScript against the SAME FRAME that content.js
// injected into — the frame's request inherits the user's session cookies
// natively.
//
// ctx = { tabId, frameId } — captured from sender.tab.id / sender.frameId
// in background.js's message handler.

const COMMON_HEADERS = {
  "Accept": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

// Runs in the page's isolated world (same world as the content script,
// thus same origin/cookies as the SN frame). Returns { ok, value, error }.
function _pageFetch(url, binary, headers) {
  return new Promise((resolve) => {
    fetch(url, { method: "GET", credentials: "include", headers })
      .then(async (res) => {
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          resolve({
            ok: false,
            error: `SN GET ${url} → ${res.status} ${res.statusText} ${txt.slice(0, 200)}`,
          });
          return;
        }
        if (binary) {
          const buf = await res.arrayBuffer();
          // Base64-encode here (in the page) so the result survives
          // structured-clone back to the service worker.
          const bytes = new Uint8Array(buf);
          const CHUNK = 0x8000;
          let s = "";
          for (let i = 0; i < bytes.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          resolve({
            ok: true,
            value: {
              base64: btoa(s),
              contentType: res.headers.get("content-type") || "application/octet-stream",
              size: buf.byteLength,
            },
          });
        } else {
          const j = await res.json();
          resolve({ ok: true, value: j });
        }
      })
      .catch((e) => resolve({ ok: false, error: String(e.message || e) }));
  });
}

async function snGet(ctx, instance, path, { binary = false } = {}) {
  if (!ctx || !ctx.tabId) {
    throw new Error("snGet: ctx.tabId is required (must be called from a message handler with sender.tab.id).");
  }
  const url = `https://${instance}${path}`;
  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, frameIds: ctx.frameId != null ? [ctx.frameId] : undefined },
      world: "ISOLATED",
      func: _pageFetch,
      args: [url, binary, COMMON_HEADERS],
    });
  } catch (e) {
    throw new Error(`executeScript failed for ${path}: ${e.message}`);
  }
  if (!injectionResults || !injectionResults.length) {
    throw new Error(`executeScript returned no result for ${path}`);
  }
  const r = injectionResults[0].result;
  if (!r) throw new Error(`Page fetch returned undefined for ${path}`);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// --- Record fetchers -----------------------------------------------------

export async function fetchCase(ctx, instance, sysId) {
  const path =
    `/api/now/table/sn_customerservice_case/${sysId}` +
    `?sysparm_display_value=all` +
    `&sysparm_fields=sys_id,number,short_description,priority,state,opened_at,assigned_to,account,company,contact`;
  const json = await snGet(ctx, instance, path);
  return json.result;
}

export async function fetchTask(ctx, instance, sysId) {
  const path =
    `/api/now/table/sn_customerservice_task/${sysId}` +
    `?sysparm_display_value=all` +
    `&sysparm_fields=sys_id,number,short_description,parent,assigned_to,sys_updated_on,state`;
  const json = await snGet(ctx, instance, path);
  return json.result;
}

export async function fetchUserEmail(ctx, instance, sysId) {
  const path =
    `/api/now/table/sys_user/${sysId}` +
    `?sysparm_fields=email,user_name`;
  const json = await snGet(ctx, instance, path);
  return ((json.result && json.result.email) || "").toLowerCase();
}

export async function listCaseAttachments(ctx, instance, caseSysId) {
  const q = encodeURIComponent(
    `table_name=sn_customerservice_case^table_sys_id=${caseSysId}`
  );
  const path =
    `/api/now/table/sys_attachment` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,table_name,table_sys_id,file_name,content_type,size_bytes,sys_created_on,hash` +
    `&sysparm_limit=1000`;
  const json = await snGet(ctx, instance, path);
  return json.result || [];
}

export async function listTaskAttachments(ctx, instance, taskSysId) {
  const q = encodeURIComponent(
    `table_name=sn_customerservice_task^table_sys_id=${taskSysId}`
  );
  const path =
    `/api/now/table/sys_attachment` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,table_name,table_sys_id,file_name,content_type,size_bytes,sys_created_on,hash` +
    `&sysparm_limit=1000`;
  const json = await snGet(ctx, instance, path);
  return json.result || [];
}

export async function listCaseTasks(ctx, instance, caseSysId) {
  const q = encodeURIComponent(`parent=${caseSysId}`);
  const path =
    `/api/now/table/sn_customerservice_task` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,number,short_description,parent,assigned_to,sys_updated_on,state` +
    `&sysparm_limit=500`;
  const json = await snGet(ctx, instance, path);
  return json.result || [];
}

// --- Binary fetchers (return {base64, contentType, size}) ----------------

export async function fetchAttachmentBlob(ctx, instance, sysId) {
  return snGet(ctx, instance, `/api/now/attachment/${sysId}/file`, { binary: true });
}

export async function fetchRecordPdf(ctx, instance, table, sysId) {
  const r = await snGet(ctx, instance, `/${table}.do?PDF&sys_id=${sysId}`, { binary: true });
  if (!/pdf/i.test(r.contentType || "")) {
    throw new Error(
      `Expected PDF for ${table} ${sysId} but got '${r.contentType}'. ` +
      `The PDF-export endpoint may not be enabled on this instance.`
    );
  }
  return r;
}

export async function fetchCasePdf(ctx, instance, sysId) {
  return fetchRecordPdf(ctx, instance, "sn_customerservice_case", sysId);
}

export async function fetchTaskPdf(ctx, instance, sysId) {
  return fetchRecordPdf(ctx, instance, "sn_customerservice_task", sysId);
}

export async function fetchKbPdf(ctx, instance, sysIdOrNumber) {
  const isHex = /^[0-9a-f]{32}$/i.test(sysIdOrNumber);
  const path = isHex
    ? `/kb_knowledge.do?PDF&sys_id=${sysIdOrNumber}`
    : `/kb_view.do?PDF&sysparm_article=${encodeURIComponent(sysIdOrNumber)}`;
  const r = await snGet(ctx, instance, path, { binary: true });
  if (!/pdf/i.test(r.contentType || "")) {
    throw new Error(
      `Expected PDF for KB ${sysIdOrNumber} but got '${r.contentType}'.`
    );
  }
  return r;
}

// --- Helpers for SN's display-value=all envelope -------------------------

export function rawVal(v) {
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

export function dispVal(v) {
  return v && typeof v === "object" && "display_value" in v
    ? (v.display_value || v.value || "")
    : (v || "");
}
