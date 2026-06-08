// Shared trade-value helpers: overlay your Lifetime Value + public consensus onto
// players, and score market arbitrage. Used by the Trade Finder and Interest views so
// both reason about value identically.

import { enrichPlayer } from './players.js';

// Enrich a player id with ranking-derived fields and public consensus. teFactor scales
// TE consensus values to approximate TE premium (1 = no adjustment / not TE premium).
export function describeWithValue(id, ctx, consensus, teFactor = 1) {
  const p = enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
  const c = consensus ? consensus.get(String(id)) || null : null;
  p.consensus = c;
  p.consensusValueAdj = c ? c.value * (p.positions.includes('TE') ? teFactor : 1) : null;
  return p;
}

// Assigns p.arbDelta (publicRank - yourRank, in spots) to every player that has both a
// Lifetime Value and a public value, by ranking the shared pool both ways. Positive =
// you rank a player higher than the market does (you're "high" on them); negative = the
// market is higher. Returns a threshold (scaled to pool size) worth flagging.
export function computeArbitrage(pool) {
  const rated = pool.filter((p) => p.lifetimeValue != null && p.consensusValueAdj != null);
  for (const p of pool) p.arbDelta = null;
  if (rated.length < 4) return Infinity; // too few to compare meaningfully

  const byMine = [...rated].sort((a, b) => b.lifetimeValue - a.lifetimeValue);
  byMine.forEach((p, i) => { p._lvRank = i + 1; });
  const byPublic = [...rated].sort((a, b) => b.consensusValueAdj - a.consensusValueAdj);
  byPublic.forEach((p, i) => { p._pubRank = i + 1; });
  for (const p of rated) p.arbDelta = p._pubRank - p._lvRank;

  return Math.max(5, Math.ceil(rated.length * 0.05));
}
