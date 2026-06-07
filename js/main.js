// App bootstrap, shell, router, and error boundary.
import { div, span, btn, mount, el } from './lib/dom.js';
import { NAV_AREAS } from './data/constants.js';
import { parseHash, navigate, onRoute } from './router.js';
import { loadPersisted, getState, setSession, subscribe } from './store.js';
import { getNflState, getLeagues, getPlayers } from './api/sleeper.js';
import { ensureActivityPolling } from './activity.js';
import { seasonTypeLabel } from './lib/format.js';
import { openSleeper } from './views/components.js';

import * as home from './views/home.js';
import * as leagues from './views/leagues.js';
import * as commish from './views/commish.js';
import * as tools from './views/tools.js';
import * as setup from './views/setup.js';

const AREA_VIEWS = { home, leagues, commish, tools, setup };

let contentEl, navEl, bannerEl, headerStatusEl;
let currentCleanup = null;

async function boot() {
  buildShell();
  await loadPersisted();

  // Online/offline awareness.
  window.addEventListener('online', () => { setSession({ online: true }); paintBanner(); });
  window.addEventListener('offline', () => { setSession({ online: false }); paintBanner(); });
  paintBanner();

  // NFL state (with calendar fallback inside the API client).
  try {
    const nfl = await getNflState();
    setSession({ nflState: nfl });
  } catch { /* non-fatal */ }

  // Restore session if previously connected.
  const { settings } = getState();
  if (settings.userId) {
    try {
      const ls = await getLeagues(settings.userId, settings.season);
      setSession({ leagues: ls || [] });
      getPlayers().catch(() => {});
      ensureActivityPolling();
    } catch { /* show whatever we can; views handle errors */ }
  }

  // Routing.
  onRoute(renderRoute);
  if (!location.hash) location.hash = '#/home';
  renderRoute();
  paintHeaderStatus();

  // Keep activity badge + header live, scoped to their channels only.
  subscribe('activity', paintNav);
  subscribe(['nflState'], paintHeaderStatus);
  // Re-render nav highlight + current view when the league set changes (e.g. connect).
  subscribe(['leagues'], () => { paintNav(); });
}

function buildShell() {
  const app = document.getElementById('app');
  bannerEl = div({ class: 'offline-banner', style: { display: 'none' } });
  headerStatusEl = div({ class: 'header-status' });
  const sleeperBtn = btn({ class: 'btn btn-sm header-sleeper', onclick: () => openSleeper('https://sleeper.com') },
    'Sleeper', span({ class: 'ext-arrow' }, '↗'));
  const header = el('header', { class: 'app-header' },
    div({ class: 'app-title' }, '🏈 Command Center'),
    div({ class: 'header-right' }, headerStatusEl, sleeperBtn),
  );
  contentEl = el('main', { class: 'app-content' });
  navEl = el('nav', { class: 'app-nav' });
  mount(app, bannerEl, header, contentEl, navEl);
  paintNav();
}

function paintBanner() {
  const online = getState().session.online;
  bannerEl.style.display = online ? 'none' : 'block';
  if (!online) bannerEl.textContent = '⚠ Offline — showing cached data where available.';
}

function paintHeaderStatus() {
  const { session, settings } = getState();
  mount(headerStatusEl,
    span({ class: 'hs-season' }, session.nflState ? seasonTypeLabel(session.nflState) : ''),
  );
}

function paintNav() {
  const { area } = parseHash();
  const { activity } = getState();
  mount(navEl, ...NAV_AREAS.map((a) => {
    const isLeagues = a.id === 'leagues';
    const badge = isLeagues && activity.unseen > 0
      ? span({ class: 'nav-badge' }, String(activity.unseen > 99 ? '99+' : activity.unseen))
      : null;
    return btn({ class: 'nav-btn' + (a.id === area ? ' active' : ''), onclick: () => navigate(a.id) },
      span({ class: 'nav-icon' }, a.icon),
      span({ class: 'nav-label' }, a.label),
      badge,
    );
  }));
}

// Error boundary around each route render.
function renderRoute() {
  const { area, sub } = parseHash();
  paintNav();
  if (currentCleanup) { try { currentCleanup(); } catch {} currentCleanup = null; }
  const view = AREA_VIEWS[area] || home;
  try {
    const cleanup = view.render(contentEl, sub);
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (err) {
    console.error('Render error:', err);
    mount(contentEl, recoveryScreen(err));
  }
  contentEl.scrollTop = 0;
}

function recoveryScreen(err) {
  return div({ class: 'recovery' },
    div({ class: 'recovery-title' }, '⚠ Something went wrong'),
    div({ class: 'recovery-msg muted' }, String(err?.message || err)),
    div({ class: 'btn-row' },
      btn({ class: 'btn btn-primary', onclick: () => renderRoute() }, 'Reload this screen'),
      btn({ class: 'btn', onclick: () => { location.hash = '#/home'; } }, 'Go home'),
    ),
  );
}

// Last-resort global error boundary.
window.addEventListener('error', (e) => {
  if (contentEl && !contentEl.hasChildNodes()) mount(contentEl, recoveryScreen(e.error || e.message));
});

boot();
