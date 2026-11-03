'use strict';

// Serves the site, plus a small API for captains to submit results with a photo of the score sheet.
// Submissions and photos live in DATA_DIR (a persistent volume on Coolify). No dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8417;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'submissions.json');
const ADMIN_KEY = process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev');

const SHEET_ID = '1iVX-93u-ydRftXX9PsBV0Cq0Q77084ZvRKxAem9tDuE';
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Results Entry')}`;
const FIXTURES_TTL = 5 * 60 * 1000;

const SUBMIT_DAYS = 7; // a result can be submitted from the fixture date until this many days after
const MAX_BODY = 12 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const POSTS_PER_HOUR = 30; // per IP address
const SAST_OFFSET = 2 * 60 * 60 * 1000;

// Scoring Rules tab: 1 point per set, plus a win bonus (singles 4, doubles 3) or 1 each for a draw.
const WIN_BONUS = { singles: 4, doubles: 3 };
const DRAW_BONUS = 1;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/submit.js': ['submit.js', 'text/javascript; charset=utf-8'],
};

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- Fixtures (read from the results sheet, same as the site) ----------

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map(clean);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function num(v) {
  const s = clean(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "31-Oct-2026" -> "2026-10-31"
function isoDate(s) {
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(clean(s));
  let d;
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) d = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
  else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    d = new Date(t + SAST_OFFSET);
  }
  return d.toISOString().slice(0, 10);
}

const todaySAST = () => new Date(Date.now() + SAST_OFFSET).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

let fixtures = { at: 0, map: new Map(), loading: null };

async function loadFixtures() {
  if (Date.now() - fixtures.at < FIXTURES_TTL && fixtures.map.size) return fixtures.map;
  fixtures.loading ??= (async () => {
    try {
      const res = await fetch(RESULTS_URL);
      if (!res.ok) throw new Error(`Results sheet: HTTP ${res.status}`);
      const rows = parseCSV(await res.text());
      const map = new Map();
      const perFixture = new Map(); // division -> Map(matches -> count)
      for (const r of rows) {
        const id = clean(r['Fixture ID']);
        const division = clean(r['Division']);
        if (!id || !division || !clean(r['Home Team']) || !clean(r['Away Team'])) continue;
        const f = {
          id, division,
          home: clean(r['Home Team']),
          away: clean(r['Away Team']),
          date: isoDate(r['Date']),
          doubles: /doubles/i.test(clean(r['Format']) || division),
          hm: num(r['Home Matches Won']), am: num(r['Away Matches Won']),
          hs: num(r['Home Sets Won']), as: num(r['Away Sets Won']),
          hp: num(r['Home Final Pts']), ap: num(r['Away Final Pts']),
        };
        f.official = (f.hm !== null && f.am !== null) || (f.hp !== null && f.ap !== null);
        const walkover = /default/i.test(clean(r['Status'])) || /default/i.test(clean(r['Notes']));
        if (f.official && !walkover && f.hm + f.am > 0) {
          if (!perFixture.has(division)) perFixture.set(division, new Map());
          const counts = perFixture.get(division);
          counts.set(f.hm + f.am, (counts.get(f.hm + f.am) ?? 0) + 1);
        }
        map.set(id, f);
      }
      // Matches per fixture: whatever played fixtures in the division usually have (6 singles / 4 doubles).
      for (const f of map.values()) {
        const best = [...(perFixture.get(f.division) ?? [])].sort((a, b) => b[1] - a[1])[0];
        f.n = best ? best[0] : f.doubles ? 4 : 6;
      }
      fixtures = { at: Date.now(), map, loading: null };
    } catch (err) {
      fixtures.loading = null;
      if (!fixtures.map.size) throw err;
      console.error(err); // keep using the last good copy
    }
    return fixtures.map;
  })();
  return fixtures.loading;
}

// ---------- Scores ----------

// Each match is best of three: the winner takes 2 sets, the loser 0 or 1.
function checkScore(f, s) {
  const ints = ['hm', 'am', 'hs', 'as'].every((k) => Number.isInteger(s[k]) && s[k] >= 0);
  if (!ints) return 'Scores must be whole numbers.';
  if (s.hm + s.am !== f.n) return `This division plays ${f.n} matches per fixture.`;
  if (s.hs < 2 * s.hm || s.hs > 2 * s.hm + s.am) return 'Home sets are outside what the match score allows.';
  if (s.as < 2 * s.am || s.as > 2 * s.am + s.hm) return 'Away sets are outside what the match score allows.';
  return null;
}

