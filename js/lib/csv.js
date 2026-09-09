// CSV parsing for personal ranking imports.
//
// Two shapes are supported, sharing the same tokenizer:
//   parseRankingsCsv()       season-long rankings, ordered by an overall rank column
//   parseWeeklyRankingsCsv() weekly rankings, ordered by projected points
//
// Weekly files are usually published split by position group (a flex file and a
// quarterback file), and each file restarts its Rank column at 1. That makes the
// Rank column meaningless once files are merged, so the weekly parser ignores it
// entirely and keeps projected points as the only cross-position sort key.

const COLUMN_ALIASES = {
  name: ['player', 'name', 'player_name', 'full_name', 'playername'],
  rank: ['overall_rank', 'rank', 'overall', 'ovr', 'rk'],
  pos: ['position', 'pos'],
  team: ['team', 'nfl_team', 'tm', 'team_abbrev', 'team_abbreviation'],
  score: ['composite_score', 'score', 'pp_score', 'composite', 'value'],
  // Dedicated "Lifetime Value" columns: a per-player worth used by the Trade
  // Finder, plus its recent trend. Kept separate from `score` so a generic
  // "value" column doesn't shadow them.
  lifetimeValue: ['lifetime_value', 'lifetimevalue', 'lt_value', 'ltv'],
  lifetimeValueChange: ['lifetime_value_change', 'lifetimevaluechange', 'lt_value_change', 'ltv_change', 'value_change'],
};

// Weekly files carry projections plus matchup context worth surfacing on a lineup card.
const WEEKLY_ALIASES = {
  name: COLUMN_ALIASES.name,
  pos: COLUMN_ALIASES.pos,
  team: COLUMN_ALIASES.team,
  proj: ['projected_points', 'proj_pts', 'projected', 'projection', 'projections', 'proj', 'fpts', 'points', 'pts'],
  week: ['week', 'wk'],
  opponent: ['opponent', 'opp', 'vs'],
  oppRankVsPos: ['opponent_vs_position_rank', 'opp_vs_pos_rank', 'opponent_rank_vs_position', 'def_vs_pos_rank'],
  oppVsPos: ['opponent_vs_position', 'opp_vs_pos', 'def_vs_pos'],
  impliedTotal: ['implied_vegas_points', 'implied_total', 'vegas_implied', 'implied_points', 'team_total'],
  snapShare: ['snap_share', 'snap_pct', 'snaps'],
  lastWeekPoints: ['last_week_points', 'last_week_pts', 'prev_week_points'],
};

function detectDelimiter(headerLine) {
  const comma = (headerLine.match(/,/g) || []).length;
  const semi = (headerLine.match(/;/g) || []).length;
  const tab = (headerLine.match(/\t/g) || []).length;
  if (tab > comma && tab > semi) return '\t';
  return semi > comma ? ';' : ',';
}

// Parse a single line respecting quoted fields (handles "" escapes).
function parseLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Strip currency symbols, thousands separators, and stray whitespace so values
// like "$1,234" or "+12" parse cleanly. Leaves sign, digits, and decimal point.
// A placeholder dash (used for stats not yet available in week 1) becomes empty.
function stripNumeric(raw) {
  const s = (raw || '').trim();
  if (!s || s === '-' || s === '--' || s === 'N/A') return '';
  return s.replace(/[^0-9.+-]/g, '');
}

function num(raw) {
  const v = parseFloat(stripNumeric(raw));
  return Number.isFinite(v) ? v : null;
}

