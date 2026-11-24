// Monte Carlo playoff odds (spec 5.4.1.c).
//
// Rather than flipping a weighted coin per game, we simulate each team's weekly SCORE.
// That gives the same "better teams win more" behaviour as a logistic on PPG difference,
// but it also produces realistic points-for totals (the default tiebreaker) and handles
// median-game leagues naturally (top half of the week's scores earn the extra win).
//
// The score model is deliberately isolated in buildScoreModel / sampleScore so it can be
// swapped (e.g. for projections) without touching the simulation loop.

import { rankTeams, DEFAULT_TIEBREAKER } from './playoffs.js';

// Seeded PRNG so results are stable between renders and testable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRIOR_WEEKS = 3;     // shrink each team's mean toward the league mean (early-season noise)
const DEFAULT_MEAN = 110;
const DEFAULT_SD = 22;
const MIN_SD = 10;

// Per-team { mean, sd } from completed weekly scores.
export function buildScoreModel(model) {
  const all = [];
  for (const t of model.teams) for (const p of model.history[t.rosterId] || []) if (p > 0) all.push(p);
  const leagueMean = all.length ? all.reduce((s, v) => s + v, 0) / all.length : DEFAULT_MEAN;

  const params = {};
  let sq = 0;
  let dof = 0;
  for (const t of model.teams) {
    const pts = (model.history[t.rosterId] || []).filter((p) => p > 0);
    const n = pts.length;
    const raw = n ? pts.reduce((s, v) => s + v, 0) / n : leagueMean;
    params[t.rosterId] = { mean: (raw * n + leagueMean * PRIOR_WEEKS) / (n + PRIOR_WEEKS) };
    for (const p of pts) sq += (p - raw) ** 2;
    dof += Math.max(0, n - 1);
  }
  // A pooled week-to-week SD is far more stable than per-team SDs from ~10 games.
  const sd = dof > 0 ? Math.max(MIN_SD, Math.sqrt(sq / dof)) : DEFAULT_SD;
  for (const id of Object.keys(params)) params[id].sd = sd;
  return { params, leagueMean, sd };
}

export function sampleScore(p, rng) {
  // Box–Muller
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.max(0, p.mean + p.sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

// Head-to-head game win probability implied by the score model (for display only).
export function winProbability(pa, pb) {
  const z = (pa.mean - pb.mean) / Math.sqrt(pa.sd ** 2 + pb.sd ** 2);
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

// Simulate the rest of the regular season `iterations` times.
// Returns { iterations, byRoster: { [rosterId]: { playoffPct, byePct, ifWinPct, ifLosePct } } }.
// ifWin/ifLose condition on the team's head-to-head result in the first remaining week.
export function simulatePlayoffs(model, { iterations = 10000, seed = 20261, tiebreaker = DEFAULT_TIEBREAKER } = {}) {
  const teams = model.teams;
  const n = teams.length;
  const index = new Map(teams.map((t, i) => [t.rosterId, i]));
  const { params } = buildScoreModel(model);
  const P = teams.map((t) => params[t.rosterId]);
  const rng = mulberry32(seed);
  const weeks = model.remainingWeeks;
  const gamesByWeek = weeks.map((w) => model.schedule
    .filter((g) => g.week === w && index.has(g.a) && index.has(g.b))
    .map((g) => [index.get(g.a), index.get(g.b)]));
  const firstWeekGames = gamesByWeek[0] || [];
  const half = Math.floor(n / 2);
  const useH2h = tiebreaker === 'h2h';

  const made = new Float64Array(n);
  const bye = new Float64Array(n);
  const winN = new Float64Array(n);
  const winMade = new Float64Array(n);
  const loseN = new Float64Array(n);
  const loseMade = new Float64Array(n);

  // Base head-to-head matrix (only needed for the h2h tiebreaker).
  const baseH2h = useH2h ? teams.map((a) => teams.map((b) => ({ ...(model.h2h[a.rosterId]?.[b.rosterId] || { w: 0, l: 0, t: 0 }) }))) : null;

  const sim = teams.map((t) => ({ rosterId: t.rosterId, wp: 0, pf: 0, pa: 0, i: 0 }));
  const scores = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i);
  const firstResult = new Int8Array(n); // 1 win, -1 loss, 0 no game

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      sim[i].wp = teams[i].wp; sim[i].pf = teams[i].pf; sim[i].pa = teams[i].pa; sim[i].i = i;
    }
    const h2h = useH2h ? baseH2h.map((row) => row.map((r) => ({ ...r }))) : null;
    firstResult.fill(0);

    for (let wi = 0; wi < weeks.length; wi++) {
      for (let i = 0; i < n; i++) scores[i] = sampleScore(P[i], rng);
      for (const [a, b] of gamesByWeek[wi]) {
        const sa = scores[a];
        const sb = scores[b];
        sim[a].pf += sa; sim[a].pa += sb;
        sim[b].pf += sb; sim[b].pa += sa;
        const winner = sa >= sb ? a : b;
        const loser = winner === a ? b : a;
        sim[winner].wp += 2;
        if (h2h) { h2h[winner][loser].w += 1; h2h[loser][winner].l += 1; }
        if (wi === 0) { firstResult[winner] = 1; firstResult[loser] = -1; }
      }
      if (model.median) {
        order.sort((p, q) => scores[q] - scores[p]);
        for (let r = 0; r < half; r++) sim[order[r]].wp += 2;
      }
    }

    const ranked = rankTeams(sim, tiebreaker, h2h ? (a, b) => h2h[index.get(a)][index.get(b)] : null);
    for (let r = 0; r < n; r++) {
      const i = ranked[r].i;
      const inP = r < model.spots;
      if (inP) made[i] += 1;
      if (r < model.byes) bye[i] += 1;
      if (firstResult[i] === 1) { winN[i] += 1; if (inP) winMade[i] += 1; }
      else if (firstResult[i] === -1) { loseN[i] += 1; if (inP) loseMade[i] += 1; }
    }
  }

  const byRoster = {};
  teams.forEach((t, i) => {
    byRoster[t.rosterId] = {
      playoffPct: (100 * made[i]) / iterations,
      byePct: model.byes ? (100 * bye[i]) / iterations : null,
      ifWinPct: firstWeekGames.length && winN[i] ? (100 * winMade[i]) / winN[i] : null,
      ifLosePct: firstWeekGames.length && loseN[i] ? (100 * loseMade[i]) / loseN[i] : null,
    };
  });
  return { iterations, byRoster };
}

// Display helper: never print "100%" / "0%" for something that isn't mathematically settled.
export function formatPct(pct, { settled = null } = {}) {
  if (pct == null) return '—';
  if (settled === 'in') return '100%';
  if (settled === 'out') return '0%';
  if (pct >= 99.5) return '>99%';
  if (pct > 0 && pct < 0.5) return '<1%';
  if (pct <= 0) return '<1%';
  return `${Math.round(pct)}%`;
}
