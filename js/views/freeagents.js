// LEAGUES > Free Agents
import { div, span, el, btn, mount } from '../lib/dom.js';
import { navigate } from '../router.js';
import { loadLeagueContext, rosteredPlayerIds } from '../lib/league.js';
import { enrichPlayer } from '../lib/players.js';
import { getState, getActiveLeagueId } from '../store.js';
import { asyncRegion, matchDiagnostic, rankBadge, injuryBadge, byeBadge, emptyBlock, sectionTitle } from './components.js';

const local = { leagueId: null, pos: 'ALL', q: '', onlyAlerts: false };
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const MAX_LIST = 300;
const RANK_CAP = 250; // only show free agents ranked this high or better in your rankings

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
  const rostered = rosteredPlayerIds(ctx.rosters);
  const threshold = getState().settings.thresholds[leagueId] || null;

  // Build the free-agent pool: unrostered players ranked within your top RANK_CAP.
  // Anyone ranked below that (or absent from your rankings) probably doesn't belong on
  // your roster, so we leave them off the list.
  const pool = [];
  for (const id of Object.keys(ctx.players)) {
    if (rostered.has(id)) continue;
    const p = ctx.players[id];
    if (!p || p.active === false) continue;
    const rankRow = ctx.rankingLookup.get(id);
    if (!rankRow || rankRow.rank == null || rankRow.rank > RANK_CAP) continue;
    pool.push(enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode));
  }
  pool.sort((a, b) => a.rank - b.rank);

  // FAAB / waiver indicator.
  const lset = ctx.league?.settings || {};
  const faabTotal = Number(lset.waiver_budget) || 0;
  const used = Number(ctx.myRoster?.settings?.waiver_budget_used) || 0;
  const faabNode = faabTotal > 0
    ? span({ class: 'pill' }, `FAAB: $${faabTotal - used} of $${faabTotal} left`)
    : span({ class: 'pill' }, 'Rolling waivers');

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));

  // Controls
  const listHost = div({ class: 'fa-list' });
  const search = el('input', {
    type: 'search', class: 'input', placeholder: 'Search name…', value: local.q,
    oninput: debounce((e) => { local.q = e.target.value.trim().toLowerCase(); paint(); }, 250),
  });
  const posSel = el('select', { class: 'select', onchange: (e) => { local.pos = e.target.value; paint(); } },
    ...POSITIONS.map((p) => el('option', { value: p, selected: p === local.pos }, p)));

  const alertToggle = threshold
    ? el('label', { class: 'toggle' },
        el('input', { type: 'checkbox', checked: local.onlyAlerts, onchange: (e) => { local.onlyAlerts = e.target.checked; paint(); } }),
        span({}, `Only rank ≤ ${threshold}`))
    : null;

  out.appendChild(div({ class: 'card fa-controls' },
    div({ class: 'fa-controls-top' },
      faabNode,
      btn({ class: 'btn btn-sm', onclick: () => navigate('leagues', 'waivers') }, '🔔 Waiver Alerts'),
    ),
    threshold ? div({ class: 'muted small' }, `Alert threshold: ${threshold}`) : null,
    div({ class: 'fa-controls-row' }, search, posSel),
    alertToggle ? div({ class: 'fa-controls-row' }, alertToggle) : null,
    div({ class: 'muted small' }, `Showing free agents ranked in your top ${RANK_CAP}.`),
  ));
  out.appendChild(listHost);

  function paint() {
    let rows = pool;
    if (local.pos !== 'ALL') rows = rows.filter((p) => p.positions.includes(local.pos));
    if (local.q) rows = rows.filter((p) => p.name.toLowerCase().includes(local.q));
    if (local.onlyAlerts && threshold) rows = rows.filter((p) => p.rank != null && p.rank <= threshold);
    const capped = rows.slice(0, MAX_LIST);
    mount(listHost,
      div({ class: 'muted small fa-count' }, `${rows.length} available${rows.length > MAX_LIST ? ` (showing top ${MAX_LIST})` : ''}`),
      capped.length
        ? div({ class: 'card' }, div({ class: 'list' }, ...capped.map((p) => faRow(p))))
        : emptyBlock('No matching free agents.'),
    );
  }
  paint();
  return out;
}

function faRow(p) {
  return div({ class: 'player-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, p.name),
      span({ class: 'pr-meta muted small' }, [p.team, p.positions.join('/')].filter(Boolean).join(' · ')),
    ),
    div({ class: 'row-badges' }, byeBadge(p.onBye, p.byeWeek), injuryBadge(p.injuryStatus), rankBadge(p.rank)),
  );
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
