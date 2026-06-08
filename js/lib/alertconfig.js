// Builds the exported alert config and provides the companion script source.

import { getState } from '../store.js';
import { resolveRankingForLeague } from '../store.js';
import { getCachedPlayersSync } from '../api/sleeper.js';
import { buildRankingLookup } from './match.js';

// Export format (documented in companion/README.md):
// {
//   version, generatedAt, username, userId, season,
//   pushover: { token, user },
//   interest: [ { id, name, pos } ],   // watched players -> alert when any frees up
//   leagues: [
//     { leagueId, name, threshold, rankings: { <sleeperPlayerId>: rank } }
//   ]
// }
export function buildAlertConfig() {
  const { settings, session } = getState();
  const players = getCachedPlayersSync();

  const interestIds = settings.interestPlayers || [];
  const hasInterest = interestIds.length > 0;
  const interest = interestIds.map((id) => {
    const p = players?.[id] || {};
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id;
    const pos = (p.fantasy_positions || (p.position ? [p.position] : [])).join('/');
    return { id, name, pos };
  });

  const leagues = [];
  for (const l of session.leagues) {
    const threshold = settings.thresholds[l.league_id];
    // Include a league if it has a rank threshold, or if there's an interest list to
    // watch (availability is checked per league).
    if (!threshold && !hasInterest) continue;
    let rankings = {};
    if (threshold && players) {
      const ranking = resolveRankingForLeague(l.league_id);
      if (ranking) {
        const { byPlayerId } = buildRankingLookup(ranking.rows, players);
        for (const [id, row] of byPlayerId) rankings[id] = row.rank;
      }
    }
    leagues.push({ leagueId: l.league_id, name: l.name, threshold: threshold || null, rankings });
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    username: settings.username,
    userId: settings.userId,
    season: session.nflState?.season || settings.season,
    pushover: { token: settings.notifCreds.pushoverToken || '', user: settings.notifCreds.pushoverUser || '' },
    interest,
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
  const interest = cfg.interest || [];

  for (const league of cfg.leagues || []) {
    const rosters = await getJson(BASE + '/league/' + league.leagueId + '/rosters');
    const rostered = new Set();
    for (const r of rosters) for (const id of r.players || []) rostered.add(id);

    const hits = [];

    // Rank-based free-agent alerts (only when this league has rankings + a threshold).
    const rankings = league.rankings || {};
    if (league.threshold && Object.keys(rankings).length) {
      for (const [pid, rank] of Object.entries(rankings)) {
        if (rank > league.threshold) continue;
        if (rostered.has(pid)) continue;
        const key = league.leagueId + ':' + pid;
        if (state.alerted[key]) continue; // already alerted while available
        const p = players[pid] || {};
        hits.push({ key, rank, name: p.full_name || pid, pos: (p.fantasy_positions || []).join('/'), interest: false });
      }
    }

    // Interest-list alerts: any watched player available in this league.
    for (const it of interest) {
      if (rostered.has(it.id)) continue;
      const key = league.leagueId + ':int:' + it.id;
      if (state.alerted[key]) continue;
      const p = players[it.id] || {};
      hits.push({ key, rank: null, name: it.name || p.full_name || it.id, pos: it.pos || (p.fantasy_positions || []).join('/'), interest: true });
    }

    // Clear "alerted" flags for players who got rostered again, so future drops re-alert.
    for (const key of Object.keys(state.alerted)) {
      if (!key.startsWith(league.leagueId + ':')) continue;
      const pid = key.split(':').pop();
      if (rostered.has(pid)) delete state.alerted[key];
    }

    // Interest alerts first, then ranked FAs by rank.
    hits.sort((a, b) => (a.interest === b.interest ? ((a.rank ?? 1e9) - (b.rank ?? 1e9)) : (a.interest ? -1 : 1)));
    for (const h of hits) {
      const title = league.name + (h.interest ? ' — Interest Alert' : ' — FA Alert');
      const msg = (h.interest ? '⭐ ' : '#' + h.rank + ' ') + h.name + ' (' + h.pos + ') is available!';
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
