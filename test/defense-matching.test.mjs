// Team defenses: ranking files say "Chiefs" (often with no position column); Sleeper
// stores the defense as id "KC" named "Kansas City Chiefs". Uses the real exported file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWeeklyRankingsCsv, parseRankingsCsv } from '../js/lib/csv.js';
import { buildRankingLookup, matchName, buildPlayerIndex } from '../js/lib/match.js';
import { mergeWeeklySet } from '../js/lib/weekly.js';
import { NFL_TEAMS, teamFromDefenseName } from '../js/lib/teams.js';

// Sleeper's shape for defenses: id = abbreviation, no full_name, city/nickname split.
const sleeperPlayers = {};
for (const [abbr, [city, nick]] of Object.entries(NFL_TEAMS)) {
  sleeperPlayers[abbr] = { player_id: abbr, first_name: city, last_name: nick, team: abbr, position: 'DEF', fantasy_positions: ['DEF'], active: true };
}
// Humans whose names could collide with a careless matcher.
sleeperPlayers['9001'] = { player_id: '9001', full_name: 'Jalen Chiefs', first_name: 'Jalen', last_name: 'Chiefs', position: 'WR', fantasy_positions: ['WR'], team: 'KC', active: true };
sleeperPlayers['4046'] = { player_id: '4046', full_name: 'Patrick Mahomes', position: 'QB', fantasy_positions: ['QB'], team: 'KC', active: true };

const csv = readFileSync(new URL('./fixtures/dst-week12-half.csv', import.meta.url), 'utf8');

test('the real DST file parses as defenses for week 12', () => {
  const parsed = parseWeeklyRankingsCsv(csv);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows.length, 26);
  assert.equal(parsed.week, 12);
  assert.deepEqual(parsed.positions, ['DEF'], 'labels the file DEF instead of by filename');
  assert.equal(parsed.rows[0].team, 'KC');
});

test('every defense in the file matches its Sleeper team defense', () => {
  const parsed = parseWeeklyRankingsCsv(csv);
  const { byPlayerId, diagnostic } = buildRankingLookup(parsed.rows, sleeperPlayers);
  assert.equal(diagnostic.matched, 26, `unmatched: ${diagnostic.unmatched.join(', ')}`);
  assert.equal(byPlayerId.get('KC').proj, 9.3);
  assert.equal(byPlayerId.get('SF').name, '49ers');
  assert.ok(!byPlayerId.has('9001'), 'never lands on a human');
});

test('defense name variants and alternate abbreviations', () => {
  const index = buildPlayerIndex(sleeperPlayers);
  const cases = [
    ['Chiefs', '', ''], ['Kansas City Chiefs', '', ''], ['Chiefs D/ST', '', ''], ['Chiefs DST', '', ''],
    ['KC Defense', '', ''], ['Kansas City', 'DEF', 'KC'], ['Jaguars', 'DST', 'JAC'], ['Washington Football Team', '', ''],
    ['Rams', 'D/ST', 'LA'], ['49ers D/ST', '', ''], ['NY Jets', '', ''], ['KC Chiefs', '', ''],
  ];
  const expected = ['KC', 'KC', 'KC', 'KC', 'KC', 'KC', 'JAX', 'WAS', 'LAR', 'SF', 'NYJ', 'KC'];
  cases.forEach(([name, pos, team], i) => assert.equal(matchName({ name, pos, team }, index), expected[i], name));
  // People are untouched.
  assert.equal(matchName({ name: 'Patrick Mahomes', pos: 'QB' }, index), '4046');
  assert.equal(matchName({ name: 'Jalen Chiefs', pos: 'WR' }, index), '9001');
  assert.equal(teamFromDefenseName('Patrick Mahomes'), '');
});

test('season ranking files tag nickname-only rows as DEF too', () => {
  const parsed = parseRankingsCsv('Rank,Player\n1,Josh Allen\n150,Steelers D/ST\n151,Bills\n');
  assert.deepEqual(parsed.rows.map((r) => r.pos), ['', 'DEF', 'DEF']);
});

test('files uploaded before the fix are repaired when the set is merged', () => {
  // Stored rows from the old parser: no position, no inference.
  const old = parseWeeklyRankingsCsv(csv).rows.map((r) => ({ ...r, pos: '' }));
  const merged = mergeWeeklySet({ files: [{ id: 'f1', label: 'DST-weekly-half-rankings_6', rows: old, week: 12, uploadedAt: 1 }] });
  assert.ok(merged.rows.every((r) => r.pos === 'DEF'));
  assert.equal(merged.rows.find((r) => r.name === 'Chiefs').posRank, 1);
  // Re-uploading the same file later replaces rows instead of duplicating them.
  const again = mergeWeeklySet({ files: [
    { id: 'f1', label: 'old', rows: old, week: 12, uploadedAt: 1 },
    { id: 'f2', label: 'DEF', rows: parseWeeklyRankingsCsv(csv).rows, week: 12, uploadedAt: 2 },
  ] });
  assert.equal(again.rows.length, 26);
});

test('a person whose surname is a nickname is never mistaken for a defense', () => {
  const parsed = parseRankingsCsv('Rank,Player\n1,Jalen Chiefs\n2,Chiefs\n');
  assert.deepEqual(parsed.rows.map((r) => r.pos), ['', 'DEF']);
  const { byPlayerId } = buildRankingLookup(parsed.rows, sleeperPlayers);
  assert.equal(byPlayerId.get('9001')?.rank, 1);
  assert.equal(byPlayerId.get('KC')?.rank, 2);
});

import { clearAllData, addWeeklySet, addWeeklyFile, getWeeklySetById } from '../js/store.js';

test('next week’s DEF upload replaces a file stored under its old filename label', async () => {
  await clearAllData();
  const oldRows = parseWeeklyRankingsCsv(csv).rows.map((r) => ({ ...r, pos: '' })); // pre-fix storage
  const set = await addWeeklySet({ name: 'Half', file: { label: 'QB', rows: [{ name: 'Josh Allen', pos: 'QB', proj: 24 }], week: 12 } });
  await addWeeklyFile(set.id, { label: 'DST-weekly-half-rankings_6', rows: oldRows, week: 12 });
  const next = parseWeeklyRankingsCsv(csv.replace(/,12,/g, ',13,'));
  await addWeeklyFile(set.id, { label: next.positions.join('/'), rows: next.rows, week: next.week });
  const files = getWeeklySetById(set.id).files;
  assert.deepEqual(files.map((f) => f.label).sort(), ['DEF', 'QB']);
  assert.equal(files.find((f) => f.label === 'DEF').week, 13);
});
