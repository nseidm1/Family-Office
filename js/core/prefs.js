import { $ } from './utils.js';
import { state } from './state.js';

export const THEME_KEY = 'theme';
export const lightMediaQuery = window.matchMedia('(prefers-color-scheme: light)');

export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null; // localStorage can throw in locked-down/private browsing contexts
  }
}

export function preferredTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return lightMediaQuery.matches ? 'light' : 'dark';
}

export const SUN_ICON = '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />';
export const MOON_ICON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />';

// Icon shows the CURRENTLY ACTIVE theme (sun while light, moon while dark) —
// same convention as the eye icon showing the current privacy state rather
// than the action the click performs.
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#theme-toggle');
  if (!btn) return; // called once before the button exists is never expected, but stay defensive
  const isLight = theme === 'light';
  btn.setAttribute('aria-pressed', String(isLight));
  const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.querySelector('.theme-icon').innerHTML = isLight ? SUN_ICON : MOON_ICON;
}

applyTheme(preferredTheme());

export let privacyHidden = false;
// ES module imports of `let` bindings are read-only live views — an importing module can read
// privacyHidden but can't reassign it directly, only this owning module can. main.js's toggle
// handler needs to flip it, so it goes through this setter instead.
export function setPrivacyHidden(v) {
  privacyHidden = v;
}
export const MASK = '••••••';

// Addresses and amounts are written through here instead of a plain
// `.textContent =` so a freshly-rendered element (e.g. after a portfolio
// refresh rebuilds the whole list) immediately respects whatever privacy state
// is already active, and so the toggle can find every such element again later
// to flip it without re-fetching anything. Status text ("wrong network",
// "error", dates, counts) is never routed through this — only real addresses
// and amounts are worth hiding.
export function setSensitiveText(el, text) {
  el.dataset.real = text;
  el.textContent = privacyHidden ? MASK : text;
  el.classList.toggle('is-masked', privacyHidden);
}

// Subtle fade whenever an element's content actually changes — most visibly
// the spinner-to-value swap once a fetch resolves, but works for any
// content update on the element (e.g. a later refresh replacing one value
// with another). Re-triggerable: forces a reflow between removing and
// re-adding the animation class so back-to-back calls each restart the fade
// instead of silently no-op'ing (CSS re-adding the same class doesn't
// restart a running/finished animation on its own).
export function applyPrivacyMode() {
  document.querySelectorAll('[data-real]').forEach((el) => {
    el.textContent = privacyHidden ? MASK : el.dataset.real;
    el.classList.toggle('is-masked', privacyHidden);
  });
  // The connect button's native title tooltip isn't a text node applyPrivacyMode
  // can find via [data-real] — it'd otherwise leak the full address on hover.
  if (state.account) $('#connect').title = privacyHidden ? '' : state.account;
}

/* ---------- ABI helpers ---------- */

