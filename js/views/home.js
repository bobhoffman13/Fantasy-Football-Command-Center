// HOME / Dashboard
import { div, span, btn, mount, el } from '../lib/dom.js';
import { getState, getProfiles } from '../store.js';
import { navigate } from '../router.js';
import { seasonTypeLabel, daysSince } from '../lib/format.js';
import { STALE_DAYS } from '../data/constants.js';
import { sectionTitle } from './components.js';

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
      quick('My Roster', () => navigate('leagues', 'roster')),
      quick('Matchup', () => navigate('leagues', 'matchup')),
      quick('Free Agents', () => navigate('leagues', 'freeagents')),
      quick('Lineup', () => navigate('leagues', 'lineup')),
      quick('Overview', () => navigate('leagues', 'overview')),
      quick('Commish', () => navigate('commish')),
      quick('Tools', () => navigate('tools')),
      quick('Setup', () => navigate('setup')),
    ),
  ));

  mount(container, root);
}

function statCard(n, label) {
  return div({ class: 'card stat' }, div({ class: 'stat-n' }, String(n)), div({ class: 'stat-label' }, label));
}

function quick(label, onclick) {
  return btn({ class: 'quicknav-btn', onclick }, label);
}
