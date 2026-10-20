'use strict';
let config = { areas: [] };

const $ = (id) => document.getElementById(id);
const myCodes = () => { try { return JSON.parse(localStorage.getItem('huntCodes') || '[]'); } catch { return []; } };
const saveCode = (c) => { try { const a = myCodes().filter((x) => x !== c); a.unshift(c); localStorage.setItem('huntCodes', JSON.stringify(a.slice(0, 20))); } catch { /* storage blocked */ } };

function requestCard(r, { onChange } = {}) {
  const statusBadge = h('span', { class: `badge ${r.status}` }, STATUS_LABEL[r.status] || r.status);
  const canCancel = r.status === 'pending' || r.status === 'approved';
  return h('div', { class: 'req' },
    h('div', {}, h('strong', {}, `${fmtDate(r.date)}, ${fmtTime(r.start)} – ${fmtTime(r.end)}`), ' ', statusBadge),
    h('div', { class: 'meta' }, [r.areaName, `${r.name} (party of ${r.party})`, `Code ${r.code}`].filter(Boolean).join(' · ')),
    r.note ? h('div', {}, r.note) : null,
    canCancel
      ? h('div', { class: 'actions' }, h('button', {
          class: 'danger small', type: 'button',
          onclick: async () => {
            if (!confirm('Cancel this request?')) return;
            try { await api('POST', '/api/requests/cancel', { code: r.code }); onChange && onChange(); }
            catch (e) { alert(e.message); }
          },
        }, 'Cancel request'))
      : null,
  );
}

async function loadConfig() {
  config = await api('GET', '/api/config');
  $('propName').textContent = config.propertyName;
  document.title = `Book a Hunt · ${config.propertyName}`;
  $('rules').textContent = config.rules || 'None posted.';
  $('drawInfo').textContent = config.autoDrawEnabled
    ? `The draw runs automatically ${config.autoDrawHours} hours before the start of your hunt date.`
    : 'The landowner will run the draw before your hunt date.';
  $('date').min = todayStr();
  $('date').value ||= todayStr();
  $('areaWrap').hidden = !config.areas.length;
  const sel = $('areaId');
  sel.replaceChildren(...config.areas.map((a) => h('option', { value: a.id }, a.name)));
}

async function loadCalendar() {
  const { items } = await api('GET', '/api/calendar');
  const box = $('calendar');
  if (!items.length) { box.replaceChildren(h('p', { class: 'hint' }, 'Nothing scheduled yet. Be the first to request a time.')); return; }
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  box.replaceChildren(...[...byDate].map(([date, list]) =>
    h('div', { class: 'cal-day' },
      h('h3', {}, fmtDate(date)),
      list.map((it) => h('div', { class: 'slot' },
        h('span', {}, `${fmtTime(it.start)} – ${fmtTime(it.end)}`, it.areaName ? ` · ${it.areaName}` : ''),
        it.status === 'approved'
          ? h('span', { class: 'badge approved' }, 'Confirmed')
          : it.contested
            ? h('span', { class: 'badge contested' }, 'Contested')
            : h('span', { class: 'badge pending' }, 'Pending'),
      )),
    )));
}

async function loadMine() {
  const codes = myCodes();
  $('mineCard').hidden = !codes.length;
  if (!codes.length) return;
  const results = await Promise.all(codes.map((c) => api('GET', `/api/requests/lookup?code=${encodeURIComponent(c)}`).then((d) => d.request).catch(() => null)));
  const list = results.filter(Boolean);
  $('mineCard').hidden = !list.length;
  $('mine').replaceChildren(...list.map((r) => requestCard(r, { onChange: refreshAll })));
}

function refreshAll() { return Promise.all([loadCalendar(), loadMine()]); }

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('formMsg');
  msg.replaceChildren();
  const f = new FormData(ev.target);
  const body = Object.fromEntries(f.entries());
  $('submitBtn').disabled = true;
  try {
    const { request } = await api('POST', '/api/requests', body);
    saveCode(request.code);
    msg.replaceChildren(h('div', { class: 'msg ok' },
      h('div', {}, 'Request received. Save this code to check your status:'),
      h('div', { class: 'code' }, request.code),
      h('div', {}, request.note),
    ));
    $('notes').value = '';
    await refreshAll();
  } catch (e) {
    msg.replaceChildren(h('div', { class: 'msg error' }, e.message));
  } finally {
    $('submitBtn').disabled = false;
  }
});

$('lookupBtn').addEventListener('click', async () => {
  const out = $('lookupResult');
  const code = $('lookupCode').value.trim();
  if (!code) return;
  try {
    const { request } = await api('GET', `/api/requests/lookup?code=${encodeURIComponent(code)}`);
    saveCode(request.code);
    out.replaceChildren(requestCard(request, { onChange: async () => { $('lookupBtn').click(); await refreshAll(); } }));
    loadMine();
  } catch (e) {
    out.replaceChildren(h('div', { class: 'msg error' }, e.message));
  }
});

(async () => {
  try { await loadConfig(); await refreshAll(); }
  catch (e) { $('formMsg').replaceChildren(h('div', { class: 'msg error' }, 'Could not load the page: ' + e.message)); }
  setInterval(() => refreshAll().catch(() => {}), 60000);
})();
