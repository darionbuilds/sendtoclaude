// url-detect.js — parse a ServiceNow URL into a record context.
//
// Recognized contexts:
//   { kind: "case",       sysId, instance }
//   { kind: "task",       sysId, instance }
//   { kind: "kb",         number, sysId?, instance }
//   { kind: "unknown",    instance }

export function detectContext({ url, dom }) {
  const u = new URL(url);
  const instance = u.hostname;
  const params = parseAllParams(u);

  // KB article
  if (
    /\/kb_view\.do$/.test(u.pathname) ||
    /\/kb_knowledge\.do$/.test(u.pathname)
  ) {
    const number = extractKbNumber(u, dom);
    const sysId = params.sys_id || params.sys_kb_id || null;
    if (number) return { kind: "kb", number, sysId, instance };
  }

  // CSTASK
  if (/sn_customerservice_task\.do$/.test(u.pathname)) {
    const sysId = params.sys_id;
    if (sysId) return { kind: "task", sysId, instance };
  }

  // Case
  if (/sn_customerservice_case\.do$/.test(u.pathname)) {
    const sysId = params.sys_id;
    if (sysId) return { kind: "case", sysId, instance };
  }

  // nav_to.do?uri=...&sys_id=... — uri may have its own query string
  if (/\/nav_to\.do$/.test(u.pathname) && params.uri) {
    try {
      const inner = new URL(`https://${instance}/${params.uri.replace(/^\//, "")}`);
      const innerParams = Object.fromEntries(inner.searchParams.entries());
      const sysId = innerParams.sys_id || params.sys_id;
      if (/sn_customerservice_case\.do/.test(inner.pathname) && sysId) {
        return { kind: "case", sysId, instance };
      }
      if (/sn_customerservice_task\.do/.test(inner.pathname) && sysId) {
        return { kind: "task", sysId, instance };
      }
      if (/kb_(view|knowledge)\.do/.test(inner.pathname)) {
        const number = innerParams.sysparm_article ||
                       extractKbNumberFromText(innerParams);
        if (number) return { kind: "kb", number, sysId: sysId || null, instance };
      }
    } catch (_) { /* ignore */ }
  }

  return { kind: "unknown", instance };
}

function parseAllParams(u) {
  const out = {};
  for (const [k, v] of u.searchParams.entries()) out[k] = v;
  return out;
}

function extractKbNumber(u, dom) {
  const params = parseAllParams(u);
  if (params.sysparm_article && /^KB\d+$/i.test(params.sysparm_article)) {
    return params.sysparm_article.toUpperCase();
  }
  if (dom && typeof dom.kbNumber === "string" && /^KB\d+$/i.test(dom.kbNumber)) {
    return dom.kbNumber.toUpperCase();
  }
  return null;
}

function extractKbNumberFromText(params) {
  for (const v of Object.values(params)) {
    if (typeof v === "string") {
      const m = v.match(/\bKB\d+\b/i);
      if (m) return m[0].toUpperCase();
    }
  }
  return null;
}
