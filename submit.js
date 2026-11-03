'use strict';

// Captains' result submissions (only when the site is served by server.js, i.e. on salwood):
//  - #/submit: pick your team, then the fixture, enter the score with the score editor, add a photo
//    of the signed sheet, then send the other captain a link to confirm.
//  - #/confirm/<fixture>/<link code>: the other captain checks the score and photo, and confirms or disputes it.
//  - #/admin: the league admin approves submissions (needs the ADMIN_KEY set on the server).
// Loaded before app.js and only called from it, so nothing here runs app.js code at load time.

const TEAM_KEY = 'ctt-my-team';
const NAME_KEY = 'ctt-captain-name';
const ADMIN_STORE = 'ctt-admin-key';
const SUBMIT_DAYS = 7; // same as SUBMIT_DAYS in server.js
const PHOTO_EDGE = 2000; // longest side of the uploaded photo, in pixels

const sub = {
  route: null, // route last entered, so the 5-minute data refresh doesn't reset the page
  team: lsGet(TEAM_KEY), // "Claremont MSB"
  pickClub: null, // club slug while choosing a team
  fixture: null, // fixture id
  score: null, // { hm, am, hs, as }
  photo: null, // shrunk photo as a data URL
  name: lsGet(NAME_KEY) ?? '',
  busy: false,
  error: '',
  done: null, // the server's reply once submitted
  confirm: null, // { id, token, data, error, disputing, note, busy }
  admin: { list: null, error: '', busy: false },
};

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

