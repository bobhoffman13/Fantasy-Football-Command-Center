#!/usr/bin/env node
// FFCC waiver alert poller. Reads ffcc-alert-config.json, finds newly-available
// highly-ranked free agents in each league, and pushes a Pushover notification.
//
// Usage:  node ffcc-alerts.mjs [path/to/ffcc-alert-config.json]
// Cron it (e.g. every 30 min during the season). State is kept in .ffcc-alert-state.json
// so you only get alerted once per player.

import fs from 'node:fs/promises';

const CONFIG_PATH = process.argv[2] || './ffcc-alert-config.json';
const STATE_PATH = './.ffcc-alert-state.json';
const BASE = 'https://api.sleeper.app/v1';

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
async function pushover(token, user, title, message) {
  if (!token || !user) { console.log('[no pushover creds] ' + title + ': ' + message); return; }
  const body = new URLSearchParams({ token, user, title, message });
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
  if (!r.ok) console.error('Pushover failed:', r.status, await r.text());
}

async function main() {
  const cfg = await readJson(CONFIG_PATH, null);
  if (!cfg) { console.error('Could not read ' + CONFIG_PATH); process.exit(1); }
  const state = await readJson(STATE_PATH, { alerted: {} });
  const players = await getJson(BASE + '/players/nfl');

  for (const league of cfg.leagues || []) {
    const rankings = league.rankings || {};
    if (!Object.keys(rankings).length) { console.log('No rankings for ' + league.name + ' — skipping.'); continue; }
    const rosters = await getJson(BASE + '/league/' + league.leagueId + '/rosters');
    const rostered = new Set();
    for (const r of rosters) for (const id of r.players || []) rostered.add(id);

    const hits = [];
    for (const [pid, rank] of Object.entries(rankings)) {
      if (rank > league.threshold) continue;
      if (rostered.has(pid)) continue;
      const key = league.leagueId + ':' + pid;
      if (state.alerted[key]) continue; // already alerted while available
      const p = players[pid] || {};
      const name = p.full_name || pid;
      const pos = (p.fantasy_positions || []).join('/');
      hits.push({ pid, key, rank, name, pos });
    }
    // Clear "alerted" flags for players who got rostered again, so future drops re-alert.
    for (const key of Object.keys(state.alerted)) {
      if (!key.startsWith(league.leagueId + ':')) continue;
      const pid = key.split(':')[1];
      if (rostered.has(pid)) delete state.alerted[key];
    }

    hits.sort((a, b) => a.rank - b.rank);
    for (const h of hits) {
      const title = league.name + ' — FA Alert';
      const msg = '#' + h.rank + ' ' + h.name + ' (' + h.pos + ') is available!';
      await pushover(cfg.pushover?.token, cfg.pushover?.user, title, msg);
      state.alerted[h.key] = Date.now();
      console.log('ALERT ' + title + ': ' + msg);
    }
    if (!hits.length) console.log('No new alerts for ' + league.name + '.');
  }

  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
