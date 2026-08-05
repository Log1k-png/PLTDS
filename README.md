# PLTDS

Score-evolution charts for players of "La Table des Savoirs" (French daily quiz game).
The site renders three SVG charts per tracked player — cumulative, daily, and average
score over a season — with controls for difficulty, metric, and which players are shown,
plus one-click copy of any chart as an image.

Recon notes on the upstream API live in [RECON_API.md](./RECON_API.md).

## How it works

The app is a static site served by a Cloudflare Pages Worker (`_worker.js`, Advanced Mode).

1. `index.html` loads `app.js` and `style.css` (no build step, no framework).
2. `app.js` calls the site's own `/api/*` routes, which `_worker.js` proxies to
   `https://api.latabledessavoirs.fr/*`, so the browser never talks to the upstream API directly.
3. The worker whitelists the exact static files it serves (`ALLOWED_STATIC`); anything else
   returns 404. To publish a new file (e.g. a new image), add it to that list.

### Files

- `_worker.js` — Cloudflare Pages worker: `/api/*` proxy + static file allowlist.
- `app.js` — all client logic: data fetching, caching, chart rendering, image copy.
- `index.html` — layout and controls.
- `style.css` — responsive styling.
- `favicon.png`, `og-image.png`, `robots.txt`, `sitemap.xml`, `google8cc9053260b18b8f.html` — static site assets.

### Chart features

- Three charts per player: **cumulative** (cumul des points), **daily** (points gagnés), **average**.
- `chartMetric` (`score` | `correct`) switches between points and correct answers.
- `chartDifficulty` (`facile` | `difficile`), per season.
- Toggle players on/off (`chartHidden`) and show/hide the season average
  (`chartAvgBase`: average over **visible** players only, or over **all** players).
- Charts render at container width (`W = max(300, container width)`), height 300,
  with a debounced `resize` handler.
- Y-axis uses a nice step (`10^k × {1,2,2.5,5,10}`) targeting ~9 intervals, max 15 ticks,
  always including 0.
- X-axis labels are dd/MM dates derived from the season's `firstDayDate`.

### Chart image copy

Clicking the copy button renders the SVG to a canvas PNG (scale ≥ 2) and writes it to the
clipboard synchronously inside the click gesture (promise-backed `ClipboardItem`, so it works
on Firefox/Safari too). If the browser can't copy images it falls back to downloading the PNG.

Known limitation: **Android Firefox cannot copy images** (no `image/png` clipboard-write in
GeckoView) — the download fallback is used there.

## Local development

The clipboard API requires HTTPS, so local testing runs behind a `cloudflared` tunnel
pointing at `wrangler pages dev`. The tunnel host is what you open in the browser.

```powershell
npx.cmd wrangler pages dev . --live-reload
cloudflared tunnel --url http://localhost:8788
```

Requests to `/api/*` are resolved by the worker to the real API, so data works locally too.

## Deployment

Deploy the repo root directory (Advanced Mode pages worker). Only the files in the worker's
`ALLOWED_STATIC` list are reachable publicly; `README.md`, `RECON_API.md`, `.git`, `.wrangler`
etc. upload but answer 404.

Commit message convention so far is a short imperative line ("commit no push" triggers a local
commit only).
