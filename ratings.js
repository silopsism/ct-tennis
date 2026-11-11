'use strict';

// Club ratings (only when the site is served by server.js, i.e. on salwood):
//  - After an away captain submits or confirms a result, they can rate the club they played at: a few stars,
//    the vibe, which facilities it has, and a comment.
//  - Each club page's About tab shows the averages, the facilities and recent comments.
//  - The admin page lists ratings with a comment or facilities to approve.
// Stars and vibe count straight away; comments and facilities show once the admin approves them.
// Loaded before app.js; uses app.js and submit.js globals (state, esc, slugify, renderPanel, api, sub…) at run time.

const FACILITIES = [
  ['practice_wall', 'Practice wall'], ['shop', 'Tennis shop'], ['floodlights', 'Floodlights'],
  ['change_rooms', 'Change rooms & showers'], ['parking', 'Secure parking'], ['bar', 'Bar'], ['braai', 'Braai area'],
  ['kids', "Kids' play area"], ['ball_machine', 'Ball machine'], ['coaching', 'Coaching'],
  ['cards', 'Card & SnapScan'], ['wheelchair', 'Wheelchair access'],
];
const STAR_ITEMS = [
  ['kitchen', 'Kitchen'], ['courts', 'Court quality'], ['shade', 'Shade & courtside seating'],
  ['seating', 'Outside seating'], ['hospitality', 'Hospitality'],
];
// Wind protection is out of 5 (the others are out of 3): it cuts the wind forecast on the Courts tab (conditions.js).
const WIND_ITEM = ['wind', 'Wind protected'];
const VIBES = [['😐', 'Quiet'], ['🙂', 'Friendly'], ['🔥', 'Buzzing']];

const clubInfo = { data: null, loading: false };
let rating = null; // the rating form: { fixture, ticket, club, slug, stars, vibe, ticks, comment, busy, sent, error }
const ratingAdmin = { list: null, error: '' };

// Only redraw pages that show ratings; never a half-filled score form.
function redrawRatings() {
  if (['leagues', 'clubs', 'submit', 'confirm', 'admin'].includes(state.mode)) renderPanel(); // leagues: fixture wind lines
}

async function loadClubInfo(force) {
  if (!state.api || clubInfo.loading || (clubInfo.data && !force)) return;
  clubInfo.loading = true;
  try {
    clubInfo.data = await api('/api/clubs');
  } catch {
    clubInfo.data ??= {};
  }
  clubInfo.loading = false;
  redrawRatings();
}

// Called with the server's reply to a submission or confirmation; away captains get a ticket to rate the home club.
function startRating(reply, fixture) {
  if (!reply?.rateTicket) return;
  if (rating?.ticket === reply.rateTicket) return;
  rating = {
    fixture, ticket: reply.rateTicket, club: reply.rateClub, slug: slugify(reply.rateClub),
    stars: {}, vibe: null, ticks: {}, comment: '', busy: false, sent: false, error: '',
  };
  loadClubInfo();
}

const known = (slug) => clubInfo.data?.[slug]?.facilities ?? {};

// ---------- The rating form ----------

