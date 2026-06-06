// TOOLS area: Playoff Race + Draft Tools. Draft state persists across navigation.
import { div, span, btn, el, mount, copyToClipboard, toast } from '../lib/dom.js';
import { getState } from '../store.js';
import { getRosters, getLeagueUsers } from '../api/sleeper.js';
import { computeStandings } from '../lib/league.js';
import { DRAFT_FORMATS } from '../data/constants.js';
import { leagueSelector, asyncRegion, sectionTitle, emptyBlock } from './components.js';
import { navigate } from '../router.js';

const TOOLS_TABS = [{ id: 'playoff', label: 'Playoff Race' }, { id: 'draft', label: 'Draft Tools' }];

const playoffState = { leagueId: null, week: null };
const draftState = { options: null, format: 'Snake', chosen: '' }; // options null => seed defaults lazily

export function render(container, sub) {
  const active = TOOLS_TABS.some((t) => t.id === sub) ? sub : 'playoff';
  const root = div({ class: 'view-area' });
  root.appendChild(div({ class: 'subnav' }, ...TOOLS_TABS.map((t) =>
    btn({ class: 'subnav-tab' + (t.id === active ? ' active' : ''), onclick: () => navigate('tools', t.id) }, t.label))));
  const host = div({ class: 'subview-host' });
  root.appendChild(host);
  mount(container, root);
  if (active === 'playoff') renderPlayoff(host);
  else renderDraft(host);
}

// --- Playoff Race ---

function renderPlayoff(host) {
  const { session } = getState();
  if (!session.leagues.length) { mount(host, emptyBlock('Connect your account in Setup first.')); return; }

  const root = div({});
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);
  const sel = leagueSelector('playoff', (id) => { playoffState.leagueId = id; trigger(); });
  if (!session.leagues.some((l) => l.league_id === playoffState.leagueId)) playoffState.leagueId = sel.selectedId;

  const nfl = session.nflState;
  if (playoffState.week == null) playoffState.week = nfl?.display_week || 1;
  const weekInput = el('input', { type: 'number', class: 'input', min: 1, max: 18, value: playoffState.week,
    oninput: (e) => { playoffState.week = e.target.value; } });
  const weekRow = div({ class: 'inline-field' }, span({ class: 'field-label' }, 'Through week'), weekInput,
    btn({ class: 'btn', onclick: trigger }, 'Load standings'));

  root.append(sel.node, weekRow, body);
  mount(host, root);
  trigger();

  function trigger() {
    const wk = parseInt(playoffState.week, 10);
    if (!Number.isFinite(wk) || wk < 1 || wk > 18) { mount(body, div({ class: 'diag diag-warn' }, '⚠ Enter a week between 1 and 18.')); return; }
    if (playoffState.leagueId) run(() => loadPlayoff(playoffState.leagueId, wk));
  }
}

async function loadPlayoff(leagueId, week) {
  const league = getState().session.leagues.find((l) => l.league_id === leagueId);
  const [rosters, users] = await Promise.all([getRosters(leagueId), getLeagueUsers(leagueId)]);
  const usersById = {};
  for (const u of users) usersById[u.user_id] = u;
  const standings = computeStandings(rosters, usersById);
  const spots = league?.settings?.playoff_teams || 6;
  const regEnd = (league?.settings?.playoff_week_start || 15) - 1;
  const gamesLeft = Math.max(0, regEnd - week);

  // Approximate clinch: a team above the line is clinched if even the best-case
  // record of the first team below the line can't catch it.
  const firstOut = standings[spots];
  const firstOutMaxWins = firstOut ? firstOut.wins + gamesLeft : -1;

  const out = div({});
  out.appendChild(div({ class: 'card' },
    sectionTitle(league?.name || 'Standings', `Through Week ${week} · top ${spots} make playoffs`),
    div({ class: 'standings' }, ...standings.map((s, i) => {
      const inSpot = i < spots;
      const clinched = inSpot && gamesLeft >= 0 && s.wins > firstOutMaxWins;
      const tag = clinched ? span({ class: 'pill pill-good' }, 'Clinched')
        : inSpot ? span({ class: 'pill pill-good' }, 'In')
        : span({ class: 'pill pill-bad' }, 'Out');
      return [
        i === spots ? div({ class: 'playoff-line' }, `— playoff line (${spots}) —`) : null,
        div({ class: 'standings-row' },
          span({ class: 'sr-rank' }, `${i + 1}`),
          span({ class: 'sr-owner' }, s.owner),
          span({ class: 'sr-rec' }, `${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}`),
          span({ class: 'sr-pf muted small' }, s.pf.toFixed(1)),
          tag,
        ),
      ];
    })),
    div({ class: 'btn-row' }, btn({ class: 'btn', onclick: () => copyStandings(league, standings, spots, week) }, 'Copy playoff picture')),
  ));
  return out;
}

