// Fuzzy name matching between CSV rankings and Sleeper player data.

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Lowercase + strip apostrophes/smart quotes/periods. Tier-1 key.
function lowerKey(name) {
  return name
    .toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Full normalization: also drop suffixes and all non-alphanumerics. Tier-2 key.
function fullKey(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter((t) => t && !SUFFIXES.has(t));
  return tokens.join('');
}

// Last-resort heuristic key: first initial + last token.
function initialLastKey(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter((t) => t && !SUFFIXES.has(t));
  if (tokens.length < 2) return null;
  return tokens[0][0] + tokens[tokens.length - 1];
}

// Build lookup indexes from Sleeper players map { player_id: {full_name, ...} }.
// Only includes fantasy-relevant players to avoid noise.
export function buildPlayerIndex(playersMap) {
  const byLower = new Map();
  const byFull = new Map();
  const byInitialLast = new Map();
  for (const [id, p] of Object.entries(playersMap || {})) {
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const lk = lowerKey(name);
    const fk = fullKey(name);
    const ik = initialLastKey(name);
    if (lk && !byLower.has(lk)) byLower.set(lk, id);
    if (fk && !byFull.has(fk)) byFull.set(fk, id);
    // initial-last is ambiguous; only keep if unique
    if (ik) {
      if (byInitialLast.has(ik)) byInitialLast.set(ik, null); // mark ambiguous
      else byInitialLast.set(ik, id);
    }
  }
  return { byLower, byFull, byInitialLast };
}

// Match a single CSV name to a Sleeper player_id, or null.
export function matchName(name, index) {
  const lk = lowerKey(name);
  if (index.byLower.has(lk)) return index.byLower.get(lk);
  const fk = fullKey(name);
  if (index.byFull.has(fk)) return index.byFull.get(fk);
  const ik = initialLastKey(name);
  if (ik && index.byInitialLast.get(ik)) return index.byInitialLast.get(ik);
  return null;
}

// Match an entire ranking profile against Sleeper players.
// Returns a Map(player_id -> {rank, name, pos, team, score}) and a diagnostic.
export function buildRankingLookup(rankingRows, playersMap) {
  const index = buildPlayerIndex(playersMap);
  const byPlayerId = new Map();
  const unmatched = [];
  for (const row of rankingRows) {
    const id = matchName(row.name, index);
    if (id) {
      // Keep the best (lowest) rank if a duplicate id appears.
      const existing = byPlayerId.get(id);
      if (!existing || row.rank < existing.rank) byPlayerId.set(id, row);
    } else {
      unmatched.push(row.name);
    }
  }
  const total = rankingRows.length;
  const matched = total - unmatched.length;
  return {
    byPlayerId,
    diagnostic: {
      total,
      matched,
      rate: total ? matched / total : 0,
      unmatched,
    },
  };
}
