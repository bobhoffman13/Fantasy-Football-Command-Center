// LEAGUES > Interest
//
// A watchlist of players you'd love to acquire. For the active league it shows which
// interest players are AVAILABLE (free agents) and, for those owned by opponents, a
// recommended offer from your roster — balanced on your Lifetime Value and sanity-checked
// against public consensus (buy-low / sell-high). The list also feeds the waiver-alert
// companion so you get a push when one hits free agency.

import { div, span, el, btn, mount } from '../lib/dom.js';
import { navigate } from '../router.js';
import { loadLeagueContext, ownerDisplayName, rosteredPlayerIds } from '../lib/league.js';
import { playerName, playerPositions } from '../lib/players.js';
import { getState, getActiveLeagueId, getInterestPlayers, addInterest, removeInterest } from '../store.js';
import { getConsensusValues, leagueToConsensusParams, getTePremium } from '../api/fantasycalc.js';
import { describeWithValue, computeArbitrage } from '../lib/tradevalue.js';
import { asyncRegion, matchDiagnostic, rankBadge, emptyBlock, sectionTitle } from './components.js';

const TE_BUMP_PER_POINT = 0.4; // keep in step with the Trade Finder
const CORE = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const OFFER_MIN = 0.95; // an offer may be worth down to 95% of the target…
const OFFER_MAX = 1.35; // …and up to 135% (a reasonable nudge to land them)

const local = { leagueId: null, q: '' };

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  local.leagueId = getActiveLeagueId();
  root.append(body);
  mount(container, root);
  if (local.leagueId) run(() => load(local.leagueId));
}