async function api(path, { method = 'GET', body, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers['X-Admin-Key'] = lsGet(ADMIN_STORE) ?? '';
  const res = await fetch(path, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
  return data;
}

// Submissions shown on the site. Without the server (GitHub Pages) there are none, and no Submit button.
async function loadSubmissions() {
  try {
    const list = await api('/api/submissions');
    state.api = true;
    state.subs = Object.fromEntries(list.map((s) => [s.fixtureId, s]));
  } catch {
    state.api = false;
    state.subs = {};
  }
}

// ---------- Routing (called from app.js) ----------

function enterSubMode(h) {
  const route = `${h.mode}/${h.id}/${h.token}`;
  if (sub.route === route) return;
  sub.route = route;
  if (h.mode === 'submit' && sub.done) Object.assign(sub, { fixture: null, score: null, photo: null, done: null, error: '' });
  if (h.mode === 'confirm') {
    sub.confirm = { id: h.id, token: h.token, data: null, error: '', disputing: false, note: '', busy: false };
    loadConfirm();
  }
  if (h.mode === 'admin') loadAdmin();
}

// Leaving these pages lets the next visit start again.
window.addEventListener('hashchange', () => {
  if (!/^#\/(submit|confirm|admin)\b/.test(location.hash)) sub.route = null;
});

function subHash() {
  if (state.mode === 'confirm') return `#/confirm/${sub.confirm?.id ?? ''}/${sub.confirm?.token ?? ''}`;
  return `#/${state.mode}`;
}

function subPanel() {
  if (state.mode === 'confirm') return { title: 'Confirm a result', html: confirmHTML() };
  if (state.mode === 'admin') return { title: 'Submitted results', html: adminHTML() };
  return { title: 'Submit a result', html: submitHTML() };
}

// ---------- Helpers ----------

const fixtureDivision = (id) => [...state.model.values()].find((d) => d.fixtures.some((f) => f.id === id));
const findFixture = (id) => fixtureDivision(id)?.fixtures.find((f) => f.id === id);
const teamDivision = (team) => [...state.model.values()].find((d) => d.teams.has(team));
const teamName = (team) => {
  const { club: c, code } = splitTeam(team);
  return `${c} ${code.slice(-1)}`.trim(); // "Claremont MSB" -> "Claremont B", as on the score sheet
};
const leagueName = (d) => d.name.replace(/^Mens/, "Men's");
const daysAgo = (date) => Math.round((today() - date) / 86400000);

function scoreLine(f, s) {
  const r = scoreFixture({ ...s, homeMatches: s.hm, awayMatches: s.am, homeSets: s.hs, awaySets: s.as, doubles: f.doubles });
  return `<strong>${esc(teamName(f.home))} ${s.hm}–${s.am} ${esc(teamName(f.away))}</strong>
    <span class="s-detail">sets ${s.hs}–${s.as} · points ${r.homePts}–${r.awayPts}</span>`;
}

const STEPS = ['Your team', 'Fixture', 'Score', 'Photo of the score sheet', 'Send'];

function stepHTML(n, title, body, done) {
  return `<section class="s-step${done ? ' done' : ''}"><h3><span class="s-num">${done ? '✓' : n}</span>${title}</h3>${body}</section>`;
}

// The steps still to come, greyed out, so it's clear what happens next.
function laterSteps(from) {
  return STEPS.slice(from - 1).map((title, i) => `
    <section class="s-step later" aria-hidden="true"><h3><span class="s-num">${from + i}</span>${title}</h3></section>`).join('');
}

// ---------- Submit ----------

function submitHTML() {
  if (!state.api) return '<p class="empty">Results can be submitted on ctt.salwood.co.za.</p>';
  if (sub.done) return doneHTML();

  const team = sub.team && teamDivision(sub.team) ? sub.team : null;
  const parts = [];

  // 1. Your team
  if (!team || sub.pickClub !== null) {
    const clubs = [...state.clubs.values()];
    const picked = state.clubs.get(sub.pickClub ?? '') ?? (team ? state.clubs.get(slugify(splitTeam(team).club)) : null);
    parts.push(stepHTML(1, 'Your team', `
      <label class="s-field"><span>Club</span>
        <select id="s-club">
          <option value="">Choose your club</option>
          ${clubs.map((c) => `<option value="${c.slug}"${c === picked ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      ${picked ? `<p class="s-prompt">Tap your team:</p>
        <div class="s-list">${picked.teams.map((t) => `
        <button type="button" class="s-item" data-s="team" data-team="${esc(t.team)}">
          <span>${esc(leagueName(t.d))}</span><span class="s-status">${esc(t.code)}<span class="chev" aria-hidden="true">›</span></span>
        </button>`).join('')}</div>` : ''}`));
    return parts.join('') + laterSteps(2);
  }

  // Clear starts again from step 1, forgetting the team, fixture, score and photo.
  const clear = '<button type="button" class="ed-btn" data-s="clear">Clear</button>';
  const foot = `<div class="s-foot">${clear}</div>`;

  const d = teamDivision(team);
  parts.push(stepHTML(1, 'Your team', `
    <p class="s-line">${teamLabel(team)} · ${esc(leagueName(d))}
      <button type="button" class="s-link" data-s="change-team">Change</button></p>`, true));

  // 2. Fixture: this team's fixtures from the last few days
  const now = today();
  const recent = d.fixtures.filter((f) => (f.home === team || f.away === team) && f.date && f.date <= now && daysAgo(f.date) <= SUBMIT_DAYS);
  if (recent.length === 1) sub.fixture = recent[0].id; // usually there's just this week's: no need to pick it
  const f = sub.fixture && recent.find((x) => x.id === sub.fixture);
  if (!f) {
    const next = d.fixtures.find((x) => (x.home === team || x.away === team) && x.date && x.date > now);
    parts.push(stepHTML(2, 'Fixture', recent.length
      ? `<p class="s-prompt">Which fixture are you submitting?</p>
        <div class="s-list">${recent.slice().reverse().map((x) => {
        const home = x.home === team;
        const status = x.submitted ? SUB_LABEL[x.submitted] : x.played && !x.local ? 'In the results sheet' : 'Not submitted yet';
        return `
          <button type="button" class="s-item" data-s="fixture" data-id="${esc(x.id)}">
            <span>${fmtDate(x.date, true)} · ${home ? 'v' : '@'} ${esc(teamName(home ? x.away : x.home))}</span>
            <span class="s-status">${status}<span class="chev" aria-hidden="true">›</span></span>
          </button>`;
      }).join('')}</div>`
      : `<p class="s-line muted">No fixtures in the last ${SUBMIT_DAYS} days.${next ? ` Next: ${fmtDate(next.date, true)}.` : ''}</p>`));
    return parts.join('') + laterSteps(3) + foot;
  }
  const home = f.home === team;
  parts.push(stepHTML(2, 'Fixture', `
    <p class="s-line">${fmtDate(f.date, true)} · ${home ? 'v' : '@'} ${esc(teamName(home ? f.away : f.home))} (${home ? 'home' : 'away'})
      ${recent.length > 1 ? '<button type="button" class="s-link" data-s="change-fixture">Change</button>' : ''}</p>
    ${f.submitted ? `<p class="s-note">${esc(subNote(f))} Submitting again from your team replaces your earlier entry.</p>` : ''}
    ${f.played && !f.local && !f.submitted ? '<p class="s-note">This result is already in the results sheet.</p>' : ''}`, true));

  // 3. Score, with the score editor
  parts.push(stepHTML(3, 'Score', sub.score
    ? `<p class="s-line">${scoreLine(f, sub.score)} <button type="button" class="s-link" data-s="score">Change</button></p>`
    : `<button type="button" class="ed-btn primary" data-s="score">Enter the score</button>`, Boolean(sub.score)));
  if (!sub.score) return parts.join('') + laterSteps(4) + foot;

  // 4. Photo of the signed score sheet
  parts.push(stepHTML(4, 'Photo of the score sheet', `
    ${sub.photo ? `<img class="s-photo" src="${sub.photo}" alt="Your photo of the score sheet">` : ''}
    <div class="s-actions">
      <label class="ed-btn${sub.photo ? '' : ' primary'}"><input type="file" accept="image/*" capture="environment" data-s="photo" hidden>${sub.photo ? 'Retake' : 'Take photo'}</label>
      <label class="ed-btn"><input type="file" accept="image/*" data-s="photo" hidden>Choose from gallery</label>
    </div>`, Boolean(sub.photo)));
  if (!sub.photo) return parts.join('') + laterSteps(5) + foot;

  // 5. Send
  parts.push(stepHTML(5, 'Send', `
    <label class="s-field"><span>Your name</span>
      <input type="text" id="s-name" autocomplete="name" maxlength="60" value="${esc(sub.name)}" placeholder="Captain's name">
    </label>
    ${sub.error ? `<p class="s-error">${esc(sub.error)}</p>` : ''}
    <div class="s-actions">
      <button type="button" class="ed-btn primary" data-s="send" ${sub.busy ? 'disabled' : ''}>${sub.busy ? 'Sending…' : 'Submit result'}</button>
      ${sub.busy ? '' : clear}
    </div>
    <p class="s-note">The other captain then confirms it. It shows on this site straight away, marked as submitted, until it's in the results sheet.</p>`));
  return parts.join('');
}

function doneHTML() {
  const { f, side, status, token } = sub.done;
  const other = teamName(side === 'home' ? f.away : f.home);
  if (status === 'confirmed') {
    return `<div class="s-done"><p class="s-big">✓ Confirmed by both teams</p>
      <p>Your score matches what ${esc(other)} submitted.</p>${againHTML()}</div>`;
  }
  if (status === 'disputed') {
    return `<div class="s-done"><p class="s-big">Sent, but it doesn't match</p>
      <p>${esc(other)} submitted a different score. The league will check both photos.</p>${againHTML()}</div>`;
  }
  const link = `${location.origin}${location.pathname}#/confirm/${f.id}/${token}`;
  const d = fixtureDivision(f.id);
  const text = `Please confirm our ${leagueName(d)} result, ${teamName(f.home)} ${sub.score.hm}–${sub.score.am} ${teamName(f.away)} (${fmtDate(f.date, true)}). Tap to check and confirm: ${link}`;
  return `<div class="s-done">
    <p class="s-big">✓ Submitted</p>
    <p>Now send this link to ${esc(other)}'s captain so they can confirm it:</p>
    <p class="s-linkbox"><a href="${esc(link)}">${esc(link)}</a></p>
    <div class="s-actions">
      <a class="ed-btn primary" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send on WhatsApp</a>
      <button type="button" class="ed-btn" data-s="copy" data-text="${esc(text)}">Copy message</button>
    </div>
    ${againHTML()}
  </div>`;
}

const againHTML = () => '<p><button type="button" class="s-link" data-s="again">Submit another result</button></p>';

function scoreEntered(f, score) {
  sub.score = score;
  renderPanel();
}

async function shrinkPhoto(file) {
  let img;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    img = await new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("That file isn't a photo the browser can read."));
      i.src = URL.createObjectURL(file);
    });
  }
  const w = img.naturalWidth ?? img.width, h = img.naturalHeight ?? img.height;
  const scale = Math.min(1, PHOTO_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function sendSubmission() {
  const f = findFixture(sub.fixture);
  if (!f || !sub.score || !sub.photo) return;
  sub.name = $('s-name')?.value.trim() ?? sub.name;
  if (!sub.name) {
    sub.error = 'Please add your name.';
    return renderPanel();
  }
  const side = f.home === sub.team ? 'home' : 'away';
  Object.assign(sub, { busy: true, error: '' });
  renderPanel();
  try {
    const reply = await api('/api/submissions', { method: 'POST', body: { fixtureId: f.id, side, name: sub.name, ...sub.score, photo: sub.photo } });
    lsSet(NAME_KEY, sub.name);
    sub.done = { ...reply, f, side };
    await loadSubmissions();
    rebuild();
  } catch (err) {
    sub.error = err.message;
  }
  sub.busy = false;
  renderPanel();
}

// ---------- Confirm (the other captain) ----------

async function loadConfirm() {
  const c = sub.confirm;
  try {
    c.data = await api(`/api/submissions/${encodeURIComponent(c.id)}?t=${encodeURIComponent(c.token)}`);
    c.error = '';
  } catch (err) {
    c.error = err.message;
  }
  if (state.mode === 'confirm') renderPanel();
}

function confirmHTML() {
  const c = sub.confirm;
  if (!c || (!c.data && !c.error)) return '<p class="empty">Loading…</p>';
  if (!c.data) return `<p class="empty">${esc(c.error)}</p>`;
  const s = c.data;
  const f = findFixture(s.fixtureId) ?? { home: s.home, away: s.away, date: new Date(s.date), doubles: /doubles/i.test(s.division) };
  const by = teamName(s.side === 'home' ? s.home : s.away);
  const yours = teamName(s.side === 'home' ? s.away : s.home);

  let action;
  if (s.status === 'pending') {
    action = `
      <label class="s-field"><span>Your name</span>
        <input type="text" id="c-name" autocomplete="name" maxlength="60" value="${esc(sub.name)}" placeholder="${esc(yours)} captain's name">
      </label>
      ${c.disputing ? `
        <label class="s-field"><span>What's wrong?</span>
          <textarea id="c-note" rows="3" maxlength="500" placeholder="e.g. we won rubber 4 in three sets">${esc(c.note)}</textarea>
        </label>` : ''}
      ${c.error ? `<p class="s-error">${esc(c.error)}</p>` : ''}
      <div class="s-actions">
        ${c.disputing
          ? `<button type="button" class="ed-btn primary" data-s="dispute-send" ${c.busy ? 'disabled' : ''}>Send to the league</button>
             <button type="button" class="ed-btn" data-s="dispute-cancel">Back</button>`
          : `<button type="button" class="ed-btn primary" data-s="confirm" ${c.busy ? 'disabled' : ''}>Confirm result</button>
             <button type="button" class="ed-btn" data-s="dispute">Something's wrong</button>`}
      </div>`;
  } else {
    action = `<p class="s-big">${{
      confirmed: `✓ Confirmed${s.confirm ? ` by ${esc(s.confirm.name)}` : ''}`,
      disputed: 'Marked as disputed. The league will check it.',
      approved: '✓ Approved by the league',
    }[s.status]}</p>`;
  }

  return `<div class="s-done">
    <p class="s-line muted">${esc(s.division.replace(/^Mens/, "Men's"))} · ${fmtDate(new Date(s.date), true)}</p>
    <p class="s-line">${scoreLine(f, s.score)}</p>
    <p class="s-line muted">Submitted by ${esc(s.name)} for ${esc(by)}</p>
    <a href="${esc(s.photo)}" target="_blank" rel="noopener"><img class="s-photo" src="${esc(s.photo)}" alt="Photo of the score sheet"></a>
    ${action}
  </div>`;
}

async function sendConfirm(kind) {
  const c = sub.confirm;
  const name = $('c-name')?.value.trim();
  const note = $('c-note')?.value.trim() ?? '';
  if (!name) {
    c.error = 'Please add your name.';
    return renderPanel();
  }
  sub.name = name;
  Object.assign(c, { busy: true, error: '', note });
  renderPanel();
  try {
    await api(`/api/submissions/${encodeURIComponent(c.id)}/${kind}`, { method: 'POST', body: { t: c.token, name, note } });
    lsSet(NAME_KEY, name);
    c.disputing = false;
    await loadConfirm();
    await loadSubmissions();
    rebuild();
  } catch (err) {
    c.error = err.message;
  }
  c.busy = false;
  renderPanel();
}

// ---------- Admin ----------

async function loadAdmin() {
  const a = sub.admin;
  if (!lsGet(ADMIN_STORE)) return;
  try {
    a.list = await api('/api/admin/submissions', { admin: true });
    a.error = '';
  } catch (err) {
    a.error = err.message;
    if (err.status === 401) lsSet(ADMIN_STORE, null);
  }
  if (state.mode === 'admin') renderPanel();
}

function adminHTML() {
  const a = sub.admin;
  if (!lsGet(ADMIN_STORE)) {
    return `<div class="s-done">
      <label class="s-field"><span>Admin key</span><input type="password" id="a-key" autocomplete="current-password"></label>
      ${a.error ? `<p class="s-error">${esc(a.error)}</p>` : ''}
      <button type="button" class="ed-btn primary" data-s="admin-key">Open</button>
    </div>`;
  }
  if (!a.list) return `<p class="empty">${a.error ? esc(a.error) : 'Loading…'}</p>`;
  if (!a.list.length) return '<p class="empty">No submissions yet.</p>';

  const confirmed = a.list.filter((s) => s.status === 'confirmed').length;
  const k = encodeURIComponent(lsGet(ADMIN_STORE));
  const photo = (file, label) => `<a href="/api/photo/${esc(file)}?k=${k}" target="_blank" rel="noopener" class="a-photo">
    <img src="/api/photo/${esc(file)}?k=${k}" alt="${esc(label)}" loading="lazy"></a>`;
  const nums = (s) => `${s.hm}–${s.am} · sets ${s.hs}–${s.as} · pts ${s.hp}–${s.ap}`;
  const when = (iso) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const cards = a.list.map((s) => {
    const by = teamName(s.side === 'home' ? s.home : s.away);
    const o = s.official;
    const sheet = o
      ? `<p class="a-sheet ${o.hm === s.score.hm && o.am === s.score.am && o.hs === s.score.hs && o.as === s.score.as ? 'ok' : 'bad'}">
          In the results sheet: ${nums(o)}</p>`
      : `<p class="a-sheet">For the sheet: Home Matches ${s.score.hm} · Away Matches ${s.score.am} · Home Sets ${s.score.hs}
          · Away Sets ${s.score.as} · Home Pts ${s.score.hp} · Away Pts ${s.score.ap}</p>`;
    const extra = [
      s.confirm ? `<li>Confirmed by ${esc(s.confirm.name)} (${esc(teamName(s.confirm.side === 'home' ? s.home : s.away))}), ${when(s.confirm.at)}</li>` : '',
      ...s.disputes.map((x) => `<li class="bad">Disputed by ${esc(x.name)} (${esc(teamName(x.side === 'home' ? s.home : s.away))}), ${when(x.at)}${x.score ? `: they submitted ${nums(x.score)}` : ''}${x.note ? `: “${esc(x.note)}”` : ''}</li>`),
      s.history.length ? `<li>Replaces ${s.history.length} earlier ${s.history.length === 1 ? 'entry' : 'entries'} from ${esc(by)}</li>` : '',
    ].filter(Boolean).join('');
    const photos = [photo(s.photo, 'Score sheet'), s.confirm?.photo ? photo(s.confirm.photo, 'Their photo') : '',
      ...s.disputes.filter((x) => x.photo).map((x) => photo(x.photo, 'Disputing photo'))].join('');
    return `
      <article class="a-card">
        <header>
          <span>${esc(s.division.replace(/^Mens/, "Men's"))} · ${fmtDate(new Date(s.date))}</span>
          <span class="tag a-${s.status}">${{ pending: 'Awaiting other team', confirmed: 'Confirmed', disputed: 'Disputed', approved: 'Approved' }[s.status]}</span>
        </header>
        <p class="s-line"><strong>${esc(teamName(s.home))} ${s.score.hm}–${s.score.am} ${esc(teamName(s.away))}</strong>
          <span class="s-detail">sets ${s.score.hs}–${s.score.as} · pts ${s.score.hp}–${s.score.ap}</span></p>
        <p class="s-line muted">Submitted by ${esc(s.name)} (${esc(by)}), ${when(s.createdAt)}</p>
        ${extra ? `<ul class="a-extra">${extra}</ul>` : ''}
        ${sheet}
        <div class="a-photos">${photos}</div>
        <div class="s-actions">
          ${s.status !== 'approved' ? `<button type="button" class="ed-btn primary" data-s="approve" data-id="${esc(s.fixtureId)}">Approve</button>` : ''}
          <button type="button" class="ed-btn" data-s="remove" data-id="${esc(s.fixtureId)}">Remove</button>
        </div>
      </article>`;
  }).join('');

  return `
    ${confirmed ? `<p class="local-note">${confirmed} confirmed by both teams.
      <button type="button" data-s="approve-all">Approve ${confirmed === 1 ? 'it' : 'all of them'}</button></p>` : ''}
    <div class="a-list">${cards}</div>
    <p class="hint">Approving marks a result as checked; it still needs entering in the results sheet. Once it's there, the sheet's result is shown instead.</p>`;
}

async function adminAction(kind, ids) {
  const a = sub.admin;
  try {
    for (const id of ids) await api(`/api/admin/submissions/${encodeURIComponent(id)}/${kind}`, { method: 'POST', admin: true });
  } catch (err) {
    a.error = err.message;
  }
  await loadAdmin();
  await loadSubmissions();
  rebuild();
}

// ---------- Events ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-s]');
  if (!el || el.matches('input[type="file"]')) return;
  const act = el.dataset.s;

  if (act === 'team') {
    sub.team = el.dataset.team;
    sub.pickClub = null;
    Object.assign(sub, { fixture: null, score: null, photo: null, error: '' });
    lsSet(TEAM_KEY, sub.team);
    return renderPanel();
  }
  if (act === 'change-team') {
    sub.pickClub = slugify(splitTeam(sub.team).club);
    return renderPanel();
  }
  if (act === 'fixture') {
    Object.assign(sub, { fixture: el.dataset.id, score: null, photo: null, error: '' });
    return renderPanel();
  }
  if (act === 'change-fixture') {
    Object.assign(sub, { fixture: null, score: null, photo: null, error: '' });
    return renderPanel();
  }
  if (act === 'score') return openEditor(sub.fixture, sub.team, { d: fixtureDivision(sub.fixture), submit: true, start: sub.score });
  if (act === 'send') return sendSubmission();
  if (act === 'clear') {
    if ((sub.score || sub.photo) && !confirm('Clear everything you entered? Nothing has been sent.')) return;
    Object.assign(sub, { team: null, pickClub: null, fixture: null, score: null, photo: null, error: '' });
    lsSet(TEAM_KEY, null);
    renderPanel();
    return $('panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  if (act === 'cancel') {
    if (!confirm('Discard this result? Nothing has been sent.')) return;
    Object.assign(sub, { fixture: null, score: null, photo: null, error: '' });
    return select(state.slug ?? defaultSlug());
  }
  if (act === 'again') {
    Object.assign(sub, { fixture: null, score: null, photo: null, done: null, error: '' });
    return renderPanel();
  }
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(el.dataset.text);
      el.textContent = 'Copied';
    } catch {
      el.textContent = 'Copy failed';
    }
    return;
  }

  if (act === 'confirm') return sendConfirm('confirm');
  if (act === 'dispute') {
    sub.confirm.disputing = true;
    sub.name = $('c-name')?.value.trim() ?? sub.name;
    return renderPanel();
  }
  if (act === 'dispute-cancel') {
    sub.confirm.disputing = false;
    return renderPanel();
  }
  if (act === 'dispute-send') return sendConfirm('dispute');

  if (act === 'admin-key') {
    lsSet(ADMIN_STORE, $('a-key').value.trim() || null);
    sub.admin.error = '';
    return loadAdmin();
  }
  if (act === 'approve') return adminAction('approve', [el.dataset.id]);
  if (act === 'remove') {
    if (!confirm('Remove this submission? It disappears from the site.')) return;
    return adminAction('remove', [el.dataset.id]);
  }
  if (act === 'approve-all') {
    return adminAction('approve', sub.admin.list.filter((s) => s.status === 'confirmed').map((s) => s.fixtureId));
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 's-club') {
    sub.pickClub = e.target.value;
    return renderPanel();
  }
  if (e.target.matches('input[data-s="photo"]') && e.target.files[0]) {
    try {
      sub.photo = await shrinkPhoto(e.target.files[0]);
      sub.error = '';
    } catch (err) {
      sub.error = err.message;
    }
    renderPanel();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 's-name' || e.target.id === 'c-name') sub.name = e.target.value;
  if (e.target.id === 'c-note' && sub.confirm) sub.confirm.note = e.target.value;
});
