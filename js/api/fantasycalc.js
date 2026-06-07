// Public-consensus values from FantasyCalc.
//
// FantasyCalc derives player values from real trades across a large public pool
// of leagues, so it's a good proxy for "what the average public thinks." Crucially
// each entry carries a Sleeper player id, so we map straight onto rosters with no
// name matching.
//
// This is the app's only third-party dependency. It is treated as strictly
// optional: every caller must handle a null result. If the request fails (network,
// CORS, schema drift), the Trade Finder degrades to your own Lifetime Value only.

const BASE = 'https://api.fantasycalc.com/values/current';
const CACHE_MS = 6 * 60 * 60 * 1000; // 6h — consensus moves slowly

const memCache = new Map(); // paramKey -> { ts, map }
const inFlight = new Map(); // paramKey -> Promise

// Map a Sleeper league object + the app's dynasty/redraft flag to FantasyCalc's
// value query. FantasyCalc only accepts ppr of 0 / 0.5 / 1 and numQbs of 1 / 2.
export function leagueToConsensusParams(league, isDynasty) {
  const positions = league?.roster_positions || [];
  const qbSlots = positions.filter((p) => p === 'QB').length;
  const hasSuperflex = positions.includes('SUPER_FLEX') || qbSlots >= 2;
  const rawPpr = Number(league?.scoring_settings?.rec);
  const ppr = !Number.isFinite(rawPpr) ? 1 : rawPpr >= 0.75 ? 1 : rawPpr >= 0.25 ? 0.5 : 0;
  return {
    isDynasty: !!isDynasty,
    numQbs: hasSuperflex ? 2 : 1,
    numTeams: Number(league?.total_rosters) || 12,
    ppr,
  };
}

function paramKey(p) {
  return `${p.isDynasty ? 'dyn' : 'red'}:${p.numQbs}:${p.numTeams}:${p.ppr}`;
}

// TE premium = bonus points per TE reception (Sleeper: scoring_settings.bonus_rec_te).
// FantasyCalc's API has no TE-premium setting, so callers use this to approximate it.
// Returns 0 when the league isn't TE premium.
export function getTePremium(league) {
  const v = Number(league?.scoring_settings?.bonus_rec_te);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Returns Map(sleeperId -> { value, overallRank, positionRank, trend }) or null on
// any failure. Never throws.
export async function getConsensusValues(params) {
  const key = paramKey(params);

  const cached = memCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.map;
  if (inFlight.has(key)) return inFlight.get(key);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return cached ? cached.map : null;
  }

  const url = `${BASE}?isDynasty=${params.isDynasty}&numQbs=${params.numQbs}`
    + `&numTeams=${params.numTeams}&ppr=${params.ppr}`;

  const promise = (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return cached ? cached.map : null;
      const data = await res.json();
      if (!Array.isArray(data)) return cached ? cached.map : null;
      const map = new Map();
      for (const entry of data) {
        const sid = entry?.player?.sleeperId;
        if (!sid) continue;
        map.set(String(sid), {
          value: Number(entry.value) || 0,
          overallRank: Number(entry.overallRank) || null,
          positionRank: Number(entry.positionRank) || null,
          trend: Number(entry.trend30Day) || 0,
        });
      }
      if (!map.size) return cached ? cached.map : null;
      memCache.set(key, { ts: Date.now(), map });
      return map;
    } catch {
      // Network error / CORS / bad JSON — consensus is optional, so swallow it.
      return cached ? cached.map : null;
    }
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
