# FFCC Companion — Waiver Alert Poller

A tiny Node script that watches your Sleeper leagues and sends a **Pushover** notification
when a highly-ranked free agent (per *your* rankings) becomes available — and when any
player on your **Targets list** hits free agency in any of your leagues.

It runs on your own machine — the web app never needs a server.

## How it works

1. In the web app, go to **Leagues → Waiver Alerts**:
   - Set a per-league rank threshold (e.g. "alert me about anyone ranked ≤ 100").
   - Enter your Pushover **App token** and **User key**.
2. Click **Download config JSON** (`ffcc-alert-config.json`) and **Download script** (or use
   the copy in this folder).
3. Run the script on a schedule.

The app resolves your CSV rankings to Sleeper player IDs *before* export, so the script needs
no name-matching logic — it just compares roster availability against the exported `rankings`
map.

## Requirements

- Node.js 18+ (uses the built-in `fetch`).
- A free [Pushover](https://pushover.net) account + the Pushover app on your phone.

## Run it on GitHub Actions (no always-on machine)

The repo ships a scheduled workflow at [`.github/workflows/waiver-alerts.yml`](../.github/workflows/waiver-alerts.yml)
that runs this script every 15 minutes on GitHub's infrastructure — no server or
home computer required.

1. In the web app, **Download config JSON** as usual.
2. In this repo: **Settings → Secrets and variables → Actions → New repository
   secret**. Name it **`FFCC_ALERT_CONFIG`** and paste the entire contents of
   `ffcc-alert-config.json`. (This keeps your Pushover creds out of the repo.)
3. Make sure the workflow file is on the repo's **default branch** — scheduled
   workflows only fire from there. Use the **Actions** tab → *Waiver Alerts* →
   **Run workflow** to test immediately.

The workflow caches the alert-state and the player list between runs (GitHub
runners are ephemeral), so you still only get alerted **once per player**, and
the big player list is only refetched about once a day. Re-export and update the
`FFCC_ALERT_CONFIG` secret whenever your leagues, thresholds, or rankings change.

Change the cadence by editing the `cron:` line (GitHub's floor is every 5 min,
but scheduled runs are best-effort and often delayed under load).

## Run it

```bash
# from this folder, with ffcc-alert-config.json next to the script
node ffcc-alerts.mjs

# or point at a config elsewhere
node ffcc-alerts.mjs ~/Downloads/ffcc-alert-config.json
```

Schedule it (every 30 min during the season) with cron:

```cron
*/30 * * * * cd /path/to/companion && /usr/bin/node ffcc-alerts.mjs >> ffcc-alerts.log 2>&1
```

State is stored in `.ffcc-alert-state.json` so you're only alerted **once** per player while
they stay available. If a player gets rostered and later dropped again, you'll be re-alerted.

## Exported config format

```jsonc
{
  "version": 1,
  "generatedAt": "2025-09-10T14:00:00.000Z",
  "username": "yourname",
  "userId": "123456789",
  "season": "2025",
  "pushover": { "token": "APP_TOKEN", "user": "USER_KEY" },
  "interest": [
    { "id": "<sleeperPlayerId>", "name": "Player Name", "pos": "WR" }
  ],
  "leagues": [
    {
      "leagueId": "987654321",
      "name": "Dynasty Warriors",
      "threshold": 100,
      "rankings": { "<sleeperPlayerId>": 12, "<sleeperPlayerId>": 47 }
    }
  ]
}
```

- `threshold` — alert when an available player's rank is **≤** this number. May be `null`
  for a league that's only included to watch your Targets list.
- `rankings` — `{ sleeperPlayerId: rank }` resolved from your assigned ranking profile.
  If empty, no rank-based alerts fire for that league (load the league once in the app so its
  players cache, then re-export).
- `interest` — players from your **Targets list** (the config field keeps its original name
  for compatibility). The poller alerts (with a ⭐) whenever one
  of them is *not* rostered in a league, i.e. has hit free agency.

> Your Pushover credentials live in this file. Keep it private; don't commit it.
