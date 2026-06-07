// LEAGUES > Trade Finder
//
// Goal: grow your team's total *Lifetime Value* (a per-player worth imported from
// your rankings CSV). Pick a player to trade away and the finder surfaces realistic
// upgrade targets on opponents' rosters — hiding unrealistic overpays — and tags each
// against public consensus (FantasyCalc) so you can spot buy-low / market-premium deals.
//
// Lifetime Value (your scale) and FantasyCalc value (the public's scale) are NOT
// directly comparable as raw numbers, so all market arbitrage is computed from RANK
// position (where you rank a player vs where the public does), which is scale-free.

import { div, span, el, btn, mount } from '../lib/dom.js';
import { loadLeagueContext, ownerDisplayName } from '../lib/league.js';
import { enrichPlayer } from '../lib/players.js';
import { getState } from '../store.js';
import { getConsensusValues, leagueToConsensusParams } from '../api/fantasycalc.js';
import { leagueSelector, asyncRegion, matchDiagnostic, rankBadge, emptyBlock, sectionTitle } from './components.js';

// Cap on how much more valuable a target may be than the player you'd give up.
// Beyond this, acquiring it would require a significant overpay — the unrealistic
// trades we deliberately hide.
const FAIR_MAX_GAIN = 0.5; // +50%

const local = { leagueId: null, selectedId: null, pos: 'ALL', buyLowOnly: false };
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

export function render(container) {
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  const sel = leagueSelector('tradefinder', (id) => { local.leagueId = id; local.selectedId = null; trigger(); });
  if (!getState().session.leagues.some((l) => l.league_id === local.leagueId)) {
    local.leagueId = sel.selectedId;
    local.selectedId = null;
  }

  root.append(sel.node, body);
  mount(container, root);
  trigger();

  function trigger() { if (local.leagueId) run(() => load(local.leagueId)); }
}

function fmtVal(v) {
  if (v == null) return '—';
  return Math.round(v).toLocaleString();
}

// Attach my ranking-derived fields + public consensus to a player id.
function describe(id, ctx, consensus) {
  const p = enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
  p.consensus = consensus ? consensus.get(String(id)) || null : null;
  return p;
}

async function load(leagueId) {
  const ctx = await loadLeagueContext(leagueId);
  const isDynasty = getState().settings.leagueTypes[leagueId] === 'dynasty';
  const params = leagueToConsensusParams(ctx.league, isDynasty);
  const consensus = await getConsensusValues(params); // null on failure — optional

  if (!ctx.myRoster) {
    return div({}, matchDiagnostic(ctx.diagnostic, { compact: true }),
      emptyBlock('No roster found for your account in this league.'));
  }

  // My roster, enriched + sorted by Lifetime Value (most valuable first).
  const myPlayers = (ctx.myRoster.players || [])
    .map((id) => describe(id, ctx, consensus))
    .sort((a, b) => (b.lifetimeValue ?? -Infinity) - (a.lifetimeValue ?? -Infinity));
  const myValued = myPlayers.filter((p) => p.lifetimeValue != null);

  if (!myValued.length) {
    return div({}, matchDiagnostic(ctx.diagnostic, { compact: true }), noValueHelp());
  }

  // Opponent pool: every player on another roster that has a Lifetime Value.
  const myRosterId = ctx.myRoster.roster_id;
  const targets = [];
  for (const r of ctx.rosters) {
    if (r.roster_id === myRosterId) continue;
    const owner = ownerDisplayName(ctx.usersById, r.owner_id);
    for (const id of r.players || []) {
      const t = describe(id, ctx, consensus);
      if (t.lifetimeValue == null) continue;
      t.owner = owner;
      targets.push(t);
    }
  }

  // Market arbitrage, computed ONLY among players in this league that have both a
  // Lifetime Value (yours) and a public value (FantasyCalc). Ranking the same pool
  // two ways — by your value and by the public's — is apples-to-apples and scale-free.
  // arbDelta = publicRank - yourRank: positive means you rank a player higher than the
  // market does (you're "high" on them); negative means the market is higher.
  const arbThreshold = computeArbitrage([...myValued, ...targets]);

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));
  out.appendChild(consensusBanner(consensus, params));
  out.appendChild(teamSummary(myValued));
  out.appendChild(sellHighBoard(myValued, arbThreshold));

  // --- Trade-away picker + results ---
  if (!local.selectedId || !myValued.some((p) => p.playerId === local.selectedId)) {
    local.selectedId = myValued[0].playerId;
  }

  const picker = el('select', { class: 'select', onchange: (e) => { local.selectedId = e.target.value; paint(); } },
    ...myValued.map((p) => el('option', { value: p.playerId, selected: p.playerId === local.selectedId },
      `${p.name} — LV ${fmtVal(p.lifetimeValue)}`)));

  const posSel = el('select', { class: 'select', onchange: (e) => { local.pos = e.target.value; paint(); } },
    ...POSITIONS.map((p) => el('option', { value: p, selected: p === local.pos }, p)));

  const buyLowToggle = el('label', { class: 'toggle' },
    el('input', { type: 'checkbox', checked: local.buyLowOnly, onchange: (e) => { local.buyLowOnly = e.target.checked; paint(); } }),
    span({}, 'Buy-low only'));

  const resultsHost = div({ class: 'tf-results' });

  out.appendChild(div({ class: 'card' },
    sectionTitle('Find an upgrade', 'Players on other teams worth more than the one you give up'),
    div({ class: 'field' }, span({ class: 'field-label' }, 'Trade away'), picker),
    div({ class: 'tf-controls-row' }, posSel, consensus ? buyLowToggle : null),
    resultsHost,
  ));

  function paint() {
    const me = myValued.find((p) => p.playerId === local.selectedId);
    mount(resultsHost, selectedSummary(me), upgradeList(me, targets, arbThreshold));
  }
  paint();

  return out;
}

