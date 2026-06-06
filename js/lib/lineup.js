// Lineup optimizer + startability logic.

import { FLEX_ELIGIBILITY, FLEX_SLOTS, NON_STARTING_SLOTS, HARD_OUT_STATUSES } from '../data/constants.js';

const UNRANKED = 100000; // sentinel so unranked players sort last but remain usable

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

function rankOf(p) {
  return p.rank == null ? UNRANKED : p.rank;
}

// players: [{ playerId, name, positions:[], rank, injuryStatus, byeWeek, onBye, startable, questionable }]
// rosterPositions: array from league (e.g. ["QB","RB","RB","WR","FLEX","K","DEF","BN","BN"])
export function optimizeLineup(players, rosterPositions) {
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
