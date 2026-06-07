// SETUP / Settings
import { div, span, btn, el, mount, toast } from '../lib/dom.js';
import {
  getState, setSettings, setSession, updateMap, getProfiles, addProfile, updateProfile, deleteProfile,
  clearAllData,
} from '../store.js';
import { getUser, getLeagues, getPlayers } from '../api/sleeper.js';
import { parseRankingsCsv } from '../lib/csv.js';
import { clearLookupCache } from '../lib/players.js';
import { ensureActivityPolling } from '../activity.js';
import { RISK_MODES, STALE_DAYS, SEASON_FALLBACK } from '../data/constants.js';
import { daysSince } from '../lib/format.js';
import { sectionTitle, notifCredsCard } from './components.js';

// Local UI state for the new-profile form (persists across re-renders).
const newProfile = { name: '', type: 'redraft' };

export function render(container) {
  const { settings, session } = getState();
  const root = div({ class: 'view view-setup' });
  const rerender = () => render(container);

  root.appendChild(connectSection(settings, session, rerender));

  root.appendChild(sleeperLinksTip());

  if (session.leagues.length) {
    root.appendChild(leagueConfigSection(settings, session, rerender));
  }

  root.appendChild(profilesSection(rerender));
  root.appendChild(legacySection(rerender));
  root.appendChild(riskSection(settings, rerender));
  root.appendChild(notifCredsCard());
  root.appendChild(dangerSection(rerender));

  mount(container, root);
}

// --- Connect ---

function connectSection(settings, session, rerender) {
  const card = div({ class: 'card' }, sectionTitle('Sleeper account'));
  const usernameInput = el('input', { type: 'text', class: 'input', placeholder: 'Sleeper username', value: settings.username || '', autocapitalize: 'none', autocorrect: 'off', spellcheck: false });
  const seasonInput = el('input', { type: 'text', class: 'input season-input', inputmode: 'numeric', placeholder: 'Season', value: settings.season || SEASON_FALLBACK });
  const status = div({ class: 'connect-status' });

  const connectBtn = btn({ class: 'btn btn-primary', onclick: async () => {
    const username = usernameInput.value; // getUser trims internally
    const season = (seasonInput.value || SEASON_FALLBACK).trim();
    connectBtn.disabled = true; // double-tap guard
    mount(status, span({ class: 'muted' }, 'Connecting…'));
    try {
      const user = await getUser(username);
      const leagues = await getLeagues(user.user_id, season);
      setSettings({ username: username.trim(), userId: user.user_id, season });
      setSession({ leagues: leagues || [] });
      clearLookupCache();
      getPlayers().catch(() => {}); // warm 3MB cache
      ensureActivityPolling();
      toast(`Connected — ${leagues?.length || 0} leagues`, 'success');
      rerender();
    } catch (e) {
      mount(status, span({ class: 'err-text' }, '⚠ ' + (e?.message || 'Failed to connect.')));
    } finally {
      connectBtn.disabled = false;
    }
  } }, settings.userId ? 'Reconnect / refresh leagues' : 'Connect');

  card.append(
    div({ class: 'field' }, span({ class: 'field-label' }, 'Username'), usernameInput),
    div({ class: 'field' }, span({ class: 'field-label' }, 'Season'), seasonInput),
    div({ class: 'btn-row' }, connectBtn),
    status,
  );
  if (settings.userId) card.appendChild(div({ class: 'muted small' }, `Connected as ${settings.username} · ${session.leagues.length} leagues`));
  return card;
}

// --- Sleeper links tip ---
// iOS is hostile to Sleeper league links: tapping one opens the app (which has
// no per-league deep-link) and pasting one into Safari makes sleeper.com bounce
// the visitor to the App Store. The only path to the actual logged-in league
// page on a phone is Safari's "Request Desktop Website" mode, so the buttons
// copy the link and we document the desktop-mode flow (plus the one-time
// per-site toggle that stops the App Store redirect for good).
function sleeperLinksTip() {
  const step = (...c) => el('li', null, ...c);
  return div({ class: 'card' }, sectionTitle('Opening a league in Sleeper (iPhone)'),
    div({ class: 'muted small' },
      'Sleeper has no real mobile website — a tapped link opens the app (which can’t jump to a league) and a pasted link bounces you to the App Store. Safari’s desktop mode is the way through:'),
    el('ol', { class: 'tip-steps muted small' },
      step('Tap any ', span({ class: 'tip-strong' }, 'Sleeper ⧉'), ' button here — it copies that page’s link.'),
      step('Open Safari, paste the link into the address bar, and go.'),
      step('If it tries to send you to the App Store, return to Safari and tap ',
        span({ class: 'tip-strong' }, 'aA'), ' (left of the address bar) → ',
        span({ class: 'tip-strong' }, 'Request Desktop Website'), '.'),
      step('The full Sleeper web app loads — logged in, on the exact page.')),
    div({ class: 'muted small' },
      span({ class: 'tip-strong' }, 'One-time fix: '),
      'in that ', span({ class: 'tip-strong' }, 'aA'), ' menu choose ',
      span({ class: 'tip-strong' }, 'Website Settings'), ' and turn on ',
      span({ class: 'tip-strong' }, '“Request Desktop Website”'),
      ' for sleeper.com — after that it loads the desktop site automatically and never bounces to the App Store again.'));
}