function copyStandings(league, standings, spots, week) {
  const lines = standings.map((s, i) =>
    `${i + 1}. ${s.owner} (${s.wins}-${s.losses}${s.ties ? '-' + s.ties : ''}, ${s.pf.toFixed(1)} PF)${i + 1 === spots ? '  ⸺ playoff line ⸺' : ''}`);
  const msg = `${league?.name || 'League'} — Playoff Picture through Week ${week}\nTop ${spots} make the playoffs.\n\n${lines.join('\n')}`;
  copyToClipboard(msg);
}

// --- Draft Tools ---

function nextWeekends(count = 4) {
  const out = [];
  const d = new Date();
  // find next Saturday
  while (out.length < count) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day === 6 || day === 0) {
      out.push(d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }));
    }
  }
  return out;
}

function renderDraft(host) {
  if (draftState.options == null) draftState.options = nextWeekends(4);
  const root = div({});

  // Date options
  const optList = div({ class: 'list' });
  function repaintOpts() {
    mount(optList, ...draftState.options.map((opt, i) => div({ class: 'list-row' },
      span({}, `${i + 1}. ${opt}`),
      btn({ class: 'btn btn-sm', onclick: () => { draftState.options.splice(i, 1); repaintOpts(); } }, 'Remove'))));
  }
  const customInput = el('input', { type: 'text', class: 'input', placeholder: 'Add custom date/option' });
  const addBtn = btn({ class: 'btn', onclick: () => {
    const v = customInput.value.trim();
    if (v) { draftState.options.push(v); customInput.value = ''; repaintOpts(); }
  } }, 'Add');

  root.appendChild(div({ class: 'card' }, sectionTitle('Draft date options'),
    optList,
    div({ class: 'inline-field' }, customInput, addBtn),
    div({ class: 'btn-row' },
      btn({ class: 'btn', onclick: () => { draftState.options = nextWeekends(4); repaintOpts(); } }, 'Regenerate weekends'),
      btn({ class: 'btn btn-primary', onclick: () => copyPoll() }, 'Copy poll message')),
  ));
  repaintOpts();

  // Confirm date + format
  const chosenInput = el('input', { type: 'text', class: 'input', placeholder: 'Confirmed date', value: draftState.chosen,
    oninput: (e) => { draftState.chosen = e.target.value; } });
  const fmtSel = el('select', { class: 'select', onchange: (e) => { draftState.format = e.target.value; } },
    ...DRAFT_FORMATS.map((f) => el('option', { value: f, selected: f === draftState.format }, f)));
  root.appendChild(div({ class: 'card' }, sectionTitle('Confirm draft'),
    div({ class: 'inline-field' }, chosenInput, fmtSel),
    div({ class: 'btn-row' }, btn({ class: 'btn btn-primary', onclick: copyConfirm }, 'Copy confirmation')),
  ));

  // Reminders
  root.appendChild(div({ class: 'card' }, sectionTitle('Reminder messages'),
    div({ class: 'btn-row wrap' },
      btn({ class: 'btn', onclick: () => copyReminder('1 week') }, '1 week before'),
      btn({ class: 'btn', onclick: () => copyReminder('48 hours') }, '48 hrs before'),
      btn({ class: 'btn', onclick: () => copyReminder('24 hours') }, '24 hrs before'),
      btn({ class: 'btn', onclick: () => copyReminder('day of') }, 'Day of'),
    ),
  ));

  mount(host, root);
}

function copyPoll() {
  if (!draftState.options.length) { toast('Add at least one option.', 'error'); return; }
  const msg = `📅 Draft Date Poll — react with the number that works for you:\n\n` +
    draftState.options.map((o, i) => `${i + 1}. ${o}`).join('\n') + `\n\nLet's lock this in!`;
  copyToClipboard(msg);
}

function copyConfirm() {
  if (!draftState.chosen.trim()) { toast('Enter the confirmed date first.', 'error'); return; }
  const msg = `🏈 Draft confirmed!\n\n📅 ${draftState.chosen}\n🎯 Format: ${draftState.format}\n\nSet your reminders and start your prep. See you there!`;
  copyToClipboard(msg);
}

function copyReminder(when) {
  const date = draftState.chosen.trim() ? ` (${draftState.chosen})` : '';
  const map = {
    '1 week': `⏳ One week until our draft${date}! Format: ${draftState.format}. Start building your board.`,
    '48 hours': `⏰ 48 hours until the draft${date}! Format: ${draftState.format}. Make sure you can make it.`,
    '24 hours': `🚨 Draft is tomorrow${date}! Format: ${draftState.format}. Set autodraft if you can't attend.`,
    'day of': `🏈 Draft day${date}! Format: ${draftState.format}. Get your rankings ready — see you online.`,
  };
  copyToClipboard(map[when]);
}
