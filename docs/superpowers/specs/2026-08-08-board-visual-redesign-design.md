# Board Visual Redesign — Design

**Date:** 2026-08-08
**Status:** Approved (pending written-spec review)

## Purpose

The board's current look is flat and low-contrast: solid pastel column
headers (`bg-slate-200`/`bg-blue-200`/`bg-amber-300`/`bg-emerald-200`),
plain white cards with a thin border and `shadow-sm`, small slate text with
little hierarchy, and the same treatment (or none at all) on the summary
stats, filter bar, notification buttons, session detail panel, and history
table. The user flagged it directly from a screenshot as "moche" (ugly).

This is a CSS/markup-only pass — no data model, server, or behavioral
changes — that gives the whole board page (not just the columns/cards) a
more deliberate visual identity, validated against mockups during
brainstorming.

## Decisions (locked during brainstorming)

- **Direction: "Bold Kanban."** Three visual directions were mocked up
  (muted/editorial, bold/saturated, dark terminal-style); the user picked
  the bold one — solid-color pill headers, white cards with a colored left
  border and a real shadow, chip-style rows.
- **Scope: the whole board page**, not just columns/cards — confirmed
  explicitly ("all board"). Covers `App.vue`'s shell (title, view toggle,
  notification buttons), `FilterBar.vue`, `SummaryHeader.vue`,
  `RepoDetail.vue`, and `HistoryView.vue`, in addition to `Column.vue`,
  `Card.vue`, and `SessionRow.vue`.
- **No per-repo avatar monograms.** An early mockup included small colored
  initials badges (one per repo, color hashed from the name); the user
  explicitly chose to drop them to avoid the extra hashing logic and keep
  cards to repo name + session chips.
