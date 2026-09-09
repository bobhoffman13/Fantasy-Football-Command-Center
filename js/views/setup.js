// SETUP / Settings
import { div, span, btn, el, mount, toast } from '../lib/dom.js';
import {
  getState, setSettings, setSession, updateMap, getProfiles, addProfile, updateProfile, deleteProfile,
  clearAllData, exportBackup, importBackup,
  getWeeklySets, addWeeklySet, addWeeklyFile, removeWeeklyFile, deleteWeeklySet,
  setWeeklyDefault, WEEKLY_NONE,
} from '../store.js';
import { getUser, getLeagues, getPlayers } from '../api/sleeper.js';
import { parseRankingsCsv, parseWeeklyRankingsCsv } from '../lib/csv.js';
import { mergeWeeklySet, weeklySetUpdatedAt } from '../lib/weekly.js';
import { clearLookupCache } from '../lib/players.js';
import { ensureActivityPolling } from '../activity.js';
import { RISK_MODES, STALE_DAYS, SEASON_FALLBACK } from '../data/constants.js';
import { daysSince } from '../lib/format.js';
import { sectionTitle, notifCredsCard } from './components.js';

// Local UI state for the new-profile form (persists across re-renders).
const newProfile = { name: '', type: 'redraft' };
// Local UI state for the new weekly-set form.
const newWeekly = { name: '' };

export function render(container) {
  const { settings, session } = getState();
  const root = div({ class: 'view view-setup' });
  const rerender = () => render(container);

  root.appendChild(connectSection(settings, session, rerender));

  if (session.leagues.length) {
    root.appendChild(leagueConfigSection(settings, session, rerender));
  }

  root.appendChild(profilesSection(rerender));
  root.appendChild(weeklySection(rerender));
  root.appendChild(legacySection(rerender));
  root.appendChild(riskSection(settings, rerender));
  root.appendChild(notifCredsCard());
  root.appendChild(backupSection());
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

    // Weekly rankings override — only shown once at least one weekly set exists,
    // so the common single-set setup stays a one-dropdown screen.
    const weeklySets = getWeeklySets();
    const weeklyAssigned = (settings.weeklyAssignments || {})[lid];
    const defaultSet = weeklySets.find((w) => w.id === settings.weeklyDefaultId);
    const weeklySel = weeklySets.length ? el('select', { class: 'select',
      onchange: (e) => { updateMap('weeklyAssignments', lid, e.target.value || undefined); clearLookupCache(); rerender(); } },
      el('option', { value: '', selected: !weeklyAssigned },
        defaultSet ? `Default (${defaultSet.name})` : 'Default (none set)'),
      ...weeklySets.map((w) => el('option', { value: w.id, selected: weeklyAssigned === w.id }, w.name)),
      el('option', { value: WEEKLY_NONE, selected: weeklyAssigned === WEEKLY_NONE }, 'None — use season rankings'),
    ) : null;

    list.appendChild(div({ class: 'league-config' },
      div({ class: 'lc-title' }, l.name),
      div({ class: 'lc-controls' },
        typeCtl,
        el('label', { class: 'toggle' }, commishCb, span({}, 'Commish')),
      ),
      div({ class: 'field' }, span({ class: 'field-label' }, 'Ranking profile'), assignSel),
      weeklySel
        ? div({ class: 'field' }, span({ class: 'field-label' }, 'Weekly rankings (lineup only)'), weeklySel)
        : null,
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
    div({ class: 'muted small' },
      'Recognized columns: Player, Rank, Position, Team, Value. ',
      'Add a "Lifetime Value" column (and optionally "Lifetime Value Change") to power the Trade Finder.'),
  ));
  return card;
}

// --- Weekly rankings (Lineup tab only) ---
//
// A set is a bundle of files because weekly rankings are published split by position
// group. Uploading a file whose label already exists replaces it, so the weekly
// routine is: upload the flex file, upload the quarterback file, done.

function weeklySection(rerender) {
  const { settings, session } = getState();
  const sets = getWeeklySets();
  const card = div({ class: 'card' },
    sectionTitle('Weekly rankings', 'Projection files that drive the Lineup tab only'));

  card.appendChild(div({ class: 'muted small' },
    'These never affect Free Agents, Trade Finder, Draft or Targets — only the lineup '
    + 'the app suggests. Files are ordered by projected points, so a quarterback file and '
    + 'a flex file can be compared for the same FLEX or SUPER_FLEX slot.'));

  if (sets.length) {
    const list = div({ class: 'list' });
    for (const set of sets) list.appendChild(weeklySetRow(set, settings, rerender));
    card.appendChild(list);
  }

  const nameInput = el('input', { type: 'text', class: 'input',
    placeholder: 'Set name (e.g. Half PPR)', value: newWeekly.name,
    oninput: (e) => { newWeekly.name = e.target.value; } });

  card.appendChild(div({ class: 'new-profile' },
    sectionTitle('New weekly set'),
    div({ class: 'field' }, nameInput),
    div({ class: 'inline-field' },
      fileButton('Upload first file', async (text, filename) => {
        const name = newWeekly.name.trim();
        if (!name) { toast('Give the set a name first.', 'error'); return; }
        const parsed = parseWeeklyRankingsCsv(text);
        if (parsed.error) { toast(parsed.error, 'error'); return; }
        await addWeeklySet({ name, file: { label: labelFor(filename, parsed), rows: parsed.rows, week: parsed.week } });
        clearLookupCache();
        newWeekly.name = '';
        toast(`Created "${name}" — ${parsed.rows.length} players`, 'success');
        rerender();
      }, 'btn-primary'),
    ),
    div({ class: 'muted small' },
      'Needs a player name column and a projected points column. Week is read from the file. '
      + 'Add one set for your normal scoring, and a separate set for any league that scores differently.'),
  ));

  if (sets.length && session.leagues.length) {
    card.appendChild(div({ class: 'muted small' },
      'Assign a different set to an individual league under Leagues above.'));
  }
  return card;
}

