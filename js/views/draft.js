// LEAGUES > Draft
//
// A live draft board for the active league. Lists every still-available player ranked by
// YOUR uploaded rankings, and — for each one — compares their rank to the average rank of
// the players you've already drafted at the same position, so you can see upgrades and
// positions of need at a glance. Auto-refreshes while a draft is in progress.

import { div, span, el, btn, mount } from '../lib/dom.js';
import { loadLeagueContext, rosteredPlayerIds } from '../lib/league.js';
import { enrichPlayer } from '../lib/players.js';
import { getState, getActiveLeagueId } from '../store.js';
import { getLeagueDrafts, getDraft, getDraftPicks } from '../api/sleeper.js';
import { asyncRegion, matchDiagnostic, rankBadge, injuryBadge, byeBadge, emptyBlock, sectionTitle } from './components.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const MAX_LIST = 250;
const POLL_MS = 15000;

const STATUS = {
  pre_draft: { label: 'Not started', live: false },
  drafting: { label: '🔴 Live — auto-refreshing', live: true },
  paused: { label: '⏸ Paused', live: true },
  complete: { label: 'Draft complete', live: false },
};

const local = { leagueId: null, pos: 'ALL', q: '' };
let pollTimer = null;
let viewToken = 0; // guards stale polling after navigating away

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

export function render(container) {
  stopPolling();
  const myToken = ++viewToken;
  const root = div({ class: 'view' });
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);

  local.leagueId = getActiveLeagueId();
  root.append(body);
  mount(container, root);
  if (local.leagueId) run(() => load(local.leagueId, myToken));
  return () => { if (myToken === viewToken) stopPolling(); };
}

// First core fantasy position (so RB/WR types group under one), else first listed.
function primaryPos(positions) {
  for (const p of positions) if (POS_ORDER.includes(p)) return p;
  return positions[0] || null;
}

