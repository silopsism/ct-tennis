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

const SUBMIT_DAYS = 7; // days after the fixture its result can be submitted, if it's already in the sheet (otherwise any time)
const MAX_BODY = 12 * 1024 * 1024;
const MAX_PHOTO = 8 * 1024 * 1024;
const POSTS_PER_HOUR = 30; // per IP address
const SAST_OFFSET = 2 * 60 * 60 * 1000;

// Reading score sheets from the photo (optional: off unless GEMINI_API_KEY is set). These models are all asked at once.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((m) => m.trim());
const READ_TIMEOUT = 20 * 1000; // overall: after this the captain types the score
const READ_TTL = 2 * 60 * 60 * 1000; // a reading is kept this long for the submission that follows it

// Scoring Rules tab: 1 point per set, plus a win bonus (singles 4, doubles 3) or 1 each for a draw.
const WIN_BONUS = { singles: 4, doubles: 3 };
const DRAW_BONUS = 1;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/submit.js': ['submit.js', 'text/javascript; charset=utf-8'],
  '/ratings.js': ['ratings.js', 'text/javascript; charset=utf-8'],
  '/conditions.js': ['conditions.js', 'text/javascript; charset=utf-8'],
  '/courts.json': ['courts.json', 'application/json; charset=utf-8'],
};

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// The page links each file with a fingerprint of its contents ("app.js?v=3f9c…"). Phones can then keep the
// files cached, and still fetch a new copy as soon as a deploy changes one, with no refresh needed.
const ASSETS = ['styles.css', 'submit.js', 'ratings.js', 'conditions.js', 'app.js'];

async function indexHTML() {
  let html = await fs.promises.readFile(path.join(ROOT, 'index.html'), 'utf8');
  for (const file of ASSETS) {
    const data = await fs.promises.readFile(path.join(ROOT, file));
    const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
    html = html.replace(`"${file}"`, `"${file}?v=${hash}"`);
  }
  return html;
}

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

// ---------- Reading the score sheet photo ----------

const READ_PROMPT = `This is a photo of a Cape Town Tennis league result sheet, filled in by hand.
Read it exactly as written. Conventions on these sheets:
- Circled boxes mark the competition (MENS / LADIES / MIXED), format (SINGLES / DBLS / VETS) and league section (P, 1-10, A, B). If nothing is circled, return null.
- Each numbered row is one rubber (match). Columns, left to right: home player(s), home "Match" won (1 or 0),
  home "Sets" won, the game scores, away "Sets" won, away "Match" won, away player(s).
- Game scores are written home side first, e.g. "6-2, 6-0". A third set may be a match tie-break such as "9-11" or "5-10".
- A dash "–" in a Match or Sets box means 0. Doubles pairs may be written as numbers like "1+4" or just "2".
- Where a digit has been written over, read the final (corrected) value.
- The totals area has TOTAL PTS (home sets / home matches and away sets / away matches), BONUS PTS and FULL SCORE for each side.
Leave out rows with nothing written in them. Use null for anything you can't read, and mention it in "unclear".`;

const INT = { type: 'INTEGER', nullable: true };
const STR = { type: 'STRING', nullable: true };
const READ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: STR,
    competition: { type: 'STRING', enum: ['mens', 'ladies', 'mixed'], nullable: true },
    format: { type: 'STRING', enum: ['singles', 'doubles', 'vets'], nullable: true },
    league_section: STR,
    home_club: STR, home_team_letter: STR, away_club: STR, away_team_letter: STR,
    rubbers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          number: INT, home_players: STR, away_players: STR,
          games: { type: 'ARRAY', items: { type: 'STRING' } },
          home_match: INT, home_sets: INT, away_sets: INT, away_match: INT,
        },
        required: ['number', 'games', 'home_match', 'home_sets', 'away_sets', 'away_match'],
      },
    },
    totals: {
      type: 'OBJECT',
      properties: {
        home_matches: INT, home_sets: INT, away_sets: INT, away_matches: INT,
        home_bonus: INT, away_bonus: INT, home_full_score: INT, away_full_score: INT,
      },
    },
    fixture_won_by: STR,
    unclear: STR,
  },
  required: ['rubbers', 'totals'],
};