// --- League config: type, commish, profile assignment ---

function leagueConfigSection(settings, session, rerender) {
  const profiles = getProfiles();
  const card = div({ class: 'card' }, sectionTitle('Leagues', 'Set type, commissioner flag, and ranking profile'));
  const list = div({ class: 'list' });

  for (const l of session.leagues) {
    const lid = l.league_id;
    const type = settings.leagueTypes[lid] || (/(dynasty|keeper)/i.test(l.name) ? 'dynasty' : 'redraft');

    // Type segmented control
    const typeCtl = div({ class: 'segmented' },
      segBtn('Redraft', type === 'redraft', () => { updateMap('leagueTypes', lid, 'redraft'); rerender(); }),
      segBtn('Dynasty', type === 'dynasty', () => { updateMap('leagueTypes', lid, 'dynasty'); rerender(); }),
    );

    // Commish toggle
    const commishCb = el('input', { type: 'checkbox', checked: !!settings.commishFlags[lid] });
    commishCb.addEventListener('change', () => {
      updateMap('commishFlags', lid, commishCb.checked ? true : undefined);
    });

    // Profile assignment — additive single-key update (never wipes siblings).
    const assignSel = el('select', { class: 'select',
      onchange: (e) => { updateMap('assignments', lid, e.target.value || undefined); rerender(); } },
      el('option', { value: '', selected: !settings.assignments[lid] }, `Default (legacy ${type})`),
      ...profiles.map((p) => el('option', { value: p.id, selected: settings.assignments[lid] === p.id }, `${p.name} (${p.type})`)),
    );

    list.appendChild(div({ class: 'league-config' },
      div({ class: 'lc-title' }, l.name),
      div({ class: 'lc-controls' },
        typeCtl,
        el('label', { class: 'toggle' }, commishCb, span({}, 'Commish')),
      ),
      div({ class: 'field' }, span({ class: 'field-label' }, 'Ranking profile'), assignSel),
    ));
  }
  card.appendChild(list);
  return card;
}

function segBtn(label, active, onclick) {
  return btn({ class: 'seg' + (active ? ' active' : ''), onclick }, label);
}

// --- Profiles ---

function profilesSection(rerender) {
  const profiles = getProfiles();
  const card = div({ class: 'card' }, sectionTitle('Ranking profiles', 'Named CSV ranking sets per scoring format'));

  if (profiles.length) {
    const list = div({ class: 'list' });
    for (const p of profiles) {
      const stale = daysSince(p.uploadedAt) > STALE_DAYS;
      list.appendChild(div({ class: 'list-row profile-row' },
        div({}, span({ class: 'profile-name' }, p.name), ' ', span({ class: 'pill' }, p.type),
          stale ? span({ class: 'badge bye', title: `${daysSince(p.uploadedAt)} days old` }, 'stale') : null,
          div({ class: 'muted small' }, `${p.rows.length} players · uploaded ${daysSince(p.uploadedAt)}d ago`)),
        div({ class: 'row-actions' },
          fileButton('Re-upload', async (text) => {
            const parsed = parseRankingsCsv(text);
            if (parsed.error) { toast(parsed.error, 'error'); return; }
            await updateProfile(p.id, { rows: parsed.rows, uploadedAt: Date.now() });
            clearLookupCache();
            toast(`Updated — ${parsed.rows.length} players`, 'success');
            rerender();
          }),
          btn({ class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!confirm(`Delete profile "${p.name}"? Leagues using it will fall back to defaults.`)) return;
            await deleteProfile(p.id);
            clearLookupCache();
            rerender();
          } }, 'Delete'),
        ),
      ));
    }
    card.appendChild(list);
  }

  // New profile form
  const nameInput = el('input', { type: 'text', class: 'input', placeholder: 'Profile name (e.g. Dynasty PPR)', value: newProfile.name,
    oninput: (e) => { newProfile.name = e.target.value; } });
  const typeSel = el('select', { class: 'select', onchange: (e) => { newProfile.type = e.target.value; } },
    el('option', { value: 'redraft', selected: newProfile.type === 'redraft' }, 'Redraft'),
    el('option', { value: 'dynasty', selected: newProfile.type === 'dynasty' }, 'Dynasty'),
  );
  card.appendChild(div({ class: 'new-profile' },
    sectionTitle('New profile'),
    div({ class: 'field' }, nameInput),
    div({ class: 'inline-field' }, typeSel,
      fileButton('Upload CSV & create', async (text) => {
        const name = newProfile.name.trim();
        if (!name) { toast('Give the profile a name first.', 'error'); return; }
        const parsed = parseRankingsCsv(text);
        if (parsed.error) { toast(parsed.error, 'error'); return; }
        await addProfile({ name, type: newProfile.type, rows: parsed.rows });
        clearLookupCache();
        newProfile.name = '';
        toast(`Created "${name}" — ${parsed.rows.length} players`, 'success');
        rerender();
      }, 'btn-primary'),
    ),
  ));
  return card;
}

