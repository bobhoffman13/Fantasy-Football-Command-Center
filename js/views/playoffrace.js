// TOOLS → Playoff Race (spec 5.4.1): standings, exact scenarios, Monte Carlo odds, and a
// copy-paste league update. All math lives in lib/playoffs*.js; this file only renders.

import { div, span, btn, el, mount, copyToClipboard } from '../lib/dom.js';
import { getState, updateMap } from '../store.js';
import { getRosters, getLeagueUsers, getMatchups } from '../api/sleeper.js';
import { ownerDisplayName, findLeague } from '../lib/league.js';
import {
  buildSeasonModel, currentStandings, analyzeRace, explain, STATUS, TIEBREAKERS, DEFAULT_TIEBREAKER,
  DIVISION_MODES, DEFAULT_DIVISION_MODE, divisionLeaders, unsupportedReason,
} from '../lib/playoffs.js';
import { simulatePlayoffs, formatPct, buildScoreModel, winProbability } from '../lib/playoffsim.js';
import { buildLeagueUpdate, settledOf, teamNeeds } from '../lib/playoffmsg.js';
import { leagueSelector, asyncRegion, sectionTitle, emptyBlock } from './components.js';

const SIM_ITERATIONS = 10000;
const state = { leagueId: null };

export function tiebreakerFor(leagueId) {
  return getState().settings.tiebreakers?.[leagueId] || DEFAULT_TIEBREAKER;
}

export function divisionModeFor(leagueId) {
  return getState().settings.divisionModes?.[leagueId] || DEFAULT_DIVISION_MODE;
}

function segmented(label, options, current, onPick) {
  return div({ class: 'field' },
    span({ class: 'field-label' }, label),
    div({ class: 'segmented' }, ...Object.entries(options).map(([key, o]) => btn({
      class: 'seg' + (key === current ? ' active' : ''),
      title: o.desc,
      onclick: () => { if (key !== current) onPick(key); },
    }, o.label))));
}

export function renderPlayoff(host) {
  const { session } = getState();
  if (!session.leagues.length) { mount(host, emptyBlock('Connect your account in Setup first.')); return; }

  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);
  const tbHost = div({});
  const sel = leagueSelector('playoff', (id) => { state.leagueId = id; paintTiebreaker(); trigger(); });
  if (!session.leagues.some((l) => l.league_id === state.leagueId)) state.leagueId = sel.selectedId;

  function paintTiebreaker() {
    const id = state.leagueId;
    const hasDivisions = Number(findLeague(id)?.settings?.divisions) >= 2;
    mount(tbHost,
      segmented('Tiebreaker (match your league rules)', TIEBREAKERS, tiebreakerFor(id), (key) => {
        updateMap('tiebreakers', id, key === DEFAULT_TIEBREAKER ? undefined : key);
        paintTiebreaker();
        trigger();
      }),
      hasDivisions ? segmented('Division winners', DIVISION_MODES, divisionModeFor(id), (key) => {
        updateMap('divisionModes', id, key === DEFAULT_DIVISION_MODE ? undefined : key);
        paintTiebreaker();
        trigger();
      }) : null);
  }

  function trigger() {
    if (state.leagueId) run(() => loadRace(state.leagueId, tiebreakerFor(state.leagueId), divisionModeFor(state.leagueId)));
  }

  paintTiebreaker();
  mount(host, div({}, sel.node, tbHost, body,
    div({ class: 'btn-row' }, btn({ class: 'btn', onclick: trigger }, 'Refresh'))));
  trigger();
}

