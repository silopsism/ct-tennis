// Builds courts.json: each club's court layout and surroundings, from OpenStreetMap.
// Run with `node tools/courts.js` after adding or moving a club below, or `node tools/courts.js tab green-point`
// to rebuild only those clubs (by their page name) and keep the rest. No dependencies.
//
// Each club is a point at (or very near) its courts. The script takes the tennis court nearest that point,
// plus every court joined to it by a gap of under 45 m, so the next-door school's courts are left out.
// A court goes to whichever club's point is nearest, so neighbouring clubs (Green Point and TAB) don't share courts.
// An outline drawn round other courts (a whole club mapped as "tennis") is ignored.
// Courts mapped as one block (several courts in a single outline) are split into single courts.
// Positions are in metres from the middle of the courts: x east, y north.

const fs = require('fs');
const path = require('path');

// [lat, lon] of each club's courts, keyed by the club name used in the results sheet. Where the map's outlines are
// wrong, { at: [lat, lon], courts: { bearing, len, wid, step, rows: [[x, y, n], …] } } lays the courts out by hand:
// each row starts at x, y (metres east and north of `at`) and has n courts side by side, `step` metres apart.
// Venues from Cape Town Tennis's 2025-26 club contacts list, placed on the courts mapped at that address.
const CLUBS = {
  Bellville: [-33.91725, 18.65698], // Glenhaven; "Bellville United Tennis Club" on the map
  Bergvliet: [-34.0481, 18.4597],
  Bonteheuwel: [-33.9503, 18.5571], // Jakkalsvlei Avenue
  'Camps Bay': [-33.95294, 18.37887],
  Chrismar: [-33.89358, 18.64455],
  Claremont: [-33.98580, 18.46265],
  // Mapped only as one outline round the whole venue; laid out from the satellite photo: rows of 3 and 6 courts.
  Constantia: { at: [-34.0187, 18.4495], courts: { bearing: 32, len: 34.5, wid: 17.4, step: 17.4, rows: [[-17.5, 37.5, 3], [-41.3, 11.3, 6]] } },
  CPUT: [-33.9334, 18.6448], // Bellville campus
  Edgemead: [-33.88042, 18.54081],
  Eversdal: [-33.86906, 18.64993],
  'Fish Hoek': [-34.1368, 18.4275],
  Fresnaye: [-33.92442, 18.39192],
  Gardens: [-33.93689, 18.41106],
  Glen: [-33.9421, 18.3735], // Glen Country Club, Clifton
  'Green Point': [-33.9064, 18.4010], // the 10 courts in the middle of Bill Peters Drive
  'Kelvin Grove': [-33.97142, 18.47052],
  Kenridge: [-33.8567, 18.6355],
  Khayelitsha: [-34.0488, 18.6529], // False Bay College
  Langa: [-33.9415, 18.5314], // Sandile Avenue
  Llandudno: [-34.00855, 18.34560],
  Meadowridge: [-34.03776, 18.45508],
  Milnerton: [-33.88483, 18.49252],
  'Mitchells Plain': [-34.0461, 18.6005], // Westridge
  'Monte Vista': [-33.88116, 18.55548],
  'Old Mutual': [-33.9245, 18.5073], // Jan Smuts Drive, Pinelands
  Orangia: [-33.9332, 18.4128],
  Parow: [-33.89125, 18.58398],
  Pinelands: [-33.94108, 18.49938],
  Plumstead: [-34.02596, 18.47530],
  TAB: [-33.90662, 18.40021], // Three Anchor Bay: the courts at the west end of Bill Peters Drive
  Tornadoes: [-33.82875, 18.48793], // Table View Tennis Club
  UCT: [-33.95692, 18.45855],
  UWC: [-33.9298, 18.6313],
  Welgemoed: [-33.87223, 18.61728],
  WPCC: [-33.97403, 18.48209],
  Wynberg: [-33.99244, 18.47206], // Harfield Road, Kenilworth
};

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BBOX = '-34.40,18.30,-33.70,18.95'; // Cape Town metro
const LINK = 45; // courts closer than this (centre to centre, minus their sizes) are one venue
const COURT = { len: 34.5, wid: 17 }; // a typical court with its run-off

const K = 111320;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const r1 = (v) => Math.round(v * 10) / 10;

async function overpass(query) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ct-tennis court builder' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.ok) return (await res.json()).elements;
    console.warn(`  Overpass ${res.status}, retrying…`);
    await sleep(5000 * 2 ** attempt);
  }
  throw new Error('Overpass is unavailable');
}

