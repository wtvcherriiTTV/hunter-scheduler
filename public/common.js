'use strict';
// Tiny DOM helper. Text is always inserted as text nodes, never as HTML.
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtTime(t) {
  const [H, M] = t.split(':').map(Number);
  return `${((H + 11) % 12) + 1}:${String(M).padStart(2, '0')} ${H >= 12 ? 'PM' : 'AM'}`;
}
function fmtDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const STATUS_LABEL = { pending: 'Pending draw', approved: 'Confirmed', rejected: 'Not selected', cancelled: 'Cancelled' };
