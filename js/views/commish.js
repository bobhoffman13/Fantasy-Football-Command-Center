// COMMISH area: Messages + Dues & Payouts. Sub-state persists across navigation.
import { div, span, btn, el, mount, copyToClipboard, toast } from '../lib/dom.js';
import { getState, updateMap } from '../store.js';
import { getLeagueUsers, getRosters } from '../api/sleeper.js';
import { ownerDisplayName } from '../lib/league.js';
import { MESSAGE_TEMPLATES, AUTO_TOKENS } from '../data/templates.js';
import { leagueSelector, asyncRegion, sectionTitle, emptyBlock } from './components.js';
import { navigate } from '../router.js';

const COMMISH_TABS = [{ id: 'messages', label: 'Messages' }, { id: 'dues', label: 'Dues & Payouts' }];

// Persistent local state (survives navigating away and back).
const msgState = { leagueId: null, templateId: 'welcome', body: '' };
const duesState = { leagueId: null };

export function render(container, sub) {
  const active = COMMISH_TABS.some((t) => t.id === sub) ? sub : 'messages';
  const root = div({ class: 'view-area' });
  root.appendChild(div({ class: 'subnav' }, ...COMMISH_TABS.map((t) =>
    btn({ class: 'subnav-tab' + (t.id === active ? ' active' : ''), onclick: () => navigate('commish', t.id) }, t.label))));
  const host = div({ class: 'subview-host' });
  root.appendChild(host);
  mount(container, root);

  if (active === 'messages') renderMessages(host);
  else renderDues(host);
}

// --- Messages ---

function autoFill(body, league) {
  const { settings, session } = getState();
  const map = {
    '[LEAGUE NAME]': league?.name || '',
    '[WEEK]': String(session.nflState?.display_week || ''),
    '[YEAR]': String(session.nflState?.season || settings.season || ''),
    '[COMMISH NAME]': settings.username || '',
  };
  let out = body;
  for (const t of AUTO_TOKENS) out = out.split(t).join(map[t] || t);
  return out;
}

function unfilledTokens(body) {
  return [...new Set((body.match(/\[[^\]]+\]/g) || []))];
}

function regenerateBody() {
  const tpl = MESSAGE_TEMPLATES.find((t) => t.id === msgState.templateId) || MESSAGE_TEMPLATES[0];
  const league = getState().session.leagues.find((l) => l.league_id === msgState.leagueId);
  msgState.body = autoFill(tpl.body, league);
}

function renderMessages(host) {
  const { settings } = getState();
  const commishLeagues = getState().session.leagues.filter((l) => settings.commishFlags[l.league_id]);
  if (!commishLeagues.length) {
    mount(host, emptyBlock('No commissioner leagues. Mark leagues as commish in Setup.'));
    return;
  }

  const root = div({});
  const sel = leagueSelector('commish', (id) => { msgState.leagueId = id; regenerateBody(); renderMessages(host); }, { filterCommish: true });
  if (!commishLeagues.some((l) => l.league_id === msgState.leagueId)) { msgState.leagueId = sel.selectedId; }
  if (!msgState.body) regenerateBody();
  root.appendChild(sel.node);

  // Template chips
  root.appendChild(div({ class: 'card' }, sectionTitle('Template'),
    div({ class: 'chip-row' }, ...MESSAGE_TEMPLATES.map((t) =>
      btn({ class: 'chip' + (t.id === msgState.templateId ? ' active' : ''), onclick: () => { msgState.templateId = t.id; regenerateBody(); renderMessages(host); } }, t.name)))));

  // Editable body
  const textarea = el('textarea', { class: 'textarea', rows: 12, value: msgState.body,
    oninput: (e) => { msgState.body = e.target.value; refreshWarn(); } });

  const warnHost = div({ class: 'unfilled-warn' });
  function refreshWarn() {
    const left = unfilledTokens(msgState.body);
    mount(warnHost, left.length
      ? div({ class: 'diag diag-warn' }, span({}, `⚠ ${left.length} unfilled placeholder${left.length > 1 ? 's' : ''}: `), span({ class: 'mono' }, left.join(' ')))
      : div({ class: 'diag diag-ok' }, '✓ No unfilled placeholders.'));
  }

  const card = div({ class: 'card' }, sectionTitle('Message'), textarea, warnHost,
    div({ class: 'btn-row' },
      btn({ class: 'btn btn-primary', onclick: () => {
        const left = unfilledTokens(msgState.body);
        if (left.length && !confirm(`There are still ${left.length} unfilled placeholder(s): ${left.join(' ')}.\n\nCopy anyway?`)) return;
        copyToClipboard(msgState.body);
      } }, 'Copy message'),
      btn({ class: 'btn', onclick: () => { regenerateBody(); renderMessages(host); } }, 'Reset to template'),
    ));
  root.appendChild(card);
  mount(host, root);
  refreshWarn();
}

// --- Dues & Payouts ---