// Local metres around a reference point.
const projector = (lat0, lon0) => {
  const kx = K * Math.cos(lat0 * Math.PI / 180);
  return {
    xy: (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * K],
    ll: ([x, y]) => [lat0 + y / K, lon0 + x / kx],
  };
};

// A court outline -> one or more courts { x, y, bearing, len, wid }.
function courtsOf(pts) {
  const ring = pts.slice(0, -1);
  let best = 0, ang = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], L = Math.hypot(dx, dy);
    if (L > best) { best = L; ang = Math.atan2(dx, dy); }
  }
  // Extents along the longest edge (a) and across it (b).
  const span = (t) => {
    const ux = Math.sin(t), uy = Math.cos(t);
    const a = ring.map(([x, y]) => x * ux + y * uy), b = ring.map(([x, y]) => -x * uy + y * ux);
    return { t, ux, uy, a0: Math.min(...a), a1: Math.max(...a), b0: Math.min(...b), b1: Math.max(...b) };
  };
  // Try the courts running along the longest edge, and across it; keep whichever divides into whole courts best.
  const options = [ang, ang + Math.PI / 2].map((t) => {
    const s = span(t);
    const along = s.a1 - s.a0, across = s.b1 - s.b0;
    const nA = Math.max(1, Math.round(along / COURT.len)), nX = Math.max(1, Math.round(across / COURT.wid));
    const err = Math.abs(along / COURT.len - nA) + Math.abs(across / COURT.wid - nX);
    return { s, nA, nX, err };
  });
  const { s, nA, nX } = options.sort((p, q) => p.err - q.err)[0];
  const len = (s.a1 - s.a0) / nA, wid = (s.b1 - s.b0) / nX;
  const bearing = ((s.t * 180 / Math.PI) % 180 + 180) % 180;
  const out = [];
  for (let i = 0; i < nA; i++) for (let j = 0; j < nX; j++) {
    const ca = s.a0 + len * (i + 0.5), cb = s.b0 + wid * (j + 0.5);
    out.push({ x: ca * s.ux - cb * s.uy, y: ca * s.uy + cb * s.ux, bearing, len, wid });
  }
  return out;
}

// Courts laid out by hand: rows of courts side by side, across the court direction.
function laidOut({ bearing, len, wid, step, rows }) {
  const t = (bearing + 90) * Math.PI / 180;
  return rows.flatMap(([x, y, n]) => Array.from({ length: n }, (_, i) => ({ x: x + i * step * Math.sin(t), y: y + i * step * Math.cos(t), bearing, len, wid })));
}

// Average court direction, as a bearing from 0 to 180 (directions 180° apart are the same court).
function mainAxis(courts) {
  let sx = 0, sy = 0;
  for (const c of courts) { const t = c.bearing * 2 * Math.PI / 180; sx += Math.sin(t); sy += Math.cos(t); }
  return ((Math.atan2(sx, sy) * 180 / Math.PI / 2) + 180) % 180;
}

