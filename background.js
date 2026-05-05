// background.js — Send to Claude service worker (MV3 module).
//
// Responsibilities:
//   1. Receive button-click messages from content.js with case context.
//   2. Resolve the case record via SN REST (read-only, GET only).
//   3. Decide primary vs reference based on partner_tse_email + case state.
//   4. For PRIMARY: fetch case PDF + all attachments + all tasks (with their
//      PDFs and attachments), bundle, call host ingest_case.
//   5. For REFERENCE: ask content.js to prompt for primary case number,
//      fetch the single record's PDF, call host ingest_reference.
//   6. For KB: fetch KB PDF, call host ingest_kb.
//
// G1 invariant: only GET requests to ServiceNow. Enforced in lib/sn-api.js.

import {
  fetchCase, fetchTask, fetchUserEmail,
  listCaseAttachments, listTaskAttachments, listCaseTasks,
  fetchCasePdf, fetchTaskPdf, fetchAttachmentBlob, fetchKbPdf,
  arrayBufferToBase64, rawVal, dispVal,
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

async function handleIngestClick(msg, sender) {
  const tabUrl = sender?.tab?.url || msg.url;
  const ctx = detectContext({ url: tabUrl, dom: msg.dom || {} });

  if (ctx.kind === "kb") {
    const result = await ingestKb(ctx);
    return { ok: true, mode: "kb", result };
  }

  if (ctx.kind !== "case" && ctx.kind !== "task") {
    return {
      ok: false,
      error: `Send to Claude — not on a recognized case, task, or KB page (${ctx.kind}).`,
    };
  }

  // Case / task → resolve to parent case + decide primary vs reference.
  const { caseSysId, caseRecord, instance } = await resolveCase(ctx);

  const decision = await decidePrimaryOrReference(caseRecord, instance);

  if (decision.mode === "primary") {
    const result = await ingestPrimary(instance, caseSysId, caseRecord);
    return { ok: true, mode: "primary", result };
  }

  // Reference mode → tell content.js to prompt for primary case.
  return {
    ok: true,
    mode: "reference_prompt",
    suggested_primary: decision.suggested_primary,
    case_number: dispVal(caseRecord.number),
    reason: decision.reason,
  };
}

async function handleIngestReference(msg, sender) {
  const tabUrl = sender?.tab?.url || msg.url;
  const ctx = detectContext({ url: tabUrl, dom: msg.dom || {} });
  const primaryCase = (msg.primaryCase || "").trim().toUpperCase();
  if (!/^CS\d+$/.test(primaryCase)) {
    return { ok: false, error: `Invalid primary case number: ${msg.primaryCase}` };
  }
  const result = await ingestReference(ctx, primaryCase);
  return { ok: true, mode: "reference", result };
}

// --- Resolve case context ------------------------------------------------

async function resolveCase(ctx) {
  const instance = ctx.instance;
  if (ctx.kind === "case") {
    const caseRecord = await fetchCase(instance, ctx.sysId);
    return { caseSysId: ctx.sysId, caseRecord, instance };
  }
  if (ctx.kind === "task") {
    const t = await fetchTask(instance, ctx.sysId);
    const parentSysId = rawVal(t.parent);
    if (!parentSysId) throw new Error("Task has no parent case.");
    const caseRecord = await fetchCase(instance, parentSysId);
    return { caseSysId: parentSysId, caseRecord, instance };
  }
  throw new Error(`resolveCase: unsupported kind '${ctx.kind}'`);
}

// --- Decide primary vs reference -----------------------------------------

const CLOSED_STATES = new Set([
  "solution proposed", "closed", "closed complete", "resolved", "cancelled",
]);

async function decidePrimaryOrReference(caseRecord, instance) {
  let cfg;
  try {
    cfg = await readConfig();
  } catch (e) {
    return { mode: "reference", reason: `host_unavailable: ${e.message}` };
  }

  const ownerEmail = String(cfg.partner_tse_email || "").toLowerCase();

  // assigned_to.email may not be returned by sysparm_display_value=all.
  // First try the display-value envelope; fall back to sys_user lookup.
  const assigned = caseRecord.assigned_to;
  let assignedEmail = "";
  if (assigned && typeof assigned === "object") {
    if (typeof assigned.email === "string") {
      assignedEmail = assigned.email.toLowerCase();
    } else if (assigned.value) {
      try {
        assignedEmail = await fetchUserEmail(instance, assigned.value);
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

async function ingestPrimary(instance, caseSysId, caseRecord) {
  const caseNumber = dispVal(caseRecord.number);
  if (!caseNumber) throw new Error("Could not resolve case number from record.");

  const casePdfBuf = await fetchCasePdf(instance, caseSysId);
  const casePackage = {
    filename: `${caseNumber}.pdf`,
    content_type: "application/pdf",
    base64: arrayBufferToBase64(casePdfBuf),
    size: casePdfBuf.byteLength,
  };

  const caseAttachMeta = await listCaseAttachments(instance, caseSysId);
  const caseAttachPackages = [];
  for (const a of caseAttachMeta) {
    const { buffer, contentType } = await fetchAttachmentBlob(instance, a.sys_id);
    caseAttachPackages.push({
      sys_id: a.sys_id,
      file_name: a.file_name,
      content_type: contentType,
      size_bytes: a.size_bytes || buffer.byteLength,
      base64: arrayBufferToBase64(buffer),
    });
  }

  const taskList = await listCaseTasks(instance, caseSysId);
  const taskPackages = [];
  for (const t of taskList) {
    let pdfPkg = null;
    try {
      const buf = await fetchTaskPdf(instance, t.sys_id);
      pdfPkg = {
        filename: `${t.number}.pdf`,
        content_type: "application/pdf",
        base64: arrayBufferToBase64(buf),
        size: buf.byteLength,
      };
    } catch (e) {
      console.warn("[send-to-claude] task PDF fetch failed", t.number, e.message);
    }
    const tAttachMeta = await listTaskAttachments(instance, t.sys_id);
    const tAttachPackages = [];
    for (const a of tAttachMeta) {
      const { buffer, contentType } = await fetchAttachmentBlob(instance, a.sys_id);
      tAttachPackages.push({
        sys_id: a.sys_id,
        file_name: a.file_name,
        content_type: contentType,
        size_bytes: a.size_bytes || buffer.byteLength,
        base64: arrayBufferToBase64(buffer),
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

async function ingestReference(ctx, primaryCaseNumber) {
  const instance = ctx.instance;

  if (ctx.kind === "case") {
    const c = await fetchCase(instance, ctx.sysId);
    const number = dispVal(c.number);
    const buf = await fetchCasePdf(instance, ctx.sysId);
    return await callHost("ingest_reference", {
      instance,
      primary_case: primaryCaseNumber,
      reference: {
        kind: "case_pdf",
        reference_case_number: number,
        file: {
          filename: `${number}.pdf`,
          content_type: "application/pdf",
          base64: arrayBufferToBase64(buf),
          size: buf.byteLength,
        },
      },
      fetched_at: new Date().toISOString(),
    }, { timeoutMs: 300000 });
  }

  if (ctx.kind === "task") {
    const t = await fetchTask(instance, ctx.sysId);
    const number = t.number;
    const buf = await fetchTaskPdf(instance, ctx.sysId);
    return await callHost("ingest_reference", {
      instance,
      primary_case: primaryCaseNumber,
      reference: {
        kind: "task_pdf",
        reference_case_number: number,
        file: {
          filename: `${number}.pdf`,
          content_type: "application/pdf",
          base64: arrayBufferToBase64(buf),
          size: buf.byteLength,
        },
      },
      fetched_at: new Date().toISOString(),
    }, { timeoutMs: 300000 });
  }

  throw new Error(`ingestReference: unsupported kind '${ctx.kind}'`);
}

// --- KB ingest -----------------------------------------------------------

async function ingestKb(ctx) {
  const buf = await fetchKbPdf(ctx.instance, ctx.sysId || ctx.number);
  return await callHost("ingest_kb", {
    instance: ctx.instance,
    number: ctx.number,
    file: {
      filename: `${ctx.number}.pdf`,
      content_type: "application/pdf",
      base64: arrayBufferToBase64(buf),
      size: buf.byteLength,
    },
    fetched_at: new Date().toISOString(),
  }, { timeoutMs: 120000 });
}