function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function buildColumnMap(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  for (const [field, names] of Object.entries(aliases)) {
    const idx = normalized.findIndex((h) => names.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

// Shared tokenizer: text -> { headers, records, colMap } or { error }.
function readTable(text, aliases) {
  if (!text || !text.trim()) return { error: 'File is empty.' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return { error: 'CSV needs a header row and at least one data row.' };
  const delim = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delim);
  const colMap = buildColumnMap(headers, aliases);
  const records = [];
  for (let i = 1; i < lines.length; i++) records.push(parseLine(lines[i], delim));
  return { headers, records, colMap };
}

export function parseRankingsCsv(text) {
  const table = readTable(text, COLUMN_ALIASES);
  if (table.error) return { rows: [], error: table.error };
  const { headers, records, colMap } = table;

  if (colMap.name == null) {
    return {
      rows: [],
      error: `No name column found. Expected one of: ${COLUMN_ALIASES.name.join(', ')}. Found columns: ${headers.join(', ')}`,
    };
  }

  const rows = [];
  let order = 0;
  for (const cells of records) {
    const name = (cells[colMap.name] || '').trim();
    if (!name) continue; // skip rows with no name
    order++;
    const rawRank = colMap.rank != null ? parseInt(cells[colMap.rank], 10) : NaN;
    const rank = Number.isFinite(rawRank) ? rawRank : order; // fall back to row order
    const rawScore = colMap.score != null ? parseFloat(cells[colMap.score]) : NaN;
    rows.push({
      rank,
      name,
      pos: colMap.pos != null ? (cells[colMap.pos] || '').toUpperCase().trim() : '',
      team: colMap.team != null ? (cells[colMap.team] || '').toUpperCase().trim() : '',
      score: Number.isFinite(rawScore) ? rawScore : null,
      lifetimeValue: colMap.lifetimeValue != null ? num(cells[colMap.lifetimeValue]) : null,
      lifetimeValueChange: colMap.lifetimeValueChange != null ? num(cells[colMap.lifetimeValueChange]) : null,
    });
  }

  // Ensure stable sort by rank.
  rows.sort((a, b) => a.rank - b.rank);

  return {
    rows,
    error: rows.length === 0 ? 'No valid rows with player names were found.' : null,
    columnsDetected: Object.keys(colMap),
  };
}

// Parse one weekly ranking file. Returns rows WITHOUT a rank: ranking only becomes
// meaningful once every file in a week's set is merged (see lib/weekly.js).
export function parseWeeklyRankingsCsv(text) {
  const table = readTable(text, WEEKLY_ALIASES);
  if (table.error) return { rows: [], error: table.error };
  const { headers, records, colMap } = table;

  if (colMap.name == null) {
    return {
      rows: [],
      error: `No name column found. Expected one of: ${WEEKLY_ALIASES.name.join(', ')}. Found columns: ${headers.join(', ')}`,
    };
  }
  if (colMap.proj == null) {
    return {
      rows: [],
      error: 'No projected points column found. Weekly rankings are ordered by projections so that '
        + 'a quarterback file and a flex file can be compared in the same lineup. '
        + `Expected one of: ${WEEKLY_ALIASES.proj.join(', ')}. Found columns: ${headers.join(', ')}`,
    };
  }

  const rows = [];
  const weekCounts = new Map();
  for (const cells of records) {
    const name = (cells[colMap.name] || '').trim();
    if (!name) continue;
    const proj = num(cells[colMap.proj]);
    if (proj == null) continue; // a row with no projection can't be ranked
    const week = colMap.week != null ? num(cells[colMap.week]) : null;
    if (week != null) weekCounts.set(week, (weekCounts.get(week) || 0) + 1);
    rows.push({
      name,
      pos: colMap.pos != null ? (cells[colMap.pos] || '').toUpperCase().trim() : '',
      team: colMap.team != null ? (cells[colMap.team] || '').toUpperCase().trim() : '',
      proj,
      opponent: colMap.opponent != null ? (cells[colMap.opponent] || '').toUpperCase().trim() : '',
      oppRankVsPos: colMap.oppRankVsPos != null ? num(cells[colMap.oppRankVsPos]) : null,
      oppVsPos: colMap.oppVsPos != null ? num(cells[colMap.oppVsPos]) : null,
      impliedTotal: colMap.impliedTotal != null ? num(cells[colMap.impliedTotal]) : null,
      snapShare: colMap.snapShare != null ? num(cells[colMap.snapShare]) : null,
      lastWeekPoints: colMap.lastWeekPoints != null ? num(cells[colMap.lastWeekPoints]) : null,
    });
  }

  if (!rows.length) {
    return { rows: [], error: 'No valid rows with a player name and a projection were found.' };
  }

  // The file's week is whichever value most rows agree on.
  let week = null;
  let best = 0;
  for (const [w, n] of weekCounts) if (n > best) { best = n; week = w; }

  const positions = [...new Set(rows.map((r) => r.pos).filter(Boolean))].sort();

  return { rows, week, positions, error: null, columnsDetected: Object.keys(colMap) };
}
