'use strict';

// Live source: the "Results Entry" tab of the league's Google Sheet (must stay "anyone with the link can view").
const SHEET_ID = '1iVX-93u-ydRftXX9PsBV0Cq0Q77084ZvRKxAem9tDuE';
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Results Entry')}`;
const CACHE_KEY = 'ctt-results-v1';
const EDITS_KEY = 'ctt-my-results-v1';
const SCORE_KEY = 'ctt-score-view';
const REFRESH_MS = 5 * 60 * 1000;

const GROUPS = [
  { key: 'mens-singles', label: "Men's singles", gender: 'mens', format: 'singles' },
  { key: 'mens-doubles', label: "Men's doubles", gender: 'mens', format: 'doubles' },
  { key: 'ladies-singles', label: 'Ladies singles', gender: 'ladies', format: 'singles' },
  { key: 'ladies-doubles', label: 'Ladies doubles', gender: 'ladies', format: 'doubles' },
];

const VIEWS = ['standings', 'weekly', 'fixtures'];
const SUB_MODES = ['submit', 'confirm', 'admin']; // captains' result submissions, in submit.js

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const state = {
  rows: null, model: null, slug: null, view: 'standings', project: false, openTeam: null, fetchedAt: null,
  mode: 'leagues', clubs: new Map(), club: null, // "Clubs" view: all of one club's teams across leagues
  clubSort: { key: 'all', dir: -1 }, domWeights: [1],
  score: readPref(SCORE_KEY, ['matches', 'sets', 'points']) ?? 'matches',
  edits: readEdits(), // { fixtureId: { hm, am, hs, as } } — results entered on this device
  api: false, // true when served by server.js (salwood), which takes captains' submissions
  subs: {}, // { fixtureId: { hm, am, hs, as, status, side } } — submitted by captains, not yet in the sheet
};

const $ = (id) => document.getElementById(id);