- **Status color system stays 4-way and keeps today's semantics** (todo /
  in progress / question / done), just restyled: slate / blue-600 /
  amber-600 / emerald-600. `question` keeps an extra visual alarm beyond its
  color — today's `ring-4 ring-amber-200` on the card becomes `ring-2
  ring-amber-300` layered on top of the new `shadow-md` (Tailwind's
  `ring-*` and `shadow-*` utilities compose into one `box-shadow` via CSS
  variables, so both render together without extra markup).
- **One shared source of truth for per-status styling**, not colors
  hand-picked independently in each component. Today, `App.vue`'s `COLUMNS`
  accent strings and `SummaryHeader.vue`'s hardcoded `text-amber-700`/
  `text-emerald-700` already pick colors independently for the same
  statuses — harmless at low saturation, but this redesign leans on exact
  color matching across pill headers, card borders, and summary chips to
  read as one system, so a small `statusStyles.js` becomes the single place
  that maps a status to its Tailwind classes.
- **Tailwind only sees classes that appear as literal strings** in files
  matched by `tailwind.config.js`'s `content` globs (`./index.html`,
  `./src/**/*.{vue,js}`) — a template string like `` `bg-${color}-600` ``
  would not be picked up by the build. `statusStyles.js` is inside
  `src/**`, so its object literal's full class strings (`'bg-blue-600'`,
  not pieces of it) satisfy the scanner.
- **No dark mode, no new dependencies, no layout restructuring** beyond
  what's described below (same components, same props/emits contracts
  except where noted).
- **Interaction with the in-flight drag-to-done work**
  (`2026-08-08-board-drag-to-done-design.md`): that feature adds
  `dragover`/`drop` listeners and a `ring-2 ring-emerald-400` hover state to
  the `Column.vue` body wrapper (the div holding the cards). This redesign
  restyles that same div (background/padding/radius) but doesn't remove it
  or change its role as the drop target — whichever of the two branches
  lands second should rebase its class changes onto the other's rather than
  reverting them.

## Design tokens — `apps/board/src/statusStyles.js` (new)

```js
export const STATUS_STYLES = {
  todo:       { label: 'To do',       pill: 'bg-slate-600',   border: 'border-slate-600',   chip: 'bg-slate-100 text-slate-600' },
  inprogress: { label: 'In progress', pill: 'bg-blue-600',    border: 'border-blue-600',    chip: 'bg-blue-50 text-blue-700' },
  question:   { label: 'Question',    pill: 'bg-amber-600',   border: 'border-amber-600',   chip: 'bg-amber-50 text-amber-700', ring: 'ring-2 ring-amber-300' },
  done:       { label: 'Done',        pill: 'bg-emerald-600', border: 'border-emerald-600', chip: 'bg-emerald-50 text-emerald-700' },
};
export const STATUS_ORDER = ['todo', 'inprogress', 'question', 'done'];
```

Pure data, no functions — no test file needed for it beyond what already
exercises it indirectly through the components below.

## Section 1 — `Column.vue`

- Imports `STATUS_STYLES` and looks itself up by its own `status` prop
  (`App.vue` no longer needs to pass an `accent` prop down).
- Header becomes a pill, not a full-width bar:
  `class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-white mb-2"`
  plus `STATUS_STYLES[status].pill`. Count stays inline as today —
  `To do (1)` as one text node — so the existing `toContain('(3)')`-style
  assertions in `App.test.js` keep passing unchanged.
- Body wrapper (holds the `Card`s) changes from
  `bg-slate-50 p-2 rounded-b-md` to `bg-white/50 rounded-xl p-2` — same
  role (padding + `min-h-[4rem]` placeholder space + drag-to-done's future
  drop target), different fill.
- Root stays a `<section>` — `App.test.js` asserts exactly 4 `section`
  elements.
- `App.vue`'s `COLUMNS` array drops the `accent` field and is derived from
  `STATUS_ORDER`/`STATUS_STYLES` instead of hand-listing each status:
  `const COLUMNS = STATUS_ORDER.map((status) => ({ status, title: STATUS_STYLES[status].label }))`.
  This removes the last place a column title was hand-duplicated outside
  `statusStyles.js`.

## Section 2 — `Card.vue`

- Root: `rounded-xl bg-white shadow-md p-3 border-l-4` +
  `STATUS_STYLES[status].border`, plus `STATUS_STYLES[status].ring` when
  `isQuestion` (replaces today's `border-amber-400 ring-4 ring-amber-200`
  branch).
- Repo name and "Aucune session active" placeholder text keep their current
  copy and structure — only classes change.
- Session list wrapper changes from `divide-y divide-slate-100` to
  `flex flex-col gap-1.5` (rows carry their own background now, so a
  divider would be redundant — see Section 3).

## Section 3 — `SessionRow.vue`

- Root goes from `py-1.5 cursor-pointer` to
  `bg-slate-50 hover:bg-slate-100 rounded-lg p-2 cursor-pointer transition-colors`
  — each row is its own chip inside the card.
- Title/meta/prompt text keep their current copy, size classes (`text-sm`,
  `text-xs`), and color intent (slate-800 title, slate-500 meta,
  slate-600 prompt) — just sit inside the new chip background.
- Token badge changes from a bare inline "· 1.6M tokens" text run to a
  small pill: `inline-block bg-slate-200/70 text-slate-600 font-medium
  text-xs px-1.5 py-0.5 rounded ml-1`. Deliberately neutral gray, not a
  status color, so it doesn't compete with the column's meaning.

## Section 4 — `App.vue` shell

- `<main>`: `p-4` → `p-6` (more breathing room); background stays
  `bg-slate-100` (already close to the approved mockup's page tint).
- Title: `text-lg font-bold` → `text-xl font-bold text-slate-900`.
- Board/Historique switches from two plain text buttons to a segmented
  pill toggle: wrapper `inline-flex items-center bg-slate-100 rounded-lg
  p-0.5 gap-0.5`; each button `rounded-md px-3 py-1 text-sm font-medium
  transition-colors`, active state `bg-white shadow-sm text-slate-900`,
  inactive `text-slate-500 hover:text-slate-700`. Same click handlers and
  `data-test` attributes as today.
- 🔔/🔊 buttons: `border-slate-300 rounded-md` → `border-slate-200
  rounded-lg shadow-sm hover:shadow`. Same logic/attributes.

## Section 5 — `FilterBar.vue`

- Search input and tech `<select>`: `rounded-md` → `rounded-lg`, add
  `shadow-sm` and `focus:outline-none focus:ring-2 focus:ring-blue-500/30
  focus:border-blue-400`. No structural or behavioral change.

## Section 6 — `SummaryHeader.vue`

- Replace the single inline-text summary line with a row of chips, one per
  stat, using `STATUS_STYLES[status].chip` for the four status counts plus
  a neutral `bg-slate-100 text-slate-700` chip for the repo total:
  `<span class="rounded-md px-2 py-0.5 text-xs font-semibold" :class="chip">N label</span>`.
- Progress bar: track `h-2` → `h-2.5`, fill `bg-emerald-500` →
  `bg-gradient-to-r from-emerald-400 to-emerald-600`.
- Outer container: `rounded-lg` → `rounded-xl`, add `shadow-sm`.
- `counts`/`percentDone` computed logic is unchanged — styling only.

## Section 7 — `RepoDetail.vue`

- Panel: `shadow-xl` stays; add a bottom border under the header block
  (`pb-3 border-b border-slate-100 mb-3`) for clearer separation from the
  prompt/history content below.
- Technology/target tag chips: `rounded` → `rounded-full`, `font-medium`
  added for a bit more presence. Same data, same conditional rendering.

## Section 8 — `HistoryView.vue`

- Container: `rounded-lg` → `rounded-xl`, add `shadow-sm`.
- `<thead>` row: add `bg-slate-50` and `uppercase tracking-wide` on the
  existing `text-slate-500` header text for a clearer table-header feel.
- `<tbody>` rows: add `odd:bg-slate-50/60 hover:bg-slate-50` for zebra
  striping and hover feedback.
- Total column value: wrap in a small chip,
  `inline-block bg-slate-100 rounded px-1.5 py-0.5 font-semibold`, instead
  of bare `font-medium` text.
- Sorting logic, columns, and data are unchanged.

## Section 9 — Testing

`apps/board` is exempt from the repo's 100% coverage gate
(`CONTRIBUTING.md`), and this is a styling-only pass with no new branches,
so no new test files are needed. One existing assertion is tied to a class
string that's changing:

- **`Card.test.js`** — `'highlights a question card'` currently asserts
  `w.classes().join(' ')).toContain('ring-amber-200')`; update to
  `'ring-amber-300'` to match the new `STATUS_STYLES.question.ring`.

A repo-wide check confirmed this is the *only* test in `apps/board`
asserting a specific Tailwind class string — everything else asserts on
rendered text, `data-test` attributes, or emitted events, none of which
change here. Full board test suite (`App.test.js`, `Card.test.js`,
`SessionRow.test.js`, `Column` coverage via `App.test.js`,
`SummaryHeader.test.js`, `FilterBar.test.js`, `RepoDetail.test.js`,
`HistoryView.test.js`) must still pass after the restyle.

## Out of scope (YAGNI)

- Dark mode.
- Per-repo avatar monograms (explicitly dropped, see Decisions).
- Any change to `apps/board/server.js`, `board.json`'s shape, or how data
  flows into the Vue components — props/emits contracts are unchanged
  except `Column.vue` no longer needs an `accent` prop.
- The drag-to-done feature itself (separate spec/branch) — this design
  only notes the shared touch point in `Column.vue`'s body wrapper.
- A generic "theme" system, design-token file beyond the one small
  `statusStyles.js`, or any new npm dependency.
