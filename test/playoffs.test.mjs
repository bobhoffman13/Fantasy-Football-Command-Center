// Playoff race math: exact clinch/elimination (schedule-aware), tiebreaker hedging,
// Monte Carlo consistency, and the copy-paste league update.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSeasonModel, analyzeRace, currentStandings, playoffByes, explain, rankTeams,
} from '../js/lib/playoffs.js';
import { simulatePlayoffs } from '../js/lib/playoffsim.js';
import { buildLeagueUpdate } from '../js/lib/playoffmsg.js';

// teams: [[rosterId, wins, losses, pf?]]; future: { week: [[a, b], ...] }
function fixture({ teams, future = {}, past = {}, settings = {} }) {
  const rosters = teams.map(([id, w, l, pf = 1000 + id, extra = {}]) => ({
    roster_id: id, owner_id: `u${id}`,
    settings: { wins: w, losses: l, ties: 0, fpts: Math.floor(pf), fpts_decimal: 0, fpts_against: 900, ...extra },
  }));
  const matchupsByWeek = {};
  const add = (week, pairs, pointsFor) => {
    matchupsByWeek[week] = pairs.flatMap(([a, b], m) => [
      { roster_id: a, matchup_id: m + 1, points: pointsFor ? pointsFor(a, week) : 0 },
      { roster_id: b, matchup_id: m + 1, points: pointsFor ? pointsFor(b, week) : 0 },
    ]);
  };
  for (const [w, pairs] of Object.entries(past)) add(Number(w), pairs, (id) => 100 + id);
  for (const [w, pairs] of Object.entries(future)) add(Number(w), pairs);
  const league = { settings: { playoff_teams: 2, playoff_week_start: 15, ...settings } };
  return buildSeasonModel({ league, rosters, nameFor: (r) => `T${r.roster_id}`, matchupsByWeek });
}

// 12 games played, 2 left. Top 2 make it.
const race = () => fixture({
  teams: [[1, 10, 2], [2, 8, 4], [3, 7, 5], [4, 3, 9]],
  future: { 13: [[1, 2], [3, 4]], 14: [[1, 3], [2, 4]] },
});

test('byes follow bracket size', () => {
  assert.equal(playoffByes(6), 2);
  assert.equal(playoffByes(4), 0);
  assert.equal(playoffByes(7), 1);
  assert.equal(playoffByes(8), 0);
  assert.equal(playoffByes(12), 4);
});

test('remaining weeks come from the W-L record, not the calendar', () => {
  const m = race();
  assert.equal(m.completedWeeks, 12);
  assert.deepEqual(m.remainingWeeks, [13, 14]);
  assert.equal(m.schedule.length, 4);
});

test('statuses: clinched / in control / hunt / eliminated', () => {
  const a = analyzeRace(race());
  assert.equal(a.get(1).status, 'clinched');
  assert.equal(a.get(1).hedged, false);
  assert.equal(a.get(2).status, 'control');
  assert.equal(a.get(2).winNext, 2, 'beating T1 alone is not enough without tiebreakers');
  assert.equal(a.get(2).pivotal.winIn, false);
  assert.equal(a.get(2).pivotal.winInTB, true, 'win this week = in, if tiebreakers hold');
  assert.equal(a.get(3).status, 'hunt');
  assert.equal(a.get(4).status, 'eliminated');
  assert.match(explain(a.get(2), { you: true }), /Win out and you're in/);
});

test('clinch accounts for rivals playing each other', () => {
  // T1 has 8 wins; T2 and T3 have 7 and play each other in the last week: only one can reach 8.
  const m = fixture({
    teams: [[1, 8, 5], [2, 7, 6], [3, 7, 6], [4, 0, 13]],
    future: { 14: [[2, 3], [1, 4]] },
  });
  const a = analyzeRace(m);
  assert.equal(a.get(1).status, 'clinched');
  assert.equal(a.get(1).hedged, false);
});

test('a clinch that needs a tie to go your way is hedged', () => {
  // T1 at 8 loses to T4 -> 8. T2 (7) can reach 8 by beating T3; T3 then can't.
  // With T4 also reaching... T4 at 7 beating T1 -> 8. Two teams at 8 => T1 only in on tiebreakers.
  const m = fixture({
    teams: [[1, 8, 5], [2, 7, 6], [3, 6, 7], [4, 7, 6]],
    future: { 14: [[1, 4], [2, 3]] },
  });
  const a = analyzeRace(m).get(1);
  assert.equal(a.status, 'clinched');
  assert.equal(a.hedged, true);
  assert.match(explain(a), /if tiebreakers hold/);
});

test('first-round bye clinch with 6 playoff teams', () => {
  const teams = [[1, 13, 0], [2, 12, 1], [3, 7, 6], [4, 7, 6], [5, 7, 6], [6, 6, 7], [7, 6, 7], [8, 5, 8], [9, 3, 10], [10, 1, 12]];
  const m = fixture({
    teams,
    settings: { playoff_teams: 6 },
    future: { 14: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]] },
  });
  const a = analyzeRace(m);
  assert.equal(m.byes, 2);
  assert.equal(a.get(1).status, 'clinched_bye');
  assert.equal(a.get(2).status, 'clinched_bye');
  assert.equal(a.get(10).status, 'eliminated');
});

