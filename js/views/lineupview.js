// LEAGUES > Lineup Optimizer
import { div, span, mount } from '../lib/dom.js';
import { loadLeagueContext } from '../lib/league.js';
import { enrichRoster } from '../lib/players.js';
import { optimizeLineup } from '../lib/lineup.js';
import { getState } from '../store.js';
import { RISK_MODES } from '../data/constants.js';
import { leagueSelector, asyncRegion, matchDiagnostic, rankBadge, injuryBadge, byeBadge, emptyBlock, sectionTitle, sleeperHandoff } from './components.js';

const local = { leagueId: null };

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  const sel = leagueSelector('lineup', (id) => { local.leagueId = id; trigger(); });
  if (!getState().session.leagues.some((l) => l.league_id === local.leagueId)) local.leagueId = sel.selectedId;

  root.append(sel.node, body);
  mount(container, root);
  trigger();

  function trigger() { if (local.leagueId) run(() => load(local.leagueId)); }
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  if (!ctx.myRoster) return emptyBlock('No roster found for your account in this league.');

  const players = enrichRoster(ctx.myRoster.players, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
  const rosterPositions = ctx.league?.roster_positions || [];
  const { starters, bench, unfilled } = optimizeLineup(players, rosterPositions);
  const riskMode = getState().settings.riskMode;

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));
  out.appendChild(div({ class: 'note muted small' }, `Risk tolerance: ${RISK_MODES[riskMode].label} — ${RISK_MODES[riskMode].desc}. Change it in Setup.`));

  if (unfilled.length) {
    out.appendChild(div({ class: 'diag diag-warn' }, `⚠ ${unfilled.length} slot(s) could not be filled with a healthy, available player: ${unfilled.join(', ')}.`));
  }

  out.appendChild(div({ class: 'card' },
    div({ class: 'card-head-row' },
      sectionTitle('Suggested starters'),
      sleeperHandoff('Set in Sleeper', { leagueId, section: 'team', small: true, primary: true }),
    ),
    div({ class: 'list' }, ...starters.map(slotRow)),
  ));

  out.appendChild(div({ class: 'card' },
    sectionTitle('Bench', `${bench.length}`),
    bench.length
      ? div({ class: 'list' }, ...bench.map((p) => playerLine(p)))
      : emptyBlock('Bench is empty.'),
  ));

  return out;
}

function slotRow({ slot, player }) {
  return div({ class: 'player-row slot-row' },
    span({ class: 'slot-tag' }, slot),
    player
      ? div({ class: 'pr-main' },
          span({ class: 'pr-name' }, player.name,
            player.questionable ? span({ class: 'badge inj-q', title: 'Questionable starter' }, ' Q?') : null),
          span({ class: 'pr-meta muted small' }, [player.team, player.positions.join('/')].filter(Boolean).join(' · ')))
      : span({ class: 'muted' }, '— empty —'),
    player ? div({ class: 'row-badges' }, injuryBadge(player.injuryStatus), rankBadge(player.rank)) : null,
  );
}

function playerLine(p) {
  return div({ class: 'player-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, p.name),
      span({ class: 'pr-meta muted small' }, [p.team, p.positions.join('/'), p.startable ? null : `(${p.reason})`].filter(Boolean).join(' · ')),
    ),
    div({ class: 'row-badges' }, byeBadge(p.onBye, p.byeWeek), injuryBadge(p.injuryStatus), rankBadge(p.rank)),
  );
}
