# 🏈 Fantasy Football Command Center

A mobile-first, single-user web app for managing all your **Sleeper** fantasy football leagues
from one place — with **your own player rankings** (CSV) overlaid onto every roster, free agent,
and lineup decision.

No backend, no database, no login. It's a pure client-side app that makes live calls to the
public Sleeper API straight from the browser.

---

## Run it locally (one command)

You only need Python (preinstalled on Mac/Linux). From this folder:

```bash
python3 -m http.server 8000
```

Then open **http://localhost:8000** in a real browser.

> It must run in a real browser (not a sandboxed preview) because it makes live network
> calls to `https://api.sleeper.app`. Any static file server works — e.g.
> `npx serve` or VS Code "Live Server".

## Use it on your iPhone

1. Deploy it (below) or serve it on your network, then open the URL in **Safari**.
2. Tap the **Share** button → **Add to Home Screen**.
3. It launches full-screen like a native app (it's a PWA).

## Deploy to a static host

This is plain static files — deploy the whole folder as-is.

- **Vercel:** import the repo (no build step). `vercel.json` is already set for static output.
- **Netlify:** drag-and-drop the folder, or connect the repo. No build command, publish dir `.`.
- **GitHub Pages:** push to a repo, enable Pages on the branch root.

---

## First-time setup (in the app)

1. **Setup → Sleeper account:** enter your username, pick the season, **Connect**.
2. **Setup → Leagues:** mark each league as *dynasty/redraft* and *commish* where relevant.
3. **Setup → Ranking profiles:** create a named profile (e.g. "Dynasty PPR"), choose a type,
   and upload your rankings CSV. Assign a profile to each league (assignments are independent —
   assigning one league never affects another).
4. **Setup → Lineup risk tolerance:** choose how Questionable players are treated by the optimizer.

### Rankings CSV format

Export from PlayerProfiler or any source. The parser auto-detects comma/semicolon, handles
quotes, and flexibly maps columns:

| Field | Accepted column names | Required |
|-------|----------------------|----------|
| Name | `player`, `name`, `player_name`, `full_name` | ✅ |
| Rank | `overall_rank`, `rank`, `overall` (falls back to row order) | |
| Position | `position`, `pos` | |
| Team | `team`, `nfl_team` | |
| Score | `composite_score`, `score`, `pp_score`, `composite` | |

Names are fuzzy-matched to Sleeper players. Every view that overlays rankings shows a
**match diagnostic** (`X% matched`); below ~80% you'll get a prominent warning with sample
unmatched names so you know your CSV is out of sync.

---

## Features

- **Home** — league counts, season/week, rankings status & staleness, quick nav.
- **Leagues**
  - *My Roster* — grouped by position, ranking tiers, injury/bye badges, watch list.
  - *Matchup* — your score vs opponent (works in regular **and** playoffs), pick any week.
  - *Free Agents* — ranked, position filter, debounced search, FAAB/waiver indicator, alert toggle.
  - *Lineup* — optimal lineup with full flex eligibility (incl. SUPER_FLEX) + injury/bye risk modes.
  - *Waiver Alerts* — per-league rank thresholds + export config for the companion script.
  - *Overview* — per-league record/standing/playoff status + cross-league activity feed (with names).
- **Commish** — message templates (auto-filled tokens + unfilled-placeholder guard) and dues tracking.
- **Tools** — playoff race (with playoff line + clinch estimate) and draft scheduling tools.
- **Setup** — account, league config, ranking profiles, risk tolerance, full data wipe.

## Push notifications (optional)

See [`companion/README.md`](./companion/README.md) — a small Node + Pushover script that alerts
you when a highly-ranked free agent appears. Configure it under **Leagues → Waiver Alerts**.

---

## Architecture (no build step)

```
index.html            App shell + PWA meta
app.webmanifest       Installable PWA manifest
css/styles.css        Mobile-first dark theme
js/
  main.js             Bootstrap, router, error boundary, app shell
  store.js            Observable store (channel-scoped subs; immutable map updates)
  router.js           Hash router
  activity.js         Cross-league transaction polling (stable-deps, race-guarded)
  api/sleeper.js      Sleeper client (in-flight dedup, 5-min cache, 24h player cache)
  lib/                csv, fuzzy match, lineup optimizer, idb, players, league, format, dom
  data/               constants, message templates
  views/              home, leagues(+roster/matchup/freeagents/lineup/waivers/overview), commish, tools, setup
companion/            Node + Pushover alert script
```

**Persistence:** `localStorage` for settings/config/dues; `IndexedDB` for the 3MB player cache
and ranking profiles. *Setup → Clear all data* wipes both completely.

State is intentionally simple: nested maps (league types, profile assignments, thresholds, dues)
are only ever updated through a single immutable add/update/delete primitive, so multi-league
assignment is additive and deletion is unambiguous.
