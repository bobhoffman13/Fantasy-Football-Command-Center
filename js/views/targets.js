// LEAGUES > Targets  (formerly "Interest")
//
// A watchlist of players you'd love to acquire. For the active league it shows which
// targets are AVAILABLE (free agents) and, for those owned by opponents, a recommended
// offer from your roster — balanced on your Lifetime Value and sanity-checked against
// public consensus (buy-low / sell-high). The list also feeds the waiver-alert companion
// so you get a push when one hits free agency.
//
// "Recommended Targets" stack-ranks the biggest value edges in your rankings: players you
// rate higher than the public market (your Lifetime Value vs. consensus), i.e. buy-low
// candidates worth chasing. Filter by position and add any of them to your list.

import { div, span, el, btn, mount } from '../lib/dom.js';
import { navigate } from '../router.js';
import { loadLeagueContext, ownerDisplayName, rosteredPlayerIds } from '../lib/league.js';
import { playerName, playerPositions } from '../lib/players.js';
import { getState, getActiveLeagueId, getTargets, addTarget, removeTarget } from '../store.js';
import { getConsensusValues, leagueToConsensusParams, getTePremium } from '../api/fantasycalc.js';
import { describeWithValue, computeArbitrage } from '../lib/tradevalue.js';
import { asyncRegion, matchDiagnostic, rankBadge, emptyBlock, sectionTitle } from './components.js';

const TE_BUMP_PER_POINT = 0.4; // keep in step with the Trade Finder
const CORE = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const OFFER_MIN = 0.95; // an offer may be worth down to 95% of the target…
const OFFER_MAX = 1.35; // …and up to 135% (a reasonable nudge to land them)
const REC_POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE']; // Recommended Targets position filter
const REC_LIMIT = 25; // how many recommendations to show per filter

const local = { leagueId: null, q: '', recPos: 'ALL' };

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
  const myRosterIds = new Set(ctx.myRoster?.players || []);
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

  // Stack-ranked value edges across your whole ranking universe (for Recommended Targets).
  const recommended = buildRecommended(ctx, consensus, teFactor, myRosterIds);

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

  // --- Recommended targets (value edges) ---
  const recHost = div({});
  out.appendChild(recHost);

  // --- Search & add ---
  const resultsHost = div({ class: 'int-search-results' });
  const searchInput = el('input', {
    type: 'search', class: 'input', placeholder: 'Search players to add…', value: local.q,
    autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
    oninput: debounce((e) => { local.q = e.target.value.trim().toLowerCase(); paintSearch(); }, 200),
  });
  out.appendChild(div({ class: 'card' },
    sectionTitle('Add to targets list', 'Watch players to get a push when they free up'),
    searchInput,
    resultsHost,
  ));

  // --- Targets list (available / trade-for / yours) ---
  const targetsHost = div({});
  out.appendChild(targetsHost);

  function paintRecommended() {
    const filtered = (local.recPos === 'ALL'
      ? recommended
      : recommended.filter((p) => p.positions.includes(local.recPos))).slice(0, REC_LIMIT);
    const targeted = new Set(getTargets());

    const filterBar = div({ class: 'segmented rec-filter' },
      ...REC_POSITIONS.map((pos) => btn({
        class: 'seg' + (local.recPos === pos ? ' active' : ''),
        onclick: () => { local.recPos = pos; paintRecommended(); },
      }, pos === 'ALL' ? 'All' : pos)),
    );

    const list = filtered.length
      ? div({ class: 'list' }, ...filtered.map((p) => {
          const added = targeted.has(p.id);
          return div({ class: 'player-row' },
            div({ class: 'pr-main' },
              span({ class: 'pr-name' }, p.name),
              span({ class: 'pr-meta muted small' },
                [p.team, p.positions.join('/'), `LV ${fmtVal(p.lifetimeValue)}`].filter(Boolean).join(' · ')),
            ),
            div({ class: 'row-badges' },
              span({ class: 'badge arb-buy', title: `You rank this player ${p.edge} spot${p.edge === 1 ? '' : 's'} higher than public consensus` }, `+${p.edge} edge`),
              rankBadge(p.rank),
              added
                ? span({ class: 'pill pill-good' }, '✓ Added')
                : btn({ class: 'btn btn-sm', onclick: () => { addTarget(p.id); paintRecommended(); paintTargets(); } }, '+ Add'),
            ),
          );
        }))
      : emptyBlock(recommended.length
          ? 'No value edges at this position right now.'
          : 'Add a "Lifetime Value" column to your rankings (Setup) to get recommendations.');

    mount(recHost, div({ class: 'card' },
      sectionTitle('Recommended targets', 'Biggest value edges — players you rate above the market'),
      filterBar,
      list,
    ));
  }

  function paintSearch() {
    if (!local.q || local.q.length < 2) { mount(resultsHost); return; }
    const targeted = new Set(getTargets());
    const matches = searchPool.filter((s) => s.lower.includes(local.q)).slice(0, 15);
    mount(resultsHost, matches.length
      ? div({ class: 'list' }, ...matches.map((s) => {
          const added = targeted.has(s.id);
          return div({ class: 'player-row' },
            div({ class: 'pr-main' },
              span({ class: 'pr-name' }, s.name),
              span({ class: 'pr-meta muted small' }, [s.team, s.pos].filter(Boolean).join(' · ')),
            ),
            added
              ? span({ class: 'pill pill-good' }, '✓ Added')
              : btn({ class: 'btn btn-sm', onclick: () => { addTarget(s.id); paintSearch(); paintTargets(); paintRecommended(); } }, '+ Add'),
          );
        }))
      : emptyBlock('No matching players.'));
  }

  function paintTargets() {
    const ids = getTargets();
    if (!ids.length) {
      mount(targetsHost, div({ class: 'card' }, emptyBlock('Your targets list is empty. Add players from Recommended targets or search above.')));
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
        ? div({ class: 'list' }, ...available.map((p) => targetRow(p, {
            badge: span({ class: 'badge arb-buy' }, 'Free agent'),
            action: btn({ class: 'btn btn-sm', onclick: () => navigate('leagues', 'freeagents') }, 'Free Agents →'),
          })))
        : emptyBlock('None of your targets are free agents in this league right now.'),
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
        : emptyBlock('None of your targets are on an opponent’s roster here.'),
    ));

    if (owned.length) {
      node.appendChild(div({ class: 'card' },
        sectionTitle('Already yours', `${owned.length}`),
        div({ class: 'list' }, ...owned.map((p) => targetRow(p, { badge: span({ class: 'pill pill-good' }, 'On your roster') }))),
      ));
    }

    mount(targetsHost, node);
  }

  function targetRow(p, { badge = null, action = null } = {}) {
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
    return btn({ class: 'btn btn-sm int-remove', title: 'Remove from targets list',
      onclick: () => { removeTarget(id); paintTargets(); paintSearch(); paintRecommended(); } }, '×');
  }

  // A deal with one opponent: the target player(s) you'd acquire from them, plus a
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
  paintRecommended();
  paintSearch();
  paintTargets();
  return out;
}