// --- Legacy single-CSV path ---

function legacySection(rerender) {
  const { settings } = getState();
  const card = div({ class: 'card' }, sectionTitle('Legacy rankings', 'Simple fallback: one dynasty + one redraft CSV'));
  for (const type of ['dynasty', 'redraft']) {
    const lr = settings.legacyRankings[type];
    card.appendChild(div({ class: 'list-row' },
      span({}, `${type[0].toUpperCase() + type.slice(1)} `, lr ? span({ class: 'muted small' }, `${lr.rows.length} players · ${daysSince(lr.uploadedAt)}d ago`) : span({ class: 'muted small' }, 'none')),
      fileButton(lr ? 'Replace' : 'Upload', async (text) => {
        const parsed = parseRankingsCsv(text);
        if (parsed.error) { toast(parsed.error, 'error'); return; }
        setSettings({ legacyRankings: { ...getState().settings.legacyRankings, [type]: { rows: parsed.rows, uploadedAt: Date.now() } } });
        clearLookupCache();
        toast(`Loaded ${parsed.rows.length} ${type} players`, 'success');
        rerender();
      }),
    ));
  }
  return card;
}

// --- Risk tolerance ---

function riskSection(settings, rerender) {
  const card = div({ class: 'card' }, sectionTitle('Lineup risk tolerance', 'How to treat Questionable players in the optimizer'));
  const seg = div({ class: 'segmented vertical' });
  for (const [key, info] of Object.entries(RISK_MODES)) {
    seg.appendChild(btn({ class: 'seg' + (settings.riskMode === key ? ' active' : ''),
      onclick: () => { setSettings({ riskMode: key }); clearLookupCache(); rerender(); } },
      div({}, div({ class: 'seg-title' }, info.label), div({ class: 'seg-desc muted small' }, info.desc))));
  }
  card.appendChild(seg);
  card.appendChild(div({ class: 'muted small' }, 'Out / IR / PUP / Doubtful and bye-week players are never started, regardless of this setting.'));
  return card;
}

// --- Danger zone ---

function dangerSection(rerender) {
  const card = div({ class: 'card danger' }, sectionTitle('Danger zone'));
  card.appendChild(div({ class: 'muted small' }, 'Clears everything: settings, league config, all ranking profiles, player cache, and dues records.'));
  card.appendChild(btn({ class: 'btn btn-danger', onclick: async () => {
    if (!confirm('Clear ALL data? This removes your account connection, every ranking profile, dues records, and cached data. This cannot be undone.')) return;
    await clearAllData();
    clearLookupCache();
    toast('All data cleared', 'success');
    location.hash = '#/home';
    rerender();
  } }, 'Clear all data'));
  return card;
}

// --- helper: a styled file picker button ---

function fileButton(label, onText, extraClass = '') {
  const input = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      e.target.value = ''; // allow re-selecting same file
      onText(text);
    } });
  const button = btn({ class: `btn btn-sm ${extraClass}`, onclick: () => input.click() }, label);
  const wrap = span({ class: 'file-btn' }, button, input);
  return wrap;
}
