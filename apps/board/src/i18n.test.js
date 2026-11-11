import { test, expect, afterEach } from 'vitest';
import {
  DEFAULT_LOCALE, LOCALES, STORAGE_KEY, isSupported, locale, translate, setLocale, initLocale, useI18n,
} from './i18n.js';
import en from './locales/en.js';
import fr from './locales/fr.js';
import de from './locales/de.js';
import es from './locales/es.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function throwingStorage() {
  return { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
}
const noDoc = { storage: fakeStorage(), doc: null };

afterEach(() => { locale.value = DEFAULT_LOCALE; });

test('defaults to English', () => {
  expect(DEFAULT_LOCALE).toBe('en');
  expect(locale.value).toBe('en');
  expect(translate('nav.history')).toBe('History');
});

test('offers exactly the four supported languages', () => {
  expect(LOCALES.map((l) => l.code)).toEqual(['en', 'fr', 'de', 'es']);
  expect(LOCALES.map((l) => l.label)).toEqual(['English', 'Français', 'Deutsch', 'Español']);
  expect(isSupported('fr')).toBe(true);
  expect(isSupported('it')).toBe(false);
  expect(isSupported(null)).toBe(false);
});

test('every locale defines the same keys as the English catalog', () => {
  const expected = Object.keys(en).sort();
  for (const catalog of [fr, de, es]) expect(Object.keys(catalog).sort()).toEqual(expected);
});

test('every locale has the worktree strings', () => {
  for (const key of ['option', 'badge', 'dirty', 'tooltip', 'remove', 'confirm', 'confirmForce', 'missing']) {
    for (const catalog of [en, fr, de, es]) expect(catalog[`factory.worktree.${key}`]).toBeTruthy();
  }
});

test('translates into the active locale', () => {
  setLocale('fr', noDoc);
  expect(translate('nav.history')).toBe('Historique');
  setLocale('de', noDoc);
  expect(translate('nav.history')).toBe('Verlauf');
  setLocale('es', noDoc);
  expect(translate('nav.history')).toBe('Historial');
});

test('interpolates named parameters and leaves unknown ones untouched', () => {
  expect(translate('banner.ciDesync', { reason: 'boom' })).toBe('CI out of sync — boom');
  expect(translate('summary.percentDone', { percent: 40 })).toBe('40 % done');
  expect(translate('banner.ciDesync', {})).toBe('CI out of sync — {reason}');
});

test('falls back to English, then to the key itself', () => {
  setLocale('fr', noDoc);
  expect(translate('unknown.key')).toBe('unknown.key');
});

test('setLocale persists the choice and tags the document language', () => {
  const storage = fakeStorage();
  const doc = { documentElement: { lang: 'en' } };
  setLocale('de', { storage, doc });
  expect(locale.value).toBe('de');
  expect(storage.getItem(STORAGE_KEY)).toBe('de');
  expect(doc.documentElement.lang).toBe('de');
});

test('setLocale ignores an unsupported language', () => {
  const storage = fakeStorage();
  setLocale('it', { storage, doc: null });
  expect(locale.value).toBe('en');
  expect(storage.getItem(STORAGE_KEY)).toBe(null);
});

test('initLocale restores a stored language', () => {
  const doc = { documentElement: { lang: 'en' } };
  initLocale({ storage: fakeStorage({ [STORAGE_KEY]: 'es' }), doc });
  expect(locale.value).toBe('es');
  expect(doc.documentElement.lang).toBe('es');
});

test('initLocale stays on English for a first visit or a bogus stored value', () => {
  setLocale('fr', noDoc);
  initLocale({ storage: fakeStorage(), doc: null });
  expect(locale.value).toBe('en');

  setLocale('fr', noDoc);
  initLocale({ storage: fakeStorage({ [STORAGE_KEY]: 'klingon' }), doc: null });
  expect(locale.value).toBe('en');
});

test('survives a storage that throws on read and on write', () => {
  initLocale({ storage: throwingStorage(), doc: null });
  expect(locale.value).toBe('en');
  setLocale('fr', { storage: throwingStorage(), doc: null });
  expect(locale.value).toBe('fr');
});

test('useI18n exposes the translator, the reactive locale and the language list', () => {
  const i18n = useI18n();
  expect(i18n.t('nav.board')).toBe('Board');
  expect(i18n.locale.value).toBe('en');
  expect(i18n.locales).toBe(LOCALES);
  i18n.setLocale('fr', noDoc);
  expect(i18n.locale.value).toBe('fr');
});

test('translate falls back to the English catalog when the active locale is unknown', () => {
  locale.value = 'xx';
  try {
    expect(translate('app.docTitle')).toBe(en['app.docTitle']);
  } finally {
    locale.value = DEFAULT_LOCALE;
  }
});
