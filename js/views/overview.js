// LEAGUES > Transactions — cross-league recent transaction feed.
// (The per-league standings summary now lives on the Home dashboard.)
import { div, span, mount } from '../lib/dom.js';
import { getState, subscribe, markActivitySeen } from '../store.js';
import { getPlayers, getCachedPlayersSync } from '../api/sleeper.js';
import { playerName } from '../lib/players.js';
import { relativeTime } from '../lib/format.js';
import { emptyBlock, sectionTitle } from './components.js';
import { notifyActivitySeen } from '../activity.js';

export function render(container) {
  const { session } = getState();
  const root = div({ class: 'view view-overview' });

  if (!session.leagues.length) {
    mount(container, root, emptyBlock('Connect your account in Setup to see transactions.'));
    return;
  }

  const feedHost = div({ class: 'card activity-feed' });
  root.appendChild(feedHost);
  paintFeed(feedHost);

  // Live-update the feed when polls land; scoped to the 'activity' channel only.
  const unsub = subscribe('activity', () => paintFeed(feedHost));

  // Viewing transactions marks activity as seen (race-guarded in activity.js).
  notifyActivitySeen();
  markActivitySeen();

  mount(container, root);
  return unsub; // cleanup
}

function paintFeed(host) {
  const { activity } = getState();
  let players = getCachedPlayersSync();
  if (!players) {
    // Warm the player cache so activity shows names, then repaint.
    players = {};
    getPlayers().then(() => paintFeed(host)).catch(() => {});
  }

  mount(host,
    sectionTitle('Recent transactions', activity.items.length ? `${activity.items.length}` : null),
    activity.items.length
      ? div({ class: 'list' }, ...activity.items.slice(0, 40).map((it) => activityRow(it, players)))
      : emptyBlock('No recent transactions across your leagues.'),
  );
}

function activityRow(it, players) {
  const adds = it.adds ? Object.keys(it.adds).map((id) => playerName(players, id)) : [];
  const drops = it.drops ? Object.keys(it.drops).map((id) => playerName(players, id)) : [];
  const typeLabel = ({ trade: 'Trade', waiver: 'Waiver', free_agent: 'Free agent' })[it.type] || it.type;
  const parts = [];
  if (adds.length) parts.push('+ ' + adds.join(', '));
  if (drops.length) parts.push('− ' + drops.join(', '));
  return div({ class: 'activity-row' },
    div({ class: 'ar-top' },
      span({ class: 'pill pill-sm' }, typeLabel),
      span({ class: 'muted small' }, it.leagueName),
      span({ class: 'muted small ar-time' }, relativeTime(it.created)),
    ),
    div({ class: 'ar-players' }, parts.join('  ') || '—'),
  );
}
