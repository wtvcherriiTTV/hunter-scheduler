'use strict';
/*
 * Hunt Scheduler — zero-dependency Node server.
 * Run:  node server.js     (then open http://localhost:3000)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// Used ONLY the first time the database is created. Change it from Admin > Account afterwards.
const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASSWORD || 'airgeouk!';

/* ------------------------------ helpers ------------------------------ */

const httpErr = (status, message) => Object.assign(new Error(message), { status });

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw, rec) {
  const got = crypto.scryptSync(pw, rec.salt, 64);
  const exp = Buffer.from(rec.hash, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

const newId = () => crypto.randomBytes(8).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return c;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ------------------------------ database ------------------------------ */

let db;
function defaultDb() {
  return {
    settings: {
      propertyName: 'Hunting Property',
      rules: 'Check in with the landowner before you head out. Follow all state hunting laws.',
      maxHours: 12,
      autoDrawEnabled: true,
      autoDrawHours: 24,
    },
    areas: [],
    requests: [],
    drawLog: [],
    admin: { username: DEFAULT_ADMIN_USER, ...hashPassword(DEFAULT_ADMIN_PASS) },
  };
}
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...defaultDb().settings, ...db.settings };
  } else {
    db = defaultDb();
    saveDb();
  }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ------------------------------ draw logic ------------------------------ */

const overlaps = (a, b) =>
  a.date === b.date && a.areaId === b.areaId && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

