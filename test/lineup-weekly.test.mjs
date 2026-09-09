// The lineup side of weekly rankings: matching projections onto Sleeper player ids,
// ordering the optimizer by them, and reporting roster coverage honestly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseWeeklyRankingsCsv } from '../js/lib/csv.js';
import { mergeWeeklySet } from '../js/lib/weekly.js';
import { buildRankingLookup } from '../js/lib/match.js';
import { optimizeLineup, weeklyRankOf, evaluateStartability } from '../js/lib/lineup.js';
import { enrichRoster, weeklyRosterCoverage } from '../js/lib/players.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');

function mergedRows() {
  const flex = parseWeeklyRankingsCsv(fixture('flex-week1-half.csv'));
  const qb = parseWeeklyRankingsCsv(fixture('qb-week1-half.csv'));
  return mergeWeeklySet({
    id: 'w1',
    files: [
      { id: 'f1', label: 'RB/TE/WR', rows: flex.rows, week: flex.week, uploadedAt: 1 },
      { id: 'f2', label: 'QB', rows: qb.rows, week: qb.week, uploadedAt: 2 },
    ],
  }).rows;
}

// A miniature Sleeper player map covering a plausible roster, including the two
// name shapes that historically break matching: a suffix ("Kenneth Walker III" in
// Sleeper versus "Kenneth Walker" in the file) and a team defense.
const PLAYERS = {
  '1': { full_name: 'Jahmyr Gibbs', fantasy_positions: ['RB'], team: 'DET', active: true },
  '2': { full_name: 'Justin Herbert', fantasy_positions: ['QB'], team: 'LAC', active: true },
  '3': { full_name: 'Kenneth Walker III', fantasy_positions: ['RB'], team: 'KC', active: true },
  '4': { full_name: 'Puka Nacua', fantasy_positions: ['WR'], team: 'LAR', active: true },
  '5': { full_name: 'Brock Bowers', fantasy_positions: ['TE'], team: 'LV', active: true },
  '6': { full_name: 'Lamar Jackson', fantasy_positions: ['QB'], team: 'BAL', active: true },
  '7': { full_name: 'Ted Hurst', fantasy_positions: ['WR'], team: 'TB', active: true },
  '8': { full_name: 'Chase McLaughlin', fantasy_positions: ['K'], team: 'TB', active: true },
  'BUF': { full_name: 'Buffalo Bills', fantasy_positions: ['DEF'], team: 'BUF', active: true },
  // A same-name decoy: an offensive lineman who must not steal the quarterback's projection.
  '99': { full_name: 'Justin Herbert', fantasy_positions: ['OL'], team: 'NYJ', active: true },
};

function lookup() {
  return buildRankingLookup(mergedRows(), PLAYERS).byPlayerId;
}

test('projections match onto Sleeper ids, including a suffixed name', () => {
  const by = lookup();
  assert.equal(by.get('1').proj, 24.8);              // Jahmyr Gibbs
  assert.equal(by.get('3').proj, 16.6);              // "Kenneth Walker" -> Kenneth Walker III
  assert.equal(by.get('5').posRank, 1);              // Brock Bowers is the TE1
});

test('position disambiguates two players sharing a name', () => {
  const by = lookup();
  assert.equal(by.get('2').proj, 23.2);   // the quarterback gets the projection
  assert.equal(by.get('99'), undefined);  // the offensive lineman gets nothing
});

test('kickers and defenses are simply absent from a weekly file', () => {
  const by = lookup();
  assert.equal(by.get('8'), undefined);
  assert.equal(by.get('BUF'), undefined);
});

// --- ordering ---

const NFL = { display_week: 1, season: '2026', season_type: 'regular' };

function roster(ids) {
  return enrichRoster(ids, PLAYERS, new Map(), NFL, 'warn', lookup());
}

test('SUPER_FLEX weighs a quarterback against a running back by projection', () => {
  // Gibbs 24.8 beats Herbert 23.2, so the RB slot takes Gibbs and SUPER_FLEX takes
  // the quarterback. Under each file's own Rank column both are "1" and this is a
  // coin flip.
  const players = roster(['1', '2', '4']);
  const { starters } = optimizeLineup(players, ['RB', 'SUPER_FLEX', 'BN'], { rankOf: weeklyRankOf });
  const bySlot = Object.fromEntries(starters.map((s) => [s.slot, s.player?.name]));
  assert.equal(bySlot.RB, 'Jahmyr Gibbs');
  assert.equal(bySlot.SUPER_FLEX, 'Justin Herbert');
});

test('FLEX picks the best projection across RB, WR and TE', () => {
  const players = roster(['3', '4', '5']); // Walker 16.6, Nacua 16.7, Bowers 12.8
  const { starters } = optimizeLineup(players, ['FLEX', 'BN', 'BN'], { rankOf: weeklyRankOf });
  assert.equal(starters[0].player.name, 'Puka Nacua');
});

