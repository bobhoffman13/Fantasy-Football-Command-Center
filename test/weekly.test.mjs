// Weekly rankings: parsing, merging, and the lineup ordering they produce.
// Run with: node --test test/
//
// Fixtures are the real exported files: a flex file (RB/WR/TE) and a quarterback
// file, both for week 1. Each file restarts its own Rank column at 1, which is the
// central hazard this feature has to handle correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseWeeklyRankingsCsv, parseRankingsCsv } from '../js/lib/csv.js';
import { mergeWeeklySet, weeklySetUpdatedAt } from '../js/lib/weekly.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');

const FLEX = fixture('flex-week1-half.csv');
const QB = fixture('qb-week1-half.csv');

// --- parsing ---

test('parses the flex file: rows, week, positions, projections', () => {
  const r = parseWeeklyRankingsCsv(FLEX);
  assert.equal(r.error, null);
  assert.equal(r.rows.length, 220);
  assert.equal(r.week, 1);
  assert.deepEqual(r.positions, ['RB', 'TE', 'WR']);

  const gibbs = r.rows.find((x) => x.name === 'Jahmyr Gibbs');
  assert.equal(gibbs.proj, 24.8);
  assert.equal(gibbs.pos, 'RB');
  assert.equal(gibbs.team, 'DET');       // from the "Team Abbrev" header
  assert.equal(gibbs.opponent, 'NO');
  assert.equal(gibbs.oppRankVsPos, 20);
  assert.equal(gibbs.impliedTotal, 28.25);
});

test('parses the quarterback file', () => {
  const r = parseWeeklyRankingsCsv(QB);
  assert.equal(r.error, null);
  assert.equal(r.rows.length, 32);
  assert.equal(r.week, 1);
  assert.deepEqual(r.positions, ['QB']);
  assert.equal(r.rows.find((x) => x.name === 'Justin Herbert').proj, 23.2);
});

test('placeholder dashes become null rather than zero', () => {
  // Snap share and last-week points are "-" in a week 1 file. Zero would be a lie:
  // it would read as "played no snaps" instead of "not measured yet".
  const gibbs = parseWeeklyRankingsCsv(FLEX).rows.find((x) => x.name === 'Jahmyr Gibbs');
  assert.equal(gibbs.snapShare, null);
  assert.equal(gibbs.lastWeekPoints, null);
});

test('a file without projections is rejected with an actionable message', () => {
  const csv = 'Rank,Player,Position\n1,Some Guy,RB\n';
  const r = parseWeeklyRankingsCsv(csv);
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /projected points/i);
});

test('season parser still works and now reads "Team Abbrev"', () => {
  const csv = 'Rank,Player,Team Abbrev,Position\n1,Jahmyr Gibbs,DET,RB\n2,Bijan Robinson,ATL,RB\n';
  const r = parseRankingsCsv(csv);
  assert.equal(r.error, null);
  assert.equal(r.rows[0].team, 'DET');
  assert.equal(r.rows[0].rank, 1);
});

// --- merging: the per-file Rank collision ---

function buildSet() {
  const flex = parseWeeklyRankingsCsv(FLEX);
  const qb = parseWeeklyRankingsCsv(QB);
  return {
    id: 'w1',
    name: 'Half PPR',
    files: [
      { id: 'f1', label: 'RB/TE/WR', rows: flex.rows, week: flex.week, uploadedAt: 1000 },
      { id: 'f2', label: 'QB', rows: qb.rows, week: qb.week, uploadedAt: 2000 },
    ],
  };
}

test('merging keeps every player from both files', () => {
  const m = mergeWeeklySet(buildSet());
  assert.equal(m.rows.length, 252); // 220 flex + 32 quarterbacks
  assert.equal(m.week, 1);
  assert.equal(m.mixedWeeks, null);
  assert.deepEqual(m.countsByPosition, { RB: 80, WR: 100, TE: 40, QB: 32 });
});

test('the two "rank 1" players from different files get distinct overall ranks', () => {
  // This is the whole point. Gibbs is rank 1 of the flex file at 24.8 projected and
  // Herbert is rank 1 of the quarterback file at 23.2. Trusting either file's own
  // Rank column would tie them and make every FLEX and SUPER_FLEX pick a coin flip.
  const m = mergeWeeklySet(buildSet());
  const gibbs = m.rows.find((r) => r.name === 'Jahmyr Gibbs');
  const herbert = m.rows.find((r) => r.name === 'Justin Herbert');
  assert.equal(gibbs.rank, 1);
  assert.equal(herbert.rank, 2);   // 23.2 projected, immediately behind Gibbs at 24.8
  assert.notEqual(gibbs.rank, herbert.rank);
  assert.ok(gibbs.proj > herbert.proj);
});

test('overall rank is strictly ordered by projection, descending', () => {
  const m = mergeWeeklySet(buildSet());
  for (let i = 1; i < m.rows.length; i++) {
    assert.ok(m.rows[i - 1].proj >= m.rows[i].proj, `row ${i} out of order`);
    assert.equal(m.rows[i].rank, i + 1);
  }
});

test('positional rank restarts per position', () => {
  const m = mergeWeeklySet(buildSet());
  const topBy = (pos) => m.rows.filter((r) => r.pos === pos).sort((a, b) => a.posRank - b.posRank)[0];
  assert.equal(topBy('RB').name, 'Jahmyr Gibbs');
  assert.equal(topBy('QB').name, 'Justin Herbert');
  assert.equal(topBy('QB').posRank, 1);
  assert.equal(topBy('TE').name, 'Brock Bowers');
  // Every position numbers from 1 with no gaps.
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const ranks = m.rows.filter((r) => r.pos === pos).map((r) => r.posRank).sort((a, b) => a - b);
    assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
  }
});

test('re-uploading a file replaces its rows instead of duplicating them', () => {
  const set = buildSet();
  const flex = parseWeeklyRankingsCsv(FLEX);
  // Same label, later timestamp, one row trimmed off — simulates next week's file.
  set.files = set.files.filter((f) => f.label !== 'RB/TE/WR');
  set.files.push({ id: 'f3', label: 'RB/TE/WR', rows: flex.rows.slice(0, 100), week: 2, uploadedAt: 3000 });
  const m = mergeWeeklySet(set);
  assert.equal(m.rows.length, 132); // 100 flex + 32 quarterbacks, no duplicates
});

test('mixed weeks across files are reported so the UI can warn', () => {
  const set = buildSet();
  set.files[1] = { ...set.files[1], week: 2 };
  const m = mergeWeeklySet(set);
  assert.deepEqual(m.mixedWeeks, [1, 2]);
});

test('name suffixes collapse so one player cannot appear twice', () => {
  const set = {
    id: 'x',
    files: [
      { id: 'a', label: 'A', week: 1, uploadedAt: 1, rows: [{ name: 'Kenneth Walker III', pos: 'RB', proj: 12 }] },
      { id: 'b', label: 'B', week: 1, uploadedAt: 2, rows: [{ name: 'Kenneth Walker', pos: 'RB', proj: 15 }] },
    ],
  };
  const m = mergeWeeklySet(set);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].proj, 15); // the later file wins
});

test('weeklySetUpdatedAt reports the newest file', () => {
  assert.equal(weeklySetUpdatedAt(buildSet()), 2000);
});
