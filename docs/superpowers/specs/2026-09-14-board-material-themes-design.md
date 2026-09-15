# Board Material Themes — Design

**Date:** 2026-09-14
**Status:** Approved (pending written-spec review)

## Purpose

The board renders one hardcoded look: Tailwind utility classes picked per
component (`bg-white`, `text-slate-800`, `rounded-xl`, `shadow-md`) plus
`statusStyles.js` for the four status colors. There is no way to change the
look, and no dark mode.

This design makes the look selectable. The board ships **four themes** —
three readings of Material, plus today's look kept as a frozen `legacy`
theme — chosen from a picker in the header next to the language picker, and
a separate light/dark/system control. Material 3 tonal becomes the default.

Getting there is mostly one mechanical change: colors, radii, shadows,
spacing and type stop being literal Tailwind classes inside components and
become **semantic tokens** that a theme file redefines. No component gains a
prop, an emit, or a different DOM shape.

Three visual directions were mocked up during brainstorming and reviewed as
a published artifact; the user chose to ship all three rather than pick one.

## Decisions (locked during brainstorming)

- **Four themes, one switcher.** `m3` (Material 3 tonal, the default),
  `expressive` (Material 3 Expressive), `classic` (Material of the M2 era),
  `legacy` (today's look).
- **`legacy` is frozen.** It stays selectable and reproduces today's look
  exactly, but no future work targets it. It is **light-only**: giving it a
  dark palette would mean evolving it.
- **Dark mode is in scope, with a manual control.** A second picker offers
  `light` / `dark` / `system` (`system` being the default), independent of
  the theme choice.
- **Approach: CSS tokens on top of Tailwind 4 — no component library.**
  Material Web (`@material/web`) was rejected: custom-element wiring for a
  library whose feature development Google has paused, covering only the
  controls (~10% of the screen) and unable to express the Expressive and
  Classic directions. Vuetify 3 was rejected: it means rewriting every
  component, fighting Tailwind 4 already in place, and accepting its own
  dialect of Material.
- **Themes never move a DOM node.** The three Material themes share one
  component tree and differ by tokens plus a thin layer of token-driven
  component classes. A theme that needs a different structure is out of
  scope — that would be three applications to maintain.
- **No runtime network access.** The project is offline-minded (the
  workspace CLI has `--offline`, the CI reader "never touches the network").
  Roboto ships as a local dependency (`@fontsource/roboto`); icons are
  inline SVG, not an icon font.
- **Theme and mode are per-browser**, in `localStorage`, exactly like the
  language choice. Nothing is persisted server-side.

## Architecture

### The token contract

One set of CSS custom properties that every theme redefines identically.
Nothing else in a component is allowed to be a literal color.

```
apps/board/src/themes/contract.css    the full set + m3 light values as the fallback
apps/board/src/themes/m3.css          Material 3 tonal        (default)
apps/board/src/themes/expressive.css  Material 3 Expressive
apps/board/src/themes/classic.css     Material of the M2 era
apps/board/src/themes/legacy.css      today's look, frozen
```

The set, 70 variables in eight families:

| Family | Variables | Covers |
|---|---|---|
| Surfaces | `--color-ground`, `--color-surface`, `--color-surface-muted`, `--color-line` | page ground, card, column body and session row, hairlines |
| Text | `--color-ink`, `--color-ink-muted`, `--color-ink-faint` | title, meta line, placeholder |
| Accent | `--color-accent`, `--color-on-accent`, `--color-accent-soft`, `--color-on-accent-soft` | send button, active tab, progress bar |
| Status | `--color-{todo,inprogress,question,done}-{solid,soft,on-soft}`, `--color-on-status`, `--color-question-ring`, `--color-drop-ring` | column pill, summary chip, card border, the question alarm, the drag-to-done target |
| Badges | `--color-ci-*`, `--color-agent-*`, `--color-worktree-{soft,on-soft}` | CI, agent and worktree pills |
| Shape and type | `--radius-{card,panel,control,chip}`, `--shadow-{card,panel}`, `--spacing-{card,gap}`, `--font-ui`, `--nav-transform`, `--nav-tracking`, `--title-weight` | what separates the directions as much as color does |
| Charts | `--color-series-1` … `--color-series-6` | Chart.js datasets (see below) |

`--color-on-status` is the ink on a filled status pill. It cannot reuse
`--color-on-accent`: in the dark palettes the accent inverts to a light
violet whose ink is dark, while the status solids stay light-on-dark, so one
token would make the column pills unreadable in dark mode.

CI badges and agent badges keep small families of their own —
`--color-ci-{failure,running,neutral,success}-{soft,on-soft,line}` and
`--color-agent-{claude,copilot}-{soft,on-soft}` — rather than borrowing the
status colors: today's CI running badge is `blue-100` where the `inprogress`
chip is `blue-50`, and CI failure is red where `question` is amber. Borrowing
would shift `legacy` by a shade, which its freeze forbids.

### Wiring into Tailwind 4

`style.css` maps the contract into **semantic utilities** through `@theme`:
`--color-surface` yields `bg-surface`, `--radius-card` yields `rounded-card`,
`--spacing-card` yields `p-card`, `--shadow-card` yields `shadow-card`.
Components write `bg-surface text-ink rounded-card p-card` instead of
`bg-white text-slate-800 rounded-xl p-3`.

Because v4 utilities compile down to `var(--color-surface)`, a block that
redefines the variable retheme the whole screen with no recompilation and no
conditional classes in templates.

Two existing traps in `style.css`: `source(none)` means the new files must be
added to the `@source` directives, and Tailwind only sees class names that
appear as literal strings — so theme files contain variables only, never
constructed class names.

### Light and dark

`system` is resolved in JavaScript, not in CSS: `theme.js` reads
`matchMedia('(prefers-color-scheme: dark)')` and stamps `<html>` with
`data-mode="light"` or `data-mode="dark"` — never `"system"`, which stays in
`mode.value` as the user's preference. A listener on that media query
restamps when the OS flips.

```css
html[data-theme='m3']                     { /* light palette */ }
html[data-theme='m3'][data-mode='dark']   { /* dark palette */ }
```

Resolving in CSS instead would mean repeating each dark palette inside a
`@media (prefers-color-scheme: dark)` block for the `system` case — around
70 duplicated declarations per theme, and two copies to keep in step. A
runtime without `matchMedia` reads as light.

`legacy` defines the light palette only. When it is active the mode control
is disabled (greyed, with a tooltip explaining why) and the screen stays
light whatever mode is stored — the stored mode is kept and reapplied as
soon as a Material theme is selected again.

### State and controls

`apps/board/src/theme.js` deliberately mirrors `i18n.js` — same shape, same
guards:

```js
export const DEFAULT_THEME = 'm3';
export const THEMES = [
  { code: 'm3',         labelKey: 'theme.m3' },
  { code: 'expressive', labelKey: 'theme.expressive' },
  { code: 'classic',    labelKey: 'theme.classic' },
  { code: 'legacy',     labelKey: 'theme.legacy' },
];
export const MODES = ['light', 'dark', 'system'];   // 'system' is the default

export const theme = ref(DEFAULT_THEME);
export const mode = ref('system');

export function setTheme(code, { storage, doc } = {}) { /* … */ }
export function setMode(value, { storage, doc } = {}) { /* … */ }
export function initTheme({ storage, doc } = {}) { /* … */ }
export function useTheme() { /* … */ }
```

An unknown value or an unreadable `localStorage` (private mode, quota) falls
back to the default silently; the choice simply is not persisted. Keys are
`maggie:theme` and `maggie:mode`, alongside `maggie:locale`. `setTheme`
stamps `data-theme`, `setMode` stamps `data-mode`; `initTheme()` runs in
`main.js` right after `initLocale()`, before `mount()`.

Labels go through the existing i18n catalogs — four `theme.*` keys and three
`mode.*` keys in `en`/`fr`/`de`/`es`. Unlike languages, which are listed in
their own language, a theme name is translated.

Two components, one job each, modeled on `LocaleSwitcher.vue` (a native
`<select>`: keyboard-accessible, no bespoke menu to maintain):

- `ThemeSwitcher.vue` — `data-test="theme"`, four options.
- `ModeSwitcher.vue` — `data-test="mode"`, three options,
  `:disabled="theme === 'legacy'"` with a `title` explaining why
  (`mode.legacyLocked`).

In `App.vue`'s header: `[ theme ][ mode ][ language ][ 🔔 ][ 🔇 ]` — appearance
grouped on the left, notifications on the right. That is five controls; the
container already wraps, so on a narrow screen they move to a second line
instead of squeezing the title.

### Two integration points

**Page ground before mount.** The ground comes from `bg-slate-100` on
`<main>` today, so it paints only after Vue mounts. It moves into
`@layer base` as `html { background: var(--color-ground); }`, so the right
ground is painted on the first frame whatever theme is stored, with no flash.

**Chart.js.** `TimeSeriesChart.vue` and `ProjectBarChart.vue` hold literal
colors (`'#2563eb'`, `MODEL_COLORS`, `UNKNOWN_COLOR`); a canvas cannot read
CSS variables. They resolve their colors at render time through
`getComputedStyle(canvas).getPropertyValue('--color-series-N')`, and a
`watch` on `theme`/`mode` triggers a re-render. This is the only place where
theming needs JavaScript rather than CSS — hence the dedicated
`--color-series-*` variables instead of borrowing status colors.

## Component migration

Every front-end file is touched, mechanically: `App.vue`, `Board.vue`,
`Column.vue`, `Card.vue`, `SessionRow.vue`, `SummaryHeader.vue`,
`FilterBar.vue`, `RepoDetail.vue`, `HistoryPage.vue`, `HistoryTable.vue`,
`LocaleSwitcher.vue`, both charts, plus `statusStyles.js`, `ciBadge.js` and
`agentBadge.js`. Every color, radius and shadow class becomes its semantic
equivalent. No props, emits or structure change.

`statusStyles.js` keeps its role as the single source of truth; only its
values change, as literal strings so Tailwind's scanner sees them:

```js
question: {
  pill:   'bg-question-solid text-on-accent',
  border: 'border-question-solid',
  chip:   'bg-question-soft text-question-on-soft',
  ring:   'ring-2 ring-question-soft',
}
```

**What utilities cannot express.** Three properties vary between themes
without being colors: `text-transform` (Classic's uppercase tabs),
`letter-spacing`, and `font-weight` (Expressive's 900). Rather than
conditional classes in templates, a thin `@layer components` defines
`.nav-tab`, `.col-title` and `.card-title` consuming tokens
(`--nav-transform`, `--nav-tracking`, `--title-weight`). Components carry a
stable class; themes fill the variables.

**Icons are inline SVG, not a font.** The `material-symbols` package weighs
several megabytes and the board needs about a dozen glyphs. `icons.js` holds
the Material Symbols paths and `Icon.vue` renders them as SVG — no request,
offline by construction, no icon font in the bundle.

`legacy` uses emoji today (🔔 🔇 🔍 ⎇) and must stay pixel-identical, so
`Icon.vue` takes both: `<Icon name="notifications" emoji="🔔" />` renders both
variants (`aria-hidden`, the label living in the neighboring text) and CSS
shows exactly one per `[data-theme]`. One component, one CSS rule, no
duplicated conditional at each call site.

**Fonts.** Roboto locally through `@fontsource/roboto` (400/500/700/900,
latin subset), imported from `style.css` and served by the board's own
server. No runtime network request. `legacy` keeps the current system stack
as its `--font-ui`.

**What "frozen" means for legacy**, concretely: its theme file reproduces
today's values exactly — `#f1f5f9` ground, `#2563eb` for `inprogress`, 12px
radius, `shadow-md`, system font stack, emoji. Acceptance criterion: the
screenshots in `docs/images/board/` stay accurate under the legacy theme. A
screenshot that moves is a migration bug, not an improvement.

## Error handling

| Case | Behavior |
|---|---|
| `localStorage` unreadable or throwing | default theme and mode, choice not persisted, nothing surfaced to the user |
| Unknown stored value (`maggie:theme = 'neon'`) | falls back to `m3`, the bad value is overwritten |
| `data-theme` missing (JS disabled, boot error) | `contract.css` carries the `m3` light values, so the screen stays readable |
| `legacy` with a stored `dark` mode | renders light, control disabled, stored mode preserved and reapplied on the next Material theme |
| `getComputedStyle` empty (jsdom, canvas outside the DOM) | charts fall back to built-in constants |

## Testing

`apps/board` is exempt from the 100% coverage gate, but the project is
developed test-first.

- `theme.test.js` — default, restore, unknown value, throwing storage,
  attributes stamped on `documentElement`, theme and mode independent.
- `ThemeSwitcher.test.js`, `ModeSwitcher.test.js` — options rendered,
  `change` calls the setter, disabled under legacy with its tooltip.
- `themes.contract.test.js` — the guard that matters: it reads the five CSS
  files, extracts the variable names, and asserts every theme defines exactly
  the contract's set, light and dark (legacy: light only). A theme that
  forgets `--color-ink-faint` fails a test instead of shipping invisible text.
- `Icon.test.js` — both variants rendered, `aria-hidden`.
- Updates to `Card.test.js`, `Column.test.js` and `SessionRow.test.js`, which
  assert on literal Tailwind classes today (`ring-amber-300`, `ring-2`,
  `sky`): they move to semantic classes.
- Charts: colors re-read after a theme change, with `getComputedStyle`
  stubbed.

**Accessibility.** AA contrast checked across the eight combinations (four
themes × light/dark) for text on ground and for status chips. The `question`
status stays identifiable without color — the ring and the icon carry it for
a color-blind reader.

## Documentation

- `docs/board-dashboard.md` gains a "Themes" section: the four themes, the
  mode control, where the choice is stored, and what "frozen legacy" implies.
- `CHANGELOG.md`, and the `README.md` table if the wording needs it.
- Screenshots: the current images in `docs/images/board/` serve as the
  acceptance reference for the legacy theme during migration, then
  `docs/images/board/` is refreshed under `m3` — the new default — with one
  capture of the picker.

## Out of scope

Stated explicitly, to be pointed at when the question comes back:

- No user-customizable theme and no configurable source color (no dynamic
  color / seed picker).
- No server-side persistence — the choice is per-browser, like the language.
- No animated transition between themes.
- No structural divergence between themes.
- The History view follows the tokens but keeps its current layout.
