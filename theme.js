// Applies the Theme setting (auto / light / dark) by setting data-theme to
// "light" or "dark" on <html>, which popup.html's color tokens key off.
// Loaded in <head> so the theme is in place before first paint: the setting
// itself lives in chrome.storage (async), so the last applied choice is
// cached in localStorage for this synchronous first pass.

const THEMES = ['auto', 'light', 'dark'];
const THEME_CACHE_KEY = 'sflTheme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = 'auto';

function resolveTheme() {
  const dark = themePref === 'dark' || (themePref === 'auto' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function applyTheme(pref) {
  themePref = THEMES.includes(pref) ? pref : 'auto';
  try { localStorage.setItem(THEME_CACHE_KEY, themePref); } catch (e) { /* first paint just follows the system */ }
  resolveTheme();
}

try { themePref = localStorage.getItem(THEME_CACHE_KEY) || 'auto'; } catch (e) { /* keep auto */ }
resolveTheme();
// Auto follows the system as it changes, even with the popup open.
systemDark.addEventListener('change', resolveTheme);