// Assigns p.arbDelta (publicRank - yourRank, in spots) to every player that has both
// a Lifetime Value and a public value, by ranking the shared pool both ways. Returns a
// threshold (in spots, scaled to pool size) at which a divergence is worth flagging.
function computeArbitrage(pool) {
  const rated = pool.filter((p) => p.lifetimeValue != null && p.consensus && p.consensus.value != null);
  for (const p of pool) p.arbDelta = null;
  if (rated.length < 4) return Infinity; // too few to compare meaningfully

  const byMine = [...rated].sort((a, b) => b.lifetimeValue - a.lifetimeValue);
  byMine.forEach((p, i) => { p._lvRank = i + 1; });
  const byPublic = [...rated].sort((a, b) => b.consensus.value - a.consensus.value);
  byPublic.forEach((p, i) => { p._pubRank = i + 1; });
  for (const p of rated) p.arbDelta = p._pubRank - p._lvRank;

  return Math.max(5, Math.ceil(rated.length * 0.05));
}

function consensusBanner(consensus, params) {
  if (consensus) {
    const fmt = `${params.isDynasty ? 'Dynasty' : 'Redraft'} · ${params.numQbs === 2 ? 'SF/2QB' : '1QB'} · ${params.numTeams}-team · ${params.ppr} PPR`;
    return div({ class: 'diag diag-ok' }, `Public consensus loaded (FantasyCalc · ${fmt}). Arbitrage tags compare your rank vs the public's.`);
  }
  return div({ class: 'diag diag-warn' }, '⚠ Public consensus unavailable — showing Lifetime Value only. Buy-low / market tags are hidden.');
}

function noValueHelp() {
  return div({ class: 'card' },
    sectionTitle('No Lifetime Value found'),
    div({ class: 'muted small' },
      'The Trade Finder needs a "Lifetime Value" column in the rankings CSV assigned to this league. ',
      'Re-import a CSV that includes a Lifetime Value (and optionally Lifetime Value Change) column in Setup.'),
  );
}

function teamSummary(myValued) {
  const total = myValued.reduce((s, p) => s + p.lifetimeValue, 0);
  const trend = myValued.reduce((s, p) => s + (p.lifetimeValueChange || 0), 0);
  return div({ class: 'card tf-summary' },
    div({ class: 'tf-stat' }, span({ class: 'tf-stat-num' }, fmtVal(total)), span({ class: 'tf-stat-label' }, 'Team Lifetime Value')),
    div({ class: 'tf-stat' }, span({ class: 'tf-stat-num' }, String(myValued.length)), span({ class: 'tf-stat-label' }, 'Valued players')),
    div({ class: 'tf-stat' }, span({ class: 'tf-stat-num' + (trend >= 0 ? ' pos' : ' neg') }, trendStr(trend)), span({ class: 'tf-stat-label' }, '30-day trend')),
  );
}

function trendStr(t) {
  if (!t) return '0';
  const r = Math.round(t);
  return (r > 0 ? '+' : '') + r.toLocaleString();
}