async function loadRace(leagueId, tiebreaker, divisionMode) {
  const league = findLeague(leagueId);
  const { settings } = getState();
  const regEnd = Math.min(18, Math.max(1, (Number(league?.settings?.playoff_week_start) || 15) - 1));
  const weeks = Array.from({ length: regEnd }, (_, i) => i + 1); // never out of range
  const [rosters, users, ...weekly] = await Promise.all([
    getRosters(leagueId),
    getLeagueUsers(leagueId),
    ...weeks.map((w) => getMatchups(leagueId, w).catch(() => [])),
  ]);
  const usersById = {};
  for (const u of users || []) usersById[u.user_id] = u;
  const matchupsByWeek = {};
  weeks.forEach((w, i) => { matchupsByWeek[w] = weekly[i] || []; });

  const model = buildSeasonModel({
    league, rosters,
    nameFor: (r) => (r.owner_id ? ownerDisplayName(usersById, r.owner_id) : `Team ${r.roster_id}`),
    matchupsByWeek,
  });
  const notStarted = model.completedWeeks === 0;
  const ranked = currentStandings(model, tiebreaker, divisionMode);
  // Let the spinner paint before the heavy math occupies the main thread.
  await new Promise((r) => setTimeout(r, 16));
  const analysis = notStarted ? null : analyzeRace(model, tiebreaker, divisionMode);
  const canSimulate = !notStarted && !model.complete && !model.scheduleIncomplete;
  const odds = canSimulate ? simulatePlayoffs(model, { iterations: SIM_ITERATIONS, tiebreaker, divisionMode }) : null;
  const me = model.teams.find((t) => t.ownerId === settings.userId) || null;
  const v = {
    league, model, ranked, analysis, odds, tiebreaker, divisionMode, notStarted, me,
    leaders: model.divisions && divisionMode !== 'none' ? divisionLeaders(model, tiebreaker) : null,
    unsupported: notStarted ? null : unsupportedReason(model, divisionMode),
  };

  const out = div({});
  if (me && analysis) out.appendChild(myRaceCard(model, me, analysis.get(me.rosterId), odds, tiebreaker));
  out.appendChild(updateCard(v));
  out.appendChild(standingsCard(v));
  if (analysis && !model.complete) {
    const needs = needsCard(model, ranked, analysis, odds, me);
    if (needs) out.appendChild(needs);
  }
  out.appendChild(assumptionsCard(v));
  return out;
}

function statusPill(a) {
  if (!a) return null;
  const s = STATUS[a.status];
  const label = a.final ? (a.status === 'eliminated' ? 'Out' : a.status === 'clinched_bye' ? 'Bye' : 'In') : s.label;
  return span({ class: `pill pill-${s.tone}` }, label + (a.hedged ? '*' : ''));
}

function myRaceCard(model, me, a, odds, tiebreaker) {
  const o = odds?.byRoster[me.rosterId];
  const settled = settledOf(a);
  const card = div({ class: 'card race-hero' });
  card.appendChild(sectionTitle('Your playoff race', `${me.name} · #${a.seed} seed · ${me.wins}-${me.losses}${me.ties ? '-' + me.ties : ''}`));
  card.appendChild(div({ class: 'race-head' },
    div({ class: `race-status tone-${STATUS[a.status].tone}` },
      STATUS[a.status].label + (a.status === 'control' ? ' (win out = in)' : a.status === 'hunt' ? ' (needs help)' : '')
      + (a.hedged ? '*' : '')),
    o ? div({ class: 'race-odds' }, div({ class: 'race-odds-n' }, formatPct(o.playoffPct, { settled })), div({ class: 'stat-label' }, 'playoff odds')) : null,
  ));
  card.appendChild(div({ class: 'race-explain' }, explain(a, { you: true })));

  const n = teamNeeds(a, { you: true });
  if (n) card.appendChild(needsLists(n, { you: true }));

  const facts = [];
  if (a.magic != null && a.status !== 'control') facts.push(`Magic number: ${a.magic} (your wins + ${a.magicRival} losses)`);
  if (a.tragic != null && (a.status === 'hunt' || a.status === 'bubble')) facts.push(`Tragic number: ${a.tragic} (your losses + ${a.tragicRival} wins)`);
  if (o?.byePct != null && a.status !== 'eliminated' && !a.final) facts.push(`First-round bye odds: ${formatPct(o.byePct, { settled: a.status === 'clinched_bye' && !a.hedged ? 'in' : null })}`);

  const week = model.remainingWeeks[0];
  const game = model.schedule.find((g) => g.week === week && (g.a === me.rosterId || g.b === me.rosterId));
  if (game) {
    const oppId = game.a === me.rosterId ? game.b : game.a;
    const opp = model.teams.find((t) => t.rosterId === oppId);
    const sm = buildScoreModel(model);
    const wp = winProbability(sm.params[me.rosterId], sm.params[oppId]);
    let line = `Week ${week} vs ${opp?.name || 'TBD'} · ~${Math.round(wp * 100)}% to win`;
    if (o?.ifWinPct != null && o?.ifLosePct != null && !settled) {
      line += ` · win → ${formatPct(o.ifWinPct)}, lose → ${formatPct(o.ifLosePct)}`;
    }
    facts.push(line);
  }
  if (facts.length) card.appendChild(div({ class: 'race-facts' }, ...facts.map((f) => div({}, f))));
  if (a.hedged) card.appendChild(div({ class: 'muted small' }, `* Depends on a tiebreaker (assumed: ${TIEBREAKERS[tiebreaker].label.toLowerCase()}).`));
  return card;
}

