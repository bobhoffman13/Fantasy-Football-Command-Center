// Central observable store.
//
// Design notes addressing prior-build pitfalls:
// - Nested maps (leagueTypes, assignments, thresholds, dues, lastSeen) are ALWAYS
//   updated through updateMap(), an immutable single-key add/update/delete. This makes
//   multi-league assignment additive by construction (assigning one league cannot wipe
//   siblings) and makes deletion unambiguous. (Pitfall #1)
// - Subscriptions are CHANNEL-SCOPED: a poll result that touches the 'activity' channel
//   never notifies 'settings' subscribers, so unrelated screens don't re-render. (#4)
// - Settings persist to localStorage; ranking profiles + player cache live in IndexedDB.

import { idbGet, idbSet, idbClearAll } from './lib/idb.js';
import { mergeWeeklySet, weeklySetUpdatedAt } from './lib/weekly.js';
import { SEASON_FALLBACK, SNOOZE_DAYS, SNOOZE_LIMIT, SNOOZE_FORGET_DAYS } from './data/constants.js';

const SETTINGS_KEY = 'ffcc:settings';
const PROFILES_IDB_KEY = 'profiles';
const WEEKLY_IDB_KEY = 'weeklyRankings';

function defaultSettings() {
  return {
    username: '',
    userId: '',
    season: SEASON_FALLBACK,
    leagueTypes: {},      // leagueId -> 'dynasty' | 'redraft'
    commishFlags: {},     // leagueId -> true
    assignments: {},      // leagueId -> profileId
    thresholds: {},       // leagueId -> number (waiver alert rank)
    riskMode: 'warn',     // 'start' | 'warn' | 'sit'
    globalLeagueId: '',   // the app-wide "active league" driving every league page
    lastLeagueByView: {}, // viewId -> leagueId
    notifCreds: { pushoverToken: '', pushoverUser: '' },
    duesByLeague: {},     // leagueId -> { amount, paid: { userId: bool } }
    lastSeen: {},         // leagueId -> timestamp
    legacyRankings: { dynasty: null, redraft: null }, // { rows, uploadedAt }
    interestPlayers: [],  // Sleeper player IDs to watch (availability + trade targets)
    forSale: [],          // your player IDs flagged willing-to-sell (prioritized in trade recs)
    snoozes: {},          // leagueId -> { actionKey: { n, until } } for the Home action plan
    weeklyDefaultId: '',  // weekly ranking set applied to every league by default
    weeklyAssignments: {}, // leagueId -> setId, or WEEKLY_NONE to opt one league out
  };
}

const state = {
  settings: defaultSettings(),
  profiles: [],            // [{ id, name, type, rows, uploadedAt }]
  weeklySets: [],          // [{ id, name, files: [{ id, label, week, rows, uploadedAt }] }]
  session: {
    leagues: [],           // raw Sleeper league objects
    nflState: null,
    online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  },
  activity: { items: [], unseen: 0, lastPoll: 0 },
};

// --- channel pub/sub ---
const listeners = new Map(); // channel -> Set<fn>

function emit(...channels) {
  for (const ch of channels) {
    const set = listeners.get(ch);
    if (set) for (const fn of set) fn(state);
  }
}

export function subscribe(channels, fn) {
  const arr = Array.isArray(channels) ? channels : [channels];
  for (const ch of arr) {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(fn);
  }
  return () => {
    for (const ch of arr) listeners.get(ch)?.delete(fn);
  };
}

export function getState() {
  return state;
}

// --- settings ---

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* storage may be full or blocked; app still works in-memory */ }
}

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persistSettings();
  // Also emit each changed top-level key as its own channel, so a listener that only
  // cares about e.g. 'legacyRankings' isn't woken by unrelated settings writes.
  emit('settings', ...Object.keys(patch));
}

// Immutable single-key update of a nested settings map.
// value === undefined deletes the key. This is the ONLY way to mutate these maps.
export function updateMap(mapName, key, value) {
  const current = state.settings[mapName] || {};
  const next = { ...current };
  if (value === undefined) delete next[key];
  else next[key] = value;
  state.settings = { ...state.settings, [mapName]: next };
  persistSettings();
  // Also emit the map's own name as a channel (see setSettings above).
  emit('settings', mapName);
}

// --- global active league ---

// The single league all league-scoped pages open for. Falls back to the first
// available league if the stored id is missing or no longer valid.
export function getActiveLeagueId() {
  const leagues = state.session.leagues || [];
  if (!leagues.length) return null;
  const g = state.settings.globalLeagueId;
  return leagues.some((l) => l.league_id === g) ? g : leagues[0].league_id;
}

export function setGlobalLeague(id) {
  state.settings = { ...state.settings, globalLeagueId: id };
  persistSettings();
  emit('globalLeague'); // league pages re-render on this channel
}

