// Fuzzy name matching between CSV rankings and Sleeper player data.
//
// Sleeper's player set includes ~11k people — many share a name (e.g. QB "Josh Allen"
// and an offensive lineman "Josh Allen"; RB "Kenneth Walker III" and a WR "Kenneth
// Walker"). So a name alone is ambiguous. We gather every Sleeper player matching a CSV
// name and pick the best one using the CSV row's Position and Team columns, falling back
// to fantasy-relevance. This keeps a star's ranking from landing on the wrong player.

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const FANTASY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

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

// Normalize a position string (CSV "RB12" / "D/ST" or a Sleeper position) to a core code.
function normPos(pos) {
  const a = (pos || '').replace(/[^a-z]/gi, '').toUpperCase();
  if (!a) return '';
  if (a.startsWith('QB')) return 'QB';
  if (a.startsWith('RB')) return 'RB';
  if (a.startsWith('WR')) return 'WR';
  if (a.startsWith('TE')) return 'TE';
  if (a === 'PK' || a === 'K') return 'K';
  if (a.startsWith('DEF') || a.startsWith('DST') || a.startsWith('DS')) return 'DEF';
  return a;
}

function playerMeta(p) {
  const raw = p.fantasy_positions || (p.position ? [p.position] : []);
  const positions = raw.map(normPos).filter(Boolean);
  return {
    positions,
    team: (p.team || '').toUpperCase(),
    fantasy: positions.some((pos) => FANTASY_POS.has(pos)),
    active: p.active !== false,
  };
}

// Build name-key -> [{id, meta}] candidate lists from Sleeper players.
export function buildPlayerIndex(playersMap) {
  const byLower = new Map();
  const byFull = new Map();
  const byInitialLast = new Map();
  const add = (map, key, entry) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  for (const [id, p] of Object.entries(playersMap || {})) {
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const entry = { id, meta: playerMeta(p) };
    add(byLower, lowerKey(name), entry);
    add(byFull, fullKey(name), entry);
    add(byInitialLast, initialLastKey(name), entry);
  }
  return { byLower, byFull, byInitialLast };
}

// Score a candidate against the CSV row's position/team. Position is the strongest
// signal, then team, then general fantasy relevance.
function scoreCandidate(meta, rowPos, rowTeam) {
  let s = 0;
  if (rowPos && meta.positions.includes(rowPos)) s += 200;
  if (rowTeam && meta.team && meta.team === rowTeam) s += 60;
  if (meta.fantasy) s += 50;
  if (meta.active) s += 10;
  return s;
}

// Best candidate from a list. Returns { id, tie } — tie flags an inconclusive top score.
function pickBest(cands, rowPos, rowTeam) {
  let best = null;
  let bestScore = -Infinity;
  let tie = false;
  for (const c of cands) {
    const s = scoreCandidate(c.meta, rowPos, rowTeam);
    if (s > bestScore) { bestScore = s; best = c; tie = false; }
    else if (s === bestScore) tie = true;
  }
  return { id: best ? best.id : null, tie };
}

// Match a single CSV row (or bare name) to a Sleeper player_id, or null.
export function matchName(row, index) {
  const r = typeof row === 'string' ? { name: row } : (row || {});
  if (!r.name) return null;
  const rowPos = normPos(r.pos);
  const rowTeam = (r.team || '').toUpperCase();

  // Tiers 1+2 merged: exact-lowercase and suffix-stripped candidates, deduped by id.
  // Merging means a suffix-stripped match (Kenneth Walker III) competes with an exact
  // match (a different Kenneth Walker), and Position/Team decides between them.
  const merged = new Map();
  for (const list of [index.byLower.get(lowerKey(r.name)), index.byFull.get(fullKey(r.name))]) {
    if (list) for (const c of list) if (!merged.has(c.id)) merged.set(c.id, c);
  }
  if (merged.size) {
    const { id } = pickBest([...merged.values()], rowPos, rowTeam);
    if (id) return id;
  }

  // Tier 3: first-initial + last-name, restricted to fantasy-relevant players, and only
  // when it resolves unambiguously (don't make a wild guess on a common name).
  const ik = initialLastKey(r.name);
  const ikCands = ik ? (index.byInitialLast.get(ik) || []).filter((c) => c.meta.fantasy) : [];
  if (ikCands.length === 1) return ikCands[0].id;
  if (ikCands.length > 1) {
    const { id, tie } = pickBest(ikCands, rowPos, rowTeam);
    if (id && !tie) return id;
  }
  return null;
}

// Match an entire ranking profile against Sleeper players.
// Returns a Map(player_id -> {rank, name, pos, team, score}) and a diagnostic.
export function buildRankingLookup(rankingRows, playersMap) {
  const index = buildPlayerIndex(playersMap);
  const byPlayerId = new Map();
  const unmatched = [];
  for (const row of rankingRows) {
    const id = matchName(row, index);
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
