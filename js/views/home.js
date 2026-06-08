// HOME / Dashboard
import { div, span, btn, mount, el } from '../lib/dom.js';
import { getState, getProfiles } from '../store.js';
import { navigate } from '../router.js';
import { seasonTypeLabel, daysSince } from '../lib/format.js';
import { STALE_DAYS } from '../data/constants.js';
import { getRosters, getLeagueUsers } from '../api/sleeper.js';
import { computeStandings } from '../lib/league.js';
import { sectionTitle, loadingBlock, emptyBlock } from './components.js';

export function render(container) {
  const { settings, session } = getState();
  const leagues = session.leagues;
  const connected = !!settings.userId;

  const root = div({ class: 'view view-home' });

  if (!connected) {
    root.appendChild(div({ class: 'card cta' },
      div({ class: 'cta-title' }, '🏈 Welcome to your Command Center'),
      div({ class: 'cta-text' }, 'Connect your Sleeper account to pull in all your leagues, then upload your player rankings to overlay them everywhere.'),
      btn({ class: 'btn btn-primary', onclick: () => navigate('setup') }, 'Connect Sleeper account →'),
    ));
    mount(container, root);
    return;
  }

  const dynasty = leagues.filter((l) => settings.leagueTypes[l.league_id] === 'dynasty').length;
  const redraft = leagues.length - dynasty;
  const commish = leagues.filter((l) => settings.commishFlags[l.league_id]).length;

  // Season / week banner
  root.appendChild(div({ class: 'card season-banner' },
    div({}, span({ class: 'season-year' }, `${session.nflState?.season || settings.season} Season`),
      session.nflState?._fallback ? span({ class: 'muted-tag' }, ' (estimated)') : null),
    div({ class: 'season-week' }, seasonTypeLabel(session.nflState)),
  ));

  // Counts
  root.appendChild(div({ class: 'stat-grid' },
    statCard(leagues.length, 'Leagues'),
    statCard(dynasty, 'Dynasty'),
    statCard(redraft, 'Redraft'),
    statCard(commish, 'Commish'),
  ));

  // Your leagues — standings summary per league (lazy/parallel).
  if (leagues.length) {
    root.appendChild(sectionTitle('Your leagues'));
    const cards = div({ class: 'overview-cards' });
    for (const l of leagues) {
      const card = div({ class: 'card league-card' },
        div({ class: 'lc-head' },
          span({ class: 'lc-name' }, l.name),
          span({ class: 'lc-tags' },
            span({ class: 'pill' }, settings.leagueTypes[l.league_id] === 'dynasty' ? 'dynasty' : 'redraft'),
            settings.commishFlags[l.league_id] ? span({ class: 'pill pill-commish' }, 'commish') : null,
          ),
        ),
        div({ class: 'lc-meta muted small' }, `${l.total_rosters || '?'} teams · ${l.season}`),
        div({ class: 'lc-body' }, loadingBlock('Loading standings…')),
      );
      cards.appendChild(card);
      loadCard(card.querySelector('.lc-body'), l, settings.userId);
    }
    root.appendChild(cards);
  }

  // Rankings status
  const profiles = getProfiles();
  const rankCard = div({ class: 'card' }, sectionTitle('Rankings'));
  if (!profiles.length && !settings.legacyRankings.dynasty && !settings.legacyRankings.redraft) {
    rankCard.appendChild(div({ class: 'muted' }, 'No rankings loaded yet.'));
    rankCard.appendChild(btn({ class: 'btn', onclick: () => navigate('setup') }, 'Upload rankings'));
  } else {
    if (profiles.length) {
      rankCard.appendChild(div({ class: 'list' }, ...profiles.map((p) => {
        const stale = daysSince(p.uploadedAt) > STALE_DAYS;
        return div({ class: 'list-row' },
          span({}, `${p.name} `, span({ class: 'pill' }, p.type)),
          span({ class: 'muted' }, `${p.rows.length} players`),
          stale ? span({ class: 'badge bye', title: `${daysSince(p.uploadedAt)} days old` }, 'stale') : null,
        );
      })));
    }
    for (const t of ['dynasty', 'redraft']) {
      const lr = settings.legacyRankings[t];
      if (lr) rankCard.appendChild(div({ class: 'list-row' }, span({}, `Legacy ${t}`), span({ class: 'muted' }, `${lr.rows.length} players`)));
    }
    // Count assigned leagues
    const assigned = leagues.filter((l) => settings.assignments[l.league_id]).length;
    rankCard.appendChild(div({ class: 'muted small' }, `${assigned} of ${leagues.length} leagues have an assigned profile.`));
  }
  root.appendChild(rankCard);

  // Quick nav
  root.appendChild(div({ class: 'card' }, sectionTitle('Jump to'),
    div({ class: 'quicknav' },
      quick('Lineup', () => navigate('leagues', 'lineup')),
      quick('Matchup', () => navigate('leagues', 'matchup')),
      quick('Free Agents', () => navigate('leagues', 'freeagents')),
      quick('Trade Finder', () => navigate('leagues', 'tradefinder')),
      quick('Interest', () => navigate('leagues', 'interest')),
      quick('Transactions', () => navigate('leagues', 'transactions')),
      quick('Commish', () => navigate('commish')),
      quick('Tools', () => navigate('tools')),
      quick('Setup', () => navigate('setup')),
    ),
  ));

  mount(container, root);
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

function ordinalRank(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function statCard(n, label) {
  return div({ class: 'card stat' }, div({ class: 'stat-n' }, String(n)), div({ class: 'stat-label' }, label));
}

function quick(label, onclick) {
  return btn({ class: 'quicknav-btn', onclick }, label);
}