// --- targets list (watched players) ---
// Persisted under the legacy `interestPlayers` key so existing saved lists (and the
// already-deployed alert companion's config schema) keep working after the UI rename.

export function getTargets() {
  return state.settings.interestPlayers || [];
}

export function addTarget(id) {
  const cur = state.settings.interestPlayers || [];
  if (cur.includes(id)) return;
  state.settings = { ...state.settings, interestPlayers: [...cur, id] };
  persistSettings();
  emit('settings', 'targets');
}

export function removeTarget(id) {
  const cur = state.settings.interestPlayers || [];
  state.settings = { ...state.settings, interestPlayers: cur.filter((x) => x !== id) };
  persistSettings();
  emit('settings', 'targets');
}

// --- trade block (your players you're willing to sell) ---
// Flagged players are prioritized (not required) when recommending the package you'd
// give up in a trade.

export function getForSale() {
  return state.settings.forSale || [];
}

export function isForSale(id) {
  return (state.settings.forSale || []).includes(id);
}

export function toggleForSale(id) {
  const cur = state.settings.forSale || [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  state.settings = { ...state.settings, forSale: next };
  persistSettings();
  emit('settings', 'forSale');
}

// --- action-plan snoozes ---
// A Home action plan recommendation can be dismissed with an X. That doesn't delete it
// — it hides it for a week. Snooze the same recommendation SNOOZE_LIMIT times and it's
// gone for good, on the theory that saying no three times is a real answer.
//
// Stored per league and keyed by the action's stable identity (e.g. "sell:4034"), so a
// snooze survives the plan being recomputed and follows the specific recommendation
// rather than a list position.

const DAY_MS = 24 * 60 * 60 * 1000;

function snoozeMapFor(leagueId) {
  return (state.settings.snoozes || {})[leagueId] || {};
}

export function getSnoozeState(leagueId, key, now = Date.now()) {
  const entry = snoozeMapFor(leagueId)[key];
  if (!entry) return { n: 0, until: 0, dismissed: false, active: false };
  const dismissed = entry.n >= SNOOZE_LIMIT;
  return { n: entry.n, until: entry.until, dismissed, active: dismissed || entry.until > now };
}

export function isActionSnoozed(leagueId, key, now = Date.now()) {
  return getSnoozeState(leagueId, key, now).active;
}

// Bump a recommendation's snooze count. Returns the resulting state so the caller can
// tell the user whether it was hidden for a week or retired permanently.
export function snoozeAction(leagueId, key, now = Date.now()) {
  const current = snoozeMapFor(leagueId);
  const n = Math.min(SNOOZE_LIMIT, (current[key]?.n || 0) + 1);
  const next = { ...current, [key]: { n, until: now + SNOOZE_DAYS * DAY_MS } };
  updateMap('snoozes', leagueId, next);
  return getSnoozeState(leagueId, key, now);
}

// Undo the most recent snooze of a recommendation (powers the "Undo" toast).
export function unsnoozeAction(leagueId, key) {
  const current = snoozeMapFor(leagueId);
  const entry = current[key];
  if (!entry) return;
  const next = { ...current };
  if (entry.n <= 1) delete next[key];
  else next[key] = { n: entry.n - 1, until: 0 };
  updateMap('snoozes', leagueId, Object.keys(next).length ? next : undefined);
}

export function clearSnoozes(leagueId) {
  updateMap('snoozes', leagueId, undefined);
}

// Count of recommendations currently hidden in a league, for the "N hidden" affordance.
export function snoozedCount(leagueId, now = Date.now()) {
  return Object.keys(snoozeMapFor(leagueId)).filter((k) => isActionSnoozed(leagueId, k, now)).length;
}

// Drop expired, un-dismissed snoozes that nobody has seen in a long time so the stored
// settings blob can't grow without bound. Called once on load.
function pruneSnoozes(now = Date.now()) {
  const all = state.settings.snoozes || {};
  const next = {};
  let changed = false;
  for (const [leagueId, entries] of Object.entries(all)) {
    const kept = {};
    for (const [key, e] of Object.entries(entries || {})) {
      const stale = e.n < SNOOZE_LIMIT && e.until && now - e.until > SNOOZE_FORGET_DAYS * DAY_MS;
      if (stale) { changed = true; continue; }
      kept[key] = e;
    }
    if (Object.keys(kept).length) next[leagueId] = kept;
    else if (Object.keys(entries || {}).length) changed = true;
  }
  if (changed) {
    state.settings = { ...state.settings, snoozes: next };
    persistSettings();
  }
}

// --- profiles (IndexedDB-backed) ---

async function persistProfiles() {
  await idbSet(PROFILES_IDB_KEY, state.profiles);
}

export function getProfiles() {
  return state.profiles;
}

export function getProfileById(id) {
  return state.profiles.find((p) => p.id === id) || null;
}

export async function addProfile({ name, type, rows }) {
  const profile = { id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, type, rows, uploadedAt: Date.now() };
  state.profiles = [...state.profiles, profile];
  await persistProfiles();
  emit('profiles');
  return profile;
}

export async function updateProfile(id, patch) {
  state.profiles = state.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
  await persistProfiles();
  emit('profiles');
}

export async function deleteProfile(id) {
  state.profiles = state.profiles.filter((p) => p.id !== id);
  // Also clear any league assignments pointing at it (additive, key-by-key).
  const next = { ...state.settings.assignments };
  let changed = false;
  for (const [lid, pid] of Object.entries(next)) {
    if (pid === id) { delete next[lid]; changed = true; }
  }
  if (changed) {
    state.settings = { ...state.settings, assignments: next };
    persistSettings();
    emit('settings');
  }
  await persistProfiles();
  emit('profiles');
}

// --- weekly ranking sets (IndexedDB-backed) ---
//
// Deliberately a SEPARATE store from ranking profiles. Profiles are assigned per
// league and feed Free Agents, Trade Finder, Draft, Targets and the Home action
// plan; weekly rankings must only ever reach the Lineup tab. Keeping them in their
// own store makes that true by construction instead of by filtering in six views.
//
// A set is a bundle of files, because weekly rankings are published split by
// position group (a flex file and a quarterback file). See lib/weekly.js.

// Sentinel assignment meaning "this league ignores weekly rankings entirely".
export const WEEKLY_NONE = 'none';

async function persistWeeklySets() {
  await idbSet(WEEKLY_IDB_KEY, state.weeklySets);
}

export function getWeeklySets() {
  return state.weeklySets;
}

export function getWeeklySetById(id) {
  return state.weeklySets.find((s) => s.id === id) || null;
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// file: { label, rows, week }
export async function addWeeklySet({ name, file }) {
  const set = {
    id: newId('w'),
    name,
    files: file ? [{ id: newId('f'), label: file.label, week: file.week ?? null, rows: file.rows, uploadedAt: Date.now() }] : [],
  };
  state.weeklySets = [...state.weeklySets, set];
  // The first set created becomes the default, so the common case needs no extra tap.
  if (!state.settings.weeklyDefaultId) {
    state.settings = { ...state.settings, weeklyDefaultId: set.id };
    persistSettings();
    emit('settings');
  }
  await persistWeeklySets();
  emit('weekly');
  return set;
}

// Add or replace a file within a set. A file with the same label replaces the
// previous one, so re-uploading this week's flex file updates it in place.
export async function addWeeklyFile(setId, { label, rows, week }) {
  const entry = { id: newId('f'), label, week: week ?? null, rows, uploadedAt: Date.now() };
  state.weeklySets = state.weeklySets.map((s) => {
    if (s.id !== setId) return s;
    const kept = (s.files || []).filter((f) => f.label !== label);
    return { ...s, files: [...kept, entry] };
  });
  await persistWeeklySets();
  emit('weekly');
  return entry;
}

export async function removeWeeklyFile(setId, fileId) {
  state.weeklySets = state.weeklySets.map((s) => (
    s.id === setId ? { ...s, files: (s.files || []).filter((f) => f.id !== fileId) } : s
  ));
  await persistWeeklySets();
  emit('weekly');
}

export async function renameWeeklySet(setId, name) {
  state.weeklySets = state.weeklySets.map((s) => (s.id === setId ? { ...s, name } : s));
  await persistWeeklySets();
  emit('weekly');
}

export async function deleteWeeklySet(id) {
  state.weeklySets = state.weeklySets.filter((s) => s.id !== id);
  // Clear the default and any league assignments pointing at it, key by key.
  let settings = state.settings;
  if (settings.weeklyDefaultId === id) settings = { ...settings, weeklyDefaultId: '' };
  const next = { ...settings.weeklyAssignments };
  let changed = false;
  for (const [lid, sid] of Object.entries(next)) {
    if (sid === id) { delete next[lid]; changed = true; }
  }
  if (changed) settings = { ...settings, weeklyAssignments: next };
  if (settings !== state.settings) {
    state.settings = settings;
    persistSettings();
    emit('settings');
  }
  await persistWeeklySets();
  emit('weekly');
}

export function setWeeklyDefault(id) {
  state.settings = { ...state.settings, weeklyDefaultId: id || '' };
  persistSettings();
  emit('settings', 'weekly');
}

// Resolve which weekly set drives a league's lineup: an explicit per-league
// assignment wins, then the app-wide default. Returns null when weekly rankings
// shouldn't apply, in which case the Lineup tab behaves exactly as it did before.
export function resolveWeeklyForLeague(leagueId) {
  const s = state.settings;
  const assigned = (s.weeklyAssignments || {})[leagueId];
  if (assigned === WEEKLY_NONE) return null;
  const id = assigned || s.weeklyDefaultId;
  // Sets live in IndexedDB but the default pointer lives in localStorage, so the two
  // can drift apart if one store is cleared without the other. With exactly one set
  // there is no ambiguity about what was meant, so use it rather than silently
  // dropping back to season rankings.
  const set = getWeeklySetById(id) || (!id && state.weeklySets.length === 1 ? state.weeklySets[0] : null);
  if (!set || !(set.files || []).length) return null;
  const merged = mergeWeeklySet(set);
  if (!merged.rows.length) return null;
  return {
    set,
    name: set.name,
    source: assigned ? 'league' : 'default',
    uploadedAt: weeklySetUpdatedAt(set),
    ...merged,
  };
}

// --- session (ephemeral) ---

export function setSession(patch) {
  state.session = { ...state.session, ...patch };
  // Emit the specific channels that changed so listeners stay scoped.
  emit(...Object.keys(patch));
  emit('session');
}

// --- activity (isolated channel) ---

export function setActivity(items, unseen) {
  state.activity = { items, unseen, lastPoll: Date.now() };
  emit('activity');
}

export function markActivitySeen() {
  // Record last-seen per league and zero the badge.
  const now = Date.now();
  const lastSeen = { ...state.settings.lastSeen };
  for (const l of state.session.leagues) lastSeen[l.league_id] = now;
  state.settings = { ...state.settings, lastSeen };
  persistSettings();
  state.activity = { ...state.activity, unseen: 0 };
  emit('activity');
  emit('settings');
}

// --- boot / load ---

export async function loadPersisted() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) state.settings = { ...defaultSettings(), ...JSON.parse(raw) };
  } catch { /* ignore corrupt settings */ }
  try {
    const profiles = await idbGet(PROFILES_IDB_KEY);
    if (Array.isArray(profiles)) state.profiles = profiles;
  } catch { /* ignore */ }
  try {
    const weekly = await idbGet(WEEKLY_IDB_KEY);
    if (Array.isArray(weekly)) state.weeklySets = weekly;
  } catch { /* ignore */ }
  pruneSnoozes();
}