async function askGemini(model, mime, image, signal) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text: READ_PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: READ_SCHEMA, temperature: 0 },
    }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || `HTTP ${res.status}`), { status: res.status });
  return JSON.parse(body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || 'null');
}

// Reads the photo for fixture f. All the models are asked at once (free-tier models are often busy, and they don't
// always read a sheet the same way twice): the first reading that adds up wins and the rest are dropped. If none
// adds up within READ_TIMEOUT, the closest one is returned so the captain can see what went wrong.
function readSheet(f, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new HttpError(400, 'Please add a photo of the score sheet.');
  const started = Date.now();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('No answer in time')), READ_TIMEOUT);
  let done = false, best = null, last = null, pending = GEMINI_MODELS.length;

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      if (best) resolve(best);
      else {
        const why = last?.status === 429 ? 'The photo reader is at its limit.'
          : stop.signal.aborted ? "The photo reader didn't answer in time."
          : "The photo reader isn't available right now.";
        reject(new HttpError(503, why));
      }
    };
    for (const model of GEMINI_MODELS) {
      askGemini(model, m[1], m[2], stop.signal).then((data) => {
        if (done) return;
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (!data || !Array.isArray(data.rubbers)) throw new Error('No reading in the answer');
        const result = readResult(f, data);
        console.log(`Read ${f.id} with ${model} in ${secs}s: ${result.problems.length ? `didn't add up (${result.problems.join(' ')})` : 'ok'}`);
        if (!best || result.problems.length < best.result.problems.length) best = { data, model, result };
        if (!result.problems.length) {
          done = true;
          stop.abort(new Error('Another model answered first'));
          finish();
        }
      }).catch((err) => {
        last = err;
        if (!done) console.error(`Reading ${f.id} with ${model} failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
      }).finally(() => {
        if (--pending === 0 && !done) {
          done = true;
          finish();
        }
      });
    }
  });
}

const words = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, '');
const clubOf = (team) => (/^(.*\S)\s+[LM][SD][A-Z]$/.exec(team)?.[1] ?? team);
const sameClub = (a, b) => Boolean(a && b) && (a.includes(b) || b.includes(a));

// Game scores one set each, whether the model gave ["6-2", "6-0"] or ["6-2, 6-0"].
const splitGames = (games) => (games ?? []).flatMap((g) => String(g).split(/[,;/]/)).map(clean).filter(Boolean);

// Sets won by each side from game scores like "6-4", "2-6", "9-11" (home first). Null if any can't be read.
function setsFromGames(games) {
  if (!games?.length) return null;
  const sets = [0, 0];
  for (const g of games) {
    const m = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(clean(g));
    if (!m || +m[1] === +m[2]) return null;
    sets[+m[1] > +m[2] ? 0 : 1]++;
  }
  return sets;
}

// Turns a reading into the fixture's result, checking each row adds up. The result comes from the rows,
// not the totals box (which is often filled in loosely). A problem means the score shouldn't be filled in;
// a warning is worth a second look.
function readResult(f, data) {
  const problems = [], warnings = [];
  const rows = (data.rubbers ?? []).filter((r) => r && ([r.home_match, r.away_match, r.home_sets, r.away_sets].some((v) => v !== null && v !== undefined) || r.games?.length));
  // The sheet's home side is normally the fixture's home team; swap if it's clearly written the other way round.
  const [sh, sa, fh, fa] = [data.home_club, data.away_club, clubOf(f.home), clubOf(f.away)].map(words);
  const flipped = fh !== fa && sameClub(sh, fa) && sameClub(sa, fh);
  if (rows.length !== f.n) problems.push(`Found ${rows.length} matches on the sheet; this division plays ${f.n}.`);

  const total = { hm: 0, am: 0, hs: 0, as: 0 };
  rows.forEach((r, i) => {
    const [m1, m2, s1, s2] = [r.home_match, r.away_match, r.home_sets, r.away_sets].map((v) => v ?? 0);
    if (m1 + m2 !== 1) problems.push(`Match ${i + 1}: couldn't tell who won.`);
    else if ((m1 ? s1 : s2) !== 2 || (m1 ? s2 : s1) > 1) problems.push(`Match ${i + 1}: sets ${s1}–${s2} don't fit the result.`);
    const games = splitGames(r.games);
    const g = setsFromGames(games);
    if (games?.length && !g) warnings.push(`Match ${i + 1}: couldn't read all the game scores (${games.join(', ')}).`);
    else if (g && (g[0] !== s1 || g[1] !== s2)) warnings.push(`Match ${i + 1}: the game scores (${games.join(', ')}) don't match the sets column.`);
    Object.assign(total, { hm: total.hm + m1, am: total.am + m2, hs: total.hs + s1, as: total.as + s2 });
  });
  const t = data.totals ?? {};
  if (t.home_sets != null && t.away_sets != null && (t.home_sets !== total.hs || t.away_sets !== total.as)) {
    warnings.push(`The totals box says sets ${t.home_sets}–${t.away_sets}, but the matches add up to ${total.hs}–${total.as}.`);
  }

  const score = flipped ? { hm: total.am, am: total.hm, hs: total.as, as: total.hs } : total;
  const invalid = problems.length ? null : checkScore(f, score);
  if (invalid) problems.push(invalid);
  const rubbers = rows.map((r) => ({
    home: clean(r.home_players).slice(0, 80), away: clean(r.away_players).slice(0, 80),
    games: splitGames(r.games).map((g) => g.slice(0, 12)).slice(0, 3),
    hm: r.home_match ?? 0, hs: r.home_sets ?? 0, as: r.away_sets ?? 0, am: r.away_match ?? 0,
  }));
  return { score: problems.length ? null : score, problems, warnings, flipped, rubbers };
}

const reads = new Map(); // read id -> { fixtureId, at, sheet }: kept for the submission that follows

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
    rubbers: s.sheet?.rubbers ?? null, sheetFlipped: Boolean(s.sheet?.flipped),
    confirm: s.confirm && { name: s.confirm.name, side: s.confirm.side, at: s.confirm.at },
    official: Boolean(f?.official),
  };
}

