// Builds the exported alert config and provides the companion script source.

import { getState } from '../store.js';
import { resolveRankingForLeague } from '../store.js';
import { getCachedPlayersSync } from '../api/sleeper.js';
import { buildRankingLookup } from './match.js';

// Export format (documented in companion/README.md):
// {
//   version, generatedAt, username, userId, season,
//   pushover: { token, user },
//   leagues: [
//     { leagueId, name, threshold, rankings: { <sleeperPlayerId>: rank } }
//   ]
// }
export function buildAlertConfig() {
  const { settings, session } = getState();
  const players = getCachedPlayersSync();
  const leagues = [];
  for (const l of session.leagues) {
    const threshold = settings.thresholds[l.league_id];
    if (!threshold) continue; // only export leagues with an alert threshold set
    const ranking = resolveRankingForLeague(l.league_id);
    let rankings = {};
    if (ranking && players) {
      const { byPlayerId } = buildRankingLookup(ranking.rows, players);
      for (const [id, row] of byPlayerId) rankings[id] = row.rank;
    }
    leagues.push({ leagueId: l.league_id, name: l.name, threshold, rankings });
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    username: settings.username,
    userId: settings.userId,
    season: session.nflState?.season || settings.season,
    pushover: { token: settings.notifCreds.pushoverToken || '', user: settings.notifCreds.pushoverUser || '' },
    leagues,
  };
}

// Companion Node script (ESM). Mirrors companion/ffcc-alerts.mjs so the in-app
// download matches the repo copy.
export const ALERT_SCRIPT = `#!/usr/bin/env node
// FFCC waiver alert poller. Reads ffcc-alert-config.json, finds newly-available
// highly-ranked free agents in each league, and pushes a Pushover notification.
//
// Usage:  node ffcc-alerts.mjs [path/to/ffcc-alert-config.json]
// Cron it (e.g. every 15 min during the season). State is kept in .ffcc-alert-state.json
// so you only get alerted once per player. The large NFL player list is cached in
// .ffcc-players-cache.json and only refreshed about once a day, so frequent polling
// only does the cheap per-league roster fetch (and stays friendly to Sleeper's API).

import fs from 'node:fs/promises';

const CONFIG_PATH = process.argv[2] || './ffcc-alert-config.json';
const STATE_PATH = './.ffcc-alert-state.json';
const PLAYERS_PATH = './.ffcc-players-cache.json';
const PLAYERS_MAX_AGE_MS = 18 * 60 * 60 * 1000; // refresh the big player list ~once a day
const BASE = 'https://api.sleeper.app/v1';

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
// Sleeper asks that /players/nfl be fetched at most ~once a day (it's multi-MB), so
// cache it to disk and reuse until it ages out.
async function getPlayers() {
  const cached = await readJson(PLAYERS_PATH, null);
  if (cached && cached.players && cached.fetchedAt && (Date.now() - cached.fetchedAt) < PLAYERS_MAX_AGE_MS) {
    return cached.players;
  }
  const players = await getJson(BASE + '/players/nfl');
  await fs.writeFile(PLAYERS_PATH, JSON.stringify({ fetchedAt: Date.now(), players }));
  return players;
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
  const players = await getPlayers();

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
`;
