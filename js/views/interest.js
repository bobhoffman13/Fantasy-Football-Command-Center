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

    // Group trade targets by the opponent who owns them, so when one owner holds
    // several of your targets we can propose a single bundle deal.
    const byOwner = new Map();
    for (const t of tradeFor) {
      if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
      byOwner.get(t.owner).push(t);
    }
    const ownerBlocks = [...byOwner.entries()]
      .sort((a, b) => (b[1].length - a[1].length) || (sumLV(b[1]) - sumLV(a[1]))); // bundles first

    node.appendChild(div({ class: 'card' },
      sectionTitle('Trade for', tradeFor.length ? `${tradeFor.length}` : null),
      tradeFor.length
        ? div({}, ...ownerBlocks.map(([owner, ts]) => ownerDealBlock(owner, ts, myValued, arbThreshold)))
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

  // A deal with one opponent: the interest player(s) you'd acquire from them, plus a
  // single recommended offer from your roster sized to their combined Lifetime Value.
  function ownerDealBlock(owner, targets, myValued, threshold) {
    targets.sort((a, b) => (b.lifetimeValue ?? -1) - (a.lifetimeValue ?? -1));
    const valued = targets.filter((t) => t.lifetimeValue != null);
    const combinedLV = sumLV(valued);
    const isBundle = valued.length >= 2;

    const getRows = targets.map((t) => {
      const buyLow = threshold !== Infinity && t.arbDelta != null && t.arbDelta >= threshold;
      return div({ class: 'player-row' },
        div({ class: 'pr-main' },
          span({ class: 'pr-name' }, t.name),
          span({ class: 'pr-meta muted small' }, [t.team, t.positions.join('/'), t.lifetimeValue != null ? `LV ${fmtVal(t.lifetimeValue)}` : null].filter(Boolean).join(' · ')),
        ),
        div({ class: 'row-badges' },
          buyLow ? span({ class: 'badge arb-buy', title: 'You value this player higher than the public — the owner may sell lower' }, 'Buy-low') : null,
          rankBadge(t.rank),
          removeBtn(t.playerId),
        ),
      );
    });

    let rec;
    if (!valued.length) {
      rec = div({ class: 'int-offer muted small' }, 'No Lifetime Value for these players — can’t size an offer.');
    } else {
      const offer = suggestPackageForValue(combinedLV, myValued, isBundle ? 4 : 2);
      if (!offer) {
        rec = div({ class: 'int-offer muted small' }, 'No clean match on your roster — you’d likely need a larger package or a pick.');
      } else {
        const names = offer.players.map((p) => `${p.name} (LV ${fmtVal(p.lifetimeValue)})`).join(' + ');
        const sells = offer.players.filter((p) => threshold !== Infinity && p.arbDelta != null && p.arbDelta <= -threshold);
        const diff = offer.total - combinedLV;
        const diffStr = diff >= 0 ? `+${fmtVal(diff)} over` : `${fmtVal(-diff)} under`;
        rec = div({ class: 'int-offer' },
          div({}, span({ class: 'int-offer-label' }, isBundle ? 'Offer (one deal): ' : 'Offer: '), span({}, names)),
          div({ class: 'muted small' }, `Package LV ${fmtVal(offer.total)} · ${diffStr} their ${isBundle ? 'combined ' : ''}value`
            + (sells.length ? ` · selling high on ${sells.map((p) => p.name).join(', ')}` : '')),
        );
      }
    }

    return div({ class: 'int-target' },
      div({ class: 'int-deal-head' },
        span({ class: 'int-offer-label' }, isBundle ? `Bundle from ${owner} — get ${valued.length}` : `From ${owner}`),
        isBundle ? span({ class: 'muted small' }, `combined LV ${fmtVal(combinedLV)}`) : null,
      ),
      div({ class: 'list' }, ...getRows),
      rec,
    );
  }

  // First paint.
  paintSearch();
  paintInterest();
  return out;
}

const sumLV = (arr) => arr.reduce((s, p) => s + (p.lifetimeValue || 0), 0);

// Cheapest fair offer for a target value: the fewest players whose combined Lifetime
// Value lands in [OFFER_MIN, OFFER_MAX] * targetValue, and among those the least overpay.
// Searches packages of 1..maxPlayers from your roster.
function suggestPackageForValue(targetValue, myValued, maxPlayers) {
  if (targetValue == null || targetValue <= 0) return null;
  const lo = targetValue * OFFER_MIN, hi = targetValue * OFFER_MAX;
  // No single piece can exceed the ceiling; sorting desc lets us prune deep branches.
  const pool = myValued.filter((p) => p.lifetimeValue <= hi).sort((a, b) => b.lifetimeValue - a.lifetimeValue);

  for (let k = 1; k <= maxPlayers; k++) {
    let best = null;
    const combo = [];
    const search = (start, sum) => {
      if (combo.length === k) {
        if (sum >= lo && sum <= hi && (!best || sum < best.total)) best = { players: combo.slice(), total: sum };
        return;
      }
      for (let i = start; i < pool.length; i++) {
        const next = sum + pool[i].lifetimeValue;
        if (next > hi) continue; // later (smaller) players may still fit
        combo.push(pool[i]);
        search(i + 1, next);
        combo.pop();
      }
    };
    search(0, 0);
    if (best) return best; // prefer the smallest viable package
  }
  return null;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
