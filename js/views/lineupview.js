// LEAGUES > Lineup Optimizer
//
// When a weekly ranking set applies to this league, the optimizer is driven by that
// week's projections instead of the season-long rankings, and the page leads with the
// changes you'd need to make versus the lineup you currently have set in Sleeper.
import { div, span, el, mount, toast } from '../lib/dom.js';
import { loadLeagueContext, rosteredPlayerIds } from '../lib/league.js';
import { enrichRoster, enrichPlayer, weeklyRosterCoverage, clearLookupCache } from '../lib/players.js';
import { optimizeLineup, weeklyRankOf, pairLineupChanges, findPickupUpgrades, dropCandidate } from '../lib/lineup.js';
import { getState, getActiveLeagueId, getWeeklySets, addWeeklyFile } from '../store.js';
import { inferDefense } from '../lib/csv.js';
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
  local.reload = () => { if (local.leagueId) run(() => load(local.leagueId)); };

  root.append(body);
  mount(container, root);
  local.reload();
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  if (!ctx.myRoster) return emptyBlock('No roster found for your account in this league.');

  const weekly = ctx.weekly;
  // Sleeper won't let you start a player sitting in an IR or taxi slot, so neither can
  // the optimizer (and neither counts against your bench when picking someone up).
  const reserve = new Set(ctx.myRoster.reserve || []);
  const taxi = new Set(ctx.myRoster.taxi || []);
  const players = enrichRoster(
    ctx.myRoster.players, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode,
    weekly?.byPlayerId || null,
  ).map((p) => {
    if (taxi.has(p.playerId)) return { ...p, startable: false, questionable: false, reason: 'Taxi squad' };
    if (reserve.has(p.playerId)) return { ...p, startable: false, questionable: false, reason: 'IR slot' };
    return p;
  });
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
    const defHelp = defenseHelp(weekly, players);
    if (defHelp) out.appendChild(defHelp);
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

  if (weekly || ctx.ranking) {
    out.appendChild(pickupCard(ctx, players, rosterPositions, weekly, new Set([...reserve, ...taxi])));
  }

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

