// Court conditions: each club's court layout (courts.json, built by tools/courts.js), the wind forecast for
// match afternoons and where the sun is (calculated here).
// Wind: the ECMWF forecast (via Open-Meteo, free, no key) over open water in False Bay, scaled for each club by
// its terrain factors (tools/terrain.js, from the Cape Town Wind Explorer model). A club without factors gets
// the forecast at its own location instead.
// Shown on a club's Courts tab, and as a one-line forecast under upcoming fixtures.
// Uses app.js globals (state, esc, splitTeam, slugify, today, fmtDate, renderPanel, writeHash) at run time.

const COURT_HOURS = [11, 12, 13, 14, 15, 16, 17, 18]; // match days, 11am to 6pm
const SAST = 2; // UTC+2 all year
const FORECAST_DAYS = 15; // Open-Meteo forecasts 16 days, today included
// Saved forecasts hold only the match hours, so the key names them: changing the hours drops the old ones.
const WIND_KEY = `ctt-wind-v3-${COURT_HOURS[0]}-${COURT_HOURS[COURT_HOURS.length - 1]}`;
try {
  for (const k of Object.keys(localStorage)) if (k.startsWith('ctt-wind-') && k !== WIND_KEY) localStorage.removeItem(k);
} catch { /* storage unavailable */ }
const OPEN_WATER = { lat: -34.30, lon: 18.60 }; // the terrain model's inflow point, in False Bay
const WIND_TTL = 60 * 60 * 1000;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const RAD = Math.PI / 180;

const courts = { data: null, loading: false, wind: new Map(), windLoading: new Set() };

const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const hourLabel = (h) => (h < 12 ? `${h}am` : `${h > 12 ? h - 12 : h}pm`);
const HOURS_TEXT = `${hourLabel(COURT_HOURS[0])} to ${hourLabel(COURT_HOURS[COURT_HOURS.length - 1])}`;

// The hour it is now in Cape Town, kept within the match hours: what the Courts tab opens on.
function currentHour() {
  const h = new Date(Date.now() + SAST * 3600e3).getUTCHours();
  return Math.min(Math.max(h, COURT_HOURS[0]), COURT_HOURS[COURT_HOURS.length - 1]);
}
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const daysAhead = (iso) => Math.round((Date.parse(iso) - Date.parse(isoDate(today()))) / 86400e3);
const localMs = (iso, h) => Date.parse(`${iso}T00:00:00Z`) + (h - SAST) * 3600e3;
const angleOff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180); // 0..180

// Only redraw pages that show conditions, never a half-filled submission form.
function redrawConditions() {
  if (state.mode === 'leagues' || state.mode === 'clubs') renderPanel();
}

