// Pickup upgrades: which available players would make your starting lineup, who they
// bump out (including chain effects through FLEX), and who to drop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPickupUpgrades, dropCandidate, weeklyRankOf } from '../js/lib/lineup.js';

const P = (id, pos, rank, extra = {}) => ({
  playerId: id, name: id, positions: [pos], rank, startable: true, questionable: false, ...extra,
});
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'FLEX', 'BN', 'BN', 'BN'];

const roster = [
  P('qb1', 'QB', 10),
  P('rb1', 'RB', 5), P('rb2', 'RB', 40),
  P('wr1', 'WR', 8), P('wr2', 'WR', 30), P('wr3', 'WR', 60),
  P('te1', 'TE', 90), P('rb3', 'RB', 150),
];

test('a free agent who would start is found, with the starter who actually drops out', () => {
  // A RB ranked 20 takes RB2; rb2 (40) slides to FLEX and bumps wr3 (60) out of FLEX.
  const res = findPickupUpgrades(roster, [P('fa_rb', 'RB', 20)], SLOTS);
  assert.equal(res.length, 1);
  assert.equal(res[0].player.playerId, 'fa_rb');
  assert.equal(res[0].slot, 'RB');
  assert.equal(res[0].displaced.playerId, 'wr3', 'chain effect: the FLEX WR is the one benched');
  assert.equal(res[0].gain, 40);
});

test('players who would not crack the lineup, or cannot play, are ignored', () => {
  const res = findPickupUpgrades(roster, [
    P('fa_bad', 'WR', 200),
    P('fa_out', 'WR', 1, { startable: false, reason: 'Out' }),
    P('fa_qb2', 'QB', 15), // worse than qb1 and no SUPER_FLEX
  ], SLOTS);
  assert.deepEqual(res, []);
});

test('superflex: a QB can be an upgrade over a flex skill player', () => {
  const sf = ['QB', 'RB', 'WR', 'SUPER_FLEX', 'BN'];
  const r = [P('qb1', 'QB', 10), P('rb1', 'RB', 5), P('wr1', 'WR', 8), P('wr2', 'WR', 70)];
  const res = findPickupUpgrades(r, [P('fa_qb', 'QB', 25)], sf);
  assert.equal(res[0]?.slot, 'SUPER_FLEX');
  assert.equal(res[0].displaced.playerId, 'wr2');
});

test('an empty starting slot is the biggest upgrade of all', () => {
  const r = [P('qb1', 'QB', 10), P('rb1', 'RB', 5)];
  const res = findPickupUpgrades(r, [P('fa_wr', 'WR', 120), P('fa_rb', 'RB', 3)], ['QB', 'RB', 'WR', 'BN']);
  assert.equal(res[0].player.playerId, 'fa_wr');
  assert.equal(res[0].displaced, null);
});

test('weekly mode ranks by projection and reports the points gained', () => {
  const W = (id, pos, rank, proj) => P(id, pos, rank, { weekly: { rank, proj } });
  const r = [W('qb1', 'QB', 3, 22), W('rb1', 'RB', 10, 15), W('rb2', 'RB', 30, 9), W('wr1', 'WR', 12, 14), W('wr2', 'WR', 40, 8), W('wr3', 'WR', 55, 6.5)];
  const gainOf = (fa, out) => (out ? (fa.weekly?.proj ?? 0) - (out.weekly?.proj ?? 0) : Infinity);
  const res = findPickupUpgrades(r, [W('fa1', 'WR', 20, 12.5), W('fa2', 'RB', 25, 10)], SLOTS, { rankOf: weeklyRankOf, gainOf });
  assert.deepEqual(res.map((x) => [x.player.playerId, x.displaced.playerId, x.gain]), [['fa1', 'wr3', 6], ['fa2', 'wr3', 3.5]]);
});

test('drop candidate is the lowest season-ranked bench player, never IR/taxi', () => {
  const [best] = findPickupUpgrades(roster, [P('fa_rb', 'RB', 20)], SLOTS);
  assert.equal(dropCandidate(best.lineup).playerId, 'rb3');
  assert.equal(dropCandidate(best.lineup, new Set(['rb3'])).playerId, 'te1');
  const unranked = { ...best.lineup, bench: [...best.lineup.bench, P('mystery', 'WR', null)] };
  assert.equal(dropCandidate(unranked).playerId, 'mystery', 'unranked counts as worst');
});