// Split requests into groups of mutually-chained overlapping requests.
function components(list) {
  const seen = new Set();
  const groups = [];
  for (const r of list) {
    if (seen.has(r)) continue;
    const group = [];
    const queue = [r];
    seen.add(r);
    while (queue.length) {
      const cur = queue.pop();
      group.push(cur);
      for (const o of list) {
        if (!seen.has(o) && overlaps(cur, o)) {
          seen.add(o);
          queue.push(o);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function decide(r, status, note) {
  r.status = status;
  r.note = note;
  r.decidedAt = new Date().toISOString();
}

/**
 * Resolve every pending request on `date`.
 *  - Pending requests that overlap an already-confirmed hunt are declined.
 *  - Requests with no conflict are confirmed.
 *  - Conflicting requests: one is chosen at random (crypto-secure); anyone whose
 *    time overlaps the winner is declined; the rest are re-checked.
 */
function runDraw(date, auto) {
  const summary = { date, confirmed: 0, declined: 0, draws: 0 };
  const approved = db.requests.filter((r) => r.date === date && r.status === 'approved');
  let pending = db.requests.filter((r) => r.date === date && r.status === 'pending');

  for (const r of [...pending]) {
    if (approved.some((a) => overlaps(a, r))) {
      decide(r, 'rejected', 'That time was already confirmed for another hunter.');
      summary.declined++;
      pending = pending.filter((x) => x !== r);
    }
  }

  while (pending.length) {
    const next = [];
    for (const group of components(pending)) {
      if (group.length === 1) {
        decide(group[0], 'approved', 'No conflicts, so this hunt is confirmed.');
        summary.confirmed++;
        continue;
      }
      const winner = group[crypto.randomInt(group.length)];
      decide(winner, 'approved', `Won the random draw (1 of ${group.length} overlapping requests).`);
      summary.confirmed++;
      summary.draws++;
      db.drawLog.push({
        at: new Date().toISOString(),
        date,
        areaId: winner.areaId,
        auto: !!auto,
        entrants: group.map((g) => ({ id: g.id, name: g.name, start: g.start, end: g.end })),
        winnerId: winner.id,
        winnerName: winner.name,
      });
      for (const r of group) {
        if (r === winner) continue;
        if (overlaps(r, winner)) {
          decide(r, 'rejected', `Lost the random draw (1 of ${group.length} overlapping requests).`);
          summary.declined++;
        } else {
          next.push(r);
        }
      }
    }
    pending = next;
  }
  if (db.drawLog.length > 500) db.drawLog = db.drawLog.slice(-500);
  return summary;
}

// Automatic draw: once we are within `autoDrawHours` of the start of a date, draw it.
function autoTick() {
  try {
    if (!db.settings.autoDrawEnabled) return;
    const now = Date.now();
    const dates = [...new Set(db.requests.filter((r) => r.status === 'pending').map((r) => r.date))];
    let changed = false;
    for (const date of dates) {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d).getTime();
      if (now >= dayStart - db.settings.autoDrawHours * 3600 * 1000) {
        runDraw(date, true);
        changed = true;
      }
    }
    if (changed) saveDb();
  } catch (e) {
    console.error('auto draw failed:', e);
  }
}

/* ------------------------------ serializers ------------------------------ */

const areaName = (id) => {
  if (!id) return '';
  const a = db.areas.find((x) => x.id === id);
  return a ? a.name : 'Removed area';
};
const publicReq = (r) => ({
  code: r.code, name: r.name, party: r.party, date: r.date, start: r.start, end: r.end,
  areaId: r.areaId, areaName: areaName(r.areaId), status: r.status, note: r.note || '', notes: r.notes || '',
});
const adminReq = (r) => ({
  ...publicReq(r),
  id: r.id, phone: r.phone, email: r.email, createdAt: r.createdAt, decidedAt: r.decidedAt || null,
  conflicts: db.requests.filter(
    (o) => o !== r && (o.status === 'pending' || o.status === 'approved') && (r.status === 'pending' || r.status === 'approved') && overlaps(r, o),
  ).length,
});

/* ------------------------------ rate limit & sessions ------------------------------ */

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++;
  buckets.set(key, b);
  return b.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  for (const [k, s] of sessions) if (now > s.expires) sessions.delete(k);
}, 10 * 60 * 1000).unref();

const sessions = new Map();
const SESSION_MS = 8 * 3600 * 1000;
const clientIp = (req) =>
  (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
function getSession(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || Date.now() > s.expires) { sessions.delete(m[1]); return null; }
  return { token: m[1], ...s };
}
function requireAdmin(req) {
  const s = getSession(req);
  if (!s) throw httpErr(401, 'Please sign in.');
  return s;
}

/* ------------------------------ request handling ------------------------------ */

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) tooBig = true; else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(httpErr(413, 'Request too large.'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpErr(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function checkOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw httpErr(415, 'JSON required.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw httpErr(403, 'Bad origin.'); }
    if (host !== req.headers.host) throw httpErr(403, 'Cross-site request blocked.');
  }
}

function validateRequestInput(b) {
  const name = clean(b.name, 80);
  const phone = clean(b.phone, 40);
  const email = clean(b.email, 120);
  const notes = clean(b.notes, 500);
  const party = Math.round(Number(b.party) || 1);
  const date = clean(b.date, 10), start = clean(b.start, 5), end = clean(b.end, 5);
  const areaId = clean(b.areaId, 40);

  if (!name) throw httpErr(400, 'Please enter your name.');
  if (!phone && !email) throw httpErr(400, 'Please give a phone number or email so the landowner can reach you.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpErr(400, 'That email address does not look right.');
  if (party < 1 || party > 20) throw httpErr(400, 'Party size must be between 1 and 20.');
  if (!validDate(date)) throw httpErr(400, 'Please pick a valid date.');
  if (date < todayStr()) throw httpErr(400, 'That date is in the past.');
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw httpErr(400, 'Please enter valid start and end times.');
  if (toMin(end) <= toMin(start)) throw httpErr(400, 'End time must be after the start time.');
  if ((toMin(end) - toMin(start)) > db.settings.maxHours * 60)
    throw httpErr(400, `Hunts are limited to ${db.settings.maxHours} hours.`);
  if (db.areas.length) {
    if (!db.areas.some((a) => a.id === areaId)) throw httpErr(400, 'Please choose a hunting area.');
  }
  return { name, phone, email, notes, party, date, start, end, areaId: db.areas.length ? areaId : '' };
}

async function handleApi(req, res, url) {
  checkOrigin(req);
  const p = url.pathname;
  const m = req.method;
  const ip = clientIp(req);

  /* ---------- public ---------- */
  if (m === 'GET' && p === '/api/config') {
    const { propertyName, rules, maxHours, autoDrawEnabled, autoDrawHours } = db.settings;
    return json(res, 200, { propertyName, rules, maxHours, autoDrawEnabled, autoDrawHours, areas: db.areas });
  }

  if (m === 'GET' && p === '/api/calendar') {
    const today = todayStr();
    const active = db.requests.filter((r) => (r.status === 'approved' || r.status === 'pending') && r.date >= today);
    const items = active
      .map((r) => ({
        date: r.date, start: r.start, end: r.end, areaId: r.areaId, areaName: areaName(r.areaId), status: r.status,
        contested: r.status === 'pending' && active.some((o) => o !== r && overlaps(r, o)),
      }))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    return json(res, 200, { items });
  }

  if (m === 'POST' && p === '/api/requests') {
    if (!rateLimit('submit:' + ip, 20, 3600 * 1000)) throw httpErr(429, 'Too many requests. Try again later.');
    const input = validateRequestInput(await readBody(req));
    let code;
    do { code = newCode(); } while (db.requests.some((r) => r.code === code));
    const r = {
      id: newId(), code, ...input, status: 'pending', note: 'Waiting for the draw.',
      createdAt: new Date().toISOString(),
    };
    db.requests.push(r);
    saveDb();
    // If the draw window for this date has already opened, resolve right away.
    autoTick();
    return json(res, 201, { request: publicReq(r) });
  }

  if (m === 'GET' && p === '/api/requests/lookup') {
    if (!rateLimit('lookup:' + ip, 60, 3600 * 1000)) throw httpErr(429, 'Too many lookups. Try again later.');
    const code = clean(url.searchParams.get('code') || '', 10).toUpperCase();
    const r = db.requests.find((x) => x.code === code);
    if (!r) throw httpErr(404, 'No request found with that code.');
    return json(res, 200, { request: publicReq(r) });
  }

  if (m === 'POST' && p === '/api/requests/cancel') {
    const body = await readBody(req);
    const code = clean(body.code, 10).toUpperCase();
    const r = db.requests.find((x) => x.code === code);
    if (!r) throw httpErr(404, 'No request found with that code.');
    if (r.status !== 'pending' && r.status !== 'approved') throw httpErr(400, 'This request is already closed.');
    decide(r, 'cancelled', 'Cancelled by the hunter.');
    saveDb();
    return json(res, 200, { request: publicReq(r) });
  }

  /* ---------- admin auth ---------- */
  if (m === 'POST' && p === '/api/admin/login') {
    if (!rateLimit('login:' + ip, 8, 15 * 60 * 1000)) throw httpErr(429, 'Too many attempts. Wait 15 minutes and try again.');
    const b = await readBody(req);
    const userOk = clean(b.username, 80) === db.admin.username;
    const passOk = typeof b.password === 'string' && verifyPassword(b.password, db.admin);
    if (!userOk || !passOk) throw httpErr(401, 'Wrong username or password.');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + SESSION_MS });
    const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return json(res, 200, { ok: true }, {
      'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`,
    });
  }

  if (m === 'POST' && p === '/api/admin/logout') {
    const s = getSession(req);
    if (s) sessions.delete(s.token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  /* ---------- admin (everything below needs a session) ---------- */
  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);

    if (m === 'GET' && p === '/api/admin/me') return json(res, 200, { username: db.admin.username });

    if (m === 'GET' && p === '/api/admin/state') {
      const requests = db.requests
        .map(adminReq)
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      return json(res, 200, {
        requests, areas: db.areas, settings: db.settings, drawLog: [...db.drawLog].reverse().slice(0, 200),
        username: db.admin.username,
      });
    }

    if (m === 'POST' && p === '/api/admin/draw') {
      const b = await readBody(req);
      const date = clean(b.date, 10);
      const dates = date
        ? [date]
        : [...new Set(db.requests.filter((r) => r.status === 'pending').map((r) => r.date))].sort();
      if (date && !validDate(date)) throw httpErr(400, 'Invalid date.');
      const results = dates.map((d) => runDraw(d, false));
      saveDb();
      return json(res, 200, { results });
    }

    let mm;
    if ((mm = /^\/api\/admin\/requests\/([a-f0-9]+)$/.exec(p))) {
      const r = db.requests.find((x) => x.id === mm[1]);
      if (!r) throw httpErr(404, 'Request not found.');
      if (m === 'PATCH') {
        const b = await readBody(req);
        if (b.status === 'approved') {
          const clash = db.requests.find((o) => o !== r && o.status === 'approved' && overlaps(o, r));
          if (clash) throw httpErr(409, `Overlaps a confirmed hunt (${clash.name}, ${clash.start}-${clash.end}). Reject that one first.`);
          decide(r, 'approved', 'Approved by the landowner.');
        } else if (b.status === 'rejected') {
          decide(r, 'rejected', 'Declined by the landowner.');
        } else if (b.status === 'pending') {
          decide(r, 'pending', 'Waiting for the draw.');
        } else throw httpErr(400, 'Unknown status.');
        saveDb();
        return json(res, 200, { request: adminReq(r) });
      }
      if (m === 'DELETE') {
        db.requests = db.requests.filter((x) => x !== r);
        saveDb();
        return json(res, 200, { ok: true });
      }
    }

    if (m === 'POST' && p === '/api/admin/areas') {
      const name = clean((await readBody(req)).name, 60);
      if (!name) throw httpErr(400, 'Give the area a name.');
      if (db.areas.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'That area already exists.');
      db.areas.push({ id: newId(), name });
      saveDb();
      return json(res, 201, { areas: db.areas });
    }
    if (m === 'DELETE' && (mm = /^\/api\/admin\/areas\/([a-f0-9]+)$/.exec(p))) {
      db.areas = db.areas.filter((a) => a.id !== mm[1]);
      saveDb();
      return json(res, 200, { areas: db.areas });
    }

    if (m === 'PUT' && p === '/api/admin/settings') {
      const b = await readBody(req);
      const propertyName = clean(b.propertyName, 80);
      const maxHours = Number(b.maxHours);
      const autoDrawHours = Number(b.autoDrawHours);
      if (!propertyName) throw httpErr(400, 'Property name is required.');
      if (!(maxHours >= 1 && maxHours <= 24)) throw httpErr(400, 'Max hours must be between 1 and 24.');
      if (!(autoDrawHours >= 0 && autoDrawHours <= 720)) throw httpErr(400, 'Draw hours must be between 0 and 720.');
      db.settings = {
        propertyName, rules: clean(b.rules, 2000), maxHours: Math.round(maxHours),
        autoDrawEnabled: !!b.autoDrawEnabled, autoDrawHours: Math.round(autoDrawHours),
      };
      saveDb();
      return json(res, 200, { settings: db.settings });
    }

    if (m === 'POST' && p === '/api/admin/password') {
      const b = await readBody(req);
      if (typeof b.current !== 'string' || !verifyPassword(b.current, db.admin)) throw httpErr(403, 'Current password is wrong.');
      if (typeof b.next !== 'string' || b.next.length < 8) throw httpErr(400, 'New password must be at least 8 characters.');
      const newUser = clean(b.username, 80) || db.admin.username;
      db.admin = { username: newUser, ...hashPassword(b.next) };
      saveDb();
      return json(res, 200, { ok: true });
    }
  }

  throw httpErr(404, 'Not found.');
}

/* ------------------------------ static files ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/admin') pathname = '/admin.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname))); }
  catch { res.writeHead(400, SEC_HEADERS); return res.end('Bad request'); }
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) {
    res.writeHead(404, SEC_HEADERS);
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    res.end(data);
  });
}

/* ------------------------------ boot ------------------------------ */

loadDb();
autoTick();
setInterval(autoTick, 60 * 1000);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Method not allowed.');
      serveStatic(res, url.pathname);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    }
  })
  .listen(PORT, () => console.log(`Hunt Scheduler running on http://localhost:${PORT}  (admin: /admin)`));
