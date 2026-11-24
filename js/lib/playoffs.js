// Playoff race math (spec 5.4.1). Pure functions, no DOM, no fetches — fully testable.
//
// Units: everything is in "win points" (win = 2, tie = 1) so ties stay integral.
//
// Exact clinch / elimination checks use the REAL remaining schedule via small max-flow
// feasibility problems, so "two rivals play each other" is accounted for. Final-standing
// ties are never resolved by assumption: each check runs twice — once with every tie going
// against the team, once with every tie going its way — and a result that only holds in
// the second case is reported as hedged ("if tiebreakers hold").
//
// Median-game leagues are handled with a relaxation (the per-week median pool is modelled,
// but not its coupling to the head-to-head result). The relaxation is in the safe
// direction for both checks — it can miss a clinch/elimination, never invent one.

import { FlowGraph } from './maxflow.js';

export const TIEBREAKERS = {
  pf: { label: 'Points for', desc: 'More total points scored wins the tie (Sleeper default)' },
  h2h: { label: 'Head-to-head', desc: 'Best record in games between the tied teams, then points for' },
  pa: { label: 'Points against', desc: 'More points scored against wins the tie, then points for' },
};
export const DEFAULT_TIEBREAKER = 'pf';

export const STATUS = {
  clinched_bye: { label: 'Clinched bye', tone: 'good', emoji: '✅' },
  clinched: { label: 'Clinched', tone: 'good', emoji: '✅' },
  control: { label: 'In control', tone: 'good', emoji: '🎯' },
  bubble: { label: 'On the bubble', tone: 'warn', emoji: '🔥' },
  hunt: { label: 'In the hunt', tone: 'warn', emoji: '🔥' },
  eliminated: { label: 'Eliminated', tone: 'bad', emoji: '❌' },
};

// Bracket byes: a bracket of 6 fills an 8-team bracket, so the top 2 seeds rest.
export function playoffByes(spots) {
  if (!(spots >= 2)) return 0;
  let p = 1;
  while (p < spots) p *= 2;
  return p === spots ? 0 : p - spots;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// --- model -------------------------------------------------------------------------

// Pair a week's matchup entries into games. Entries without a matchup_id are byes.
export function pairMatchups(entries) {
  const byId = new Map();
  for (const m of entries || []) {
    if (m == null || m.matchup_id == null) continue;
    if (!byId.has(m.matchup_id)) byId.set(m.matchup_id, []);
    byId.get(m.matchup_id).push(m);
  }
  const games = [];
  for (const pair of byId.values()) if (pair.length === 2) games.push(pair);
  return games;
}

// Build everything the math needs from raw Sleeper payloads.
// matchupsByWeek: { [week]: matchups[] } for weeks 1..regEnd (missing weeks tolerated).
export function buildSeasonModel({ league, rosters, nameFor, matchupsByWeek = {} }) {
  const s = league?.settings || {};
  const list = rosters || [];
  const median = Number(s.league_average_match) === 1;
  const gamesPerWeek = median ? 2 : 1;
  const spots = clamp(Number(s.playoff_teams) || 6, 1, Math.max(1, list.length));
  const regEnd = clamp((Number(s.playoff_week_start) || 15) - 1, 1, 18);
  const divisions = Number(s.divisions) >= 2;

  const teams = list.map((r) => {
    const rs = r.settings || {};
    const wins = Number(rs.wins) || 0;
    const losses = Number(rs.losses) || 0;
    const ties = Number(rs.ties) || 0;
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      name: nameFor ? nameFor(r) : `Team ${r.roster_id}`,
      wins, losses, ties,
      wp: 2 * wins + ties,
      pf: (Number(rs.fpts) || 0) + (Number(rs.fpts_decimal) || 0) / 100,
      pa: (Number(rs.fpts_against) || 0) + (Number(rs.fpts_against_decimal) || 0) / 100,
      division: rs.division ?? null,
    };
  });

  // Weeks already reflected in the W-L records. Records (not display_week) are the source
  // of truth: mid-week the in-progress week isn't in the record yet, so it's still "remaining".
  const maxGames = teams.reduce((m, t) => Math.max(m, t.wins + t.losses + t.ties), 0);
  const completedWeeks = clamp(Math.round(maxGames / gamesPerWeek), 0, regEnd);
  const complete = completedWeeks >= regEnd;

  const ids = new Set(teams.map((t) => t.rosterId));
  const history = {};
  const h2h = {};
  for (const t of teams) { history[t.rosterId] = []; h2h[t.rosterId] = {}; }
  const bump = (a, b, key) => {
    const rec = h2h[a][b] || (h2h[a][b] = { w: 0, l: 0, t: 0 });
    rec[key] += 1;
  };

  for (let w = 1; w <= completedWeeks; w++) {
    for (const m of matchupsByWeek[w] || []) {
      if (ids.has(m.roster_id) && Number.isFinite(Number(m.points))) history[m.roster_id].push(Number(m.points));
    }
    for (const [a, b] of pairMatchups(matchupsByWeek[w])) {
      if (!ids.has(a.roster_id) || !ids.has(b.roster_id)) continue;
      const pa = Number(a.points) || 0;
      const pb = Number(b.points) || 0;
      if (pa > pb) { bump(a.roster_id, b.roster_id, 'w'); bump(b.roster_id, a.roster_id, 'l'); }
      else if (pb > pa) { bump(b.roster_id, a.roster_id, 'w'); bump(a.roster_id, b.roster_id, 'l'); }
      else { bump(a.roster_id, b.roster_id, 't'); bump(b.roster_id, a.roster_id, 't'); }
    }
  }

  const remainingWeeks = [];
  const schedule = [];
  let scheduleIncomplete = false;
  for (let w = completedWeeks + 1; w <= regEnd; w++) {
    remainingWeeks.push(w);
    const games = pairMatchups(matchupsByWeek[w]).filter(([a, b]) => ids.has(a.roster_id) && ids.has(b.roster_id));
    if (!games.length) scheduleIncomplete = true;
    for (const [a, b] of games) schedule.push({ week: w, a: a.roster_id, b: b.roster_id });
  }

  return {
    teams, spots, byes: playoffByes(spots), regEnd, completedWeeks, complete,
    remainingWeeks, schedule, scheduleIncomplete, median, gamesPerWeek, divisions,
    history, h2h,
  };
}

