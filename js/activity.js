// Cross-league activity polling.
//
// Pitfall fixes:
// - Interval is tied to the STABLE set of league IDs (a sorted string), not to any
//   frequently-recreated object. Typing in settings never restarts the poll. (#4 / 6.2)
// - Allowed during 'regular' AND 'post'. (#6)
// - Race guard: each poll captures a token; if the user marks activity seen while a poll
//   is in flight, the completing poll won't resurrect the badge. (6.2)

import { getState, setActivity } from './store.js';
import { getTransactions } from './api/sleeper.js';
import { isActiveSeason } from './lib/format.js';
import { ACTIVITY_POLL_MS } from './data/constants.js';

let timer = null;
let currentKey = '';
let pollToken = 0;
let seenToken = 0; // bumped when user marks seen

export function notifyActivitySeen() {
  seenToken++;
}

async function pollOnce() {
  const myToken = ++pollToken;
  const seenAtStart = seenToken;
  const { session, settings } = getState();
  const nfl = session.nflState;
  if (!nfl || !isActiveSeason(nfl.season_type)) return;
  const leagues = session.leagues;
  if (!leagues.length) return;
  const week = nfl.display_week;

  const results = await Promise.all(
    leagues.map(async (l) => {
      try {
        const tx = await getTransactions(l.league_id, week);
        return (tx || []).map((t) => ({
          id: `${l.league_id}_${t.transaction_id || t.created}`,
          type: t.type,
          status: t.status,
          leagueId: l.league_id,
          leagueName: l.name,
          created: t.created,
          adds: t.adds || null,
          drops: t.drops || null,
          rosterIds: t.roster_ids || [],
        }));
      } catch {
        return [];
      }
    }),
  );

  // Stale-poll guard: a newer poll started, drop this result.
  if (myToken !== pollToken) return;

  const items = results.flat().sort((a, b) => b.created - a.created).slice(0, 60);
  // If the user marked seen while we were fetching, don't resurrect the badge.
  const unseen = seenToken !== seenAtStart
    ? 0
    : items.filter((it) => it.created > (settings.lastSeen[it.leagueId] || 0)).length;
  setActivity(items, unseen);
}

// Start (or restart only if the league set changed) the polling loop.
export function ensureActivityPolling() {
  const { session } = getState();
  const key = session.leagues.map((l) => l.league_id).sort().join(',');
  if (key === currentKey && timer) return; // stable — do nothing
  currentKey = key;
  if (timer) { clearInterval(timer); timer = null; }
  if (!key) return;
  pollOnce();
  timer = setInterval(pollOnce, ACTIVITY_POLL_MS);
}

export function refreshActivityNow() {
  return pollOnce();
}