test('Monte Carlo agrees with the exact math and is deterministic', () => {
  const m = race();
  const odds = simulatePlayoffs(m, { iterations: 4000, seed: 7 });
  const again = simulatePlayoffs(m, { iterations: 4000, seed: 7 });
  assert.deepEqual(odds, again);
  assert.equal(odds.byRoster[1].playoffPct, 100);
  assert.equal(odds.byRoster[4].playoffPct, 0);
  const total = Object.values(odds.byRoster).reduce((s, o) => s + o.playoffPct, 0);
  assert.ok(Math.abs(total - 200) < 1e-6, 'exactly `spots` teams make it every run');
  // Conditioning on this week: winning can't make your odds worse.
  assert.ok(odds.byRoster[3].ifWinPct >= odds.byRoster[3].ifLosePct);
});

test('median-game leagues: two games a week, never invents a clinch', () => {
  const m = fixture({
    teams: [[1, 20, 4], [2, 16, 8], [3, 14, 10], [4, 6, 18]],
    settings: { league_average_match: 1 },
    future: { 13: [[1, 2], [3, 4]], 14: [[1, 3], [2, 4]] },
  });
  assert.equal(m.gamesPerWeek, 2);
  assert.equal(m.completedWeeks, 12);
  const a = analyzeRace(m);
  assert.equal(a.get(1).status, 'clinched'); // 20 vs best rival max 16+4=20... T2 must also beat T1
  assert.equal(a.get(4).status, 'eliminated');
  const odds = simulatePlayoffs(m, { iterations: 2000 });
  const total = Object.values(odds.byRoster).reduce((s, o) => s + o.playoffPct, 0);
  assert.ok(Math.abs(total - 200) < 1e-6);
});

test('tiebreakers: points for, points against, head-to-head', () => {
  const teams = [
    { rosterId: 1, wp: 16, pf: 1200, pa: 1000 },
    { rosterId: 2, wp: 16, pf: 1100, pa: 1300 },
    { rosterId: 3, wp: 10, pf: 1500, pa: 900 },
  ];
  assert.deepEqual(rankTeams(teams, 'pf').map((t) => t.rosterId), [1, 2, 3]);
  assert.deepEqual(rankTeams(teams, 'pa').map((t) => t.rosterId), [2, 1, 3]);
  const h2h = (a, b) => (a === 2 && b === 1 ? { w: 1, l: 0, t: 0 } : a === 1 && b === 2 ? { w: 0, l: 1, t: 0 } : null);
  assert.deepEqual(rankTeams(teams, 'h2h', h2h).map((t) => t.rosterId), [2, 1, 3]);
});

