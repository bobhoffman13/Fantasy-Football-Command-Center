// Draft-room strategy: rank the best *pick* (not just best player) using your rankings
// plus live game theory — your roster needs, positional scarcity/runs across the league,
// and whether a player will even survive to your next pick.
//
// Pure + deterministic so it can be unit-tested. draft.js gathers the live inputs.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Starting-lineup demand per position from Sleeper roster_positions, folding FLEX/SUPERFLEX
// into the positions that fill them. Falls back to a standard 1QB/2RB/2WR/1TE/FLEX league.
export function starterTargets(rosterPositions) {
  if (!rosterPositions || !rosterPositions.length) {
    return { QB: 1, RB: 2.5, WR: 2.5, TE: 1, K: 1, DEF: 1 };
  }
  const c = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0, superflex = 0;
  for (const slot of rosterPositions) {
    if (c[slot] != null) c[slot]++;
    else if (slot === 'SUPER_FLEX' || slot === 'SUPERFLEX' || slot === 'QB_FLEX') superflex++;
    else if (/FLEX|WRRB|REC_FLEX/.test(slot)) flex++;
  }
  return {
    QB: c.QB + superflex,      // SF/2QB leagues want a second QB
    RB: c.RB + flex * 0.5,     // RB/WR share flex demand
    WR: c.WR + flex * 0.5,
    TE: c.TE,
    K: c.K,
    DEF: c.DEF,
  };
}

// Recommend the top picks. See module header for the model.
// input: {
//   available,        // enriched players, sorted by rank asc; each has {playerId,name,rank,lifetimeValue,positions,pos,team}
//   myCounts,         // { POS: count } your roster (existing + drafted)
//   targets,          // starterTargets() output
//   leagueDemand,     // { POS: # of OTHER teams still below their starter target }
//   recentPositions,  // [POS,...] of the last N picks (run detection)
//   picksUntilNext,   // number | null (from the trade-aware projection)
//   teamsCount,       // league size
// }
export function recommendDraftPicks(input) {
  const {
    available = [], myCounts = {}, targets = {}, leagueDemand = {},
    recentPositions = [], picksUntilNext = null, teamsCount = 12,
    candidatePool = 24, weights = { value: 0.45, need: 0.2, scarcity: 0.15, urgency: 0.2 },
  } = input || {};
  if (!available.length) return [];

  const pool = available.slice(0, candidatePool);
  const useLV = pool[0].lifetimeValue != null;
  const valueOf = (p) => (useLV ? (p.lifetimeValue ?? 0) : -(p.rank ?? 9999));

  const vals = pool.map(valueOf);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const valueNorm = (p) => (maxV > minV ? (valueOf(p) - minV) / (maxV - minV) : 1);

  // Per-position available lists (for tier-cliff detection) + typical value gap.
  const byPos = {};
  for (const p of available) (byPos[p.pos] ||= []).push(p);
  const medianGap = {};
  for (const pos of Object.keys(byPos)) {
    const list = byPos[pos];
    const gaps = [];
    for (let i = 0; i < list.length - 1; i++) gaps.push(Math.abs(valueOf(list[i]) - valueOf(list[i + 1])));
    gaps.sort((a, b) => a - b);
    medianGap[pos] = gaps.length ? (gaps[Math.floor(gaps.length / 2)] || 1) : 1;
  }
  const cliff = (p) => {
    const list = byPos[p.pos] || [];
    const idx = list.indexOf(p);
    const next = list[idx + 1];
    if (!next) return 1; // last one available at the position
    return clamp(Math.abs(valueOf(p) - valueOf(next)) / (2 * (medianGap[p.pos] || 1)), 0, 1);
  };
  const runScore = (pos) => (recentPositions.length ? clamp(recentPositions.filter((x) => x === pos).length / recentPositions.length, 0, 1) : 0);
  const demandScore = (pos) => (teamsCount ? clamp((leagueDemand[pos] || 0) / teamsCount, 0, 1) : 0);
  const needScore = (pos) => {
    const req = targets[pos] || 0;
    if (req <= 0) return 0;
    return clamp((req - (myCounts[pos] || 0)) / req, 0, 1);
  };

  const rankIdx = new Map(available.map((p, i) => [p.playerId, i])); // 0-based board position
  const urgency = (p) => {
    if (picksUntilNext == null) return 0.5; // can't project — neutral
    const risk = picksUntilNext - (rankIdx.get(p.playerId) ?? 0); // >0 => likely gone before your pick
    return clamp(0.5 + risk / (2 * (teamsCount || 12)), 0, 1);
  };

  const scored = pool.map((p) => {
    const value = valueNorm(p);
    const need = needScore(p.pos);
    const scarcity = clamp(0.5 * cliff(p) + 0.25 * runScore(p.pos) + 0.25 * demandScore(p.pos), 0, 1);
    const urg = urgency(p);
    const score = weights.value * value + weights.need * need + weights.scarcity * scarcity + weights.urgency * urg;
    return { player: p, score, components: { value, need, scarcity, urgency: urg } };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  for (const s of top) s.reasons = buildReasons(s, { myCounts, targets, picksUntilNext });
  return top;
}

function buildReasons(s, { myCounts, targets, picksUntilNext }) {
  const p = s.player, c = s.components;
  const out = [`#${p.rank} available${p.lifetimeValue != null ? `, LV ${Math.round(p.lifetimeValue).toLocaleString()}` : ''}`];
  const drivers = [
    { v: c.need, txt: () => `fills ${p.pos} need (${myCounts[p.pos] || 0}/${Math.round(targets[p.pos] || 0)} starters)` },
    { v: c.urgency, txt: () => (picksUntilNext ? 'likely gone by your next pick' : 'best on the board') },
    { v: c.scarcity, txt: () => `${p.pos} tier is thinning` },
  ].filter((d) => d.v > 0.55).sort((a, b) => b.v - a.v).slice(0, 2);
  for (const d of drivers) out.push(d.txt());
  return out;
}