function renderDues(host) {
  const { settings } = getState();
  const commishLeagues = getState().session.leagues.filter((l) => settings.commishFlags[l.league_id]);
  if (!commishLeagues.length) { mount(host, emptyBlock('No commissioner leagues. Mark leagues as commish in Setup.')); return; }

  const root = div({});
  const body = div({ class: 'view-body' });
  const run = asyncRegion(body);
  const sel = leagueSelector('commish_dues', (id) => { duesState.leagueId = id; run(() => loadDues(id)); }, { filterCommish: true });
  if (!commishLeagues.some((l) => l.league_id === duesState.leagueId)) duesState.leagueId = sel.selectedId;
  root.append(sel.node, body);
  mount(host, root);
  if (duesState.leagueId) run(() => loadDues(duesState.leagueId));
}

async function loadDues(leagueId) {
  const [users, rosters] = await Promise.all([getLeagueUsers(leagueId), getRosters(leagueId)]);
  // Only managers with a roster.
  const ownerIds = new Set((rosters || []).map((r) => r.owner_id).filter(Boolean));
  const managers = (users || []).filter((u) => ownerIds.has(u.user_id));

  const out = div({});
  const dues = getState().settings.duesByLeague[leagueId] || { amount: 0, paid: {} };

  // Amount input
  const amountInput = el('input', { type: 'number', class: 'input', inputmode: 'decimal', value: dues.amount || '', placeholder: 'Dues per manager',
    oninput: debounce((e) => {
      const amount = parseFloat(e.target.value) || 0;
      const cur = getState().settings.duesByLeague[leagueId] || { amount: 0, paid: {} };
      updateMap('duesByLeague', leagueId, { ...cur, amount });
      repaintTotals();
    }, 500) });

  out.appendChild(div({ class: 'card' }, sectionTitle('Dues amount', 'Per manager'),
    div({ class: 'field' }, amountInput)));

  const totalsHost = div({ class: 'card totals' });
  out.appendChild(totalsHost);

  const listCard = div({ class: 'card' }, sectionTitle('Managers', `${managers.length}`));
  const list = div({ class: 'list' });
  for (const m of managers) {
    const name = m.metadata?.team_name || m.display_name || m.username;
    const row = div({ class: 'list-row dues-row' });
    const toggle = el('label', { class: 'toggle' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!(getState().settings.duesByLeague[leagueId]?.paid?.[m.user_id]);
    cb.addEventListener('change', () => {
      const cur = getState().settings.duesByLeague[leagueId] || { amount: 0, paid: {} };
      const paid = { ...cur.paid, [m.user_id]: cb.checked };
      updateMap('duesByLeague', leagueId, { ...cur, paid });
      row.classList.toggle('paid', cb.checked);
      repaintTotals();
    });
    toggle.append(cb, span({}, cb.checked ? 'Paid' : 'Unpaid'));
    cb.addEventListener('change', () => { toggle.querySelector('span').textContent = cb.checked ? 'Paid' : 'Unpaid'; });
    if (cb.checked) row.classList.add('paid');
    row.append(span({ class: 'dues-name' }, name), toggle);
    list.appendChild(row);
  }
  listCard.appendChild(list);
  out.appendChild(listCard);

  function repaintTotals() {
    const d = getState().settings.duesByLeague[leagueId] || { amount: 0, paid: {} };
    const amount = Number(d.amount) || 0;
    const paidCount = managers.filter((m) => d.paid?.[m.user_id]).length;
    const collected = paidCount * amount;
    const pot = managers.length * amount;
    const outstanding = pot - collected;
    mount(totalsHost,
      div({ class: 'totals-grid' },
        totalCell('$' + collected.toFixed(0), 'Collected'),
        totalCell('$' + outstanding.toFixed(0), 'Outstanding'),
        totalCell('$' + pot.toFixed(0), 'Total pot'),
      ),
      btn({ class: 'btn', onclick: () => copyReminder(leagueId, managers) }, 'Copy dues reminder'),
    );
  }
  repaintTotals();
  return out;
}

function copyReminder(leagueId, managers) {
  const d = getState().settings.duesByLeague[leagueId] || { amount: 0, paid: {} };
  const league = getState().session.leagues.find((l) => l.league_id === leagueId);
  const unpaid = managers.filter((m) => !d.paid?.[m.user_id]).map((m) => m.metadata?.team_name || m.display_name || m.username);
  if (!unpaid.length) { toast('Everyone has paid! 🎉', 'success'); return; }
  const msg = `${league?.name || 'League'} dues reminder: $${Number(d.amount) || 0} per team is still outstanding for:\n` +
    unpaid.map((n) => `• ${n}`).join('\n') + `\n\nPlease send when you get a chance. Thanks!`;
  copyToClipboard(msg);
}

function totalCell(big, label) {
  return div({ class: 'total-cell' }, div({ class: 'tc-big' }, big), div({ class: 'tc-label' }, label));
}

function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
