// LEAGUES area shell: sub-tab nav + delegates to the active league-scoped view.
import { div, btn, mount } from '../lib/dom.js';
import { LEAGUE_VIEWS } from '../data/constants.js';
import { navigate } from '../router.js';
import * as roster from './roster.js';
import * as matchup from './matchup.js';
import * as freeagents from './freeagents.js';
import * as tradefinder from './tradefinder.js';
import * as lineupview from './lineupview.js';
import * as waivers from './waivers.js';
import * as overview from './overview.js';

const VIEW_MAP = { roster, matchup, freeagents, tradefinder, lineup: lineupview, waivers, overview };

export function render(container, sub) {
  const active = VIEW_MAP[sub] ? sub : 'roster';
  const root = div({ class: 'view-area' });

  const tabs = div({ class: 'subnav' }, ...LEAGUE_VIEWS.map((v) =>
    btn({ class: 'subnav-tab' + (v.id === active ? ' active' : ''), onclick: () => navigate('leagues', v.id) }, v.label)));
  root.appendChild(tabs);

  const host = div({ class: 'subview-host' });
  root.appendChild(host);
  mount(container, root);

  // Delegate; propagate any cleanup the sub-view returns.
  return VIEW_MAP[active].render(host);
}
