// Reference enumerations and tunable thresholds for the app.

export const SEASON_FALLBACK = '2025';

// Canonical display order for positions on rosters.
export const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'IDP', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX', 'BN', 'IR'];

// Which real positions can fill each flex slot type.
export const FLEX_ELIGIBILITY = {
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  IDP_FLEX: ['DB', 'DL', 'LB', 'DT', 'DE', 'S', 'CB'],
};

// Roster slot identifiers that are flex slots (the rest are exact-position).
export const FLEX_SLOTS = new Set(['FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX', 'IDP_FLEX']);

// Slots that are not startable lineup positions.
export const NON_STARTING_SLOTS = new Set(['BN', 'IR', 'TAXI']);

// Injury statuses that are NEVER startable regardless of risk tolerance.
export const HARD_OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'NA', 'Sus', 'COV']);

// Risk-tolerance modes for the "Questionable" injury status.
export const RISK_MODES = {
  start: { label: 'Aggressive', desc: 'Start Questionable players' },
  warn: { label: 'Balanced', desc: 'Start Questionable players but flag them' },
  sit: { label: 'Cautious', desc: 'Bench Questionable players' },
};

// Visual ranking tiers, by overall rank threshold (<=).
export const RANK_TIERS = [
  { max: 12, key: 'elite', label: 'Elite' },
  { max: 36, key: 'good', label: 'Strong' },
  { max: 84, key: 'mid', label: 'Solid' },
  { max: 180, key: 'deep', label: 'Depth' },
  { max: Infinity, key: 'low', label: 'Deprioritized' },
];

export function tierForRank(rank) {
  if (rank == null) return null;
  return RANK_TIERS.find((t) => rank <= t.max);
}

// Below this match rate we surface a prominent warning.
export const LOW_MATCH_THRESHOLD = 0.8;

// Profile data older than this many days is flagged stale.
export const STALE_DAYS = 14;

// Cache lifetimes.
export const PLAYERS_CACHE_MS = 24 * 60 * 60 * 1000; // 24h
export const GET_CACHE_MS = 5 * 60 * 1000; // 5m
export const ACTIVITY_POLL_MS = 5 * 60 * 1000; // 5m

export const NAV_AREAS = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'leagues', label: 'Leagues', icon: '🏈' },
  { id: 'commish', label: 'Commish', icon: '📣' },
  { id: 'tools', label: 'Tools', icon: '🛠️' },
  { id: 'setup', label: 'Setup', icon: '⚙️' },
];

export const LEAGUE_VIEWS = [
  { id: 'roster', label: 'My Roster' },
  { id: 'matchup', label: 'Matchup' },
  { id: 'freeagents', label: 'Free Agents' },
  { id: 'lineup', label: 'Lineup' },
  { id: 'waivers', label: 'Waiver Alerts' },
  { id: 'overview', label: 'Overview' },
];

export const DRAFT_FORMATS = ['Snake', 'Auction', 'Linear'];
