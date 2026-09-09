// Weekly ranking sets: merging the position-group files that make up one week,
// and turning their projections into a single cross-position ordering.
//
// Sources publish weekly rankings split by position group — typically one flex
// file (RB/WR/TE) and one quarterback file, sometimes kickers and defenses too.
// Each file restarts its own Rank column at 1, so those ranks cannot be compared
// across files: the top quarterback and the top running back are both "1". The
// only column that IS comparable across files is projected points, so a set's
// overall rank is synthesized by sorting the merged rows by projection.
//
// That synthesized rank is what the lineup optimizer consumes, which is exactly
// what a FLEX or SUPER_FLEX slot needs in order to weigh a quarterback against a
// running back.

// Identity for de-duplication across files. Name plus position, normalized the
// same way the Sleeper matcher normalizes names, so "Kenneth Walker III" in one
// file and "Kenneth Walker" in another collapse to one player.
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function dedupeKey(row) {
  const tokens = (row.name || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !SUFFIXES.has(t));
  return `${tokens.join('')}|${(row.pos || '').replace(/[^A-Z]/gi, '').toUpperCase()}`;
}

// Merge every file in a set into one ranked list.
// files: [{ id, label, rows, week, uploadedAt }] — later files win on conflict,
// so re-uploading a corrected file replaces its rows rather than duplicating them.
export function mergeWeeklySet(set) {
  const files = (set?.files || []).slice().sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
  const byKey = new Map();
  for (const f of files) {
    for (const row of f.rows || []) {
      byKey.set(dedupeKey(row), { ...row, fileId: f.id, fileLabel: f.label });
    }
  }

  const rows = [...byKey.values()].sort((a, b) => (b.proj ?? -Infinity) - (a.proj ?? -Infinity));

  // Overall rank across the whole set, plus rank within each position.
  const posCounters = new Map();
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const n = (posCounters.get(row.pos) || 0) + 1;
    posCounters.set(row.pos, n);
    row.posRank = n;
  });

  // A set's week is whichever week its files agree on; disagreement is reported
  // so the UI can warn rather than silently mixing two weeks of projections.
  const weeks = [...new Set(files.map((f) => f.week).filter((w) => w != null))];

  return {
    rows,
    week: weeks.length ? weeks[0] : null,
    mixedWeeks: weeks.length > 1 ? weeks : null,
    positions: [...posCounters.keys()].filter(Boolean).sort(),
    countsByPosition: Object.fromEntries(posCounters),
  };
}

// Latest upload time across a set's files — drives staleness display and cache keys.
export function weeklySetUpdatedAt(set) {
  return (set?.files || []).reduce((max, f) => Math.max(max, f.uploadedAt || 0), 0);
}
