import { ref } from 'vue';
import en from './locales/en.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import es from './locales/es.js';

const MESSAGES = { en, fr, de, es };

// English is the default everywhere: the board never guesses from
// navigator.language, so a fresh browser always starts in English and only a
// deliberate choice (persisted below) moves it elsewhere.
export const DEFAULT_LOCALE = 'en';
export const STORAGE_KEY = 'maggie:locale';

// Each language is listed under its own name, so the menu reads the same
// whatever locale is currently active.
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
];

export function isSupported(code) {
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code);
}

export const locale = ref(DEFAULT_LOCALE);

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
}

// Falls back to English before falling back to the key itself, so a locale
// that is missing a translation degrades to readable text rather than a slug.
export function translate(key, params) {
  const catalog = MESSAGES[locale.value] ?? MESSAGES[DEFAULT_LOCALE];
  const template = catalog[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, params);
}

// For values that arrive as codes from outside the board (hook event names,
// CI states, server reasons): a known code is translated, anything else is
// shown as it came rather than as a missing-key slug.
export function translateOr(key, fallback, params) {
  return Object.hasOwn(MESSAGES[DEFAULT_LOCALE], key) ? translate(key, params) : fallback;
}

export function setLocale(code, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  if (!isSupported(code)) return locale.value;
  locale.value = code;
  try {
    storage?.setItem(STORAGE_KEY, code);
  } catch { /* storage unavailable (private mode, quota) — the choice just is not persisted */ }
  if (doc?.documentElement) doc.documentElement.lang = code;
  return locale.value;
}

// Called once at startup: restores a previously chosen language, and stays on
// English for a first visit or an unreadable/unknown stored value.
export function initLocale({ storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  let saved = null;
  try {
    saved = storage?.getItem(STORAGE_KEY) ?? null;
  } catch { /* storage unavailable — fall through to the default */ }
  return setLocale(isSupported(saved) ? saved : DEFAULT_LOCALE, { storage, doc });
}

export function useI18n() {
  return { t: translate, locale, setLocale, locales: LOCALES };
}