function ratingHTML(fixture) {
  const r = rating;
  if (!r || r.fixture !== fixture) return '';
  if (r.sent) {
    return `<section class="r-card"><p class="s-big">Thanks for rating ${esc(r.club)}</p>
      <p class="s-note">Stars count straight away. Comments and facilities show once the league has checked them.</p>
      <p><a class="s-link" href="#/clubs/${r.slug}/about">See ${esc(r.club)}'s page</a></p></section>`;
  }
  const facts = known(r.slug);
  const starRow = ([k, label], max = 3) => {
    const v = r.stars[k];
    const buttons = Array.from({ length: max }, (_, i) => i + 1).map((n) => `<button type="button" class="r-star${v >= n ? ' on' : ''}" data-r="star" data-k="${k}" data-v="${n}"
      aria-label="${label}: ${n} of ${max}" aria-pressed="${v === n}">★</button>`).join('');
    const none = k === 'kitchen' ? `<button type="button" class="r-none" data-r="star" data-k="kitchen" data-v="0" aria-pressed="${v === 0}">None</button>` : '';
    const note = k === 'wind' ? ' <small class="s-note">1 exposed, 5 sheltered</small>' : '';
    return `<div class="r-row"><span>${label}${note}</span><span class="r-pick">${none}${buttons}</span></div>`;
  };
  const chip = ([k, label]) => {
    const v = k in r.ticks ? r.ticks[k] : facts[k] ?? null;
    const cls = v === true ? ' yes' : v === false ? ' no' : '';
    const mark = v === true ? '✓ ' : v === false ? '✗ ' : '';
    return `<button type="button" class="r-chip${cls}" data-r="tick" data-k="${k}"
      aria-label="${label}: ${v === true ? 'yes' : v === false ? 'no' : "don't know"}">${mark}${esc(label)}</button>`;
  };
  return `
    <section class="r-card">
      <h3>How was ${esc(r.club)}?</h3>
      <p class="s-note">Optional. It helps other teams know what to expect.</p>
      ${STAR_ITEMS.map((x) => starRow(x)).join('')}
      ${starRow(WIND_ITEM, 5)}
      <div class="r-row"><span>Vibes</span><span class="r-pick">${VIBES.map(([e, label], i) => `
        <button type="button" class="r-vibe${r.vibe === i + 1 ? ' on' : ''}" data-r="vibe" data-v="${i + 1}" aria-pressed="${r.vibe === i + 1}" title="${label}">${e}</button>`).join('')}</span></div>
      <p class="r-label">Facilities <span class="s-note">tap to mark yes, again for no</span></p>
      <div class="r-chips">${FACILITIES.map(chip).join('')}</div>
      <label class="s-field"><span>Comment</span>
        <textarea id="r-comment" rows="2" maxlength="300" placeholder="e.g. great toasted sandwiches, tight parking">${esc(r.comment)}</textarea>
      </label>
      <p class="s-note">Comments show once the league has checked them. Please leave out people's names.</p>
      ${r.error ? `<p class="s-error">${esc(r.error)}</p>` : ''}
      <div class="s-actions"><button type="button" class="ed-btn primary" data-r="send" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Sending…' : 'Send rating'}</button></div>
    </section>`;
}

async function sendRating() {
  const r = rating;
  r.comment = $('r-comment')?.value.trim() ?? r.comment;
  Object.assign(r, { busy: true, error: '' });
  renderPanel();
  try {
    await api('/api/ratings', { method: 'POST', body: { ticket: r.ticket, stars: r.stars, vibe: r.vibe, ticks: r.ticks, comment: r.comment } });
    r.sent = true;
    loadClubInfo(true);
  } catch (err) {
    r.error = err.message;
  }
  r.busy = false;
  renderPanel();
}

// ---------- About tab ----------

const starsHTML = (avg, max = 3) => `<span class="r-stars" style="--v:${avg};--max:${max}" role="img" aria-label="${avg.toFixed(1)} out of ${max}">${'★'.repeat(max)}</span>`;
const mapsLink = (club) => {
  const c = typeof courts !== 'undefined' ? courts.data?.[club.slug] : null; // conditions.js
  const q = c ? `${c.lat},${c.lon}` : `${club.name} tennis club, Cape Town`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
};