async function load(leagueId, myToken) {
  const ctx = await loadLeagueContext(leagueId);

  // Resolve the draft: prefer a live one, else the most recent.
  let draft = null;
  try {
    const drafts = await getLeagueDrafts(leagueId);
    if (Array.isArray(drafts) && drafts.length) {
      draft = drafts.find((d) => d.status === 'drafting' || d.status === 'paused') || drafts[0];
    }
  } catch { /* fall through to league.draft_id */ }
  if (!draft && ctx.league?.draft_id) {
    try { draft = await getDraft(ctx.league.draft_id); } catch { /* ignore */ }
  }
  if (!draft) {
    return div({}, matchDiagnostic(ctx.diagnostic, { compact: true }),
      emptyBlock('No draft found for this league. Sleeper exposes the board once a draft is created.'));
  }

  // Every ranked player, enriched + sorted by your rank. Availability is recomputed each
  // refresh as picks come in.
  const rankedPool = [];
  for (const [id, rankRow] of ctx.rankingLookup.entries()) {
    if (rankRow?.rank == null) continue;
    const p = enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
    p.pos = primaryPos(p.positions);
    rankedPool.push(p);
  }
  rankedPool.sort((a, b) => a.rank - b.rank);

  const userId = getState().settings.userId;
  const mySlot = draft.draft_order?.[userId] ?? null;

  // Snake/linear pick math, so we can project where your next pick lands.
  const teams = Number(draft.settings?.teams) || 0;
  const rounds = Number(draft.settings?.rounds) || 0;
  const isAuction = draft.type === 'auction';
  const isSnake = (draft.type || 'snake') === 'snake';

  // Which draft slot is on the clock at overall pick P (1-indexed).
  function slotAt(P) {
    const posInRound = ((P - 1) % teams) + 1;
    const round = Math.floor((P - 1) / teams) + 1;
    return (isSnake && round % 2 === 0) ? (teams - posInRound + 1) : posInRound;
  }
  // Given picks already made, find your next pick: how many picks happen before it
  // (`before`), its overall number, and round. null when it can't be projected.
  function myNextPick(picksMade) {
    if (!teams || !mySlot || isAuction) return null;
    const maxPick = rounds ? teams * rounds : teams * 30;
    const start = picksMade + 1;
    for (let P = start; P <= maxPick; P++) {
      if (slotAt(P) === mySlot) return { before: P - start, overall: P, round: Math.floor((P - 1) / teams) + 1 };
    }
    return null;
  }

  // Players already rostered league-wide before the draft (e.g. dynasty keepers) — never
  // "available". Picks made during the draft are layered on top each refresh.
  const preRostered = new Set([...rosteredPlayerIds(ctx.rosters)].map(String));
  const myExisting = (ctx.myRoster?.players || []).map(String); // your roster going in

  // Closure state, refreshed from picks.
  let available = [];
  let myRosterPlayers = [];
  let posStats = {}; // pos -> { count, avg }
  let totalPicks = 0;
  let myPick = null; // { before, overall, round } | null

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));
  const statusHost = div({ class: 'draft-status' });
  const summaryHost = div({});
  const listHost = div({});

  // Controls (static) — filtering only re-renders the list.
  const search = el('input', {
    type: 'search', class: 'input', placeholder: 'Search name…', value: local.q,
    autocapitalize: 'none', autocorrect: 'off', spellcheck: false,
    oninput: debounce((e) => { local.q = e.target.value.trim().toLowerCase(); paintList(); }, 250),
  });
  const posSel = el('select', { class: 'select', onchange: (e) => { local.pos = e.target.value; paintList(); } },
    ...POSITIONS.map((p) => el('option', { value: p, selected: p === local.pos }, p)));
  const refreshBtn = btn({ class: 'btn btn-sm', onclick: () => refresh().catch(() => {}) }, '↻ Refresh');
  const controls = div({ class: 'card fa-controls' },
    div({ class: 'fa-controls-top' }, span({ class: 'muted small' }, 'Available players, ranked by your rankings'), refreshBtn),
    div({ class: 'fa-controls-row' }, search, posSel),
  );

  out.append(statusHost, summaryHost, controls, listHost);

  function recompute(picks) {
    const taken = new Set(preRostered); // rostered + drafted = unavailable
    const myIds = new Set(myExisting);  // your roster: existing + your picks
    for (const pk of picks || []) {
      if (!pk.player_id) continue;
      const id = String(pk.player_id);
      taken.add(id);
      const mine = (userId && pk.picked_by === userId) || (mySlot != null && pk.draft_slot === mySlot);
      if (mine) myIds.add(id);
    }
    totalPicks = (picks || []).length;

    myRosterPlayers = [...myIds].map((id) => {
      const ep = enrichPlayer(id, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode);
      ep.pos = primaryPos(ep.positions);
      return ep;
    });

    // Per-position: total count (incl. unranked) and average rank (ranked only).
    const ranksByPos = {};
    const countByPos = {};
    for (const p of myRosterPlayers) {
      if (!p.pos) continue;
      countByPos[p.pos] = (countByPos[p.pos] || 0) + 1;
      if (p.rank != null) (ranksByPos[p.pos] ||= []).push(p.rank);
    }
    posStats = {};
    for (const pos of POS_ORDER) {
      const ranks = ranksByPos[pos] || [];
      posStats[pos] = {
        count: countByPos[pos] || 0,
        avg: ranks.length ? Math.round(ranks.reduce((s, x) => s + x, 0) / ranks.length) : null,
      };
    }

    available = rankedPool.filter((p) => !taken.has(String(p.playerId)));
    myPick = myNextPick(totalPicks);
  }

  function paintAll() {
    mount(statusHost, statusBanner(draft, totalPicks));
    mount(summaryHost, rosterSummary(myRosterPlayers.length, posStats));
    paintList();
  }

  function paintList() {
    const filtered = local.pos !== 'ALL' || !!local.q;
    let rows = available;
    if (local.pos !== 'ALL') rows = rows.filter((p) => p.positions.includes(local.pos));
    if (local.q) rows = rows.filter((p) => p.name.toLowerCase().includes(local.q));
    const capped = rows.slice(0, MAX_LIST);

    // The projection line only makes sense on the full, unfiltered board (picks before
    // you span every position, not just the filtered one).
    const nodes = capped.map((p) => draftRow(p, posStats));
    if (!filtered && myPick && myPick.before <= capped.length) {
      nodes.splice(myPick.before, 0, pickMarker(myPick));
    }

    const pickLine = myPick
      ? `Your next pick: Round ${myPick.round}, #${myPick.overall} overall` + (myPick.before === 0 ? ' — on the clock' : ` · ~${myPick.before} off the board first`)
      : (!isAuction && !mySlot ? 'Draft order not set yet — pick projection unavailable' : null);

    mount(listHost,
      pickLine ? div({ class: 'muted small draft-pickline' }, pickLine) : null,
      div({ class: 'muted small fa-count' },
        `${rows.length} available${rows.length > MAX_LIST ? ` (showing top ${MAX_LIST})` : ''}`
        + (filtered && myPick ? ' · pick line hidden while filtered' : '')),
      capped.length
        ? div({ class: 'card' }, div({ class: 'list' }, ...nodes))
        : emptyBlock('No matching available players.'),
    );
  }

  function pickMarker(mp) {
    const label = mp.before === 0
      ? '🟢 Your pick — on the clock'
      : `⬇ Your pick here · Round ${mp.round}, #${mp.overall} overall`;
    return div({ class: 'draft-pick-marker', title: 'Projected, assuming players come off the board in your ranking order' },
      span({ class: 'dpm-label' }, label));
  }

  async function refresh() {
    const picks = await getDraftPicks(draft.draft_id);
    if (myToken !== viewToken) return; // navigated away mid-flight
    recompute(picks);
    paintAll();
  }

  await refresh();

  if ((draft.status === 'drafting' || draft.status === 'paused') && myToken === viewToken) {
    pollTimer = setInterval(() => {
      if (myToken !== viewToken) { stopPolling(); return; }
      refresh().catch(() => {});
    }, POLL_MS);
  }

  return out;
}

