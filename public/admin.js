'use strict';
const app = document.getElementById('app');
const S = { requests: [], areas: [], settings: {}, drawLog: [], username: 'admin', tab: 'requests', status: 'all', date: '', flash: null };

const flash = (text, kind = 'ok') => { S.flash = { text, kind }; };

async function load() {
  const d = await api('GET', '/api/admin/state');
  Object.assign(S, { requests: d.requests, areas: d.areas, settings: d.settings, drawLog: d.drawLog, username: d.username });
}

async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) flash(typeof okText === 'function' ? okText(r) : okText);
    await load();
  } catch (e) {
    if (e.status === 401) return renderLogin();
    flash(e.message, 'error');
  }
  render();
}

/* ---------------- login ---------------- */
function renderLogin(error) {
  const user = h('input', { id: 'u', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('div', {}, error ? h('div', { class: 'msg error' }, error) : null);
  const form = h('form', { class: 'card login', onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/admin/login', { username: user.value, password: pass.value });
      await load();
      render();
    } catch (e) { renderLogin(e.message); }
  } },
    h('h2', {}, 'Admin sign in'),
    h('label', { for: 'u' }, 'Username'), user,
    h('label', { for: 'p' }, 'Password'), pass,
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Sign in')),
    msg,
  );
  app.replaceChildren(form);
  user.focus();
}

/* ---------------- shell ---------------- */
function render() {
  const tabs = [['requests', 'Requests'], ['areas', 'Areas'], ['settings', 'Settings'], ['log', 'Draw log'], ['account', 'Account']];
  const body = { requests: tabRequests, areas: tabAreas, settings: tabSettings, log: tabLog, account: tabAccount }[S.tab]();
  const f = S.flash; S.flash = null;
  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('h1', {}, S.settings.propertyName + ' · Admin'),
      h('div', {},
        h('a', { class: 'btn secondary', href: '/' }, 'View public page'), ' ',
        h('button', { class: 'secondary', type: 'button', onclick: async () => { await api('POST', '/api/admin/logout', {}); renderLogin(); } }, 'Sign out'),
      ),
    ),
    h('div', { class: 'tabs' }, tabs.map(([k, label]) =>
      h('button', { type: 'button', class: S.tab === k ? 'active' : '', onclick: () => { S.tab = k; render(); } }, label))),
    f ? h('div', { class: `msg ${f.kind}` }, f.text) : null,
    body,
  );
}

/* ---------------- requests ---------------- */
function tabRequests() {
  const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  S.requests.forEach((r) => counts[r.status]++);
  const rows = S.requests.filter((r) => (S.status === 'all' || r.status === S.status) && (!S.date || r.date === S.date));
  const pendingDates = [...new Set(S.requests.filter((r) => r.status === 'pending').map((r) => r.date))];

  const statusSel = h('select', { id: 'fs', onchange: (e) => { S.status = e.target.value; render(); } },
    [['all', 'All'], ['pending', 'Pending'], ['approved', 'Confirmed'], ['rejected', 'Not selected'], ['cancelled', 'Cancelled']]
      .map(([v, l]) => h('option', { value: v, selected: S.status === v }, l)));
  const dateIn = h('input', { id: 'fd', type: 'date', value: S.date, onchange: (e) => { S.date = e.target.value; render(); } });

  return h('div', {},
    h('div', { class: 'card' },
      h('p', {}, h('strong', {}, `${counts.pending} pending`), ` · ${counts.approved} confirmed · ${counts.rejected} not selected · ${counts.cancelled} cancelled`),
      h('div', { class: 'toolbar' },
        h('div', {}, h('label', { for: 'fs' }, 'Status'), statusSel),
        h('div', {}, h('label', { for: 'fd' }, 'Date'), dateIn),
        h('button', { class: 'secondary', type: 'button', onclick: () => { S.status = 'all'; S.date = ''; render(); } }, 'Clear filters'),
      ),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', disabled: !S.date || !S.requests.some((r) => r.date === S.date && r.status === 'pending'),
          onclick: () => act(() => api('POST', '/api/admin/draw', { date: S.date }), drawMsg),
        }, S.date ? `Run draw for ${fmtDate(S.date)}` : 'Pick a date to run its draw'),
        h('button', {
          type: 'button', class: 'secondary', disabled: !pendingDates.length,
          onclick: () => { if (confirm(`Run the draw for all ${pendingDates.length} date(s) with pending requests?`)) act(() => api('POST', '/api/admin/draw', {}), drawMsg); },
        }, 'Run all pending draws'),
      ),
      h('p', { class: 'hint' }, 'A draw confirms any request with no overlap, and picks one winner at random whenever requests overlap in the same area.'),
    ),
    h('div', { class: 'card table-wrap' },
      rows.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, ['When', 'Area', 'Hunter', 'Contact', 'Status', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, rows.map(reqRow)))
        : h('p', { class: 'hint' }, 'No requests match.'),
    ),
  );
}

