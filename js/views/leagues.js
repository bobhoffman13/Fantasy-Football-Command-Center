// LEAGUES area shell: sub-tab nav + delegates to the active league-scoped view.
import { div, btn, mount } from '../lib/dom.js';
import { LEAGUE_VIEWS } from '../data/constants.js';
import { navigate } from '../router.js';
import { getState } from '../store.js';
import * as matchup from './matchup.js';
import * as freeagents from './freeagents.js';
import * as tradefinder from './tradefinder.js';
import * as lineupview from './lineupview.js';
import * as waivers from './waivers.js';
import * as overview from './overview.js';

// 'transactions' is served by the overview module. 'waivers' is reachable from the
// Free Agents page (a button), so it stays renderable here without being a tab.
const VIEW_MAP = { lineup: lineupview, matchup, freeagents, tradefinder, transactions: overview, waivers };

export function render(container, sub) {
  const isOffseason = getState().session.nflState?.season_type === 'off';
  const views = LEAGUE_VIEWS.filter((v) => !(v.hideInOffseason && isOffseason));

  let active = VIEW_MAP[sub] ? sub : 'lineup';
  if (active === 'matchup' && isOffseason) active = 'lineup'; // tab hidden in offseason

  const root = div({ class: 'view-area' });

  const tabs = div({ class: 'subnav' }, ...views.map((v) =>
    btn({ class: 'subnav-tab' + (v.id === active ? ' active' : ''), onclick: () => navigate('leagues', v.id) }, v.label)));
  root.appendChild(tabs);

  const host = div({ class: 'subview-host' });
  root.appendChild(host);
  mount(container, root);

  // Delegate; propagate any cleanup the sub-view returns.
  return VIEW_MAP[active].render(host);
}
