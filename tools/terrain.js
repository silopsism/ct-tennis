// Adds terrain wind factors to courts.json: how much of the open-water wind reaches each club's courts,
// for each of 16 wind directions. Run with `node tools/terrain.js` after tools/courts.js. No dependencies.
//
// The factors come from the Cape Town Wind Explorer (https://wind-analyzer.pages.dev/), a terrain wind model
// of the peninsula (75 m around the Table Mountain chain, 200 m elsewhere). For each direction it gives the
// street-level wind for a strong blow (the windiest 10% of hours) arriving over False Bay. Dividing by that
// inflow gives a factor; the app multiplies it by the day's forecast at the same open-water point.
//
// Per club and direction it stores [wind, gust, turn]:
//   wind  street-level mean wind / open-water wind
//   gust  street-level gust / open-water gust (the model's gust over its inflow gust)
//   turn  how many degrees the terrain swings the wind (local "from" direction minus the open-water one)
// Each is averaged over a 150 m circle around the courts, so one odd grid cell doesn't decide it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://wind-analyzer.pages.dev/data';
const CACHE = path.join(os.tmpdir(), 'ct-tennis-terrain');
const FILE = process.argv[2] ?? path.join(__dirname, '..', 'courts.json');
const RING = [[0, 0]]; // sample offsets in metres: the centre, then rings at 75 m and 150 m
for (const r of [75, 150]) for (let k = 0; k < 8; k++) RING.push([r * Math.sin(k * Math.PI / 4), r * Math.cos(k * Math.PI / 4)]);

async function get(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  if (!fs.existsSync(file)) {
    const res = await fetch(`${BASE}/${name}`, { headers: { 'User-Agent': 'ct-tennis terrain sampler' } });
    if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A quantised field (bytes 0-255 between min and max), sampled bilinearly at a lat/lon.
function sampler(dom, bbox) {
  const [ny, nx] = dom.shape;
  const fields = {};
  for (const [k, f] of Object.entries(dom.fields)) fields[k] = { min: f.min, s: (f.max - f.min) / 255, u: Buffer.from(f.b64, 'base64') };
  return {
    has: (lat, lon) => lat > bbox.lat_min && lat < bbox.lat_max && lon > bbox.lon_min && lon < bbox.lon_max,
    at(name, lat, lon) {
      const f = fields[name];
      const x = Math.min(Math.max((lon - bbox.lon_min) / (bbox.lon_max - bbox.lon_min) * nx - 0.5, 0), nx - 1.001);
      const y = Math.min(Math.max((lat - bbox.lat_min) / (bbox.lat_max - bbox.lat_min) * ny - 0.5, 0), ny - 1.001);
      const x0 = Math.floor(x), y0 = Math.floor(y), dx = x - x0, dy = y - y0, i = y0 * nx + x0;
      const v = (j) => f.min + f.u[j] * f.s;
      return v(i) * (1 - dx) * (1 - dy) + v(i + 1) * dx * (1 - dy) + v(i + nx) * (1 - dx) * dy + v(i + nx + 1) * dx * dy;
    },
  };
}

async function main() {
  const clubs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const stat = await get('static.json');
  for (const c of Object.values(clubs)) c.terrain = [];
  for (let dir = 0; dir < 16; dir++) {
    const run = await get(`run_${String(dir).padStart(2, '0')}_strong.json`);
    const { meta } = run;
    // The finer grid where it covers the club, the metro grid elsewhere.
    const grids = ['detail', 'region'].map((n) => sampler(run.domains[n], stat.domains[n].bbox));
    for (const c of Object.values(clubs)) {
      const kx = 111320 * Math.cos(c.lat * Math.PI / 180);
      let sp = 0, gu = 0, u = 0, v = 0;
      for (const [dx, dy] of RING) {
        const lat = c.lat + dy / 111320, lon = c.lon + dx / kx;
        const g = grids.find((s) => s.has(lat, lon));
        sp += g.at('speed10', lat, lon);
        gu += g.at('gust', lat, lon);
        u += g.at('u10', lat, lon);
        v += g.at('v10', lat, lon);
      }
      sp /= RING.length; gu /= RING.length;
      const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
      const turn = ((from - meta.dir_deg) % 360 + 540) % 360 - 180;
      c.terrain.push([+(sp / meta.speed_10m).toFixed(2), +(gu / (meta.speed_10m * meta.gust_factor)).toFixed(2), Math.round(turn)]);
    }
    console.log(`${meta.dir_label}: done`);
  }
  fs.writeFileSync(FILE, JSON.stringify(clubs));
  const show = (c) => `${c.name.padEnd(16)} SE ${c.terrain[6][0].toFixed(2)}  NW ${c.terrain[14][0].toFixed(2)}`;
  console.log(Object.values(clubs).map(show).join('\n'));
}

main().catch((err) => { console.error(err); process.exit(1); });
