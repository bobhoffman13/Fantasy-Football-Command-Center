// Hash-based router. Routes: #/home, #/leagues/<view>, #/commish/<sub>, #/tools/<sub>, #/setup
import { NAV_AREAS } from './data/constants.js';

const AREA_IDS = NAV_AREAS.map((a) => a.id);

export function parseHash() {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  let area = parts[0] || 'home';
  if (!AREA_IDS.includes(area)) area = 'home';
  return { area, sub: parts[1] || null, rest: parts.slice(2) };
}

export function navigate(area, sub) {
  location.hash = sub ? `#/${area}/${sub}` : `#/${area}`;
}

export function onRoute(fn) {
  window.addEventListener('hashchange', fn);
}
