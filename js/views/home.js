// HOME / Dashboard
import { div, span, btn, mount, toast } from '../lib/dom.js';
import { getState, getProfiles, setGlobalLeague, subscribe, snoozeAction, unsnoozeAction, clearSnoozes, isActionSnoozed, getSnoozeState, snoozedCount } from '../store.js';
import { navigate } from '../router.js';
import { seasonTypeLabel, daysSince, relativeTime } from '../lib/format.js';
import { STALE_DAYS, SNOOZE_LIMIT } from '../data/constants.js';
import { getRosters, getLeagueUsers } from '../api/sleeper.js';
import { computeStandings, loadLeagueContext, ownerDisplayName, rosteredPlayerIds } from '../lib/league.js';
import { enrichPlayer } from '../lib/players.js';
import { describeWithValue } from '../lib/tradevalue.js';
import { getConsensusValues, leagueToConsensusParams, getTePremium } from '../api/fantasycalc.js';
import { recommendActions } from '../lib/actionplan.js';
import { sectionTitle, loadingBlock, emptyBlock, errorBlock } from './components.js';

// Same TE-premium approximation the Trade Finder uses, so both value TEs identically.
const TE_BUMP_PER_POINT = 0.4;
// Free agents worth considering at all: ranked this high or better in your rankings.
const FA_RANK_CAP = 250;
const FA_POOL_MAX = 150;

// Which league cards are open, and the assembled plan inputs per league. Both are
// module-level so a re-render (or a snooze) doesn't collapse cards or refetch the API.
const expanded = new Set();
const planInputs = new Map(); // leagueId -> input object for recommendActions()
const planHosts = new Map(); // leagueId -> { host, league } for the OPEN cards, so a
                              // rankings/league-type change can rebuild them without a full re-render.
let storeSubscribed = false;

// Anything that can change what a plan should recommend: a new/edited rankings profile,
// a league's profile assignment or dynasty/redraft flag, the legacy-rankings fallback, or
// risk tolerance (affects which players are startable). Deliberately narrow — it must NOT
// include 'snoozes' or 'forSale', which fire on every tap inside the plan itself and are
// already handled by a direct repaint, not a rebuild.
const INVALIDATING_CHANNELS = ['profiles', 'assignments', 'leagueTypes', 'legacyRankings', 'riskMode'];

function invalidatePlans() {
  planInputs.clear();
  for (const [id, ref] of planHosts) {
    if (!expanded.has(id) || !ref.host.isConnected) continue;
    openPlan(ref.host, ref.league);
  }
}

export function render(container) {
  const { settings, session } = getState();
  const leagues = session.leagues;
  const connected = !!settings.userId;

  if (!storeSubscribed) {
    storeSubscribed = true;
    subscribe(INVALIDATING_CHANNELS, invalidatePlans);
  }

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

  // Your leagues — standings summary per league, each expandable into an action plan.
  if (leagues.length) {
    root.appendChild(sectionTitle('Your leagues', 'Tap a league for your top 5 moves'));
    const cards = div({ class: 'overview-cards' });
    for (const l of leagues) cards.appendChild(leagueCard(l, settings));
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
      quick('Draft', () => navigate('leagues', 'draft')),
      quick('Targets', () => navigate('leagues', 'targets')),
      quick('Transactions', () => navigate('leagues', 'transactions')),
      quick('Commish', () => navigate('commish')),
      quick('Tools', () => navigate('tools')),
      quick('Setup', () => navigate('setup')),
    ),
  ));

  mount(container, root);
}

// --- league card --------------------------------------------------------------

function leagueCard(league, settings) {
  const id = league.league_id;
  const isDynasty = settings.leagueTypes[id] === 'dynasty';
  const planHost = div({ class: 'lc-plan' });
  const caret = span({ class: 'lc-caret' }, expanded.has(id) ? '▾' : '▸');
  planHosts.set(id, { host: planHost, league });

  const head = btn({
    class: 'lc-head lc-toggle',
    'aria-expanded': expanded.has(id) ? 'true' : 'false',
    onclick: () => toggle(),
  },
    span({ class: 'lc-head-left' },
      caret,
      span({ class: 'lc-name' }, league.name),
    ),
    span({ class: 'lc-tags' },
      span({ class: 'pill' }, isDynasty ? 'dynasty' : 'redraft'),
      settings.commishFlags[id] ? span({ class: 'pill pill-commish' }, 'commish') : null,
    ),
  );

  const card = div({ class: 'card league-card' },
    head,
    div({ class: 'lc-meta muted small' }, `${league.total_rosters || '?'} teams · ${league.season}`),
    div({ class: 'lc-body' }, loadingBlock('Loading standings…')),
    planHost,
  );

  loadCard(card.querySelector('.lc-body'), league, settings.userId);

  function toggle() {
    const open = expanded.has(id);
    if (open) {
      expanded.delete(id);
      mount(planHost);
    } else {
      expanded.add(id);
      openPlan(planHost, league);
    }
    caret.textContent = expanded.has(id) ? '▾' : '▸';
    head.setAttribute('aria-expanded', expanded.has(id) ? 'true' : 'false');
  }

  if (expanded.has(id)) openPlan(planHost, league);
  return card;
}

