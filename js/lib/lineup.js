// Lineup optimizer + startability logic.

import { FLEX_ELIGIBILITY, FLEX_SLOTS, NON_STARTING_SLOTS, HARD_OUT_STATUSES } from '../data/constants.js';

const UNRANKED = 100000; // sentinel so unranked players sort last but remain usable

// Weekly rankings cover QB/RB/WR/TE but usually not kickers or defenses, and never
// the deep end of a roster. A player absent from the week's file sorts after every
// ranked player, but still in season-ranking order among the others — so a lone
// kicker still fills the K slot, and two unranked bench receivers keep a sensible
// order rather than falling back to roster order.
const UNRANKED_WEEKLY = 1000000;

// Determine whether a player can be started this week given injury + bye + risk.
// Returns { startable, questionable, reason }.
export function evaluateStartability(player, riskMode) {
  if (player.onBye) return { startable: false, questionable: false, reason: 'On bye' };
  const status = player.injuryStatus;
  if (status && HARD_OUT_STATUSES.has(status)) {
    return { startable: false, questionable: false, reason: status };
  }
  if (status === 'Questionable') {
    if (riskMode === 'sit') return { startable: false, questionable: true, reason: 'Questionable (sat)' };
    return { startable: true, questionable: true, reason: 'Questionable' };
  }
  return { startable: true, questionable: false, reason: '' };
}

function slotEligible(slot, positions) {
  if (FLEX_SLOTS.has(slot)) {
    const allowed = FLEX_ELIGIBILITY[slot] || [];
    return positions.some((p) => allowed.includes(p));
  }
  // Exact position slot.
  return positions.includes(slot);
}

function seasonRankOf(p) {
  return p.rank == null ? UNRANKED : p.rank;
}

// Sort key when a weekly ranking set is driving the lineup.
export function weeklyRankOf(p) {
  if (p.weekly?.rank != null) return p.weekly.rank;
  return UNRANKED_WEEKLY + seasonRankOf(p);
}

// players: [{ playerId, name, positions:[], rank, injuryStatus, byeWeek, onBye, startable, questionable }]
// rosterPositions: array from league (e.g. ["QB","RB","RB","WR","FLEX","K","DEF","BN","BN"])
// rankOf: sort key, lower is better. Defaults to the season ranking; the Lineup tab
//   passes weeklyRankOf when a weekly set applies to the league.
export function optimizeLineup(players, rosterPositions, { rankOf = seasonRankOf } = {}) {
  const startingSlots = (rosterPositions || []).filter((s) => !NON_STARTING_SLOTS.has(s));
  const pool = players.filter((p) => p.startable).slice();
  // Best rank first.
  pool.sort((a, b) => rankOf(a) - rankOf(b));

  // Exact-position slots first, then flex slots.
  const ordered = [
    ...startingSlots.map((slot, i) => ({ slot, i })).filter((s) => !FLEX_SLOTS.has(s.slot)),
    ...startingSlots.map((slot, i) => ({ slot, i })).filter((s) => FLEX_SLOTS.has(s.slot)),
  ];

  const assigned = new Map(); // slotIndex -> player
  const used = new Set();
  for (const { slot, i } of ordered) {
    let pick = null;
    for (const p of pool) {
      if (used.has(p.playerId)) continue;
      if (slotEligible(slot, p.positions)) { pick = p; break; }
    }
    if (pick) {
      assigned.set(i, pick);
      used.add(pick.playerId);
    }
  }

  // Rebuild in roster_positions order for display.
  const starters = startingSlots.map((slot, i) => ({ slot, player: assigned.get(i) || null }));
  const bench = players
    .filter((p) => !used.has(p.playerId))
    .sort((a, b) => rankOf(a) - rankOf(b));
  const unfilled = starters.filter((s) => !s.player).map((s) => s.slot);

  return { starters, bench, unfilled };
}

// Pair the players entering a lineup with the ones they displace.
//
// Naively pairing "best player coming in" with "worst player going out" produces
// nonsense across positions: it will tell you to start a tight end over a running
// back and quote a points gap between two players who never compete for the same
// slot. Pair on shared position eligibility first, so each suggestion names the
// player actually being replaced.
//
// bringIn / sitDown are already sorted best-first and worst-first respectively.
export function pairLineupChanges(bringIn, sitDown) {
  const remaining = sitDown.slice();
  const pairs = [];
  for (const inP of bringIn) {
    let idx = remaining.findIndex((o) => o.positions?.some((pos) => inP.positions?.includes(pos)));
    if (idx === -1) idx = remaining.length ? 0 : -1; // else the worst player still starting
    pairs.push({ inP, outP: idx >= 0 ? remaining.splice(idx, 1)[0] : null });
  }
  return pairs;
}
