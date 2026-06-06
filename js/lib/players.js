// Helpers for working with Sleeper player data + overlaying rankings.

import { buildRankingLookup } from './match.js';
import { evaluateStartability } from './lineup.js';
import { resolveRankingForLeague } from '../store.js';

// Memoize ranking lookups so we don't re-run fuzzy matching on every render.
const lookupCache = new Map(); // key -> { lookup, diagnostic }

export function getRankingLookup(leagueId, playersMap) {
  const ranking = resolveRankingForLeague(leagueId);
  if (!ranking) return { ranking: null, byPlayerId: new Map(), diagnostic: null };
  const key = `${ranking.source}:${ranking.name}:${ranking.uploadedAt}:${ranking.rows.length}`;
  if (lookupCache.has(key)) {
    const cached = lookupCache.get(key);
    return { ranking, byPlayerId: cached.byPlayerId, diagnostic: cached.diagnostic };
  }
  const { byPlayerId, diagnostic } = buildRankingLookup(ranking.rows, playersMap);
  lookupCache.set(key, { byPlayerId, diagnostic });
  return { ranking, byPlayerId, diagnostic };
}

export function clearLookupCache() {
  lookupCache.clear();
}

export function playerName(playersMap, id) {
  const p = playersMap?.[id];
  if (!p) {
    // Defense/team IDs are non-numeric (e.g. "BUF").
    return /^[A-Z]{2,4}$/.test(id) ? `${id} DEF` : `Player ${id}`;
  }
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id;
}

export function playerPositions(playersMap, id) {
  const p = playersMap?.[id];
  if (!p) return /^[A-Z]{2,4}$/.test(id) ? ['DEF'] : [];
  return p.fantasy_positions || (p.position ? [p.position] : []);
}

// Build an enriched player object combining Sleeper data + ranking + startability.
export function enrichPlayer(id, playersMap, rankingLookup, nflState, riskMode) {
  const p = playersMap?.[id] || {};
  const rankRow = rankingLookup?.get(id) || null;
  const positions = playerPositions(playersMap, id);
  const week = nflState?.display_week;
  const byeWeek = p.bye_week != null ? Number(p.bye_week) : null;
  const onBye = byeWeek != null && week != null && byeWeek === Number(week);
  const injuryStatus = p.injury_status || null;
  const base = {
    playerId: id,
    name: playerName(playersMap, id),
    positions,
    team: p.team || rankRow?.team || '',
    age: p.age ?? null,
    rank: rankRow ? rankRow.rank : null,
    score: rankRow ? rankRow.score : null,
    injuryStatus,
    byeWeek,
    onBye,
  };
  const eval_ = evaluateStartability(base, riskMode);
  return { ...base, ...eval_ };
}

export function enrichRoster(playerIds, playersMap, rankingLookup, nflState, riskMode) {
  return (playerIds || []).map((id) => enrichPlayer(id, playersMap, rankingLookup, nflState, riskMode));
}
