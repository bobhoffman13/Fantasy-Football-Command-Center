// LEAGUES > My Roster
import { div, span, mount } from '../lib/dom.js';
import { loadLeagueContext } from '../lib/league.js';
import { enrichRoster } from '../lib/players.js';
import { POSITION_ORDER } from '../data/constants.js';
import { leagueSelector, asyncRegion, matchDiagnostic, rankBadge, injuryBadge, byeBadge, sectionTitle, emptyBlock, sleeperHandoff } from './components.js';

const local = { leagueId: null };

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  const sel = leagueSelector('roster', (id) => { local.leagueId = id; run(() => load(id)); });
  if (!local.leagueId || !getStillValid(sel)) local.leagueId = sel.selectedId;

  root.append(sel.node, body);
  mount(container, root);
  if (local.leagueId) run(() => load(local.leagueId));
}

function getStillValid(sel) {
  return sel.selectedId && local.leagueId === sel.selectedId;
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  if (!ctx.myRoster) return emptyBlock('No roster found for your account in this league.');

  const players = enrichRoster(ctx.myRoster.players, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
  const starters = new Set(ctx.myRoster.starters || []);
  const reserve = new Set([...(ctx.myRoster.reserve || []), ...(ctx.myRoster.taxi || [])]);

  // Starters grouped by position (canonical order), then a dedicated Bench
  // group, then IR/taxi. (Spec 5.2.1: "...by position ... then bench/IR".)
  const groups = {};
  for (const p of players) {
    let key;
    if (reserve.has(p.playerId)) key = 'IR';
    else if (starters.has(p.playerId)) key = p.positions[0] || 'FLEX';
    else key = 'BN';
    (groups[key] = groups[key] || []).push(p);
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  const out = div({});
  out.appendChild(div({ class: 'handoff-bar' },
    sleeperHandoff('Open team in Sleeper', { leagueId, section: 'team', small: true })));
  out.appendChild(matchDiagnostic(ctx.diagnostic));

  // Watch list: rostered players injured or on bye this week.
  const watch = players.filter((p) => p.onBye || p.injuryStatus);
  if (watch.length) {
    out.appendChild(div({ class: 'card watchlist' },
      sectionTitle('⚠ Watch list', 'Injured or on bye this week'),
      div({ class: 'list' }, ...watch.map((p) => div({ class: 'list-row' },
        span({}, p.name, ' ', span({ class: 'muted small' }, p.positions.join('/'))),
        span({ class: 'row-badges' }, byeBadge(p.onBye, p.byeWeek), injuryBadge(p.injuryStatus)),
      ))),
    ));
  }

  const GROUP_LABELS = { BN: 'Bench', IR: 'IR / Taxi' };
  const orderedKeys = [...POSITION_ORDER.filter((k) => groups[k]), ...Object.keys(groups).filter((k) => !POSITION_ORDER.includes(k))];
  const starterKeys = orderedKeys.filter((k) => k !== 'BN' && k !== 'IR');
  if (starterKeys.length) out.appendChild(div({ class: 'group-heading' }, 'Starting lineup'));
  for (const key of orderedKeys) {
    const list = groups[key];
    if (!list?.length) continue;
    out.appendChild(div({ class: 'card pos-group' },
      sectionTitle(GROUP_LABELS[key] || key, `${list.length}`),
      div({ class: 'list' }, ...list.map(playerRow)),
    ));
  }

  return out;
}

function playerRow(p) {
  return div({ class: 'player-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, p.name),
      span({ class: 'pr-meta muted small' }, [p.team, p.positions.join('/'), p.age ? `${p.age}y` : null].filter(Boolean).join(' · ')),
    ),
    div({ class: 'row-badges' },
      byeBadge(p.onBye, p.byeWeek),
      injuryBadge(p.injuryStatus),
      rankBadge(p.rank),
    ),
  );
}
