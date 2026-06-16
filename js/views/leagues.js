// LEAGUES area shell: global league picker + sub-tab nav + delegates to the active view.
import { div, btn, el, span, mount } from '../lib/dom.js';
import { LEAGUE_VIEWS } from '../data/constants.js';
import { navigate } from '../router.js';
import { getState, getActiveLeagueId, setGlobalLeague } from '../store.js';
import { emptyBlock } from './components.js';
import * as matchup from './matchup.js';
import * as freeagents from './freeagents.js';
import * as tradefinder from './tradefinder.js';
import * as draft from './draft.js';
import * as targets from './targets.js';
import * as lineupview from './lineupview.js';
import * as waivers from './waivers.js';
import * as overview from './overview.js';

// 'transactions' is served by the overview module. 'waivers' is reachable from the
// Free Agents page (a button), so it stays renderable here without being a tab.
const VIEW_MAP = { lineup: lineupview, matchup, freeagents, tradefinder, draft, targets, transactions: overview, waivers };

export function render(container, sub) {
  const { session } = getState();
  const root = div({ class: 'view-area' });

  if (!session.leagues.length) {
    mount(container, root, emptyBlock('Connect your account in Setup to see your leagues.'));
    return;
  }

  const isOffseason = session.nflState?.season_type === 'off';
  const views = LEAGUE_VIEWS.filter((v) => !(v.hideInOffseason && isOffseason));

  let active = VIEW_MAP[sub] ? sub : 'lineup';
  if (active === 'matchup' && isOffseason) active = 'lineup'; // tab hidden in offseason

  // Global league picker — drives every league page. Sits right under the app title.
  const activeId = getActiveLeagueId();
  const leagueBar = div({ class: 'league-bar' },
    span({ class: 'field-label' }, 'League'),
    el('select', { class: 'select', onchange: (e) => setGlobalLeague(e.target.value) },
      ...session.leagues.map((l) => el('option', { value: l.league_id, selected: l.league_id === activeId }, l.name))),
  );
  root.appendChild(leagueBar);

  const tabs = div({ class: 'subnav' }, ...views.map((v) =>
    btn({ class: 'subnav-tab' + (v.id === active ? ' active' : ''), onclick: () => navigate('leagues', v.id) }, v.label)));
  root.appendChild(tabs);

  const host = div({ class: 'subview-host' });
  root.appendChild(host);
  mount(container, root);

  // Delegate; propagate any cleanup the sub-view returns.
  return VIEW_MAP[active].render(host);
}
