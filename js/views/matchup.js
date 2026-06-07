// LEAGUES > Matchup
import { div, span, el, btn, mount } from '../lib/dom.js';
import { getMatchups } from '../api/sleeper.js';
import { loadLeagueContext, ownerDisplayName } from '../lib/league.js';
import { isActiveSeason, fmtPoints } from '../lib/format.js';
import { playerName, playerPositions } from '../lib/players.js';
import { leagueSelector, asyncRegion, emptyBlock, sectionTitle, sleeperHandoff } from './components.js';
import { getState } from '../store.js';

const local = { leagueId: null, week: null };

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  const sel = leagueSelector('matchup', (id) => { local.leagueId = id; trigger(); });
  if (!local.leagueId || local.leagueId !== sel.selectedId) {
    // keep remembered if still valid, else default
    if (!getState().session.leagues.some((l) => l.league_id === local.leagueId)) local.leagueId = sel.selectedId;
  }

  // Week selector
  const nfl = getState().session.nflState;
  if (local.week == null) local.week = isActiveSeason(nfl?.season_type) ? nfl.display_week : 1;
  const weekSel = div({ class: 'week-select' },
    el('label', { class: 'field-label' }, 'Week'),
    el('select', { class: 'select', onchange: (e) => { local.week = Number(e.target.value); trigger(); } },
      ...Array.from({ length: 18 }, (_, i) => i + 1).map((w) => el('option', { value: w, selected: w === local.week }, `Week ${w}`))),
  );

  root.append(sel.node, weekSel, body);
  mount(container, root);
  trigger();

  function trigger() {
    if (local.leagueId) run(() => load(local.leagueId, local.week));
  }
}

async function load(leagueId, week) {
  const nfl = getState().session.nflState;
  if (nfl && !isActiveSeason(nfl.season_type)) {
    return emptyBlock(nfl.season_type === 'pre'
      ? 'Matchups are unavailable during the preseason. Check back in Week 1.'
      : 'Matchups are unavailable in the offseason.');
  }

  const ctx = await loadLeagueContext(leagueId);
  if (!ctx.myRoster) return emptyBlock('No roster found for your account in this league.');
  const matchups = await getMatchups(leagueId, week);
  if (!matchups || !matchups.length) return emptyBlock(`No matchup data for Week ${week} yet.`);

  const mine = matchups.find((m) => m.roster_id === ctx.myRoster.roster_id);
  if (!mine) return emptyBlock('Could not find your team in this week\'s matchups.');
  const opp = matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id);

  const rosterById = {};
  for (const r of ctx.rosters) rosterById[r.roster_id] = r;

  const myName = ownerDisplayName(ctx.usersById, ctx.myRoster.owner_id);
  const oppRoster = opp ? rosterById[opp.roster_id] : null;
  const oppName = oppRoster ? ownerDisplayName(ctx.usersById, oppRoster.owner_id) : 'BYE / TBD';

  const myPts = Number(mine.points) || 0;
  const oppPts = opp ? (Number(opp.points) || 0) : 0;
  const iWin = myPts >= oppPts;

  const out = div({});
  out.appendChild(div({ class: 'card scoreboard' },
    teamScore(myName, myPts, opp ? iWin : true),
    span({ class: 'vs' }, 'vs'),
    teamScore(oppName, oppPts, opp ? !iWin : false),
  ));

  out.appendChild(div({ class: 'handoff-bar' },
    sleeperHandoff('Open matchup in Sleeper', { leagueId, section: 'matchup', small: true })));
  out.appendChild(div({ class: 'note muted small' }, 'Note: Sleeper\'s API provides team totals only — no per-player point breakdowns.'));

  out.appendChild(div({ class: 'lineup-cols' },
    lineupCol(myName, mine, ctx.players),
    opp ? lineupCol(oppName, opp, ctx.players) : div({ class: 'card' }, emptyBlock('No opponent this week (bye).')),
  ));

  return out;
}

function teamScore(name, pts, winning) {
  return div({ class: 'team-score' + (winning ? ' winning' : '') },
    div({ class: 'ts-name' }, name),
    div({ class: 'ts-pts' }, fmtPoints(pts)),
    winning ? div({ class: 'ts-flag' }, '▲ leading') : null,
  );
}

function lineupCol(name, m, players) {
  const starters = m.starters || [];
  return div({ class: 'card lineup-col' },
    sectionTitle(name, 'Starters'),
    div({ class: 'list' }, ...starters.filter((id) => id && id !== '0').map((id) => div({ class: 'list-row' },
      span({}, playerName(players, id)),
      span({ class: 'muted small' }, playerPositions(players, id).join('/')),
    ))),
  );
}
