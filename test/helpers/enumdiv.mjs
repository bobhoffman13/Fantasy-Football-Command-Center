// TEST ORACLE: exhaustive playoff math for division leagues (no median game).
//
// The app uses the flow-based goal engine in js/lib/playoffs.js for division leagues. This
// file plays out EVERY remaining result instead, which is exact but only feasible for small
// schedules — so the tests use it to verify the app's engine.
//
// "Division winner is automatically in" can't be expressed in the max-flow model used for
// normal leagues, so here we simply play out every remaining result (2^games outcomes).
// That's ~262k outcomes for a 12-team league with 3 weeks left, and a single pass gives
// every team's clinch / elimination / bye / division status plus this week's scenarios.
//
// Ties are handled exactly as in the flow engine: each check is done once with every tie
// going against the team ("certain") and once with every tie going its way ("if
// tiebreakers hold"). Ties between OTHER teams are resolved by the current ranking; that
// can't change the answer for the team being checked, because two tied rivals affect it
// identically whichever of them wins the tie.

import {
  currentStandings, divisionLeaders, buildScenarioLists, MAX_SCENARIO_GAMES, DEFAULT_TIEBREAKER,
} from '../../js/lib/playoffs.js';

export const MAX_ENUM_GAMES = 18; // 2^18 = 262,144 outcomes

export function divisionUnsupported(model) {
  if (model.median) return 'median';
  if (model.schedule.length > MAX_ENUM_GAMES) return 'too_many';
  return null;
}