function loadCourts() {
  if (courts.data || courts.loading) return;
  courts.loading = true;
  fetch('courts.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((d) => { courts.data = d; redrawConditions(); });
}

function readWindCache() {
  try { return JSON.parse(localStorage.getItem(WIND_KEY)) || {}; } catch { return {}; }
}

function saveWindCache(iso, data) {
  try {
    const c = readWindCache();
    for (const k of Object.keys(c)) if (Date.now() - c[k].at > WIND_TTL) delete c[k];
    c[iso] = { at: Date.now(), data };
    localStorage.setItem(WIND_KEY, JSON.stringify(c));
  } catch { /* storage unavailable */ }
}

// One day's forecast for the match hours: { open: { 13: { speed, from, gust }, … }, <slug>: {…}, … } for the open-water
// point and at every club. Null while loading or out of range; {} if it couldn't be had.
function windFor(iso) {
  if (courts.wind.has(iso)) return courts.wind.get(iso);
  const cached = readWindCache()[iso];
  if (cached && Date.now() - cached.at < WIND_TTL) {
    courts.wind.set(iso, cached.data);
    return cached.data;
  }
  const ahead = daysAhead(iso);
  if (!courts.data || courts.windLoading.has(iso) || ahead > FORECAST_DAYS || ahead < -60) return null;
  const slugs = ['open', ...Object.keys(courts.data)];
  const at = (s) => (s === 'open' ? OPEN_WATER : courts.data[s]);
  courts.windLoading.add(iso);
  const q = new URLSearchParams({
    latitude: slugs.map((s) => at(s).lat).join(','),
    longitude: slugs.map((s) => at(s).lon).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    models: 'ecmwf_ifs',
    timezone: 'Africa/Johannesburg', start_date: iso, end_date: iso,
  });
  fetch(`https://api.open-meteo.com/v1/forecast?${q}`)
    .then((r) => r.json())
    .then((j) => {
      const list = Array.isArray(j) ? j : [j];
      const out = {};
      list.forEach((loc, i) => {
        const t = loc.hourly?.time ?? [];
        const hours = {};
        for (const h of COURT_HOURS) {
          const k = t.indexOf(`${iso}T${pad2(h)}:00`);
          if (k >= 0 && loc.hourly.wind_speed_10m[k] != null) {
            hours[h] = { speed: loc.hourly.wind_speed_10m[k], from: loc.hourly.wind_direction_10m[k], gust: loc.hourly.wind_gusts_10m[k] };
          }
        }
        if (slugs[i]) out[slugs[i]] = hours;
      });
      courts.wind.set(iso, out);
      saveWindCache(iso, out);
    })
    .catch(() => courts.wind.set(iso, {}))
    .finally(() => { courts.windLoading.delete(iso); redrawConditions(); });
  return null;
}

// The wind at a club's courts for each match hour: { 13: { speed, from, gust, open, share }, … }.
// With terrain factors it's the open-water forecast scaled and turned for the direction it blows from
// (between the model's 16 directions, in proportion); `open` is that forecast and `share` the factor.
// Gusts: the terrain model's gustiness is calibrated over the sea, so it's kept only where it's gustier
// than the land forecast at the club (lee rotors); otherwise the land forecast's gust-to-wind ratio is used.
function clubWind(slug, all) {
  const c = courts.data?.[slug];
  if (!all || !c) return null;
  if (!c.terrain) return all[slug] ?? null;
  if (!all.open) return null;
  const out = {};
  for (const [h, o] of Object.entries(all.open)) {
    const pos = (((o.from % 360) + 360) % 360) / 22.5;
    const i = Math.floor(pos) % 16, j = (i + 1) % 16, t = pos - Math.floor(pos);
    const mix = (k) => c.terrain[i][k] * (1 - t) + c.terrain[j][k] * t;
    const speed = o.speed * mix(0);
    const land = all[slug]?.[h];
    const gustiness = Math.max(land?.speed > 1 ? land.gust / land.speed : 0, o.speed > 1 ? (o.gust * mix(1)) / speed : 0);
    out[h] = { speed, gust: speed * (gustiness || 1), from: (o.from + mix(2) + 360) % 360, open: o, share: mix(0) };
  }
  return out;
}

// Sun position: azimuth clockwise from north, altitude above the horizon, both in degrees. Good to well under a degree.
function sunAt(ms, lat, lon) {
  const d = ms / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const H = ((18.697374558 + 24.06570982441908 * d) * 15 + lon) * RAD - ra;
  const p = lat * RAD;
  const alt = Math.asin(Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(p) - Math.sin(p) * Math.cos(H));
  return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
}

// ---------- Wording ----------

const ends = (c) => ({ a: compass(c.axis), b: compass(c.axis + 180) });
const windWord = (k) => (k < 8 ? 'Calm' : k < 18 ? 'Light' : k < 28 ? 'Breezy' : k < 38 ? 'Strong' : 'Very strong');

// How the wind meets the courts: 'down', 'across' or 'diagonal', and the end where it's behind you.
function windWay(c, w) {
  const off = angleOff((w.from + 180) % 360, c.axis); // 0 = blowing toward the axis end
  const across = Math.min(off, 180 - off);
  const { a, b } = ends(c);
  return { way: across < 30 ? 'down' : across > 60 ? 'across' : 'diagonal', back: off < 90 ? b : a, into: off < 90 ? a : b };
}

function windText(c, w) {
  const r = windWay(c, w);
  if (r.way === 'down') return `<strong>Down the court.</strong> Behind you at the ${r.back} end, in your face at the ${r.into} end.`;
  if (r.way === 'across') return `<strong>Across the court</strong>, pushing the ball toward the ${compass((w.from + 180) % 360)} side.`;
  return `<strong>Diagonal.</strong> Partly across, partly behind you at the ${r.back} end.`;
}

// Low sun in line with the courts gets in players' eyes. Returns the end that looks into it, or null.
function glareEnd(c, s) {
  if (s.alt <= 0 || s.alt >= 35) return null;
  const off = angleOff(s.az, c.axis);
  if (Math.min(off, 180 - off) >= 35) return null;
  const { a, b } = ends(c);
  return off < 90 ? b : a;
}

function sunText(c, s) {
  if (s.alt <= 0) return '<strong>Set.</strong>';
  const facing = glareEnd(c, s);
  if (facing) return `<strong>Low and in line.</strong> Players at the ${facing} end look into it.`;
  const off = angleOff(s.az, c.axis), inLine = Math.min(off, 180 - off) < 35;
  const { a, b } = ends(c);
  if (s.alt < 20) return '<strong>Low but side-on</strong>, so mostly out of players\' eyes.';
  if (s.alt > 60) return '<strong>High overhead.</strong> Only a problem on serves and lobs.';
  return `<strong>Clear of eye level</strong>${inLine ? `, but serving from the ${off < 90 ? b : a} end means tossing toward it` : ''}.`;
}

function arrowSVG(toDeg, size) {
  return `<svg class="wind-arrow" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true"><path transform="rotate(${Math.round(toDeg)})" d="M0 -8V7M-4.5 -3L0 -8 4.5 -3"/></svg>`;
}

// ---------- Fixture line ----------

// One line under an upcoming fixture: wind for the afternoon at the home club, and any low sun. Links to the Courts tab.
function fixtureConditions(f) {
  if (f.played || !f.date || /postpon/i.test(f.status ?? '')) return '';
  const iso = isoDate(f.date);
  const ahead = daysAhead(iso);
  if (ahead < 0 || ahead > FORECAST_DAYS) return '';
  loadCourts();
  const slug = slugify(splitTeam(f.home).club);
  const c = courts.data?.[slug];
  if (!c) return '';
  const parts = [];
  const hours = clubWind(slug, windFor(iso));
  const ws = hours ? COURT_HOURS.map((h) => hours[h]).filter(Boolean) : [];
  if (ws.length) {
    const lo = Math.round(Math.min(...ws.map((w) => w.speed))), hi = Math.round(Math.max(...ws.map((w) => w.speed)));
    const peak = ws.reduce((m, w) => (w.speed > m.speed ? w : m));
    const way = { down: 'down the courts', across: 'across the courts', diagonal: 'diagonal' }[windWay(c, peak).way];
    parts.push(`${arrowSVG((peak.from + 180) % 360, 12)} ${compass(peak.from)} ${lo === hi ? lo : `${lo}–${hi}`} km/h ${way}, gusts ${Math.round(Math.max(...ws.map((w) => w.gust)))}`);
  }
  const glare = COURT_HOURS.filter((h) => glareEnd(c, sunAt(localMs(iso, h), c.lat, c.lon)));
  if (glare.length) parts.push(`low sun ${hourLabel(glare[0])}${glare.length > 1 ? `–${hourLabel(glare[glare.length - 1])}` : ''}`);
  const text = parts.length ? parts.join(' · ') : 'Courts, sun and wind';
  return `<a class="fx-cond" href="#/clubs/${slug}/courts/${iso}" title="Courts, sun and wind at ${esc(c.name)}">${text} ›</a>`;
}

// ---------- Courts tab ----------

function nextSaturday() {
  const d = today();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return isoDate(d);
}

// Upcoming dates with a home fixture at this club.
function homeDates(club) {
  const now = today();
  const dates = new Map();
  for (const d of state.model.values()) {
    for (const f of d.fixtures) {
      if (f.played || !f.date || f.date < now || splitTeam(f.home).club !== club.name) continue;
      const iso = isoDate(f.date);
      dates.set(iso, (dates.get(iso) ?? 0) + 1);
    }
  }
  return [...dates].sort((a, b) => a[0].localeCompare(b[0]));
}

function courtsTabHTML(club) {
  loadCourts();
  if (!courts.data) return '<p class="empty">Loading the courts…</p>';
  const c = courts.data[club.slug];
  if (!c) return `<p class="empty">We don't have a map of ${esc(club.name)}'s courts yet.</p>`;

  const upcoming = homeDates(club);
  const iso = state.courtDate ?? upcoming[0]?.[0] ?? nextSaturday();
  const hour = COURT_HOURS.includes(state.courtHour) ? state.courtHour : currentHour();
  const suns = COURT_HOURS.map((h) => ({ h, ...sunAt(localMs(iso, h), c.lat, c.lon) }));
  const sun = suns.find((s) => s.h === hour);
  const ahead = daysAhead(iso);
  const all = windFor(iso);
  const hours = clubWind(club.slug, all);
  const w = hours?.[hour];
  const windMsg = ahead > FORECAST_DAYS ? `No forecast yet. It opens ${ahead - FORECAST_DAYS} ${ahead - FORECAST_DAYS === 1 ? 'day' : 'days'} before.`
    : ahead < -60 ? 'No wind record this far back.'
    : !all ? 'Loading the forecast…'
    : 'No wind forecast for this date.';
  const { a, b } = ends(c);
  const n = c.courts.length;

  const dateChips = upcoming.slice(0, 4).map(([d, count]) => {
    const dt = new Date(`${d}T00:00:00`);
    return `<button type="button" data-court-date="${d}" aria-pressed="${d === iso}">${fmtDate(dt)} <small>${count} home</small></button>`;
  }).join('');

  const col = (h) => (h === hour ? ' class="on"' : '');
  const strip = `
    <table class="court-strip">
      <thead><tr><th></th>${COURT_HOURS.map((h) => `<th${col(h)}><button type="button" data-court-hour="${h}">${hourLabel(h)}</button></th>`).join('')}</tr></thead>
      <tbody>
        <tr><th scope="row">Sun</th>${suns.map((s) => `<td${col(s.h)}>${s.alt > 0
          ? `<span${glareEnd(c, s) ? ' class="glare" title="Low and in line with the courts"' : ''}>${Math.round(s.alt)}° ${compass(s.az)}</span>` : 'set'}</td>`).join('')}</tr>
        <tr><th scope="row">Wind</th>${COURT_HOURS.map((h) => { const x = hours?.[h]; return `<td${col(h)}>${x ? `${arrowSVG((x.from + 180) % 360, 12)} ${Math.round(x.speed)}` : '–'}</td>`; }).join('')}</tr>
        <tr><th scope="row">Gusts</th>${COURT_HOURS.map((h) => { const x = hours?.[h]; return `<td${col(h)}>${x ? Math.round(x.gust) : '–'}</td>`; }).join('')}</tr>
      </tbody>
    </table>`;

  return `
    <div class="courts-tab">
      <p class="club-summary"><strong>${n}</strong> ${n === 1 ? 'court' : 'courts'} · ${n === 1 ? 'it runs' : 'they run'}
        <strong>${b}–${a}</strong> (${Math.round(c.axis)}°/${Math.round(c.axis) + 180}°)</p>
      <div class="court-controls">
        <input type="date" id="court-date" value="${iso}" aria-label="Date">
        ${dateChips ? `<div class="court-dates" aria-label="Home fixture dates">${dateChips}</div>` : ''}
      </div>
      <div class="court-hours" role="group" aria-label="Time">
        ${COURT_HOURS.map((h) => `<button type="button" data-court-hour="${h}" aria-pressed="${h === hour}">${hourLabel(h)}</button>`).join('')}
      </div>
      ${courtMapSVG(c, iso, suns, hour, w)}
      <div class="court-readout">
        <div>
          <h3>Wind</h3>
          <div class="big">${w ? `${arrowSVG((w.from + 180) % 360, 18)} ${Math.round(w.speed)} km/h ${compass(w.from)}` : '–'}</div>
          <p>${w ? `${windWord(w.speed)}, gusting ${Math.round(w.gust)}. ${windText(c, w)}` : esc(windMsg)}</p>
          ${w ? `<p class="wind-basis">${w.open
            ? `Estimated for these courts: ${Math.round(w.share * 100)}% of the ${Math.round(w.open.speed)} km/h ${compass(w.open.from)} forecast over open water.`
            : 'Forecast for this part of Cape Town.'}</p>` : ''}
        </div>
        <div>
          <h3>Sun at ${hourLabel(hour)}</h3>
          <div class="big">${sun.alt > 0 ? `${Math.round(sun.alt)}° up in the ${compass(sun.az)}` : 'Below the horizon'}</div>
          <p>${sunText(c, sun)}</p>
        </div>
      </div>
      ${strip}
      <p class="hint">Court outlines from OpenStreetMap. Wind is the ECMWF forecast (via Open-Meteo) over open water in
        False Bay, scaled for how the terrain around these courts speeds it up or shelters it, using the
        <a href="https://wind-analyzer.pages.dev/" target="_blank" rel="noopener">Cape Town Wind Explorer</a> model.
        It's an estimate: trees, walls and clubhouses aren't in it. The sun is worked out for the date.</p>
    </div>`;
}

// North-up map: courts and surroundings in a circle, a compass ring, the sun's path through the match hours outside it,
// sunlight across the courts and wind streaks drifting with the wind.
function courtMapSVG(c, iso, suns, hour, w) {
  const f1 = (v) => Math.round(v * 10) / 10;
  let reach = 0;
  for (const [x, y, , len, wid] of c.courts) reach = Math.max(reach, Math.hypot(x, y) + Math.hypot(len, wid) / 2);
  const mapR = Math.max(55, reach + 22); // metres shown, drawn at radius 100
  const S = 100 / mapR;
  const P = ([x, y]) => `${f1(x * S)} ${f1(-y * S)}`;
  const path = (pts, close) => pts.map((p, i) => (i ? 'L' : 'M') + P(p)).join('') + (close ? 'Z' : '');
  const out = [];

  // Map contents, clipped to the circle.
  out.push('<g clip-path="url(#court-clip)"><circle r="100" class="m-bg"/>');
  for (const p of c.pitches) out.push(`<path class="m-pitch" d="${path(p, true)}"/>`);
  for (const p of c.pools) out.push(`<path class="m-pool" d="${path(p, true)}"/>`);
  for (const p of c.buildings) out.push(`<path class="m-bldg" d="${path(p, true)}"/>`);
  const roadW = (k) => f1((k === 's' ? 3.5 : 7) * S);
  for (const r of c.roads) out.push(`<path class="m-road-edge" stroke-width="${f1(roadW(r.k) + 1.2 * S)}" d="${path(r.p)}"/>`);
  for (const r of c.roads) out.push(`<path class="m-road" stroke-width="${roadW(r.k)}" d="${path(r.p)}"/>`);
  // One label per named road, on its longest stretch inside the map.
  const named = new Map();
  for (const r of c.roads) {
    if (!r.n) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, ay] = r.p[i], [bx, by] = r.p[i + 1];
      const mx = (ax + bx) / 2, my = (ay + by) / 2, L = Math.hypot(bx - ax, by - ay);
      if (Math.hypot(mx, my) > mapR - 12 || L < 22) continue;
      if (!named.has(r.n) || named.get(r.n).L < L) named.set(r.n, { mx, my, L, ang: Math.atan2(-(by - ay), bx - ax) / RAD });
    }
  }
  for (const [name, s] of named) {
    const ang = s.ang > 90 ? s.ang - 180 : s.ang < -90 ? s.ang + 180 : s.ang;
    out.push(`<text class="m-road-name" transform="translate(${P([s.mx, s.my])}) rotate(${f1(ang)})">${esc(name)}</text>`);
  }
  // Courts: run-off from the outline, then a regulation court (23.77 × 10.97 m) on it.
  for (const [x, y, bearing, len, wid] of c.courts) {
    out.push(`<g transform="translate(${P([x, y])}) rotate(${bearing}) scale(${f1(S * 100) / 100})">
      <rect class="m-runoff" x="${-wid / 2}" y="${-len / 2}" width="${wid}" height="${len}"/>
      <rect class="m-court" x="-5.485" y="-11.885" width="10.97" height="23.77"/>
      <path class="m-lines" d="M-5.485 -11.885h10.97v23.77h-10.97zM-4.115 -11.885v23.77M4.115 -11.885v23.77M-4.115 -6.4h8.23M-4.115 6.4h8.23M0 -6.4v12.8"/>
      <path class="m-net" d="M-6.4 0h12.8"/></g>`);
  }
  // Sunlight: faint parallel rays from the sun's direction.
  const sun = suns.find((s) => s.h === hour);
  if (sun.alt > 0) {
    out.push(`<g transform="rotate(${f1(sun.az)})">`);
    for (let x = -98; x <= 98; x += 14) out.push(`<line class="m-ray" x1="${x}" y1="-100" x2="${x}" y2="100"/>`);
    out.push('</g>');
  }
  // Wind streaks drifting downwind; faster and heavier as the wind picks up.
  if (w) {
    const to = (w.from + 180) % 360;
    const dur = Math.max(1.2, 14 / Math.max(w.speed, 3));
    const sw = f1(0.8 + Math.min(w.speed, 50) / 50 * 1.6);
    const len = Math.round(6 + Math.min(w.speed, 50) / 50 * 16);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    out.push(`<g transform="rotate(${f1(to - 90)})">`);
    for (let y = -104; y <= 104; y += 9) {
      out.push(`<line class="m-streak" x1="-110" y1="${y}" x2="110" y2="${y}" stroke-width="${sw}" stroke-dasharray="${len} ${120 - len}"
        stroke-dashoffset="${f1(rnd() * 120)}" style="animation-duration:${(dur * (0.85 + rnd() * 0.3)).toFixed(2)}s"/>`);
    }
    out.push('</g>');
  }
  // End names, near the edge along the court direction.
  const { a, b } = ends(c);
  for (const [deg, label] of [[c.axis, a], [c.axis + 180, b]]) {
    out.push(`<text class="m-end" x="${f1(Math.sin(deg * RAD) * 88)}" y="${f1(-Math.cos(deg * RAD) * 88)}">${label} end</text>`);
  }
  out.push('</g>');

  // Compass ring.
  out.push('<circle r="100" class="m-ring"/>');
  for (let d = 0; d < 360; d += 10) {
    const r2 = d % 90 ? 103 : 106;
    out.push(`<line class="m-tick" x1="${f1(Math.sin(d * RAD) * 100)}" y1="${f1(-Math.cos(d * RAD) * 100)}" x2="${f1(Math.sin(d * RAD) * r2)}" y2="${f1(-Math.cos(d * RAD) * r2)}"/>`);
  }
  for (const [d, t] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    out.push(`<text class="m-cardinal${t === 'N' ? ' n' : ''}" x="${f1(Math.sin(d * RAD) * 113)}" y="${f1(-Math.cos(d * RAD) * 113)}">${t}</text>`);
  }

  // The sun's path outside the ring: placed by direction, closer in the higher it is.
  const rOf = (alt) => 141 - Math.min(Math.max(alt, 0), 90) / 90 * 18; // a midday sun stays clear of the N
  const at = (s, extra = 0) => [Math.sin(s.az * RAD) * (rOf(s.alt) + extra), -Math.cos(s.az * RAD) * (rOf(s.alt) + extra)];
  const fine = [];
  for (let t = COURT_HOURS[0]; t <= COURT_HOURS[COURT_HOURS.length - 1] + 1e-9; t += 0.25) {
    fine.push(sunAt(localMs(iso, t), c.lat, c.lon));
  }
  out.push(`<path class="m-sunpath" d="${fine.map((s, i) => (i ? 'L' : 'M') + at(s).map(f1).join(' ')).join('')}"/>`);
  for (const s of suns) {
    const on = s.h === hour;
    const [x, y] = at(s);
    const [lx, ly] = at(s, on ? 15 : 10);
    out.push(`<g class="m-sun${on ? ' on' : ''}" data-court-hour="${s.h}">`);
    if (on) {
      for (let k = 0; k < 8; k++) {
        const q = k * 45 * RAD;
        out.push(`<line class="m-sunray" x1="${f1(x + Math.cos(q) * 7)}" y1="${f1(y + Math.sin(q) * 7)}" x2="${f1(x + Math.cos(q) * 9.5)}" y2="${f1(y + Math.sin(q) * 9.5)}"/>`);
      }
    }
    out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${on ? 5.2 : 3.4}"/><text x="${f1(lx)}" y="${f1(ly)}">${hourLabel(s.h)}</text></g>`);
  }

  return `<svg class="court-map" viewBox="-162 -158 324 316" role="img"
    aria-label="Map of ${esc(c.name)}'s courts, north up, with the sun's path from ${HOURS_TEXT}${w ? ' and the wind' : ''}">
    <defs><clipPath id="court-clip"><circle r="100"/></clipPath></defs>${out.join('')}</svg>`;
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  const h = e.target.closest('[data-court-hour]');
  if (h) {
    state.courtHour = +h.dataset.courtHour;
    return renderPanel();
  }
  const d = e.target.closest('[data-court-date]');
  if (d) {
    state.courtDate = d.dataset.courtDate;
    writeHash();
    renderPanel();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'court-date' && /^\d{4}-\d\d-\d\d$/.test(e.target.value)) {
    state.courtDate = e.target.value;
    writeHash();
    renderPanel();
  }
});
