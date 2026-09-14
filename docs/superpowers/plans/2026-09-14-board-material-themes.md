# Board Material Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the board's user pick one of four looks — Material 3 tonal (the new default), Material 3 Expressive, Material classique, or today's look kept as a frozen `legacy` theme — plus a light/dark/system control, from pickers in the header.

**Architecture:** Colors, radii, shadows, spacing and type stop being literal Tailwind classes inside components and become a contract of CSS custom properties. `<html data-theme="…" data-mode="…">` selects which theme file fills that contract; Tailwind 4's `@theme` maps the contract to semantic utilities (`bg-surface`, `rounded-card`, `text-ink`), so no component gains a prop, an emit, or a different DOM shape. A small `@layer components` carries the three typographic properties utilities cannot express. Chart.js is the only place needing JavaScript: a canvas cannot read CSS variables, so the charts resolve colors at render time and re-render on a theme change.

**Tech Stack:** Vue 3 (`<script setup>`), Vite 8, Tailwind CSS 4 (CSS-configured, `source(none)` + `@source`), vitest + @vue/test-utils + jsdom, Chart.js 4, `@fontsource/roboto`.

**Spec:** `docs/superpowers/specs/2026-09-14-board-material-themes-design.md`

---

## Before you start

Everything in this plan lives in `apps/board/`. Two things about this app that are not obvious:

1. **Tailwind is configured from CSS, not a config file.** `apps/board/src/style.css` starts with `@import 'tailwindcss' source(none);` followed by `@source` lines. `source(none)` disables automatic content detection, so **a new file that contains class names must be covered by an `@source` line** or its classes are silently dropped from the build. The existing lines already cover `./src/**/*.{vue,js}`.
2. **Tailwind only sees class names that appear as complete literal strings.** `'bg-question-soft'` works; `` `bg-${status}-soft` `` does not. `statusStyles.js` exists for exactly this reason.
3. **Tailwind 4 tree-shakes unused `@theme` variables, not just unused utilities.** A token declared in `@theme` reaches the built CSS only once something references it — a utility a component uses, or a `var()` in the stylesheet's own rules. So a freshly added token is legitimately absent from `dist/` until a component uses it, and grepping the build for it proves nothing. This does not weaken the theming mechanism: the theme files under `themes/` are ordinary CSS, always emitted, and they are what supply the values; the `@theme` block supplies the fallback and, more importantly, makes Tailwind generate the semantic utilities in the first place.

Commands you will use:

```bash
npx vitest run apps/board/src/<file>.test.js --root apps/board   # one front-end test file
npm run test:board                                               # the board's full suite
npm run lint                                                     # eslint across the workspace
npm run board:build                                              # build the front-end only
npm start                                                        # build + serve on http://localhost:4180
```

`apps/board` is exempt from the repository's 100% coverage gate, but this project is developed test-first: write the failing test, watch it fail, make it pass, commit.

---

## File structure

**Created**

| File | Responsibility |
|---|---|
| `apps/board/src/theme.js` | Theme and mode state, persistence, `<html>` stamping. Mirrors `i18n.js`. |
| `apps/board/src/theme.test.js` | Tests for the above. |
| `apps/board/src/ThemeSwitcher.vue` | The four-theme `<select>`. |
| `apps/board/src/ThemeSwitcher.test.js` | Tests for the above. |
| `apps/board/src/ModeSwitcher.vue` | The light/dark/system `<select>`, disabled on light-only themes. |
| `apps/board/src/ModeSwitcher.test.js` | Tests for the above. |
| `apps/board/src/themes/contract.css` | The variable contract + the fallback values (m3 light). |
| `apps/board/src/themes/m3.css` | Material 3 tonal, light and dark. |
| `apps/board/src/themes/expressive.css` | Material 3 Expressive, light and dark. |
| `apps/board/src/themes/classic.css` | Material of the M2 era, light and dark. |
| `apps/board/src/themes/legacy.css` | Today's look, frozen, light only. |
| `apps/board/src/themes/contract.test.js` | The guard: every theme defines exactly the contract. |
| `apps/board/src/icons.js` | Material Symbols path data for the glyphs the board uses. |
| `apps/board/src/Icon.vue` | Renders an SVG glyph and its legacy emoji twin; CSS shows one. |
| `apps/board/src/Icon.test.js` | Tests for the above. |

**Modified**

| File | Change |
|---|---|
| `apps/board/src/style.css` | `@theme` mapping, theme imports, `@layer base` ground, `@layer components` typography, Roboto import. |
| `apps/board/src/main.js` | `initTheme()` next to `initLocale()`. |
| `apps/board/src/App.vue` | Mount both switchers; migrate classes. |
| `apps/board/src/locales/{en,fr,de,es}.js` | Ten new keys each. |
| `apps/board/src/statusStyles.js` | Semantic class strings. |
| `apps/board/src/ciBadge.js`, `agentBadge.js` | Semantic class strings. |
| `apps/board/src/{Board,Column,Card,SessionRow,SummaryHeader,FilterBar,RepoDetail,HistoryPage,HistoryTable,LocaleSwitcher}.vue` | Migrate classes. |
| `apps/board/src/{TimeSeriesChart,ProjectBarChart}.vue` | Resolve colors from tokens, re-render on theme change. |
| `apps/board/src/{Card,Column,SessionRow}.test.js` | Assertions move off literal Tailwind colors. |
| `apps/board/package.json` | `@fontsource/roboto` dependency. |
| `docs/board-dashboard.md`, `CHANGELOG.md` | Document the themes. |

**Order matters.** The contract and the theme files (Tasks 3–6) come before any component migration (Tasks 10–17), because the semantic utilities must exist before a component can use them. Between Task 9 and Task 14 the pickers work but change nothing visible — every component still carries its own literal classes. That is expected; do not "fix" it by skipping ahead.

---

## Task 1: Theme and mode state

**Files:**
- Create: `apps/board/src/theme.js`
- Test: `apps/board/src/theme.test.js`

This module is a deliberate decalque of `apps/board/src/i18n.js` — same shape, same guards, same storage discipline. Read that file first; the reviewer will expect the resemblance.

Two design points that are easy to miss:

- **`system` is resolved here, not in CSS.** `<html>` is only ever stamped `data-mode="light"` or `data-mode="dark"`; `mode.value` keeps `'system'` when that is what the user chose. This is what lets each theme file carry exactly one dark block instead of duplicating its whole palette inside a `@media (prefers-color-scheme: dark)` rule. A listener on the media query restamps when the OS flips.
- **A light-only theme is stamped light** whatever the stored mode is, while `mode.value` keeps the user's preference — that is how `legacy` stays light without needing dark values, and how the preference survives a round trip through it.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/theme.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import {
  DEFAULT_THEME, DEFAULT_MODE, THEMES, MODES, THEME_STORAGE_KEY, MODE_STORAGE_KEY,
  isSupportedTheme, isSupportedMode, isLightOnly,
  theme, mode, setTheme, setMode, initTheme, useTheme,
} from './theme.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function throwingStorage() {
  return { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
}
function fakeDoc() {
  const attrs = {};
  return { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, attrs } };
}
// Stands in for window.matchMedia. `listeners` lets a test fire an OS change.
function fakeMedia(matches = false) {
  const listeners = [];
  const mql = {
    matches,
    addEventListener: (_event, fn) => listeners.push(fn),
    flip(next) { mql.matches = next; for (const fn of listeners) fn({ matches: next }); },
  };
  const media = () => mql;
  media.mql = mql;
  return media;
}
const noDoc = { storage: fakeStorage(), doc: null, media: fakeMedia() };

afterEach(() => { theme.value = DEFAULT_THEME; mode.value = DEFAULT_MODE; });

test('defaults to Material 3 tonal following the system mode', () => {
  expect(DEFAULT_THEME).toBe('m3');
  expect(DEFAULT_MODE).toBe('system');
  expect(theme.value).toBe('m3');
  expect(mode.value).toBe('system');
});

test('offers exactly four themes and three modes', () => {
  expect(THEMES.map((t) => t.code)).toEqual(['m3', 'expressive', 'classic', 'legacy']);
  expect(THEMES.map((t) => t.labelKey)).toEqual(['theme.m3', 'theme.expressive', 'theme.classic', 'theme.legacy']);
  expect(MODES.map((m) => m.code)).toEqual(['light', 'dark', 'system']);
  expect(isSupportedTheme('classic')).toBe(true);
  expect(isSupportedTheme('neon')).toBe(false);
  expect(isSupportedTheme(null)).toBe(false);
  expect(isSupportedMode('dark')).toBe(true);
  expect(isSupportedMode('sepia')).toBe(false);
});

test('legacy is the only light-only theme', () => {
  expect(isLightOnly('legacy')).toBe(true);
  expect(isLightOnly('m3')).toBe(false);
});

test('setTheme persists the choice and stamps the document', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  setTheme('expressive', { storage, doc, media: fakeMedia() });
  expect(theme.value).toBe('expressive');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe('expressive');
  expect(doc.documentElement.attrs['data-theme']).toBe('expressive');
});

test('setTheme ignores an unsupported theme', () => {
  const storage = fakeStorage();
  setTheme('neon', { storage, doc: null, media: fakeMedia() });
  expect(theme.value).toBe('m3');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe(null);
});