export function analyzeDivisionRace(model, tiebreaker = DEFAULT_TIEBREAKER, mode = 'top') {
  if (divisionUnsupported(model)) return null;
  const teams = model.teams;
  const n = teams.length;
  const { spots, byes } = model;
  const index = new Map(teams.map((t, i) => [t.rosterId, i]));

  const divIds = [...new Set(teams.map((t) => t.division))];
  const D = divIds.length;
  const div = Int32Array.from(teams, (t) => divIds.indexOf(t.division));
  const wild = Math.max(0, spots - D);

  // Others' ties are ordered by the current overall ranking.
  const tieKey = new Int32Array(n);
  currentStandings(model, tiebreaker, 'none').forEach((t, r) => { tieKey[index.get(t.rosterId)] = r; });

  const games = model.schedule.map((g) => ({ a: index.get(g.a), b: index.get(g.b), week: g.week }));
  const G = games.length;
  const gA = Int32Array.from(games, (g) => g.a);
  const gB = Int32Array.from(games, (g) => g.b);
  const week0 = [];
  games.forEach((g, k) => { if (g.week === model.remainingWeeks[0]) week0.push(k); });
  const V0 = Math.min(week0.length, MAX_SCENARIO_GAMES);
  const keySize = 1 << V0;
  const xGames = Array.from({ length: n }, () => []);
  games.forEach((g, k) => { xGames[g.a].push(k); xGames[g.b].push(k); }); // schedule is in week order

  // Aggregates (1 = "true in every outcome so far" for ALL*, "true in some outcome" for ANY*).
  const allInW = new Uint8Array(n).fill(1);
  const allInB = new Uint8Array(n).fill(1);
  const anyInW = new Uint8Array(n);
  const anyInB = new Uint8Array(n);
  const allByeW = new Uint8Array(n).fill(1);
  const allByeB = new Uint8Array(n).fill(1);
  const allDivW = new Uint8Array(n).fill(1);
  const failW = xGames.map((g) => new Uint8Array(g.length + 1)); // by # of leading wins
  const failB = xGames.map((g) => new Uint8Array(g.length + 1));
  const k0AllW = Array.from({ length: n }, () => new Uint8Array(keySize).fill(1));
  const k0AllB = Array.from({ length: n }, () => new Uint8Array(keySize).fill(1));
  const k0AnyB = Array.from({ length: n }, () => new Uint8Array(keySize));

  const base = Int32Array.from(teams, (t) => t.wp);
  const wp = new Int32Array(n);
  const ord = new Int32Array(n);
  const first = new Int32Array(D);
  const second = new Int32Array(D);
  const pos = new Int32Array(n);      // rank position of each team this outcome
  const cw = new Int32Array(n + 1);   // # division winners among the first r ranked teams
  const gs = new Int32Array(n);       // start of the equal-win-points group at rank r
  const ge = new Int32Array(n);       // end (exclusive) of that group
  const total = 2 ** G;

  for (let mask = 0; mask < total; mask++) {
    wp.set(base);
    for (let k = 0; k < G; k++) wp[(mask >>> k) & 1 ? gA[k] : gB[k]] += 2;
    let key = 0;
    for (let v = 0; v < V0; v++) key |= ((mask >>> week0[v]) & 1) << v;

    // Order by win points then current rank (insertion sort; n is small).
    for (let i = 0; i < n; i++) {
      let j = i;
      while (j > 0) {
        const p = ord[j - 1];
        if (wp[p] > wp[i] || (wp[p] === wp[i] && tieKey[p] < tieKey[i])) break;
        ord[j] = p;
        j--;
      }
      ord[j] = i;
    }
    first.fill(-1);
    second.fill(-1);
    for (let r = 0; r < n; r++) {
      const t = ord[r];
      pos[t] = r;
      const d = div[t];
      if (first[d] < 0) first[d] = t;
      else if (second[d] < 0) second[d] = t;
    }
    for (let r = 0; r < n; r++) cw[r + 1] = cw[r] + (first[div[ord[r]]] === ord[r] ? 1 : 0);
    for (let r = 0; r < n;) {
      let e = r + 1;
      while (e < n && wp[ord[e]] === wp[ord[r]]) e++;
      for (let q = r; q < e; q++) { gs[q] = r; ge[q] = e; }
      r = e;
    }

    for (let x = 0; x < n; x++) {
      const dx = div[x];
      const fx = first[dx];
      const cand = fx === x ? second[dx] : fx; // best division rival
      // Leading wins in x's remaining games (chronological).
      let lead = 0;
      for (const k of xGames[x]) {
        if (((mask >>> k) & 1 ? gA[k] : gB[k]) === x) lead++;
        else break;
      }
      const rx = pos[x];
      for (let pol = 0; pol < 2; pol++) {
        const worst = pol === 0;
        // Teams "before" x are exactly the first `end` ranked teams (x itself included when
        // ties go against it, since x sits inside its own tie group).
        const end = worst ? ge[rx] : gs[rx];
        const xWinsDiv = cand < 0 || pos[cand] >= end;
        const winnersBefore = cw[end] - (pos[fx] < end ? 1 : 0) + (xWinsDiv ? 0 : 1);
        const othersBefore = end - (worst ? 1 : 0) - winnersBefore;
        let inP;
        let seed;
        if (mode === 'top') {
          inP = xWinsDiv || othersBefore < wild;
          seed = xWinsDiv ? 1 + winnersBefore : D + 1 + othersBefore;
        } else {
          inP = xWinsDiv || othersBefore < wild;
          seed = 1 + winnersBefore + Math.min(othersBefore, wild);
        }
        const bye = inP && seed <= byes;
        if (worst) {
          if (!inP) { allInW[x] = 0; failW[x][lead] = 1; k0AllW[x][key] = 0; } else anyInW[x] = 1;
          if (!bye) allByeW[x] = 0;
          if (!xWinsDiv) allDivW[x] = 0;
        } else {
          if (!inP) { allInB[x] = 0; failB[x][lead] = 1; k0AllB[x][key] = 0; } else { anyInB[x] = 1; k0AnyB[x][key] = 1; }
          if (!bye) allByeB[x] = 0;
        }
      }
    }
  }

  // --- turn aggregates into the same analysis shape the flow engine produces ---
  const seeded = currentStandings(model, tiebreaker, mode);
  const seedOf = new Map(seeded.map((t, i) => [t.rosterId, i + 1]));
  const leaders = divisionLeaders(model, tiebreaker);
  const lastWildcard = (() => {
    const inTeams = seeded.slice(0, spots).filter((t) => !leaders.has(t.rosterId));
    return inTeams[inTeams.length - 1] || seeded[spots - 1];
  })();
  const W = model.remainingWeeks.length;
  const noFailFrom = (fail, j) => { for (let p = j; p < fail.length; p++) if (fail[p]) return false; return true; };
  const pairs = week0.slice(0, V0).map((k) => ({ i: gA[k], j: gB[k] }));
  const out = new Map();

  teams.forEach((team, x) => {
    const R = xGames[x].length;
    const seed = seedOf.get(team.rosterId);
    const a = { rosterId: team.rosterId, seed, hedged: false, final: false, weeksLeft: W, approx: false };
    a.divLeader = leaders.has(team.rosterId);
    a.divClinched = Boolean(allDivW[x]);

    const clinch = Boolean(allInW[x]);
    const clinchTB = Boolean(allInB[x]);
    const byeClinch = byes > 0 && Boolean(allByeW[x]);
    const byeClinchTB = byes > 0 && Boolean(allByeB[x]);
    const winOut = noFailFrom(failW[x], R);
    const winOutTB = noFailFrom(failB[x], R);
    const elim = !anyInB[x];

    if (byeClinchTB) { a.status = 'clinched_bye'; a.hedged = !byeClinch; }
    else if (clinchTB) { a.status = 'clinched'; a.hedged = !clinch; }
    else if (elim) a.status = 'eliminated';
    else if (winOutTB) { a.status = 'control'; a.hedged = !winOut; }
    else a.status = seed <= spots ? 'bubble' : 'hunt';
    a.aliveOnlyViaTB = !elim && !anyInW[x];
    a.inClinched = clinch;

    if (a.status === 'control') {
      const fail = a.hedged ? failB[x] : failW[x];
      a.winNext = R;
      for (let j = 1; j < R; j++) if (noFailFrom(fail, j)) { a.winNext = j; break; }
    }

    if (seed > spots && lastWildcard) {
      a.gamesBack = (lastWildcard.wp - team.wp) / 2;
      a.lastIn = lastWildcard.name;
      a.lastInWildcard = model.divisions && !leaders.has(lastWildcard.rosterId);
    }

    const alive = a.status === 'control' || a.status === 'bubble' || a.status === 'hunt';
    if (alive && V0 && V0 === week0.length) {
      const ownVar = pairs.findIndex((g) => g.i === x || g.j === x);
      const fe = Uint8Array.from(k0AnyB[x], (v) => (v ? 0 : 1));
      a.scenarios = buildScenarioLists(teams, pairs, ownVar, x, k0AllW[x], k0AllB[x], fe, V0, model.remainingWeeks[0]);
      if (ownVar >= 0) {
        let winIn = true;
        let winInTB = true;
        let loseOut = true;
        for (let key = 0; key < keySize; key++) {
          const firstWins = (key >> ownVar) & 1;
          const xWon = (firstWins ? pairs[ownVar].i : pairs[ownVar].j) === x;
          if (xWon) { winIn &&= Boolean(k0AllW[x][key]); winInTB &&= Boolean(k0AllB[x][key]); }
          else loseOut &&= !k0AnyB[x][key];
        }
        a.pivotal = { winIn, winInTB, loseOut };
      }
    }
    out.set(team.rosterId, a);
  });
  return out;
}
