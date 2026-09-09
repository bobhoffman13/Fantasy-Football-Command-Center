// LEAGUES > Lineup Optimizer
//
// When a weekly ranking set applies to this league, the optimizer is driven by that
// week's projections instead of the season-long rankings, and the page leads with the
// changes you'd need to make versus the lineup you currently have set in Sleeper.
import { div, span, mount } from '../lib/dom.js';
import { loadLeagueContext } from '../lib/league.js';
import { enrichRoster, weeklyRosterCoverage } from '../lib/players.js';
import { optimizeLineup, weeklyRankOf, pairLineupChanges } from '../lib/lineup.js';
import { getState, getActiveLeagueId } from '../store.js';
import { RISK_MODES } from '../data/constants.js';
import { daysSince } from '../lib/format.js';
import {
  asyncRegion, matchDiagnostic, rankBadge, weeklyBadge, projBadge,
  injuryBadge, byeBadge, emptyBlock, sectionTitle,
} from './components.js';

const local = { leagueId: null };

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  local.leagueId = getActiveLeagueId();

  root.append(body);
  mount(container, root);
  if (local.leagueId) run(() => load(local.leagueId));
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  if (!ctx.myRoster) return emptyBlock('No roster found for your account in this league.');

  const weekly = ctx.weekly;
  const players = enrichRoster(
    ctx.myRoster.players, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode,
    weekly?.byPlayerId || null,
  );
  const rosterPositions = ctx.league?.roster_positions || [];
  const { starters, bench, unfilled } = optimizeLineup(players, rosterPositions,
    weekly ? { rankOf: weeklyRankOf } : {});
  const riskMode = getState().settings.riskMode;

  const out = div({});

  out.appendChild(sourceBanner(weekly, ctx));
  if (weekly) {
    const staleness = weekStaleness(weekly, ctx.nflState);
    if (staleness) out.appendChild(staleness);
    out.appendChild(coverageBlock(weekly, ctx));
  } else {
    out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));
  }

  out.appendChild(div({ class: 'note muted small' },
    `Risk tolerance: ${RISK_MODES[riskMode].label} — ${RISK_MODES[riskMode].desc}. Change it in Setup.`));

  if (unfilled.length) {
    out.appendChild(div({ class: 'diag diag-warn' },
      `⚠ ${unfilled.length} slot(s) could not be filled with a healthy, available player: ${unfilled.join(', ')}.`));
  }

  const changes = lineupChanges(starters, players, ctx.myRoster.starters, !!weekly);
  if (changes) out.appendChild(changes);

  out.appendChild(div({ class: 'card' },
    sectionTitle('Suggested starters'),
    div({ class: 'list' }, ...starters.map((s) => slotRow(s, !!weekly))),
  ));

  out.appendChild(div({ class: 'card' },
    sectionTitle('Bench', `${bench.length}`),
    bench.length
      ? div({ class: 'list' }, ...bench.map((p) => playerLine(p, !!weekly)))
      : emptyBlock('Bench is empty.'),
  ));

  return out;
}

// --- which rankings are driving this page ---

function sourceBanner(weekly, ctx) {
  if (weekly) {
    const scope = weekly.source === 'league' ? 'this league only' : 'default for all leagues';
    return div({ class: 'card weekly-source' },
      div({ class: 'ws-head' },
        span({ class: 'badge badge-weekly' }, weekly.week != null ? `Week ${weekly.week}` : 'Weekly'),
        span({ class: 'ws-name' }, weekly.name),
      ),
      div({ class: 'muted small' },
        `Ranked by projected points · ${weekly.rows.length} players · ${scope} · `
        + `uploaded ${daysSince(weekly.uploadedAt)}d ago`),
    );
  }
  const name = ctx.ranking?.name;
  return div({ class: 'note muted small' },
    name
      ? `Using season rankings: ${name}. Upload weekly rankings in Setup to order this lineup by weekly projections instead.`
      : 'No rankings loaded for this league. Assign a profile or upload weekly rankings in Setup.');
}

// Weekly rankings go stale in days, not weeks — warn loudly on a week mismatch.
function weekStaleness(weekly, nflState) {
  const current = nflState?.display_week;
  if (weekly.mixedWeeks) {
    return div({ class: 'diag diag-warn' },
      `⚠ This set mixes files from weeks ${weekly.mixedWeeks.join(' and ')}. `
      + 'Replace the stale file in Setup so every position is projected for the same week.');
  }
  if (current == null || weekly.week == null || Number(weekly.week) === Number(current)) return null;
  return div({ class: 'diag diag-warn' },
    `⚠ These rankings are for week ${weekly.week}, but it's week ${current}. `
    + 'Upload this week’s files in Setup before trusting these suggestions.');
}

// Coverage of YOUR roster, which is the number that matters for a lineup.
function coverageBlock(weekly, ctx) {
  const cov = weeklyRosterCoverage(ctx.myRoster.players, weekly.byPlayerId, ctx.players);
  if (!cov.missing.length) {
    return div({ class: 'diag diag-ok' }, `All ${cov.total} rostered players have a projection this week.`);
  }
  // Kickers and defenses are routinely absent from weekly files and fill only their
  // own slots, so they're noted separately from a genuine gap at a flex position.
  const names = cov.missing.map((m) => m.name);
  const sample = names.slice(0, 6);
  return div({ class: 'diag diag-none' },
    div({ class: 'diag-head' }, `${cov.covered} of ${cov.total} rostered players projected this week`),
    div({ class: 'diag-unmatched' },
      'No projection: ' + sample.join(', ')
      + (names.length > sample.length ? `, +${names.length - sample.length} more` : '')),
    div({ class: 'diag-hint' },
      'These sort below every projected player. Kickers and defenses are normally missing '
      + 'from weekly files and still fill their own slots correctly.'),
  );
}