test('setMode persists the choice and stamps the resolved mode', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  setMode('dark', { storage, doc, media: fakeMedia() });
  expect(mode.value).toBe('dark');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('dark');
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('the document is never stamped "system": it resolves to light or dark', () => {
  const doc = fakeDoc();
  setMode('system', { storage: fakeStorage(), doc, media: fakeMedia(false) });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');

  setMode('system', { storage: fakeStorage(), doc, media: fakeMedia(true) });
  expect(mode.value).toBe('system');
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('an OS scheme change restamps a theme following the system', () => {
  const doc = fakeDoc();
  const media = fakeMedia(false);
  initTheme({ storage: fakeStorage(), doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
  media.mql.flip(true);
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('a light-only theme is stamped light while the stored mode is preserved', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const media = fakeMedia();
  setMode('dark', { storage, doc, media });
  setTheme('legacy', { storage, doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
  expect(mode.value).toBe('dark');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('dark');

  setTheme('m3', { storage, doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('initTheme restores a stored theme and mode', () => {
  const doc = fakeDoc();
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'classic', [MODE_STORAGE_KEY]: 'light' });
  initTheme({ storage, doc, media: fakeMedia() });
  expect(theme.value).toBe('classic');
  expect(mode.value).toBe('light');
  expect(doc.documentElement.attrs['data-theme']).toBe('classic');
});

test('initTheme falls back to the defaults and overwrites a bogus stored value', () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'neon', [MODE_STORAGE_KEY]: 'sepia' });
  initTheme({ storage, doc: null, media: fakeMedia() });
  expect(theme.value).toBe('m3');
  expect(mode.value).toBe('system');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe('m3');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('system');
});

test('survives a storage that throws, and a runtime with no matchMedia', () => {
  initTheme({ storage: throwingStorage(), doc: null, media: undefined });
  expect(theme.value).toBe('m3');
  const doc = fakeDoc();
  setMode('system', { storage: throwingStorage(), doc, media: undefined });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
});

test('useTheme exposes the reactive state, the setters and the lists', () => {
  const api = useTheme();
  expect(api.theme.value).toBe('m3');
  expect(api.mode.value).toBe('system');
  expect(api.themes).toBe(THEMES);
  expect(api.modes).toBe(MODES);
  api.setTheme('classic', noDoc);
  expect(api.theme.value).toBe('classic');
  expect(api.isLightOnly('legacy')).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/theme.test.js --root apps/board`
Expected: FAIL — `Failed to resolve import "./theme.js"`.

- [ ] **Step 3: Write the implementation**

Create `apps/board/src/theme.js`:

```js
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
// A runtime without matchMedia (jsdom, an old browser) reads as light.
function prefersDark(media) {
  try {
    return media?.(DARK_QUERY)?.matches === true;
  } catch { /* matchMedia missing or refusing the query — treat as light */ }
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

function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch { /* storage unavailable (private mode, quota) — the choice just is not persisted */ }
}

function read(storage, key) {
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
  write(storage, THEME_STORAGE_KEY, code);
  stamp(doc, media);
  return theme.value;
}

export function setMode(code, {
  storage = globalThis.localStorage, doc = globalThis.document, media = globalThis.matchMedia,
} = {}) {
  if (!isSupportedMode(code)) return mode.value;
  mode.value = code;
  write(storage, MODE_STORAGE_KEY, code);
  stamp(doc, media);
  return mode.value;
}

// Called once at startup, before mount: restores both choices, rewrites an
// unreadable or unknown stored value with the default rather than leaving it,
// and follows the OS from then on while the mode stays `system`.
export function initTheme({
  storage = globalThis.localStorage, doc = globalThis.document, media = globalThis.matchMedia,
} = {}) {
  const savedTheme = read(storage, THEME_STORAGE_KEY);
  const savedMode = read(storage, MODE_STORAGE_KEY);
  setMode(isSupportedMode(savedMode) ? savedMode : DEFAULT_MODE, { storage, doc, media });
  setTheme(isSupportedTheme(savedTheme) ? savedTheme : DEFAULT_THEME, { storage, doc, media });

  try {
    media?.(DARK_QUERY)?.addEventListener?.('change', () => stamp(doc, media));
  } catch { /* no matchMedia or no listener support — the board simply does not follow OS changes */ }

  return { theme: theme.value, mode: mode.value };
}

export function useTheme() {
  return { theme, mode, setTheme, setMode, themes: THEMES, modes: MODES, isLightOnly };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/theme.test.js --root apps/board`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/theme.js apps/board/src/theme.test.js
git commit -m "feat(board): add theme and mode state with persistence"
```

---

## Task 2: Translations for the theme and mode labels

**Files:**
- Modify: `apps/board/src/locales/en.js`, `fr.js`, `de.js`, `es.js`
- Test: `apps/board/src/i18n.test.js` (already asserts catalog parity — no edit needed)

`i18n.test.js` has a test called *"every locale defines the same keys as the English catalog"*. Adding a key to `en.js` alone turns it red; that is the failing test for this task.

- [ ] **Step 1: Add the keys to the English catalog only, to watch parity fail**

In `apps/board/src/locales/en.js`, after the `'nav.language': 'Language',` line:

```js
  'nav.theme': 'Theme',
  'nav.mode': 'Appearance',

  'theme.m3': 'Material 3',
  'theme.expressive': 'Material 3 Expressive',
  'theme.classic': 'Material classic',
  'theme.legacy': 'Legacy (frozen)',

  'mode.light': 'Light',
  'mode.dark': 'Dark',
  'mode.system': 'System',
  'mode.legacyLocked': 'This theme is light only.',
```

- [ ] **Step 2: Run the i18n tests to verify parity fails**

Run: `npx vitest run src/i18n.test.js --root apps/board`
Expected: FAIL on *"every locale defines the same keys as the English catalog"*.

- [ ] **Step 3: Add the same keys to the three other catalogs**

`apps/board/src/locales/fr.js`:

```js
  'nav.theme': 'Thème',
  'nav.mode': 'Apparence',

  'theme.m3': 'Material 3',
  'theme.expressive': 'Material 3 Expressive',
  'theme.classic': 'Material classique',
  'theme.legacy': 'Ancien (figé)',

  'mode.light': 'Clair',
  'mode.dark': 'Sombre',
  'mode.system': 'Système',
  'mode.legacyLocked': 'Ce thème n’existe qu’en version claire.',
```

`apps/board/src/locales/de.js`:

```js
  'nav.theme': 'Design',
  'nav.mode': 'Erscheinungsbild',

  'theme.m3': 'Material 3',
  'theme.expressive': 'Material 3 Expressive',
  'theme.classic': 'Material klassisch',
  'theme.legacy': 'Bisheriges (eingefroren)',

  'mode.light': 'Hell',
  'mode.dark': 'Dunkel',
  'mode.system': 'System',
  'mode.legacyLocked': 'Dieses Design gibt es nur in Hell.',
```

`apps/board/src/locales/es.js`:

```js
  'nav.theme': 'Tema',
  'nav.mode': 'Apariencia',

  'theme.m3': 'Material 3',
  'theme.expressive': 'Material 3 Expressive',
  'theme.classic': 'Material clásico',
  'theme.legacy': 'Anterior (congelado)',

  'mode.light': 'Claro',
  'mode.dark': 'Oscuro',
  'mode.system': 'Sistema',
  'mode.legacyLocked': 'Este tema solo está disponible en modo claro.',
```

- [ ] **Step 4: Run the i18n tests to verify they pass**

Run: `npx vitest run src/i18n.test.js --root apps/board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/locales
git commit -m "feat(board): translate the theme and mode labels"
```

---
## Task 3: The token contract

**Files:**
- Create: `apps/board/src/themes/contract.css`
- Modify: `apps/board/src/style.css`

The contract is **72 variables**. Sixty-eight sit in an `@theme` block, which is what makes Tailwind emit the semantic utilities (`--color-surface` yields `bg-surface`/`text-surface`/`border-surface`, `--radius-card` yields `rounded-card`, `--spacing-card` yields `p-card`/`m-card`, `--shadow-card` yields `shadow-card`, `--font-ui` yields `font-ui`). The remaining four are plain custom properties consumed by the component layer in Task 17 — `text-transform`, `letter-spacing`, `font-weight` and a gradient have no Tailwind namespace.

The values in `contract.css` are the Material 3 tonal light palette. A token reaches the build only once something references it (see the third Tailwind trap in the preamble), so `contract.css` cannot promise the whole board renders styled before `data-theme` is stamped — but the four tokens the base layer references by `var()` are always emitted, so an unstamped board keeps its ground, its body text colour and its font: the page stays readable rather than unstyled, while the rest of the contract reaches the build as components come to use it.

Specificity is deliberate: `@theme` emits onto `:root` (0,1,0) while every theme file selects `html[data-theme='…']` (0,1,1), so a theme always wins over the fallback regardless of import order.

- [ ] **Step 1: Create the contract**

Create `apps/board/src/themes/contract.css`:

```css
/*
 * The theme contract. Every theme file under this directory redefines this
 * exact set of variables — no more, no less; themes/contract.test.js fails a
 * theme that drifts. The values here are Material 3 tonal in light, which is
 * both the default theme and the fallback when `data-theme` is never stamped.
 *
 * Keep this file flat: one declaration per line, no nested rules, and no
 * braces inside comments. The contract test parses it with a deliberately
 * dumb regex rather than a CSS parser.
 */
@theme {
  /*
   * Surfaces, outermost to innermost: ground is the page behind everything,
   * surface a card or a panel that sits on it, panel the tinted well a column
   * body forms around its cards, surface-muted a row or chip inside a card,
   * surface-hover its hover state, overlay the scrim behind the detail drawer.
   */
  --color-ground: #fef7ff;
  --color-surface: #fffbff;
  --color-panel: #f7f2fa;
  --color-surface-muted: #f3edf7;
  --color-surface-hover: #ece6f0;
  --color-overlay: rgb(29 27 32 / 0.32);

  /* Hairlines */
  --color-line: #cac4d0;
  --color-line-soft: #e7e0ec;

  /* Text */
  --color-ink-strong: #1d1b20;
  --color-ink: #2b2930;
  --color-ink-soft: #49454f;
  --color-ink-muted: #605d66;
  --color-ink-faint: #79747e;

  /* Accent */
  --color-accent: #6750a4;
  --color-accent-strong: #563f9b;
  --color-on-accent: #ffffff;
  --color-accent-soft: #eaddff;
  --color-on-accent-soft: #21005d;

  /* Status */
  --color-todo-solid: #605d66;
  --color-todo-soft: #ece6f0;
  --color-todo-on-soft: #49454f;
  --color-inprogress-solid: #6750a4;
  --color-inprogress-soft: #eaddff;
  --color-inprogress-on-soft: #21005d;
  --color-question-solid: #b3261e;
  --color-question-soft: #f9dedc;
  --color-question-on-soft: #410e0b;
  --color-done-solid: #386a3c;
  --color-done-soft: #c8efc9;
  --color-done-on-soft: #0a2e0c;
  --color-on-status: #ffffff;
  --color-question-ring: #f2b8b5;
  --color-drop-ring: #7abf7e;

  /* CI badges */
  --color-ci-failure-soft: #f9dedc;
  --color-ci-failure-on-soft: #8c1d18;
  --color-ci-failure-line: #f2b8b5;
  --color-ci-running-soft: #eaddff;
  --color-ci-running-on-soft: #21005d;
  --color-ci-running-line: #d0bcff;
  --color-ci-neutral-soft: #ece6f0;
  --color-ci-neutral-on-soft: #49454f;
  --color-ci-neutral-line: #cac4d0;
  --color-ci-success-soft: #c8efc9;
  --color-ci-success-on-soft: #0a2e0c;
  --color-ci-success-line: #8fd693;

  /* Agent and worktree badges */
  --color-agent-claude-soft: #e8def8;
  --color-agent-claude-on-soft: #1d192b;
  --color-agent-copilot-soft: #ffd8e4;
  --color-agent-copilot-on-soft: #31111d;
  --color-worktree-soft: #d7f0f6;
  --color-worktree-on-soft: #0b3b45;

  /* Chart series */
  --color-series-1: #6750a4;
  --color-series-2: #386a3c;
  --color-series-3: #7d5260;
  --color-series-4: #79747e;
  --color-series-5: #3f5f9e;
  --color-series-6: #8c4a1f;

  /* Shape, spacing and type */
  --radius-card: 1rem;
  --radius-panel: 1rem;
  --radius-control: 0.5rem;
  --radius-badge: 0.25rem;
  --radius-chip: 999px;
  --shadow-card: 0 1px 2px 0 rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15);
  --shadow-panel: none;
  --shadow-overlay: 0 4px 8px 3px rgb(0 0 0 / 0.15), 0 1px 3px 0 rgb(0 0 0 / 0.3);
  --spacing-card: 0.875rem;
  --spacing-gutter: 0.5rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;
}

/*
 * Four properties Tailwind has no namespace for. The component layer in
 * style.css consumes them; themes set them like any other token.
 */
:root {
  --nav-transform: none;
  --nav-tracking: 0.00625em;
  --title-weight: 500;
  --progress-fill: #6750a4;               /* a colour or a gradient — whatever background the progress bar paints */
}
```

- [ ] **Step 2: Wire it into the stylesheet**

In `apps/board/src/style.css`, add the import right after the Tailwind import, and replace the `@layer base` block with one that paints the ground from the tokens:

```css
@import 'tailwindcss' source(none);
@import './themes/contract.css';

@source '../index.html';
@source './**/*.{vue,js}';
```

Then, in the existing `@layer base` block, add these two rules above the ones already there:

```css
@layer base {
  /*
   * The ground used to come from `bg-slate-100` on <main>, so it only painted
   * once Vue had mounted. Painting it on <html> means the stored theme's
   * ground is there on the first frame, with no flash of the default.
   */
  html {
    background: var(--color-ground);
    color: var(--color-ink);
    font-family: var(--font-ui);
  }

  body {
    background: var(--color-ground);
  }
```

Leave the existing `button:not(:disabled)` and `input::placeholder` rules in place, but change the placeholder color to the token:

```css
  input::placeholder,
  textarea::placeholder {
    color: var(--color-ink-faint);
  }
}
```

- [ ] **Step 3: Build to verify the utilities exist**

Run: `npm run board:build`
Expected: the build succeeds.

Do **not** expect to find `bg-surface` or `--color-surface` in the built CSS yet — see the third Tailwind trap in the preamble. At this point only the tokens the new `@layer base` rules reference by `var()` are emitted. Confirm exactly those:

```bash
grep -o -- '--color-ground:\|--color-ink:\|--color-ink-faint:\|--font-ui:' apps/board/dist/assets/*.css | sort -u
```

Expected: all four listed. Everything else in the contract appears in the build only once a component uses its utility, which starts in Task 14.

- [ ] **Step 4: Commit**

```bash
git add apps/board/src/themes/contract.css apps/board/src/style.css
git commit -m "feat(board): declare the theme token contract"
```

---

## Task 4: The contract guard, and the legacy theme

**Files:**
- Create: `apps/board/src/themes/contract.test.js`
- Create: `apps/board/src/themes/legacy.css`
- Modify: `apps/board/src/style.css`

The guard is the test that matters most in this plan: a theme that forgets `--color-ink-faint` would otherwise ship invisible text, and nobody reviews 72 values by eye. Writing it before the first theme file means every theme after it is checked on arrival.

`legacy.css` is a pure transcription of what the board renders today. Do not improve anything in it — a shade that moves is a migration bug.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/themes/contract.test.js`:

```js
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// A deliberately dumb parser: theme files are flat lists of declarations, so
// matching `selector { … }` and pulling the custom property names out is
// enough — and it fails loudly if someone nests a rule or hides a brace in a
// comment, which is exactly the discipline these files need.
function blocks(file) {
  const css = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const out = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.trim().replace(/\s+/g, ' ').replace(/^[\s\S]*\*\//, '').trim();
    const names = [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();
    if (names.length > 0) out[key] = names;
  }
  return out;
}

const contract = blocks('contract.css');
const CONTRACT = [...contract['@theme'], ...contract[':root']].sort();

const THEMEABLE = ['m3', 'expressive', 'classic'];

test('the contract declares 72 variables', () => {
  expect(CONTRACT).toHaveLength(72);
  expect(new Set(CONTRACT).size).toBe(72);
});

test.each(THEMEABLE)('%s defines the whole contract in light', (name) => {
  const light = blocks(`${name}.css`)[`html[data-theme='${name}']`];
  expect(light).toEqual(CONTRACT);
});

test.each(THEMEABLE)('%s defines the whole contract in dark', (name) => {
  const dark = blocks(`${name}.css`)[`html[data-theme='${name}'][data-mode='dark']`];
  expect(dark).toEqual(CONTRACT);
});

test('legacy defines the whole contract and stays light only', () => {
  const found = blocks('legacy.css');
  expect(Object.keys(found)).toEqual(["html[data-theme='legacy']"]);
  expect(found["html[data-theme='legacy']"]).toEqual(CONTRACT);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/themes/contract.test.js --root apps/board`
Expected: FAIL — `ENOENT … legacy.css` (the m3/expressive/classic cases fail the same way; they arrive in Tasks 5 and 6).

- [ ] **Step 3: Write the legacy theme**

Create `apps/board/src/themes/legacy.css`. Every value is what the board renders today; the Tailwind shade each one comes from is in the comment so a reviewer can check it against the component it was lifted from.

```css
/*
 * The board's pre-Material look, frozen. It stays selectable so nobody loses
 * their bearings, but no new work targets it: fix bugs here only if they are
 * migration bugs — a value that no longer matches what the board rendered
 * before this feature. Light only by design; giving it a dark palette would
 * be evolving it.
 *
 * Acceptance: the screenshots in docs/images/board/ must still be accurate
 * with this theme selected.
 */
html[data-theme='legacy'] {
  /* Surfaces */
  --color-ground: #f1f5f9;                  /* slate-100, <main> */
  --color-surface: #ffffff;                 /* cards, panels */
  --color-panel: rgb(255 255 255 / 0.5);    /* column body */
  --color-surface-muted: #f8fafc;           /* slate-50, session rows */
  --color-surface-hover: #f1f5f9;           /* slate-100, table hover */
  --color-overlay: rgb(15 23 42 / 0.3);     /* slate-900/30, detail overlay */

  /* Hairlines */
  --color-line: #e2e8f0;                    /* slate-200 */
  --color-line-soft: #f1f5f9;               /* slate-100 */

  /* Text */
  --color-ink-strong: #0f172a;              /* slate-900, headings */
  --color-ink: #1e293b;                     /* slate-800, card and row titles */
  --color-ink-soft: #475569;                /* slate-600, prompts */
  --color-ink-muted: #64748b;               /* slate-500, meta lines */
  --color-ink-faint: #94a3b8;               /* slate-400, placeholders */

  /* Accent */
  --color-accent: #2563eb;                  /* blue-600, send button */
  --color-accent-strong: #1d4ed8;           /* blue-700, its hover */
  --color-on-accent: #ffffff;
  --color-accent-soft: #eff6ff;             /* blue-50 */
  --color-on-accent-soft: #1d4ed8;          /* blue-700 */

  /* Status */
  --color-todo-solid: #475569;              /* slate-600 */
  --color-todo-soft: #f1f5f9;               /* slate-100 */
  --color-todo-on-soft: #475569;            /* slate-600 */
  --color-inprogress-solid: #2563eb;        /* blue-600 */
  --color-inprogress-soft: #eff6ff;         /* blue-50 */
  --color-inprogress-on-soft: #1d4ed8;      /* blue-700 */
  --color-question-solid: #d97706;          /* amber-600 */
  --color-question-soft: #fffbeb;           /* amber-50 */
  --color-question-on-soft: #b45309;        /* amber-700 */
  --color-done-solid: #059669;              /* emerald-600 */
  --color-done-soft: #ecfdf5;               /* emerald-50 */
  --color-done-on-soft: #047857;            /* emerald-700 */
  --color-on-status: #ffffff;
  --color-question-ring: #fcd34d;           /* amber-300, the question alarm */
  --color-drop-ring: #34d399;               /* emerald-400, drag-to-done */

  /* CI badges */
  --color-ci-failure-soft: #fee2e2;         /* red-100 */
  --color-ci-failure-on-soft: #b91c1c;      /* red-700 */
  --color-ci-failure-line: #fca5a5;         /* red-300 */
  --color-ci-running-soft: #dbeafe;         /* blue-100 */
  --color-ci-running-on-soft: #1d4ed8;      /* blue-700 */
  --color-ci-running-line: #93c5fd;         /* blue-300 */
  --color-ci-neutral-soft: #f1f5f9;         /* slate-100 */
  --color-ci-neutral-on-soft: #475569;      /* slate-600 */
  --color-ci-neutral-line: #cbd5e1;         /* slate-300 */
  --color-ci-success-soft: #d1fae5;         /* emerald-100 */
  --color-ci-success-on-soft: #047857;      /* emerald-700 */
  --color-ci-success-line: #6ee7b7;         /* emerald-300 */

  /* Agent and worktree badges */
  --color-agent-claude-soft: #fef3c7;       /* amber-100 */
  --color-agent-claude-on-soft: #b45309;    /* amber-700 */
  --color-agent-copilot-soft: #e0f2fe;      /* sky-100 */
  --color-agent-copilot-on-soft: #0369a1;   /* sky-700 */
  --color-worktree-soft: #ede9fe;           /* violet-100 */
  --color-worktree-on-soft: #6d28d9;        /* violet-700 */

  /* Chart series — today's hardcoded Chart.js colors */
  --color-series-1: #2563eb;
  --color-series-2: #10b981;
  --color-series-3: #f59e0b;
  --color-series-4: #94a3b8;
  --color-series-5: #8b5cf6;
  --color-series-6: #ec4899;

  /* Shape, spacing and type */
  --radius-card: 0.75rem;                   /* rounded-xl */
  --radius-panel: 0.75rem;                  /* rounded-xl */
  --radius-control: 0.5rem;                 /* rounded-lg */
  --radius-badge: 0.25rem;                  /* rounded-sm */
  --radius-chip: 0.375rem;                  /* rounded-md */
  --shadow-card: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-panel: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-overlay: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);  /* shadow-xl */
  --spacing-card: 0.75rem;                  /* p-3 */
  --spacing-gutter: 0.5rem;                 /* gap-2 */
  --font-ui: ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';

  /* Component-layer properties */
  --nav-transform: none;
  --nav-tracking: 0;
  --title-weight: 600;
  --progress-fill: linear-gradient(90deg, #34d399, #059669);
}
```

- [ ] **Step 4: Import it**

In `apps/board/src/style.css`, below the contract import:

```css
@import './themes/legacy.css';
```

- [ ] **Step 5: Run the test — the legacy case passes, the other three still fail**

Run: `npx vitest run src/themes/contract.test.js --root apps/board`
Expected: the `legacy` test and the `72 variables` test PASS; the six `m3`/`expressive`/`classic` cases FAIL with `ENOENT`. That is the state Task 5 and Task 6 close.

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/themes/contract.test.js apps/board/src/themes/legacy.css apps/board/src/style.css
git commit -m "feat(board): add the legacy theme and the contract guard"
```

---
## Task 5: The Material 3 tonal theme

**Files:**
- Create: `apps/board/src/themes/m3.css`
- Modify: `apps/board/src/style.css`

The light block repeats the values from `contract.css` under the theme selector. That duplication is on purpose: the contract's job is to be the fallback and the canonical list, the theme's job is to be selectable, and the guard test asserts the theme declares the whole set rather than inheriting half of it.

The palette is Material 3's baseline violet seed (`#6750A4`) with its standard role names mapped onto the board's vocabulary: `surface-container-*` become `panel` / `surface-muted` / `surface-hover`, `on-surface-variant` becomes `ink-soft`, `error` becomes the `question` status. Material 3 ships no green role, so `done` uses a custom tonal green built the same way.

- [ ] **Step 1: Write the theme**

Create `apps/board/src/themes/m3.css`:

```css
/*
 * Material 3 tonal — the board's default look.
 *
 * Roles map onto the board's vocabulary like this: surface-container-low is
 * `panel` (column bodies), surface-container is `surface-muted` (session
 * rows), on-surface-variant is `ink-soft`, and the error role carries the
 * `question` status. Material 3 has no green role, so `done` is a tonal green
 * built to the same recipe.
 */
html[data-theme='m3'] {
  --color-ground: #fef7ff;
  --color-surface: #fffbff;
  --color-panel: #f7f2fa;
  --color-surface-muted: #f3edf7;
  --color-surface-hover: #ece6f0;
  --color-overlay: rgb(29 27 32 / 0.32);

  --color-line: #cac4d0;
  --color-line-soft: #e7e0ec;

  --color-ink-strong: #1d1b20;
  --color-ink: #2b2930;
  --color-ink-soft: #49454f;
  --color-ink-muted: #605d66;
  --color-ink-faint: #79747e;

  --color-accent: #6750a4;
  --color-accent-strong: #563f9b;
  --color-on-accent: #ffffff;
  --color-accent-soft: #eaddff;
  --color-on-accent-soft: #21005d;

  --color-todo-solid: #605d66;
  --color-todo-soft: #ece6f0;
  --color-todo-on-soft: #49454f;
  --color-inprogress-solid: #6750a4;
  --color-inprogress-soft: #eaddff;
  --color-inprogress-on-soft: #21005d;
  --color-question-solid: #b3261e;
  --color-question-soft: #f9dedc;
  --color-question-on-soft: #410e0b;
  --color-done-solid: #386a3c;
  --color-done-soft: #c8efc9;
  --color-done-on-soft: #0a2e0c;
  --color-on-status: #ffffff;
  --color-question-ring: #f2b8b5;
  --color-drop-ring: #7abf7e;

  --color-ci-failure-soft: #f9dedc;
  --color-ci-failure-on-soft: #8c1d18;
  --color-ci-failure-line: #f2b8b5;
  --color-ci-running-soft: #eaddff;
  --color-ci-running-on-soft: #21005d;
  --color-ci-running-line: #d0bcff;
  --color-ci-neutral-soft: #ece6f0;
  --color-ci-neutral-on-soft: #49454f;
  --color-ci-neutral-line: #cac4d0;
  --color-ci-success-soft: #c8efc9;
  --color-ci-success-on-soft: #0a2e0c;
  --color-ci-success-line: #8fd693;

  --color-agent-claude-soft: #e8def8;
  --color-agent-claude-on-soft: #1d192b;
  --color-agent-copilot-soft: #ffd8e4;
  --color-agent-copilot-on-soft: #31111d;
  --color-worktree-soft: #d7f0f6;
  --color-worktree-on-soft: #0b3b45;

  --color-series-1: #6750a4;
  --color-series-2: #386a3c;
  --color-series-3: #7d5260;
  --color-series-4: #79747e;
  --color-series-5: #3f5f9e;
  --color-series-6: #8c4a1f;

  --radius-card: 1rem;
  --radius-panel: 1rem;
  --radius-control: 0.5rem;
  --radius-badge: 0.25rem;
  --radius-chip: 999px;
  --shadow-card: 0 1px 2px 0 rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15);
  --shadow-panel: none;
  --shadow-overlay: 0 4px 8px 3px rgb(0 0 0 / 0.15), 0 1px 3px 0 rgb(0 0 0 / 0.3);
  --spacing-card: 0.875rem;
  --spacing-gutter: 0.5rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: none;
  --nav-tracking: 0.00625em;
  --title-weight: 500;
  --progress-fill: #6750a4;
}

/*
 * Dark. `system` is resolved in theme.js, so this one block covers both an
 * explicit dark choice and an OS that asks for dark — there is no media query
 * to keep in sync with it.
 */
html[data-theme='m3'][data-mode='dark'] {
  --color-ground: #141218;
  --color-surface: #1d1b20;
  --color-panel: #211f26;
  --color-surface-muted: #2b2930;
  --color-surface-hover: #36343b;
  --color-overlay: rgb(0 0 0 / 0.5);

  --color-line: #49454f;
  --color-line-soft: #36343b;

  --color-ink-strong: #e6e0e9;
  --color-ink: #ddd7e0;
  --color-ink-soft: #cac4d0;
  --color-ink-muted: #b0a7b8;
  --color-ink-faint: #938f99;

  --color-accent: #d0bcff;
  --color-accent-strong: #e0cfff;
  --color-on-accent: #381e72;
  --color-accent-soft: #4f378b;
  --color-on-accent-soft: #eaddff;

  --color-todo-solid: #938f99;
  --color-todo-soft: #36343b;
  --color-todo-on-soft: #cac4d0;
  --color-inprogress-solid: #d0bcff;
  --color-inprogress-soft: #4f378b;
  --color-inprogress-on-soft: #eaddff;
  --color-question-solid: #f2b8b5;
  --color-question-soft: #8c1d18;
  --color-question-on-soft: #f9dedc;
  --color-done-solid: #8fd693;
  --color-done-soft: #204b24;
  --color-done-on-soft: #c8efc9;
  --color-on-status: #1d1b20;
  --color-question-ring: #b3261e;
  --color-drop-ring: #8fd693;

  --color-ci-failure-soft: #601410;
  --color-ci-failure-on-soft: #f9dedc;
  --color-ci-failure-line: #8c1d18;
  --color-ci-running-soft: #4f378b;
  --color-ci-running-on-soft: #eaddff;
  --color-ci-running-line: #7f67be;
  --color-ci-neutral-soft: #36343b;
  --color-ci-neutral-on-soft: #cac4d0;
  --color-ci-neutral-line: #49454f;
  --color-ci-success-soft: #204b24;
  --color-ci-success-on-soft: #c8efc9;
  --color-ci-success-line: #3c6b40;

  --color-agent-claude-soft: #4a4458;
  --color-agent-claude-on-soft: #e8def8;
  --color-agent-copilot-soft: #633b48;
  --color-agent-copilot-on-soft: #ffd8e4;
  --color-worktree-soft: #14434d;
  --color-worktree-on-soft: #b8e8f2;

  --color-series-1: #d0bcff;
  --color-series-2: #8fd693;
  --color-series-3: #efb8c8;
  --color-series-4: #938f99;
  --color-series-5: #a8c7fa;
  --color-series-6: #f0a868;

  --radius-card: 1rem;
  --radius-panel: 1rem;
  --radius-control: 0.5rem;
  --radius-badge: 0.25rem;
  --radius-chip: 999px;
  --shadow-card: 0 1px 2px 0 rgb(0 0 0 / 0.6), 0 1px 3px 1px rgb(0 0 0 / 0.3);
  --shadow-panel: none;
  --shadow-overlay: 0 4px 8px 3px rgb(0 0 0 / 0.4), 0 1px 3px 0 rgb(0 0 0 / 0.6);
  --spacing-card: 0.875rem;
  --spacing-gutter: 0.5rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: none;
  --nav-tracking: 0.00625em;
  --title-weight: 500;
  --progress-fill: #d0bcff;
}
```

- [ ] **Step 2: Import it**

In `apps/board/src/style.css`, above the legacy import (import order does not decide the winner — the theme selectors all have the same specificity and are mutually exclusive — but keeping them in picker order makes the file readable):

```css
@import './themes/m3.css';
```

- [ ] **Step 3: Run the guard**

Run: `npx vitest run src/themes/contract.test.js --root apps/board`
Expected: the two `m3` cases PASS; `expressive` and `classic` still FAIL with `ENOENT`.

- [ ] **Step 4: Commit**

```bash
git add apps/board/src/themes/m3.css apps/board/src/style.css
git commit -m "feat(board): add the Material 3 tonal theme"
```

---

## Task 6: The Expressive and Classic themes

**Files:**
- Create: `apps/board/src/themes/expressive.css`
- Create: `apps/board/src/themes/classic.css`
- Modify: `apps/board/src/style.css`

Both files carry the same 72 variables in the same order as `m3.css` — copy that file and replace the values. The guard test is what tells you a variable went missing.

**Expressive** leans on color rather than elevation: shadows are `none`, radii are large, `--title-weight` is 700. **Classic** is the Material everyone recognizes: indigo 500 with a pink accent, 4px radii, real elevation shadows, uppercase nav with wide tracking.

- [ ] **Step 1: Write the Expressive theme**

Create `apps/board/src/themes/expressive.css` with the two blocks below.

```css
/*
 * Material 3 Expressive — color does the work that elevation does elsewhere:
 * no card shadows, large radii, heavy titles, saturated status containers.
 */
html[data-theme='expressive'] {
  --color-ground: #fdf7ff;
  --color-surface: #ffffff;
  --color-panel: #eceef5;
  --color-surface-muted: #f2eff7;
  --color-surface-hover: #e9e6ff;
  --color-overlay: rgb(27 27 33 / 0.35);

  --color-line: #d9d5e8;
  --color-line-soft: #ece9f5;

  --color-ink-strong: #1b1b21;
  --color-ink: #26262e;
  --color-ink-soft: #45464f;
  --color-ink-muted: #5a5b66;
  --color-ink-faint: #767680;

  --color-accent: #5a47e0;
  --color-accent-strong: #4535c4;
  --color-on-accent: #ffffff;
  --color-accent-soft: #e4deff;
  --color-on-accent-soft: #241c78;

  --color-todo-solid: #5a5b66;
  --color-todo-soft: #eceef5;
  --color-todo-on-soft: #45464f;
  --color-inprogress-solid: #5a47e0;
  --color-inprogress-soft: #e4deff;
  --color-inprogress-on-soft: #241c78;
  --color-question-solid: #b3245e;
  --color-question-soft: #ffd9e4;
  --color-question-on-soft: #5c0f38;
  --color-done-solid: #0f7a4e;
  --color-done-soft: #c8f0db;
  --color-done-on-soft: #0b4d33;
  --color-on-status: #ffffff;
  --color-question-ring: #ffb1c8;
  --color-drop-ring: #4fc28c;

  --color-ci-failure-soft: #ffd9e4;
  --color-ci-failure-on-soft: #5c0f38;
  --color-ci-failure-line: #ffb1c8;
  --color-ci-running-soft: #e4deff;
  --color-ci-running-on-soft: #241c78;
  --color-ci-running-line: #b9aeff;
  --color-ci-neutral-soft: #eceef5;
  --color-ci-neutral-on-soft: #45464f;
  --color-ci-neutral-line: #d0d2de;
  --color-ci-success-soft: #c8f0db;
  --color-ci-success-on-soft: #0b4d33;
  --color-ci-success-line: #7fd7a8;

  --color-agent-claude-soft: #e0dbff;
  --color-agent-claude-on-soft: #241c78;
  --color-agent-copilot-soft: #ffd9e4;
  --color-agent-copilot-on-soft: #5c0f38;
  --color-worktree-soft: #c8f0db;
  --color-worktree-on-soft: #0b4d33;

  --color-series-1: #5a47e0;
  --color-series-2: #0f7a4e;
  --color-series-3: #b3245e;
  --color-series-4: #767680;
  --color-series-5: #2e6bd9;
  --color-series-6: #c4611a;

  --radius-card: 1.375rem;
  --radius-panel: 1.75rem;
  --radius-control: 999px;
  --radius-badge: 999px;
  --radius-chip: 999px;
  --shadow-card: none;
  --shadow-panel: none;
  --shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.18);
  --spacing-card: 1rem;
  --spacing-gutter: 0.625rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: none;
  --nav-tracking: 0;
  --title-weight: 700;
  --progress-fill: #5a47e0;
}

html[data-theme='expressive'][data-mode='dark'] {
  --color-ground: #131318;
  --color-surface: #1e1e26;
  --color-panel: #22222c;
  --color-surface-muted: #2a2a36;
  --color-surface-hover: #343444;
  --color-overlay: rgb(0 0 0 / 0.55);

  --color-line: #45465a;
  --color-line-soft: #2e2e3c;

  --color-ink-strong: #ededf4;
  --color-ink: #e2e2ec;
  --color-ink-soft: #c9c9d6;
  --color-ink-muted: #a9a9b8;
  --color-ink-faint: #8a8a99;

  --color-accent: #bfb2ff;
  --color-accent-strong: #d6ccff;
  --color-on-accent: #241c78;
  --color-accent-soft: #3a2f86;
  --color-on-accent-soft: #e4deff;

  --color-todo-solid: #a9a9b8;
  --color-todo-soft: #2a2a36;
  --color-todo-on-soft: #c9c9d6;
  --color-inprogress-solid: #bfb2ff;
  --color-inprogress-soft: #3a2f86;
  --color-inprogress-on-soft: #e4deff;
  --color-question-solid: #ffb1c8;
  --color-question-soft: #6b1238;
  --color-question-on-soft: #ffd9e4;
  --color-done-solid: #7fd7a8;
  --color-done-soft: #11402b;
  --color-done-on-soft: #c8f0db;
  --color-on-status: #131318;
  --color-question-ring: #b3245e;
  --color-drop-ring: #7fd7a8;

  --color-ci-failure-soft: #6b1238;
  --color-ci-failure-on-soft: #ffd9e4;
  --color-ci-failure-line: #a3315f;
  --color-ci-running-soft: #3a2f86;
  --color-ci-running-on-soft: #e4deff;
  --color-ci-running-line: #6d5cc4;
  --color-ci-neutral-soft: #2a2a36;
  --color-ci-neutral-on-soft: #c9c9d6;
  --color-ci-neutral-line: #45465a;
  --color-ci-success-soft: #11402b;
  --color-ci-success-on-soft: #c8f0db;
  --color-ci-success-line: #2f7150;

  --color-agent-claude-soft: #3a2f86;
  --color-agent-claude-on-soft: #e4deff;
  --color-agent-copilot-soft: #6b1238;
  --color-agent-copilot-on-soft: #ffd9e4;
  --color-worktree-soft: #11402b;
  --color-worktree-on-soft: #c8f0db;

  --color-series-1: #bfb2ff;
  --color-series-2: #7fd7a8;
  --color-series-3: #ffb1c8;
  --color-series-4: #a9a9b8;
  --color-series-5: #8fb6ff;
  --color-series-6: #f0a868;

  --radius-card: 1.375rem;
  --radius-panel: 1.75rem;
  --radius-control: 999px;
  --radius-badge: 999px;
  --radius-chip: 999px;
  --shadow-card: none;
  --shadow-panel: none;
  --shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.5);
  --spacing-card: 1rem;
  --spacing-gutter: 0.625rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: none;
  --nav-tracking: 0;
  --title-weight: 700;
  --progress-fill: #bfb2ff;
}
```

- [ ] **Step 2: Write the Classic theme**

Create `apps/board/src/themes/classic.css`:

```css
/*
 * Material of the M2 era: indigo 500 with a pink accent, 4px corners, real
 * elevation shadows, uppercase nav. Dense and familiar.
 */
html[data-theme='classic'] {
  --color-ground: #fafafa;
  --color-surface: #ffffff;
  --color-panel: #f5f5f5;
  --color-surface-muted: #fafafa;
  --color-surface-hover: #eeeeee;
  --color-overlay: rgb(0 0 0 / 0.5);

  --color-line: rgb(0 0 0 / 0.12);
  --color-line-soft: rgb(0 0 0 / 0.06);

  --color-ink-strong: rgb(0 0 0 / 0.87);
  --color-ink: rgb(0 0 0 / 0.8);
  --color-ink-soft: rgb(0 0 0 / 0.6);
  --color-ink-muted: rgb(0 0 0 / 0.54);
  --color-ink-faint: rgb(0 0 0 / 0.38);

  --color-accent: #3f51b5;
  --color-accent-strong: #303f9f;
  --color-on-accent: #ffffff;
  --color-accent-soft: #e8eaf6;
  --color-on-accent-soft: #303f9f;

  --color-todo-solid: #616161;
  --color-todo-soft: #f5f5f5;
  --color-todo-on-soft: #424242;
  --color-inprogress-solid: #3f51b5;
  --color-inprogress-soft: #e8eaf6;
  --color-inprogress-on-soft: #303f9f;
  --color-question-solid: #f57c00;
  --color-question-soft: #fff3e0;
  --color-question-on-soft: #e65100;
  --color-done-solid: #388e3c;
  --color-done-soft: #e8f5e9;
  --color-done-on-soft: #2e7d32;
  --color-on-status: #ffffff;
  --color-question-ring: #ffb74d;
  --color-drop-ring: #81c784;

  --color-ci-failure-soft: #ffebee;
  --color-ci-failure-on-soft: #c62828;
  --color-ci-failure-line: #ef9a9a;
  --color-ci-running-soft: #e8eaf6;
  --color-ci-running-on-soft: #303f9f;
  --color-ci-running-line: #9fa8da;
  --color-ci-neutral-soft: #f5f5f5;
  --color-ci-neutral-on-soft: #616161;
  --color-ci-neutral-line: #e0e0e0;
  --color-ci-success-soft: #e8f5e9;
  --color-ci-success-on-soft: #2e7d32;
  --color-ci-success-line: #a5d6a7;

  --color-agent-claude-soft: #e8eaf6;
  --color-agent-claude-on-soft: #303f9f;
  --color-agent-copilot-soft: #e0f7fa;
  --color-agent-copilot-on-soft: #00697a;
  --color-worktree-soft: #fce4ec;
  --color-worktree-on-soft: #ad1457;

  --color-series-1: #3f51b5;
  --color-series-2: #388e3c;
  --color-series-3: #f57c00;
  --color-series-4: #9e9e9e;
  --color-series-5: #00838f;
  --color-series-6: #c2185b;

  --radius-card: 0.25rem;
  --radius-panel: 0.25rem;
  --radius-control: 0.25rem;
  --radius-badge: 0.125rem;
  --radius-chip: 0.125rem;
  --shadow-card: 0 1px 3px rgb(0 0 0 / 0.12), 0 1px 2px rgb(0 0 0 / 0.24);
  --shadow-panel: 0 1px 3px rgb(0 0 0 / 0.12);
  --shadow-overlay: 0 8px 10px -5px rgb(0 0 0 / 0.2), 0 16px 24px 2px rgb(0 0 0 / 0.14), 0 6px 30px 5px rgb(0 0 0 / 0.12);
  --spacing-card: 0.875rem;
  --spacing-gutter: 0.5rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: uppercase;
  --nav-tracking: 0.09em;
  --title-weight: 500;
  --progress-fill: #3f51b5;
}

html[data-theme='classic'][data-mode='dark'] {
  --color-ground: #121212;
  --color-surface: #1e1e1e;
  --color-panel: #242424;
  --color-surface-muted: #1a1a1a;
  --color-surface-hover: #2c2c2c;
  --color-overlay: rgb(0 0 0 / 0.6);

  --color-line: rgb(255 255 255 / 0.12);
  --color-line-soft: rgb(255 255 255 / 0.06);

  --color-ink-strong: rgb(255 255 255 / 0.87);
  --color-ink: rgb(255 255 255 / 0.8);
  --color-ink-soft: rgb(255 255 255 / 0.7);
  --color-ink-muted: rgb(255 255 255 / 0.6);
  --color-ink-faint: rgb(255 255 255 / 0.38);

  --color-accent: #9fa8da;
  --color-accent-strong: #c5cae9;
  --color-on-accent: #1a237e;
  --color-accent-soft: #283593;
  --color-on-accent-soft: #e8eaf6;

  --color-todo-solid: #9e9e9e;
  --color-todo-soft: #2c2c2c;
  --color-todo-on-soft: #e0e0e0;
  --color-inprogress-solid: #9fa8da;
  --color-inprogress-soft: #283593;
  --color-inprogress-on-soft: #e8eaf6;
  --color-question-solid: #ffb74d;
  --color-question-soft: #5d3a00;
  --color-question-on-soft: #ffe0b2;
  --color-done-solid: #81c784;
  --color-done-soft: #1b5e20;
  --color-done-on-soft: #c8e6c9;
  --color-on-status: #121212;
  --color-question-ring: #f57c00;
  --color-drop-ring: #81c784;

  --color-ci-failure-soft: #5c1a1a;
  --color-ci-failure-on-soft: #ef9a9a;
  --color-ci-failure-line: #8e3a3a;
  --color-ci-running-soft: #283593;
  --color-ci-running-on-soft: #c5cae9;
  --color-ci-running-line: #5c6bc0;
  --color-ci-neutral-soft: #2c2c2c;
  --color-ci-neutral-on-soft: #bdbdbd;
  --color-ci-neutral-line: #424242;
  --color-ci-success-soft: #1b5e20;
  --color-ci-success-on-soft: #a5d6a7;
  --color-ci-success-line: #2e7d32;

  --color-agent-claude-soft: #283593;
  --color-agent-claude-on-soft: #c5cae9;
  --color-agent-copilot-soft: #004d5a;
  --color-agent-copilot-on-soft: #80deea;
  --color-worktree-soft: #4a0e2a;
  --color-worktree-on-soft: #f8bbd0;

  --color-series-1: #9fa8da;
  --color-series-2: #81c784;
  --color-series-3: #ffb74d;
  --color-series-4: #bdbdbd;
  --color-series-5: #4dd0e1;
  --color-series-6: #f06292;

  --radius-card: 0.25rem;
  --radius-panel: 0.25rem;
  --radius-control: 0.25rem;
  --radius-badge: 0.125rem;
  --radius-chip: 0.125rem;
  --shadow-card: 0 1px 3px rgb(0 0 0 / 0.5), 0 1px 2px rgb(0 0 0 / 0.6);
  --shadow-panel: 0 1px 3px rgb(0 0 0 / 0.5);
  --shadow-overlay: 0 8px 10px -5px rgb(0 0 0 / 0.5), 0 16px 24px 2px rgb(0 0 0 / 0.4), 0 6px 30px 5px rgb(0 0 0 / 0.35);
  --spacing-card: 0.875rem;
  --spacing-gutter: 0.5rem;
  --font-ui: Roboto, ui-sans-serif, system-ui, sans-serif;

  --nav-transform: uppercase;
  --nav-tracking: 0.09em;
  --title-weight: 500;
  --progress-fill: #9fa8da;
}
```

- [ ] **Step 3: Import both**

In `apps/board/src/style.css`, between the m3 and legacy imports:

```css
@import './themes/expressive.css';
@import './themes/classic.css';
```

- [ ] **Step 4: Run the guard — all eight cases pass**

Run: `npx vitest run src/themes/contract.test.js --root apps/board`
Expected: PASS, 8 assertions (the count, three light themes, three dark themes, legacy).

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/themes/expressive.css apps/board/src/themes/classic.css apps/board/src/style.css
git commit -m "feat(board): add the Expressive and Classic themes"
```

---
## Task 7: The theme picker

**Files:**
- Create: `apps/board/src/ThemeSwitcher.vue`
- Test: `apps/board/src/ThemeSwitcher.test.js`

Modeled on `LocaleSwitcher.vue`: a native `<select>`, because it is keyboard-accessible and screen-reader-friendly for free, and there is no bespoke menu to maintain. Read that component first; this one is its twin.

`theme.js` holds module-level refs, so the test resets them in `afterEach` exactly as `i18n.test.js` resets `locale`.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/ThemeSwitcher.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ThemeSwitcher from './ThemeSwitcher.vue';
import { DEFAULT_THEME, DEFAULT_MODE, theme, mode } from './theme.js';
import { DEFAULT_LOCALE, locale, setLocale } from './i18n.js';

afterEach(() => {
  theme.value = DEFAULT_THEME;
  mode.value = DEFAULT_MODE;
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
});

test('lists the four themes with the active one selected', () => {
  const w = mount(ThemeSwitcher);
  const select = w.get('[data-test=theme]');
  expect(select.findAll('option').map((o) => o.attributes('value')))
    .toEqual(['m3', 'expressive', 'classic', 'legacy']);
  expect(select.element.value).toBe('m3');
});

test('translates the theme names', () => {
  const w = mount(ThemeSwitcher);
  expect(w.text()).toContain('Material 3 Expressive');
  expect(w.text()).toContain('Legacy (frozen)');

  setLocale('fr', { storage: window.localStorage, doc: null });
  const fr = mount(ThemeSwitcher);
  expect(fr.text()).toContain('Material classique');
  expect(fr.text()).toContain('Historique (figé)');
});

test('picking a theme stamps the document and persists the choice', async () => {
  const w = mount(ThemeSwitcher);
  await w.get('[data-test=theme]').setValue('classic');
  expect(theme.value).toBe('classic');
  expect(document.documentElement.getAttribute('data-theme')).toBe('classic');
  expect(window.localStorage.getItem('maggie:theme')).toBe('classic');
});

test('labels itself for assistive technology', () => {
  const w = mount(ThemeSwitcher);
  expect(w.get('[data-test=theme]').attributes('aria-label')).toBe('Theme');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ThemeSwitcher.test.js --root apps/board`
Expected: FAIL — `Failed to resolve import "./ThemeSwitcher.vue"`.

- [ ] **Step 3: Write the component**

Create `apps/board/src/ThemeSwitcher.vue`:

```vue
<script setup>
import { useTheme } from './theme.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();
const { theme, setTheme, themes } = useTheme();
</script>

<template>
  <select
    data-test="theme"
    :value="theme"
    :aria-label="t('nav.theme')"
    :title="t('nav.theme')"
    class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    @change="setTheme($event.target.value)"
  >
    <option v-for="th in themes" :key="th.code" :value="th.code">{{ t(th.labelKey) }}</option>
  </select>
</template>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ThemeSwitcher.test.js --root apps/board`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/ThemeSwitcher.vue apps/board/src/ThemeSwitcher.test.js
git commit -m "feat(board): add the theme picker"
```

---

## Task 8: The light/dark/system picker

**Files:**
- Create: `apps/board/src/ModeSwitcher.vue`
- Test: `apps/board/src/ModeSwitcher.test.js`

Same shape as Task 7, with one rule of its own: on a light-only theme the control is disabled and says why. The stored preference is left alone — this component never clears it.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/ModeSwitcher.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModeSwitcher from './ModeSwitcher.vue';
import { DEFAULT_THEME, DEFAULT_MODE, theme, mode, setTheme } from './theme.js';
import { DEFAULT_LOCALE, locale } from './i18n.js';

afterEach(() => {
  theme.value = DEFAULT_THEME;
  mode.value = DEFAULT_MODE;
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
});

test('lists the three modes with the active one selected', () => {
  const w = mount(ModeSwitcher);
  const select = w.get('[data-test=mode]');
  expect(select.findAll('option').map((o) => o.attributes('value')))
    .toEqual(['light', 'dark', 'system']);
  expect(select.element.value).toBe('system');
});

test('picking a mode stamps the document and persists the choice', async () => {
  const w = mount(ModeSwitcher);
  await w.get('[data-test=mode]').setValue('dark');
  expect(mode.value).toBe('dark');
  expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
  expect(window.localStorage.getItem('maggie:mode')).toBe('dark');
});

test('is disabled on a light-only theme and explains why', async () => {
  setTheme('legacy', { storage: window.localStorage, doc: document });
  const w = mount(ModeSwitcher);
  const select = w.get('[data-test=mode]');
  expect(select.attributes('disabled')).toBeDefined();
  expect(select.attributes('title')).toBe('The legacy theme is light only.');
});

test('leaves the stored preference alone while disabled', async () => {
  const storage = window.localStorage;
  setTheme('m3', { storage, doc: document });
  mount(ModeSwitcher);
  const w = mount(ModeSwitcher);
  await w.get('[data-test=mode]').setValue('dark');
  setTheme('legacy', { storage, doc: document });
  expect(storage.getItem('maggie:mode')).toBe('dark');
  expect(mode.value).toBe('dark');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ModeSwitcher.test.js --root apps/board`
Expected: FAIL — `Failed to resolve import "./ModeSwitcher.vue"`.

- [ ] **Step 3: Write the component**

Create `apps/board/src/ModeSwitcher.vue`:

```vue
<script setup>
import { computed } from 'vue';
import { useTheme } from './theme.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();
const { theme, mode, setMode, modes, isLightOnly } = useTheme();

// A frozen theme has no dark palette, so the control goes quiet rather than
// silently doing nothing. The stored preference is untouched and applies
// again as soon as a themeable theme is selected.
const locked = computed(() => isLightOnly(theme.value));
</script>

<template>
  <select
    data-test="mode"
    :value="mode"
    :disabled="locked"
    :aria-label="t('nav.mode')"
    :title="locked ? t('mode.legacyLocked') : t('nav.mode')"
    class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
    @change="setMode($event.target.value)"
  >
    <option v-for="m in modes" :key="m.code" :value="m.code">{{ t(m.labelKey) }}</option>
  </select>
</template>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ModeSwitcher.test.js --root apps/board`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/ModeSwitcher.vue apps/board/src/ModeSwitcher.test.js
git commit -m "feat(board): add the light, dark and system picker"
```

---

## Task 9: Mount the pickers and initialise at boot

**Files:**
- Modify: `apps/board/src/main.js`
- Modify: `apps/board/src/App.vue:56-70` (the header's right-hand control group)
- Test: `apps/board/src/App.test.js`

After this task the pickers work end to end — but nothing on screen changes yet, because every component still carries its own literal Tailwind classes. That gap closes in Tasks 14 to 17. Do not jump ahead to "fix" it.

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/App.test.js` (it already has `mountApp` and `routedFetch` helpers, and an `afterEach` that clears `localStorage`):

```js
test('the header carries the theme and mode pickers', async () => {
  const { wrapper } = await mountApp(routedFetch());
  expect(wrapper.find('[data-test=theme]').exists()).toBe(true);
  expect(wrapper.find('[data-test=mode]').exists()).toBe(true);
  expect(wrapper.find('[data-test=locale]').exists()).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.test.js --root apps/board -t 'theme and mode pickers'`
Expected: FAIL — `expected false to be true`.

- [ ] **Step 3: Mount the pickers**

In `apps/board/src/App.vue`, add the imports next to the existing `LocaleSwitcher` import:

```js
import ThemeSwitcher from './ThemeSwitcher.vue';
import ModeSwitcher from './ModeSwitcher.vue';
```

and put them ahead of the language picker in the header's control group, so appearance reads as one group:

```html
      <div class="flex items-center gap-2 flex-wrap">
        <ThemeSwitcher />
        <ModeSwitcher />
        <LocaleSwitcher />
```

- [ ] **Step 4: Initialise at boot**

In `apps/board/src/main.js`, import and call `initTheme` next to `initLocale` — before `mount()`, so the right theme is stamped on the first frame:

```js
import { createApp } from 'vue';
import App from './App.vue';
import { createBoardRouter } from './router.js';
import { initLocale } from './i18n.js';
import { initTheme } from './theme.js';
import './style.css';

initLocale();
initTheme();

const app = createApp(App);
app.use(createBoardRouter());
app.mount('#app');
```

- [ ] **Step 5: Run the board's suite to verify it passes**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 6: Check it by hand**

Run: `npm start`, open http://localhost:4180, switch themes in the picker and confirm with devtools that `<html>` carries `data-theme` and `data-mode`, that `data-mode` reads `light` or `dark` but never `system`, and that the choice survives a reload. Selecting `Legacy (frozen)` must grey out the mode picker.

- [ ] **Step 7: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/main.js apps/board/src/App.test.js
git commit -m "feat(board): mount the theme pickers in the header"
```

---

## Task 10: Status styles on tokens

**Files:**
- Modify: `apps/board/src/statusStyles.js`
- Test: `apps/board/src/Card.test.js:29-32`, `apps/board/src/Column.test.js`

`statusStyles.js` stays the single source of truth for per-status classes — only its values change. Every class is a complete literal string, because Tailwind's scanner cannot see a class it has to assemble.

`Card.test.js` currently asserts `toContain('ring-amber-300')`, which is the literal amber the question card used. That assertion is what makes this a red-to-green task.

- [ ] **Step 1: Point the test at the semantic class**

In `apps/board/src/Card.test.js`, in the test `highlights a question card`:

```js
test('highlights a question card', () => {
  const w = mount(Card, { props: { name: 'oc-auth', sessions: [session()], status: 'question', now } });
  expect(w.classes().join(' ')).toContain('ring-question-ring');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/Card.test.js --root apps/board -t 'highlights a question card'`
Expected: FAIL — the class list still reads `ring-2 ring-amber-300`.

- [ ] **Step 3: Rewrite the styles**

Replace the body of `apps/board/src/statusStyles.js`:

```js
// apps/board/src/statusStyles.js
// Semantic classes only — the hues live in the theme files under
// apps/board/src/themes/, so a theme can restyle every status at once. The
// human-readable column labels live in the i18n catalogs under `status.<key>`.
//
// Each string must stay a complete literal: Tailwind's scanner cannot see a
// class name that is assembled at runtime.
export const STATUS_STYLES = {
  todo: {
    pill: 'bg-todo-solid text-on-status',
    border: 'border-todo-solid',
    chip: 'bg-todo-soft text-todo-on-soft',
  },
  inprogress: {
    pill: 'bg-inprogress-solid text-on-status',
    border: 'border-inprogress-solid',
    chip: 'bg-inprogress-soft text-inprogress-on-soft',
  },
  question: {
    pill: 'bg-question-solid text-on-status',
    border: 'border-question-solid',
    chip: 'bg-question-soft text-question-on-soft',
    ring: 'ring-2 ring-question-ring',
  },
  done: {
    pill: 'bg-done-solid text-on-status',
    border: 'border-done-solid',
    chip: 'bg-done-soft text-done-on-soft',
  },
};

export const STATUS_ORDER = ['todo', 'inprogress', 'question', 'done'];
```

- [ ] **Step 4: Update the drop-zone ring in `Column.vue`**

`Column.test.js` asserts on `ring-2`, which survives, but the hue must stop being literal. In `apps/board/src/Column.vue`, in the `:class` binding on `[data-test=column-body]`:

```html
      :class="['flex flex-col gap-gutter bg-panel rounded-panel p-2 min-h-[4rem]',
               dragOver ? 'ring-2 ring-drop-ring' : '']"
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `npx vitest run src/Card.test.js src/Column.test.js --root apps/board`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/statusStyles.js apps/board/src/Column.vue apps/board/src/Card.test.js
git commit -m "refactor(board): move the status styles onto theme tokens"
```

---

## Task 11: Badge styles on tokens

**Files:**
- Modify: `apps/board/src/ciBadge.js:5-10`
- Modify: `apps/board/src/agentBadge.js:11-14`
- Test: `apps/board/src/Card.test.js:45-51`, `apps/board/src/SessionRow.test.js:136-142`, `apps/board/src/ciBadge.test.js`

CI and agent badges keep families of their own rather than borrowing the status colors: today's CI running badge is `blue-100` where the `inprogress` chip is `blue-50`, and CI failure is red where `question` is amber. Borrowing would shift `legacy` by a shade, which its freeze forbids.

- [ ] **Step 1: Point the tests at the semantic classes**

In `apps/board/src/Card.test.js`, in `renders one badge per contributor, worst first`:

```js
  expect(badges[0].classes().join(' ')).toContain('ci-failure');
```

In `apps/board/src/SessionRow.test.js`, in `shows a copilot badge for a session recorded by the GitHub Copilot hooks`:

```js
  expect(badge.classes().join(' ')).toContain('agent-copilot');
```

Then check `apps/board/src/ciBadge.test.js` for any assertion naming a Tailwind hue:

```bash
grep -n "red\|blue\|slate\|emerald" apps/board/src/ciBadge.test.js
```

Any hit becomes its semantic equivalent — `bg-red-100 …` becomes `bg-ci-failure-soft text-ci-failure-on-soft border-ci-failure-line`, and so on for `running`, `neutral` and `success`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/Card.test.js src/SessionRow.test.js src/ciBadge.test.js --root apps/board`
Expected: FAIL on the two assertions above (plus any in `ciBadge.test.js`).

- [ ] **Step 3: Rewrite the badge classes**

In `apps/board/src/ciBadge.js`, replace the `PILL` map:

```js
const PILL = {
  failure: 'bg-ci-failure-soft text-ci-failure-on-soft border-ci-failure-line',
  running: 'bg-ci-running-soft text-ci-running-on-soft border-ci-running-line animate-pulse',
  neutral: 'bg-ci-neutral-soft text-ci-neutral-on-soft border-ci-neutral-line',
  success: 'bg-ci-success-soft text-ci-success-on-soft border-ci-success-line',
};
```

In `apps/board/src/agentBadge.js`, replace the `PILL` map and the fallback in `agentPillClass`:

```js
const PILL = {
  claude: 'bg-agent-claude-soft text-agent-claude-on-soft',
  copilot: 'bg-agent-copilot-soft text-agent-copilot-on-soft',
};
```

```js
export function agentPillClass(agent) {
  return PILL[agent] ?? 'bg-ci-neutral-soft text-ci-neutral-on-soft';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/Card.test.js src/SessionRow.test.js src/ciBadge.test.js src/agentBadge.test.js --root apps/board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/ciBadge.js apps/board/src/agentBadge.js apps/board/src/Card.test.js apps/board/src/SessionRow.test.js apps/board/src/ciBadge.test.js
git commit -m "refactor(board): move the CI and agent badges onto theme tokens"
```

---
## Task 12: Icons as inline SVG, with the legacy emoji twin

**Files:**
- Create: `apps/board/src/icons.js` (generated, then committed)
- Create: `apps/board/src/Icon.vue`
- Test: `apps/board/src/Icon.test.js`
- Modify: `apps/board/src/style.css`

The board shows seven glyphs today, all emoji: 🔔 🔊 🔇 🔍 ⎇ ✕ ⚠ (and ↩ in the detail panel's pending list). The Material themes want Material Symbols; `legacy` must keep the emoji exactly.

**Do not hand-write the path data.** Extract it from Google's own SVG package, then drop the package — the board ships the paths, not the dependency. The `material-symbols` font package is several megabytes for glyphs the board does not use; eight inline paths are about 3 KB and work offline by construction.

- [ ] **Step 1: Generate `icons.js` from Google's SVGs**

```bash
npm install --no-save @material-symbols/svg-400

cat > /tmp/gen-icons.mjs <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = ['notifications', 'volume_up', 'volume_off', 'search', 'account_tree', 'close', 'warning', 'reply'];

const entries = NAMES.map((name) => {
  const svg = readFileSync(`node_modules/@material-symbols/svg-400/rounded/${name}.svg`, 'utf8');
  const d = svg.match(/ d="([^"]+)"/)[1];
  return `  ${name}: '${d}',`;
});

const lines = [
  '// Material Symbols Rounded, weight 400, extracted from @material-symbols/svg-400.',
  '// Inline rather than an icon font: the font package is several megabytes for',
  '// glyphs the board does not use, and the board has to work offline.',
  '// Regenerate with the snippet in',
  '// docs/superpowers/plans/2026-09-14-board-material-themes.md (Task 12).',
  '',
  "export const ICON_VIEWBOX = '0 -960 960 960';",
  '',
  'export const ICONS = {',
  ...entries,
  '};',
  '',
];

writeFileSync('apps/board/src/icons.js', lines.join('\n'));
EOF

node /tmp/gen-icons.mjs
npm uninstall --no-save @material-symbols/svg-400
head -12 apps/board/src/icons.js
```

Expected: `icons.js` exists, exports `ICONS` with eight keys whose values start with `M`.

- [ ] **Step 2: Write the failing test**

Create `apps/board/src/Icon.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Icon from './Icon.vue';
import { ICONS } from './icons.js';
import { DEFAULT_THEME, theme } from './theme.js';

afterEach(() => { theme.value = DEFAULT_THEME; });

test('renders the requested glyph', () => {
  const w = mount(Icon, { props: { name: 'notifications' } });
  expect(w.get('svg path').attributes('d')).toBe(ICONS.notifications);
});

test('renders the legacy emoji twin alongside it, marked for the theme to pick', () => {
  const w = mount(Icon, { props: { name: 'notifications', emoji: '🔔' } });
  expect(w.get('.icon').classes()).toContain('has-emoji');
  expect(w.get('.icon-emoji').text()).toBe('🔔');
  expect(w.find('.icon-symbol').exists()).toBe(true);
});

test('carries no emoji twin when none is given', () => {
  const w = mount(Icon, { props: { name: 'search' } });
  expect(w.get('.icon').classes()).not.toContain('has-emoji');
  expect(w.find('.icon-emoji').exists()).toBe(false);
});

test('is hidden from assistive technology — the label lives in the neighboring text', () => {
  const w = mount(Icon, { props: { name: 'close', emoji: '✕' } });
  expect(w.get('.icon').attributes('aria-hidden')).toBe('true');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/Icon.test.js --root apps/board`
Expected: FAIL — `Failed to resolve import "./Icon.vue"`.

- [ ] **Step 4: Write the component**

Create `apps/board/src/Icon.vue`:

```vue
<script setup>
import { computed } from 'vue';
import { ICONS, ICON_VIEWBOX } from './icons.js';

const props = defineProps({
  name: { type: String, required: true },
  // What the legacy theme shows instead of the glyph. Both are rendered; CSS
  // picks one, so no call site needs a conditional.
  emoji: { type: String, default: '' },
  size: { type: Number, default: 18 },
});

const path = computed(() => ICONS[props.name]);
</script>

<template>
  <span :class="['icon', emoji ? 'has-emoji' : '']" aria-hidden="true">
    <svg
      class="icon-symbol" :width="size" :height="size"
      :viewBox="ICON_VIEWBOX" fill="currentColor" focusable="false"
    ><path :d="path" /></svg>
    <span v-if="emoji" class="icon-emoji">{{ emoji }}</span>
  </span>
</template>
```

- [ ] **Step 5: Let the theme pick which twin shows**

In `apps/board/src/style.css`, add a `@layer components` block (it will grow in Task 17):

```css
@layer components {
  .icon {
    display: inline-flex;
    align-items: center;
    vertical-align: -0.2em;
  }

  /* Material themes show the glyph; legacy keeps the emoji it always had. */
  .icon-emoji { display: none; }
  html[data-theme='legacy'] .icon.has-emoji .icon-symbol { display: none; }
  html[data-theme='legacy'] .icon.has-emoji .icon-emoji { display: inline; }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/Icon.test.js --root apps/board`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/board/src/icons.js apps/board/src/Icon.vue apps/board/src/Icon.test.js apps/board/src/style.css
git commit -m "feat(board): add inline Material Symbols with a legacy emoji twin"
```

---

## Task 13: Roboto, served locally

**Files:**
- Modify: `apps/board/package.json`
- Modify: `apps/board/src/style.css`

Material's typeface, without a runtime network request: the project is offline-minded (`--offline` on the workspace CLI, a CI reader that "never touches the network"), so a Google Fonts `<link>` is not an option. `@fontsource/roboto` ships the woff2 files; Vite fingerprints them into `dist/` and the board's own server serves them.

Four weights are enough: 400 for body, 500 for Material 3's medium titles, 700 and 900 for Expressive.

- [ ] **Step 1: Add the dependency**

```bash
npm install @fontsource/roboto --workspace apps/board
```

- [ ] **Step 2: Import the weights**

At the very top of `apps/board/src/style.css`, above the Tailwind import:

```css
/*
 * Roboto ships with the board rather than loading from a font CDN: the board
 * has to work offline, and a stylesheet link would leak every page view to a
 * third party. Only the weights the themes use are imported.
 */
@import '@fontsource/roboto/400.css';
@import '@fontsource/roboto/500.css';
@import '@fontsource/roboto/700.css';
@import '@fontsource/roboto/900.css';
```

- [ ] **Step 3: Verify the font is bundled, not fetched**

Run: `npm run board:build`, then:

```bash
ls apps/board/dist/assets/*.woff2 | head
grep -c 'fonts.googleapis.com\|fonts.gstatic.com' apps/board/dist/assets/*.css
```

Expected: woff2 files are listed, and the grep returns `0`.

- [ ] **Step 4: Commit**

```bash
git add apps/board/package.json apps/board/src/style.css package-lock.json
git commit -m "build(board): ship Roboto locally for the Material themes"
```

---

## The class mapping

Tasks 14 to 16 apply the same substitution across every component. This table is the whole of it — no component invents a class outside it.

| Today | Becomes | Where it shows up |
|---|---|---|
| `bg-white` on a card or panel | `bg-surface` | cards, summary, detail panel, history table |
| `bg-white/50` on a column body | `bg-panel` | `Column.vue` |
| `bg-slate-50`, `bg-slate-50/60` | `bg-surface-muted` | session rows, table head, odd rows |
| `hover:bg-slate-100`, `hover:bg-slate-50` | `hover:bg-surface-hover` | session rows, table rows |
| `bg-slate-100` on `<main>` | *(removed — the ground now comes from `html`)* | `App.vue` |
| `bg-slate-100` on a segmented control | `bg-surface-muted` | `App.vue`, `HistoryPage.vue` |
| `bg-slate-900/30` | `bg-overlay` | `RepoDetail.vue` |
| `border-slate-200` | `border-line` | inputs, selects, cards, table |
| `border-slate-100` | `border-line-soft` | detail panel divider, table rows |
| `text-slate-900` | `text-ink-strong` | page title, panel heading |
| `text-slate-800` | `text-ink` | card and session titles |
| `text-slate-700`, `text-slate-600` | `text-ink-soft` | prompts, list text |
| `text-slate-500` | `text-ink-muted` | meta lines, section headings |
| `text-slate-400` | `text-ink-faint` | placeholders, empty states |
| `text-blue-600`, `underline` links | `text-accent` | repo URL, CI link, "show more" |
| `bg-blue-600`, `hover:bg-blue-700` | `bg-accent`, `hover:bg-accent-strong` | send buttons |
| `text-white` on the accent | `text-on-accent` | send buttons |
| `bg-blue-50 text-blue-700` | `bg-accent-soft text-on-accent-soft` | target chips |
| `focus:ring-blue-500/30`, `focus:border-blue-400` | `focus:ring-accent/30`, `focus:border-accent` | every input and select |
| `rounded-xl` | `rounded-card` (cards, summary) or `rounded-panel` (column body) | — |
| `rounded-lg` | `rounded-control` | inputs, selects, buttons, session rows |
| `rounded-md`, `rounded-full` on a chip | `rounded-chip` | chips, pills |
| `rounded-sm` on a badge | `rounded-badge` | CI, agent, worktree and token badges |
| `shadow-md` | `shadow-card` | cards |
| `shadow-xs`, `shadow-sm` | `shadow-panel` | summary, controls |
| `shadow-xl` | `shadow-overlay` | detail panel |
| `p-3` on a card | `p-card` | `Card.vue` |
| `gap-2` between cards or columns | `gap-gutter` | `Board.vue`, `Column.vue` |
| `bg-slate-200/70 text-slate-600` token badge | `bg-surface-muted text-ink-soft` | `SessionRow.vue` |
| `bg-violet-100 text-violet-700` worktree badge | `bg-worktree-soft text-worktree-on-soft` | `SessionRow.vue` |
| `text-amber-700` warning banners | `text-question-on-soft` | `App.vue` |
| `bg-gradient-to-r from-emerald-400 to-emerald-600` | *(replaced by `.progress-fill`, Task 17)* | `SummaryHeader.vue` |

Two rules while applying it:

- **Nothing outside the table changes.** Layout utilities (`flex`, `grid`, `min-w-0`, `truncate`, `px-3`, `text-xs`) stay exactly as they are; this is a color-and-shape pass, not a layout pass.
- **After each file, run its test.** A component with no test of its own is covered by `App.test.js`.

---

## Task 14: Migrate the shell — App, FilterBar, SummaryHeader

**Files:**
- Modify: `apps/board/src/App.vue`
- Modify: `apps/board/src/FilterBar.vue`
- Modify: `apps/board/src/SummaryHeader.vue`
- Modify: `apps/board/src/LocaleSwitcher.vue`
- Test: `apps/board/src/App.test.js`, `apps/board/src/FilterBar.test.js`, `apps/board/src/SummaryHeader.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/App.test.js`:

```js
test('the shell paints from theme tokens, not literal Tailwind colors', async () => {
  const { wrapper } = await mountApp(routedFetch());
  // Scoped to the shell's own elements on purpose: the cards inside it are
  // still on literal classes until Task 15.
  expect(wrapper.get('main').classes()).not.toContain('bg-slate-100');
  const tabs = wrapper.findAll('[data-test^=view-]');
  expect(tabs).toHaveLength(2);
  for (const tab of tabs) {
    expect(tab.classes().join(' ')).not.toMatch(/slate-|bg-white/);
    expect(tab.classes()).toContain('nav-tab');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.test.js --root apps/board -t 'theme tokens'`
Expected: FAIL — the rendered HTML is full of `bg-slate-*`.

- [ ] **Step 3: Migrate `App.vue`**

Apply the mapping table. Specifically:

- `<main class="min-h-screen bg-slate-100 p-6">` becomes `<main class="min-h-screen p-6">` — the ground now comes from `html`.
- The title: `text-xl font-bold text-slate-900` becomes `text-xl font-bold text-ink-strong`.
- The view segmented control: `bg-slate-100 rounded-lg` becomes `bg-surface-muted rounded-control`; the active link's `bg-white shadow-xs text-slate-900` becomes `bg-surface shadow-panel text-ink-strong`; the inactive `text-slate-500 hover:text-slate-700` becomes `text-ink-muted hover:text-ink-soft`. Add the `nav-tab` class to both links — Task 17 fills it.
- The two notification buttons: `border border-slate-200 rounded-lg shadow-xs hover:shadow-sm px-3 py-1.5 text-sm bg-white` becomes `border border-line rounded-control shadow-panel hover:shadow-card px-3 py-1.5 text-sm bg-surface`; the sound button's `text-slate-700` / `text-slate-400` become `text-ink-soft` / `text-ink-faint`.
- Their emoji move to `Icon`: `🔔 {{ t('notifications.enable') }}` becomes `<Icon name="notifications" emoji="🔔" /> {{ t('notifications.enable') }}`, and the sound button's `{{ soundOn ? '🔊' : '🔇' }}` becomes `<Icon :name="soundOn ? 'volume_up' : 'volume_off'" :emoji="soundOn ? '🔊' : '🔇'" />`.
- The three banners: `text-amber-700` becomes `text-question-on-soft`, and their `⚠` becomes `<Icon name="warning" emoji="⚠" />`.
- `text-slate-500` on the blocked-notifications line becomes `text-ink-muted`.

Import `Icon` alongside the switchers:

```js
import Icon from './Icon.vue';
```

- [ ] **Step 4: Migrate `FilterBar.vue` and `LocaleSwitcher.vue`**

Both are the same control styling, three times over:

```
border border-slate-200 rounded-lg shadow-xs px-3 py-1.5 text-sm bg-white
  → border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface
text-slate-600                     → text-ink-soft
focus:ring-blue-500/30             → focus:ring-accent/30
focus:border-blue-400              → focus:border-accent
border-slate-300 rounded-md        → border-line rounded-control    (the CI select, which drifted)
```

In `FilterBar.vue`, the search input's placeholder text contains a literal 🔍 through the i18n key `filter.searchRepo`. Leave the catalogs alone — the magnifier is part of the translated string and changing it would ripple through four locales for no gain.

- [ ] **Step 5: Migrate `SummaryHeader.vue`**

```
bg-white border border-slate-200 rounded-xl shadow-xs
  → bg-surface border border-line rounded-card shadow-panel
bg-slate-100 text-slate-700  (the "N repos" chip) → bg-surface-muted text-ink-soft
rounded-md on the chips                          → rounded-chip
h-2.5 bg-slate-100 rounded-full  (the track)     → h-2.5 bg-surface-muted rounded-chip
bg-gradient-to-r from-emerald-400 to-emerald-600 → progress-fill        (class added in Task 17)
text-slate-400 (the percentage)                  → text-ink-faint
```

The per-status chips already come from `STATUS_STYLES[...].chip`, migrated in Task 10 — leave those bindings alone.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/App.test.js src/FilterBar.test.js src/SummaryHeader.test.js src/LocaleSwitcher.test.js --root apps/board`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/FilterBar.vue apps/board/src/SummaryHeader.vue apps/board/src/LocaleSwitcher.vue apps/board/src/App.test.js
git commit -m "refactor(board): paint the shell from theme tokens"
```

---
## Task 15: Migrate the board — Board, Column, Card, SessionRow

**Files:**
- Modify: `apps/board/src/Board.vue`
- Modify: `apps/board/src/Column.vue`
- Modify: `apps/board/src/Card.vue`
- Modify: `apps/board/src/SessionRow.vue`
- Test: `apps/board/src/Card.test.js`, `apps/board/src/Column.test.js`, `apps/board/src/SessionRow.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/Card.test.js`:

```js
test('a card paints from theme tokens, not literal Tailwind colors', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'inprogress', now } });
  expect(w.html()).not.toMatch(/bg-white|bg-slate-|text-slate-|bg-blue-|text-blue-|violet-/);
  expect(w.classes()).toContain('bg-surface');
  expect(w.classes()).toContain('rounded-card');
  expect(w.classes()).toContain('shadow-card');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/Card.test.js --root apps/board -t 'theme tokens'`
Expected: FAIL — the card still carries `bg-white rounded-xl shadow-md`.

- [ ] **Step 3: Migrate `Card.vue`**

```
rounded-xl bg-white shadow-md p-3 border-l-4  → rounded-card bg-surface shadow-card p-card border-l-4
font-medium text-slate-800                    → font-medium text-ink  (plus the `card-title` class, Task 17)
text-xs text-slate-400  (empty state)         → text-xs text-ink-faint
```

The CI badge classes come from `pillClass()` and the status border from `STATUS_STYLES` — both already migrated. Leave the `border-l-4` width alone: it is shape, and every theme keeps it.

- [ ] **Step 4: Migrate `Column.vue`**

```
bg-white/50 rounded-xl p-2   → bg-panel rounded-panel p-2
flex flex-col gap-2          → flex flex-col gap-gutter
```

The pill heading already comes from `STATUS_STYLES[...].pill`; add the `col-title` class to the `<h2>` for Task 17.

- [ ] **Step 5: Migrate `SessionRow.vue`**

```
bg-slate-50 hover:bg-slate-100 rounded-lg p-2  → bg-surface-muted hover:bg-surface-hover rounded-control p-2
font-medium text-slate-800 text-sm             → font-medium text-ink text-sm
text-xs text-slate-500   (the meta line)       → text-xs text-ink-muted
text-xs text-slate-600   (the prompt)          → text-xs text-ink-soft
text-blue-600 hover:underline  ("show more")   → text-accent hover:underline
bg-violet-100 text-violet-700  (worktree)      → bg-worktree-soft text-worktree-on-soft
bg-slate-200/70 text-slate-600 (token badge)   → bg-surface-muted text-ink-soft
rounded-sm on all three badges                 → rounded-badge
border border-slate-200 bg-white … focus:border-blue-400  (the message input)
  → border border-line bg-surface … focus:border-accent
bg-blue-600 … text-white hover:bg-blue-700     (the send button)
  → bg-accent … text-on-accent hover:bg-accent-strong
rounded-sm on the input and button             → rounded-control
```

The worktree badge's `⎇` becomes `<Icon name="account_tree" emoji="⎇" />`; import `Icon` in this file.

The agent badge's classes come from `agentPillClass()`, migrated in Task 11.

- [ ] **Step 6: Migrate `Board.vue`**

Only one substitution: the column grid's `gap-3` and the card list's `gap-2` become `gap-gutter` so the density token reaches the layout. Nothing else in this file carries a color.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/Card.test.js src/Column.test.js src/SessionRow.test.js src/Board.test.js --root apps/board`
Expected: PASS. (`Board.vue` has no test file of its own; `App.test.js` covers it.)

- [ ] **Step 8: Commit**

```bash
git add apps/board/src/Board.vue apps/board/src/Column.vue apps/board/src/Card.vue apps/board/src/SessionRow.vue apps/board/src/Card.test.js
git commit -m "refactor(board): paint the kanban from theme tokens"
```

---

## Task 16: Migrate the detail panel and the history view

**Files:**
- Modify: `apps/board/src/RepoDetail.vue`
- Modify: `apps/board/src/HistoryPage.vue`
- Modify: `apps/board/src/HistoryTable.vue`
- Test: `apps/board/src/RepoDetail.test.js`, `apps/board/src/HistoryPage.test.js`, `apps/board/src/HistoryTable.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/RepoDetail.test.js` (reuse the mounting helper already in the file):

```js
test('the detail panel paints from theme tokens, not literal Tailwind colors', () => {
  const w = mount(RepoDetail, {
    props: { name: 'oc-be', sessionId: 's1', session: { title: 't', events: [] }, meta: null, ci: null, now: Date.now() },
  });
  expect(w.html()).not.toMatch(/bg-white|bg-slate-|text-slate-|bg-blue-|text-blue-/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/RepoDetail.test.js --root apps/board -t 'theme tokens'`
Expected: FAIL.

- [ ] **Step 3: Migrate `RepoDetail.vue`**

```
bg-slate-900/30                     → bg-overlay
bg-white shadow-xl p-4              → bg-surface shadow-overlay p-4
text-slate-400 hover:text-slate-600 → text-ink-faint hover:text-ink-soft   (the close button)
border-b border-slate-100           → border-b border-line-soft
font-bold text-slate-900            → font-bold text-ink-strong
text-sm text-slate-600              → text-sm text-ink-soft
text-blue-600 underline             → text-accent underline                (both links)
bg-slate-100  (technology chips)    → bg-surface-muted
bg-blue-50 text-blue-700 (targets)  → bg-accent-soft text-on-accent-soft
rounded-full on both chip kinds     → rounded-chip
text-sm text-slate-700              → text-sm text-ink-soft                (the prompt)
text-xs font-semibold text-slate-500 uppercase  (3 headings) → text-xs font-semibold text-ink-muted uppercase
text-xs text-slate-600 / text-slate-500 / text-slate-400     → text-ink-soft / text-ink-muted / text-ink-faint
border border-slate-200 bg-white … focus:border-blue-400 (textarea) → border border-line bg-surface … focus:border-accent
bg-blue-600 … text-white hover:bg-blue-700 (send)                   → bg-accent … text-on-accent hover:bg-accent-strong
rounded-sm on the textarea, the send button and the CI pill         → rounded-control (controls) / rounded-badge (pill)
```

The close button's `✕` becomes `<Icon name="close" emoji="✕" />` and the pending list's `↩` becomes `<Icon name="reply" emoji="↩" />`; import `Icon`.

- [ ] **Step 4: Migrate `HistoryPage.vue`**

The `tabClass()` helper is where the literals hide:

```js
function tabClass(active) {
  return ['nav-tab rounded-control px-3 py-1 font-medium transition-colors',
    active ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft'];
}
```

and in the template:

```
inline-flex bg-slate-100 rounded-lg          → inline-flex bg-surface-muted rounded-control   (three segmented controls)
bg-white border border-slate-200 rounded-xl shadow-xs p-4 → bg-surface border border-line rounded-card shadow-panel p-4  (both chart panels)
```

- [ ] **Step 5: Migrate `HistoryTable.vue`**

```
bg-white border border-slate-200 rounded-xl shadow-xs p-4 → bg-surface border border-line rounded-card shadow-panel p-4
border border-slate-200 rounded-lg shadow-xs … bg-white … focus:ring-blue-500/30 focus:border-blue-400
  → border border-line rounded-control shadow-panel … bg-surface … focus:ring-accent/30 focus:border-accent
text-slate-500 bg-slate-50 … border-b border-slate-200   (thead) → text-ink-muted bg-surface-muted … border-b border-line
border-b border-slate-100 odd:bg-slate-50/60 hover:bg-slate-50  (rows)
  → border-b border-line-soft odd:bg-surface-muted hover:bg-surface-hover
bg-slate-100 rounded-sm  (the total badge) → bg-surface-muted rounded-badge
text-xs text-slate-400   (the empty line)  → text-xs text-ink-faint
```

- [ ] **Step 6: Migrate the two charts' empty-state text**

In both `TimeSeriesChart.vue` and `ProjectBarChart.vue`, the overlay paragraph's `text-slate-400` becomes `text-ink-faint`. The canvas colors themselves are Task 18.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/board/src/RepoDetail.vue apps/board/src/HistoryPage.vue apps/board/src/HistoryTable.vue apps/board/src/TimeSeriesChart.vue apps/board/src/ProjectBarChart.vue apps/board/src/RepoDetail.test.js
git commit -m "refactor(board): paint the detail panel and history from theme tokens"
```

---

## Task 17: The typographic component layer

**Files:**
- Modify: `apps/board/src/style.css`

Three properties vary between themes without being colors — Classic's uppercase nav with wide tracking, Expressive's heavy titles — and Tailwind has no namespace for them. The classes added in Tasks 14 to 16 (`nav-tab`, `col-title`, `card-title`) and the progress bar's fill are wired here. Components carry a stable class; themes fill the variables.

- [ ] **Step 1: Extend the components layer**

In `apps/board/src/style.css`, add to the `@layer components` block created in Task 12:

```css
  /*
   * Properties Tailwind has no namespace for. Classic sets --nav-transform to
   * uppercase with wide tracking; Expressive sets --title-weight to 700. Every
   * theme fills all four, so these classes need no per-theme rules.
   */
  .nav-tab {
    text-transform: var(--nav-transform);
    letter-spacing: var(--nav-tracking);
  }

  .col-title,
  .card-title {
    font-weight: var(--title-weight);
  }

  .progress-fill {
    background: var(--progress-fill);
  }
```

- [ ] **Step 2: Check every hook has a consumer**

```bash
grep -rn "nav-tab\|col-title\|card-title\|progress-fill" apps/board/src --include=*.vue
```

Expected: `nav-tab` in `App.vue` (two view links) and `HistoryPage.vue` (`tabClass`); `col-title` in `Column.vue`; `card-title` in `Card.vue`; `progress-fill` in `SummaryHeader.vue`. A hook with no consumer means a step in Tasks 14 to 16 was skipped — go back rather than deleting the rule.

- [ ] **Step 3: Verify by eye**

Run: `npm start`, open http://localhost:4180, and walk the four themes:

- **Classic**: the Board/History tabs read in capitals with visible tracking.
- **Expressive**: column titles and card titles are visibly heavier than in Material 3.
- **Legacy**: tabs are sentence case, titles are semibold — the same as before this feature.
- Toggle to dark on each Material theme: nothing keeps a light background, no text disappears.

- [ ] **Step 4: Commit**

```bash
git add apps/board/src/style.css
git commit -m "feat(board): let themes set nav case, title weight and the progress fill"
```

---

## Task 18: Charts on theme colors

**Files:**
- Create: `apps/board/src/chartColors.js`
- Test: `apps/board/src/chartColors.test.js`
- Modify: `apps/board/src/TimeSeriesChart.vue`
- Modify: `apps/board/src/ProjectBarChart.vue`
- Test: `apps/board/src/TimeSeriesChart.test.js`, `apps/board/src/ProjectBarChart.test.js`

A canvas cannot read CSS variables, so this is the one place where theming needs JavaScript. The colors are resolved at render time and the charts re-render when the theme or the mode changes.

The fallbacks matter: in jsdom `getComputedStyle` returns empty strings for custom properties, so without them every test would draw transparent bars. They are the legacy series colors — the ones the charts use today.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/chartColors.test.js`:

```js
import { test, expect } from 'vitest';
import { tokenColor, seriesColors, chartInk, FALLBACK } from './chartColors.js';

// Stands in for getComputedStyle: returns whatever the theme is supposed to
// have resolved for each custom property.
function computedFrom(values) {
  return () => ({ getPropertyValue: (name) => values[name] ?? '' });
}

test('reads a token from the resolved styles', () => {
  const computed = computedFrom({ '--color-series-1': ' #6750a4 ' });
  expect(tokenColor('--color-series-1', { computed })).toBe('#6750a4');
});

test('falls back when the property resolves empty, as it does in jsdom', () => {
  expect(tokenColor('--color-series-1', { computed: computedFrom({}) })).toBe(FALLBACK['--color-series-1']);
});

test('falls back when there is no getComputedStyle at all', () => {
  expect(tokenColor('--color-series-2', { computed: undefined })).toBe(FALLBACK['--color-series-2']);
});

test('returns the six series colors in order', () => {
  const computed = computedFrom({
    '--color-series-1': '#111111', '--color-series-2': '#222222', '--color-series-3': '#333333',
    '--color-series-4': '#444444', '--color-series-5': '#555555', '--color-series-6': '#666666',
  });
  expect(seriesColors({ computed })).toEqual(['#111111', '#222222', '#333333', '#444444', '#555555', '#666666']);
});

test('chart text follows the muted ink token', () => {
  const computed = computedFrom({ '--color-ink-muted': '#605d66' });
  expect(chartInk({ computed })).toBe('#605d66');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chartColors.test.js --root apps/board`
Expected: FAIL — `Failed to resolve import "./chartColors.js"`.

- [ ] **Step 3: Write the helper**

Create `apps/board/src/chartColors.js`:

```js
// Chart.js paints on a canvas, which cannot read CSS custom properties, so the
// theme tokens are resolved to plain strings at render time. The charts re-run
// this on every theme or mode change.
//
// The fallbacks are the colors the charts used before themes existed. They
// cover jsdom, where getComputedStyle returns an empty string for a custom
// property, and any moment the canvas is not in the document yet.
export const FALLBACK = {
  '--color-series-1': '#2563eb',
  '--color-series-2': '#10b981',
  '--color-series-3': '#f59e0b',
  '--color-series-4': '#94a3b8',
  '--color-series-5': '#8b5cf6',
  '--color-series-6': '#ec4899',
  '--color-ink-muted': '#64748b',
};

export function tokenColor(name, {
  el = globalThis.document?.documentElement,
  computed = globalThis.getComputedStyle,
} = {}) {
  try {
    const value = computed?.(el)?.getPropertyValue(name)?.trim();
    if (value) return value;
  } catch { /* no computed styles available — fall through to the fallback */ }
  return FALLBACK[name];
}

export function seriesColors(options = {}) {
  return [1, 2, 3, 4, 5, 6].map((i) => tokenColor(`--color-series-${i}`, options));
}

export function chartInk(options = {}) {
  return tokenColor('--color-ink-muted', options);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/chartColors.test.js --root apps/board`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in `TimeSeriesChart.vue`**

Replace the three color constants with token reads, and let the render pick them up. The series keep their meaning — input, output, cache write, cache read map to series 1 to 4:

```js
import { seriesColors, chartInk } from './chartColors.js';
import { useTheme } from './theme.js';

const { theme, mode } = useTheme();

const TOKEN_SERIES = [
  { key: 'inputTokens', labelKey: 'chart.input' },
  { key: 'outputTokens', labelKey: 'chart.output' },
  { key: 'cacheCreationInputTokens', labelKey: 'chart.cacheWrite' },
  { key: 'cacheReadInputTokens', labelKey: 'chart.cacheRead' },
];
```

`datasets` becomes a function of the resolved palette rather than a computed of literals — `render()` resolves once and passes it down:

```js
function buildDatasets(palette) {
  if (props.mode === 'tokens') {
    return TOKEN_SERIES.map((s, i) => ({
      label: t(s.labelKey),
      backgroundColor: palette[i],
      data: props.buckets.map((b) => b.tokens[s.key]),
    }));
  }
  return modelKeys.value.map((model, i) => ({
    label: modelLabel(model),
    // The unknown model keeps the neutral slot rather than taking a hue that
    // would read as a real model.
    backgroundColor: model === UNKNOWN_MODEL ? palette[3] : palette[i % palette.length],
    data: props.buckets.map((b) => Number((b.costByModel[model] ?? 0).toFixed(4))),
  }));
}
```

and `render()` resolves the palette from the canvas, so the styles it reads are the ones actually applying to it:

```js
function render() {
  const options = { el: canvas.value ?? undefined };
  const palette = seriesColors(options);
  const ink = chartInk(options);
  const config = {
    type: 'bar',
    data: { labels: props.buckets.map((b) => b.key), datasets: buildDatasets(palette) },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: ink } },
        y: { stacked: true, ticks: { color: ink } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: ink } } },
    },
  };
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}
```

Finally, add the theme to the watch list:

```js
watch([() => props.buckets, () => props.mode, locale, theme, mode], render);
```

Delete the now-unused `MODEL_COLORS`, `UNKNOWN_COLOR` and the `datasets` computed.

- [ ] **Step 6: Use it in `ProjectBarChart.vue`**

Same shape, one dataset:

```js
import { seriesColors, chartInk } from './chartColors.js';
import { useTheme } from './theme.js';

const { theme, mode } = useTheme();
```

```js
function render() {
  const options = { el: canvas.value ?? undefined };
  const ink = chartInk(options);
  const config = {
    type: 'bar',
    data: {
      labels: props.totals.map((t) => t.repo),
      datasets: [{
        label: props.mode === 'tokens' ? t('history.modeTokens') : t('chart.cost'),
        backgroundColor: seriesColors(options)[0],
        data: values.value,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: { x: { ticks: { color: ink } }, y: { ticks: { color: ink } } },
      plugins: { legend: { display: false } },
    },
  };
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}
```

```js
watch([() => props.totals, () => props.mode, locale, theme, mode], render);
```

- [ ] **Step 7: Assert the charts follow the theme**

Append to `apps/board/src/TimeSeriesChart.test.js` (it already mocks `chart.js`; reuse that mock's captured config the way the file's existing tests do):

```js
test('re-renders when the theme changes', async () => {
  const w = mount(TimeSeriesChart, { props: { buckets: [], mode: 'tokens' } });
  const before = updateCalls();
  setTheme('classic', { storage: window.localStorage, doc: document });
  await nextTick();
  expect(updateCalls()).toBeGreaterThan(before);
  w.unmount();
});
```

`updateCalls()` is whatever counter the file's `chart.js` mock already exposes; if it exposes none, add one to the mock's `update()` in the same style as the existing assertions. Import `setTheme` from `./theme.js` and `nextTick` from `vue`, and reset the theme in `afterEach`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/board/src/chartColors.js apps/board/src/chartColors.test.js apps/board/src/TimeSeriesChart.vue apps/board/src/ProjectBarChart.vue apps/board/src/TimeSeriesChart.test.js
git commit -m "feat(board): draw the charts in the active theme's colors"
```

---
## Task 19: The contrast gate

**Files:**
- Create: `apps/board/src/themes/contrast.test.js`
- Modify: `apps/board/src/themes/classic.css`

Eight palettes is too many to eyeball. This test computes WCAG contrast for the pairs the board actually renders — text on its surface, a badge's ink on its own fill, the pill text on the status color — across every theme and mode, so a palette that ships unreadable text fails a test rather than a user.

Two exemptions, both explicit rather than a lowered threshold:

- **`legacy` is frozen**, so its values cannot move to satisfy a gate that did not exist when they were chosen. Its one failing pair (placeholder ink at 2.9:1) is named in the test.
- **Placeholder and empty-state text** (`ink-faint`) is held to 3:1, the AA threshold for non-essential UI text, not 4.5:1 — it never carries information the board does not also show elsewhere.

- [ ] **Step 1: Write the failing test**

Create `apps/board/src/themes/contrast.test.js`:

```js
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FILES = {
  'm3 light': ["m3.css", "html[data-theme='m3']"],
  'm3 dark': ["m3.css", "html[data-theme='m3'][data-mode='dark']"],
  'expressive light': ["expressive.css", "html[data-theme='expressive']"],
  'expressive dark': ["expressive.css", "html[data-theme='expressive'][data-mode='dark']"],
  'classic light': ["classic.css", "html[data-theme='classic']"],
  'classic dark': ["classic.css", "html[data-theme='classic'][data-mode='dark']"],
  legacy: ["legacy.css", "html[data-theme='legacy']"],
};

// Text on its own surface, and every "ink on its own fill" pair the board
// renders. `min` is the WCAG AA ratio: 4.5 for body text, 3 for the faint
// placeholder and empty-state ink, which never carries unique information.
const PAIRS = [
  ['--color-ink', '--color-surface', 4.5],
  ['--color-ink-strong', '--color-surface', 4.5],
  ['--color-ink-soft', '--color-surface', 4.5],
  ['--color-ink-muted', '--color-surface', 4.5],
  ['--color-ink-faint', '--color-surface', 3],
  ['--color-ink', '--color-surface-muted', 4.5],
  ['--color-ink-muted', '--color-panel', 4.5],
  ['--color-on-accent', '--color-accent', 4.5],
  ['--color-on-accent-soft', '--color-accent-soft', 4.5],
  ['--color-todo-on-soft', '--color-todo-soft', 4.5],
  ['--color-inprogress-on-soft', '--color-inprogress-soft', 4.5],
  ['--color-question-on-soft', '--color-question-soft', 4.5],
  ['--color-done-on-soft', '--color-done-soft', 4.5],
  ['--color-on-status', '--color-todo-solid', 4.5],
  ['--color-on-status', '--color-inprogress-solid', 4.5],
  ['--color-on-status', '--color-question-solid', 4.5],
  ['--color-on-status', '--color-done-solid', 4.5],
  ['--color-ci-failure-on-soft', '--color-ci-failure-soft', 4.5],
  ['--color-ci-running-on-soft', '--color-ci-running-soft', 4.5],
  ['--color-ci-neutral-on-soft', '--color-ci-neutral-soft', 4.5],
  ['--color-ci-success-on-soft', '--color-ci-success-soft', 4.5],
  ['--color-agent-claude-on-soft', '--color-agent-claude-soft', 4.5],
  ['--color-agent-copilot-on-soft', '--color-agent-copilot-soft', 4.5],
  ['--color-worktree-on-soft', '--color-worktree-soft', 4.5],
];

// legacy is frozen: its values predate this gate and cannot move to satisfy
// it. Its placeholder ink (slate-400 on white, 2.9:1) is the one pair below
// the bar, and it is named here rather than hidden behind a lower threshold.
const EXEMPT = new Set(['legacy|--color-ink-faint|--color-surface']);

function declarations(file, selector) {
  const css = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.trim().replace(/\s+/g, ' ').replace(/^[\s\S]*\*\//, '').trim() !== selector) continue;
    const out = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
    return out;
  }
  throw new Error(`no block ${selector} in ${file}`);
}

// Accepts #rgb, #rrggbb and rgb(r g b / a); alpha is composited over `over`,
// because that is what the eye sees. Classic's inks are black at 87%, 60%…
function parse(value, over = [255, 255, 255]) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i);
  if (!rgb) throw new Error(`cannot parse color: ${value}`);
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
  const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  return [r, g, b].map((c, i) => Math.round(c * a + over[i] * (1 - a)));
}

function luminance([r, g, b]) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test.each(Object.entries(FILES))('%s meets AA on every pair it renders', (name, [file, selector]) => {
  const vars = declarations(file, selector);
  const ground = parse(vars['--color-ground']);
  const failures = [];

  for (const [ink, surface, min] of PAIRS) {
    if (EXEMPT.has(`${name.split(' ')[0]}|${ink}|${surface}`)) continue;
    const bg = parse(vars[surface], ground);
    const ratio = contrast(parse(vars[ink], bg), bg);
    if (ratio < min) failures.push(`${ink} on ${surface}: ${ratio.toFixed(2)}:1 (needs ${min})`);
  }

  expect(failures).toEqual([]);
});
```

- [ ] **Step 2: Run the test to see which palettes fail**

Run: `npx vitest run src/themes/contrast.test.js --root apps/board`
Expected: FAIL on `classic light` — `--color-ink-faint on --color-surface: 2.85:1 (needs 3)`. Material 2's hint ink is 38% black, which is below the bar on white.

Any other failure is a palette bug: fix the value in the theme file, keeping it recognisably within that design system, and re-run. Do not lower a threshold and do not add an exemption — the two exemptions above are the only ones this plan sanctions.

- [ ] **Step 3: Lift Classic's hint ink just over the bar**

In `apps/board/src/themes/classic.css`, in the light block only:

```css
  --color-ink-faint: rgb(0 0 0 / 0.45);
```

Material 2 put hint text at 38% black on white, which predates the AA guidance the board holds itself to; 45% keeps the same grey family and clears 3:1.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/themes/contrast.test.js --root apps/board`
Expected: PASS, 7 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/themes/contrast.test.js apps/board/src/themes/classic.css
git commit -m "test(board): gate every theme palette on WCAG AA contrast"
```

---

## Task 20: Documentation and screenshots

**Files:**
- Modify: `docs/board-dashboard.md`
- Modify: `CHANGELOG.md`
- Replace: `docs/images/board/*.png`

- [ ] **Step 1: Check the legacy theme against the committed screenshots**

This is the acceptance criterion for the freeze, and it happens before the images are replaced.

Run: `npm start`, open http://localhost:4180, select **Legacy (frozen)**, and compare against `docs/images/board/board-en.png`, `send-message-card.png` and `send-message-detail.png` at the same window width. Ground, card shadows, status colors, badge hues and corner radii must match. A difference is a migration bug in `legacy.css` — fix the token, do not accept the drift.

- [ ] **Step 2: Refresh the screenshots under the new default**

With the theme set to **Material 3** in light mode, retake the three screenshots at the same framing as the originals and overwrite the files in `docs/images/board/`. Take one new image, `docs/images/board/theme-picker.png`, showing the header with the theme and mode pickers open.

- [ ] **Step 3: Document the themes**

In `docs/board-dashboard.md`, in the "What the UI does" list, add an entry after the language picker bullet:

```markdown
- **Theme picker** in the header: Material 3 (the default), Material 3
  Expressive, Material classic, and Legacy — the board's pre-Material look,
  kept selectable but frozen. A second picker sets light, dark or system.
  See [Themes](#themes).
```

Then add a section after "Messaging a session":

```markdown
## Themes

![The theme and mode pickers](images/board/theme-picker.png)

The board ships four looks, chosen from the header:

| Theme | What it is |
|---|---|
| **Material 3** | Material 3's tonal surfaces on a violet seed. The default. |
| **Material 3 Expressive** | The expressive revision: full-colour column blocks, large radii, heavy titles. |
| **Material classic** | Material of the M2 era — indigo app bar, 4px corners, elevation shadows. |
| **Legacy (frozen)** | Exactly what the board looked like before themes existed. Still selectable, no longer maintained: new work targets the Material themes. |

A second picker sets **light**, **dark** or **system** (the default, which
follows the operating system). The legacy theme is light only, so the mode
picker is disabled while it is active — the stored preference is kept and
applies again as soon as another theme is selected.

Both choices live in `localStorage` (`maggie:theme`, `maggie:mode`),
per browser, like the language. Nothing is stored server-side, so two people
looking at the same board can each have their own.

### Adding or changing a theme

Every theme is one CSS file under `apps/board/src/themes/` that redefines the
same contract of custom properties — colours, radii, shadows, spacing and
type. `contract.css` declares the full set; `themes/contract.test.js` fails
any theme that misses one, and `themes/contrast.test.js` fails a palette that
puts text below WCAG AA on its own background. Components never name a
colour: they use semantic utilities (`bg-surface`, `text-ink`,
`rounded-card`) that resolve through those variables.
```

- [ ] **Step 4: Add the changelog entry**

Under `## Unreleased` in `CHANGELOG.md`:

```markdown
### Added

- The board ships four selectable themes — Material 3 (the new default),
  Material 3 Expressive, Material classic, and the previous look as a frozen
  `Legacy` theme — with a light/dark/system picker beside them. Both choices
  persist per browser. ([spec](docs/superpowers/specs/2026-09-14-board-material-themes-design.md))
```

- [ ] **Step 5: Verify the whole suite and the build**

Run:

```bash
npm run test:board
npm run lint
npm run build
```

Expected: all three pass.

- [ ] **Step 6: Commit**

```bash
git add docs/board-dashboard.md docs/images/board CHANGELOG.md
git commit -m "docs(board): document the four themes and refresh the screenshots"
```

---

## Done when

- The header carries a theme picker (four entries) and a mode picker (three), beside the language picker.
- Switching either repaints the whole board, both views, without a reload.
- Both choices survive a reload; a wiped or unreadable `localStorage` lands on Material 3 following the system.
- `Legacy (frozen)` reproduces the committed screenshots, and disables the mode picker while active.
- `npm run test:board`, `npm run lint` and `npm run build` pass.
- No component names a literal colour: `grep -rn "bg-slate-\|text-slate-\|bg-blue-\|text-blue-\|border-slate-\|violet-\|amber-\|emerald-\|sky-" apps/board/src --include=*.vue --include=*.js` returns nothing outside `themes/` and `chartColors.js`.
