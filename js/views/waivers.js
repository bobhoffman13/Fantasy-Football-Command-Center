// LEAGUES > Waiver Alerts (config)
import { div, span, btn, mount } from '../lib/dom.js';
import { getState, updateMap, setSettings } from '../store.js';
import { copyToClipboard, toast } from '../lib/dom.js';
import { leagueSelector, debouncedNumberInput, sectionTitle, emptyBlock } from './components.js';
import { buildAlertConfig, ALERT_SCRIPT } from '../lib/alertconfig.js';

export function render(container) {
  const { session, settings } = getState();
  const root = div({ class: 'view' });

  if (!session.leagues.length) {
    mount(container, root, emptyBlock('Connect your account in Setup to configure waiver alerts.'));
    return;
  }

  root.appendChild(div({ class: 'card' },
    sectionTitle('Per-league waiver thresholds', 'Alert when a free agent is ranked at or above N'),
    div({ class: 'list' }, ...session.leagues.map((l) => {
      const val = settings.thresholds[l.league_id] ?? '';
      return div({ class: 'list-row threshold-row' },
        span({}, l.name),
        debouncedNumberInput({
          value: val, placeholder: 'e.g. 100', min: 1, max: 1000,
          onCommit: (n) => updateMap('thresholds', l.league_id, n == null ? undefined : n),
        }),
      );
    })),
  ));

  // Notification credentials (used only by exported script)
  root.appendChild(div({ class: 'card' },
    sectionTitle('Pushover credentials', 'Used only by the exported companion script'),
    credInput('App token', settings.notifCreds.pushoverToken, (v) => setSettings({ notifCreds: { ...getState().settings.notifCreds, pushoverToken: v } })),
    credInput('User key', settings.notifCreds.pushoverUser, (v) => setSettings({ notifCreds: { ...getState().settings.notifCreds, pushoverUser: v } })),
  ));

  // Export
  root.appendChild(div({ class: 'card' },
    sectionTitle('Export alert config'),
    div({ class: 'muted small' }, 'Download the JSON config and the Node companion script, then run it on your machine to get push alerts for highly-ranked free agents.'),
    div({ class: 'btn-row' },
      btn({ class: 'btn btn-primary', onclick: exportConfig }, 'Download config JSON'),
      btn({ class: 'btn', onclick: () => copyToClipboard(JSON.stringify(buildAlertConfig(), null, 2)) }, 'Copy JSON'),
      btn({ class: 'btn', onclick: downloadScript }, 'Download script'),
    ),
  ));

  mount(container, root);
}

function credInput(label, value, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input';
  input.value = value || '';
  input.placeholder = label;
  let t = null;
  input.addEventListener('input', (e) => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => onChange(v), 500); });
  const wrap = div({ class: 'field' }, span({ class: 'field-label' }, label));
  wrap.appendChild(input);
  return wrap;
}

function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportConfig() {
  const cfg = buildAlertConfig();
  if (!cfg.leagues.length) { toast('Set at least one threshold first.', 'error'); return; }
  download('ffcc-alert-config.json', JSON.stringify(cfg, null, 2));
  toast('Config downloaded', 'success');
}

function downloadScript() {
  download('ffcc-alerts.mjs', ALERT_SCRIPT, 'text/javascript');
  toast('Script downloaded', 'success');
}