async function main() {
  console.log('Fetching every tennis court in Cape Town…');
  const mapped = (await overpass(`[out:json][timeout:120];way["leisure"="pitch"]["sport"~"tennis"](${BBOX});out geom;`))
    .filter((w) => w.geometry?.length > 3);
  const centre = (w) => [w.geometry.reduce((a, p) => a + p.lat, 0) / w.geometry.length, w.geometry.reduce((a, p) => a + p.lon, 0) / w.geometry.length];
  const inside = ([lat, lon], g) => {
    let hit = false;
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      if ((g[i].lat > lat) !== (g[j].lat > lat) && lon < (g[j].lon - g[i].lon) * (lat - g[i].lat) / (g[j].lat - g[i].lat) + g[i].lon) hit = !hit;
    }
    return hit;
  };
  const area = (g) => Math.abs(g.reduce((s, p, i) => { const q = g[(i + 1) % g.length]; return s + p.lon * q.lat - q.lon * p.lat; }, 0));
  const allCourts = mapped.filter((w) => !mapped.some((o) => o !== w && area(w.geometry) > 2 * area(o.geometry) && inside(centre(o), w.geometry)));
  const points = Object.values(CLUBS).map((v) => (Array.isArray(v) ? v : v.at));
  const metres = ([a, b], [c, d]) => Math.hypot((a - c) * K, (b - d) * K * Math.cos(a * Math.PI / 180));
  const nearestPoint = (w) => { const c = centre(w); return points.reduce((m, p) => (metres(p, c) < metres(m, c) ? p : m)); };

  const out = {};
  const only = process.argv.slice(2);
  for (const [name, spec0] of Object.entries(CLUBS)) {
    if (only.length && !only.includes(slugify(name))) continue;
    const spec = Array.isArray(spec0) ? { at: spec0 } : spec0;
    const [lat, lon] = spec.at;
    const { xy } = projector(lat, lon);
    const outlines = allCourts.filter((w) => nearestPoint(w) === spec.at).map((w) => {
      const pts = w.geometry.map(xy);
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      return { id: w.id, pts, cx, cy, size: Math.max(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy))) };
    });
    const start = outlines.filter((o) => Math.hypot(o.cx, o.cy) < 300).sort((a, b) => Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy))[0];
    if (!start && !spec.courts) { console.warn(`${name}: no tennis courts mapped within 300 m`); continue; }
    const venue = new Set(spec.courts ? outlines.filter((o) => Math.hypot(o.cx, o.cy) < 120) : [start]);
    for (let grew = !spec.courts; grew;) {
      grew = false;
      for (const o of outlines) {
        if (venue.has(o)) continue;
        if ([...venue].some((v) => Math.hypot(o.cx - v.cx, o.cy - v.cy) - o.size - v.size < LINK)) { venue.add(o); grew = true; }
      }
    }
    const courts0 = spec.courts ? laidOut(spec.courts) : [...venue].flatMap((o) => courtsOf(o.pts));

    // Re-centre on the middle of the courts.
    const mx = courts0.reduce((a, c) => a + c.x, 0) / courts0.length, my = courts0.reduce((a, c) => a + c.y, 0) / courts0.length;
    const [clat, clon] = projector(lat, lon).ll([mx, my]);
    const local = projector(clat, clon);
    const courts = courts0.map((c) => ({ ...c, x: c.x - mx, y: c.y - my }));
    const reach = Math.max(...courts.map((c) => Math.hypot(c.x, c.y) + Math.hypot(c.len, c.wid) / 2));
    const R = Math.max(55, reach + 22) + 10;

    // Surroundings: buildings, roads and other pitches, so people can recognise the place.
    // Fetched a little beyond the map circle so roads passing through it keep their ends.
    await sleep(1500);
    const around = await overpass(`[out:json][timeout:60];(way["building"](around:${Math.round(R * 1.45)},${clat},${clon});way["highway"](around:${Math.round(R * 1.45)},${clat},${clon});way["leisure"="pitch"](around:${Math.round(R * 1.45)},${clat},${clon});way["leisure"="swimming_pool"](around:${Math.round(R * 1.45)},${clat},${clon}););out geom;`);
    const pts = (w) => w.geometry.map(local.xy).map(([x, y]) => [Math.round(x), Math.round(y)]);
    const club = {
      name, lat: +clat.toFixed(6), lon: +clon.toFixed(6), axis: r1(mainAxis(courts)),
      courts: courts.map((c) => [r1(c.x), r1(c.y), r1(c.bearing), r1(c.len), r1(c.wid)]),
      pitches: [], pools: [], buildings: [], roads: [],
    };
    const own = new Set([...venue].map((o) => o.id));
    for (const w of around) {
      const p = pts(w);
      const t = w.tags ?? {};
      if (t.leisure === 'pitch') {
        if (own.has(w.id)) continue;
        club.pitches.push(p);
      } else if (t.leisure === 'swimming_pool') club.pools.push(p);
      else if (t.building) club.buildings.push(p);
      else if (t.highway && !/footway|path|steps|cycleway|track|bridleway|corridor|elevator|proposed|construction/.test(t.highway)) {
        club.roads.push({ k: t.highway === 'service' ? 's' : 'r', n: t.name ?? '', p });
      }
    }
    out[slugify(name)] = club;
    console.log(`${name}: ${courts.length} courts at ${Math.round(club.axis)}°, ${club.buildings.length} buildings, ${club.roads.length} roads`);
  }

  // Keep each club's terrain wind factors (tools/terrain.js); run that again if a club moved.
  const file = path.join(__dirname, '..', 'courts.json');
  let old = {};
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  for (const [slug, c] of Object.entries(out)) if (old[slug]?.terrain) c.terrain = old[slug].terrain;
  const all = only.length ? { ...old, ...out } : out;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify(sorted));
  console.log(`Wrote ${Object.keys(sorted).length} clubs to courts.json (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