// ---------- Club ratings ----------
// Away captains rate the club they played at, after submitting or confirming a result: stars and a vibe count at
// once; a comment and any facilities they tick wait for the admin. Kept in DATA_DIR/clubs.json.

const CLUBS_FILE = path.join(DATA_DIR, 'clubs.json');
const FACILITIES = ['practice_wall', 'shop', 'floodlights', 'change_rooms', 'parking', 'bar', 'braai', 'kids',
  'ball_machine', 'coaching', 'cards', 'wheelchair'];
const STARS = ['kitchen', 'courts', 'shade', 'seating', 'hospitality']; // kitchen 0 = no kitchen
const COMMENTS_SHOWN = 8;

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let clubDb = { tickets: {}, ratings: {}, facts: {}, summaries: {}, research: {} };
try { clubDb = { ...clubDb, ...JSON.parse(fs.readFileSync(CLUBS_FILE, 'utf8')) }; } catch { /* first run */ }

// Researched club details (club-facts.json, in the repo): address and links show straight away; the facilities found
// (each with its source) wait on the admin page like a captain's, and approving one never overrides a captain's answer.
// clubDb.research records the admin's decision per club: 'approved' or 'removed'.
let RESEARCH = {};
try { RESEARCH = JSON.parse(fs.readFileSync(path.join(ROOT, 'club-facts.json'), 'utf8')); } catch { /* none yet */ }

let clubWriting = Promise.resolve();
function saveClubs() {
  const json = JSON.stringify(clubDb, null, 1);
  clubWriting = clubWriting.then(async () => {
    const tmp = `${CLUBS_FILE}.tmp`;
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, CLUBS_FILE);
  }).catch((err) => console.error('Saving club ratings failed', err));
  return clubWriting;
}