function needsLists(n, { you = false } = {}) {
  const box = div({ class: 'needs' });
  if (n.clinch.length) {
    box.appendChild(div({ class: 'needs-head tone-good' }, `${you ? 'You clinch' : 'Clinches'} this week with:`));
    box.appendChild(el('ul', { class: 'needs-list' }, ...n.clinch.map((c) => el('li', {}, c))));
  } else if (n.cantClinchNow) {
    box.appendChild(div({ class: 'needs-head muted' }, 'Can’t clinch this week.'));
  }
  if (n.path && !you) box.appendChild(div({ class: 'needs-path' }, n.clinch.length ? `Otherwise: ${n.path.charAt(0).toLowerCase()}${n.path.slice(1)}` : n.path));
  if (n.elim.length) {
    box.appendChild(div({ class: 'needs-head tone-bad' }, `${you ? 'You’re eliminated' : 'Eliminated'} this week with:`));
    box.appendChild(el('ul', { class: 'needs-list' }, ...n.elim.map((c) => el('li', {}, c))));
  }
  return box;
}

// Every team still alive, in seed order, with exactly what it takes this week.
function needsCard(model, ranked, analysis, odds, me) {
  const alive = ranked.filter((t) => ['control', 'bubble', 'hunt'].includes(analysis.get(t.rosterId)?.status));
  if (!alive.length) return null;
  const settled = (keys) => ranked.filter((t) => keys.includes(analysis.get(t.rosterId)?.status))
    .map((t) => t.name + (analysis.get(t.rosterId).hedged ? '*' : ''));
  const clinched = settled(['clinched', 'clinched_bye']);
  const out = settled(['eliminated']);
  return div({ class: 'card' },
    sectionTitle('What each team needs', `Week ${model.remainingWeeks[0]} scenarios`),
    clinched.length ? div({ class: 'muted small race-note' }, `✅ Clinched: ${clinched.join(', ')}`) : null,
    out.length ? div({ class: 'muted small race-note' }, `❌ Eliminated: ${out.join(', ')}`) : null,
    ...alive.map((t) => {
      const a = analysis.get(t.rosterId);
      const o = odds?.byRoster[t.rosterId];
      return div({ class: 'needs-team' + (me && me.rosterId === t.rosterId ? ' me' : '') },
        div({ class: 'needs-team-head' },
          div({ class: 'sr-main' },
            div({ class: 'sr-owner' }, t.name),
            div({ class: 'muted small' }, `#${a.seed} · ${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}${o ? ' · ' + formatPct(o.playoffPct) + ' odds' : ''}`)),
          statusPill(a)),
        needsLists(teamNeeds(a)));
    }),
    div({ class: 'muted small race-note' }, 'Scenarios cover every combination of this week’s results and hold no matter what happens after this week.'));
}

function updateCard({ league, model, ranked, analysis, odds, tiebreaker, divisionMode, leaders, unsupported, notStarted }) {
  const text = buildLeagueUpdate({ leagueName: league?.name, model, ranked, analysis, odds, tiebreaker, divisionMode, leaders, unsupported });
  const preview = el('pre', { class: 'msg-preview race-preview' }, text);
  const details = el('details', { class: 'race-details' }, el('summary', {}, 'Preview message'), preview);
  return div({ class: 'card' },
    sectionTitle('League playoff update', 'Whole-league summary for Sleeper chat'),
    notStarted ? div({ class: 'muted small' }, 'No games played yet — the update will only show standings.') : null,
    div({ class: 'btn-row' }, btn({ class: 'btn btn-primary', onclick: () => copyToClipboard(text) }, '📋 Copy League Playoff Update')),
    details);
}

