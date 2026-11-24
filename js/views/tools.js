// TOOLS area: Playoff Race + Draft Tools. Draft state persists across navigation.
import { div, span, btn, el, mount, copyToClipboard, toast } from '../lib/dom.js';
import { DRAFT_FORMATS } from '../data/constants.js';
import { sectionTitle } from './components.js';
import { navigate } from '../router.js';
import { renderPlayoff } from './playoffrace.js';

const TOOLS_TABS = [{ id: 'playoff', label: 'Playoff Race' }, { id: 'draft', label: 'Draft Tools' }];

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