// A ticket for the away team to rate the home club, one per fixture: rating again replaces the earlier one.
function rateTicket(f) {
  const found = Object.entries(clubDb.tickets).find(([, t]) => t.fixtureId === f.id);
  if (found) return { rateTicket: found[0], rateClub: found[1].name };
  const ticket = crypto.randomBytes(9).toString('base64url');
  const name = clubOf(f.home);
  clubDb.tickets[ticket] = { fixtureId: f.id, club: slugify(name), name, away: f.away, division: f.division, date: f.date, at: new Date().toISOString() };
  saveClubs();
  return { rateTicket: ticket, rateClub: name };
}

function rate(body) {
  const t = clubDb.tickets[clean(body.ticket)];
  if (!t) throw new HttpError(404, 'This rating link is not valid.');
  const stars = {};
  for (const k of STARS) {
    const v = Number(body.stars?.[k]);
    if (Number.isInteger(v) && v >= (k === 'kitchen' ? 0 : 1) && v <= 3) stars[k] = v;
  }
  const vibe = [1, 2, 3].includes(Number(body.vibe)) ? Number(body.vibe) : null;
  const ticks = {};
  for (const k of FACILITIES) if (typeof body.ticks?.[k] === 'boolean') ticks[k] = body.ticks[k];
  const comment = clean(body.comment).slice(0, 300);
  if (!Object.keys(stars).length && !vibe && !Object.keys(ticks).length && !comment) throw new HttpError(400, 'Nothing to send yet.');
  clubDb.ratings[clean(body.ticket)] = {
    club: t.club, name: t.name, fixtureId: t.fixtureId, away: t.away, division: t.division, date: t.date,
    stars, vibe, ticks, comment, at: new Date().toISOString(),
    reviewed: !comment && !Object.keys(ticks).length, // nothing for the admin to check
  };
  return saveClubs();
}

// What the club pages show: averages of every rating, facilities and comments once the admin has approved them.
function clubSummaries() {
  const out = {};
  const get = (slug) => (out[slug] ??= { n: 0, stars: {}, noKitchen: 0, vibe: { sum: 0, n: 0 }, facilities: {}, comments: [], summary: null });
  for (const r of Object.values(clubDb.ratings)) {
    const c = get(r.club);
    c.n++;
    for (const [k, v] of Object.entries(r.stars)) {
      if (k === 'kitchen' && v === 0) { c.noKitchen++; continue; }
      const s = (c.stars[k] ??= { sum: 0, n: 0 });
      s.sum += v; s.n++;
    }
    if (r.vibe) { c.vibe.sum += r.vibe; c.vibe.n++; }
    if (r.reviewed && r.comment) c.comments.push({ text: r.comment, at: r.at });
  }
  for (const [slug, facts] of Object.entries(clubDb.facts)) get(slug).facilities = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.value]));
  for (const [slug, x] of Object.entries(RESEARCH)) {
    get(slug).info = {
      address: x.address ?? null, website: x.website ?? null, facebook: x.facebook ?? null,
      notes: clubDb.research[slug] === 'approved' ? x.notes || null : null,
      // focus: which part of the photo the banner crop keeps (CSS object-position, e.g. "50% 80%").
      photo: x.photo ? { src: `club-photos/${slug}.jpg`, page: x.photo.page ?? null, focus: x.photo.focus ?? null } : null,
    };
  }
  for (const [slug, s] of Object.entries(clubDb.summaries)) get(slug).summary = s.text;
  for (const c of Object.values(out)) {
    c.comments = c.comments.sort((a, b) => b.at.localeCompare(a.at)).slice(0, COMMENTS_SHOWN).map((x) => ({ text: x.text, at: x.at.slice(0, 10) }));
    c.stars = Object.fromEntries(Object.entries(c.stars).map(([k, s]) => [k, { avg: +(s.sum / s.n).toFixed(2), n: s.n }]));
    c.vibe = c.vibe.n ? { avg: +(c.vibe.sum / c.vibe.n).toFixed(2), n: c.vibe.n } : null;
  }
  return out;
}

