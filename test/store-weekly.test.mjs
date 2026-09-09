// Weekly set resolution in the store: which league gets which set, what happens on
// delete, and the isolation guarantee that weekly rankings never reach other views.
//
// The store degrades gracefully without localStorage or IndexedDB, so it runs
// in-memory here exactly as it would in a browser with storage blocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getState, setSettings, updateMap,
  addWeeklySet, addWeeklyFile, deleteWeeklySet, getWeeklySets, getWeeklySetById,
  setWeeklyDefault, resolveWeeklyForLeague, resolveRankingForLeague,
  removeWeeklyFile, exportBackup, importBackup, clearAllData, WEEKLY_NONE,
} from '../js/store.js';

const rows = (n, base = 20) => Array.from({ length: n }, (_, i) => ({
  name: `Player ${i}`, pos: 'RB', team: 'DET', proj: base - i * 0.1,
}));

async function reset() {
  await clearAllData();
}

test('the first set created becomes the default automatically', async () => {
  await reset();
  const set = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  assert.equal(getState().settings.weeklyDefaultId, set.id);
  const r = resolveWeeklyForLeague('L1');
  assert.equal(r.name, 'Half PPR');
  assert.equal(r.source, 'default');
  assert.equal(r.week, 1);
  assert.equal(r.rows.length, 5);
});

test('the default applies to every league until one is overridden', async () => {
  await reset();
  const def = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  const special = await addWeeklySet({ name: 'Full PPR TE Premium', file: { label: 'RB/TE/WR', rows: rows(3), week: 1 } });
  assert.equal(getState().settings.weeklyDefaultId, def.id); // second set does not steal the default

  assert.equal(resolveWeeklyForLeague('L1').name, 'Half PPR');
  assert.equal(resolveWeeklyForLeague('L2').name, 'Half PPR');

  updateMap('weeklyAssignments', 'L2', special.id);
  assert.equal(resolveWeeklyForLeague('L1').name, 'Half PPR');       // untouched
  assert.equal(resolveWeeklyForLeague('L2').name, 'Full PPR TE Premium');
  assert.equal(resolveWeeklyForLeague('L2').source, 'league');
});

test('a league can opt out of weekly rankings entirely', async () => {
  await reset();
  await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  updateMap('weeklyAssignments', 'L3', WEEKLY_NONE);
  assert.equal(resolveWeeklyForLeague('L3'), null);
  assert.notEqual(resolveWeeklyForLeague('L1'), null); // siblings unaffected
});

test('no sets means no weekly rankings, and the Lineup tab falls back', async () => {
  await reset();
  assert.equal(resolveWeeklyForLeague('L1'), null);
});

test('a set with every file removed resolves to null rather than an empty lineup', async () => {
  await reset();
  const set = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  await removeWeeklyFile(set.id, getWeeklySetById(set.id).files[0].id);
  assert.equal(resolveWeeklyForLeague('L1'), null);
});

test('adding a second file merges both position groups into one ranking', async () => {
  await reset();
  const set = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5, 20), week: 1 } });
  await addWeeklyFile(set.id, { label: 'QB', rows: [{ name: 'A QB', pos: 'QB', team: 'LAC', proj: 25 }], week: 1 });
  const r = resolveWeeklyForLeague('L1');
  assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].name, 'A QB'); // 25 projected outranks everything in the flex file
  assert.equal(r.rows[0].rank, 1);
});

test('re-uploading the same file label replaces it', async () => {
  await reset();
  const set = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  await addWeeklyFile(set.id, { label: 'RB/TE/WR', rows: rows(2), week: 2 });
  assert.equal(getWeeklySetById(set.id).files.length, 1);
  assert.equal(resolveWeeklyForLeague('L1').rows.length, 2);
  assert.equal(resolveWeeklyForLeague('L1').week, 2);
});

test('deleting a set clears the default and any assignments pointing at it', async () => {
  await reset();
  const a = await addWeeklySet({ name: 'A', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  const b = await addWeeklySet({ name: 'B', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  updateMap('weeklyAssignments', 'L2', b.id);
  updateMap('weeklyAssignments', 'L3', a.id);

  await deleteWeeklySet(b.id);
  assert.equal(getState().settings.weeklyAssignments.L2, undefined); // dangling assignment cleared
  assert.equal(getState().settings.weeklyAssignments.L3, a.id);      // sibling untouched
  assert.equal(resolveWeeklyForLeague('L2').name, 'A');              // falls back to the default

  await deleteWeeklySet(a.id);
  assert.equal(getState().settings.weeklyDefaultId, '');
  assert.equal(resolveWeeklyForLeague('L1'), null);
});

test('setWeeklyDefault switches which set every un-overridden league uses', async () => {
  await reset();
  await addWeeklySet({ name: 'A', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  const b = await addWeeklySet({ name: 'B', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  setWeeklyDefault(b.id);
  assert.equal(resolveWeeklyForLeague('L1').name, 'B');
});

// --- the isolation guarantee ---

test('weekly rankings never leak into the season ranking used by other views', async () => {
  await reset();
  // A league with a weekly set but no ranking profile and no legacy rankings.
  await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  assert.notEqual(resolveWeeklyForLeague('L1'), null);
  // Free Agents, Trade Finder, Draft, Targets and the waiver companion all read this.
  assert.equal(resolveRankingForLeague('L1'), null);

  // And with a legacy season ranking present, that is still what they get.
  setSettings({ legacyRankings: { dynasty: null, redraft: { rows: [{ rank: 1, name: 'Season Guy' }], uploadedAt: 1 } } });
  const season = resolveRankingForLeague('L1');
  assert.equal(season.source, 'legacy');
  assert.equal(season.rows[0].name, 'Season Guy');
});

// --- backup ---

test('backup round-trips weekly sets and their assignments', async () => {
  await reset();
  const set = await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  updateMap('weeklyAssignments', 'L2', WEEKLY_NONE);
  const backup = JSON.parse(JSON.stringify(exportBackup()));

  await clearAllData();
  assert.equal(getWeeklySets().length, 0);

  await importBackup(backup);
  assert.equal(getWeeklySets().length, 1);
  assert.equal(getState().settings.weeklyDefaultId, set.id);
  assert.equal(resolveWeeklyForLeague('L1').name, 'Half PPR');
  assert.equal(resolveWeeklyForLeague('L2'), null); // opt-out survived
});

test('restoring a backup made before this feature works and adds no sets', async () => {
  await reset();
  const old = { app: 'ffcc', kind: 'backup', version: 1, settings: { username: 'bob' }, profiles: [] };
  await importBackup(old);
  assert.equal(getWeeklySets().length, 0);
  assert.equal(getState().settings.username, 'bob');
  assert.equal(getState().settings.weeklyDefaultId, ''); // default filled in from defaults
  assert.equal(resolveWeeklyForLeague('L1'), null);
});

test('clear all data removes weekly sets', async () => {
  await addWeeklySet({ name: 'Half PPR', file: { label: 'RB/TE/WR', rows: rows(5), week: 1 } });
  await clearAllData();
  assert.equal(getWeeklySets().length, 0);
  assert.equal(getState().settings.weeklyDefaultId, '');
});