const sumLV = (arr) => arr.reduce((s, p) => s + (p.lifetimeValue || 0), 0);

// Stack-rank your biggest value edges: players whose Lifetime Value rates them higher
// than the public consensus does. We rank the shared (LV + consensus) pool both ways and
// score edge = consensusRank - yourRank (positive = you're higher on them than the market).
// Players on your own roster are excluded — you can't "target" what you already own.
function buildRecommended(ctx, consensus, teFactor, myRosterIds) {
  const pool = [];
  for (const [id, row] of ctx.rankingLookup.entries()) {
    if (!row || row.lifetimeValue == null) continue;
    const c = consensus ? consensus.get(String(id)) : null;
    if (!c) continue;
    const positions = playerPositions(ctx.players, id);
    if (!positions.some((pos) => CORE.has(pos))) continue;
    const consAdj = c.value * (positions.includes('TE') ? teFactor : 1);
    pool.push({
      id,
      name: playerName(ctx.players, id),
      team: ctx.players[id]?.team || row.team || '',
      positions,
      rank: row.rank,
      lifetimeValue: row.lifetimeValue,
      consAdj,
    });
  }
  if (pool.length < 4) return []; // too few to compare meaningfully

  const byMine = [...pool].sort((a, b) => b.lifetimeValue - a.lifetimeValue);
  byMine.forEach((p, i) => { p.lvRank = i + 1; });
  const byPublic = [...pool].sort((a, b) => b.consAdj - a.consAdj);
  byPublic.forEach((p, i) => { p.pubRank = i + 1; });
  for (const p of pool) p.edge = p.pubRank - p.lvRank;

  return pool
    .filter((p) => p.edge > 0 && !myRosterIds.has(p.id))
    .sort((a, b) => (b.edge - a.edge) || (a.lvRank - b.lvRank));
}

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