function points(f, s) {
  const result = s.hm !== s.am ? (s.hm > s.am ? 'H' : 'A') : s.hs !== s.as ? (s.hs > s.as ? 'H' : 'A') : 'D';
  const bonus = WIN_BONUS[f.doubles ? 'doubles' : 'singles'];
  return {
    hp: s.hs + (result === 'H' ? bonus : result === 'D' ? DRAW_BONUS : 0),
    ap: s.as + (result === 'A' ? bonus : result === 'D' ? DRAW_BONUS : 0),
  };
}

const sameScore = (a, b) => ['hm', 'am', 'hs', 'as'].every((k) => a[k] === b[k]);

// ---------- Storage ----------

let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* first run */ }

let writing = Promise.resolve();
function save() {
  const json = JSON.stringify(db, null, 1);
  writing = writing.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, DB_FILE);
  }).catch((err) => console.error('Saving submissions failed', err));
  return writing;
}

async function savePhoto(fixtureId, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new HttpError(400, 'Please add a photo of the score sheet.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO) throw new HttpError(413, 'That photo is too large.');
  const file = `${fixtureId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  await fs.promises.writeFile(path.join(PHOTO_DIR, file), buf);
  return file;
}

const newToken = () => crypto.randomBytes(6).toString('base64url');

// What everyone can see: enough to show the result on the site, without names, photos or links.
function publicView(s) {
  return { fixtureId: s.fixtureId, status: s.status, side: s.side, at: s.createdAt, ...s.score };
}

// What the other captain sees through their link.
function confirmView(s, f) {
  return {
    fixtureId: s.fixtureId, division: s.division, home: s.home, away: s.away, date: s.date,
    status: s.status, side: s.side, name: s.name, at: s.createdAt, score: s.score,
    photo: `/api/photo/${s.photo}?t=${s.token}`,
    confirm: s.confirm && { name: s.confirm.name, side: s.confirm.side, at: s.confirm.at },
    official: Boolean(f?.official),
  };
}

// ---------- HTTP ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'Bad request.')); }
    });
    req.on('error', reject);
  });
}

const posts = new Map(); // ip -> timestamps of recent POSTs
function rateLimit(req) {
  const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (posts.get(ip) ?? []).filter((t) => now - t < 3600000);
  if (recent.length >= POSTS_PER_HOUR) throw new HttpError(429, 'Too many submissions from here. Please try again later.');
  recent.push(now);
  posts.set(ip, recent);
}

const isAdmin = (req, url) => Boolean(ADMIN_KEY) && (req.headers['x-admin-key'] === ADMIN_KEY || url.searchParams.get('k') === ADMIN_KEY);

const name = (v) => clean(v).slice(0, 60);

async function submit(body) {
  const all = await loadFixtures();
  const f = all.get(clean(body.fixtureId));
  if (!f) throw new HttpError(404, 'That fixture is not in the results sheet.');
  const today = todaySAST();
  if (!f.date || f.date > today) throw new HttpError(400, 'Results can be submitted from the day of the fixture.');
  if (daysBetween(f.date, today) > SUBMIT_DAYS) throw new HttpError(400, `Results can only be submitted within ${SUBMIT_DAYS} days of the fixture.`);
  const side = body.side === 'away' ? 'away' : 'home';
  const who = name(body.name);
  if (!who) throw new HttpError(400, 'Please add your name.');
  const score = { hm: body.hm, am: body.am, hs: body.hs, as: body.as };
  const problem = checkScore(f, score);
  if (problem) throw new HttpError(400, problem);
  Object.assign(score, points(f, score));

  const prev = db[f.id];
  if (prev?.status === 'approved') throw new HttpError(409, 'This result has already been approved by the league.');
  const photo = await savePhoto(f.id, body.photo);
  const now = new Date().toISOString();

  // The other team submitting the same score counts as their confirmation; a different score is a dispute.
  if (prev && prev.side !== side) {
    if (sameScore(prev.score, score) && prev.status !== 'disputed') {
      prev.status = 'confirmed';
      prev.confirm = { name: who, side, at: now, photo };
    } else {
      prev.status = 'disputed';
      prev.disputes.push({ name: who, side, at: now, score, photo });
    }
    await save();
    return { status: prev.status, fixtureId: f.id };
  }

  // A new submission, or the same team correcting its own (which needs confirming again).
  const s = {
    fixtureId: f.id, division: f.division, home: f.home, away: f.away, date: f.date,
    status: 'pending', side, name: who, score, photo, createdAt: now,
    token: prev?.token ?? newToken(), confirm: null, disputes: [],
    history: prev ? [...prev.history, { name: prev.name, at: prev.createdAt, score: prev.score, photo: prev.photo }] : [],
  };
  db[f.id] = s;
  await save();
  return { status: s.status, fixtureId: f.id, token: s.token };
}

function byToken(id, token) {
  const s = db[id];
  if (!s || !token || s.token !== token) throw new HttpError(404, 'This link is not valid any more.');
  return s;
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = (re) => re.exec(p);
  let r;

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, submitDays: SUBMIT_DAYS });

  if (req.method === 'GET' && p === '/api/submissions') {
    return send(res, 200, Object.values(db).map(publicView));
  }

  if (req.method === 'POST' && p === '/api/submissions') {
    rateLimit(req);
    return send(res, 200, await submit(await readBody(req)));
  }

  if (req.method === 'GET' && (r = m(/^\/api\/submissions\/([\w-]+)$/))) {
    const s = byToken(r[1], url.searchParams.get('t'));
    return send(res, 200, confirmView(s, (await loadFixtures().catch(() => new Map())).get(s.fixtureId)));
  }

  if (req.method === 'POST' && (r = m(/^\/api\/submissions\/([\w-]+)\/(confirm|dispute)$/))) {
    rateLimit(req);
    const body = await readBody(req);
    const s = byToken(r[1], body.t);
    const who = name(body.name);
    if (!who) throw new HttpError(400, 'Please add your name.');
    if (s.status === 'approved') throw new HttpError(409, 'This result has already been approved by the league.');
    const side = s.side === 'home' ? 'away' : 'home';
    const now = new Date().toISOString();
    if (r[2] === 'confirm') {
      if (s.status === 'disputed') throw new HttpError(409, 'This result is disputed. The league will look at it.');
      s.status = 'confirmed';
      s.confirm = { name: who, side, at: now };
    } else {
      s.status = 'disputed';
      s.disputes.push({ name: who, side, at: now, note: clean(body.note).slice(0, 500) });
    }
    await save();
    return send(res, 200, { status: s.status });
  }

  if (req.method === 'GET' && (r = m(/^\/api\/photo\/([\w.-]+)$/))) {
    const file = r[1];
    const owner = Object.values(db).find((s) => s.photo === file
      || s.confirm?.photo === file
      || s.disputes.some((d) => d.photo === file)
      || s.history.some((h) => h.photo === file));
    const allowed = isAdmin(req, url) || (owner && owner.token === url.searchParams.get('t'));
    if (!allowed) throw new HttpError(404, 'Not found.');
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const data = await fs.promises.readFile(path.join(PHOTO_DIR, file)).catch(() => null);
    if (!data) throw new HttpError(404, 'Not found.');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    return res.end(data);
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req, url)) throw new HttpError(401, 'Wrong admin key.');

    if (req.method === 'GET' && p === '/api/admin/submissions') {
      const all = await loadFixtures().catch(() => new Map());
      const list = Object.values(db).map((s) => {
        const f = all.get(s.fixtureId);
        return { ...s, official: f?.official ? { hm: f.hm, am: f.am, hs: f.hs, as: f.as, hp: f.hp, ap: f.ap } : null };
      });
      return send(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }

    if (req.method === 'POST' && (r = m(/^\/api\/admin\/submissions\/([\w-]+)\/(approve|remove)$/))) {
      const s = db[r[1]];
      if (!s) throw new HttpError(404, 'Not found.');
      if (r[2] === 'approve') {
        s.status = 'approved';
        s.approvedAt = new Date().toISOString();
      } else {
        delete db[r[1]];
      }
      await save();
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    const file = STATIC[url.pathname];
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const data = await fs.promises.readFile(path.join(ROOT, file[0]));
    // Files change on every deploy, so browsers must re-check them.
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`ct-tennis on http://localhost:${PORT}${ADMIN_KEY ? '' : ' (admin disabled: set ADMIN_KEY)'}`));
