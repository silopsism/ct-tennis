# Cape Town Tennis League 2026

Live standings and fixture results, read straight from the **Results Entry** tab of the league's Google Sheet each time the page loads (and every 5 minutes while open).

- No build step: `index.html`, `styles.css`, `app.js`.
- The sheet must stay shared as "anyone with the link can view", and the Results Entry tab name and column headers must stay the same.
- Standings are calculated from the results: a fixture counts once scores are entered; win/draw/loss is matches won, then sets won; points come from Home/Away Final Pts (so overrides apply). Ranked on points, then sets difference, then sets for.

- By week view: score shown as matches, sets or points; the wand projects the rest of the season (Bradley–Terry on sets won, walkovers excluded, home edge measured from all results).
- Clubs view: every club's teams across all leagues. The all-clubs table sorts on any column, and ranks clubs on **dominance**. That is each team's share of the league points it could have won (×100), weighted by division. Divisions sit on one ladder per competition. Each overlaps the one above by 20%, 25%, 30%, 40%, 50%, then 60% going down (`DIVISION_OVERLAP`). A division's weight is the height of its middle on that ladder, squared (`WEIGHT_CURVE`). Lower divisions still count, but many weak teams can't outweigh a few strong ones.
- Tapping an upcoming or projected tile lets a viewer enter their own score. It is stored only in that browser (`localStorage`), counts in the standings and projection, and is dropped automatically once the official result is in the sheet.

## Result submissions (salwood only)

`server.js` serves the site and a small API, with no dependencies. On GitHub Pages there's no server, so the Submit button doesn't appear.

- **Captains** go to `#/submit`. They pick their club and team (remembered on the phone), then a fixture from the last 7 days. They enter the score with the score editor, add a photo of the signed sheet (camera or gallery, shrunk on the phone to about 2000 px), and add their name.
- **They get a confirm link** (`#/confirm/<fixture>/<code>`) to send to the other captain, with a WhatsApp button. The other captain confirms it, or marks it disputed with a note.
  - If the other team submits the same score themselves, that counts as confirming it.
  - A different score marks the result disputed.
  - The same team submitting again replaces its earlier entry, which is kept in the history.
- **The admin** goes to `#/admin` and enters the `ADMIN_KEY` to see every submission with its photos. A submission is marked approved there, or removed. It shows the numbers to copy into the Results Entry tab, or ✓/✗ against the sheet once the result is there.
- **On the site**, submitted results count straight away, with a dotted outline and a "Submitted / Confirmed / Approved" tag. Disputed ones don't count. The sheet's result always wins once it's in.
- **Storage:** `DATA_DIR/submissions.json` and `DATA_DIR/photos/`. Locally that's `./data` and the admin key is `dev`.
- **Guards:** fixtures only from the fixture date to 7 days after, the score must fit the division's match count and the best-of-three set range, a photo is required, and each IP address can post at most 30 times an hour.

## Hosting

- https://ctt.salwood.co.za is a Coolify app, behind the Cloudflare Tunnel route `ctt.salwood.co.za` → `http://192.168.3.60:80`.
  - Build pack `dockerfile`: Node running `server.js` on port 80.
  - It needs a persistent storage volume mounted at `/data` and an `ADMIN_KEY` environment variable.
  - To update: push to `main`, then Redeploy in Coolify.
- https://silopsism.github.io/ct-tennis/ is GitHub Pages: the static site only, updated automatically on push.

Run locally with `node server.js` and open http://localhost:8417.
