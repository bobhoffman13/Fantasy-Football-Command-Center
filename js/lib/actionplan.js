// League Action Plan: the top 5 things to do in a league right now.
//
// The core idea is that "dynasty vs redraft" is too coarse to drive advice. What
// actually matters is whether THIS season is still live for you. So every candidate
// action is scored on two independent axes — how much it helps you win now, and how
// much it helps you win later — and the league type plus your standing decides the
// blend (see leaguePosture). A dynasty team in first and a dynasty team in tenth get
// genuinely opposite advice out of the same roster.
//
// Recommendations are grounded in three data sources, in this order:
//   1. YOUR rankings profile assigned to this league (rank + Lifetime Value + LV change)
//   2. Public consensus (FantasyCalc: overall rank + 30-day market trend)
//   3. Real-world NFL data from Sleeper (injury status, depth chart, age, bye)
// Sources 2 and 3 are optional; the plan degrades to fewer actions, never breaks.
//
// Pure + deterministic so it can be unit-tested. home.js gathers the live inputs.

import { optimizeLineup, weeklyRankOf, pairLineupChanges } from './lineup.js';
import { starterTargets } from './draftstrategy.js';
import { computeArbitrage } from './tradevalue.js';

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const CORE_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// Age at which a position's dynasty value typically starts falling off a cliff.
const AGE_CLIFF = { RB: 27, WR: 29, TE: 30, QB: 34 };

// At most this many actions from any one category, so the plan can't become five
// variations of "make a trade" while an empty lineup slot goes unmentioned.
const MAX_PER_CATEGORY = 2;
export const PLAN_SIZE = 5;

// --- posture -----------------------------------------------------------------

// Decide how much this league's advice should weight now vs later.
export function leaguePosture({ isDynasty, standings = [], myOwnerId, playoffSpots = 6, week = null, inSeason = false }) {
  if (!isDynasty) {
    return { key: 'redraft', label: 'Win now', detail: 'Redraft league — every move is judged on this season only.', wNow: 1, wFuture: 0 };
  }
  const idx = standings.findIndex((s) => s.ownerId === myOwnerId);
  const me = idx >= 0 ? standings[idx] : null;
  const seed = idx >= 0 ? idx + 1 : null;

  // Before the season starts nobody has a record to judge, so sit on the fence.
  if (!inSeason || !me || (me.wins + me.losses + me.ties) === 0) {
    return { key: 'bubble', label: 'Balanced', detail: 'Dynasty — no results yet, so this weighs winning now and building for later about evenly.', wNow: 0.55, wFuture: 0.45 };
  }

  const leader = standings[0];
  const gamesBack = leader ? (leader.wins - me.wins) : 0;
  const lateSeason = week != null && week >= 8;

  if (seed <= Math.max(3, Math.ceil(playoffSpots / 2))) {
    return { key: 'contending', label: 'Contending', detail: `Dynasty — you're the ${ordinal(seed)} seed. Push for it, but don't mortgage the future.`, wNow: 0.7, wFuture: 0.3 };
  }
  if (lateSeason && (seed > playoffSpots) && gamesBack >= 2) {
    return { key: 'rebuilding', label: 'Rebuilding', detail: `Dynasty — ${ordinal(seed)} of ${standings.length} and ${gamesBack} games back this late. This year is gone; play for next year.`, wNow: 0.2, wFuture: 0.8 };
  }
  return { key: 'bubble', label: 'On the bubble', detail: `Dynasty — ${ordinal(seed)} of ${standings.length}. Still alive, so keep both eyes open.`, wNow: 0.55, wFuture: 0.45 };
}

