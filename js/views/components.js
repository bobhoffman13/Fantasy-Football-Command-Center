// Shared UI building blocks used across views.

import { el, div, span, btn, mount } from '../lib/dom.js';
import { tierForRank, LOW_MATCH_THRESHOLD } from '../data/constants.js';
import { getState, setSettings, updateMap } from '../store.js';

export function rankBadge(rank) {
  if (rank == null) return span({ class: 'badge badge-unranked' }, 'NR');
  const tier = tierForRank(rank);
  return span({ class: `badge tier-${tier.key}`, title: tier.label }, `#${rank}`);
}

export function injuryBadge(status) {
  if (!status) return null;
  const cls = status === 'Questionable' ? 'inj-q' : 'inj-out';
  return span({ class: `badge ${cls}` }, status);
}

export function byeBadge(onBye, byeWeek) {
  if (!onBye) return null;
  return span({ class: 'badge bye' }, `BYE ${byeWeek ?? ''}`.trim());
}

// Match diagnostic banner. Shows prominent warning when below threshold.
export function matchDiagnostic(diagnostic, { compact = false } = {}) {
  if (!diagnostic) {
    return div({ class: 'diag diag-none' }, 'No rankings loaded for this league. Assign a profile in Setup.');
  }
  const pct = Math.round(diagnostic.rate * 100);
  const low = diagnostic.rate < LOW_MATCH_THRESHOLD;
  const sample = diagnostic.unmatched.slice(0, 8);
  const children = [
    div({ class: 'diag-head' },
      span({}, `${pct}% matched (${diagnostic.matched} of ${diagnostic.total})`),
      low ? span({ class: 'diag-warn-tag' }, '⚠ Low match rate') : null,
    ),
  ];
  if (low && !compact && sample.length) {
    children.push(div({ class: 'diag-unmatched' },
      'Unmatched names: ' + sample.join(', ') + (diagnostic.unmatched.length > sample.length ? `, +${diagnostic.unmatched.length - sample.length} more` : '')));
    children.push(div({ class: 'diag-hint' }, 'Your CSV names may be out of sync with Sleeper. Check spelling/suffixes.'));
  }
  return div({ class: `diag ${low ? 'diag-warn' : 'diag-ok'}` }, ...children);
}

export function loadingBlock(text = 'Loading…') {
  return div({ class: 'loading' }, div({ class: 'spinner' }), span({}, text));
}

export function errorBlock(message, onRetry) {
  return div({ class: 'errbox' },
    div({ class: 'errbox-msg' }, '⚠ ' + message),
    onRetry ? btn({ class: 'btn', onclick: onRetry }, 'Retry') : null,
  );
}

export function emptyBlock(text) {
  return div({ class: 'empty' }, text);
}

export function sectionTitle(text, sub) {
  return div({ class: 'section-title' }, span({}, text), sub ? span({ class: 'section-sub' }, sub) : null);
}

// League selector dropdown that remembers the last selection per view.
// onChange(leagueId) is called on selection. filterCommish limits to commish leagues.
export function leagueSelector(viewId, onChange, { filterCommish = false } = {}) {
  const { settings, session } = getState();
  let leagues = session.leagues;
  if (filterCommish) leagues = leagues.filter((l) => settings.commishFlags[l.league_id]);

  const wrap = div({ class: 'league-select' });
  if (!leagues.length) {
    wrap.appendChild(span({ class: 'muted' }, filterCommish ? 'No commissioner leagues. Mark some in Setup.' : 'No leagues. Connect your account in Setup.'));
    return { node: wrap, selectedId: null };
  }

  const remembered = settings.lastLeagueByView[viewId];
  const selectedId = leagues.some((l) => l.league_id === remembered) ? remembered : leagues[0].league_id;

  const select = el('select', {
    class: 'select',
    onchange: (e) => {
      updateMap('lastLeagueByView', viewId, e.target.value);
      onChange(e.target.value);
    },
  }, ...leagues.map((l) => el('option', { value: l.league_id, selected: l.league_id === selectedId }, l.name)));

  wrap.appendChild(el('label', { class: 'field-label' }, 'League'));
  wrap.appendChild(select);
  return { node: wrap, selectedId };
}

// Async region manager: handles loading/error states and ignores stale renders.
// The runId means a rapid re-trigger (double-tap) only renders the latest result;
// combined with the API layer's in-flight dedup, exactly one request is honored. (6.1)
export function asyncRegion(body) {
  let runId = 0;
  async function run(loadFn) {
    const my = ++runId;
    mount(body, loadingBlock());
    try {
      const content = await loadFn();
      if (my !== runId) return;
      mount(body, content);
    } catch (e) {
      if (my !== runId) return;
      mount(body, errorBlock(e?.message || 'Something went wrong.', () => run(loadFn)));
    }
  }
  return run;
}

// A debounced number input that persists via a setter. Avoids saving 1,10,100
// while the user types "100". (Spec 5.2.5 / 5.4)
export function debouncedNumberInput({ value, placeholder, min, max, onCommit, delay = 600 }) {
  let timer = null;
  const input = el('input', {
    type: 'number',
    class: 'input',
    inputmode: 'numeric',
    value: value ?? '',
    placeholder: placeholder || '',
    min, max,
    oninput: (e) => {
      clearTimeout(timer);
      const raw = e.target.value;
      timer = setTimeout(() => {
        if (raw === '') { onCommit(null); return; }
        let n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return;
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        onCommit(n);
      }, delay);
    },
  });
  return input;
}