// ---------- Parsing ----------

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

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function num(v) {
  const s = clean(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(s) {
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(clean(s));
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// "Mens Singles 8A" -> { group: 'mens-singles', label: '8A', order: 8.01 }
function classifyDivision(name) {
  const m = /^(mens|men's|men|ladies|womens|women's|women)\s+(premier|singles|doubles)\s*(.*)$/i.exec(name);
  if (!m) return { group: 'other', label: name, order: 999 };
  const gender = /^l|^w/i.test(m[1]) ? 'ladies' : 'mens';
  const kind = m[2].toLowerCase();
  const format = kind === 'doubles' ? 'doubles' : 'singles';
  if (kind === 'premier') return { group: `${gender}-${format}`, label: 'Premier', order: 0 };
  const tier = clean(m[3]) || '1';
  const t = /^(\d+)\s*([A-Za-z]?)$/.exec(tier);
  const order = t ? +t[1] + (t[2] ? (t[2].toUpperCase().charCodeAt(0) - 64) / 100 : 0) : 500;
  return { group: `${gender}-${format}`, label: tier, order };
}

// Result per the league rule: matches won, then sets won, otherwise a draw.
function outcome(f) {
  const a = f.homeMatches ?? 0, b = f.awayMatches ?? 0;
  if (a !== b) return a > b ? 'H' : 'A';
  const x = f.homeSets ?? 0, y = f.awaySets ?? 0;
  if (x !== y) return x > y ? 'H' : 'A';
  return 'D';
}

function buildModel(rows, edits = {}, subs = {}) {
  const divisions = new Map();
  const seen = new Set();

  for (const r of rows) {
    const id = clean(r['Fixture ID']);
    const division = clean(r['Division']);
    const home = clean(r['Home Team']);
    const away = clean(r['Away Team']);
    if (!id || !division || !home || !away) continue;

    const f = {
      id, division, home, away,
      date: parseDate(r['Date']),
      homeMatches: num(r['Home Matches Won']),
      awayMatches: num(r['Away Matches Won']),
      homeSets: num(r['Home Sets Won']),
      awaySets: num(r['Away Sets Won']),
      homePts: num(r['Home Final Pts']),
      awayPts: num(r['Away Final Pts']),
      status: clean(r['Status']),
      notes: clean(r['Notes']),
      doubles: /doubles/i.test(clean(r['Format']) || division),
    };
    // Status isn't always kept up to date, so a fixture counts as played once scores are in.
    f.played = (f.homeMatches !== null && f.awayMatches !== null) || (f.homePts !== null && f.awayPts !== null);
    if (f.played) {
      f.result = outcome(f);
      f.homePts ??= f.homeSets ?? 0;
      f.awayPts ??= f.awaySets ?? 0;
    } else if (subs[id] && subs[id].status !== 'disputed') {
      // A captain's submission counts until the official result reaches the sheet.
      const s = subs[id];
      Object.assign(f, { homeMatches: s.hm, awayMatches: s.am, homeSets: s.hs, awaySets: s.as, played: true, submitted: s.status, by: s.side });
      scoreFixture(f);
    } else if (edits[id]) {
      const e = edits[id];
      Object.assign(f, { homeMatches: e.hm, awayMatches: e.am, homeSets: e.hs, awaySets: e.as, played: true, local: true });
      scoreFixture(f);
    }
    seen.add(id);

    const slug = slugify(division);
    if (!divisions.has(slug)) {
      divisions.set(slug, { slug, name: division, ...classifyDivision(division), fixtures: [], teams: new Map() });
    }
    const d = divisions.get(slug);
    d.fixtures.push(f);
    for (const t of [home, away]) {
      if (!d.teams.has(t)) d.teams.set(t, { team: t, P: 0, W: 0, D: 0, L: 0, SF: 0, SA: 0, Pts: 0 });
    }
    if (f.played) {
      const h = d.teams.get(home), a = d.teams.get(away);
      tally(h, f.homeSets, f.awaySets, f.homePts, f.result === 'H' ? 'W' : f.result === 'A' ? 'L' : 'D');
      tally(a, f.awaySets, f.homeSets, f.awayPts, f.result === 'A' ? 'W' : f.result === 'H' ? 'L' : 'D');
    }
  }

  for (const d of divisions.values()) {
    d.fixtures.sort((x, y) => (x.date ?? 0) - (y.date ?? 0) || x.id.localeCompare(y.id));
    d.table = [...d.teams.values()].sort(byStanding);
    d.abbr = abbreviations([...d.teams.keys()]);
  }
  const edge = homeEdge([...divisions.values()].flatMap((d) => d.fixtures));
  for (const d of divisions.values()) d.homeEdge = edge;

  // Once the official result is in the sheet (or the fixture is gone), your own entry is dropped.
  const official = new Set([...divisions.values()].flatMap((d) => d.fixtures).filter((f) => f.played && !f.local && !f.submitted).map((f) => f.id));
  const stale = Object.keys(edits).filter((id) => official.has(id) || !seen.has(id));
  if (stale.length && seen.size) {
    for (const id of stale) delete edits[id];
    saveEdits(edits);
  }
  return divisions;
}

function byStanding(x, y) {
  return y.Pts - x.Pts || (y.SF - y.SA) - (x.SF - x.SA) || y.SF - x.SF || x.team.localeCompare(y.team);
}

function isDefault(f) {
  return /default/i.test(f.status) || /default/i.test(f.notes);
}

function splitTeam(name) {
  const m = /^(.*\S)\s+([LM][SD][A-Z])$/.exec(name);
  return m ? { club: m[1], code: m[2] } : { club: name, code: '' };
}

// Short club codes for one division: "Claremont" -> CLA, "Fish Hoek" -> FH, "CPUT" -> CPUT.
// Clubs with two teams in the same division get the team letter added ("PLU B").
function abbreviations(teams) {
  const short = (club, len) => {
    const words = club.split(' ');
    if (words.length > 1) return words.map((w) => w[0]).join('').toUpperCase();
    return /^[A-Z]{2,5}$/.test(club) ? club : club.slice(0, len).toUpperCase();
  };
  const clubs = new Map();
  for (const t of teams) {
    const { club } = splitTeam(t);
    clubs.set(club, (clubs.get(club) ?? 0) + 1);
  }
  const base = new Map();
  for (const club of clubs.keys()) {
    let len = 3, code = short(club, len);
    while ([...base.values()].includes(code) && len < club.length) code = short(club, ++len);
    base.set(club, code);
  }
  return new Map(teams.map((t) => {
    const { club, code } = splitTeam(t);
    return [t, clubs.get(club) > 1 && code ? `${base.get(club)} ${code.slice(-1)}` : base.get(club)];
  }));
}

function tally(t, sf, sa, pts, res) {
  t.P++;
  t[res]++;
  t.SF += sf ?? 0;
  t.SA += sa ?? 0;
  t.Pts += pts ?? 0;
}

// ---------- Projection ----------

// Scoring Rules tab: 1 point per set, plus a win bonus (singles 4, doubles 3) or 1 each for a draw.
const WIN_BONUS = { singles: 4, doubles: 3 };
const DRAW_BONUS = 1;
const PRIOR_SETS = 2; // each team starts as if it had split 2–2 in sets with an average side

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const isRated = (f) => f.played && !isDefault(f) && (f.homeSets ?? 0) + (f.awaySets ?? 0) > 0;

// Home advantage in log-odds of winning a set, measured across every league's results.
function homeEdge(fixtures) {
  let home = 1, away = 1;
  for (const f of fixtures) {
    if (!isRated(f)) continue;
    home += f.homeSets;
    away += f.awaySets;
  }
  return Math.log(home / away);
}

// Bradley–Terry strength from sets won, so beating strong sides counts for more. Defaults are ignored.
function ratings(d) {
  const r = new Map([...d.teams.keys()].map((t) => [t, 0]));
  const games = d.fixtures.filter(isRated);
  const edge = d.homeEdge ?? 0;
  for (let iter = 0; iter < 60; iter++) {
    for (const t of r.keys()) {
      const p0 = sigmoid(r.get(t));
      let grad = PRIOR_SETS - 2 * PRIOR_SETS * p0;
      let hess = 2 * PRIOR_SETS * p0 * (1 - p0);
      for (const f of games) {
        if (f.home !== t && f.away !== t) continue;
        const isHome = f.home === t;
        const won = isHome ? f.homeSets : f.awaySets;
        const n = f.homeSets + f.awaySets;
        const p = sigmoid(r.get(t) - r.get(isHome ? f.away : f.home) + (isHome ? edge : -edge));
        grad += won - n * p;
        hess += n * p * (1 - p);
      }
      r.set(t, r.get(t) + grad / hess);
    }
  }
  return r;
}

// Matches per fixture: whatever played fixtures in this division usually have (6 singles / 4 doubles).
function matchesPerFixture(d) {
  const counts = new Map();
  for (const f of d.fixtures) {
    if (!f.played || isDefault(f)) continue;
    const n = (f.homeMatches ?? 0) + (f.awayMatches ?? 0);
    if (n > 0) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : d.fixtures[0]?.doubles ? 4 : 6;
}

function binomial(n, k, p) {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * p ** k * (1 - p) ** (n - k);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Most likely scoreline for an unplayed fixture. Each match is best of three sets.
function projectFixture(f, r, n, edge = 0) {
  const p = sigmoid(r.get(f.home) - r.get(f.away) + edge);
  const pm = p * p * (3 - 2 * p);
  const homeMatches = Math.round(n * pm);
  const awayMatches = n - homeMatches;
  const homeSetsPerMatch = 2 * pm + 2 * p * (1 - p) ** 2;
  const awaySetsPerMatch = 2 * (1 - pm) + 2 * p * p * (1 - p);
  const homeSets = clamp(Math.round(n * homeSetsPerMatch), 2 * homeMatches, 2 * homeMatches + awayMatches);
  const awaySets = clamp(Math.round(n * awaySetsPerMatch), 2 * awayMatches, 2 * awayMatches + homeMatches);

  let homeWinChance = 0;
  for (let k = 0; k <= n; k++) {
    const pk = binomial(n, k, pm);
    homeWinChance += 2 * k > n ? pk : 2 * k === n ? pk / 2 : 0;
  }

  const pf = { ...f, homeMatches, awayMatches, homeSets, awaySets, played: true, projected: true, homeWinChance };
  return scoreFixture(pf);
}

// Result and league points from matches and sets won, per the Scoring Rules tab.
function scoreFixture(f) {
  f.result = outcome(f);
  const bonus = WIN_BONUS[f.doubles ? 'doubles' : 'singles'];
  f.homePts = f.homeSets + (f.result === 'H' ? bonus : f.result === 'D' ? DRAW_BONUS : 0);
  f.awayPts = f.awaySets + (f.result === 'A' ? bonus : f.result === 'D' ? DRAW_BONUS : 0);
  return f;
}

// Played results plus projected ones for everything left; cached per division until the next data load.
function projection(d) {
  if (d.projection) return d.projection;
  const r = ratings(d);
  const n = matchesPerFixture(d);
  const fixtures = new Map();
  const teams = new Map([...d.teams.values()].map((t) => [t.team, { ...t }]));
  for (const f of d.fixtures) {
    if (f.played) continue;
    const pf = projectFixture(f, r, n, d.homeEdge);
    fixtures.set(f.id, pf);
    tally(teams.get(f.home), pf.homeSets, pf.awaySets, pf.homePts, pf.result === 'H' ? 'W' : pf.result === 'A' ? 'L' : 'D');
    tally(teams.get(f.away), pf.awaySets, pf.homeSets, pf.awayPts, pf.result === 'A' ? 'W' : pf.result === 'H' ? 'L' : 'D');
  }
  d.projection = { fixtures, table: [...teams.values()].sort(byStanding) };
  return d.projection;
}

// ---------- Rendering ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Claremont LDA" -> "Claremont" + muted "LDA"
function teamLabel(name) {
  const { club, code } = splitTeam(name);
  return `<span class="team-name">${esc(club)}</span>${code ? `<span class="code">${esc(code)}</span>` : ''}`;
}

function fmtDate(d, long) {
  if (!d) return 'TBC';
  return d.toLocaleDateString('en-ZA', long ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' });
}

function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

// Captains' submissions: shown until the official result reaches the sheet.
const SUB_LABEL = { pending: 'Submitted', confirmed: 'Confirmed', approved: 'Approved' };

function subNote(f) {
  const by = splitTeam(f.by === 'away' ? f.away : f.home).club;
  return {
    pending: `Submitted by ${by}'s captain, awaiting the other team. Not in the results sheet yet.`,
    confirmed: 'Submitted and confirmed by both teams. Not in the results sheet yet.',
    approved: 'Approved by the league. Not in the results sheet yet.',
  }[f.submitted];
}

function subTag(f) {
  return f.submitted ? `<span class="tag sub" title="${esc(subNote(f))}">${SUB_LABEL[f.submitted]}</span>` : '';
}

function pendingTag(f) {
  if (/postpon/i.test(f.status)) return '<span class="tag">Postponed</span>';
  if (f.date && f.date < today()) return '<span class="tag">Result pending</span>';
  return '';
}

function renderNav() {
  const modeRow = `
    <div class="mode-row">
      <div class="mini-toggle" role="group" aria-label="Browse by">
        <button type="button" data-mode="leagues" aria-pressed="${state.mode === 'leagues'}">Leagues</button>
        <button type="button" data-mode="clubs" aria-pressed="${state.mode === 'clubs'}">Clubs</button>
        ${state.api ? `<button type="button" data-mode="submit" aria-pressed="${state.mode === 'submit'}">Submit a result</button>` : ''}
      </div>
    </div>`;

  if (SUB_MODES.includes(state.mode)) {
    $('divisions').innerHTML = modeRow;
    return;
  }

  if (state.mode === 'clubs') {
    $('divisions').innerHTML = modeRow + `
      <label class="club-pick">
        <span class="group-label">Club</span>
        <select id="club-select">
          <option value="">All clubs</option>
          ${[...state.clubs.values()].map((c) => `
            <option value="${c.slug}"${c.slug === state.club ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>`;
    return;
  }

  const divs = [...state.model.values()];
  const groups = GROUPS.map((g) => ({ ...g, divs: divs.filter((d) => d.group === g.key) }));
  const other = divs.filter((d) => !GROUPS.some((g) => g.key === d.group));
  if (other.length) groups.push({ key: 'other', label: 'Other', divs: other });

  $('divisions').innerHTML = modeRow + groups.filter((g) => g.divs.length).map((g) => `
    <div class="group" role="group" aria-label="${esc(g.label)}">
      <div class="group-label">${esc(g.label)}</div>
      <div class="group-buttons">
        ${g.divs.sort((a, b) => a.order - b.order).map((d) => `
          <button type="button" class="div-btn" data-slug="${d.slug}" aria-pressed="${d.slug === state.slug}"
            title="${esc(d.name)}">${esc(d.label)}</button>`).join('')}
      </div>
    </div>`).join('');
}

function renderPanel() {
  if (SUB_MODES.includes(state.mode)) {
    const { title, html } = subPanel(); // submit.js
    $('panel').hidden = false;
    $('division-title').textContent = title;
    document.querySelector('.tools').hidden = true;
    $('content').innerHTML = html;
    return;
  }

  if (state.mode === 'clubs') {
    const c = state.clubs.get(state.club);
    $('panel').hidden = false;
    $('division-title').textContent = c ? c.name : 'All clubs';
    document.querySelector('.tools').hidden = true;
    $('content').innerHTML = c ? localNote(contextFixtures()) + clubHTML(c) : clubsHTML();
    return;
  }

  const d = state.model.get(state.slug);
  $('panel').hidden = !d;
  if (!d) return;
  $('division-title').textContent = d.name;
  document.querySelector('.tools').hidden = false;
  for (const b of document.querySelectorAll('.toggle button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  }
  $('wand').hidden = state.view !== 'weekly';
  $('wand').setAttribute('aria-pressed', String(state.project));
  $('content').innerHTML = localNote(d.fixtures) + (state.view === 'fixtures' ? fixturesHTML(d)
    : state.view === 'weekly' ? weeklyHTML(d)
    : standingsHTML(d));
}

function localNote(fixtures) {
  const mine = fixtures.filter((f) => f.local).length;
  return mine
    ? `<p class="local-note">Includes ${mine === 1 ? 'a result' : `${mine} results`} you entered, saved only on this device.
        <button type="button" data-action="clear-local">Remove ${mine === 1 ? 'it' : 'them'}</button></p>`
    : '';
}

// Fixtures shown on the current page (one league, or every team of one club).
function contextFixtures() {
  if (state.mode === 'clubs') {
    const c = state.clubs.get(state.club);
    return c ? c.teams.flatMap((t) => t.d.fixtures.filter((f) => f.home === t.team || f.away === t.team)) : [];
  }
  return state.model.get(state.slug)?.fixtures ?? [];
}

function standingsHTML(d) {
  if (!d.table.length) return '<p class="empty">No teams yet.</p>';
  const rows = d.table.map((t, i) => {
    const diff = t.SF - t.SA;
    const open = t.team === state.openTeam;
    return `
      <tr class="team-row${open ? ' open' : ''}" data-team="${esc(t.team)}" tabindex="0" aria-expanded="${open}">
        <td class="pos">${i + 1}</td>
        <td class="team">${teamLabel(t.team)}<span class="chev" aria-hidden="true">›</span></td>
        <td>${t.P}</td><td>${t.W}</td><td>${t.D}</td><td>${t.L}</td>
        <td class="wide">${t.SF}</td><td class="wide">${t.SA}</td>
        <td class="${diff > 0 ? 'diff-pos' : diff < 0 ? 'diff-neg' : ''}">${diff > 0 ? '+' : ''}${diff}</td>
        <td class="pts">${t.Pts}</td>
      </tr>
      ${open ? `<tr class="team-detail"><td colspan="10">${teamFixturesHTML(d, t.team)}</td></tr>` : ''}`;
  }).join('');

  return `
    <table class="standings">
      <thead><tr>
        <th>#</th><th class="team">Team</th>
        <th title="Played">P</th><th title="Won">W</th><th title="Drawn">D</th><th title="Lost">L</th>
        <th class="wide" title="Sets for">SF</th><th class="wide" title="Sets against">SA</th>
        <th title="Sets difference">+/−</th><th title="League points">Pts</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Tap a team to see its results. Ranked on league points, then sets difference.</p>`;
}

function teamFixturesHTML(d, team) {
  const items = d.fixtures.filter((f) => f.home === team || f.away === team).map((f) => {
    const isHome = f.home === team;
    const opp = isHome ? f.away : f.home;
    let score, sub = '', mark = '';
    if (f.played) {
      const [m1, m2, s1, s2, p] = isHome
        ? [f.homeMatches, f.awayMatches, f.homeSets, f.awaySets, f.homePts]
        : [f.awayMatches, f.homeMatches, f.awaySets, f.homeSets, f.awayPts];
      const res = f.result === 'D' ? 'D' : (f.result === 'H') === isHome ? 'W' : 'L';
      score = `${m1 ?? '–'}–${m2 ?? '–'}`;
      sub = `sets ${s1 ?? 0}–${s2 ?? 0} · ${p} pts`;
      if (isDefault(f)) sub += ' <span class="tag alert">Default</span>';
      if (f.local) sub += ' <span class="tag mine">Your entry</span>';
      if (f.submitted) sub += ` ${subTag(f)}`;
      mark = `<span class="pill ${res}" title="${{ W: 'Won', D: 'Drew', L: 'Lost' }[res]}">${res}</span>`;
    } else {
      score = pendingTag(f);
    }
    return `
      <li class="tf${f.played ? '' : ' upcoming'}">
        <span class="tf-date">${fmtDate(f.date)}</span>
        <span class="ha" title="${isHome ? 'Home' : 'Away'}">${isHome ? 'H' : 'A'}</span>
        <span class="tf-opp">${teamLabel(opp)}${sub ? `<span class="fx-sub">${sub}</span>` : ''}</span>
        <span class="tf-score">${score}</span>
        <span>${mark}</span>
      </li>`;
  });
  const { club } = splitTeam(team);
  return `<ul class="tf-list">${items.join('') || '<li class="tf">No fixtures.</li>'}</ul>
    <a class="club-link" href="#/clubs/${slugify(club)}">All ${esc(club)} teams →</a>`;
}

// ---------- Clubs ----------

// Every club's teams across all leagues, with each team's current standing and dominance score.
function buildClubs(model) {
  const tier = divisionTiers(model);
  const weights = tierWeights(Math.max(0, ...tier.values()));
  const clubs = new Map();
  for (const d of model.values()) {
    const weight = weights[tier.get(d)];
    d.table.forEach((t, i) => {
      const { club, code } = splitTeam(t.team);
      const slug = slugify(club);
      if (!clubs.has(slug)) clubs.set(slug, { slug, name: club, teams: [] });
      clubs.get(slug).teams.push({ ...t, code, d, pos: i + 1, of: d.table.length, dom: 100 * pointsShare(d, t) * weight });
    });
  }
  const groupIndex = (d) => {
    const i = GROUPS.findIndex((g) => g.key === d.group);
    return i < 0 ? GROUPS.length : i;
  };
  for (const c of clubs.values()) {
    c.teams.sort((a, b) => groupIndex(a.d) - groupIndex(b.d) || a.d.order - b.d.order);
    c.dom = { all: 0 };
    for (const t of c.teams) {
      c.dom.all += t.dom;
      c.dom[t.d.group] = (c.dom[t.d.group] ?? 0) + t.dom;
    }
  }
  const byDom = [...clubs.values()].sort((a, b) => b.dom.all - a.dom.all);
  byDom.forEach((c, i) => { c.rank = i + 1; });
  state.domWeights = weights;
  return new Map([...clubs].sort((a, b) => a[1].name.localeCompare(b[1].name)));
}

// ---------- Dominance ----------
// A team's share of the league points it could have taken, weighted by how high its division is,
// so a weak team adds little wherever it plays and a strong one counts for more the higher it is.
// Divisions sit on one ladder, each overlapping the one above (more so lower down, where the gaps
// between divisions are smaller). A division's weight is the height of its middle on that ladder,
// squared: lower divisions still count, but many middling teams can't outweigh a few strong ones.

const DIVISION_OVERLAP = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6]; // top→2nd, 2nd→3rd, …; the last applies further down
const WEIGHT_CURVE = 2;

function pointsShare(d, t) {
  if (!t.P) return 0;
  const format = GROUPS.find((g) => g.key === d.group)?.format ?? (d.fixtures[0]?.doubles ? 'doubles' : 'singles');
  return t.Pts / (t.P * (2 * matchesPerFixture(d) + WIN_BONUS[format]));
}

// Weight per tier (0 = top division), from 1 at the top down to near 0 for the lowest tier there is.
function tierWeights(lowest) {
  const top = [0];
  for (let k = 1; k <= lowest; k++) top.push(top[k - 1] + 1 - DIVISION_OVERLAP[Math.min(k - 1, DIVISION_OVERLAP.length - 1)]);
  const length = top[lowest] + 1;
  const height = (k) => 1 - (top[k] + 0.5) / length;
  return top.map((_, k) => (height(k) / height(0)) ** WEIGHT_CURVE);
}

// Tier 0 is the top division of each competition; parallel divisions (2A, 2B) share a tier.
function divisionTiers(model) {
  const tiers = new Map();
  for (const g of new Set([...model.values()].map((d) => d.group))) {
    const divs = [...model.values()].filter((d) => d.group === g);
    const levels = [...new Set(divs.map((d) => Math.floor(d.order)))].sort((a, b) => a - b);
    for (const d of divs) tiers.set(d, levels.indexOf(Math.floor(d.order)));
  }
  return tiers;
}

function clubTotals(c) {
  const s = { P: 0, W: 0, D: 0, L: 0, top: 0 };
  for (const t of c.teams) {
    for (const k of ['P', 'W', 'D', 'L']) s[k] += t[k];
    if (t.pos === 1 && t.P > 0) s.top++;
  }
  return s;
}

// Sortable columns of the all-clubs table. Numbers sort high to low first; ties go to dominance, then name.
// A value of -1 means "nothing to show" (no teams in that competition, or nothing played yet).
const CLUB_COLUMNS = [
  { key: 'name', label: 'Club', title: 'Club name', value: (c) => c.name },
  { key: 'teams', label: 'Teams', title: 'Teams in the league', value: (c) => c.teams.length },
  { key: 'top', label: '1st', title: 'Teams currently top of their league', value: (c) => c.totals.top },
  { key: 'win', label: 'Win %', title: 'Share of fixtures won', value: (c) => (c.totals.P ? c.totals.W / c.totals.P : -1) },
  { key: 'all', label: 'All', title: 'Dominance across all competitions', value: (c) => c.dom.all, dom: true },
  ...GROUPS.map((g) => ({
    key: g.key,
    label: g.label.replace(/^(\w)\S*\s(\w).*$/, '$1$2').toUpperCase(),
    title: `Dominance in ${g.label.toLowerCase()}`,
    value: (c) => c.dom[g.key] ?? -1,
    dom: true,
  })),
];

function clubsHTML() {
  const { key, dir } = state.clubSort;
  const col = CLUB_COLUMNS.find((x) => x.key === key) ?? CLUB_COLUMNS[4];
  const clubs = [...state.clubs.values()].map((c) => ({ ...c, totals: clubTotals(c) }));
  clubs.sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    if ((x === -1) !== (y === -1)) return x === -1 ? 1 : -1; // no teams there: always last
    const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir * cmp || b.dom.all - a.dom.all || a.name.localeCompare(b.name);
  });

  const dom = (v) => (v === undefined ? '–' : Math.round(v));
  const rows = clubs.map((c, i) => {
    const s = c.totals;
    return `
      <tr class="team-row club-row" data-club="${c.slug}" tabindex="0">
        <td class="pos">${i + 1}</td>
        <td class="team"><span class="team-name">${esc(c.name)}</span><span class="chev" aria-hidden="true">›</span></td>
        <td>${c.teams.length}</td>
        <td class="${s.top ? 'top-pos' : ''}">${s.top || '–'}</td>
        <td>${s.P ? `${Math.round((100 * s.W) / s.P)}%` : '–'}</td>
        <td class="pts dom-start">${dom(c.dom.all)}</td>
        ${GROUPS.map((g) => `<td class="dom-sub">${dom(c.dom[g.key])}</td>`).join('')}
      </tr>`;
  }).join('');

  const head = CLUB_COLUMNS.map((x) => {
    const on = x.key === col.key;
    const sort = on ? (dir > 0 ? 'ascending' : 'descending') : 'none';
    const cls = [x.key === 'name' ? 'team' : '', x.key === 'all' ? 'dom-start' : ''].filter(Boolean).join(' ');
    return `<th${cls ? ` class="${cls}"` : ''} aria-sort="${sort}">
      <button type="button" class="sort${on ? ' on' : ''}" data-sort="${x.key}" title="${esc(x.title)}">${esc(x.label)}<span class="arrow" aria-hidden="true">${on ? (dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
  }).join('');

  return `
    <div class="scroll">
      <table class="standings clubs-table">
        <thead>
          <tr class="dom-band"><th colspan="5"></th><th colspan="${1 + GROUPS.length}" class="dom-start">Dominance</th></tr>
          <tr><th>#</th>${head}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">Tap a heading to sort, or a club to see all its teams. "1st" counts teams currently top of their league.</p>
    <p class="hint"><strong>Dominance</strong> adds up each team's share of the league points it could have won (a perfect
      record in a top division scores 100), weighted by division. Divisions overlap in strength, more so lower down
      (${DIVISION_OVERLAP.map((o) => `${Math.round(o * 100)}%`).join(', ')} going down), so the weights from the top are
      ${state.domWeights.map((w) => (w === 1 ? '1' : w.toFixed(2).replace(/^0/, ''))).join(' · ')}.</p>`;
}

function clubHTML(c) {
  const s = clubTotals(c);
  const now = today();
  let group = null;
  const rows = c.teams.map((t) => {
    const g = GROUPS.find((x) => x.key === t.d.group);
    const head = g && g.key !== group
      ? `<tr class="grp"><th colspan="9">${esc(g.label)}</th></tr>`
      : '';
    group = g?.key ?? group;

    const mine = t.d.fixtures.filter((f) => f.home === t.team || f.away === t.team);
    const form = mine.filter((f) => f.played).slice(-5).map((f) => {
      const isHome = f.home === t.team;
      const res = f.result === 'D' ? 'D' : (f.result === 'H') === isHome ? 'W' : 'L';
      const opp = isHome ? f.away : f.home;
      return `<span class="pill ${res}" title="${{ W: 'Won', D: 'Drew', L: 'Lost' }[res]} v ${esc(opp)}, ${fmtDate(f.date)}">${res}</span>`;
    }).join('');
    const next = mine.find((f) => !f.played && f.date && f.date >= now);
    const nextHTML = next
      ? (() => {
        const isHome = next.home === t.team;
        const opp = isHome ? next.away : next.home;
        return `<span title="${esc(opp)} (${isHome ? 'home' : 'away'})">${isHome ? 'v' : '@'} ${esc(t.d.abbr.get(opp) ?? opp)}</span> <small>${fmtDate(next.date)}</small>`;
      })()
      : '–';
    const league = t.d.label === 'Premier' ? 'Premier' : `Division ${t.d.label}`;

    return `${head}
      <tr class="team-row" data-goto="${t.d.slug}" data-team="${esc(t.team)}" tabindex="0" title="Open ${esc(t.d.name)}">
        <td class="team"><span class="team-name">${esc(league)}</span>${t.code ? `<span class="code">${esc(t.code)}</span>` : ''}<span class="chev" aria-hidden="true">›</span></td>
        <td class="${t.pos === 1 && t.P ? 'top-pos' : ''}">${ordinal(t.pos)} <small class="of">of ${t.of}</small></td>
        <td class="wide">${t.P}</td><td class="wide">${t.W}</td><td class="wide">${t.D}</td><td class="wide">${t.L}</td>
        <td class="pts">${t.Pts}</td>
        <td><span class="form">${form || '–'}</span></td>
        <td class="wide next">${nextHTML}</td>
      </tr>`;
  }).join('');

  return `
    <p class="club-summary">
      <strong>${c.teams.length}</strong> ${c.teams.length === 1 ? 'team' : 'teams'}
      · <strong>${s.top}</strong> top of their league
      · <strong>${s.W}</strong> won, <strong>${s.D}</strong> drawn, <strong>${s.L}</strong> lost
      · dominance <strong>${Math.round(c.dom.all)}</strong> (${ordinal(c.rank)} of ${state.clubs.size})
    </p>
    <table class="standings club-teams">
      <thead><tr>
        <th class="team">League</th><th>Position</th>
        <th class="wide" title="Played">P</th><th class="wide" title="Won">W</th>
        <th class="wide" title="Drawn">D</th><th class="wide" title="Lost">L</th>
        <th title="League points">Pts</th><th title="Last five results, oldest first">Form</th>
        <th class="wide">Next</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Tap a team to open its league. Form shows the last five results, oldest first.</p>`;
}

// Standings rows with one column per round: opponent code + match score, coloured by result.
// With the projection on, unplayed fixtures get a predicted score and rows are ordered by projected finish.
function weeklyHTML(d) {
  if (!d.table.length) return '<p class="empty">No teams yet.</p>';
  const proj = state.project ? projection(d) : null;
  const weeks = [...new Map(d.fixtures.map((f) => [f.date ? f.date.getTime() : 'tbc', f.date])).entries()];
  const head = weeks.map(([, date]) => `<th class="wk-head">${date ? fmtDate(date) : 'TBC'}</th>`).join('');
  const nowPos = new Map(d.table.map((t, i) => [t.team, i + 1]));

  const rows = (proj ? proj.table : d.table).map((t, i) => {
    const cells = weeks.map(([key]) => {
      const fx = d.fixtures.filter((f) => (f.date ? f.date.getTime() : 'tbc') === key && (f.home === t.team || f.away === t.team));
      return `<td class="wk">${fx.map((f) => weekCellHTML(d, proj?.fixtures.get(f.id) ?? f, t.team)).join('')}</td>`;
    }).join('');
    const move = proj ? nowPos.get(t.team) - (i + 1) : 0;
    const moveTag = move
      ? `<span class="move ${move > 0 ? 'up' : 'down'}" title="${move > 0 ? 'Up' : 'Down'} ${Math.abs(move)} from ${ordinal(nowPos.get(t.team))} now">${move > 0 ? '▲' : '▼'}${Math.abs(move)}</span>`
      : '';
    return `
      <tr>
        <td class="team"><span class="pos">${i + 1}${moveTag}</span><button type="button" class="fx-team" data-team="${esc(t.team)}">${teamLabel(t.team)}</button></td>
        ${cells}
        <td class="${proj ? 'now-pts' : 'pts'}">${d.teams.get(t.team).Pts}</td>
        ${proj ? `<td class="pts proj-pts">${t.Pts}</td>` : ''}
      </tr>`;
  }).join('');

  const hint = proj
    ? `Dashed tiles are projected. Each team is rated on sets won so far, weighted by how strong its opponents were (walkovers left out), with a small home advantage. Every remaining fixture gets its most likely score. Ranked by projected finish. Tap a dashed tile to try a different score.`
    : 'Each week shows the opponent and score. Tap an upcoming tile to enter a result you know, a team for its full results, or the wand to project the rest of the season.';

  const scoreToggle = `
    <div class="wk-bar">
      <div class="mini-toggle" role="group" aria-label="Score shown">
        ${['matches', 'sets', 'points'].map((s) => `<button type="button" data-score="${s}" aria-pressed="${state.score === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
      </div>
    </div>`;

  return `
    ${scoreToggle}
    <div class="scroll${proj ? ' projecting' : ''}">
      <table class="weekly">
        <thead><tr>
          <th class="team"><span class="pos">#</span>Team</th>${head}
          <th title="League points so far">Pts</th>
          ${proj ? '<th class="proj-pts" title="Projected final league points">Proj</th>' : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">${hint}</p>`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Official results are fixed; upcoming, projected and your own results open the score editor.
function weekCellHTML(d, f, team) {
  const isHome = f.home === team;
  const opp = isHome ? f.away : f.home;
  const code = esc(d.abbr.get(opp) ?? opp);
  const where = isHome ? 'home' : 'away';
  const editable = !f.played || f.projected || f.local;
  const tag = editable ? `button type="button" data-fixture="${esc(f.id)}" data-team="${esc(team)}"` : 'span';
  const close = editable ? 'button' : 'span';

  if (!f.played) {
    const pp = /postpon/i.test(f.status);
    const pending = !pp && f.date && f.date < today();
    const label = pp ? 'PP' : pending ? '?' : '';
    const tip = `${pp ? 'Postponed' : pending ? 'Result pending' : 'Upcoming'}: v ${opp} (${where}). Tap to enter a score.`;
    return `<${tag} class="chip up" title="${esc(tip)}"><b>${code}</b><span>${label || '&nbsp;'}</span></${close}>`;
  }

  const [m1, m2, s1, s2, p1, p2] = isHome
    ? [f.homeMatches, f.awayMatches, f.homeSets, f.awaySets, f.homePts, f.awayPts]
    : [f.awayMatches, f.homeMatches, f.awaySets, f.homeSets, f.awayPts, f.homePts];
  const res = f.result === 'D' ? 'D' : (f.result === 'H') === isHome ? 'W' : 'L';
  const shown = { matches: [m1, m2], sets: [s1, s2], points: [p1, p2] }[state.score];
  const detail = `${m1 ?? '–'}–${m2 ?? '–'} · sets ${s1 ?? 0}–${s2 ?? 0} · ${p1} pts`;
  let kind = '', tip;
  if (f.projected) {
    const chance = Math.round(100 * (isHome ? f.homeWinChance : 1 - f.homeWinChance));
    kind = ' proj';
    tip = `Projected ${{ W: 'win', D: 'draw', L: 'loss' }[res]} v ${opp} (${where}) · ${detail} · ${chance}% chance of winning. Tap to change.`;
  } else if (f.local) {
    kind = ' local';
    tip = `Your result: ${{ W: 'won', D: 'drew', L: 'lost' }[res]} v ${opp} (${where}) · ${detail}. Tap to change.`;
  } else if (f.submitted) {
    kind = ' sub';
    tip = `${{ W: 'Won', D: 'Drew', L: 'Lost' }[res]} v ${opp} (${where}) · ${detail}. ${subNote(f)}`;
  } else {
    tip = `${{ W: 'Won', D: 'Drew', L: 'Lost' }[res]} v ${opp} (${where}) · ${detail}`;
  }
  return `<${tag} class="chip${kind} ${res}" title="${esc(tip)}"><b>${code}</b><span>${shown[0] ?? '–'}–${shown[1] ?? '–'}</span></${close}>`;
}

function fixturesHTML(d) {
  if (!d.fixtures.length) return '<p class="empty">No fixtures yet.</p>';
  const rounds = new Map();
  for (const f of d.fixtures) {
    const key = f.date ? f.date.getTime() : 'tbc';
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key).push(f);
  }
  return [...rounds.values()].map((list) => `
    <section class="round">
      <h3>${fmtDate(list[0].date, true)}</h3>
      ${list.map(fixtureHTML).join('')}
    </section>`).join('');
}

function fixtureHTML(f) {
  const cls = (side) => !f.played || f.result === 'D' ? '' : f.result === side ? ' won' : ' lost';
  let mid;
  if (f.played) {
    mid = `<div class="fx-score">${f.homeMatches ?? '–'} – ${f.awayMatches ?? '–'}</div>
      <div class="fx-sub">sets ${f.homeSets ?? 0}–${f.awaySets ?? 0}</div>
      <div class="fx-sub">pts ${f.homePts}–${f.awayPts}</div>`;
  } else {
    mid = `<div class="fx-vs">vs</div>${pendingTag(f)}`;
  }
  const defaulted = f.played && isDefault(f);
  const note = [
    defaulted ? '<span class="tag alert">Default</span>' : '',
    f.local ? '<span class="tag mine">Your entry</span>' : '',
    subTag(f),
    f.notes ? esc(f.notes) : '',
  ]
    .filter(Boolean).join(' ');
  return `
    <div class="fx">
      <button type="button" class="fx-team home${cls('H')}" data-team="${esc(f.home)}">${teamLabel(f.home)}</button>
      <div class="fx-mid">${mid}</div>
      <button type="button" class="fx-team away${cls('A')}" data-team="${esc(f.away)}">${teamLabel(f.away)}</button>
      ${note ? `<div class="fx-note">${note}</div>` : ''}
    </div>`;
}

// ---------- Score editor ----------

// The editor reads from the side of the team whose row was tapped ("left"), like the tile did.
// You pick the match score; sets start at straight sets and can only move within what's possible.
// Scores are converted back to home/away when saved.
// With `submit`, it's a captain entering a result for submission rather than a score kept on this device.
const editor = { f: null, n: 6, flip: false, lm: null, ls: 0, rs: 0, submit: false };

const club = (team) => splitTeam(team).club;

function editorTeams() {
  const { f, flip } = editor;
  return flip ? [f.away, f.home] : [f.home, f.away];
}

// Each match is best of three: the winner takes 2 sets, the loser 0 or 1.
// So a team has 2 sets per match won, plus at most 1 per match lost.
function setsRange(won, lost) {
  return [2 * won, 2 * won + lost];
}

// `start` reopens a score already entered: { hm, am, hs, as } (home/away).
function openEditor(id, team, { d = state.model.get(state.slug), submit = false, start = null } = {}) {
  const f = d?.fixtures.find((x) => x.id === id);
  if (!f) return;
  const n = matchesPerFixture(d);
  const flip = team === f.away;
  Object.assign(editor, { f, n, flip, lm: null, ls: 0, rs: 0, submit });
  start ??= f.local && !submit ? { hm: f.homeMatches, am: f.awayMatches, hs: f.homeSets, as: f.awaySets } : null;
  if (start) {
    // Reopen the score as it was (pulled into range if it was saved by an older version).
    editor.lm = clamp(flip ? start.am : start.hm, 0, n);
    editor.ls = clamp(flip ? start.as : start.hs, ...setsRange(editor.lm, n - editor.lm));
    editor.rs = clamp(flip ? start.hs : start.as, ...setsRange(n - editor.lm, editor.lm));
  }

  const [left, right] = editorTeams();
  const p = f.local || submit ? null : projection(d).fixtures.get(id);
  $('ed-hint').textContent = p
    ? `Projected: ${club(left)} ${flip ? p.awayMatches : p.homeMatches}–${flip ? p.homeMatches : p.awayMatches}`
    : '';
  $('ed-title').textContent = submit ? 'Enter the result' : f.local ? 'Change your score' : 'Enter a score';
  $('ed-sub').textContent = `${d.name} · ${fmtDate(f.date, true)} · ${club(f.home)} at home`;
  $('ed-left').innerHTML = teamLabel(left);
  $('ed-right').innerHTML = teamLabel(right);
  $('ed-m-order').textContent = `(${club(left)} – ${club(right)})`;
  $('ed-remove').hidden = !f.local || submit;
  $('ed-note').textContent = submit
    ? 'Check it against the signed score sheet.'
    : "Saved on this device only. The official result replaces it once it's in the results sheet.";
  $('ed-save').textContent = submit ? 'Next' : 'Save';
  $('ed-matches').innerHTML = Array.from({ length: n + 1 }, (_, i) => n - i)
    .map((k) => `<button type="button" data-lm="${k}" aria-label="${esc(club(left))} ${k}, ${esc(club(right))} ${n - k}">${k}–${n - k}</button>`)
    .join('');
  syncEditor();
  $('editor').showModal();
}

function editorResult() {
  const { f, n, flip, lm, ls, rs } = editor;
  return scoreFixture({
    homeMatches: flip ? n - lm : lm, awayMatches: flip ? lm : n - lm,
    homeSets: flip ? rs : ls, awaySets: flip ? ls : rs, doubles: f.doubles,
  });
}

function syncEditor() {
  const { n, flip, lm, ls, rs } = editor;
  for (const b of $('ed-matches').children) b.setAttribute('aria-pressed', String(+b.dataset.lm === lm));
  const picked = lm !== null;
  $('ed-score').hidden = !picked;
  $('ed-save').disabled = !picked;
  if (!picked) {
    $('ed-preview').textContent = 'Pick the match score to see sets and points.';
    return;
  }

  const rm = n - lm;
  const r = editorResult();
  const [lp, rp] = flip ? [r.awayPts, r.homePts] : [r.homePts, r.awayPts];
  const [left, right] = editorTeams();
  const row = (team, key, sets, [min, max], pts) => `
    <tr>
      <th scope="row">${esc(club(team))}</th>
      <td>
        <span class="stepper">
          <button type="button" data-step="${key}" data-by="-1" ${sets <= min ? 'disabled' : ''} aria-label="One set fewer for ${esc(club(team))}">−</button>
          <output aria-live="polite">${sets}</output>
          <button type="button" data-step="${key}" data-by="1" ${sets >= max ? 'disabled' : ''} aria-label="One set more for ${esc(club(team))}">+</button>
        </span>
        <small>${min === max ? 'fixed' : `${min}–${max}`}</small>
      </td>
      <td class="bonus">${pts - sets ? `+${pts - sets}` : '–'}</td>
      <td class="total">${pts}</td>
    </tr>`;
  $('ed-rows').innerHTML =
    row(left, 'ls', ls, setsRange(lm, rm), lp) +
    row(right, 'rs', rs, setsRange(rm, lm), rp);

  const who = r.result === 'D' ? 'Draw' : `${club((r.result === 'H') !== flip ? left : right)} win`;
  $('ed-preview').innerHTML = `${esc(who)} · <strong>${esc(club(left))} ${lp} – ${rp} ${esc(club(right))}</strong> league points`;
}

$('ed-matches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lm]');
  if (!b) return;
  const lm = +b.dataset.lm;
  // A new match score resets the sets to straight sets.
  Object.assign(editor, { lm, ls: 2 * lm, rs: 2 * (editor.n - lm) });
  syncEditor();
});

$('ed-rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  const { n, lm } = editor;
  const key = b.dataset.step;
  const [min, max] = key === 'ls' ? setsRange(lm, n - lm) : setsRange(n - lm, lm);
  editor[key] = clamp(editor[key] + Number(b.dataset.by), min, max);
  syncEditor();
});

$('ed-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { f, n, flip, lm, ls, rs } = editor;
  if (lm === null) return;
  const hm = flip ? n - lm : lm;
  const score = { hm, am: n - hm, hs: flip ? rs : ls, as: flip ? ls : rs };
  $('editor').close();
  if (editor.submit) return scoreEntered(f, score); // submit.js
  state.edits[f.id] = score;
  rebuild();
});

$('ed-remove').addEventListener('click', () => {
  delete state.edits[editor.f.id];
  $('editor').close();
  rebuild();
});

$('ed-cancel').addEventListener('click', () => $('editor').close());

// Close when tapping the dimmed backdrop.
$('editor').addEventListener('click', (e) => {
  if (e.target === $('editor')) $('editor').close();
});

function renderStatus(error) {
  const el = $('status');
  el.classList.toggle('warn', Boolean(error));
  const when = state.fetchedAt
    ? new Date(state.fetchedAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  if (error && !state.model) {
    el.innerHTML = `Couldn't load results. <button type="button" data-action="refresh">Try again</button>`;
  } else if (error) {
    el.innerHTML = `Couldn't refresh – showing results from ${when}. <button type="button" data-action="refresh">Retry</button>`;
  } else {
    el.innerHTML = `Live results · updated ${when} · <button type="button" data-action="refresh">Refresh</button>`;
  }
}

function render() {
  renderNav();
  renderPanel();
}

// ---------- State & routing ----------

function defaultSlug() {
  const divs = [...state.model.values()].filter((d) => d.group === GROUPS[0].key).sort((a, b) => a.order - b.order);
  return (divs[0] || state.model.values().next().value)?.slug ?? null;
}

// Routes: #/<league>[/weekly[/projected]|/fixtures], #/clubs, #/clubs/<club>,
// #/submit, #/confirm/<fixture>/<link code>, #/admin
function readHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'clubs') return { mode: 'clubs', club: parts[1] || null };
  if (SUB_MODES.includes(parts[0])) return { mode: parts[0], id: parts[1] || null, token: parts[2] || null };
  const [slug, view, extra] = parts;
  return { mode: 'leagues', slug: slug || null, view: VIEWS.includes(view) ? view : 'standings', project: extra === 'projected' };
}

function writeHash() {
  let hash;
  if (SUB_MODES.includes(state.mode)) {
    hash = subHash(); // submit.js
  } else if (state.mode === 'clubs') {
    hash = `#/clubs${state.club ? `/${state.club}` : ''}`;
  } else {
    const view = state.view === 'standings' ? '' : `/${state.view}`;
    hash = `#/${state.slug}${view}${state.view === 'weekly' && state.project ? '/projected' : ''}`;
  }
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function applyHash() {
  if (!state.model) return;
  const h = readHash();
  if (SUB_MODES.includes(h.mode)) {
    state.mode = h.mode;
    state.slug ??= defaultSlug();
    enterSubMode(h); // submit.js
    writeHash();
    render();
    return;
  }
  if (h.mode === 'clubs') {
    state.mode = 'clubs';
    state.club = state.clubs.has(h.club) ? h.club : null;
    state.slug ??= defaultSlug();
    writeHash();
    render();
    return;
  }
  state.mode = 'leagues';
  if (h.slug !== state.slug) state.openTeam = null;
  state.slug = state.model.has(h.slug) ? h.slug : defaultSlug();
  state.view = h.view;
  if (h.view === 'weekly') state.project = h.project;
  writeHash();
  render();
}

function select(slug, view) {
  if (slug !== state.slug) state.openTeam = null;
  state.mode = 'leagues';
  state.slug = slug;
  state.view = view ?? state.view;
  writeHash();
  render();
}

function selectClub(slug) {
  state.mode = 'clubs';
  state.club = state.clubs.has(slug) ? slug : null;
  writeHash();
  render();
}

// From a club page to a team's league standings, with that team's results open.
function openTeamInLeague(slug, team) {
  state.mode = 'leagues';
  state.slug = slug;
  state.view = 'standings';
  state.openTeam = team;
  writeHash();
  render();
  document.querySelector('.team-row.open')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- Data ----------

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && typeof c.csv === 'string') return c;
  } catch { /* storage unavailable */ }
  return null;
}

function saveCache(csv, at) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ csv, at })); } catch { /* storage unavailable */ }
}