test('weekly ordering can differ from season ordering', () => {
  // Season rankings say Bowers is the better player; this week's projections say
  // Nacua. With weekly active the lineup must follow the week.
  const season = new Map([['5', { rank: 5 }], ['4', { rank: 40 }]]);
  const players = enrichRoster(['4', '5'], PLAYERS, season, NFL, 'warn', lookup());
  const flexOnly = ['FLEX', 'BN'];
  assert.equal(optimizeLineup(players, flexOnly)[('starters')][0].player.name, 'Brock Bowers');
  assert.equal(optimizeLineup(players, flexOnly, { rankOf: weeklyRankOf }).starters[0].player.name, 'Puka Nacua');
});

test('an unprojected kicker still fills the K slot', () => {
  const players = roster(['1', '8']);
  const { starters, unfilled } = optimizeLineup(players, ['RB', 'K'], { rankOf: weeklyRankOf });
  assert.deepEqual(unfilled, []);
  assert.equal(starters.find((s) => s.slot === 'K').player.name, 'Chase McLaughlin');
});

test('unprojected players fall behind projected ones but keep season order', () => {
  // Two receivers with no weekly projection: the better season rank still wins,
  // rather than the order they happen to sit in on the roster.
  const season = new Map([['8', { rank: 200 }], ['BUF', { rank: 100 }]]);
  const players = enrichRoster(['8', 'BUF'], PLAYERS, season, NFL, 'warn', lookup());
  assert.ok(weeklyRankOf(players[1]) < weeklyRankOf(players[0]));
  // And both sit behind anyone who does have a projection.
  const gibbs = roster(['1'])[0];
  assert.ok(weeklyRankOf(gibbs) < weeklyRankOf(players[1]));
});

test('injury and bye rules still apply on top of weekly projections', () => {
  const map = { ...PLAYERS, '1': { ...PLAYERS['1'], injury_status: 'Out' } };
  const players = enrichRoster(['1', '3'], map, new Map(), NFL, 'warn', lookup());
  const { starters } = optimizeLineup(players, ['RB', 'BN'], { rankOf: weeklyRankOf });
  // Gibbs has the best projection on the board but is Out, so Walker starts.
  assert.equal(starters[0].player.name, 'Kenneth Walker III');
  assert.equal(evaluateStartability({ injuryStatus: 'Out' }, 'warn').startable, false);
});

// --- coverage ---

test('roster coverage counts your players, not the file', () => {
  const by = lookup();
  const cov = weeklyRosterCoverage(['1', '2', '8', 'BUF'], by, PLAYERS);
  assert.equal(cov.total, 4);
  assert.equal(cov.covered, 2);
  assert.deepEqual(cov.missing.map((m) => m.name), ['Chase McLaughlin', 'Buffalo Bills']);
});

test('coverage is the right metric: the file-wide match rate looks alarming but is fine', () => {
  // 252 rows league-wide, only a handful of which are on this roster. The season
  // diagnostic would report a terrible match rate for a perfectly good file.
  const { diagnostic } = buildRankingLookup(mergedRows(), PLAYERS);
  assert.ok(diagnostic.rate < 0.1, 'file-wide rate is low by construction');
  const cov = weeklyRosterCoverage(['1', '2', '4', '5'], lookup(), PLAYERS);
  assert.equal(cov.rate, 1); // every rostered player is projected
});

// --- pairing changes to the current lineup ---

test('changes pair on position, not on rank order', async () => {
  const { pairLineupChanges } = await import('../js/lib/lineup.js');
  // Coming in: a running back and a tight end. Going out: a tight end and a
  // running back. Rank-order pairing would cross them and quote a meaningless gap.
  const bringIn = [
    { name: 'Gibbs', positions: ['RB'] },
    { name: 'Bowers', positions: ['TE'] },
  ];
  const sitDown = [
    { name: 'Otton', positions: ['TE'] },
    { name: 'Dowdle', positions: ['RB'] },
  ];
  const pairs = pairLineupChanges(bringIn, sitDown);
  assert.deepEqual(pairs.map((p) => [p.inP.name, p.outP.name]),
    [['Gibbs', 'Dowdle'], ['Bowers', 'Otton']]);
});

test('a multi-position player pairs on any shared position', async () => {
  const { pairLineupChanges } = await import('../js/lib/lineup.js');
  const pairs = pairLineupChanges(
    [{ name: 'Flex Guy', positions: ['RB', 'WR'] }],
    [{ name: 'A Receiver', positions: ['WR'] }],
  );
  assert.equal(pairs[0].outP.name, 'A Receiver');
});

test('with no position match, the worst player still starting is displaced', async () => {
  const { pairLineupChanges } = await import('../js/lib/lineup.js');
  const pairs = pairLineupChanges(
    [{ name: 'A Kicker', positions: ['K'] }],
    [{ name: 'Worst', positions: ['WR'] }, { name: 'Better', positions: ['WR'] }],
  );
  assert.equal(pairs[0].outP.name, 'Worst');
});

test('more players coming in than going out leaves an empty-slot fill', async () => {
  const { pairLineupChanges } = await import('../js/lib/lineup.js');
  const pairs = pairLineupChanges(
    [{ name: 'A', positions: ['RB'] }, { name: 'B', positions: ['RB'] }],
    [{ name: 'Only', positions: ['RB'] }],
  );
  assert.equal(pairs[0].outP.name, 'Only');
  assert.equal(pairs[1].outP, null);
});
