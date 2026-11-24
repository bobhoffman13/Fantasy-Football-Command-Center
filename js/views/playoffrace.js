// TOOLS → Playoff Race (spec 5.4.1): standings, exact scenarios, Monte Carlo odds, and a
// copy-paste league update. All math lives in lib/playoffs*.js; this file only renders.

import { div, span, btn, el, mount, copyToClipboard } from '../lib/dom.js';
import { getState, updateMap } from '../store.js';
import { getRosters, getLeagueUsers, getMatchups } from '../api/sleeper.js';
import { ownerDisplayName, findLeague } from '../lib/league.js';
import {
  buildSeasonModel, currentStandings, analyzeRace, explain, STATUS, TIEBREAKERS, DEFAULT_TIEBREAKER,
} from '../lib/playoffs.js';
import { simulatePlayoffs, formatPct, buildScoreModel, winProbability } from '../lib/playoffsim.js';
import { buildLeagueUpdate, settledOf } from '../lib/playoffmsg.js';
import { leagueSelector, asyncRegion, sectionTitle, emptyBlock } from './components.js';

const SIM_ITERATIONS = 10000;
const state = { leagueId: null };

export function tiebreakerFor(leagueId) {
  return getState().settings.tiebreakers?.[leagueId] || DEFAULT_TIEBREAKER;
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
    const current = tiebreakerFor(state.leagueId);
    mount(tbHost, div({ class: 'field' },
      span({ class: 'field-label' }, 'Tiebreaker (match your league rules)'),
      div({ class: 'segmented' }, ...Object.entries(TIEBREAKERS).map(([key, tb]) => btn({
        class: 'seg' + (key === current ? ' active' : ''),
        title: tb.desc,
        onclick: () => {
          if (key === tiebreakerFor(state.leagueId)) return;
          updateMap('tiebreakers', state.leagueId, key === DEFAULT_TIEBREAKER ? undefined : key);
          paintTiebreaker();
          trigger();
        },
      }, tb.label)))));
  }

  function trigger() {
    if (state.leagueId) run(() => loadRace(state.leagueId, tiebreakerFor(state.leagueId)));
  }

  paintTiebreaker();
  mount(host, div({}, sel.node, tbHost, body,
    div({ class: 'btn-row' }, btn({ class: 'btn', onclick: trigger }, 'Refresh'))));
  trigger();
}

async function loadRace(leagueId, tiebreaker) {
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
  const ranked = currentStandings(model, tiebreaker);
  const notStarted = model.completedWeeks === 0;
  const analysis = notStarted ? null : analyzeRace(model, tiebreaker);
  // Let the spinner paint before the simulation occupies the main thread.
  await new Promise((r) => setTimeout(r, 16));
  const odds = analysis && !model.complete ? simulatePlayoffs(model, { iterations: SIM_ITERATIONS, tiebreaker }) : null;
  const me = model.teams.find((t) => t.ownerId === settings.userId) || null;

  const out = div({});
  if (me && analysis) out.appendChild(myRaceCard(model, me, analysis.get(me.rosterId), odds, tiebreaker));
  out.appendChild(updateCard(league, model, ranked, analysis, odds, tiebreaker, notStarted));
  out.appendChild(standingsCard(league, model, ranked, analysis, odds, me, notStarted));
  out.appendChild(assumptionsCard(model, analysis, odds, tiebreaker, notStarted));
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

  const facts = [];
  if (a.pivotal?.winIn) facts.push('🎯 Win this week and you’re in.');
  else if (a.pivotal?.winInTB) facts.push('🎯 Win this week and you’re in — if tiebreakers hold.');
  if (a.pivotal?.loseOut) facts.push('⚠️ Lose this week and you’re eliminated.');
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

function updateCard(league, model, ranked, analysis, odds, tiebreaker, notStarted) {
  const text = buildLeagueUpdate({ leagueName: league?.name, model, ranked, analysis, odds, tiebreaker });
  const preview = el('pre', { class: 'msg-preview race-preview' }, text);
  const details = el('details', { class: 'race-details' }, el('summary', {}, 'Preview message'), preview);
  return div({ class: 'card' },
    sectionTitle('League playoff update', 'Whole-league summary for Sleeper chat'),
    notStarted ? div({ class: 'muted small' }, 'No games played yet — the update will only show standings.') : null,
    div({ class: 'btn-row' }, btn({ class: 'btn btn-primary', onclick: () => copyToClipboard(text) }, '📋 Copy League Playoff Update')),
    details);
}

function standingsCard(league, model, ranked, analysis, odds, me, notStarted) {
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
        div({ class: 'sr-owner' }, t.name),
        div({ class: 'muted small' }, `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''} · ${t.pf.toFixed(1)} PF${why ? ' · ' + why : ''}`)),
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

function assumptionsCard(model, analysis, odds, tiebreaker, notStarted) {
  const notes = [`Tiebreaker assumed: ${TIEBREAKERS[tiebreaker].label} — ${TIEBREAKERS[tiebreaker].desc}. Sleeper doesn’t reliably expose this, so set it above to match your league.`];
  if (model.byes) notes.push(`Assumes the top ${model.byes} seeds get first-round byes (${model.spots}-team bracket).`);
  if (model.divisions) notes.push('⚠ This league uses divisions. Division winners can be guaranteed seeds, which isn’t modelled — showing standings only, no clinch math or odds.');
  if (model.scheduleIncomplete && !model.divisions) notes.push('⚠ Sleeper didn’t return the remaining schedule, so clinch scenarios and odds are unavailable.');
  if (model.median) notes.push('League plays a weekly median game: each week counts as two games. Clinch/elimination calls are conservative here.');
  if (analysis && [...analysis.values()].some((a) => a.approx)) notes.push('Some scenarios were too numerous to check exhaustively; those calls use a conservative bound.');
  if (analysis && [...analysis.values()].some((a) => a.hedged)) notes.push('* = result depends on the tiebreaker going as assumed.');
  if (odds) notes.push(`Odds: ${odds.iterations.toLocaleString('en-US')} simulated seasons using each team’s scoring this year (regressed toward the league average). Clinched/eliminated come from exact math, not the simulation.`);
  if (notStarted) notes.push('Scenarios and odds start once week 1 is in the books.');
  return div({ class: 'card' }, sectionTitle('How this is calculated'), ...notes.map((n) => div({ class: 'muted small race-note' }, n)));
}
