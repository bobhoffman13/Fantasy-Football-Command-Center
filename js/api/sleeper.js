// Sleeper API client.
// - One shared fetch primitive with in-flight DEDUP (double-tap => single request).
// - 5-minute in-memory cache on normal GETs.
// - 24-hour IndexedDB + in-memory cache for the ~3MB /players/nfl payload.
// - Graceful errors; offline awareness.

import { idbGet, idbSet } from '../lib/idb.js';
import { GET_CACHE_MS, PLAYERS_CACHE_MS, SEASON_FALLBACK } from '../data/constants.js';

const BASE = 'https://api.sleeper.app/v1';

const memCache = new Map(); // url -> { ts, data }
const inFlight = new Map(); // url -> Promise

export class ApiError extends Error {
  constructor(message, { status, offline } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = offline;
  }
}

// Core GET with dedup + short cache. cacheMs=0 disables caching.
async function get(path, { cacheMs = GET_CACHE_MS, allow404Null = false } = {}) {
  const url = `${BASE}${path}`;

  const cached = memCache.get(url);
  if (cached && Date.now() - cached.ts < cacheMs) return cached.data;

  if (inFlight.has(url)) return inFlight.get(url);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (cached) return cached.data; // stale-but-better-than-nothing
    throw new ApiError('You appear to be offline.', { offline: true });
  }

  const promise = (async () => {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      if (cached) return cached.data;
      throw new ApiError('Network error reaching Sleeper. Check your connection.', { offline: true });
    }
    if (res.status === 404) {
      if (allow404Null) return null;
      throw new ApiError('Not found.', { status: 404 });
    }
    if (!res.ok) {
      throw new ApiError(`Sleeper API error (${res.status}). Try again shortly.`, { status: res.status });
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError('Sleeper returned an unexpected response.');
    }
    if (cacheMs > 0) memCache.set(url, { ts: Date.now(), data });
    return data;
  })();

  inFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(url);
  }
}

export function clearMemCache() {
  memCache.clear();
}

// --- Endpoints ---

export async function getUser(username) {
  const trimmed = (username || '').trim(); // mobile keyboards add trailing spaces
  if (!trimmed) throw new ApiError('Please enter a username.');
  const data = await get(`/user/${encodeURIComponent(trimmed)}`, { allow404Null: true });
  if (!data || !data.user_id) throw new ApiError(`No Sleeper user named "${trimmed}".`);
  return data;
}

export function getLeagues(userId, season = SEASON_FALLBACK) {
  return get(`/user/${userId}/leagues/nfl/${season}`);
}

export function getRosters(leagueId) {
  return get(`/league/${leagueId}/rosters`);
}

export function getLeagueUsers(leagueId) {
  return get(`/league/${leagueId}/users`);
}

export function getMatchups(leagueId, week) {
  return get(`/league/${leagueId}/matchups/${week}`);
}

export function getTransactions(leagueId, week) {
  return get(`/league/${leagueId}/transactions/${week}`);
}

// NFL state with calendar fallback if the call fails.
export async function getNflState() {
  try {
    const s = await get('/state/nfl', { cacheMs: 30 * 60 * 1000 });
    if (s && s.season) return s;
  } catch { /* fall through to calendar fallback */ }
  return calendarFallbackState();
}

function calendarFallbackState() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0=Jan
  // Rough NFL calendar: season runs Sep–Jan.
  let season_type = 'off';
  if (month === 8) season_type = 'regular';
  else if (month >= 9 && month <= 11) season_type = 'regular';
  else if (month === 0) season_type = 'post';
  else if (month === 7) season_type = 'pre';
  // Approximate week: NFL Week 1 ~ first Thursday of September.
  let display_week = 1;
  if (season_type === 'regular' || season_type === 'post') {
    const sept1 = new Date(year, 8, 1);
    const weeks = Math.floor((now - sept1) / (7 * 24 * 60 * 60 * 1000));
    display_week = Math.min(Math.max(weeks, 1), 18);
  }
  const season = month === 0 ? String(year - 1) : String(year);
  return { season, display_week, season_type, _fallback: true };
}

// --- Players (3MB) with aggressive caching ---

let playersMem = null; // { data, fetchedAt }

export async function getPlayers({ force = false, onProgress } = {}) {
  if (!force && playersMem && Date.now() - playersMem.fetchedAt < PLAYERS_CACHE_MS) {
    return playersMem.data;
  }
  if (!force) {
    const stored = await idbGet('playerCache');
    if (stored && stored.data && Date.now() - stored.fetchedAt < PLAYERS_CACHE_MS) {
      playersMem = stored;
      return stored.data;
    }
  }
  if (onProgress) onProgress('Downloading NFL player database (~3MB)…');
  // Bypass the short GET cache; this is large and self-cached.
  const data = await get('/players/nfl', { cacheMs: 0 });
  playersMem = { data, fetchedAt: Date.now() };
  idbSet('playerCache', playersMem); // fire and forget
  return data;
}

export function getCachedPlayersSync() {
  return playersMem?.data || null;
}