// Your defense has no projection: say exactly why, and fix the common case in one tap —
// the DST file was uploaded as its own weekly set instead of into the set this league uses.
function defenseHelp(weekly, players) {
  const unprojected = players.filter((p) => p.positions.includes('DEF') && !p.weekly);
  if (!unprojected.length) return null;
  const setHasDef = weekly.rows.some((r) => r.pos === 'DEF');
  if (setHasDef) {
    return div({ class: 'diag diag-warn' },
      `⚠ “${weekly.name}” has defense rankings, but none for ${unprojected.map((p) => p.name).join(', ')}. `
      + 'Check that team is in your DST file.');
  }
  // Is there a DEF file sitting in another set?
  let source = null;
  for (const set of getWeeklySets()) {
    if (set.id === weekly.set.id) continue;
    for (const f of set.files || []) {
      if (!(f.rows || []).some((r) => inferDefense({ ...r }).pos === 'DEF')) continue;
      if (!source || (f.uploadedAt || 0) > (source.file.uploadedAt || 0)) source = { set, file: f };
    }
  }
  if (!source) {
    return div({ class: 'diag diag-warn' },
      `⚠ No defense projections: this league uses the weekly set “${weekly.name}”, which has no DST file. `
      + `Add it in Setup → Weekly rankings → “${weekly.name}” → Add / replace file.`);
  }
  const fix = el('button', { type: 'button', class: 'btn btn-sm btn-primary',
    onclick: async () => {
      fix.disabled = true;
      await addWeeklyFile(weekly.set.id, { label: 'DEF', rows: source.file.rows, week: source.file.week });
      clearLookupCache();
      toast(`Added defenses to “${weekly.name}”`, 'success');
      local.reload?.();
    } }, `Add them to “${weekly.name}”`);
  return div({ class: 'diag diag-warn' },
    div({}, `⚠ Your defense projections are in the weekly set “${source.set.name}”, but this league uses “${weekly.name}”.`),
    div({ class: 'btn-row' }, fix));
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

// --- available players who would start for you ---

const PICKUP_LIMIT = 8;

function pickupCard(ctx, roster, rosterPositions, weekly, keepIds) {
  const isWeekly = !!weekly;
  // Candidates: anyone unrostered that the active rankings know about.
  const rostered = rosteredPlayerIds(ctx.rosters);
  const ids = new Set([...ctx.rankingLookup.keys(), ...(weekly ? weekly.byPlayerId.keys() : [])]);
  const freeAgents = [];
  for (const id of ids) {
    if (rostered.has(id)) continue;
    const raw = ctx.players[id];
    if (raw && raw.active === false) continue;
    freeAgents.push(enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode, weekly?.byPlayerId || null));
  }

  const proj = (p) => p?.weekly?.proj ?? null;
  const gainOf = isWeekly
    ? (fa, out) => {
        if (!out) return Infinity;
        if (proj(fa) != null && proj(out) != null) return proj(fa) - proj(out);
        if (proj(fa) != null) return proj(fa);
        return ((out.rank ?? 1e5) - (fa.rank ?? 1e5)) / 1e6; // unprojected (K/DEF): order only
      }
    : undefined;
  const upgrades = findPickupUpgrades(roster, freeAgents, rosterPositions,
    { ...(isWeekly ? { rankOf: weeklyRankOf, gainOf } : {}), limit: PICKUP_LIMIT });

  const activeCount = roster.filter((p) => !keepIds.has(p.playerId)).length;
  const openSpots = Math.max(0, rosterPositions.length - activeCount);

  const lset = ctx.league?.settings || {};
  const faabTotal = Number(lset.waiver_budget) || 0;
  const faabLeft = faabTotal - (Number(ctx.myRoster?.settings?.waiver_budget_used) || 0);
  const sub = [
    isWeekly ? 'by this week’s projections' : 'by your season rankings',
    faabTotal > 0 ? `FAAB $${faabLeft} left` : null,
    openSpots ? `${openSpots} open roster spot${openSpots === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  const card = div({ class: 'card' }, sectionTitle('Pickup upgrades', sub));
  const leagueType = getState().settings.leagueTypes?.[ctx.league?.league_id];
  if (!isWeekly && leagueType === 'dynasty') {
    card.appendChild(div({ class: 'muted small pickup-note' },
      'Heads up: these use your dynasty rankings (long-term value), not this week’s outlook. Upload weekly rankings in Setup for start/sit-accurate pickups.'));
  }
  if (!upgrades.length) {
    card.appendChild(div({ class: 'diag diag-ok' }, '✓ No available player would crack your starting lineup.'));
    return card;
  }

  card.appendChild(div({ class: 'list' }, ...upgrades.map(({ player, slot, displaced, gain, lineup }) => {
    const why = !displaced
      ? `Starts at ${slot} — fills an empty slot`
      : `Starts at ${slot}, bumping ${displaced.name} from your lineup${pickupGain(player, displaced, isWeekly)}`;
    const drop = openSpots > 0 ? null : dropCandidate(lineup, keepIds);
    return div({ class: 'swap-row pickup-row' },
      div({ class: 'swap-in' },
        span({ class: 'swap-tag add' }, 'ADD'),
        span({ class: 'pr-name' }, player.name),
        span({ class: 'pr-meta muted small' },
          [player.team, player.positions.join('/'), isWeekly ? matchupNote(player) : null].filter(Boolean).join(' · ')),
        player.questionable ? span({ class: 'badge inj-q', title: 'Questionable' }, 'Q') : null,
        isWeekly ? projBadge(proj(player)) : null,
        isWeekly ? weeklyBadge(player.weekly) : rankBadge(player.rank)),
      div({ class: 'muted small swap-why' }, why),
      openSpots > 0
        ? div({ class: 'muted small pickup-drop' }, 'Room on your roster — no drop needed.')
        : drop
          ? div({ class: 'muted small pickup-drop' }, 'Drop candidate: ', span({ class: 'pr-name' }, drop.name), ' ', rankBadge(drop.rank),
              drop.positions?.length ? ` (${drop.positions.join('/')})` : '')
          : null,
    );
  })));
  card.appendChild(div({ class: 'muted small pickup-note' },
    'Includes players on waivers (a claim may be needed). The drop candidate is your lowest-ranked bench player by season rankings — double-check before cutting anyone in dynasty.'));
  return card;
}

function pickupGain(fa, out, isWeekly) {
  if (isWeekly) {
    const a = fa.weekly?.proj;
    const b = out.weekly?.proj;
    if (a != null && b != null) return ` (+${(a - b).toFixed(1)} projected pts)`;
    if (a != null) return ` (${a.toFixed(1)} projected pts; ${out.name} has no projection)`;
    return '';
  }
  if (fa.rank != null && out.rank != null) { const d = out.rank - fa.rank; return ` (ranked ${d} spot${d === 1 ? "" : "s"} higher)`; }
  if (fa.rank != null) return ` (${out.name} is unranked)`;
  return '';
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