function weeklySetRow(set, settings, rerender) {
  const merged = mergeWeeklySet(set);
  const isDefault = settings.weeklyDefaultId === set.id;
  const updated = weeklySetUpdatedAt(set);
  const counts = Object.entries(merged.countsByPosition)
    .filter(([pos]) => pos)
    .map(([pos, n]) => `${pos} ${n}`)
    .join(' · ');

  const files = div({ class: 'weekly-files' });
  for (const f of (set.files || []).slice().sort((a, b) => (a.label > b.label ? 1 : -1))) {
    files.appendChild(div({ class: 'weekly-file' },
      span({ class: 'wf-label' }, f.label),
      span({ class: 'muted small' },
        `${(f.rows || []).length} players${f.week != null ? ` · week ${f.week}` : ''} · ${daysSince(f.uploadedAt)}d ago`),
      btn({ class: 'btn btn-sm btn-danger', onclick: async () => {
        await removeWeeklyFile(set.id, f.id);
        clearLookupCache();
        rerender();
      } }, 'Remove'),
    ));
  }

  return div({ class: 'list-row weekly-row' },
    div({ class: 'weekly-head' },
      span({ class: 'profile-name' }, set.name),
      merged.week != null ? span({ class: 'pill' }, `Week ${merged.week}`) : null,
      isDefault ? span({ class: 'badge badge-weekly' }, 'default') : null,
      merged.mixedWeeks ? span({ class: 'badge inj-out', title: 'Files disagree on the week' }, 'mixed weeks') : null,
    ),
    div({ class: 'muted small' },
      `${merged.rows.length} players${counts ? ` · ${counts}` : ''}`
      + `${updated ? ` · updated ${daysSince(updated)}d ago` : ''}`),
    files,
    div({ class: 'row-actions' },
      fileButton('Add / replace file', async (text, filename) => {
        const parsed = parseWeeklyRankingsCsv(text);
        if (parsed.error) { toast(parsed.error, 'error'); return; }
        const label = labelFor(filename, parsed);
        await addWeeklyFile(set.id, { label, rows: parsed.rows, week: parsed.week });
        clearLookupCache();
        toast(`${label}: ${parsed.rows.length} players`, 'success');
        rerender();
      }, 'btn-primary'),
      isDefault ? null : btn({ class: 'btn btn-sm', onclick: () => {
        setWeeklyDefault(set.id);
        clearLookupCache();
        toast(`"${set.name}" is now the default`, 'success');
        rerender();
      } }, 'Make default'),
      btn({ class: 'btn btn-sm btn-danger', onclick: async () => {
        if (!confirm(`Delete weekly set "${set.name}"? Leagues using it fall back to season rankings.`)) return;
        await deleteWeeklySet(set.id);
        clearLookupCache();
        rerender();
      } }, 'Delete'),
    ),
  );
}

// Label a file by the position groups it actually contains, falling back to the
// filename. That way "Flexweeklyhalfrankings.csv" becomes "RB/TE/WR" and re-uploading
// next week's version of the same groups replaces it instead of stacking up.
function labelFor(filename, parsed) {
  if (parsed.positions?.length) return parsed.positions.join('/');
  return (filename || 'file').replace(/\.[^.]+$/, '').slice(0, 30);
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

// --- Backup & restore ---

function backupSection() {
  const card = div({ class: 'card' }, sectionTitle('Backup & restore', 'Save everything to a file you control'));
  card.appendChild(div({ class: 'muted small' },
    'Your data lives only in this browser. Download a backup to move it to another device — '
    + 'or to restore it after clearing data or switching browsers. The file includes your settings, '
    + 'league config, ranking profiles, dues, targets list, and Pushover credentials, so keep it private.'));
  card.appendChild(div({ class: 'btn-row' },
    btn({ class: 'btn btn-primary', onclick: () => {
      const date = new Date().toISOString().slice(0, 10);
      download(`ffcc-backup-${date}.json`, JSON.stringify(exportBackup(), null, 2));
      toast('Backup downloaded', 'success');
    } }, 'Download backup'),
    fileButton('Restore from backup', async (text) => {
      let data;
      try { data = JSON.parse(text); } catch { toast('Could not read that file (invalid JSON).', 'error'); return; }
      if (!confirm('Restore from backup? This overwrites the settings and ranking profiles currently in this browser.')) return;
      try {
        await importBackup(data);
        clearLookupCache();
        toast('Backup restored — reloading…', 'success');
        setTimeout(() => location.reload(), 700);
      } catch (e) {
        toast(e?.message || 'Restore failed.', 'error');
      }
    }, '', '.json,application/json'),
  ));
  return card;
}

function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function fileButton(label, onText, extraClass = '', accept = '.csv,text/csv,text/plain') {
  const input = el('input', { type: 'file', accept, style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const filename = file.name;
      e.target.value = ''; // allow re-selecting same file
      onText(text, filename);
    } });
  const button = btn({ class: `btn btn-sm ${extraClass}`, onclick: () => input.click() }, label);
  const wrap = span({ class: 'file-btn' }, button, input);
  return wrap;
}