// One friendly line summing up a club's approved comments, written by Gemini (when it's set up).
async function summarise(slug) {
  if (!GEMINI_KEY) return;
  const comments = Object.values(clubDb.ratings).filter((r) => r.club === slug && r.reviewed && r.comment)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((r) => `- ${r.comment}`);
  if (!comments.length) { delete clubDb.summaries[slug]; return saveClubs(); }
  const prompt = `These are comments from visiting tennis league players about a tennis club in Cape Town.
Write ONE short, friendly line (at most 15 words) summing up what visitors say about the club's vibe and facilities.
Plain text, no quotes, no names of people, no emoji. Mention only what the comments say.

${comments.join('\n')}`;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4 } }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json().catch(() => ({}));
      const text = clean(body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')).replace(/^["“]|["”]$/g, '').slice(0, 160);
      if (res.ok && text) {
        clubDb.summaries[slug] = { text, at: new Date().toISOString(), n: comments.length };
        return saveClubs();
      }
    } catch (err) {
      console.error(`Summarising ${slug} with ${model} failed`, err.message);
    }
  }
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
  // Older fixtures without a result (postponed, or never entered) stay open; ones in the sheet close after a week.
  if (f.official && daysBetween(f.date, today) > SUBMIT_DAYS) throw new HttpError(400, 'This result is already in the results sheet.');
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
  // What was read from the photo, if anything: the game-by-game detail, and whether the captain changed the score.
  const reading = reads.get(clean(body.readId));
  const sheet = reading?.fixtureId === f.id
    ? { ...reading.sheet, edited: !reading.sheet.score || !sameScore(reading.sheet.score, score) }
    : null;

  // The other team submitting the same score counts as their confirmation; a different score is a dispute.
  if (prev && prev.side !== side) {
    if (sameScore(prev.score, score) && prev.status !== 'disputed') {
      prev.status = 'confirmed';
      prev.confirm = { name: who, side, at: now, photo, sheet };
    } else {
      prev.status = 'disputed';
      prev.disputes.push({ name: who, side, at: now, score, photo, sheet });
    }
    await save();
    return { status: prev.status, fixtureId: f.id, ...(side === 'away' ? rateTicket(f) : {}) };
  }

  // A new submission, or the same team correcting its own (which needs confirming again).
  const s = {
    fixtureId: f.id, division: f.division, home: f.home, away: f.away, date: f.date,
    status: 'pending', side, name: who, score, photo, sheet, createdAt: now,
    token: prev?.token ?? newToken(), confirm: null, disputes: [],
    history: prev ? [...prev.history, { name: prev.name, at: prev.createdAt, score: prev.score, photo: prev.photo, sheet: prev.sheet }] : [],
  };
  db[f.id] = s;
  await save();
  return { status: s.status, fixtureId: f.id, token: s.token, ...(side === 'away' ? rateTicket(f) : {}) };
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

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, submitDays: SUBMIT_DAYS, read: Boolean(GEMINI_KEY) });

  if (req.method === 'POST' && p === '/api/read') {
    if (!GEMINI_KEY) throw new HttpError(501, 'Reading photos is not set up.');
    rateLimit(req);
    const body = await readBody(req);
    const f = (await loadFixtures()).get(clean(body.fixtureId));
    if (!f) throw new HttpError(404, 'That fixture is not in the results sheet.');
    const { data, model, result } = await readSheet(f, body.photo);
    const id = crypto.randomBytes(8).toString('base64url');
    const now = Date.now();
    for (const [k, v] of reads) if (now - v.at > READ_TTL) reads.delete(k);
    reads.set(id, {
      fixtureId: f.id, at: now,
      sheet: { model, score: result.score, rubbers: result.rubbers, flipped: result.flipped, warnings: result.warnings, problems: result.problems, unclear: clean(data.unclear).slice(0, 300) || null },
    });
    return send(res, 200, { readId: id, score: result.score, problems: result.problems, warnings: result.warnings, rubbers: result.rubbers, flipped: result.flipped });
  }

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
    // The away captain can rate the home club they just played at.
    const f = side === 'away' ? (await loadFixtures().catch(() => new Map())).get(s.fixtureId) : null;
    return send(res, 200, { status: s.status, ...(f ? rateTicket(f) : {}) });
  }

  if (req.method === 'GET' && p === '/api/clubs') return send(res, 200, clubSummaries());

  if (req.method === 'POST' && p === '/api/ratings') {
    rateLimit(req);
    await rate(await readBody(req));
    return send(res, 200, { ok: true });
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

    // Ratings with a comment or facilities to check, newest first, with what's on record for those facilities.
    if (req.method === 'GET' && p === '/api/admin/ratings') {
      const current = (club, ticks) => Object.fromEntries(Object.keys(ticks).map((k) => [k, clubDb.facts[club]?.[k]?.value ?? null]));
      const list = Object.entries(clubDb.ratings).filter(([, x]) => !x.reviewed)
        .map(([id, x]) => ({ id, ...x, current: current(x.club, x.ticks) }))
        .sort((a, b) => b.at.localeCompare(a.at));
      // Researched facilities not yet decided, after the captains' ratings.
      for (const [slug, x] of Object.entries(RESEARCH)) {
        if (clubDb.research[slug] || (!Object.keys(x.facilities ?? {}).length && !x.notes)) continue;
        const ticks = Object.fromEntries(Object.entries(x.facilities ?? {}).map(([k, v]) => [k, v.value]));
        const sources = Object.fromEntries(Object.entries(x.facilities ?? {}).map(([k, v]) => [k, v.source]));
        list.push({ id: `research-${slug}`, research: true, club: slug, name: x.name, ticks, sources, notes: x.notes || '', current: current(slug, ticks) });
      }
      return send(res, 200, list);
    }

    // Approving shows the comment and records the facilities; removing deletes the whole rating.
    if (req.method === 'POST' && (r = m(/^\/api\/admin\/ratings\/research-([\w-]+)\/(approve|remove)$/))) {
      const slug = r[1];
      if (!RESEARCH[slug]) throw new HttpError(404, 'Not found.');
      clubDb.research[slug] = r[2] === 'approve' ? 'approved' : 'removed';
      if (r[2] === 'approve') {
        const facts = (clubDb.facts[slug] ??= {});
        for (const [k, v] of Object.entries(RESEARCH[slug].facilities ?? {})) {
          if (FACILITIES.includes(k) && typeof v.value === 'boolean' && !facts[k]) facts[k] = { value: v.value, at: new Date().toISOString(), source: v.source };
        }
      }
      await saveClubs();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (r = m(/^\/api\/admin\/ratings\/([\w-]+)\/(approve|remove)$/))) {
      const x = clubDb.ratings[r[1]];
      if (!x) throw new HttpError(404, 'Not found.');
      if (r[2] === 'approve') {
        x.reviewed = true;
        const facts = (clubDb.facts[x.club] ??= {});
        for (const [k, v] of Object.entries(x.ticks)) facts[k] = { value: v, at: x.at };
      } else {
        delete clubDb.ratings[r[1]];
      }
      await saveClubs();
      if (x.comment) summarise(x.club).catch((err) => console.error('Summary failed', err));
      return send(res, 200, { ok: true });
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
    // Club banner photos (club-photos/<club>.jpg), named in club-facts.json.
    const photo = /^\/club-photos\/([a-z0-9-]+)\.jpg$/.exec(url.pathname);
    if (photo && (req.method === 'GET' || req.method === 'HEAD')) {
      const data = await fs.promises.readFile(path.join(ROOT, 'club-photos', `${photo[1]}.jpg`)).catch(() => null);
      if (!data) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    const file = STATIC[url.pathname];
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const page = file[0] === 'index.html';
    const data = page ? await indexHTML() : await fs.promises.readFile(path.join(ROOT, file[0]));
    // The page is never reused from cache; fingerprinted files never change, so they can be kept.
    const cache = page ? 'no-store' : url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': cache });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`ct-tennis on http://localhost:${PORT}${ADMIN_KEY ? '' : ' (admin disabled: set ADMIN_KEY)'}`));
