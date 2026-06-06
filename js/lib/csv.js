// CSV parsing for personal ranking imports.
// Auto-detects delimiter, handles quoted fields, flexibly maps columns.

const COLUMN_ALIASES = {
  name: ['player', 'name', 'player_name', 'full_name', 'playername'],
  rank: ['overall_rank', 'rank', 'overall', 'ovr', 'rk'],
  pos: ['position', 'pos'],
  team: ['team', 'nfl_team', 'tm'],
  score: ['composite_score', 'score', 'pp_score', 'composite', 'value'],
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

function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function buildColumnMap(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

export function parseRankingsCsv(text) {
  if (!text || !text.trim()) {
    return { rows: [], error: 'File is empty.' };
  }
  // Normalize line endings; split into non-empty lines.
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    return { rows: [], error: 'CSV needs a header row and at least one data row.' };
  }
  const delim = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delim);
  const colMap = buildColumnMap(headers);

  if (colMap.name == null) {
    return {
      rows: [],
      error: `No name column found. Expected one of: ${COLUMN_ALIASES.name.join(', ')}. Found columns: ${headers.join(', ')}`,
    };
  }

  const rows = [];
  let order = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i], delim);
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