function readPref(key, allowed) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : null;
  } catch { return null; }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function readEdits() {
  try {
    const e = JSON.parse(localStorage.getItem(EDITS_KEY));
    return e && typeof e === 'object' ? e : {};
  } catch { return {}; }
}

function saveEdits(edits) {
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(edits)); } catch { /* storage unavailable */ }
}

function useCSV(csv, at) {
  state.rows = parseCSV(csv);
  state.model = buildModel(state.rows, state.edits, state.subs);
  state.clubs = buildClubs(state.model);
  state.fetchedAt = at;
}

// Re-run the standings after one of your own results (or a captain's submission) changes.
function rebuild() {
  saveEdits(state.edits);
  if (!state.rows) return;
  state.model = buildModel(state.rows, state.edits, state.subs);
  state.clubs = buildClubs(state.model);
  render();
}

let loading = false;

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch(RESULTS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    if (!/Fixture ID/i.test(csv.slice(0, 500))) throw new Error('Unexpected response');
    const at = Date.now();
    await loadSubmissions(); // submit.js
    useCSV(csv, at);
    saveCache(csv, at);
    renderStatus();
    applyHash();
  } catch (err) {
    console.error(err);
    renderStatus(err);
  } finally {
    loading = false;
  }
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.div-btn');
  if (btn) return select(btn.dataset.slug);

  const tab = e.target.closest('.toggle button');
  if (tab) return select(state.slug, tab.dataset.view);

  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) {
    const mode = modeBtn.dataset.mode;
    if (mode === 'submit') return void (location.hash = '#/submit');
    return mode === 'clubs' ? selectClub(state.club) : select(state.slug ?? defaultSlug());
  }

  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    const dir = state.clubSort.key === key ? -state.clubSort.dir : key === 'name' ? 1 : -1;
    state.clubSort = { key, dir };
    return renderPanel();
  }

  const clubRow = e.target.closest('.club-row');
  if (clubRow) return selectClub(clubRow.dataset.club);

  const goto = e.target.closest('[data-goto]');
  if (goto) return openTeamInLeague(goto.dataset.goto, goto.dataset.team);

  if (e.target.closest('#wand')) {
    state.project = !state.project;
    writeHash();
    return renderPanel();
  }

  const scoreBtn = e.target.closest('[data-score]');
  if (scoreBtn) {
    state.score = scoreBtn.dataset.score;
    savePref(SCORE_KEY, state.score);
    return renderPanel();
  }

  const tile = e.target.closest('.chip[data-fixture]');
  if (tile) return openEditor(tile.dataset.fixture, tile.dataset.team);

  if (e.target.closest('[data-action="clear-local"]')) {
    for (const f of contextFixtures()) if (f.local) delete state.edits[f.id];
    return rebuild();
  }

  const fxTeam = e.target.closest('.fx-team');
  if (fxTeam) {
    state.openTeam = fxTeam.dataset.team;
    select(state.slug, 'standings');
    document.querySelector('.team-row.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  const row = e.target.closest('.team-row');
  if (row) {
    state.openTeam = state.openTeam === row.dataset.team ? null : row.dataset.team;
    renderPanel();
    document.querySelector(`.team-row[data-team="${CSS.escape(row.dataset.team)}"]`)?.focus({ preventScroll: true });
    return;
  }

  if (e.target.closest('[data-action="refresh"]')) refresh();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'club-select') selectClub(e.target.value || null);
});

document.addEventListener('keydown', (e) => {
  const row = e.target.closest?.('.team-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    row.click();
  }
});

window.addEventListener('hashchange', applyHash);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - (state.fetchedAt ?? 0) > REFRESH_MS) refresh();
});

setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);

// ---------- Boot ----------

const cached = loadCache();
if (cached) {
  useCSV(cached.csv, cached.at);
  renderStatus();
  applyHash();
}
refresh();
