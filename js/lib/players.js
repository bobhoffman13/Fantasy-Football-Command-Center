// Helpers for working with Sleeper player data + overlaying rankings.

import { buildRankingLookup } from './match.js';
import { evaluateStartability } from './lineup.js';
import { resolveRankingForLeague, resolveWeeklyForLeague } from '../store.js';

// Memoize ranking lookups so we don't re-run fuzzy matching on every render.
const lookupCache = new Map(); // key -> { lookup, diagnostic }
const weeklyCache = new Map(); // key -> { byPlayerId, diagnostic }

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

// Weekly rankings for a league, or null. Kept separate from the season lookup so
// that only the Lineup tab (which asks for it explicitly) can ever see it.
export function getWeeklyLookup(leagueId, playersMap) {
  const weekly = resolveWeeklyForLeague(leagueId);
  if (!weekly) return null;
  const key = `${weekly.set.id}:${weekly.uploadedAt}:${weekly.rows.length}`;
  let entry = weeklyCache.get(key);
  if (!entry) {
    entry = buildRankingLookup(weekly.rows, playersMap);
    weeklyCache.set(key, entry);
  }
  return { ...weekly, byPlayerId: entry.byPlayerId, diagnostic: entry.diagnostic };
}

// How much of YOUR roster this week's file actually covers.
//
// The season-long diagnostic reports matched CSV rows over total CSV rows, which is
// the wrong question for weekly rankings: a weekly file lists a few hundred players
// league-wide, so a perfectly good file scores badly and trips the low-match warning.
// What matters for a lineup is whether the players you actually roster got a
// projection, so that is what this measures.
export function weeklyRosterCoverage(playerIds, byPlayerId, playersMap) {
  const ids = playerIds || [];
  const missing = [];
  let covered = 0;
  for (const id of ids) {
    if (byPlayerId?.has(id)) covered++;
    else missing.push({ playerId: id, name: playerName(playersMap, id), positions: playerPositions(playersMap, id) });
  }
  return { total: ids.length, covered, rate: ids.length ? covered / ids.length : 0, missing };
}

export function clearLookupCache() {
  lookupCache.clear();
  weeklyCache.clear();
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
export function enrichPlayer(id, playersMap, rankingLookup, nflState, riskMode, weeklyLookup = null) {
  const p = playersMap?.[id] || {};
  const rankRow = rankingLookup?.get(id) || null;
  const weeklyRow = weeklyLookup?.get(id) || null;
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
    lifetimeValue: rankRow && rankRow.lifetimeValue != null ? rankRow.lifetimeValue : null,
    lifetimeValueChange: rankRow && rankRow.lifetimeValueChange != null ? rankRow.lifetimeValueChange : null,
    injuryStatus,
    byeWeek,
    onBye,
    // Real-world context straight from Sleeper, used by the Home action plan to
    // justify recommendations with actual NFL usage rather than rankings alone.
    depthChartPosition: p.depth_chart_position || null,
    depthChartOrder: p.depth_chart_order != null ? Number(p.depth_chart_order) : null,
    yearsExp: p.years_exp != null ? Number(p.years_exp) : null,
    nflStatus: p.status || null,
    // This week's projection and matchup, when a weekly set applies. `rank` above
    // stays the season ranking so both numbers can be shown side by side.
    weekly: weeklyRow ? {
      rank: weeklyRow.rank,
      pos: weeklyRow.pos || '',
      posRank: weeklyRow.posRank,
      proj: weeklyRow.proj,
      opponent: weeklyRow.opponent || '',
      oppRankVsPos: weeklyRow.oppRankVsPos,
      impliedTotal: weeklyRow.impliedTotal,
    } : null,
  };
  const eval_ = evaluateStartability(base, riskMode);
  return { ...base, ...eval_ };
}

export function enrichRoster(playerIds, playersMap, rankingLookup, nflState, riskMode, weeklyLookup = null) {
  return (playerIds || []).map((id) => enrichPlayer(id, playersMap, rankingLookup, nflState, riskMode, weeklyLookup));
}