function fmtVal(v) {
  if (v == null) return '—';
  return Math.round(v).toLocaleString();
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  const isDynasty = getState().settings.leagueTypes[leagueId] === 'dynasty';
  const consensus = await getConsensusValues(leagueToConsensusParams(ctx.league, isDynasty));
  const teFactor = 1 + getTePremium(ctx.league) * TE_BUMP_PER_POINT;

  // Roster maps + value pool (mine + opponents) for arbitrage scoring.
  const rostered = rosteredPlayerIds(ctx.rosters);
  const myRosterId = ctx.myRoster?.roster_id;
  const ownerOf = new Map(); // playerId -> { owner, mine }
  const myPlayers = [];
  const oppPlayers = [];
  for (const r of ctx.rosters) {
    const mine = r.roster_id === myRosterId;
    const owner = mine ? 'You' : ownerDisplayName(ctx.usersById, r.owner_id);
    for (const id of r.players || []) {
      ownerOf.set(id, { owner, mine });
      const d = describeWithValue(id, ctx, consensus, teFactor);
      (mine ? myPlayers : oppPlayers).push(d);
    }
  }
  const arbThreshold = computeArbitrage([...myPlayers, ...oppPlayers]);
  const pooledById = new Map([...myPlayers, ...oppPlayers].map((p) => [p.playerId, p]));
  const myValued = myPlayers.filter((p) => p.lifetimeValue != null);

  // Lightweight search index: relevant, active players only.
  const searchPool = [];
  for (const [id, p] of Object.entries(ctx.players)) {
    if (!p || p.active === false) continue;
    const positions = p.fantasy_positions || (p.position ? [p.position] : []);
    if (!positions.some((pos) => CORE.has(pos))) continue;
    const name = playerName(ctx.players, id);
    if (!name) continue;
    searchPool.push({ id, name, lower: name.toLowerCase(), pos: positions.join('/'), team: p.team || '' });
  }

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));

  // --- Search & add ---
  const resultsHost = div({ class: 'int-search-results' });
  const searchInput = el('input', {
    type: 'search', class: 'input', placeholder: 'Search players to add…', value: local.q,
    autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
    oninput: debounce((e) => { local.q = e.target.value.trim().toLowerCase(); paintSearch(); }, 200),
  });
  out.appendChild(div({ class: 'card' },
    sectionTitle('Add to interest list', 'Watch players to get a push when they free up'),
    searchInput,
    resultsHost,
  ));

  // --- Interest list (available / trade-for / yours) ---
  const interestHost = div({});
  out.appendChild(interestHost);

  function paintSearch() {
    if (!local.q || local.q.length < 2) { mount(resultsHost); return; }
    const interest = new Set(getInterestPlayers());
    const matches = searchPool.filter((s) => s.lower.includes(local.q)).slice(0, 15);
    mount(resultsHost, matches.length
      ? div({ class: 'list' }, ...matches.map((s) => {
          const added = interest.has(s.id);
          return div({ class: 'player-row' },
            div({ class: 'pr-main' },
              span({ class: 'pr-name' }, s.name),
              span({ class: 'pr-meta muted small' }, [s.team, s.pos].filter(Boolean).join(' · ')),
            ),
            added
              ? span({ class: 'pill pill-good' }, '✓ Added')
              : btn({ class: 'btn btn-sm', onclick: () => { addInterest(s.id); paintSearch(); paintInterest(); } }, '+ Add'),
          );
        }))
      : emptyBlock('No matching players.'));
  }

  function paintInterest() {
    const ids = getInterestPlayers();
    if (!ids.length) {
      mount(interestHost, div({ class: 'card' }, emptyBlock('Your interest list is empty. Search above to add players you want.')));
      return;
    }

    const available = [];
    const tradeFor = [];
    const owned = [];
    for (const id of ids) {
      const d = pooledById.get(id) || describeWithValue(id, ctx, consensus, teFactor);
      const ref = ownerOf.get(id);
      if (!ref) available.push(d);
      else if (ref.mine) owned.push(d);
      else { d.owner = ref.owner; tradeFor.push(d); }
    }
    available.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    tradeFor.sort((a, b) => (b.lifetimeValue ?? -1) - (a.lifetimeValue ?? -1));

    const node = div({});

    node.appendChild(div({ class: 'card' },
      sectionTitle(`Available now`, available.length ? `${available.length}` : null),
      available.length
        ? div({ class: 'list' }, ...available.map((p) => interestRow(p, {
            badge: span({ class: 'badge arb-buy' }, 'Free agent'),
            action: btn({ class: 'btn btn-sm', onclick: () => navigate('leagues', 'freeagents') }, 'Free Agents →'),
          })))
        : emptyBlock('None of your interest players are free agents in this league right now.'),
    ));

    node.appendChild(div({ class: 'card' },
      sectionTitle('Trade for', tradeFor.length ? `${tradeFor.length}` : null),
      tradeFor.length
        ? div({}, ...tradeFor.map((p) => tradeTargetBlock(p, myValued, arbThreshold)))
        : emptyBlock('None of your interest players are on an opponent’s roster here.'),
    ));

    if (owned.length) {
      node.appendChild(div({ class: 'card' },
        sectionTitle('Already yours', `${owned.length}`),
        div({ class: 'list' }, ...owned.map((p) => interestRow(p, { badge: span({ class: 'pill pill-good' }, 'On your roster') }))),
      ));
    }

    mount(interestHost, node);
  }

  function interestRow(p, { badge = null, action = null } = {}) {
    return div({ class: 'player-row' },
      div({ class: 'pr-main' },
        span({ class: 'pr-name' }, p.name),
        span({ class: 'pr-meta muted small' }, [p.team, p.positions.join('/'), p.lifetimeValue != null ? `LV ${fmtVal(p.lifetimeValue)}` : null].filter(Boolean).join(' · ')),
      ),
      div({ class: 'row-badges' },
        badge,
        action,
        rankBadge(p.rank),
        removeBtn(p.playerId),
      ),
    );
  }

  function removeBtn(id) {
    return btn({ class: 'btn btn-sm int-remove', title: 'Remove from interest list',
      onclick: () => { removeInterest(id); paintInterest(); paintSearch(); } }, '×');
  }

  // A trade target: the player + a recommended offer from your roster.
  function tradeTargetBlock(target, myValued, threshold) {
    const buyLow = threshold !== Infinity && target.arbDelta != null && target.arbDelta >= threshold;
    const head = div({ class: 'player-row' },
      div({ class: 'pr-main' },
        span({ class: 'pr-name' }, target.name),
        span({ class: 'pr-meta muted small' }, [target.team, target.positions.join('/'), `owned by ${target.owner}`, target.lifetimeValue != null ? `LV ${fmtVal(target.lifetimeValue)}` : null].filter(Boolean).join(' · ')),
      ),
      div({ class: 'row-badges' },
        buyLow ? span({ class: 'badge arb-buy', title: 'You value this player higher than the public — the owner may sell lower' }, 'Buy-low') : null,
        rankBadge(target.rank),
        removeBtn(target.playerId),
      ),
    );

    const offer = suggestOffer(target, myValued, threshold);
    let rec;
    if (target.lifetimeValue == null) {
      rec = div({ class: 'int-offer muted small' }, 'No Lifetime Value for this player — can’t size an offer.');
    } else if (!offer) {
      rec = div({ class: 'int-offer muted small' }, 'No clean match on your roster — you’d likely need a larger package or a pick.');
    } else {
      const names = offer.players.map((p) => `${p.name} (LV ${fmtVal(p.lifetimeValue)})`).join(' + ');
      const sells = offer.players.filter((p) => threshold !== Infinity && p.arbDelta != null && p.arbDelta <= -threshold);
      const diff = offer.total - target.lifetimeValue;
      const diffStr = diff >= 0 ? `+${fmtVal(diff)} over` : `${fmtVal(-diff)} under`;
      rec = div({ class: 'int-offer' },
        div({}, span({ class: 'int-offer-label' }, 'Offer: '), span({}, names)),
        div({ class: 'muted small' }, `Package LV ${fmtVal(offer.total)} · ${diffStr} their value`
          + (sells.length ? ` · selling high on ${sells.map((p) => p.name).join(', ')}` : '')),
      );
    }
    return div({ class: 'int-target' }, head, rec);
  }

  // First paint.
  paintSearch();
  paintInterest();
  return out;
}

// Find the cheapest fair offer (single player, else best 2-player package) whose total
// Lifetime Value lands in [OFFER_MIN, OFFER_MAX] * target value.
function suggestOffer(target, myValued, threshold) {
  const t = target.lifetimeValue;
  if (t == null) return null;
  const lo = t * OFFER_MIN, hi = t * OFFER_MAX;
  const pool = myValued.filter((p) => p.playerId !== target.playerId);

  // Single player in band — prefer the smallest total at/above the target (least overpay).
  const singles = pool.filter((p) => p.lifetimeValue >= lo && p.lifetimeValue <= hi)
    .sort((a, b) => a.lifetimeValue - b.lifetimeValue);
  const fairSingle = singles.find((p) => p.lifetimeValue >= t) || singles[singles.length - 1];
  if (fairSingle) return { players: [fairSingle], total: fairSingle.lifetimeValue };

  // Otherwise the cheapest 2-player package whose sum lands in band.
  let best = null;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const sum = pool[i].lifetimeValue + pool[j].lifetimeValue;
      if (sum < lo || sum > hi) continue;
      if (!best || sum < best.total) best = { players: [pool[i], pool[j]], total: sum };
    }
  }
  return best;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