// --- full wipe (Setup -> Clear all data) ---
// Must clear EVERYTHING: localStorage settings + ALL IndexedDB (profiles, player cache,
// dues live in settings/localStorage). (Pitfall #7)
export async function clearAllData() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
  try { localStorage.clear(); } catch { /* ignore */ }
  await idbClearAll();
  state.settings = defaultSettings();
  state.profiles = [];
  state.weeklySets = [];
  state.session = { leagues: [], nflState: state.session.nflState, online: state.session.online };
  state.activity = { items: [], unseen: 0, lastPoll: 0 };
  emit('settings', 'profiles', 'weekly', 'session', 'activity', 'leagues');
}

// --- backup / restore ---
// A portable snapshot of everything the user configured: settings (account, league
// config, thresholds, dues, targets, credentials) + ranking profiles. The big player
// cache is intentionally excluded — it's just re-downloaded from Sleeper.
export function exportBackup() {
  return {
    app: 'ffcc',
    kind: 'backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    profiles: state.profiles,
    weeklySets: state.weeklySets,
  };
}

// Restore from a parsed backup object. Overwrites current settings + profiles. Settings
// are merged onto defaults so older/newer backups still get every expected key.
export async function importBackup(data) {
  if (!data || data.app !== 'ffcc' || !data.settings || typeof data.settings !== 'object') {
    throw new Error('That doesn’t look like an FFCC backup file.');
  }
  state.settings = { ...defaultSettings(), ...data.settings };
  persistSettings();
  state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
  await persistProfiles();
  // Backups predating weekly rankings simply have no sets to restore.
  state.weeklySets = Array.isArray(data.weeklySets) ? data.weeklySets : [];
  await persistWeeklySets();
  emit('settings', 'profiles', 'weekly', 'targets');
}

// Ask the browser to keep our storage durable (resists eviction, esp. on iOS Safari).
// Best-effort: returns whether storage is now persisted. Never throws.
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// Resolve the ranking lookup source for a league: assigned profile, else legacy by type.
export function resolveRankingForLeague(leagueId) {
  const s = state.settings;
  const profileId = s.assignments[leagueId];
  if (profileId) {
    const p = getProfileById(profileId);
    if (p) return { source: 'profile', name: p.name, type: p.type, rows: p.rows, uploadedAt: p.uploadedAt };
  }
  const type = s.leagueTypes[leagueId] || 'redraft';
  const legacy = s.legacyRankings[type];
  if (legacy && legacy.rows) {
    return { source: 'legacy', name: `Legacy ${type}`, type, rows: legacy.rows, uploadedAt: legacy.uploadedAt };
  }
  return null;
}
