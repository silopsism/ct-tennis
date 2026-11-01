# Cape Town Tennis League 2026

Live standings and fixture results, read straight from the **Results Entry** tab of the league's Google Sheet each time the page loads (and every 5 minutes while open).

- No build step: `index.html`, `styles.css`, `app.js`.
- The sheet must stay shared as "anyone with the link can view", and the Results Entry tab name and column headers must stay the same.
- Standings are calculated from the results: a fixture counts once scores are entered; win/draw/loss is matches won, then sets won; points come from Home/Away Final Pts (so overrides apply). Ranked on points, then sets difference, then sets for.

- By week view: score shown as matches, sets or points; the wand projects the rest of the season (Bradley–Terry on sets won, walkovers excluded, home edge measured from all results).
- Clubs view: every club's teams across all leagues. The all-clubs table sorts on any column, and ranks clubs on **dominance**. That is each team's share of the league points it could have won (×100), weighted by division. Divisions sit on one ladder per competition. Each overlaps the one above by 20%, 25%, 30%, 40%, 50%, then 60% going down (`DIVISION_OVERLAP`). A division's weight is the height of its middle on that ladder, squared (`WEIGHT_CURVE`). Lower divisions still count, but many weak teams can't outweigh a few strong ones.
- Tapping an upcoming or projected tile lets a viewer enter their own score. It is stored only in that browser (`localStorage`), counts in the standings and projection, and is dropped automatically once the official result is in the sheet.

## Hosting

- https://ctt.salwood.co.za — Coolify app (build pack `dockerfile`: nginx serving the three files), behind the Cloudflare Tunnel route `ctt.salwood.co.za` → `http://192.168.3.60:80`. To update: push to `main`, then Redeploy in Coolify.
- https://silopsism.github.io/ct-tennis/ — GitHub Pages, updates automatically on push.

Run locally with `python -m http.server` and open http://localhost:8000.
