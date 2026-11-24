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
import { analyzeDivisionRace, divisionUnsupported } from './playoffdiv.js';

export const TIEBREAKERS = {
  pf: { label: 'Points for', desc: 'More total points scored wins the tie (Sleeper default)' },
  h2h: { label: 'Head-to-head', desc: 'Best record in games between the tied teams, then points for' },
  pa: { label: 'Points against', desc: 'More points scored against wins the tie, then points for' },
};
export const DEFAULT_TIEBREAKER = 'pf';

// How division winners are treated. Sleeper doesn't expose this, so it's a per-league setting.
export const DIVISION_MODES = {
  top: { label: 'Top seeds', desc: 'Division winners are guaranteed a spot and take the top seeds' },
  in: { label: 'Guaranteed spot', desc: 'Division winners are guaranteed a spot; all seeds by record' },
  none: { label: 'Ignore', desc: 'Divisions don’t affect the playoffs' },
};
export const DEFAULT_DIVISION_MODE = 'top';

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
  const divisionCount = Number(s.divisions) || 0;

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
      division: rs.division != null && Number(rs.division) > 0 ? Number(rs.division) : null,
    };
  });
  // Only treat the league as divisional when Sleeper says so AND every roster has one.
  const divisions = divisionCount >= 2 && teams.length > 0 && teams.every((t) => t.division != null)
    && new Set(teams.map((t) => t.division)).size >= 2;
  const divisionNames = {};
  if (divisions) {
    for (const d of new Set(teams.map((t) => t.division))) {
      divisionNames[d] = league?.metadata?.[`division_${d}`] || `Division ${d}`;
    }
  }

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
    remainingWeeks, schedule, scheduleIncomplete, median, gamesPerWeek, divisions, divisionNames,
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

// Apply division rules to an overall ranking: returns teams in SEED order (playoff teams
// first). Works on any objects carrying { division } (model teams or simulated rows).
export function seedTeams(ranked, model, mode = DEFAULT_DIVISION_MODE) {
  if (!model.divisions || mode === 'none') return ranked;
  const seen = new Set();
  const leaders = [];
  for (const t of ranked) if (!seen.has(t.division)) { seen.add(t.division); leaders.push(t); }
  const leaderSet = new Set(leaders);
  const rest = ranked.filter((t) => !leaderSet.has(t));
  if (mode === 'top') return [...leaders, ...rest];
  const wild = Math.max(0, model.spots - leaders.length);
  const inSet = new Set([...leaders, ...rest.slice(0, wild)]);
  return [...ranked.filter((t) => inSet.has(t)), ...ranked.filter((t) => !inSet.has(t))];
}

// rosterIds currently leading their division (by the overall ranking).
export function divisionLeaders(model, tiebreaker = DEFAULT_TIEBREAKER) {
  const out = new Set();
  if (!model.divisions) return out;
  const seen = new Set();
  for (const t of rankTeams(model.teams, tiebreaker, modelH2hFn(model))) {
    if (!seen.has(t.division)) { seen.add(t.division); out.add(t.rosterId); }
  }
  return out;
}

export function currentStandings(model, tiebreaker = DEFAULT_TIEBREAKER, divisionMode = DEFAULT_DIVISION_MODE) {
  return seedTeams(rankTeams(model.teams, tiebreaker, modelH2hFn(model)), model, divisionMode);
}