// --- standings ---------------------------------------------------------------------

function h2hAmong(team, group, h2hFn) {
  let pts = 0;
  let games = 0;
  for (const o of group) {
    if (o === team) continue;
    const r = h2hFn(team.rosterId, o.rosterId);
    if (!r) continue;
    pts += r.w + r.t / 2;
    games += r.w + r.l + r.t;
  }
  return games ? pts / games : 0.5;
}

// Sort teams by win points, then the chosen tiebreaker. Works on any objects carrying
// { rosterId, wp, pf, pa }. h2hFn(a, b) -> { w, l, t } is only needed for 'h2h'.
export function rankTeams(list, tiebreaker = DEFAULT_TIEBREAKER, h2hFn = null) {
  const sorted = [...list].sort((a, b) => b.wp - a.wp
    || (tiebreaker === 'pa' ? b.pa - a.pa : 0)
    || b.pf - a.pf);
  if (tiebreaker !== 'h2h' || !h2hFn) return sorted;
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].wp === sorted[i].wp) j++;
    const group = sorted.slice(i, j);
    if (group.length > 1) {
      const score = new Map(group.map((t) => [t, h2hAmong(t, group, h2hFn)]));
      group.sort((a, b) => score.get(b) - score.get(a) || b.pf - a.pf);
    }
    out.push(...group);
    i = j;
  }
  return out;
}

export function modelH2hFn(model) {
  return (a, b) => model.h2h[a]?.[b] || null;
}

export function currentStandings(model, tiebreaker = DEFAULT_TIEBREAKER) {
  return rankTeams(model.teams, tiebreaker, modelH2hFn(model));
}

// --- exact scenario engine -----------------------------------------------------------

