import { ref } from 'vue';

// Material 3 tonal is the board's look from now on; `legacy` keeps the
// pre-Material appearance selectable but frozen — no new work targets it,
// which is also why it has no dark palette.
export const DEFAULT_THEME = 'm3';
export const DEFAULT_MODE = 'system';

export const THEME_STORAGE_KEY = 'maggie:theme';
export const MODE_STORAGE_KEY = 'maggie:mode';

// Unlike languages, which are listed in their own language, a theme name is
// translated — so these carry i18n keys rather than literal labels.
export const THEMES = [
  { code: 'm3', labelKey: 'theme.m3' },
  { code: 'expressive', labelKey: 'theme.expressive' },
  { code: 'classic', labelKey: 'theme.classic' },
  { code: 'legacy', labelKey: 'theme.legacy' },
];

export const MODES = [
  { code: 'light', labelKey: 'mode.light' },
  { code: 'dark', labelKey: 'mode.dark' },
  { code: 'system', labelKey: 'mode.system' },
];

const DARK_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_ONLY_THEMES = ['legacy'];

export function isSupportedTheme(code) {
  return THEMES.some((t) => t.code === code);
}

export function isSupportedMode(code) {
  return MODES.some((m) => m.code === code);
}

export function isLightOnly(code) {
  return LIGHT_ONLY_THEMES.includes(code);
}

export const theme = ref(DEFAULT_THEME);
export const mode = ref(DEFAULT_MODE);

// `system` is resolved here rather than in CSS, so a theme file needs a single
// dark block instead of repeating its whole palette inside a media query.
// Optional chaining already covers a missing matchMedia or a missing
// `.matches`; the catch below only guards a matchMedia that throws when
// invoked (a sandboxed or permission-restricted runtime) — both read as light.
function prefersDark(media) {
  try {
    return media?.(DARK_QUERY)?.matches === true;
  } catch { /* matchMedia threw when invoked — treat as light */ }
  return false;
}

// A light-only theme is stamped light whatever the stored mode is, so its CSS
// needs no dark values. The preference itself is untouched and comes back the
// moment a themeable theme is picked again.
function stamp(doc, media) {
  const el = doc?.documentElement;
  if (!el) return;
  el.setAttribute('data-theme', theme.value);
  if (isLightOnly(theme.value)) {
    el.setAttribute('data-mode', 'light');
    return;
  }
  const resolved = mode.value === 'system' ? (prefersDark(media) ? 'dark' : 'light') : mode.value;
  el.setAttribute('data-mode', resolved);
}

function writeStored(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch { /* storage unavailable (private mode, quota) — the choice just is not persisted */ }
}

function readStored(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch { /* storage unavailable — fall through to the default */ }
  return null;
}

export function setTheme(code, {
  storage = globalThis.localStorage, doc = globalThis.document, media = globalThis.matchMedia,
} = {}) {
  if (!isSupportedTheme(code)) return theme.value;
  theme.value = code;
  writeStored(storage, THEME_STORAGE_KEY, code);
  stamp(doc, media);
  return theme.value;
}

export function setMode(code, {
  storage = globalThis.localStorage, doc = globalThis.document, media = globalThis.matchMedia,
} = {}) {
  if (!isSupportedMode(code)) return mode.value;
  mode.value = code;
  writeStored(storage, MODE_STORAGE_KEY, code);
  stamp(doc, media);
  return mode.value;
}

// Guards the OS-listener registration below so that calling initTheme more
// than once (a second entry point, an HMR reload, a stray onMounted) cannot
// stack a second `change` listener on top of the first — the contract is
// "called once at startup", but this makes a repeat call harmless instead of
// relying on callers to honor that.
let listenerAttached = false;

// Called once at startup, before mount: restores both choices, rewrites an
// unreadable or unknown stored value with the default rather than leaving it,
// and follows the OS from then on while the mode stays `system`.
export function initTheme({
  storage = globalThis.localStorage, doc = globalThis.document, media = globalThis.matchMedia,
} = {}) {
  const savedTheme = readStored(storage, THEME_STORAGE_KEY);
  const savedMode = readStored(storage, MODE_STORAGE_KEY);
  // setMode's stamp() here is immediately superseded by setTheme's below: the
  // first write still reflects the pre-restore theme.value, so only the
  // second (final) stamp reflects the fully restored state.
  setMode(isSupportedMode(savedMode) ? savedMode : DEFAULT_MODE, { storage, doc, media });
  setTheme(isSupportedTheme(savedTheme) ? savedTheme : DEFAULT_THEME, { storage, doc, media });

  if (!listenerAttached) {
    listenerAttached = true;
    // Optional chaining already covers a missing matchMedia or
    // addEventListener; the catch below only guards a matchMedia that throws
    // when invoked (a sandboxed or permission-restricted runtime).
    try {
      media?.(DARK_QUERY)?.addEventListener?.('change', () => stamp(doc, media));
    } catch { /* matchMedia threw when invoked — the board simply does not follow OS changes */ }
  }

  return { theme: theme.value, mode: mode.value };
}

export function useTheme() {
  return { theme, mode, setTheme, setMode, themes: THEMES, modes: MODES, isLightOnly };
}
