// background.js — Send to Claude service worker (MV3 module).
//
// Responsibilities:
//   1. Receive button-click messages from content.js with case context.
//   2. Resolve the case record via SN REST (read-only, GET only). All
//      SN fetches are routed through chrome.scripting.executeScript
//      against the same frame content.js injected into, so they inherit
//      the user's HI session cookies.
//   3. Decide primary vs reference based on partner_tse_email + case state.
//   4. PRIMARY: fetch case PDF + all attachments + all tasks (with their
//      PDFs and attachments). Bundle, call host ingest_case.
//   5. REFERENCE: ask content.js for primary case number, fetch single
//      record PDF, call host ingest_reference.
//   6. KB: fetch KB PDF, call host ingest_kb.

import {
  fetchCase, fetchTask, fetchUserEmail,
  listCaseAttachments, listTaskAttachments, listCaseTasks,
  fetchCasePdf, fetchTaskPdf, fetchAttachmentBlob, fetchKbPdf,
  rawVal, dispVal,
} from "./lib/sn-api.js";
import { callHost, ping, readConfig } from "./lib/messaging.js";
import { detectContext } from "./lib/url-detect.js";

// --- Message handler -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.kind === "ingest") {
        const result = await handleIngestClick(msg, sender);
        sendResponse(result);
        return;
      }
      if (msg.kind === "ingest_reference_confirmed") {
        const result = await handleIngestReference(msg, sender);
        sendResponse(result);
        return;
      }
      if (msg.kind === "ping_host") {
        const r = await ping();
        sendResponse({ ok: true, result: r });
        return;
      }
      if (msg.kind === "read_config") {
        const r = await readConfig();
        sendResponse({ ok: true, result: r });
        return;
      }
      sendResponse({ ok: false, error: `unknown kind: ${msg.kind}` });
    } catch (e) {
      console.error("[send-to-claude] background error:", e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// --- Top-level click handler ---------------------------------------------

function _ctxFromSender(sender, msg) {
  return {
    tabId: sender?.tab?.id,
    frameId: sender?.frameId,
    url: msg.url || sender?.tab?.url,
  };
}

async function handleIngestClick(msg, sender) {
  const ctx = _ctxFromSender(sender, msg);
  const recordCtx = detectContext({ url: ctx.url, dom: msg.dom || {} });

  if (recordCtx.kind === "kb") {
    const result = await ingestKb(ctx, recordCtx);
    return { ok: true, mode: "kb", result };
  }

  if (recordCtx.kind !== "case" && recordCtx.kind !== "task") {
    return {
      ok: false,
      error: `Send to Claude — not on a recognized case, task, or KB page (${recordCtx.kind}).`,
    };
  }

  const { caseSysId, caseRecord, instance } = await resolveCase(ctx, recordCtx);
  const decision = await decidePrimaryOrReference(ctx, caseRecord, instance);

  if (decision.mode === "primary") {
    const result = await ingestPrimary(ctx, instance, caseSysId, caseRecord);
    return { ok: true, mode: "primary", result };
  }

  return {
    ok: true,
    mode: "reference_prompt",
    suggested_primary: decision.suggested_primary,
    case_number: dispVal(caseRecord.number),
    reason: decision.reason,
  };
}

async function handleIngestReference(msg, sender) {
  const ctx = _ctxFromSender(sender, msg);
  const recordCtx = detectContext({ url: ctx.url, dom: msg.dom || {} });
  const primaryCase = (msg.primaryCase || "").trim().toUpperCase();
  if (!/^CS\d+$/.test(primaryCase)) {
    return { ok: false, error: `Invalid primary case number: ${msg.primaryCase}` };
  }
  const result = await ingestReference(ctx, recordCtx, primaryCase);
  return { ok: true, mode: "reference", result };
}

// --- Resolve case context ------------------------------------------------

async function resolveCase(ctx, recordCtx) {
  const instance = recordCtx.instance;
  if (recordCtx.kind === "case") {
    const caseRecord = await fetchCase(ctx, instance, recordCtx.sysId);
    return { caseSysId: recordCtx.sysId, caseRecord, instance };
  }
  if (recordCtx.kind === "task") {
    const t = await fetchTask(ctx, instance, recordCtx.sysId);
    const parentSysId = rawVal(t.parent);
    if (!parentSysId) throw new Error("Task has no parent case.");
    const caseRecord = await fetchCase(ctx, instance, parentSysId);
    return { caseSysId: parentSysId, caseRecord, instance };
  }
  throw new Error(`resolveCase: unsupported kind '${recordCtx.kind}'`);
}

// --- Decide primary vs reference -----------------------------------------

const CLOSED_STATES = new Set([
  "solution proposed", "closed", "closed complete", "resolved", "cancelled",
]);

async function decidePrimaryOrReference(ctx, caseRecord, instance) {
  let cfg;
  try {
    cfg = await readConfig();
  } catch (e) {
    return { mode: "reference", reason: `host_unavailable: ${e.message}` };
  }

  const ownerEmail = String(cfg.partner_tse_email || "").toLowerCase();
  const assigned = caseRecord.assigned_to;
  let assignedEmail = "";
  if (assigned && typeof assigned === "object") {
    if (typeof assigned.email === "string") {
      assignedEmail = assigned.email.toLowerCase();
    } else if (assigned.value) {
      try {
        assignedEmail = await fetchUserEmail(ctx, instance, assigned.value);
      } catch (_) { /* leave blank */ }
    }
  }

  const stateDisp = String(dispVal(caseRecord.state) || "").toLowerCase();
  const isOwner = !!ownerEmail && !!assignedEmail && ownerEmail === assignedEmail;
  const isClosed = CLOSED_STATES.has(stateDisp);

  if (isOwner && !isClosed) {
    return { mode: "primary", isOwner, isClosed };
  }

  return {
    mode: "reference",
    isOwner,
    isClosed,
    reason: isClosed ? "case_closed" : (isOwner ? "unknown" : "not_assigned_to_owner"),
    suggested_primary: dispVal(caseRecord.number) || "",
  };
}

// --- PRIMARY ingest pipeline ---------------------------------------------

async function ingestPrimary(ctx, instance, caseSysId, caseRecord) {
  const caseNumber = dispVal(caseRecord.number);
  if (!caseNumber) throw new Error("Could not resolve case number from record.");

  const casePdf = await fetchCasePdf(ctx, instance, caseSysId);
  const casePackage = {
    filename: `${caseNumber}.pdf`,
    content_type: casePdf.contentType,
    base64: casePdf.base64,
    size: casePdf.size,
  };

  const caseAttachMeta = await listCaseAttachments(ctx, instance, caseSysId);
  const caseAttachPackages = [];
  for (const a of caseAttachMeta) {
    const blob = await fetchAttachmentBlob(ctx, instance, a.sys_id);
    caseAttachPackages.push({
      sys_id: a.sys_id,
      file_name: a.file_name,
      content_type: blob.contentType,
      size_bytes: a.size_bytes || blob.size,
      base64: blob.base64,
    });
  }

  const taskList = await listCaseTasks(ctx, instance, caseSysId);
  const taskPackages = [];
  for (const t of taskList) {
    let pdfPkg = null;
    try {
      const tp = await fetchTaskPdf(ctx, instance, t.sys_id);
      pdfPkg = {
        filename: `${t.number}.pdf`,
        content_type: tp.contentType,
        base64: tp.base64,
        size: tp.size,
      };
    } catch (e) {
      console.warn("[send-to-claude] task PDF fetch failed", t.number, e.message);
    }
    const tAttachMeta = await listTaskAttachments(ctx, instance, t.sys_id);
    const tAttachPackages = [];
    for (const a of tAttachMeta) {
      const blob = await fetchAttachmentBlob(ctx, instance, a.sys_id);
      tAttachPackages.push({
        sys_id: a.sys_id,
        file_name: a.file_name,
        content_type: blob.contentType,
        size_bytes: a.size_bytes || blob.size,
        base64: blob.base64,
      });
    }
    taskPackages.push({
      sys_id: t.sys_id,
      number: t.number,
      sys_updated_on: t.sys_updated_on || null,
      pdf: pdfPkg,
      attachments: tAttachPackages,
    });
  }

  return await callHost("ingest_case", {
    instance,
    case: { sys_id: caseSysId, number: caseNumber, record: caseRecord },
    case_pdf: casePackage,
    attachments: caseAttachPackages,
    tasks: taskPackages,
    fetched_at: new Date().toISOString(),
  }, { timeoutMs: 600000 });
}

// --- REFERENCE ingest pipeline -------------------------------------------

async function ingestReference(ctx, recordCtx, primaryCaseNumber) {
  const instance = recordCtx.instance;

  if (recordCtx.kind === "case") {
    const c = await fetchCase(ctx, instance, recordCtx.sysId);
    const number = dispVal(c.number);
    const r = await fetchCasePdf(ctx, instance, recordCtx.sysId);
    return await callHost("ingest_reference", {
      instance,
      primary_case: primaryCaseNumber,
      reference: {
        kind: "case_pdf",
        reference_case_number: number,
        file: { filename: `${number}.pdf`, content_type: r.contentType, base64: r.base64, size: r.size },
      },
      fetched_at: new Date().toISOString(),
    }, { timeoutMs: 300000 });
  }

  if (recordCtx.kind === "task") {
    const t = await fetchTask(ctx, instance, recordCtx.sysId);
    const number = t.number;
    const r = await fetchTaskPdf(ctx, instance, recordCtx.sysId);
    return await callHost("ingest_reference", {
      instance,
      primary_case: primaryCaseNumber,
      reference: {
        kind: "task_pdf",
        reference_case_number: number,
        file: { filename: `${number}.pdf`, content_type: r.contentType, base64: r.base64, size: r.size },
      },
      fetched_at: new Date().toISOString(),
    }, { timeoutMs: 300000 });
  }

  throw new Error(`ingestReference: unsupported kind '${recordCtx.kind}'`);
}

// --- KB ingest -----------------------------------------------------------

async function ingestKb(ctx, recordCtx) {
  const r = await fetchKbPdf(ctx, recordCtx.instance, recordCtx.sysId || recordCtx.number);
  return await callHost("ingest_kb", {
    instance: recordCtx.instance,
    number: recordCtx.number,
    file: { filename: `${recordCtx.number}.pdf`, content_type: r.contentType, base64: r.base64, size: r.size },
    fetched_at: new Date().toISOString(),
  }, { timeoutMs: 120000 });
}