// Why exact scenarios can't be computed for this league (null = they can).
export function unsupportedReason(model, divisionMode = DEFAULT_DIVISION_MODE) {
  if (model.scheduleIncomplete) return 'Sleeper didn’t return the remaining schedule, so clinch scenarios and odds are unavailable.';
  if (model.divisions && divisionMode !== 'none' && !model.complete) {
    const why = divisionUnsupported(model);
    if (why === 'median') return 'Clinch scenarios aren’t available for division leagues that also play a weekly median game.';
    if (why === 'too_many') return 'Too many games left to check every outcome in a division league — exact clinch scenarios start in the last few weeks of the regular season. Odds are still shown.';
  }
  return null;
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

// Fix team x's results per remaining week. plan[wi] is one of:
//   'W' win head-to-head AND median · 'L' lose both
//   'H' win head-to-head, lose median · 'M' lose head-to-head, win median
// (In non-median leagues H == W and M == L.) `fixed` optionally pins other games:
// Map<game, winnerIndex>. Returns what's left to be decided.
const H2H_WIN = new Set(['W', 'H']);
const MED_WIN = new Set(['W', 'M']);

function applyPlan(ctx, x, plan, fixed = null) {
  const base = ctx.wp.slice();
  const free = [];
  for (const g of ctx.games) {
    if (g.i === x || g.j === x) {
      const opp = g.i === x ? g.j : g.i;
      if (H2H_WIN.has(plan[g.wi])) base[x] += 2; else base[opp] += 2;
    } else if (fixed && fixed.has(g)) {
      base[fixed.get(g)] += 2;
    } else {
      free.push(g);
    }
  }
  const medianSupply = [];
  if (ctx.median) {
    for (let wi = 0; wi < ctx.weeks; wi++) {
      const xWin = MED_WIN.has(plan[wi]);
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
export function canFinishOutside(ctx, x, plan, k, tiesHurt, fixed = null) {
  const st = applyPlan(ctx, x, plan, fixed);
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
export function canFinishInside(ctx, x, plan, k, tiesFavor, fixed = null) {
  const st = applyPlan(ctx, x, plan, fixed);
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
    const atLine = ranked[spots];
    const inClinched = seed <= spots && !(atLine && atLine.wp === t.wp);
    out.set(t.rosterId, { status, hedged, inClinched, approx: false, seed, final: true });
  });
  return out;
}

// Analyze every team. Returns Map<rosterId, analysis>, or null when exact math isn't
// available (see unsupportedReason) and the view falls back to standings + odds.
export function analyzeRace(model, tiebreaker = DEFAULT_TIEBREAKER, divisionMode = DEFAULT_DIVISION_MODE) {
  if (model.scheduleIncomplete) return null;
  const ranked = currentStandings(model, tiebreaker, divisionMode);
  if (model.complete) return finalStatuses(model, ranked);
  if (model.divisions && divisionMode !== 'none') return analyzeDivisionRace(model, tiebreaker, divisionMode);

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
    a.inClinched = clinch; // playoff spot certain (a hedged bye can still have a certain spot)

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

    // This week's clinching / elimination scenarios for every team still alive.
    if (a.status === 'control' || a.status === 'bubble' || a.status === 'hunt') {
      a.scenarios = weekScenarios(model, ctx, x, spots);
      approx ||= Boolean(a.scenarios?.approx);
    }

    a.approx = approx;
    out.set(team.rosterId, a);
  }
  return out;
}

// --- this week's scenarios (NFL "clinches with: ..." style) ---------------------------

export const MAX_SCENARIO_GAMES = 8; // 2^8 outcomes; beyond that (17+ team leagues) skip

const popcount = (n) => { let c = 0; for (; n; n &= n - 1) c++; return c; };

// All prime implicants of boolean function f over V variables (f: Uint8Array of 2^V).
// A term is { c: care-mask, val: required bits }. 3^V terms, so trivial for V <= 8.
function primeImplicants(f, V) {
  const size = 1 << V;
  const full = size - 1;
  const terms = [];
  for (let c = 0; c < size; c++) {
    const freeBits = full & ~c;
    for (let val = c; ; val = (val - 1) & c) {
      let ok = true;
      for (let sub = freeBits; ; sub = (sub - 1) & freeBits) {
        if (!f[val | sub]) { ok = false; break; }
        if (sub === 0) break;
      }
      if (ok) terms.push({ c, val });
      if (val === 0) break;
    }
  }
  const keys = new Set(terms.map((t) => t.c * size + t.val));
  return terms.filter(({ c, val }) => {
    for (let b = c; b; b &= b - 1) {
      const c2 = c & ~(b & -b);
      if (keys.has(c2 * size + (val & c2))) return false; // a shorter term already works
    }
    return true;
  });
}

// Greedy cover of `target` minterms, preferring the fewest conditions per scenario.
function coverWith(primes, target, V) {
  const size = 1 << V;
  const uncovered = new Set();
  for (let m = 0; m < size; m++) if (target[m]) uncovered.add(m);
  const chosen = [];
  while (uncovered.size) {
    let best = null;
    let bestKey = null;
    for (const p of primes) {
      let hits = 0;
      for (const m of uncovered) if ((m & p.c) === p.val) hits++;
      if (!hits) continue;
      const key = [popcount(p.c), -hits];
      if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = p; bestKey = key; }
    }
    if (!best) break;
    chosen.push(best);
    for (const m of [...uncovered]) if ((m & best.c) === best.val) uncovered.delete(m);
  }
  return chosen;
}

// Try every combination of this week's results (the team's future games are assumed lost
// for clinching and won for elimination, so a listed scenario holds no matter what comes
// after). Returns { week, clinch: [{ lits, hedged }], elim: [{ lits }], approx }.
function weekScenarios(model, ctx, x, k) {
  const W = ctx.weeks;
  const week0 = ctx.games.filter((g) => g.wi === 0);
  if (!week0.length || week0.length > MAX_SCENARIO_GAMES) return null;
  const V = week0.length;
  const size = 1 << V;
  const ownVar = week0.findIndex((g) => g.i === x || g.j === x);
  const fc = new Uint8Array(size);
  const ftb = new Uint8Array(size);
  const fe = new Uint8Array(size);
  let approx = false;

  for (let m = 0; m < size; m++) {
    const fixed = new Map();
    let own = null; // true = x wins its game this week; null = bye
    week0.forEach((g, v) => {
      const winner = (m >> v) & 1 ? g.i : g.j;
      if (v === ownVar) own = winner === x;
      else fixed.set(g, winner);
    });
    // Clinch: worst case everywhere else (median game lost, future games lost).
    const cPlan = planOf(W, (i) => (i === 0 && own ? 'H' : 'L'));
    const r1 = canFinishOutside(ctx, x, cPlan, k, true, fixed);
    approx ||= r1.approx;
    fc[m] = r1.result ? 0 : 1;
    if (fc[m]) ftb[m] = 1;
    else {
      const r2 = canFinishOutside(ctx, x, cPlan, k, false, fixed);
      approx ||= r2.approx;
      ftb[m] = r2.result ? 0 : 1;
    }
    // Elimination: best case everywhere else (median game won, future games won).
    const ePlan = planOf(W, (i) => (i === 0 && own === false ? 'M' : 'W'));
    const r3 = canFinishInside(ctx, x, ePlan, k, true, fixed);
    approx ||= r3.approx;
    fe[m] = r3.result ? 0 : 1;
  }

  const pairs = week0.map((g) => ({ i: g.i, j: g.j }));
  return { ...buildScenarioLists(model.teams, pairs, ownVar, x, fc, ftb, fe, V, model.remainingWeeks[0]), approx };
}

// Turn per-outcome truth tables for this week's games into readable scenario lists.
// pairs[v] = { i, j } team indexes; outcome bit v set => team i wins game v.
// fc: clinched for certain · ftb: clinched if ties go your way · fe: eliminated.
export function buildScenarioLists(teams, pairs, ownVar, x, fc, ftb, fe, V, week) {
  const size = 1 << V;
  const lit = (v, firstWins) => {
    const g = pairs[v];
    const winner = firstWins ? g.i : g.j;
    if (v === ownVar) return { self: true, result: winner === x ? 'win' : 'loss' };
    const loser = winner === g.i ? g.j : g.i;
    return { self: false, winner: teams[winner].name, loser: teams[loser].name };
  };
  const toScenario = (t, hedged) => {
    const lits = [];
    for (let v = 0; v < V; v++) if (t.c & (1 << v)) lits.push(lit(v, Boolean(t.val & (1 << v))));
    lits.sort((p, q) => Number(q.self) - Number(p.self));
    return { lits, hedged };
  };
  const clinch = coverWith(primeImplicants(fc, V), fc, V).map((t) => toScenario(t, false));
  const tbOnly = new Uint8Array(size);
  for (let m = 0; m < size; m++) tbOnly[m] = ftb[m] && !fc[m] ? 1 : 0;
  clinch.push(...coverWith(primeImplicants(ftb, V), tbOnly, V).map((t) => toScenario(t, true)));
  const elim = coverWith(primeImplicants(fe, V), fe, V).map((t) => toScenario(t, false));
  return { week, clinch, elim };
}

// "Win + Lamb Chops beats Chase Bank" — one scenario as text.
export function scenarioText(sc) {
  if (!sc.lits.length) return 'Any result';
  const txt = sc.lits.map((l) => (l.self ? (l.result === 'win' ? 'Win' : 'Loss') : `${l.winner} beats ${l.loser}`)).join(' + ');
  return txt + (sc.hedged ? ' (if tiebreakers hold)' : '');
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
    case 'clinched': return a.divClinched ? `Clinched the division${tb}.` : `Clinched a playoff spot${tb}.`;
    case 'eliminated': return 'Eliminated from playoff contention.';
    case 'control': {
      const head = a.winNext === 1 ? `Win this week and ${subj} in`
        : a.winNext < a.weeksLeft ? `Win the next ${a.winNext} and ${subj} in`
          : `Win out and ${subj} in`;
      return `${head}${tb}.`;
    }
    case 'bubble': {
      const parts = [a.divLeader ? `Leads the division (#${a.seed} seed) but can't lock it up alone` : `Holding the #${a.seed} seed but can't lock it up alone`];
      if (a.magic != null) parts.push(`magic number ${a.magic} vs ${a.magicRival}`);
      return parts.join(' — ') + '.';
    }
    default: {
      const parts = [];
      if (a.gamesBack > 0) parts.push(`${a.gamesBack} game${a.gamesBack === 1 ? '' : 's'} back of ${a.lastIn}${a.lastInWildcard ? ' for the last wildcard' : ''}`);
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
