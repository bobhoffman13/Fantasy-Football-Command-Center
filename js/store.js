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
import { SEASON_FALLBACK } from './data/constants.js';

const SETTINGS_KEY = 'ffcc:settings';
const PROFILES_IDB_KEY = 'profiles';

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
    lastLeagueByView: {}, // viewId -> leagueId
    notifCreds: { pushoverToken: '', pushoverUser: '' },
    duesByLeague: {},     // leagueId -> { amount, paid: { userId: bool } }
    lastSeen: {},         // leagueId -> timestamp
    legacyRankings: { dynasty: null, redraft: null }, // { rows, uploadedAt }
  };
}

const state = {
  settings: defaultSettings(),
  profiles: [],            // [{ id, name, type, rows, uploadedAt }]
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
  emit('settings');
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
  emit('settings');
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
  state.session = { leagues: [], nflState: state.session.nflState, online: state.session.online };
  state.activity = { items: [], unseen: 0, lastPoll: 0 };
  emit('settings', 'profiles', 'session', 'activity', 'leagues');
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