// --- changes versus the lineup currently set in Sleeper ---

function lineupChanges(starters, players, currentStarters, isWeekly) {
  const current = new Set((currentStarters || []).filter((id) => id && id !== '0'));
  if (!current.size) return null;

  const byId = new Map(players.map((p) => [p.playerId, p]));
  const optimalIds = new Set(starters.filter((s) => s.player).map((s) => s.player.playerId));
  const bringIn = starters.map((s) => s.player).filter((p) => p && !current.has(p.playerId));
  const sitDown = [...current].filter((id) => !optimalIds.has(id)).map((id) => byId.get(id)).filter(Boolean);

  if (!bringIn.length) {
    return div({ class: 'card' },
      sectionTitle('Changes to make'),
      div({ class: 'diag diag-ok' }, '✓ Your current lineup already matches these rankings.'));
  }

  const key = (p) => (isWeekly ? (p.weekly?.rank ?? Infinity) : (p.rank ?? Infinity));
  bringIn.sort((a, b) => key(a) - key(b));
  sitDown.sort((a, b) => key(b) - key(a));

  const rows = [];
  for (const { inP, outP } of pairLineupChanges(bringIn, sitDown)) {
    rows.push(div({ class: 'swap-row' },
      div({ class: 'swap-in' }, span({ class: 'swap-tag start' }, 'START'), span({ class: 'pr-name' }, inP.name),
        isWeekly ? projBadge(inP.weekly?.proj) : rankBadge(inP.rank)),
      outP
        ? div({ class: 'swap-out' }, span({ class: 'swap-tag sit' }, 'SIT'), span({ class: 'pr-name' }, outP.name),
            isWeekly ? projBadge(outP.weekly?.proj) : rankBadge(outP.rank))
        : div({ class: 'swap-out muted small' }, 'fills an empty slot'),
      reasonLine(inP, outP, isWeekly),
    ));
  }

  return div({ class: 'card' },
    sectionTitle('Changes to make', `${rows.length}`),
    div({ class: 'list' }, ...rows));
}

function reasonLine(inP, outP, isWeekly) {
  if (!outP) return null;
  if (isWeekly) {
    const a = inP.weekly?.proj, b = outP.weekly?.proj;
    if (a == null || b == null) return null;
    const gap = (a - b).toFixed(1);
    const opp = inP.weekly?.opponent;
    return div({ class: 'muted small swap-why' },
      `${gap} more projected points this week${opp ? ` · ${inP.name} faces ${opp}` : ''}`);
  }
  if (inP.rank == null || outP.rank == null) return null;
  return div({ class: 'muted small swap-why' },
    `Ranked ${outP.rank - inP.rank} spots higher in this league’s rankings.`);
}

// --- rows ---

function slotRow({ slot, player }, isWeekly) {
  return div({ class: 'player-row slot-row' },
    span({ class: 'slot-tag' }, slot),
    player
      ? div({ class: 'pr-main' },
          span({ class: 'pr-name' }, player.name,
            player.questionable ? span({ class: 'badge inj-q', title: 'Questionable starter' }, ' Q?') : null),
          span({ class: 'pr-meta muted small' },
            [player.team, player.positions.join('/'), isWeekly ? matchupNote(player) : null].filter(Boolean).join(' · ')))
      : span({ class: 'muted' }, '— empty —'),
    player
      ? div({ class: 'row-badges' },
          injuryBadge(player.injuryStatus),
          isWeekly ? projBadge(player.weekly?.proj) : null,
          isWeekly ? weeklyBadge(player.weekly) : rankBadge(player.rank))
      : null,
  );
}

function playerLine(p, isWeekly) {
  return div({ class: 'player-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, p.name),
      span({ class: 'pr-meta muted small' },
        [p.team, p.positions.join('/'), isWeekly ? matchupNote(p) : null, p.startable ? null : `(${p.reason})`]
          .filter(Boolean).join(' · ')),
    ),
    div({ class: 'row-badges' },
      byeBadge(p.onBye, p.byeWeek), injuryBadge(p.injuryStatus),
      isWeekly ? projBadge(p.weekly?.proj) : null,
      isWeekly ? weeklyBadge(p.weekly) : rankBadge(p.rank)),
  );
}

// Matchup context straight from the weekly file — turns "start him" into "start him,
// and here's the matchup that says so".
function matchupNote(p) {
  const w = p.weekly;
  if (!w) return null;
  const bits = [];
  if (w.opponent) bits.push(`vs ${w.opponent}`);
  if (w.oppRankVsPos != null && w.pos) bits.push(`${ordinal(w.oppRankVsPos)} vs ${w.pos}`);
  if (w.impliedTotal != null) bits.push(`${w.impliedTotal} implied`);
  return bits.length ? bits.join(' · ') : null;
}

function ordinal(n) {
  const v = Math.round(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return v + (s[(m - 20) % 10] || s[m] || s[0]);
}