const COMBO_LIMIT = 4000; // beyond this, fall back to a schedule-free bound (still sound)

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// Yields index-combinations of size k from arr (in order).
function* combos(arr, k) {
  const n = arr.length;
  if (k === 0) { yield []; return; }
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function makeContext(model) {
  const n = model.teams.length;
  const index = new Map(model.teams.map((t, i) => [t.rosterId, i]));
  const weekIndex = new Map(model.remainingWeeks.map((w, i) => [w, i]));
  const games = model.schedule
    .filter((g) => index.has(g.a) && index.has(g.b))
    .map((g) => ({ wi: weekIndex.get(g.week), i: index.get(g.a), j: index.get(g.b) }));
  return {
    n, index, games,
    weeks: model.remainingWeeks.length,
    wp: model.teams.map((t) => t.wp),
    median: model.median,
    half: Math.floor(n / 2),
  };
}

// Fix team x's results per remaining week (plan[wi] = 'W' | 'L', applied to its head-to-head
// game and, in median leagues, its median game). Returns what's left to be decided.
function applyPlan(ctx, x, plan) {
  const base = ctx.wp.slice();
  const free = [];
  for (const g of ctx.games) {
    if (g.i === x || g.j === x) {
      const opp = g.i === x ? g.j : g.i;
      if (plan[g.wi] === 'W') base[x] += 2; else base[opp] += 2;
    } else {
      free.push(g);
    }
  }
  const medianSupply = [];
  if (ctx.median) {
    for (let wi = 0; wi < ctx.weeks; wi++) {
      const xWin = plan[wi] === 'W';
      if (xWin) base[x] += 2;
      medianSupply.push(2 * Math.max(0, ctx.half - (xWin ? 1 : 0)));
    }
  }
  const maxGain = new Array(ctx.n).fill(ctx.median ? 2 * ctx.weeks : 0);
  for (const g of free) { maxGain[g.i] += 2; maxGain[g.j] += 2; }
  return { base, free, medianSupply, maxGain };
}

// Can every team in S reach `target` win points simultaneously?
function canAllReach(ctx, st, x, S, target) {
  const inS = new Map(S.map((t, k) => [t, k]));
  const games = st.free.filter((g) => inS.has(g.i) || inS.has(g.j));
  const W = st.medianSupply.length;
  const src = 0;
  const g0 = 1;
  const w0 = g0 + games.length;
  const t0 = w0 + W;
  const sink = t0 + S.length;
  const G = new FlowGraph(sink + 1);
  let need = 0;
  games.forEach((g, k) => {
    G.addEdge(src, g0 + k, 2);
    if (inS.has(g.i)) G.addEdge(g0 + k, t0 + inS.get(g.i), 2);
    if (inS.has(g.j)) G.addEdge(g0 + k, t0 + inS.get(g.j), 2);
  });
  for (let wi = 0; wi < W; wi++) {
    G.addEdge(src, w0 + wi, st.medianSupply[wi]);
    for (let k = 0; k < S.length; k++) G.addEdge(w0 + wi, t0 + k, 2);
  }
  S.forEach((t, k) => {
    const d = target - st.base[t];
    need += d;
    G.addEdge(t0 + k, sink, d);
  });
  return G.maxFlow(src, sink) === need;
}

// Can every remaining result be assigned so that each team outside `allowed` stays
// strictly below `target`? (Every game and median slot must be absorbed by someone.)
function canContain(ctx, st, x, allowed, target) {
  const games = st.free;
  const W = st.medianSupply.length;
  const src = 0;
  const g0 = 1;
  const w0 = g0 + games.length;
  const t0 = w0 + W;
  const sink = t0 + ctx.n;
  const G = new FlowGraph(sink + 1);
  let total = 0;
  games.forEach((g, k) => {
    G.addEdge(src, g0 + k, 2);
    G.addEdge(g0 + k, t0 + g.i, 2);
    G.addEdge(g0 + k, t0 + g.j, 2);
    total += 2;
  });
  for (let wi = 0; wi < W; wi++) {
    G.addEdge(src, w0 + wi, st.medianSupply[wi]);
    total += st.medianSupply[wi];
    for (let t = 0; t < ctx.n; t++) if (t !== x) G.addEdge(w0 + wi, t0 + t, 2);
  }
  const BIG = 1e6;
  for (let t = 0; t < ctx.n; t++) {
    if (t === x) continue;
    const cap = allowed.has(t) ? BIG : target - 1 - st.base[t];
    G.addEdge(t0 + t, sink, cap);
  }
  return G.maxFlow(src, sink) === total;
}

// Is there ANY outcome (given x's plan) where at least k other teams finish above x?
// tiesHurt: a team level with x on win points counts as above x.
export function canFinishOutside(ctx, x, plan, k, tiesHurt) {
  const st = applyPlan(ctx, x, plan);
  const target = tiesHurt ? st.base[x] : st.base[x] + 1;
  const others = [];
  for (let t = 0; t < ctx.n; t++) if (t !== x) others.push(t);
  const forced = others.filter((t) => st.base[t] >= target).length;
  if (forced >= k) return { result: true, approx: false };
  const need = k - forced;
  const cands = others
    .filter((t) => st.base[t] < target && st.base[t] + st.maxGain[t] >= target)
    .sort((a, b) => (st.base[b] + st.maxGain[b]) - (st.base[a] + st.maxGain[a]));
  if (cands.length < need) return { result: false, approx: false };
  if (binom(cands.length, need) > COMBO_LIMIT) return { result: true, approx: true };
  for (const S of combos(cands, need)) {
    if (canAllReach(ctx, st, x, S, target)) return { result: true, approx: false };
  }
  return { result: false, approx: false };
}

// Is there ANY outcome (given x's plan) where fewer than k other teams finish above x?
// tiesFavor: a team level with x on win points counts as below x.
export function canFinishInside(ctx, x, plan, k, tiesFavor) {
  const st = applyPlan(ctx, x, plan);
  const target = tiesFavor ? st.base[x] + 1 : st.base[x];
  const others = [];
  for (let t = 0; t < ctx.n; t++) if (t !== x) others.push(t);
  const forcedSet = new Set(others.filter((t) => st.base[t] >= target));
  if (forcedSet.size >= k) return { result: false, approx: false };
  const room = k - 1 - forcedSet.size;
  const threats = others
    .filter((t) => !forcedSet.has(t) && st.base[t] + st.maxGain[t] >= target)
    .sort((a, b) => (st.base[b] + st.maxGain[b]) - (st.base[a] + st.maxGain[a]));
  if (threats.length <= room) return { result: true, approx: false };
  if (binom(threats.length, room) > COMBO_LIMIT) return { result: true, approx: true };
  for (const A of combos(threats, room)) {
    if (canContain(ctx, st, x, new Set([...forcedSet, ...A]), target)) return { result: true, approx: false };
  }
  return { result: false, approx: false };
}

// --- per-team analysis -----------------------------------------------------------------

function planOf(weeks, fn) {
  return Array.from({ length: weeks }, (_, i) => fn(i));
}

function gamesFromPoints(p) {
  return Math.max(0, Math.ceil(p / 2));
}

function finalStatuses(model, ranked) {
  // Regular season over: seeding is final, but a seed decided purely by a tiebreaker is
  // only as good as our tiebreaker assumption.
  const { spots, byes } = model;
  const out = new Map();
  ranked.forEach((t, i) => {
    const seed = i + 1;
    const status = seed <= byes ? 'clinched_bye' : seed <= spots ? 'clinched' : 'eliminated';
    const line = seed <= byes ? byes : spots;
    const neighbor = seed <= line ? ranked[line] : ranked[line - 1];
    const hedged = Boolean(neighbor && neighbor.wp === t.wp);
    out.set(t.rosterId, { status, hedged, approx: false, seed, final: true });
  });
  return out;
}

// Analyze every team. Returns Map<rosterId, analysis>, or null when the league uses
// divisions or the schedule can't be read (the view falls back to standings-only).
export function analyzeRace(model, tiebreaker = DEFAULT_TIEBREAKER) {
  if (model.divisions || model.scheduleIncomplete) return null;
  const ranked = currentStandings(model, tiebreaker);
  if (model.complete) return finalStatuses(model, ranked);

  const ctx = makeContext(model);
  const { spots, byes } = model;
  const W = ctx.weeks;
  const out = new Map();
  const seedOf = new Map(ranked.map((t, i) => [t.rosterId, i + 1]));

  for (const team of model.teams) {
    const x = ctx.index.get(team.rosterId);
    let approx = false;
    const outside = (plan, k, tiesHurt) => { const r = canFinishOutside(ctx, x, plan, k, tiesHurt); approx ||= r.approx; return r.result; };
    const inside = (plan, k, tiesFavor) => { const r = canFinishInside(ctx, x, plan, k, tiesFavor); approx ||= r.approx; return r.result; };

    const allL = planOf(W, () => 'L');
    const allW = planOf(W, () => 'W');
    const seed = seedOf.get(team.rosterId);
    const a = { rosterId: team.rosterId, seed, hedged: false, final: false, weeksLeft: W };

    const clinch = !outside(allL, spots, true);
    const clinchTB = clinch || !outside(allL, spots, false);
    const byeClinch = byes > 0 && !outside(allL, byes, true);
    const byeClinchTB = byes > 0 && (byeClinch || !outside(allL, byes, false));
    const winOut = clinch || !outside(allW, spots, true);
    const winOutTB = winOut || !outside(allW, spots, false);
    const elim = !inside(allW, spots, true);
    const aliveOnlyViaTB = !elim && !inside(allW, spots, false);

    if (byeClinchTB) { a.status = 'clinched_bye'; a.hedged = !byeClinch; }
    else if (clinchTB) { a.status = 'clinched'; a.hedged = !clinch; }
    else if (elim) a.status = 'eliminated';
    else if (winOutTB) { a.status = 'control'; a.hedged = !winOut; }
    else a.status = seed <= spots ? 'bubble' : 'hunt';
    a.aliveOnlyViaTB = aliveOnlyViaTB;

    // "Win your next j and you're in" — smallest j that clinches regardless of the rest.
    if (a.status === 'control') {
      a.winNext = W;
      for (let j = 1; j < W; j++) {
        const plan = planOf(W, (i) => (i < j ? 'W' : 'L'));
        if (!outside(plan, spots, !a.hedged)) { a.winNext = j; break; }
      }
    }

    // This week's swing (only meaningful while the race is still open for this team).
    if (W >= 1 && a.status !== 'clinched' && a.status !== 'clinched_bye' && a.status !== 'eliminated') {
      const winThis = planOf(W, (i) => (i === 0 ? 'W' : 'L'));
      const loseThis = planOf(W, (i) => (i === 0 ? 'L' : 'W'));
      a.pivotal = {
        winIn: !outside(winThis, spots, true),
        winInTB: !outside(winThis, spots, false),
        loseOut: !inside(loseThis, spots, true),
      };
    }

    // Schedule-free magic / tragic numbers (conventional, conservative).
    const others = model.teams.filter((t) => t.rosterId !== team.rosterId);
    const remainingFor = (t) => {
      const i = ctx.index.get(t.rosterId);
      let g = 0;
      for (const gm of ctx.games) if (gm.i === i || gm.j === i) g += 1;
      return g + (ctx.median ? W : 0);
    };
    const myMax = team.wp + 2 * remainingFor(team);
    if (a.status !== 'clinched' && a.status !== 'clinched_bye' && others.length >= spots) {
      const byMax = others.map((t) => ({ t, max: t.wp + 2 * remainingFor(t) })).sort((p, q) => q.max - p.max);
      const rival = byMax[spots - 1];
      a.magic = gamesFromPoints(rival.max - team.wp + 1);
      a.magicRival = rival.t.name;
    }
    if (a.status !== 'eliminated' && others.length >= spots) {
      const byNow = [...others].sort((p, q) => q.wp - p.wp);
      const rival = byNow[spots - 1];
      a.tragic = gamesFromPoints(myMax - rival.wp + 1);
      a.tragicRival = rival.name;
    }
    if (seed > spots) {
      const lastIn = ranked[spots - 1];
      a.gamesBack = (lastIn.wp - team.wp) / 2;
      a.lastIn = lastIn.name;
    }

    a.approx = approx;
    out.set(team.rosterId, a);
  }
  return out;
}

// --- plain-English explanation -------------------------------------------------------

// One-line "what they need". `you` switches to second person for the user's own team.
export function explain(a, { you = false } = {}) {
  if (!a) return '';
  const subj = you ? "you're" : "they're";
  const tb = a.hedged ? ', if tiebreakers hold' : '';
  if (a.final) {
    if (a.status === 'clinched_bye') return `Earned a first-round bye${tb}.`;
    if (a.status === 'clinched') return `Made the playoffs${tb}.`;
    return `Missed the playoffs${tb}.`;
  }
  switch (a.status) {
    case 'clinched_bye': return `Clinched a first-round bye${tb}.`;
    case 'clinched': return `Clinched a playoff spot${tb}.`;
    case 'eliminated': return 'Eliminated from playoff contention.';
    case 'control': {
      const head = a.winNext === 1 ? `Win this week and ${subj} in`
        : a.winNext < a.weeksLeft ? `Win the next ${a.winNext} and ${subj} in`
          : `Win out and ${subj} in`;
      return `${head}${tb}.`;
    }
    case 'bubble': {
      const parts = [`Holding the #${a.seed} seed but can't lock it up alone`];
      if (a.magic != null) parts.push(`magic number ${a.magic} vs ${a.magicRival}`);
      return parts.join(' — ') + '.';
    }
    default: {
      const parts = [];
      if (a.gamesBack > 0) parts.push(`${a.gamesBack} game${a.gamesBack === 1 ? '' : 's'} back of ${a.lastIn}`);
      else if (a.gamesBack === 0) parts.push(`level with ${a.lastIn} but behind on the tiebreaker`);
      parts.push('needs help');
      if (a.pivotal?.loseOut) parts.push('a loss this week is elimination');
      else if (a.tragic != null) parts.push(`tragic number ${a.tragic} vs ${a.tragicRival}`);
      if (a.aliveOnlyViaTB) parts.push('can only get in on a tiebreaker');
      const txt = parts.join(' — ');
      return txt.charAt(0).toUpperCase() + txt.slice(1) + '.';
    }
  }
}
