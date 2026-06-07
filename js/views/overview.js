// LEAGUES > Overview — league cards (lazy/parallel) + cross-league activity feed.
import { div, span, mount } from '../lib/dom.js';
import { getState, subscribe, markActivitySeen } from '../store.js';
import { getRosters, getLeagueUsers, getPlayers, getCachedPlayersSync } from '../api/sleeper.js';
import { computeStandings } from '../lib/league.js';
import { playerName } from '../lib/players.js';
import { relativeTime } from '../lib/format.js';
import { loadingBlock, emptyBlock, sectionTitle, sleeperHandoff } from './components.js';
import { notifyActivitySeen } from '../activity.js';

export function render(container) {
  const { session, settings } = getState();
  const root = div({ class: 'view view-overview' });

  if (!session.leagues.length) {
    mount(container, root, emptyBlock('Connect your account in Setup to see your leagues.'));
    return;
  }

  // League cards — each loads its own standings lazily in parallel.
  const cards = div({ class: 'overview-cards' });
  for (const l of session.leagues) {
    const card = div({ class: 'card league-card' },
      div({ class: 'lc-head' },
        span({ class: 'lc-name' }, l.name),
        span({ class: 'lc-tags' },
          settings.leagueTypes[l.league_id] === 'dynasty' ? span({ class: 'pill' }, 'dynasty') : span({ class: 'pill' }, 'redraft'),
          settings.commishFlags[l.league_id] ? span({ class: 'pill pill-commish' }, 'commish') : null,
          sleeperHandoff('Open', { leagueId: l.league_id, section: 'team', small: true }),
        ),
      ),
      div({ class: 'lc-meta muted small' }, `${l.total_rosters || '?'} teams · ${l.season}`),
      div({ class: 'lc-body' }, loadingBlock('Loading standings…')),
    );
    cards.appendChild(card);
    loadCard(card.querySelector('.lc-body'), l, settings.userId);
  }
  root.appendChild(sectionTitle('Your leagues'));
  root.appendChild(cards);

  // Activity feed
  const feedHost = div({ class: 'card activity-feed' });
  root.appendChild(feedHost);
  paintFeed(feedHost);

  // Live-update the feed when polls land; scoped to the 'activity' channel only.
  const unsub = subscribe('activity', () => paintFeed(feedHost));

  // Viewing the overview marks activity as seen (race-guarded in activity.js).
  notifyActivitySeen();
  markActivitySeen();

  mount(container, root);
  return unsub; // cleanup
}

async function loadCard(body, league, userId) {
  try {
    const [rosters, users] = await Promise.all([getRosters(league.league_id), getLeagueUsers(league.league_id)]);
    const usersById = {};
    for (const u of users) usersById[u.user_id] = u;
    const standings = computeStandings(rosters, usersById);
    const myIdx = standings.findIndex((s) => s.ownerId === userId);
    const me = myIdx >= 0 ? standings[myIdx] : null;
    const playoffSpots = league.settings?.playoff_teams || 6;
    const inPlayoffs = myIdx >= 0 && myIdx < playoffSpots;

    mount(body,
      me
        ? div({ class: 'lc-stats' },
            span({}, `${me.wins}-${me.losses}${me.ties ? '-' + me.ties : ''}`),
            span({ class: 'muted' }, `${ordinalRank(myIdx + 1)} of ${standings.length}`),
            span({ class: inPlayoffs ? 'pill pill-good' : 'pill pill-bad' }, inPlayoffs ? 'In playoff spot' : 'Outside'),
          )
        : emptyBlock('No team found here for your account.'),
    );
  } catch (e) {
    mount(body, div({ class: 'errbox-inline' }, '⚠ ' + (e?.message || 'Failed to load.')));
  }
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
    sectionTitle('Recent activity', activity.items.length ? `${activity.items.length}` : null),
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

function ordinalRank(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
