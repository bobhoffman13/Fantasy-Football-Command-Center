// LEAGUES > Draft
//
// A live draft board for the active league. Lists every still-available player ranked by
// YOUR uploaded rankings, compares each to the average rank of players you've drafted at
// the same position, marks where your (trade-aware) picks land, and — via the Draft
// Assistant — recommends the top 3 picks by blending your rankings with live game theory
// (roster need, positional scarcity/runs across all teams, survival to your next pick).
// Auto-refreshes while a draft is in progress.

import { div, span, el, btn, mount } from '../lib/dom.js';
import { loadLeagueContext, rosteredPlayerIds } from '../lib/league.js';
import { enrichPlayer, playerPositions } from '../lib/players.js';
import { getState, getActiveLeagueId } from '../store.js';
import { getLeagueDrafts, getDraft, getDraftPicks, getDraftTradedPicks, getLeagueTradedPicks } from '../api/sleeper.js';
import { recommendDraftPicks, starterTargets } from '../lib/draftstrategy.js';
import { asyncRegion, matchDiagnostic, rankBadge, injuryBadge, byeBadge, emptyBlock, sectionTitle } from './components.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const MAX_LIST = 250;
const POLL_MS = 15000;
const RUN_WINDOW = 10; // recent picks scanned for positional-run detection

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

  // Resolve which draft: prefer a live one, else the most recent.
  let draftId = ctx.league?.draft_id || null;
  try {
    const drafts = await getLeagueDrafts(leagueId);
    if (Array.isArray(drafts) && drafts.length) {
      const chosen = drafts.find((d) => d.status === 'drafting' || d.status === 'paused') || drafts[0];
      draftId = chosen?.draft_id || draftId;
    }
  } catch { /* fall through to league.draft_id */ }
  if (!draftId) {
    return div({}, matchDiagnostic(ctx.diagnostic, { compact: true }),
      emptyBlock('No draft found for this league. Sleeper exposes the board once a draft is created.'));
  }
  // Always fetch the FULL draft object — the league-drafts list omits slot_to_roster_id /
  // draft_order, which we need to project your actual (traded) picks.
  let draft = null;
  try { draft = await getDraft(draftId); } catch { /* ignore */ }
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

  // Map draft slot -> roster_id. Prefer Sleeper's slot_to_roster_id; otherwise derive it
  // from draft_order (user -> slot) + rosters (user -> roster_id).
  let slotToRoster = draft.slot_to_roster_id || null;
  if (!slotToRoster && draft.draft_order) {
    const rosterByOwner = new Map();
    for (const r of ctx.rosters) if (r.owner_id != null) rosterByOwner.set(r.owner_id, r.roster_id);
    slotToRoster = {};
    for (const [uid, slot] of Object.entries(draft.draft_order)) {
      const rid = rosterByOwner.get(uid);
      if (rid != null) slotToRoster[slot] = rid;
    }
  }

  // Your roster id (used to claim picks by ownership). Fall back to your slot's roster.
  let myRosterId = ctx.myRoster?.roster_id ?? null;
  if (myRosterId == null && mySlot != null && slotToRoster) myRosterId = slotToRoster[mySlot] ?? null;

  // Snake/linear pick math, so we can project where your next pick lands.
  const teams = Number(draft.settings?.teams) || 0;
  const rounds = Number(draft.settings?.rounds) || 0;
  const isAuction = draft.type === 'auction';
  const isSnake = (draft.type || 'snake') === 'snake';

  // Traded picks: which roster currently OWNS each (round, original-roster) pick. This is
  // what makes the projection track your ACTUAL picks, not just your snake slot. We merge
  // the draft-scoped list with the league list (filtered to this draft's season) since the
  // draft endpoint is sometimes incomplete.
  const tradedOwner = new Map(); // `${round}:${originalRosterId}` -> current owner roster_id
  const ingest = (list, filterSeason) => {
    for (const t of list || []) {
      if (filterSeason && draft.season != null && String(t.season) !== String(draft.season)) continue;
      if (t.round != null && t.roster_id != null && t.owner_id != null) {
        tradedOwner.set(`${t.round}:${t.roster_id}`, t.owner_id);
      }
    }
  };
  try { ingest(await getDraftTradedPicks(draftId), false); } catch { /* ignore */ }
  try { ingest(await getLeagueTradedPicks(leagueId), true); } catch { /* ignore */ }

  // Which draft slot is on the clock at overall pick P (1-indexed).
  function slotAt(P) {
    const posInRound = ((P - 1) % teams) + 1;
    const round = Math.floor((P - 1) / teams) + 1;
    return (isSnake && round % 2 === 0) ? (teams - posInRound + 1) : posInRound;
  }
  // Does overall pick P belong to you? Resolve the slot -> original roster, then apply any
  // trade that moved that pick to another roster. Falls back to raw slot if we can't map
  // rosters (then trades aren't reflected).
  function isMyPick(P) {
    const slot = slotAt(P);
    if (slotToRoster && myRosterId != null) {
      const baseRoster = slotToRoster[slot];
      if (baseRoster != null) {
        const round = Math.floor((P - 1) / teams) + 1;
        const key = `${round}:${baseRoster}`;
        const owner = tradedOwner.has(key) ? tradedOwner.get(key) : baseRoster;
        return owner === myRosterId;
      }
    }
    return mySlot != null && slot === mySlot;
  }
  // Find every upcoming pick you own (trade-aware), each as { before, overall, round },
  // where `before` is how many picks happen before it relative to now. First = next pick.
  function myUpcomingPicks(picksMade) {
    if (!teams || isAuction || (myRosterId == null && mySlot == null)) return [];
    const maxPick = rounds ? teams * rounds : teams * 30;
    const start = picksMade + 1;
    const picks = [];
    for (let P = start; P <= maxPick; P++) {
      if (isMyPick(P)) picks.push({ before: P - start, overall: P, round: Math.floor((P - 1) / teams) + 1 });
    }
    return picks;
  }

  // Players already rostered league-wide before the draft (e.g. dynasty keepers) — never
  // "available". Picks made during the draft are layered on top each refresh.
  const preRostered = new Set([...rosteredPlayerIds(ctx.rosters)].map(String));
  const myExisting = (ctx.myRoster?.players || []).map(String); // your roster going in

  // Strategy inputs. Starter demand + each team's pre-draft positional makeup (static);
  // live picks are layered on per refresh to gauge league-wide need and positional runs.
  const targets = starterTargets(ctx.league?.roster_positions);
  const posOf = (id) => primaryPos(playerPositions(ctx.players, id));
  const rosterByOwner = new Map();
  for (const r of ctx.rosters) if (r.owner_id != null) rosterByOwner.set(r.owner_id, r.roster_id);
  const baseCounts = new Map(); // rosterId -> { POS: count }
  const baseIds = new Map();    // rosterId -> Set(playerId) (to avoid double-counting picks)
  for (const r of ctx.rosters) {
    const counts = {};
    const ids = new Set();
    for (const pid of r.players || []) {
      ids.add(String(pid));
      const pos = posOf(String(pid));
      if (pos) counts[pos] = (counts[pos] || 0) + 1;
    }
    baseCounts.set(r.roster_id, counts);
    baseIds.set(r.roster_id, ids);
  }

  // Closure state, refreshed from picks.
  let available = [];
  let myRosterPlayers = [];
  let posStats = {}; // pos -> { count, avg }
  let totalPicks = 0;
  let myPicks = []; // [{ before, overall, round }] — all your upcoming picks, next first
  let recommendations = []; // top-3 strategy picks

  const out = div({});
  out.appendChild(matchDiagnostic(ctx.diagnostic, { compact: true }));
  const statusHost = div({ class: 'draft-status' });
  const recHost = div({});
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

  out.append(statusHost, recHost, summaryHost, controls, listHost);

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
    myPicks = myUpcomingPicks(totalPicks);

    // League-wide positional demand + recent run, from every team's live makeup.
    const countsByRoster = new Map();
    for (const [rid, counts] of baseCounts) countsByRoster.set(rid, { ...counts });
    const recentPositions = [];
    for (const pk of [...(picks || [])].sort((a, b) => (a.pick_no || 0) - (b.pick_no || 0))) {
      if (!pk.player_id) continue;
      const pos = posOf(String(pk.player_id));
      if (pos) recentPositions.push(pos);
      const rid = pk.roster_id != null ? pk.roster_id : rosterByOwner.get(pk.picked_by);
      if (rid != null && pos && !baseIds.get(rid)?.has(String(pk.player_id))) {
        const c = countsByRoster.get(rid) || {};
        c[pos] = (c[pos] || 0) + 1;
        countsByRoster.set(rid, c);
      }
    }
    const myCounts = {};
    for (const pos of POS_ORDER) myCounts[pos] = posStats[pos]?.count || 0;
    const leagueDemand = {};
    for (const pos of POS_ORDER) {
      const req = Math.round(targets[pos] || 0);
      let n = 0;
      for (const [rid, counts] of countsByRoster) {
        if (rid === myRosterId) continue;
        if ((counts[pos] || 0) < req) n++;
      }
      leagueDemand[pos] = n;
    }
    recommendations = recommendDraftPicks({
      available, myCounts, targets, leagueDemand,
      recentPositions: recentPositions.slice(-RUN_WINDOW),
      picksUntilNext: myPicks[0]?.before ?? null,
      teamsCount: teams || ctx.rosters.length,
    });
  }

  function paintAll() {
    mount(statusHost, statusBanner(draft, totalPicks));
    mount(recHost, recommendationsCard(recommendations));
    mount(summaryHost, rosterSummary(myRosterPlayers.length, posStats));
    paintList();
  }

  function paintList() {
    const filtered = local.pos !== 'ALL' || !!local.q;
    let rows = available;
    if (local.pos !== 'ALL') rows = rows.filter((p) => p.positions.includes(local.pos));
    if (local.q) rows = rows.filter((p) => p.name.toLowerCase().includes(local.q));
    const capped = rows.slice(0, MAX_LIST);

    // Projection lines only make sense on the full, unfiltered board (picks before each of
    // your selections span every position, not just the filtered one). Insert a marker at
    // each owned pick's projected slot.
    const markerAt = new Map(); // insertion index -> pick
    if (!filtered) {
      for (const mp of myPicks) if (mp.before <= capped.length && !markerAt.has(mp.before)) markerAt.set(mp.before, mp);
    }
    const nodes = [];
    for (let i = 0; i <= capped.length; i++) {
      if (markerAt.has(i)) nodes.push(pickMarker(markerAt.get(i)));
      if (i < capped.length) nodes.push(draftRow(capped[i], posStats));
    }

    const next = myPicks[0];
    const pickLine = next
      ? `Your next pick: Round ${next.round}, #${next.overall} overall`
        + (next.before === 0 ? ' — on the clock' : ` · ~${next.before} off the board first`)
        + (myPicks.length > 1 ? ` · ${myPicks.length} of your picks remaining` : '')
      : (!isAuction && !mySlot ? 'Draft order not set yet — pick projection unavailable' : null);

    mount(listHost,
      pickLine ? div({ class: 'muted small draft-pickline' }, pickLine) : null,
      div({ class: 'muted small fa-count' },
        `${rows.length} available${rows.length > MAX_LIST ? ` (showing top ${MAX_LIST})` : ''}`
        + (filtered && myPicks.length ? ' · pick lines hidden while filtered' : '')),
      capped.length
        ? div({ class: 'card' }, div({ class: 'list' }, ...nodes))
        : emptyBlock('No matching available players.'),
    );
  }

  function pickMarker(mp) {
    const label = mp.before === 0
      ? '🟢 Your pick — on the clock'
      : `⬇ Your pick · Round ${mp.round}, #${mp.overall} overall`;
    return div({ class: 'draft-pick-marker', title: 'Projected, assuming players come off the board in your ranking order' },
      span({ class: 'dpm-label' }, label));
  }

  async function refresh() {
    const picks = await getDraftPicks(draftId);
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

function recommendationsCard(recs) {
  if (!recs || !recs.length) return div({});
  return div({ class: 'card draft-rec-card' },
    sectionTitle('Draft assistant', 'Top 3 picks now — your rankings + draft game theory'),
    div({ class: 'list' }, ...recs.map((r, i) =>
      div({ class: 'player-row target-row draft-rec' },
        span({ class: 'draft-rec-num' }, String(i + 1)),
        div({ class: 'pr-main' },
          span({ class: 'pr-name' }, r.player.name),
          span({ class: 'pr-meta muted small' }, [r.player.team, r.player.positions.join('/')].filter(Boolean).join(' · ')),
          div({ class: 'draft-rec-why muted small' }, r.reasons.join(' · ')),
        ),
        div({ class: 'row-badges' }, rankBadge(r.player.rank)),
      ))),
    div({ class: 'muted small draft-rec-note' }, 'Balances your rankings with roster need, positional scarcity, and whether a player survives to your next pick.'),
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