// Open (and if needed, build) the action plan for a league. The assembled inputs are
// cached per league for the session so collapsing and reopening — or snoozing an
// action — recomputes the plan locally instead of hitting the network again.
async function openPlan(host, league) {
  const id = league.league_id;
  const isDynasty = getState().settings.leagueTypes[id] === 'dynasty';
  if (planInputs.has(id)) { paintPlan(host, league); return; }

  mount(host, loadingBlock('Building your action plan…'));
  try {
    const input = await buildPlanInput(league, isDynasty);
    planInputs.set(id, input);
    if (!expanded.has(id)) return; // user collapsed it while we were loading
    paintPlan(host, league);
  } catch (e) {
    mount(host, errorBlock(e?.message || 'Could not build an action plan.', () => openPlan(host, league)));
  }
}

async function buildPlanInput(league, isDynasty) {
  const id = league.league_id;
  const ctx = await loadLeagueContext(id);

  const params = leagueToConsensusParams(ctx.league, isDynasty);
  const consensus = await getConsensusValues(params); // null on failure — optional
  const teFactor = 1 + getTePremium(ctx.league) * TE_BUMP_PER_POINT;

  const myRosterId = ctx.myRoster?.roster_id ?? null;
  // Weekly projections are overlaid on your own players only, so the action plan's
  // start/sit advice matches what the Lineup tab shows instead of contradicting it.
  const myPlayers = (ctx.myRoster?.players || [])
    .map((pid) => describeWithValue(pid, ctx, consensus, teFactor, ctx.weekly?.byPlayerId || null));

  const opponentPlayers = [];
  for (const r of ctx.rosters) {
    if (r.roster_id === myRosterId) continue;
    const owner = ownerDisplayName(ctx.usersById, r.owner_id);
    for (const pid of r.players || []) {
      const p = describeWithValue(pid, ctx, consensus, teFactor);
      p.owner = owner;
      p.rosterId = r.roster_id;
      opponentPlayers.push(p);
    }
  }

  // Free-agent pool, same rule the Free Agents page uses: unrostered and ranked inside
  // your top FA_RANK_CAP. Without an assigned rankings profile this comes back empty
  // and the plan simply leans on the generators that don't need rankings.
  const rostered = rosteredPlayerIds(ctx.rosters);
  const freeAgents = [];
  for (const pid of Object.keys(ctx.players)) {
    if (rostered.has(pid)) continue;
    const raw = ctx.players[pid];
    if (!raw || raw.active === false) continue;
    const row = ctx.rankingLookup.get(pid);
    if (!row || row.rank == null || row.rank > FA_RANK_CAP) continue;
    freeAgents.push(enrichPlayer(pid, ctx.players, ctx.rankingLookup, ctx.nflState, ctx.riskMode));
  }
  freeAgents.sort((a, b) => a.rank - b.rank);

  return {
    league: ctx.league,
    isDynasty,
    standings: computeStandings(ctx.rosters, ctx.usersById),
    myOwnerId: getState().settings.userId,
    myRoster: ctx.myRoster,
    rosters: ctx.rosters,
    usersById: ctx.usersById,
    myPlayers,
    opponentPlayers,
    freeAgents: freeAgents.slice(0, FA_POOL_MAX),
    nflState: ctx.nflState,
    consensus,
    hasRankings: !!ctx.ranking,
    rankingName: ctx.ranking?.name || null,
    weekly: ctx.weekly || null,
    diagnostic: ctx.diagnostic,
    builtAt: Date.now(),
  };
}

// Force a rebuild of one league's plan, bypassing the cache — powers the manual
// Refresh control (live scores/injuries/rosters otherwise only update on reload).
function forceRefresh(host, league) {
  planInputs.delete(league.league_id);
  openPlan(host, league);
}