// My players the public rates meaningfully HIGHER than I do (negative arbDelta) =
// market overvalues them = good chips to trade away while perceived value is high.
function sellHighBoard(myValued, threshold) {
  const chips = myValued
    .filter((p) => p.arbDelta != null && p.arbDelta <= -threshold)
    .sort((a, b) => a.arbDelta - b.arbDelta)
    .slice(0, 6);
  if (!chips.length) return div({});
  return div({ class: 'card' },
    sectionTitle('Sell-high candidates', 'Your players the public values higher than you do'),
    div({ class: 'list' }, ...chips.map((p) =>
      div({ class: 'player-row' },
        div({ class: 'pr-main' },
          span({ class: 'pr-name' }, p.name),
          span({ class: 'pr-meta muted small' }, `${[p.team, p.positions.join('/')].filter(Boolean).join(' · ')} · your LV ${fmtVal(p.lifetimeValue)}`),
        ),
        div({ class: 'row-badges' },
          span({ class: 'badge arb-sell', title: 'Public ranks this player higher than your Lifetime Value does' }, `Market +${-p.arbDelta}`),
          rankBadge(p.rank),
        ),
      ))),
  );
}

function selectedSummary(me) {
  if (!me) return div({});
  const bits = [`Your LV ${fmtVal(me.lifetimeValue)}`];
  if (me.lifetimeValueChange != null) bits.push(`trend ${trendStr(me.lifetimeValueChange)}`);
  if (me.consensus && me.consensus.overallRank) bits.push(`public #${me.consensus.overallRank}`);
  return div({ class: 'tf-selected muted small' },
    `Giving up ${me.name} (${[me.team, me.positions.join('/')].filter(Boolean).join(' · ')}) · ${bits.join(' · ')}`);
}

function upgradeList(me, targets, threshold) {
  if (!me) return div({});
  const ceiling = me.lifetimeValue * (1 + FAIR_MAX_GAIN);

  let rows = targets
    .filter((t) => t.lifetimeValue > me.lifetimeValue && t.lifetimeValue <= ceiling)
    .filter((t) => local.pos === 'ALL' || t.positions.includes(local.pos))
    .map((t) => {
      const gain = t.lifetimeValue - me.lifetimeValue;
      // arbDelta > 0 => you rank the target higher than the public does => the market
      // may underprice them => buy-low. < 0 => the market prizes them more than you do.
      const arbDelta = t.arbDelta;
      let arb = 'none';
      if (arbDelta != null) {
        if (arbDelta >= threshold) arb = 'buy';
        else if (arbDelta <= -threshold) arb = 'premium';
        else arb = 'fair';
      }
      return { t, gain, arbDelta, arb };
    });

  if (local.buyLowOnly) rows = rows.filter((r) => r.arb === 'buy');

  // Buy-lows first, then by raw value gain.
  rows.sort((a, b) => {
    const ar = a.arb === 'buy' ? 0 : 1, br = b.arb === 'buy' ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.gain - a.gain;
  });

  if (!rows.length) {
    return emptyBlock(local.buyLowOnly
      ? 'No buy-low upgrades in the fair range. Try turning off "Buy-low only".'
      : 'No realistic upgrades found for this player in the fair value range.');
  }

  const capped = rows.slice(0, 40);
  return div({},
    div({ class: 'muted small tf-count' }, `${rows.length} fair upgrade${rows.length === 1 ? '' : 's'} (within +${Math.round(FAIR_MAX_GAIN * 100)}% value)`),
    div({ class: 'list' }, ...capped.map(targetRow)),
  );
}

function targetRow({ t, gain, arbDelta, arb }) {
  const tags = [];
  if (arb === 'buy') tags.push(span({ class: 'badge arb-buy', title: 'You rank this player higher than the public does — potential buy-low' }, `Buy-low +${arbDelta}`));
  else if (arb === 'premium') tags.push(span({ class: 'badge arb-premium', title: 'The public prizes this player more than your Lifetime Value does' }, `Premium ${arbDelta}`));
  else if (arb === 'fair') tags.push(span({ class: 'badge arb-fair' }, 'Fair market'));

  return div({ class: 'player-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, t.name),
      span({ class: 'pr-meta muted small' }, `${[t.team, t.positions.join('/')].filter(Boolean).join(' · ')} · ${t.owner}`),
    ),
    div({ class: 'tf-gain' },
      span({ class: 'tf-gain-num' }, `+${fmtVal(gain)}`),
      span({ class: 'tf-gain-label muted small' }, 'value'),
    ),
    div({ class: 'row-badges' }, ...tags, rankBadge(t.rank)),
  );
}