function ordinal(n) {
  if (n == null) return '?';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// --- main entry ---------------------------------------------------------------

// input: {
//   league, isDynasty, standings, myOwnerId, myRoster, rosters, usersById,
//   myPlayers,        // enriched + consensus-decorated (describeWithValue) roster
//   opponentPlayers,  // same, for every other team, each carrying .owner
//   freeAgents,       // enriched unrostered players worth rostering
//   nflState, consensus, isSnoozed(key) -> bool
// }
export function recommendActions(input) {
  const {
    league, isDynasty = false, standings = [], myOwnerId = null, myRoster = null,
    myPlayers = [], opponentPlayers = [], freeAgents = [], nflState = null,
    consensus = null, isSnoozed = () => false, planSize = PLAN_SIZE,
  } = input || {};

  const seasonType = nflState?.season_type || '';
  const inSeason = seasonType === 'regular' || seasonType === 'post';
  const week = nflState?.display_week != null ? Number(nflState.display_week) : null;
  const playoffSpots = Number(league?.settings?.playoff_teams) || 6;

  const posture = leaguePosture({ isDynasty, standings, myOwnerId, playoffSpots, week, inSeason });

  if (!myRoster || !myPlayers.length) return { posture, actions: [], candidates: 0 };

  // Arbitrage is only meaningful across the whole league pool, and only when both a
  // Lifetime Value and a public value exist. Mutates arbDelta onto the players.
  const arbThreshold = computeArbitrage([...myPlayers, ...opponentPlayers]);

  const ctx = {
    league, isDynasty, posture, myRoster, myPlayers, opponentPlayers, freeAgents,
    standings, myOwnerId, consensus, arbThreshold, inSeason, week, nflState,
  };

  const candidates = [
    ...genUnfilledSlots(ctx),
    ...genLineupSwaps(ctx),
    ...genFreeAgents(ctx),
    ...genPositionalWeakness(ctx),
    ...genSellHigh(ctx),
    ...genBuyLow(ctx),
    ...genAgingAssets(ctx),
    ...genRosterHygiene(ctx),
  ].filter(Boolean);

  for (const c of candidates) {
    c.score = posture.wNow * clamp(c.nowImpact ?? 0) + posture.wFuture * clamp(c.futureImpact ?? 0);
    c.guardrail = c.guardrail || guardrailFor(c, posture);
  }

  const live = candidates.filter((c) => !isSnoozed(c.key));
  live.sort((a, b) => b.score - a.score);

  // Cap per category so the plan stays varied.
  const perCategory = new Map();
  const picked = [];
  for (const c of live) {
    const n = perCategory.get(c.category) || 0;
    if (n >= MAX_PER_CATEGORY) continue;
    perCategory.set(c.category, n + 1);
    picked.push(c);
    if (picked.length >= planSize) break;
  }

  // In a dynasty league the whole point is that the long term isn't ignored, so if the
  // top 5 came out entirely win-now, swap the weakest one for the best future action.
  if (isDynasty && picked.length === planSize && !picked.some((c) => c.horizon !== 'now')) {
    const bestFuture = live.find((c) => c.horizon !== 'now' && !picked.includes(c));
    if (bestFuture) picked.splice(planSize - 1, 1, bestFuture);
  }

  picked.forEach((c, i) => { c.rank = i + 1; });
  return { posture, actions: picked, candidates: live.length };
}

// Posture-aware caution attached to each action, so a win-now move in a dynasty league
// still carries its long-term cost on the face of the card.
function guardrailFor(c, posture) {
  if (posture.key === 'redraft') return null;
  if (posture.key === 'rebuilding' && c.horizon === 'now') {
    return 'This year is likely gone — do this only if it costs you nothing future-facing.';
  }
  if (posture.key === 'contending' && c.horizon === 'future') {
    return 'You’re contending — only move a producer if the return helps you this season too.';
  }
  if (c.category === 'buy' || c.category === 'need') {
    return posture.key === 'contending'
      ? 'Paying a future 1st is defensible here — you’re the one with a real shot.'
      : 'Cap the cost: no future 1sts for win-now pieces while you’re not a favorite.';
  }
  return null;
}

// --- generators ---------------------------------------------------------------

const primaryPos = (p) => (p.positions || []).find((x) => CORE_POSITIONS.includes(x)) || (p.positions || [])[0] || '';
const fmtLV = (v) => (v == null ? '—' : Math.round(v).toLocaleString());

// Public-market colour for a player, used to justify buy/sell timing with real data.
function marketNote(p) {
  const c = p.consensus;
  if (!c) return null;
  const bits = [];
  if (c.overallRank) bits.push(`public rank #${c.overallRank}`);
  if (c.trend) bits.push(`${c.trend > 0 ? 'up' : 'down'} ${Math.abs(Math.round(c.trend)).toLocaleString()} in public value over 30 days`);
  return bits.length ? bits.join(', ') : null;
}

// Real-world usage/availability signal straight from Sleeper's player data.
function realWorldNote(p) {
  const bits = [];
  if (p.injuryStatus) bits.push(`listed ${p.injuryStatus}`);
  if (p.depthChartOrder === 1 && p.depthChartPosition) bits.push(`${p.depthChartPosition}1 on the depth chart`);
  else if (p.depthChartOrder > 2 && p.depthChartPosition) bits.push(`buried at ${p.depthChartPosition}${p.depthChartOrder}`);
  if (p.onBye) bits.push(`on bye week ${p.byeWeek}`);
  return bits.length ? bits.join(', ') : null;
}

function lineupOf(ctx) {
  const slots = ctx.league?.roster_positions || [];
  if (!slots.length) return null;
  // Match the Lineup tab: when a weekly set applies, order by this week's projections.
  return optimizeLineup(ctx.myPlayers, slots, ctx.weekly ? { rankOf: weeklyRankOf } : {});
}

// 1. Starting slots that nothing can fill (bye/injury holes) — free points lost.
function genUnfilledSlots(ctx) {
  if (!ctx.inSeason) return [];
  const opt = lineupOf(ctx);
  if (!opt) return [];
  return opt.unfilled.slice(0, 2).map((slot) => ({
    key: `slot:${slot}`,
    category: 'lineup',
    horizon: 'now',
    title: `Fill your empty ${slot} slot`,
    detail: `Nobody on your roster can start at ${slot} this week — that slot scores zero unless you add someone.`,
    why: ['An unfilled starting slot is the single most expensive thing on a roster.'],
    nowImpact: 1,
    futureImpact: 0,
    cta: { label: 'Find a free agent', view: 'freeagents' },
  }));
}

// 2. Better player sitting on your bench than the one you have starting.
function genLineupSwaps(ctx) {
  if (!ctx.inSeason) return [];
  const opt = lineupOf(ctx);
  if (!opt) return [];
  const current = new Set(ctx.myRoster?.starters || []);
  if (!current.size) return [];

  const optimalIds = new Set(opt.starters.filter((s) => s.player).map((s) => s.player.playerId));
  const shouldStart = opt.starters.map((s) => s.player).filter((p) => p && !current.has(p.playerId));
  const shouldSit = ctx.myPlayers.filter((p) => current.has(p.playerId) && !optimalIds.has(p.playerId));
  if (!shouldStart.length || !shouldSit.length) return [];

  const isWeekly = !!ctx.weekly;
  const sortKey = (p) => (isWeekly ? (p.weekly?.rank ?? 99999) : (p.rank ?? 99999));
  shouldStart.sort((a, b) => sortKey(a) - sortKey(b));
  shouldSit.sort((a, b) => sortKey(b) - sortKey(a));

  const out = [];
  // Pair on position eligibility so a recommendation names the player actually
  // being replaced, and matches what the Lineup tab shows.
  for (const { inP, outP } of pairLineupChanges(shouldStart, shouldSit).slice(0, 2)) {
    if (!outP) continue;

    // Weekly sets are ranked by projected points, so the gap is stated in points —
    // which is what the recommendation actually rests on — rather than rank spots.
    let gap, detail, why;
    if (isWeekly) {
      const a = inP.weekly?.proj, b = outP.weekly?.proj;
      if (a == null || b == null || a <= b) continue;
      gap = a - b;
      const wk = ctx.weekly.week != null ? `week ${ctx.weekly.week}` : 'this week';
      detail = `${inP.name} projects ${gap.toFixed(1)} more points in ${wk} and is currently on your bench.`;
      why = [`Your ${wk} projections have ${inP.name} at ${a.toFixed(1)} and ${outP.name} at ${b.toFixed(1)}.`];
      if (inP.weekly?.opponent) why.push(`${inP.name} draws ${inP.weekly.opponent}.`);
    } else {
      gap = (outP.rank ?? 300) - (inP.rank ?? 300);
      if (gap <= 0) continue;
      detail = `${inP.name} is ${gap} spots higher in the rankings assigned to this league and is currently on your bench.`;
      why = [`Your rankings have ${inP.name} at #${inP.rank ?? '—'} and ${outP.name} at #${outP.rank ?? '—'}.`];
    }
    const rw = realWorldNote(outP);
    if (rw) why.push(`${outP.name} is ${rw}.`);
    out.push({
      key: `lineup:${outP.playerId}>${inP.playerId}`,
      category: 'lineup',
      horizon: 'now',
      title: `Start ${inP.name} over ${outP.name}`,
      detail,
      why,
      nowImpact: clamp(isWeekly ? 0.55 + gap / 12 : 0.55 + gap / 120, 0, 1),
      futureImpact: 0,
      cta: { label: 'Open lineup', view: 'lineup' },
    });
  }
  return out;
}

// 3. A free agent clearly better than someone you're currently starting.
function genFreeAgents(ctx) {
  if (!ctx.freeAgents.length) return [];
  const starters = new Set(ctx.myRoster?.starters || []);
  const startingPlayers = ctx.myPlayers.filter((p) => starters.has(p.playerId));
  const pool = startingPlayers.length ? startingPlayers : ctx.myPlayers;

  const worstByPos = new Map();
  for (const p of pool) {
    const pos = primaryPos(p);
    if (!CORE_POSITIONS.includes(pos)) continue;
    const cur = worstByPos.get(pos);
    if (!cur || (p.rank ?? 99999) > (cur.rank ?? 99999)) worstByPos.set(pos, p);
  }

  const out = [];
  const seenPos = new Set();
  for (const fa of ctx.freeAgents) {
    const pos = primaryPos(fa);
    if (!CORE_POSITIONS.includes(pos) || seenPos.has(pos)) continue;
    const incumbent = worstByPos.get(pos);
    if (!incumbent || fa.rank == null) continue;
    const gap = (incumbent.rank ?? 99999) - fa.rank;
    if (gap < 15) continue;
    seenPos.add(pos);

    const why = [`Free agent at #${fa.rank} in your rankings vs ${incumbent.name} at #${incumbent.rank ?? '—'}.`];
    const rw = realWorldNote(fa);
    if (rw) why.push(`Real-world: ${rw}.`);
    const mk = marketNote(fa);
    if (mk) why.push(`Market: ${mk}.`);

    const young = fa.age != null && fa.age <= 25;
    out.push({
      key: `fa:${fa.playerId}`,
      category: 'freeagent',
      horizon: ctx.isDynasty && young ? 'both' : 'now',
      title: `Add ${fa.name} (${pos})`,
      detail: `Available right now and ${gap} spots better than your weakest starting ${pos}.`,
      why,
      nowImpact: clamp(0.5 + gap / 150, 0, 1),
      futureImpact: ctx.isDynasty && young ? 0.55 : 0.1,
      cta: { label: 'Open free agents', view: 'freeagents' },
    });
    if (out.length >= 2) break;
  }
  return out;
}

// 4. A starting position where your group is among the weakest in the league.
function genPositionalWeakness(ctx) {
  const targets = starterTargets(ctx.league?.roster_positions);
  const byRosterId = new Map();
  for (const p of ctx.opponentPlayers) {
    if (!byRosterId.has(p.rosterId)) byRosterId.set(p.rosterId, []);
    byRosterId.get(p.rosterId).push(p);
  }
  if (!byRosterId.size) return [];

  const groupValue = (players, pos, need) => players
    .filter((p) => primaryPos(p) === pos && p.lifetimeValue != null)
    .sort((a, b) => b.lifetimeValue - a.lifetimeValue)
    .slice(0, Math.max(1, Math.ceil(need)))
    .reduce((s, p) => s + p.lifetimeValue, 0);

  const out = [];
  for (const pos of CORE_POSITIONS) {
    const need = targets[pos] || 0;
    if (need <= 0) continue;
    const mine = groupValue(ctx.myPlayers, pos, need);
    const others = [...byRosterId.values()].map((list) => groupValue(list, pos, need));
    if (others.length < 3) continue;
    const worseThanMe = others.filter((v) => v < mine).length;
    const place = others.length + 1 - worseThanMe; // 1 = best in league
    const total = others.length + 1;
    if (place <= Math.ceil(total * 0.65)) continue; // only flag genuine bottom-third holes

    const weakness = clamp((place - total * 0.65) / (total * 0.35), 0, 1);
    out.push({
      key: `need:${pos}`,
      category: 'need',
      horizon: 'both',
      title: `Upgrade at ${pos}`,
      detail: `Your ${pos} group ranks ${ordinal(place)} of ${total} in this league by Lifetime Value (${fmtLV(mine)}).`,
      why: [
        `This league starts about ${need % 1 ? need.toFixed(1) : need} ${pos}${need > 1 ? 's' : ''} every week, so this is a lineup hole, not a bench problem.`,
        'Structural holes cost you now and keep costing you until you fix them.',
      ],
      nowImpact: clamp(0.45 + weakness * 0.5, 0, 1),
      futureImpact: clamp(0.5 + weakness * 0.45, 0, 1),
      cta: { label: 'Open trade finder', view: 'tradefinder' },
    });
  }
  return out;
}

// 5. Your players the public rates higher than your rankings do — sell into strength.
function genSellHigh(ctx) {
  if (!Number.isFinite(ctx.arbThreshold)) return [];
  const chips = ctx.myPlayers
    .filter((p) => p.arbDelta != null && p.arbDelta <= -ctx.arbThreshold)
    .sort((a, b) => a.arbDelta - b.arbDelta)
    .slice(0, 2);

  return chips.map((p) => {
    const why = [`The public ranks ${p.name} about ${-p.arbDelta} spots higher than your own rankings do.`];
    const mk = marketNote(p);
    if (mk) why.push(`Market: ${mk}.`);
    if (p.lifetimeValueChange != null) {
      why.push(`Your model has him ${p.lifetimeValueChange >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(p.lifetimeValueChange))} LV recently.`);
    }
    const rising = (p.consensus?.trend || 0) > 0;
    return {
      key: `sell:${p.playerId}`,
      category: 'sell',
      horizon: ctx.isDynasty ? 'both' : 'now',
      title: `Sell ${p.name} while the market is high`,
      detail: `You value him at LV ${fmtLV(p.lifetimeValue)}; the public values him more. That gap is free profit in a trade.`,
      why,
      nowImpact: 0.4,
      futureImpact: clamp(0.7 + (rising ? 0.15 : 0), 0, 1),
      cta: { label: 'Open trade finder', view: 'tradefinder' },
    };
  });
}

// 6. Opponents' players your rankings like more than the public does — buy the dip.
function genBuyLow(ctx) {
  if (!Number.isFinite(ctx.arbThreshold)) return [];
  const myTop = Math.max(0, ...ctx.myPlayers.map((p) => p.lifetimeValue || 0));
  const targets = ctx.opponentPlayers
    .filter((p) => p.arbDelta != null && p.arbDelta >= ctx.arbThreshold && p.lifetimeValue != null)
    .filter((p) => p.lifetimeValue <= myTop * 1.5) // has to be somewhere near affordable
    .sort((a, b) => b.arbDelta - a.arbDelta)
    .slice(0, 2);

  return targets.map((p) => {
    const why = [`Your rankings have ${p.name} about ${p.arbDelta} spots higher than the public does.`];
    const mk = marketNote(p);
    if (mk) why.push(`Market: ${mk}.`);
    const rw = realWorldNote(p);
    if (rw) why.push(`Real-world: ${rw}.`);
    const young = p.age != null && p.age <= 25;
    const cooling = (p.consensus?.trend || 0) < 0;
    return {
      key: `buy:${p.playerId}`,
      category: 'buy',
      horizon: ctx.isDynasty && young ? 'future' : 'both',
      title: `Buy low on ${p.name}${p.owner ? ` from ${p.owner}` : ''}`,
      detail: `LV ${fmtLV(p.lifetimeValue)} on your board${cooling ? ', and public value is falling' : ''} — you'd be paying the market's price, not yours.`,
      why,
      nowImpact: 0.5,
      futureImpact: clamp(0.65 + (young ? 0.2 : 0) + (cooling ? 0.1 : 0), 0, 1),
      cta: { label: 'Open trade finder', view: 'tradefinder' },
    };
  });
}

// 7. Dynasty only: valuable players past their positional age cliff, still holding value.
function genAgingAssets(ctx) {
  if (!ctx.isDynasty) return [];
  const aging = ctx.myPlayers
    .filter((p) => {
      const pos = primaryPos(p);
      const cliff = AGE_CLIFF[pos];
      return cliff != null && p.age != null && p.age >= cliff && (p.lifetimeValue || 0) > 0;
    })
    .filter((p) => (p.lifetimeValueChange || 0) > 0 || (p.consensus?.trend || 0) > 0)
    .sort((a, b) => (b.lifetimeValue || 0) - (a.lifetimeValue || 0))
    .slice(0, 2);

  return aging.map((p) => {
    const pos = primaryPos(p);
    const why = [
      `${pos}s typically fall off around ${AGE_CLIFF[pos]}; he's ${p.age}.`,
      'His value is still rising, which is exactly when a dynasty seller should move.',
    ];
    const mk = marketNote(p);
    if (mk) why.push(`Market: ${mk}.`);
    return {
      key: `age:${p.playerId}`,
      category: 'age',
      horizon: 'future',
      title: `Move ${p.name} before the age cliff`,
      detail: `Age ${p.age} ${pos} carrying LV ${fmtLV(p.lifetimeValue)}. In dynasty you want to be a year early, not a year late.`,
      why,
      nowImpact: ctx.posture.key === 'contending' ? 0.05 : 0.2,
      futureImpact: 0.95,
      cta: { label: 'Open trade finder', view: 'tradefinder' },
    };
  });
}

// 8. Roster hygiene: a long-term injury eating a bench spot when IR is open.
function genRosterHygiene(ctx) {
  const slots = ctx.league?.roster_positions || [];
  const irSlots = slots.filter((s) => s === 'IR').length;
  if (!irSlots) return [];
  const onIr = new Set(ctx.myRoster?.reserve || []);
  if (onIr.size >= irSlots) return [];

  const stashable = ctx.myPlayers
    .filter((p) => !onIr.has(p.playerId) && p.injuryStatus && ['IR', 'PUP', 'Out', 'NA', 'Sus'].includes(p.injuryStatus))
    .sort((a, b) => (a.rank ?? 99999) - (b.rank ?? 99999))
    .slice(0, 1);

  return stashable.map((p) => ({
    key: `ir:${p.playerId}`,
    category: 'hygiene',
    horizon: 'now',
    title: `Move ${p.name} to IR`,
    detail: `He's listed ${p.injuryStatus} and you have an open IR slot — parking him frees a bench spot for free.`,
    why: ['Costs you nothing and buys a roster spot you can use on a waiver add.'],
    nowImpact: 0.62,
    futureImpact: 0.15,
    cta: { label: 'Open free agents', view: 'freeagents' },
  }));
}
