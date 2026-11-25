// NFL team identities, for matching team defenses (D/ST) in ranking files.
//
// Sleeper stores each defense as a "player" whose id is the team abbreviation (e.g. "KC")
// and whose name is city + nickname ("Kansas City Chiefs"). Ranking sources usually list
// defenses by nickname only ("Chiefs"), sometimes with a suffix ("Chiefs D/ST"), and some
// use older/alternate abbreviations (JAC, WSH, LA). These helpers normalize all of that.

export const NFL_TEAMS = {
  ARI: ['Arizona', 'Cardinals'], ATL: ['Atlanta', 'Falcons'], BAL: ['Baltimore', 'Ravens'],
  BUF: ['Buffalo', 'Bills'], CAR: ['Carolina', 'Panthers'], CHI: ['Chicago', 'Bears'],
  CIN: ['Cincinnati', 'Bengals'], CLE: ['Cleveland', 'Browns'], DAL: ['Dallas', 'Cowboys'],
  DEN: ['Denver', 'Broncos'], DET: ['Detroit', 'Lions'], GB: ['Green Bay', 'Packers'],
  HOU: ['Houston', 'Texans'], IND: ['Indianapolis', 'Colts'], JAX: ['Jacksonville', 'Jaguars'],
  KC: ['Kansas City', 'Chiefs'], LAC: ['Los Angeles', 'Chargers'], LAR: ['Los Angeles', 'Rams'],
  LV: ['Las Vegas', 'Raiders'], MIA: ['Miami', 'Dolphins'], MIN: ['Minnesota', 'Vikings'],
  NE: ['New England', 'Patriots'], NO: ['New Orleans', 'Saints'], NYG: ['New York', 'Giants'],
  NYJ: ['New York', 'Jets'], PHI: ['Philadelphia', 'Eagles'], PIT: ['Pittsburgh', 'Steelers'],
  SEA: ['Seattle', 'Seahawks'], SF: ['San Francisco', '49ers'], TB: ['Tampa Bay', 'Buccaneers'],
  TEN: ['Tennessee', 'Titans'], WAS: ['Washington', 'Commanders'],
};

const ABBR_ALIASES = { JAC: 'JAX', WSH: 'WAS', LA: 'LAR', STL: 'LAR', OAK: 'LV', SD: 'LAC', GNB: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB' };

// Former nickname still seen in some files.
const NICKNAME_ALIASES = {
  'football team': 'WAS', 'washington football team': 'WAS', redskins: 'WAS', 'washington redskins': 'WAS',
  'ny giants': 'NYG', 'ny jets': 'NYJ', 'la rams': 'LAR', 'la chargers': 'LAC',
};

// "jac" / "WSH" / "kc" -> Sleeper abbreviation, or '' if unknown.
export function normalizeTeam(abbr) {
  const a = (abbr || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (NFL_TEAMS[a]) return a;
  return ABBR_ALIASES[a] || '';
}

const clean = (s) => s.toLowerCase().replace(/[’'`.]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Words that mark a row as a defense rather than part of the team's name.
const DEF_WORDS = /\b(d ?st|def|defense|defence|special teams|team defense)\b/g;

const BY_NAME = (() => {
  const m = new Map();
  for (const [abbr, [city, nick]] of Object.entries(NFL_TEAMS)) {
    m.set(clean(nick), abbr);
    m.set(clean(`${city} ${nick}`), abbr);
    m.set(clean(`${abbr} ${nick}`), abbr); // "KC Chiefs"
  }
  for (const [nick, abbr] of Object.entries(NICKNAME_ALIASES)) m.set(nick, abbr);
  return m;
})();

// "Chiefs", "Kansas City Chiefs", "Chiefs D/ST", "KC Defense" -> "KC"; anything else -> ''.
export function teamFromDefenseName(name) {
  const raw = clean(name || '');
  const stripped = raw.replace(DEF_WORDS, ' ').replace(/\s+/g, ' ').trim();
  for (const key of [stripped, raw]) {
    if (!key) continue;
    if (BY_NAME.has(key)) return BY_NAME.get(key);
    const abbr = normalizeTeam(key);
    if (abbr && key !== raw) return abbr; // "KC Defense" (bare "KC" alone is too ambiguous)
  }
  return '';
}

// Should this ranking row be treated as a team defense?
export function isDefenseRow(row) {
  const pos = (row?.pos || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (pos.startsWith('DEF') || pos.startsWith('DST') || pos === 'DS') return true;
  return !pos && Boolean(teamFromDefenseName(row?.name));
}