function statusBanner(draft, totalPicks) {
  const s = STATUS[draft.status] || { label: draft.status || 'Unknown', live: false };
  const type = draft.type ? draft.type[0].toUpperCase() + draft.type.slice(1) : '';
  const teams = draft.settings?.teams;
  const rounds = draft.settings?.rounds;
  const meta = [type, teams ? `${teams} teams` : null, rounds ? `${rounds} rounds` : null, `${totalPicks} picks made`]
    .filter(Boolean).join(' · ');
  return div({ class: `diag ${s.live ? 'diag-ok' : 'diag-none'}` },
    div({ class: 'diag-head' }, span({}, s.label)),
    div({ class: 'muted small' }, meta),
  );
}

function rosterSummary(playerCount, posStats) {
  return div({ class: 'card' },
    sectionTitle('Your roster', `${playerCount} player${playerCount === 1 ? '' : 's'} · avg rank by position`),
    div({ class: 'draft-roster-grid' }, ...POS_ORDER.map((pos) => {
      const st = posStats[pos] || { count: 0, avg: null };
      const need = st.count === 0;
      return div({ class: 'draft-pos-chip' + (need ? ' need' : '') },
        div({ class: 'dp-pos' }, pos),
        div({ class: 'dp-count' }, `${st.count}`),
        div({ class: 'dp-avg muted small' }, st.avg != null ? `avg #${st.avg}` : (need ? 'none yet' : 'unranked')),
      );
    })),
  );
}

function draftRow(p, posStats) {
  const st = p.pos ? posStats[p.pos] : null;
  let cmp = null;
  if (st) {
    if (st.count === 0) {
      cmp = span({ class: 'badge draft-need', title: `You haven't drafted a ${p.pos} yet` }, `Need ${p.pos}`);
    } else if (st.avg != null && p.rank != null) {
      const delta = st.avg - p.rank; // positive => ranked better than your average at this position
      const cls = delta > 0 ? 'draft-up' : (delta < 0 ? 'draft-down' : 'draft-fair');
      const arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '▶');
      cmp = span({ class: `badge ${cls}`, title: `Your ${p.pos} picks average #${st.avg} (${st.count}). This player is ${Math.abs(delta)} ${delta >= 0 ? 'better' : 'worse'}.` },
        `${arrow}${Math.abs(delta)} vs ${p.pos}`);
    }
  }

  return div({ class: 'player-row target-row' },
    div({ class: 'pr-main' },
      span({ class: 'pr-name' }, p.name),
      span({ class: 'pr-meta muted small' }, [p.team, p.positions.join('/'), p.lifetimeValue != null ? `LV ${Math.round(p.lifetimeValue).toLocaleString()}` : null].filter(Boolean).join(' · ')),
    ),
    div({ class: 'row-badges' },
      cmp,
      byeBadge(p.onBye, p.byeWeek),
      injuryBadge(p.injuryStatus),
      rankBadge(p.rank),
    ),
  );
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