function drawMsg(r) {
  const t = r.results.reduce((a, x) => ({ c: a.c + x.confirmed, d: a.d + x.declined, w: a.w + x.draws }), { c: 0, d: 0, w: 0 });
  return `Draw complete: ${t.c} confirmed, ${t.d} not selected, ${t.w} random draw${t.w === 1 ? '' : 's'} held.`;
}

function reqRow(r) {
  const contested = r.status === 'pending' && r.conflicts > 0;
  return h('tr', {},
    h('td', {}, h('div', {}, fmtDate(r.date)), h('div', { class: 'hint' }, `${fmtTime(r.start)} – ${fmtTime(r.end)}`)),
    h('td', {}, r.areaName || '—'),
    h('td', {}, h('div', {}, r.name), h('div', { class: 'hint' }, `Party of ${r.party} · ${r.code}`), r.notes ? h('div', { class: 'hint' }, r.notes) : null),
    h('td', {}, r.phone ? h('div', {}, r.phone) : null, r.email ? h('div', {}, r.email) : null),
    h('td', {},
      h('span', { class: `badge ${r.status}` }, STATUS_LABEL[r.status]),
      contested ? h('div', {}, h('span', { class: 'badge contested' }, `Conflicts with ${r.conflicts}`)) : null,
      r.note ? h('div', { class: 'hint' }, r.note) : null),
    h('td', {}, h('div', { class: 'btns' },
      r.status !== 'approved' ? h('button', { class: 'small', type: 'button', onclick: () => act(() => api('PATCH', `/api/admin/requests/${r.id}`, { status: 'approved' }), 'Approved.') }, 'Approve') : null,
      r.status !== 'rejected' ? h('button', { class: 'small secondary', type: 'button', onclick: () => act(() => api('PATCH', `/api/admin/requests/${r.id}`, { status: 'rejected' }), 'Declined.') }, 'Decline') : null,
      r.status !== 'pending' ? h('button', { class: 'small secondary', type: 'button', onclick: () => act(() => api('PATCH', `/api/admin/requests/${r.id}`, { status: 'pending' }), 'Moved back to pending.') }, 'Re-queue') : null,
      h('button', { class: 'small danger', type: 'button', onclick: () => { if (confirm(`Delete the request from ${r.name}?`)) act(() => api('DELETE', `/api/admin/requests/${r.id}`), 'Deleted.'); } }, 'Delete'),
    )),
  );
}