test('head-to-head records are built from completed weeks', () => {
  const m = fixture({
    teams: [[1, 1, 0], [2, 0, 1]],
    past: { 1: [[1, 2]] },
    future: { 2: [[1, 2]] },
  });
  assert.deepEqual(m.h2h[2][1], { w: 1, l: 0, t: 0 }); // fixture scores 100+id, so T2 won
  assert.deepEqual(m.history[1], [101]);
});

test('division leagues fall back to standings only', () => {
  const m = fixture({ teams: [[1, 5, 5], [2, 5, 5]], settings: { divisions: 2 }, future: { 11: [[1, 2]] } });
  assert.equal(analyzeRace(m), null);
});

test('regular season complete: final seeding, no scenarios', () => {
  const m = fixture({ teams: [[1, 10, 4], [2, 9, 5, 1300], [3, 9, 5, 1200], [4, 0, 14]] });
  assert.equal(m.complete, true);
  const a = analyzeRace(m);
  assert.equal(a.get(1).final, true);
  assert.equal(a.get(2).status, 'clinched');
  assert.equal(a.get(2).hedged, true, 'won the seed on a points tiebreaker');
  assert.equal(a.get(3).status, 'eliminated');
});

test('league update covers every team, the line, and the status groups', () => {
  const m = race();
  const analysis = analyzeRace(m);
  const odds = simulatePlayoffs(m, { iterations: 1000 });
  const msg = buildLeagueUpdate({ leagueName: 'Dynasty Bros', model: m, ranked: currentStandings(m), analysis, odds, tiebreaker: 'pf' });
  assert.match(msg, /PLAYOFF PICTURE — Week 13/);
  assert.match(msg, /Dynasty Bros/);
  for (const n of ['T1', 'T2', 'T3', 'T4']) assert.ok(msg.includes(n));
  assert.match(msg, /playoff line/);
  assert.match(msg, /✅ CLINCHED: T1\n/);
  assert.match(msg, /❌ ELIMINATED: T4\n/);
  assert.match(msg, /🎯 T2 \(#2/);
  assert.match(msg, /Tiebreaker: points for · odds from 1,000 sims/);
  assert.ok(!/\[[A-Z ]+\]/.test(msg), 'no template placeholders');
  console.log('\n' + msg);
});

// --- this week's scenarios -----------------------------------------------------------

import { scenarioText } from '../js/lib/playoffs.js';
import { mulberry32 } from '../js/lib/playoffsim.js';

test('this-week scenarios read like NFL clinching scenarios', () => {
  const a = analyzeRace(race());
  const t2 = a.get(2).scenarios;
  assert.equal(t2.week, 13);
  assert.deepEqual(t2.clinch.map(scenarioText), [
    'Win + T4 beats T3',
    'Win (if tiebreakers hold)',
    'T4 beats T3 (if tiebreakers hold)', // T2 can still reach 8; T3 then tops out at 8 too
  ]);
  assert.deepEqual(a.get(3).scenarios.elim.map(scenarioText), ['Loss + T2 beats T1']);
  assert.equal(a.get(1).scenarios, undefined, 'clinched teams get no scenarios');
});

test('league update lists what every live team needs', () => {
  const m = race();
  const msg = buildLeagueUpdate({ leagueName: 'L', model: m, ranked: currentStandings(m), analysis: analyzeRace(m), odds: null, tiebreaker: 'pf' });
  assert.match(msg, /WHAT EACH TEAM NEEDS — WEEK 13/);
  assert.match(msg, /T2 \(#2 · 8-4\)\nClinches this week with:\n• Win \+ T4 beats T3\n• Win \(if tiebreakers hold\)\n• T4 beats T3 \(if tiebreakers hold\)\nOtherwise: win out and they're in\./);
  assert.match(msg, /T3 \(#3 · 7-5\)\nCan’t clinch this week\.\n.*\nEliminated this week with:\n• Loss \+ T2 beats T1/);
});

// Brute force: play out EVERY remaining result and confirm each listed scenario truly
// clinches (ties counted against) or eliminates (ties counted in favour), and that no
// clinching combination of this week's results is missing from the list.
function bruteCheck(m, analysis) {
  const games = m.schedule;
  const idx = new Map(m.teams.map((t, i) => [t.rosterId, i]));
  const name = new Map(m.teams.map((t) => [t.name, t.rosterId]));
  const week0 = games.filter((g) => g.week === m.remainingWeeks[0]);
  const outcomes = [];
  for (let mask = 0; mask < 1 << games.length; mask++) {
    const wp = m.teams.map((t) => t.wp);
    const winners = new Set();
    games.forEach((g, b) => {
      const w = (mask >> b) & 1 ? g.a : g.b;
      wp[idx.get(w)] += 2;
      if (g.week === m.remainingWeeks[0]) winners.add(w);
    });
    outcomes.push({ wp, winners });
  }
  const holds = (sc, x, o) => sc.lits.every((l) => {
    if (l.self) return o.winners.has(x) === (l.result === 'win');
    return o.winners.has(name.get(l.winner));
  });
  for (const t of m.teams) {
    const a = analysis.get(t.rosterId);
    if (!a.scenarios) continue;
    const xi = idx.get(t.rosterId);
    const xGame = week0.find((g) => g.a === t.rosterId || g.b === t.rosterId);
    for (const sc of a.scenarios.clinch.filter((s) => !s.hedged)) {
      for (const o of outcomes) if (holds(sc, t.rosterId, o)) {
        const above = o.wp.filter((w, i) => i !== xi && w >= o.wp[xi]).length;
        assert.ok(above < m.spots, `${t.name}: "${scenarioText(sc)}" failed`);
      }
    }
    for (const sc of a.scenarios.elim) {
      for (const o of outcomes) if (holds(sc, t.rosterId, o)) {
        const above = o.wp.filter((w, i) => i !== xi && w > o.wp[xi]).length;
        assert.ok(above >= m.spots, `${t.name}: "${scenarioText(sc)}" elim failed`);
      }
    }
    // Completeness: a week-0 result set that clinches in every continuation must be listed.
    const byWeek0 = new Map();
    for (const o of outcomes) {
      const key = week0.map((g) => (o.winners.has(g.a) ? 'a' : 'b')).join('');
      const above = o.wp.filter((w, i) => i !== xi && w >= o.wp[xi]).length;
      byWeek0.set(key, (byWeek0.get(key) ?? true) && above < m.spots);
    }
    for (const [key, alwaysIn] of byWeek0) {
      if (!alwaysIn) continue;
      const sample = outcomes.find((o) => week0.map((g) => (o.winners.has(g.a) ? 'a' : 'b')).join('') === key);
      assert.ok(a.scenarios.clinch.some((sc) => !sc.hedged && holds(sc, t.rosterId, sample)),
        `${t.name}: clinching week-${m.remainingWeeks[0]} result ${key} (own game ${xGame ? 'yes' : 'bye'}) not listed`);
    }
  }
}

test('scenarios are sound and complete against brute force (random leagues)', () => {
  const rng = mulberry32(99);
  let checked = 0;
  for (let trial = 0; trial < 25; trial++) {
    const n = 6;
    const played = 10;
    const teams = Array.from({ length: n }, (_, i) => {
      const w = Math.floor(rng() * (played + 1));
      return [i + 1, w, played - w, 1000 + Math.floor(rng() * 400)];
    });
    const future = {};
    for (let w = 11; w <= 13; w++) {
      const order = [1, 2, 3, 4, 5, 6].sort(() => rng() - 0.5);
      future[w] = [[order[0], order[1]], [order[2], order[3]], [order[4], order[5]]];
    }
    const m = fixture({ teams, future, settings: { playoff_teams: 3, playoff_week_start: 14 } });
    const analysis = analyzeRace(m);
    bruteCheck(m, analysis);
    checked += [...analysis.values()].filter((a) => a.scenarios).length;
  }
  assert.ok(checked > 20, `exercised ${checked} live teams`);
});
