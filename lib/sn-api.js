// sn-api.js — Read-only ServiceNow REST helpers.
//
// G1 (Permanent Guardrail per docs/case-ingestion-architecture.md §2):
// READ-ONLY against ServiceNow. Every helper here uses fetch with method GET
// only. There are zero POST/PUT/PATCH/DELETE calls — the extension never
// writes upstream.
//
// All requests rely on the user's existing browser session cookies
// (credentials: "include"). No credentials are stored or transmitted.

const COMMON_OPTS = {
  method: "GET",
  credentials: "include",
  headers: {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  },
};

async function snGet(instance, path, { binary = false, signal } = {}) {
  const url = `https://${instance}${path}`;
  const res = await fetch(url, { ...COMMON_OPTS, signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SN GET ${path} → ${res.status} ${res.statusText} ${txt.slice(0, 200)}`);
  }
  if (binary) {
    const buf = await res.arrayBuffer();
    return {
      buffer: buf,
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  }
  return res.json();
}

// --- Record fetchers -----------------------------------------------------

export async function fetchCase(instance, sysId) {
  const path =
    `/api/now/table/sn_customerservice_case/${sysId}` +
    `?sysparm_display_value=all` +
    `&sysparm_fields=sys_id,number,short_description,priority,state,opened_at,assigned_to,account,company,contact`;
  const json = await snGet(instance, path);
  return json.result;
}

export async function fetchTask(instance, sysId) {
  const path =
    `/api/now/table/sn_customerservice_task/${sysId}` +
    `?sysparm_display_value=all` +
    `&sysparm_fields=sys_id,number,short_description,parent,assigned_to,sys_updated_on,state`;
  const json = await snGet(instance, path);
  return json.result;
}

export async function fetchUserEmail(instance, sysId) {
  const path =
    `/api/now/table/sys_user/${sysId}` +
    `?sysparm_fields=email,user_name`;
  const json = await snGet(instance, path);
  return ((json.result && json.result.email) || "").toLowerCase();
}

export async function listCaseAttachments(instance, caseSysId) {
  const q = encodeURIComponent(
    `table_name=sn_customerservice_case^table_sys_id=${caseSysId}`
  );
  const path =
    `/api/now/table/sys_attachment` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,table_name,table_sys_id,file_name,content_type,size_bytes,sys_created_on,hash` +
    `&sysparm_limit=1000`;
  const json = await snGet(instance, path);
  return json.result || [];
}

export async function listTaskAttachments(instance, taskSysId) {
  const q = encodeURIComponent(
    `table_name=sn_customerservice_task^table_sys_id=${taskSysId}`
  );
  const path =
    `/api/now/table/sys_attachment` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,table_name,table_sys_id,file_name,content_type,size_bytes,sys_created_on,hash` +
    `&sysparm_limit=1000`;
  const json = await snGet(instance, path);
  return json.result || [];
}

export async function listCaseTasks(instance, caseSysId) {
  const q = encodeURIComponent(`parent=${caseSysId}`);
  const path =
    `/api/now/table/sn_customerservice_task` +
    `?sysparm_query=${q}` +
    `&sysparm_fields=sys_id,number,short_description,parent,assigned_to,sys_updated_on,state` +
    `&sysparm_limit=500`;
  const json = await snGet(instance, path);
  return json.result || [];
}

// --- Binary fetchers -----------------------------------------------------

export async function fetchAttachmentBlob(instance, sysId) {
  return snGet(instance, `/api/now/attachment/${sysId}/file`, { binary: true });
}

// PDF export — proven URL pattern from the predecessor flat-layout extension:
//   /<table>.do?PDF&sys_id=<id>
// `&PDF` is a bare flag (no `=value`) and appears immediately after `?` —
// order preserved from the proven form.
export async function fetchRecordPdf(instance, table, sysId) {
  const path = `/${table}.do?PDF&sys_id=${sysId}`;
  const { buffer, contentType } = await snGet(instance, path, { binary: true });
  if (!/pdf/i.test(contentType)) {
    throw new Error(
      `Expected PDF for ${table} ${sysId} but got '${contentType}'. ` +
      `The PDF-export endpoint may not be enabled on this instance.`
    );
  }
  return buffer;
}

export async function fetchCasePdf(instance, sysId) {
  return fetchRecordPdf(instance, "sn_customerservice_case", sysId);
}

export async function fetchTaskPdf(instance, sysId) {
  return fetchRecordPdf(instance, "sn_customerservice_task", sysId);
}

export async function fetchKbPdf(instance, sysIdOrNumber) {
  const isHex = /^[0-9a-f]{32}$/i.test(sysIdOrNumber);
  const path = isHex
    ? `/kb_knowledge.do?PDF&sys_id=${sysIdOrNumber}`
    : `/kb_view.do?PDF&sysparm_article=${encodeURIComponent(sysIdOrNumber)}`;
  const { buffer, contentType } = await snGet(instance, path, { binary: true });
  if (!/pdf/i.test(contentType)) {
    throw new Error(
      `Expected PDF for KB ${sysIdOrNumber} but got '${contentType}'.`
    );
  }
  return buffer;
}

// --- ArrayBuffer → base64 (native messaging is JSON-only) ----------------

export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
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