function standingsCard({ league, model, ranked, analysis, odds, me, notStarted, leaders }) {
  const { spots, byes } = model;
  const sub = model.complete ? 'Regular season complete — final seeding'
    : notStarted ? 'No games played yet'
      : `Week ${model.remainingWeeks[0]} · ${model.remainingWeeks.length} week${model.remainingWeeks.length === 1 ? '' : 's'} left · top ${spots} make it${byes ? `, top ${byes} bye` : ''}`;
  const rows = [];
  ranked.forEach((t, i) => {
    if (byes && i === byes && i < spots) rows.push(div({ class: 'playoff-line bye-line' }, `— bye line (${byes}) —`));
    if (i === spots) rows.push(div({ class: 'playoff-line' }, `— playoff line (${spots}) —`));
    const a = analysis?.get(t.rosterId);
    const o = odds?.byRoster[t.rosterId];
    const why = shortWhy(a);
    rows.push(div({ class: 'standings-row race-row' + (me && me.rosterId === t.rosterId ? ' me' : '') },
      span({ class: 'sr-rank' }, `${i + 1}`),
      div({ class: 'sr-main' },
        div({ class: 'sr-owner' }, t.name + (leaders?.has(t.rosterId) ? ' 👑' : '')),
        div({ class: 'muted small' }, [
          `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`,
          `${t.pf.toFixed(1)} PF`,
          model.divisions ? model.divisionNames[t.division] : null,
          why || null,
        ].filter(Boolean).join(' · '))),
      o ? span({ class: 'sr-odds' }, formatPct(o.playoffPct, { settled: settledOf(a) })) : null,
      statusPill(a)));
  });
  return div({ class: 'card' }, sectionTitle(league?.name || 'Standings', sub), div({ class: 'standings' }, ...rows));
}

// Compact reason for the standings table (the full sentence lives in the update message).
function shortWhy(a) {
  if (!a || a.final) return '';
  if (a.status === 'control') return a.winNext < a.weeksLeft ? `Win next ${a.winNext} = in` : 'Win out = in';
  if (a.status === 'bubble') return a.magic != null ? `Magic # ${a.magic}` : 'Needs help';
  if (a.status === 'hunt') {
    const gb = a.gamesBack > 0 ? `${a.gamesBack} GB` : 'Tiebreak';
    if (a.pivotal?.loseOut) return `${gb} · loss = out`;
    return a.tragic != null ? `${gb} · tragic # ${a.tragic}` : gb;
  }
  return '';
}

function assumptionsCard({ model, analysis, odds, tiebreaker, divisionMode, notStarted, unsupported }) {
  const notes = [`Tiebreaker assumed: ${TIEBREAKERS[tiebreaker].label} — ${TIEBREAKERS[tiebreaker].desc}. Sleeper doesn’t reliably expose this, so set it above to match your league.`];
  if (model.byes) notes.push(`Assumes the top ${model.byes} seeds get first-round byes (${model.spots}-team bracket).`);
  if (model.divisions) {
    notes.push(divisionMode === 'none'
      ? 'Divisions are being ignored (set above) — playoffs by overall record only.'
      : `Division league: ${DIVISION_MODES[divisionMode].desc.toLowerCase()} (👑 = current leader). Sleeper doesn’t expose this rule, so set it above to match your league. Scenarios here come from checking every possible result of every remaining game.`);
  }
  if (unsupported) notes.push(`⚠ ${unsupported}`);
  if (model.median) notes.push('League plays a weekly median game: each week counts as two games. Clinch/elimination calls are conservative here.');
  if (analysis && [...analysis.values()].some((a) => a.approx)) notes.push('Some scenarios were too numerous to check exhaustively; those calls use a conservative bound.');
  if (analysis && [...analysis.values()].some((a) => a.hedged)) notes.push('* = result depends on the tiebreaker going as assumed.');
  if (odds) notes.push(`Odds: ${odds.iterations.toLocaleString('en-US')} simulated seasons using each team’s scoring this year (regressed toward the league average). Clinched/eliminated come from exact math, not the simulation.`);
  if (notStarted) notes.push('Scenarios and odds start once week 1 is in the books.');
  return div({ class: 'card' }, sectionTitle('How this is calculated'), ...notes.map((n) => div({ class: 'muted small race-note' }, n)));
}