/* ---------------- areas ---------------- */
function tabAreas() {
  const input = h('input', { id: 'an', maxlength: 60, placeholder: 'e.g. North Woods, Back 40, Creek Bottom' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Hunting areas'),
    h('p', { class: 'hint' }, 'Optional. With areas set up, hunters pick one and only overlapping times in the same area conflict. With none, the whole property is one slot.'),
    S.areas.length
      ? S.areas.map((a) => h('div', { class: 'list-item' }, h('span', {}, a.name),
          h('button', { class: 'small danger', type: 'button', onclick: () => { if (confirm(`Remove "${a.name}"? Existing requests keep their time.`)) act(() => api('DELETE', `/api/admin/areas/${a.id}`), 'Area removed.'); } }, 'Remove')))
      : h('p', {}, 'No areas yet.'),
    h('form', { onsubmit: (ev) => { ev.preventDefault(); act(() => api('POST', '/api/admin/areas', { name: input.value }), 'Area added.'); } },
      h('label', { for: 'an' }, 'Add an area'), input,
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Add area'))),
  );
}

/* ---------------- settings ---------------- */
function tabSettings() {
  const s = S.settings;
  const name = h('input', { id: 'sn', value: s.propertyName, maxlength: 80 });
  const rules = h('textarea', { id: 'sr', maxlength: 2000 }); rules.value = s.rules || '';
  const maxH = h('input', { id: 'sm', type: 'number', min: 1, max: 24, value: s.maxHours });
  const auto = h('input', { id: 'sa', type: 'checkbox', checked: !!s.autoDrawEnabled });
  const hrs = h('input', { id: 'sh', type: 'number', min: 0, max: 720, value: s.autoDrawHours });
  return h('form', { class: 'card', onsubmit: (ev) => {
    ev.preventDefault();
    act(() => api('PUT', '/api/admin/settings', { propertyName: name.value, rules: rules.value, maxHours: maxH.value, autoDrawEnabled: auto.checked, autoDrawHours: hrs.value }), 'Settings saved.');
  } },
    h('h2', {}, 'Settings'),
    h('label', { for: 'sn' }, 'Property name'), name,
    h('label', { for: 'sr' }, 'Rules shown to hunters'), rules,
    h('label', { for: 'sm' }, 'Longest hunt allowed (hours)'), maxH,
    h('div', { class: 'inline-check' }, auto, h('label', { for: 'sa' }, 'Run draws automatically')),
    h('label', { for: 'sh' }, 'Hours before the start of the hunt date to draw'), hrs,
    h('p', { class: 'hint' }, 'Example: 24 means a draw for Saturday runs at 12:00 AM Friday (server time). Requests submitted after that are settled within a minute: confirmed if free, declined if the time is taken.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Save settings')),
  );
}

/* ---------------- draw log ---------------- */
function tabLog() {
  const areaName = (id) => (S.areas.find((a) => a.id === id) || {}).name || '';
  return h('div', { class: 'card table-wrap' },
    h('h2', {}, 'Draw log'),
    S.drawLog.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, ['Drawn', 'Hunt date', 'Area', 'Entrants', 'Winner', 'Type'].map((t) => h('th', {}, t)))),
          h('tbody', {}, S.drawLog.map((l) => h('tr', {},
            h('td', {}, new Date(l.at).toLocaleString()),
            h('td', {}, fmtDate(l.date)),
            h('td', {}, areaName(l.areaId) || '—'),
            h('td', {}, l.entrants.map((e) => h('div', {}, `${e.name} (${fmtTime(e.start)}–${fmtTime(e.end)})`))),
            h('td', {}, h('strong', {}, l.winnerName)),
            h('td', {}, l.auto ? 'Automatic' : 'Manual'),
          ))))
      : h('p', { class: 'hint' }, 'No random draws have been held yet.'),
  );
}

/* ---------------- account ---------------- */
function tabAccount() {
  const user = h('input', { id: 'au', value: S.username, autocomplete: 'username' });
  const cur = h('input', { id: 'ac', type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { id: 'an2', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  return h('form', { class: 'card', onsubmit: async (ev) => {
    ev.preventDefault();
    await act(() => api('POST', '/api/admin/password', { username: user.value, current: cur.value, next: nw.value }), 'Account updated.');
  } },
    h('h2', {}, 'Admin account'),
    h('p', { class: 'hint' }, 'Change the default password before putting this on the internet.'),
    h('label', { for: 'au' }, 'Username'), user,
    h('label', { for: 'ac' }, 'Current password'), cur,
    h('label', { for: 'an2' }, 'New password (8+ characters)'), nw,
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Update account')),
  );
}

/* ---------------- boot ---------------- */
(async () => {
  try { await load(); render(); } catch { renderLogin(); }
})();
