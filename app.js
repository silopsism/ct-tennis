'use strict';

// Live source: the "Results Entry" tab of the league's Google Sheet (must stay "anyone with the link can view").
const SHEET_ID = '1iVX-93u-ydRftXX9PsBV0Cq0Q77084ZvRKxAem9tDuE';
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Results Entry')}`;
const CACHE_KEY = 'ctt-results-v1';
const REFRESH_MS = 5 * 60 * 1000;

const GROUPS = [
  { key: 'mens-singles', label: "Men's singles", gender: 'mens', format: 'singles' },
  { key: 'mens-doubles', label: "Men's doubles", gender: 'mens', format: 'doubles' },
  { key: 'ladies-singles', label: 'Ladies singles', gender: 'ladies', format: 'singles' },
  { key: 'ladies-doubles', label: 'Ladies doubles', gender: 'ladies', format: 'doubles' },
];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const state = { model: null, slug: null, view: 'standings', openTeam: null, fetchedAt: null };

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

function buildModel(rows) {
  const divisions = new Map();

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
    };
    // Status isn't always kept up to date, so a fixture counts as played once scores are in.
    f.played = (f.homeMatches !== null && f.awayMatches !== null) || (f.homePts !== null && f.awayPts !== null);
    if (f.played) {
      f.result = outcome(f);
      f.homePts ??= f.homeSets ?? 0;
      f.awayPts ??= f.awaySets ?? 0;
    }

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
    d.table = [...d.teams.values()].sort((x, y) =>
      y.Pts - x.Pts || (y.SF - y.SA) - (x.SF - x.SA) || y.SF - x.SF || x.team.localeCompare(y.team));
  }
  return divisions;
}

function tally(t, sf, sa, pts, res) {
  t.P++;
  t[res]++;
  t.SF += sf ?? 0;
  t.SA += sa ?? 0;
  t.Pts += pts ?? 0;
}

// ---------- Rendering ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Claremont LDA" -> "Claremont" + muted "LDA"
function teamLabel(name) {
  const m = /^(.*\S)\s+([LM][SD][A-Z])$/.exec(name);
  return m
    ? `<span class="team-name">${esc(m[1])}</span><span class="code">${esc(m[2])}</span>`
    : `<span class="team-name">${esc(name)}</span>`;
}

function fmtDate(d, long) {
  if (!d) return 'TBC';
  return d.toLocaleDateString('en-ZA', long ? { weekday: 'short', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' });
}

function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function pendingTag(f) {
  if (/postpon/i.test(f.status)) return '<span class="tag">Postponed</span>';
  if (f.date && f.date < today()) return '<span class="tag">Result pending</span>';
  return '';
}

function renderNav() {
  const divs = [...state.model.values()];
  const groups = GROUPS.map((g) => ({ ...g, divs: divs.filter((d) => d.group === g.key) }));
  const other = divs.filter((d) => !GROUPS.some((g) => g.key === d.group));
  if (other.length) groups.push({ key: 'other', label: 'Other', divs: other });

  $('divisions').innerHTML = groups.filter((g) => g.divs.length).map((g) => `
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
  const d = state.model.get(state.slug);
  $('panel').hidden = !d;
  if (!d) return;
  $('division-title').textContent = d.name;
  for (const b of document.querySelectorAll('.toggle button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  }
  $('content').innerHTML = state.view === 'fixtures' ? fixturesHTML(d) : standingsHTML(d);
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
      if (/default/i.test(f.status) || /default/i.test(f.notes)) sub += ' <span class="tag alert">Default</span>';
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
  return `<ul class="tf-list">${items.join('') || '<li class="tf">No fixtures.</li>'}</ul>`;
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
  const defaulted = f.played && (/default/i.test(f.status) || /default/i.test(f.notes));
  const note = [defaulted ? '<span class="tag alert">Default</span>' : '', f.notes ? esc(f.notes) : '']
    .filter(Boolean).join(' ');
  return `
    <div class="fx">
      <button type="button" class="fx-team home${cls('H')}" data-team="${esc(f.home)}">${teamLabel(f.home)}</button>
      <div class="fx-mid">${mid}</div>
      <button type="button" class="fx-team away${cls('A')}" data-team="${esc(f.away)}">${teamLabel(f.away)}</button>
      ${note ? `<div class="fx-note">${note}</div>` : ''}
    </div>`;
}

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

function readHash() {
  const [slug, view] = location.hash.replace(/^#\/?/, '').split('/');
  return { slug: slug || null, view: view === 'fixtures' ? 'fixtures' : 'standings' };
}

function writeHash() {
  const hash = `#/${state.slug}${state.view === 'fixtures' ? '/fixtures' : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function applyHash() {
  if (!state.model) return;
  const h = readHash();
  if (h.slug !== state.slug) state.openTeam = null;
  state.slug = state.model.has(h.slug) ? h.slug : defaultSlug();
  state.view = h.view;
  writeHash();
  render();
}

function select(slug, view) {
  if (slug !== state.slug) state.openTeam = null;
  state.slug = slug;
  state.view = view ?? state.view;
  writeHash();
  render();
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

function useCSV(csv, at) {
  state.model = buildModel(parseCSV(csv));
  state.fetchedAt = at;
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