function aboutTabHTML(club) {
  loadClubInfo();
  if (!clubInfo.data) return '<p class="empty">Loading…</p>';
  const c = clubInfo.data[club.slug] ?? { n: 0, stars: {}, noKitchen: 0, vibe: null, facilities: {}, comments: [], summary: null };
  const info = c.info ?? {};
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${text} ›</a>`;
  const maps = `<div class="r-maps">
    ${info.address ? `<p class="r-address">${esc(info.address)}</p>` : ''}
    <p>${[link(mapsLink(club), 'Google Maps'), info.website && link(info.website, 'Website'),
      info.facebook && link(info.facebook, /instagram/.test(info.facebook) ? 'Instagram' : 'Facebook')].filter(Boolean).join(' · ')}</p>
    <span class="s-note">Google Maps has photos, reviews and directions.</span></div>`;
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const banner = info.photo ? `<figure class="r-banner">
      <img src="${esc(info.photo.src)}" alt="${esc(club.name)} tennis club" loading="lazy" onerror="this.closest('figure').remove()"
        ${/^[\d.]+% [\d.]+%$/.test(info.photo.focus ?? '') ? `style="object-position:${info.photo.focus}"` : ''}>
      ${info.photo.page ? `<figcaption>Photo: <a href="${esc(info.photo.page)}" target="_blank" rel="noopener">${esc(host(info.photo.page))}</a></figcaption>` : ''}
    </figure>` : '';
  if (!c.n && !Object.keys(c.facilities).length) {
    return `<div class="about-tab">
      ${banner}
      ${info.notes ? `<p class="r-summary">${esc(info.notes)}</p>` : ''}
      <p class="s-note">No ratings yet. Away captains can rate ${esc(club.name)} after submitting a result.</p>${maps}</div>`;
  }

  const vibe = c.vibe ? VIBES[Math.min(2, Math.max(0, Math.round(c.vibe.avg) - 1))] : null;
  const head = `<div class="r-head">
    ${vibe ? `<span class="r-vibe-big" title="${vibe[1]}">${vibe[0]}</span>` : ''}
    <div>${vibe ? `<strong>${vibe[1]}</strong> <span class="s-note">vibes from ${c.vibe.n} ${c.vibe.n === 1 ? 'visitor' : 'visitors'}</span>` : ''}
      ${c.summary ? `<p class="r-summary">${esc(c.summary)}</p>` : ''}
      ${info.notes ? `<p class="s-note">${esc(info.notes)}</p>` : ''}</div></div>`;

  const rows = STAR_ITEMS.map(([k, label]) => {
    const s = c.stars[k];
    if (k === 'kitchen' && c.noKitchen > (s?.n ?? 0)) return `<tr><th scope="row">${label}</th><td colspan="2">No kitchen</td></tr>`;
    return `<tr><th scope="row">${label}</th><td>${s ? starsHTML(s.avg) : '<span class="s-note">Not rated</span>'}</td>
      <td class="r-n">${s ? s.n : ''}</td></tr>`;
  }).join('') + (() => {
    const s = c.stars.wind;
    return `<tr><th scope="row">${WIND_ITEM[1]}</th><td>${s ? starsHTML(s.avg, 5) : '<span class="s-note">Not rated</span>'}</td>
      <td class="r-n">${s ? (s.n || 'league') : ''}</td></tr>`;
  })();

  const yes = FACILITIES.filter(([k]) => c.facilities[k] === true);
  const no = FACILITIES.filter(([k]) => c.facilities[k] === false);
  const unknown = FACILITIES.filter(([k]) => !(k in c.facilities));
  const facilities = `
    <div class="r-chips">${yes.map(([, l]) => `<span class="r-chip yes">✓ ${esc(l)}</span>`).join('')}${no.map(([, l]) => `<span class="r-chip no">✗ ${esc(l)}</span>`).join('')}</div>
    ${unknown.length ? `<p class="s-note">Not known yet: ${unknown.map(([, l]) => esc(l)).join(', ')}.</p>` : ''}`;

  const month = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
  const comments = c.comments.length
    ? `<ul class="r-comments">${c.comments.map((x) => `<li>“${esc(x.text)}” <span class="s-note">${month(x.at)}</span></li>`).join('')}</ul>`
    : '<p class="s-note">No comments yet.</p>';

  return `<div class="about-tab">
    ${banner}
    ${head}
    ${maps}
    <h3 class="r-h">Ratings</h3>
    ${c.n || c.stars.wind ? `<table class="r-table"><tbody>${rows}</tbody></table>` : '<p class="s-note">No ratings yet.</p>'}
    <h3 class="r-h">Facilities</h3>
    ${facilities}
    <h3 class="r-h">What visitors say</h3>
    ${comments}
    <p class="hint">${c.n ? `Rated by away captains after their matches: ${c.n} ${c.n === 1 ? 'rating' : 'ratings'} so far.`
      : `No ratings yet. Away captains can rate ${esc(club.name)} after submitting a result.`}
      Facilities come from captains and from the club's own pages.</p>
  </div>`;
}

// ---------- Admin ----------

async function loadRatingsAdmin() {
  try {
    ratingAdmin.list = await api('/api/admin/ratings', { admin: true });
    ratingAdmin.error = '';
  } catch (err) {
    ratingAdmin.error = err.message;
  }
}

function ratingsAdminHTML() {
  const list = ratingAdmin.list;
  if (!list?.length) return ratingAdmin.error ? `<p class="s-error">${esc(ratingAdmin.error)}</p>` : '';
  const label = Object.fromEntries([...FACILITIES, ...STAR_ITEMS, WIND_ITEM]);
  const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : 'not known');
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'source'; } };
  const researchCard = (x) => {
    const ticks = Object.entries(x.ticks).map(([k, v]) => {
      const kept = x.current[k] !== null; // a captain's answer is already on record and stays
      return `<li${kept ? ' class="muted"' : ''}>${label[k]}: ${yn(v)}
        ${x.sources[k] ? `<a href="${esc(x.sources[k])}" target="_blank" rel="noopener">${esc(host(x.sources[k]))}</a>` : ''}
        ${kept ? ` (keeps the captains' ${yn(x.current[k])})` : ''}</li>`;
    }).join('');
    return `
      <article class="a-card">
        <header><span><strong>${esc(x.name)}</strong> · from research</span></header>
        ${ticks ? `<ul class="a-extra">${ticks}</ul>` : ''}
        ${x.notes ? `<p class="r-quote">${esc(x.notes)}</p>` : ''}
        <div class="s-actions">
          <button type="button" class="ed-btn primary" data-r="approve" data-id="${esc(x.id)}">Approve</button>
          <button type="button" class="ed-btn" data-r="remove" data-id="${esc(x.id)}">Remove</button>
        </div>
      </article>`;
  };
  const research = list.filter((x) => x.research);
  const cards = list.map((x) => {
    if (x.research) return researchCard(x);
    const stars = Object.entries(x.stars).map(([k, v]) => `${label[k]} ${k === 'kitchen' && v === 0 ? 'none' : '★'.repeat(v)}`).join(' · ');
    const ticks = Object.entries(x.ticks).map(([k, v]) => {
      const changed = x.current[k] !== v;
      return `<li${changed ? ' class="bad-plain"' : ''}>${label[k]}: ${yn(v)}${changed ? ` (on record: ${yn(x.current[k])})` : ''}</li>`;
    }).join('');
    return `
      <article class="a-card">
        <header><span><strong>${esc(x.name)}</strong> · rated by ${esc(teamName(x.away))}</span>
          <span class="s-note">${esc(x.division.replace(/^Mens/, "Men's"))} · ${fmtDate(new Date(x.date))}</span></header>
        ${stars || x.vibe ? `<p class="s-line muted">${stars}${x.vibe ? `${stars ? ' · ' : ''}vibes ${VIBES[x.vibe - 1][0]}` : ''}</p>` : ''}
        ${ticks ? `<ul class="a-extra">${ticks}</ul>` : ''}
        ${x.comment ? `<p class="r-quote">“${esc(x.comment)}”</p>` : ''}
        <div class="s-actions">
          <button type="button" class="ed-btn primary" data-r="approve" data-id="${esc(x.id)}">Approve</button>
          <button type="button" class="ed-btn" data-r="remove" data-id="${esc(x.id)}">Remove</button>
        </div>
      </article>`;
  }).join('');
  return `<h3 class="r-h">Club ratings to check</h3>
    ${research.length > 1 ? `<p class="local-note">${research.length} clubs have researched facilities to check.
      <button type="button" data-r="approve-research">Approve all of them</button></p>` : ''}
    <div class="a-list">${cards}</div>
    <p class="hint">Approving shows the comment on the club's page and records the facilities ticked. Removing a captain's
      rating deletes it all, stars included. Researched facilities never replace an answer captains have already given.</p>
    <h3 class="r-h">Submitted results</h3>`;
}

async function ratingAdminAction(kind, ids) {
  try {
    for (const id of [].concat(ids)) await api(`/api/admin/ratings/${encodeURIComponent(id)}/${kind}`, { method: 'POST', admin: true });
  } catch (err) {
    ratingAdmin.error = err.message;
  }
  await loadRatingsAdmin();
  loadClubInfo(true);
  renderPanel();
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-r]');
  if (!el) return;
  const act = el.dataset.r;
  const r = rating;
  if (act === 'star' && r) {
    const v = +el.dataset.v;
    r.stars[el.dataset.k] = r.stars[el.dataset.k] === v ? undefined : v; // tap the same again to clear
    if (r.stars[el.dataset.k] === undefined) delete r.stars[el.dataset.k];
    return renderPanel();
  }
  if (act === 'vibe' && r) {
    r.vibe = r.vibe === +el.dataset.v ? null : +el.dataset.v;
    return renderPanel();
  }
  if (act === 'tick' && r) {
    const k = el.dataset.k;
    const now = k in r.ticks ? r.ticks[k] : known(r.slug)[k] ?? null;
    r.ticks[k] = now === null ? true : now === true ? false : null; // don't know -> yes -> no -> don't know
    if (r.ticks[k] === null) delete r.ticks[k];
    return renderPanel();
  }
  if (act === 'send' && r) return sendRating();
  if (act === 'approve') return ratingAdminAction('approve', el.dataset.id);
  if (act === 'approve-research') {
    if (!confirm('Approve the researched facilities for every club listed?')) return;
    return ratingAdminAction('approve', ratingAdmin.list.filter((x) => x.research).map((x) => x.id));
  }
  if (act === 'remove') {
    if (!confirm('Remove this rating? Its stars, vibe and comment are all deleted.')) return;
    return ratingAdminAction('remove', el.dataset.id);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'r-comment' && rating) rating.comment = e.target.value;
});
