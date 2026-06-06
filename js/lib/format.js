// Formatting helpers.

export function fmtPoints(n) {
  const v = Number(n) || 0;
  return v.toFixed(2);
}

// Combine Sleeper's settings.fpts + fpts_decimal into a number.
export function rosterPoints(settings) {
  if (!settings) return 0;
  const whole = Number(settings.fpts) || 0;
  const dec = Number(settings.fpts_decimal) || 0;
  return whole + dec / 100;
}

export function relativeTime(ms) {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function daysSince(ms) {
  return Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function seasonTypeLabel(state) {
  switch (state?.season_type) {
    case 'pre': return 'Preseason';
    case 'regular': return `Week ${state.display_week}`;
    case 'post': return `Playoffs · Week ${state.display_week}`;
    case 'off': return 'Offseason';
    default: return '—';
  }
}

export function isActiveSeason(seasonType) {
  // Matchups / activity polling allowed during regular AND post.
  return seasonType === 'regular' || seasonType === 'post';
}