function paintPlan(host, league) {
  const id = league.league_id;
  const input = planInputs.get(id);
  if (!input) return;

  const { posture, actions } = recommendActions({
    ...input,
    isSnoozed: (key) => isActionSnoozed(id, key),
  });

  const repaint = () => paintPlan(host, league);

  const nodes = [];

  nodes.push(div({ class: `plan-posture posture-${posture.key}` },
    span({ class: 'plan-posture-label' }, posture.label),
    span({ class: 'plan-posture-detail muted small' }, posture.detail),
  ));

  if (!input.myRoster) {
    nodes.push(emptyBlock('No team found here for your account.'));
  } else if (!actions.length) {
    nodes.push(emptyBlock(snoozedCount(id)
      ? 'Nothing left to suggest — everything current is snoozed.'
      : 'No clear moves right now. That usually means your lineup is optimal and no obvious value gaps exist.'));
  } else {
    nodes.push(div({ class: 'plan-list' }, ...actions.map((a) => actionRow(a, id, repaint))));
  }

  nodes.push(planFooter(input, league, host, repaint));
  mount(host, ...nodes);
}

function actionRow(a, leagueId, repaint) {
  const state = getSnoozeState(leagueId, a.key);
  const remaining = SNOOZE_LIMIT - state.n;
  const xTitle = remaining <= 1
    ? 'Dismiss permanently — you’ve snoozed this twice already'
    : `Snooze for a week (${remaining} snoozes before it’s dismissed for good)`;

  return div({ class: 'plan-action' },
    span({ class: 'plan-num' }, String(a.rank)),
    div({ class: 'plan-main' },
      div({ class: 'plan-title' }, a.title),
      div({ class: 'plan-detail muted small' }, a.detail),
      a.why?.length ? div({ class: 'plan-why' }, ...a.why.slice(0, 3).map((w) => div({ class: 'plan-why-row' }, w))) : null,
      a.guardrail ? div({ class: 'plan-guardrail' }, `⚠ ${a.guardrail}`) : null,
      div({ class: 'plan-cta-row' },
        span({ class: `pill horizon-${a.horizon}` }, horizonLabel(a.horizon)),
        state.n ? span({ class: 'muted small' }, `snoozed ${state.n}×`) : null,
        a.cta ? btn({
          class: 'btn btn-sm',
          onclick: () => { setGlobalLeague(leagueId); navigate('leagues', a.cta.view); },
        }, a.cta.label) : null,
      ),
    ),
    btn({
      class: 'plan-x', title: xTitle, 'aria-label': xTitle,
      onclick: () => {
        const res = snoozeAction(leagueId, a.key);
        repaint();
        toast(
          res.dismissed ? 'Dismissed for good' : 'Snoozed for a week',
          'info',
          { label: 'Undo', onClick: () => { unsnoozeAction(leagueId, a.key); repaint(); } },
        );
      },
    }, '✕'),
  );
}

function horizonLabel(h) {
  if (h === 'future') return 'Long term';
  if (h === 'both') return 'Now + later';
  return 'Win now';
}

// Data-provenance line, a "how fresh is this" readout with a manual refresh, and a
// way back from over-eager snoozing.
function planFooter(input, league, host, repaint) {
  const leagueId = league.league_id;
  const sources = [
    input.hasRankings ? `your “${input.rankingName}” rankings` : null,
    input.consensus ? 'public market values (FantasyCalc)' : null,
    'live NFL data (injuries, depth chart, age, byes)',
  ].filter(Boolean);

  const hidden = snoozedCount(leagueId);
  return div({ class: 'plan-footer' },
    div({ class: 'plan-freshness muted small' },
      span({}, `Updated ${relativeTime(input.builtAt)}. Rebuilds automatically when your rankings change.`),
      btn({ class: 'btn btn-sm plan-refresh', onclick: () => forceRefresh(host, league) }, '↻ Refresh'),
    ),
    div({ class: 'muted small' }, `Based on ${sources.join(', ')}.`),
    !input.hasRankings
      ? div({ class: 'diag diag-warn' }, '⚠ No rankings profile is assigned to this league, so value-based moves are hidden. Assign one in Setup.')
      : null,
    !input.consensus
      ? div({ class: 'muted small' }, 'Public consensus unavailable right now — buy-low / sell-high moves are hidden.')
      : null,
    hidden
      ? div({ class: 'plan-hidden-row' },
          span({ class: 'muted small' }, `${hidden} recommendation${hidden === 1 ? '' : 's'} hidden`),
          btn({ class: 'btn btn-sm', onclick: () => { clearSnoozes(leagueId); repaint(); toast('Hidden recommendations restored', 'success'); } }, 'Restore'),
        )
      : null,
  );
}

// --- standings summary (unchanged behaviour) ------------------------------------

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
