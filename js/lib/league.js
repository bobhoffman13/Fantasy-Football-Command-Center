// Shared league-data loading used by multiple league-scoped views.

import { getRosters, getLeagueUsers, getPlayers } from '../api/sleeper.js';
import { getState } from '../store.js';
import { getRankingLookup } from './players.js';

export function findLeague(leagueId) {
  return getState().session.leagues.find((l) => l.league_id === leagueId) || null;
}

// Loads rosters + users + players in parallel and resolves the user's own roster.
export async function loadLeagueContext(leagueId, { onProgress } = {}) {
  const { settings } = getState();
  const league = findLeague(leagueId);
  const [rosters, users, players] = await Promise.all([
    getRosters(leagueId),
    getLeagueUsers(leagueId),
    getPlayers({ onProgress }),
  ]);
  const usersById = {};
  for (const u of users || []) usersById[u.user_id] = u;

  const myRoster = (rosters || []).find((r) => r.owner_id === settings.userId) || null;
  const { ranking, byPlayerId, diagnostic } = getRankingLookup(leagueId, players);

  return {
    league,
    rosters: rosters || [],
    users: users || [],
    usersById,
    players,
    myRoster,
    ranking,
    rankingLookup: byPlayerId,
    diagnostic,
    riskMode: settings.riskMode,
    nflState: getState().session.nflState,
  };
}

export function ownerDisplayName(usersById, ownerId) {
  const u = usersById[ownerId];
  return u?.metadata?.team_name || u?.display_name || u?.username || 'Unknown';
}

// Compute standings array sorted by wins then points-for.
export function computeStandings(rosters, usersById) {
  return (rosters || [])
    .map((r) => {
      const s = r.settings || {};
      const pf = (Number(s.fpts) || 0) + (Number(s.fpts_decimal) || 0) / 100;
      return {
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        owner: ownerDisplayName(usersById, r.owner_id),
        wins: Number(s.wins) || 0,
        losses: Number(s.losses) || 0,
        ties: Number(s.ties) || 0,
        pf,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.pf - a.pf);
}

// Set of all rostered player IDs across a league (for free-agent computation).
export function rosteredPlayerIds(rosters) {
  const set = new Set();
  for (const r of rosters || []) for (const id of r.players || []) set.add(id);
  return set;
}
