# Board Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole board app (`apps/board/src`) from its current flat, low-contrast look to the "Bold Kanban" direction approved during brainstorming — solid-color pill column headers, white cards with a colored left border and real shadow, chip-style session rows, and matching treatment on the header/nav, filter bar, summary stats, detail panel, and history table.

**Architecture:** Pure CSS/markup pass, no data flow or behavior changes. One new file, `apps/board/src/statusStyles.js`, becomes the single source of truth for per-status Tailwind classes (pill background, card left-border, chip background) so the four statuses (`todo`/`inprogress`/`question`/`done`) read as one consistent color system across every component instead of each component picking colors independently. Every other change is template/class edits to existing components.

**Tech Stack:** Vue 3 (`<script setup>`), Tailwind CSS (utility classes only, JIT-scanned from literal strings in `src/**/*.vue|js`), Vitest + `@vue/test-utils` for component tests.

**Spec:** `docs/superpowers/specs/2026-08-08-board-visual-redesign-design.md`

**Note on commits:** this project's assistant policy is that commits are made by a human, not the assistant. Each task below ends with a "stage the change" step (`git add`) instead of a commit — pause there for the user (or whoever is driving the execution skill) to review the diff and commit it before moving to the next task.

---

### Task 1: Create the shared status style tokens

**Files:**
- Create: `apps/board/src/statusStyles.js`

- [ ] **Step 1: Write the file**

```js
// apps/board/src/statusStyles.js
export const STATUS_STYLES = {
  todo: {
    label: 'To do',
    pill: 'bg-slate-600',
    border: 'border-slate-600',
    chip: 'bg-slate-100 text-slate-600',
  },
  inprogress: {
    label: 'In progress',
    pill: 'bg-blue-600',
    border: 'border-blue-600',
    chip: 'bg-blue-50 text-blue-700',
  },
  question: {
    label: 'Question',
    pill: 'bg-amber-600',
    border: 'border-amber-600',
    chip: 'bg-amber-50 text-amber-700',
    ring: 'ring-2 ring-amber-300',
  },
  done: {
    label: 'Done',
    pill: 'bg-emerald-600',
    border: 'border-emerald-600',
    chip: 'bg-emerald-50 text-emerald-700',
  },
};

export const STATUS_ORDER = ['todo', 'inprogress', 'question', 'done'];
```

This is pure data (no functions), so per the spec it doesn't need its own test file — it's exercised indirectly through every component that imports it in the tasks below.

- [ ] **Step 2: Stage the change**

```bash
git add apps/board/src/statusStyles.js
```

---

### Task 2: Restyle `Column.vue`

**Files:**
- Modify: `apps/board/src/Column.vue`
- Modify: `apps/board/src/App.vue` (drop the `accent` binding passed into `Column`)

- [ ] **Step 1: Replace `Column.vue`'s contents**

```vue
<script setup>
import { computed } from 'vue';
import Card from './Card.vue';
import { STATUS_STYLES } from './statusStyles.js';

const props = defineProps({
  title: { type: String, required: true },
  status: { type: String, required: true },
  entries: { type: Array, required: true }, // [{ name, sessions }]
  now: { type: Number, default: () => Date.now() },
});
defineEmits(['open']);

const style = computed(() => STATUS_STYLES[props.status]);
</script>

<template>
  <section class="min-w-0">
    <h2 :class="['inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-white mb-2', style.pill]">
      {{ title }} <span class="opacity-80">({{ entries.length }})</span>
    </h2>
    <div class="flex flex-col gap-2 bg-white/50 rounded-xl p-2 min-h-[4rem]">
      <Card v-for="e in entries" :key="e.name" :name="e.name" :sessions="e.sessions" :status="status" :now="now" @open="$emit('open', $event)" />
    </div>
  </section>
</template>
```

Note for whoever picks up the in-flight drag-to-done branch: the `<div class="flex flex-col gap-2 bg-white/50 rounded-xl p-2 min-h-[4rem]">` above is the div that design adds `dragover`/`drop`/highlight classes to — rebase those additions onto this restyled version rather than the old `bg-slate-50 p-2 rounded-b-md` one.

- [ ] **Step 2: Remove the now-unused `accent` field and binding in `App.vue`**

In `apps/board/src/App.vue`, change:

```js
const COLUMNS = [
  { status: 'todo', title: 'To do', accent: 'bg-slate-200' },
  { status: 'inprogress', title: 'In progress', accent: 'bg-blue-200' },
  { status: 'question', title: 'Question', accent: 'bg-amber-300' },
  { status: 'done', title: 'Done', accent: 'bg-emerald-200' },
];
```

to:

```js
import { STATUS_ORDER, STATUS_STYLES } from './statusStyles.js';

const COLUMNS = STATUS_ORDER.map((status) => ({ status, title: STATUS_STYLES[status].label }));
```

(Add the import at the top of the `<script setup>` block alongside the other imports.)

Then change the `Column` usage:

```html
        <Column
          v-for="c in grouped" :key="c.status"
          :title="c.title" :status="c.status" :accent="c.accent" :entries="c.entries" :now="now"
          @open="selected = $event"
        />
```

to:

```html
        <Column
          v-for="c in grouped" :key="c.status"
          :title="c.title" :status="c.status" :entries="c.entries" :now="now"
          @open="selected = $event"
        />
```

- [ ] **Step 3: Run the board test suite to confirm nothing broke**

Run: `npx vitest run --root apps/board`
Expected: all existing tests PASS, including `App.test.js`'s check for exactly 4 `section` elements and the `(3)`-style count text.

- [ ] **Step 4: Stage the change**

```bash
git add apps/board/src/Column.vue apps/board/src/App.vue
```

---

### Task 3: Restyle `Card.vue` (TDD on the question-highlight class)

**Files:**
- Modify: `apps/board/src/Card.vue`
- Modify: `apps/board/src/Card.test.js`

- [ ] **Step 1: Update the failing assertion first**

In `apps/board/src/Card.test.js`, change:

```js
test('highlights a question card', () => {
  const w = mount(Card, { props: { name: 'oc-auth', sessions: [session()], status: 'question', now } });
  expect(w.classes().join(' ')).toContain('ring-amber-200');
});
```

to:

```js
test('highlights a question card', () => {
  const w = mount(Card, { props: { name: 'oc-auth', sessions: [session()], status: 'question', now } });
  expect(w.classes().join(' ')).toContain('ring-amber-300');
});
```

- [ ] **Step 2: Run the test to verify it now fails**

Run: `npx vitest run --root apps/board src/Card.test.js`
Expected: FAIL on `'highlights a question card'` — current `Card.vue` still renders `ring-amber-200`, not `ring-amber-300`.

- [ ] **Step 3: Replace `Card.vue`'s contents**

```vue
<script setup>
import { computed } from 'vue';
import SessionRow from './SessionRow.vue';
import { STATUS_STYLES } from './statusStyles.js';

const props = defineProps({
  name: { type: String, required: true },
  sessions: { type: Array, required: true }, // [{ sessionId, title, lastPrompt, updatedAt, lastEvent, ... }]
  status: { type: String, required: true },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open']);

const isQuestion = computed(() => props.status === 'question');
const style = computed(() => STATUS_STYLES[props.status]);

function open(sessionId) {
  emit('open', { name: props.name, sessionId });
}
</script>

<template>
  <div
    :class="['rounded-xl bg-white shadow-md p-3 border-l-4', style.border, isQuestion ? style.ring : '']"
  >
    <div class="font-medium text-slate-800">{{ name }}</div>
    <p v-if="sessions.length === 0" class="mt-1 text-xs text-slate-400">Aucune session active</p>
    <div v-else class="mt-2 flex flex-col gap-1.5">
      <SessionRow v-for="s in sessions" :key="s.sessionId" :session="s" :now="now" @open="open" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root apps/board src/Card.test.js`
Expected: PASS, all 4 tests in the file.

- [ ] **Step 5: Stage the change**

```bash
git add apps/board/src/Card.vue apps/board/src/Card.test.js
```

---

### Task 4: Restyle `SessionRow.vue`

**Files:**
- Modify: `apps/board/src/SessionRow.vue`

- [ ] **Step 1: Update the template**

In `apps/board/src/SessionRow.vue`, change the `<template>` block from:

```vue
<template>
  <div
    role="button"
    tabindex="0"
    data-test="session-row"
    class="py-1.5 cursor-pointer"
    @click="open"
    @keydown.enter="open"
    @keydown.space.prevent="open"
  >
    <div class="font-medium text-slate-800 text-sm truncate">{{ session.title ?? '(sans titre)' }}</div>
    <div class="text-xs text-slate-500">
      {{ session.lastEvent }} · {{ when }}
      <span v-if="usage" data-test="token-badge" :title="usageTooltip" class="ml-1 text-slate-400">· {{ formatTokens(totalTokens) }} tokens</span>
    </div>
    <p v-if="prompt" class="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
      {{ displayedPrompt }}
      <button
        v-if="overflows"
        type="button"
        data-test="toggle-prompt"
        class="text-blue-600 hover:underline"
        @click="toggle"
      >{{ expanded ? 'voir moins' : 'voir plus' }}</button>
    </p>
  </div>
</template>
```

to:

```vue
<template>
  <div
    role="button"
    tabindex="0"
    data-test="session-row"
    class="bg-slate-50 hover:bg-slate-100 rounded-lg p-2 cursor-pointer transition-colors"
    @click="open"
    @keydown.enter="open"
    @keydown.space.prevent="open"
  >
    <div class="font-medium text-slate-800 text-sm truncate">{{ session.title ?? '(sans titre)' }}</div>
    <div class="text-xs text-slate-500">
      {{ session.lastEvent }} · {{ when }}
      <span v-if="usage" data-test="token-badge" :title="usageTooltip" class="inline-block ml-1 bg-slate-200/70 text-slate-600 font-medium px-1.5 py-0.5 rounded">{{ formatTokens(totalTokens) }} tokens</span>
    </div>
    <p v-if="prompt" class="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
      {{ displayedPrompt }}
      <button
        v-if="overflows"
        type="button"
        data-test="toggle-prompt"
        class="text-blue-600 hover:underline"
        @click="toggle"
      >{{ expanded ? 'voir moins' : 'voir plus' }}</button>
    </p>
  </div>
</template>
```

(Script block is unchanged — only the template's classes and the token badge's markup move.)

- [ ] **Step 2: Update `Card.vue`'s row wrapper to drop the now-redundant divider**

In `apps/board/src/Card.vue` (already edited in Task 3), the session list wrapper is:

```html
    <div v-else class="mt-2 flex flex-col gap-1.5">
```

Confirm this is already in place from Task 3 (it replaced the old `divide-y divide-slate-100` wrapper) — no further edit needed here, this step is just a checkpoint since rows now carry their own background and a divider would look wrong on top of it.

- [ ] **Step 3: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/SessionRow.test.js src/Card.test.js`
Expected: PASS. The token badge text assertion (`toContain('36.6K tokens')`) and tooltip assertion still match — only the leading "· " and surrounding classes changed, not the text content.

- [ ] **Step 4: Stage the change**

```bash
git add apps/board/src/SessionRow.vue
```

---

### Task 5: Restyle the `App.vue` page shell (title, nav toggle, buttons, spacing)

**Files:**
- Modify: `apps/board/src/App.vue`

- [ ] **Step 1: Update the top-of-page markup**

In `apps/board/src/App.vue`, change:

```html
  <main class="min-h-screen bg-slate-100 p-4">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-bold text-slate-800">ai-sync · workspace board</h1>
        <div class="flex items-center gap-1 text-sm">
          <button
            data-test="view-board"
            :class="view === 'board' ? 'font-semibold text-slate-800' : 'text-slate-400'"
            @click="view = 'board'"
          >Board</button>
          <span class="text-slate-300">·</span>
          <button
            data-test="view-history"
            :class="view === 'history' ? 'font-semibold text-slate-800' : 'text-slate-400'"
            @click="view = 'history'; loadHistory()"
          >Historique</button>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <FilterBar
          v-if="view === 'board'"
          :name="nameFilter" :tech="techFilter" :technologies="technologies"
          @update:name="nameFilter = $event" @update:tech="techFilter = $event"
        />
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>
```

to:

```html
  <main class="min-h-screen bg-slate-100 p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-slate-900">ai-sync · workspace board</h1>
        <div class="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
          <button
            data-test="view-board"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', view === 'board' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
            @click="view = 'board'"
          >Board</button>
          <button
            data-test="view-history"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', view === 'history' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
            @click="view = 'history'; loadHistory()"
          >Historique</button>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <FilterBar
          v-if="view === 'board'"
          :name="nameFilter" :tech="techFilter" :technologies="technologies"
          @update:name="nameFilter = $event" @update:tech="techFilter = $event"
        />
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>
```

(The `<span class="text-slate-300">·</span>` separator between Board/Historique is removed — the segmented pill's own background now separates the two states, so the dot is redundant. No test asserts on that separator.)

- [ ] **Step 2: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/App.test.js`
Expected: PASS. `data-test=view-board` / `data-test=view-history` still exist with the same click handlers, `[data-test=search]` from `FilterBar` is unaffected.

- [ ] **Step 3: Stage the change**

```bash
git add apps/board/src/App.vue
```

---

### Task 6: Restyle `FilterBar.vue`

**Files:**
- Modify: `apps/board/src/FilterBar.vue`

- [ ] **Step 1: Update the input/select classes**

In `apps/board/src/FilterBar.vue`, change:

```vue
<template>
  <div class="flex items-center gap-2 flex-wrap">
    <input
      data-test="search"
      :value="name"
      @input="$emit('update:name', $event.target.value)"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white flex-1 min-w-0"
    />
    <select
      data-test="tech"
      :value="tech"
      @change="$emit('update:tech', $event.target.value)"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-600"
    >
      <option value="">techno : toutes</option>
      <option v-for="t in technologies" :key="t" :value="t">{{ t }}</option>
    </select>
  </div>
</template>
```

to:

```vue
<template>
  <div class="flex items-center gap-2 flex-wrap">
    <input
      data-test="search"
      :value="name"
      @input="$emit('update:name', $event.target.value)"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-200 rounded-lg shadow-sm px-3 py-1.5 text-sm bg-white flex-1 min-w-0 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
    />
    <select
      data-test="tech"
      :value="tech"
      @change="$emit('update:tech', $event.target.value)"
      class="border border-slate-200 rounded-lg shadow-sm px-3 py-1.5 text-sm bg-white text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
    >
      <option value="">techno : toutes</option>
      <option v-for="t in technologies" :key="t" :value="t">{{ t }}</option>
    </select>
  </div>
</template>
```

- [ ] **Step 2: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/FilterBar.test.js`
Expected: PASS.

- [ ] **Step 3: Stage the change**

```bash
git add apps/board/src/FilterBar.vue
```

---

### Task 7: Restyle `SummaryHeader.vue` (stat chips + progress bar)

**Files:**
- Modify: `apps/board/src/SummaryHeader.vue`

- [ ] **Step 1: Update the script and template**

In `apps/board/src/SummaryHeader.vue`, add the import and change the `<template>` block. Full new file:

```vue
<script setup>
import { computed } from 'vue';
import { STATUS_STYLES } from './statusStyles.js';

const props = defineProps({ repos: { type: Object, required: true } });

// A repo with zero active sessions counts as one "todo" card (same
// placeholder behavior the board itself shows); otherwise every session
// counts individually, so a repo with two concurrent sessions counts twice.
const counts = computed(() => {
  const c = { todo: 0, inprogress: 0, question: 0, done: 0 };
  for (const repoEntry of Object.values(props.repos)) {
    const sessions = Object.values(repoEntry.sessions ?? {});
    if (sessions.length === 0) { c.todo += 1; continue; }
    for (const s of sessions) if (c[s.status] !== undefined) c[s.status] += 1;
  }
  return c;
});
const total = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0));
const percentDone = computed(() => (total.value ? Math.round((counts.value.done / total.value) * 100) : 0));
</script>

<template>
  <div class="bg-white border border-slate-200 rounded-xl shadow-sm px-4 py-3 mb-4">
    <div class="flex flex-wrap gap-2 mb-2.5">
      <span class="rounded-md px-2 py-0.5 text-xs font-semibold bg-slate-100 text-slate-700">{{ total }} repos</span>
      <span :class="['rounded-md px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.todo.chip]">{{ counts.todo }} To do</span>
      <span :class="['rounded-md px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.inprogress.chip]">{{ counts.inprogress }} In progress</span>
      <span :class="['rounded-md px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.question.chip]">{{ counts.question }} Question</span>
      <span :class="['rounded-md px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.done.chip]">{{ counts.done }} Done</span>
    </div>
    <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
      <div data-test="progress" class="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 rounded-full" :style="{ width: percentDone + '%' }"></div>
    </div>
    <div class="text-xs text-slate-400 mt-1">{{ percentDone }} % terminé</div>
  </div>
</template>
```

- [ ] **Step 2: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/SummaryHeader.test.js`
Expected: PASS. `toContain('5')`, `toContain('1 Question')`, `toContain('2 Done')`, `toContain('40 %')`, and the `[data-test=progress]` style-width check all still match the new chip text (`"1 Question"`/`"2 Done"` render as literal substrings even though the surrounding `·` separators are gone).

- [ ] **Step 3: Stage the change**

```bash
git add apps/board/src/SummaryHeader.vue
```

---

### Task 8: Restyle `RepoDetail.vue`

**Files:**
- Modify: `apps/board/src/RepoDetail.vue`

- [ ] **Step 1: Update the template**

In `apps/board/src/RepoDetail.vue`, change the `<template>` block from:

```vue
<template>
  <div v-if="name" class="fixed inset-0 z-20">
    <div data-test="overlay" class="absolute inset-0 bg-slate-900/30" @click="emit('close')"></div>
    <aside class="absolute right-0 top-0 h-full w-full sm:w-80 max-w-full bg-white shadow-xl p-4 overflow-y-auto">
      <button class="float-right text-slate-400 hover:text-slate-600" @click="emit('close')">✕</button>
      <h2 class="font-bold text-slate-800">{{ name }}</h2>
      <p v-if="session?.title" class="text-sm text-slate-600 mt-1">{{ session.title }}</p>
      <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
         class="text-sm text-blue-600 underline break-all">{{ meta.url }}</a>
      <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
        <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs bg-slate-100 px-2 py-0.5 rounded">{{ t }}</span>
        <span v-for="t in (meta.targets || [])" :key="t" class="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{{ t }}</span>
      </div>
      <p v-if="session?.lastPrompt" class="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{{ session.lastPrompt }}</p>
      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">Historique</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (session?.events || [])" :key="i" class="text-xs text-slate-600">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
```

to:

```vue
<template>
  <div v-if="name" class="fixed inset-0 z-20">
    <div data-test="overlay" class="absolute inset-0 bg-slate-900/30" @click="emit('close')"></div>
    <aside class="absolute right-0 top-0 h-full w-full sm:w-80 max-w-full bg-white shadow-xl p-4 overflow-y-auto">
      <button class="float-right text-slate-400 hover:text-slate-600" @click="emit('close')">✕</button>
      <div class="pb-3 border-b border-slate-100 mb-3">
        <h2 class="font-bold text-slate-900">{{ name }}</h2>
        <p v-if="session?.title" class="text-sm text-slate-600 mt-1">{{ session.title }}</p>
        <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
           class="text-sm text-blue-600 underline break-all">{{ meta.url }}</a>
        <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
          <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs font-medium bg-slate-100 px-2 py-0.5 rounded-full">{{ t }}</span>
          <span v-for="t in (meta.targets || [])" :key="t" class="text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{{ t }}</span>
        </div>
      </div>
      <p v-if="session?.lastPrompt" class="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{{ session.lastPrompt }}</p>
      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">Historique</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (session?.events || [])" :key="i" class="text-xs text-slate-600">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
```

(Script block is unchanged.)

- [ ] **Step 2: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/RepoDetail.test.js`
Expected: PASS. The anchor (`w.get('a')`), tag text, prompt text, and event-timeline assertions are all unaffected by the wrapping `<div>` and class changes.

- [ ] **Step 3: Stage the change**

```bash
git add apps/board/src/RepoDetail.vue
```

---

### Task 9: Restyle `HistoryView.vue`

**Files:**
- Modify: `apps/board/src/HistoryView.vue`

- [ ] **Step 1: Update the template**

In `apps/board/src/HistoryView.vue`, change the `<template>` block from:

```vue
<template>
  <div class="bg-white border border-slate-200 rounded-lg p-4">
    <input
      data-test="history-repo-filter"
      v-model="repoFilter"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white mb-3"
    />
    <table class="w-full text-sm text-left">
      <thead>
        <tr class="text-slate-500 border-b border-slate-200">
          <th class="py-1 pr-3 cursor-pointer" data-test="sort-repo" @click="sortBy('repo')">Repo</th>
          <th class="py-1 pr-3 cursor-pointer" data-test="sort-title" @click="sortBy('title')">Titre</th>
          <th class="py-1 pr-3">Démarrée</th>
          <th class="py-1 pr-3">Terminée</th>
          <th class="py-1 pr-3">Durée</th>
          <th class="py-1 pr-3 text-right">Input</th>
          <th class="py-1 pr-3 text-right">Output</th>
          <th class="py-1 pr-3 text-right">Cache écrit</th>
          <th class="py-1 pr-3 text-right">Cache lu</th>
          <th class="py-1 pr-3 text-right cursor-pointer" data-test="sort-total" @click="sortBy('total')">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in rows" :key="`${e.repo}-${e.sessionId}`" data-test="history-row" class="border-b border-slate-100">
          <td class="py-1 pr-3">{{ e.repo }}</td>
          <td class="py-1 pr-3">{{ e.title ?? '(sans titre)' }}</td>
          <td class="py-1 pr-3">{{ e.startedAt }}</td>
          <td class="py-1 pr-3">{{ e.endedAt }}</td>
          <td class="py-1 pr-3">{{ durationLabel(e) }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.inputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.outputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.cacheCreationInputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.cacheReadInputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right font-medium">{{ formatTokens(totalOf(e)) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="text-xs text-slate-400 mt-2">Aucune session terminée pour l'instant.</p>
  </div>
</template>
```

to:

```vue
<template>
  <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
    <input
      data-test="history-repo-filter"
      v-model="repoFilter"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-200 rounded-lg shadow-sm px-3 py-1.5 text-sm bg-white mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
    />
    <table class="w-full text-sm text-left">
      <thead>
        <tr class="text-slate-500 bg-slate-50 uppercase tracking-wide text-xs border-b border-slate-200">
          <th class="py-2 px-3 cursor-pointer" data-test="sort-repo" @click="sortBy('repo')">Repo</th>
          <th class="py-2 px-3 cursor-pointer" data-test="sort-title" @click="sortBy('title')">Titre</th>
          <th class="py-2 px-3">Démarrée</th>
          <th class="py-2 px-3">Terminée</th>
          <th class="py-2 px-3">Durée</th>
          <th class="py-2 px-3 text-right">Input</th>
          <th class="py-2 px-3 text-right">Output</th>
          <th class="py-2 px-3 text-right">Cache écrit</th>
          <th class="py-2 px-3 text-right">Cache lu</th>
          <th class="py-2 px-3 text-right cursor-pointer" data-test="sort-total" @click="sortBy('total')">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in rows" :key="`${e.repo}-${e.sessionId}`" data-test="history-row" class="border-b border-slate-100 odd:bg-slate-50/60 hover:bg-slate-50">
          <td class="py-1.5 px-3">{{ e.repo }}</td>
          <td class="py-1.5 px-3">{{ e.title ?? '(sans titre)' }}</td>
          <td class="py-1.5 px-3">{{ e.startedAt }}</td>
          <td class="py-1.5 px-3">{{ e.endedAt }}</td>
          <td class="py-1.5 px-3">{{ durationLabel(e) }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.inputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.outputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.cacheCreationInputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.cacheReadInputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">
            <span class="inline-block bg-slate-100 rounded px-1.5 py-0.5 font-semibold">{{ formatTokens(totalOf(e)) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="text-xs text-slate-400 mt-2">Aucune session terminée pour l'instant.</p>
  </div>
</template>
```

(Script block is unchanged — sorting, filtering, and `totalOf`/`durationLabel` logic are untouched.)

- [ ] **Step 2: Run the test to verify nothing broke**

Run: `npx vitest run --root apps/board src/HistoryView.test.js`
Expected: PASS. Row count, placeholder text, repo-filter, and sort-by-column-click assertions are all unaffected — only classes and the total cell's wrapping `<span>` changed.

- [ ] **Step 3: Stage the change**

```bash
git add apps/board/src/HistoryView.vue
```

---

### Task 10: Full test suite + lint pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full board test suite**

Run: `npx vitest run --root apps/board`
Expected: PASS, every test file green (this catches any cross-component regression the per-file runs in Tasks 2–9 might have missed, e.g. `useBoard.test.js`, `useNotifications.test.js`, `useConfig.test.js`, `useHistory.test.js`, `useRelativeTime.test.js`, none of which touch styling but should still be confirmed unaffected).

- [ ] **Step 2: Run the repo-wide test target for the board app**

Run: `npm run test:board`
Expected: PASS (this is the same suite via the Nx target, confirming it also works through the project's normal CI entry point).

- [ ] **Step 3: Lint the changed files**

Run: `npx eslint apps/board/src`
Expected: no errors. Fix any Vue/ESLint issues surfaced (e.g. attribute ordering) before continuing — don't disable rules to force a pass.

---

### Task 11: Manual visual verification in the browser

**Files:** none (verification only)

- [ ] **Step 1: Launch the board app**

Use the `run` skill to start `apps/board` (it will pick the right launch command for this project — a Vite/Node app with a browser UI) and open it in a browser.

- [ ] **Step 2: Compare against the approved direction**

With the board loaded, check each of the following against what was approved in brainstorming:
- Column headers are solid-color pills (`slate`/`blue`/`amber`/`emerald`) with the title and count on one line, not full-width bars.
- Cards are white with a visible colored left border matching their column, and a real shadow (not the old hairline `shadow-sm`).
- A card in the Question column has the extra amber ring/glow on top of its left border.
- Session rows inside a card are individually chipped (light gray background), not separated by thin dividers.
- The token-usage badge is a small neutral gray pill, not competing in color with the status.
- Board/Historique is a segmented pill toggle, not two plain underlined-feeling text links.
- The 🔔/🔊 buttons and filter/search inputs have rounded-lg corners and a soft shadow.
- The summary stats render as colored chips (repos/todo/in progress/question/done), not a single plain text line, with a visibly thicker gradient progress bar underneath.
- Switching to the Historique tab shows a table with a shaded header row and zebra-striped rows, matching the same rounded/shadow container style as the rest of the page.
- No layout is broken at a narrow window width (columns should wrap via the existing responsive grid, not overflow).

- [ ] **Step 3: Report back**

If everything matches, the redesign is complete. If something looks off (a color that doesn't read as intended, spacing that feels cramped, etc.), note exactly which element and what's wrong so it can be adjusted — this is a visual pass, so eyeballing the real rendered page is the actual acceptance test, not just green tests.

---

## Out of scope (per spec)

- Dark mode.
- Per-repo avatar monograms (considered and explicitly dropped during brainstorming).
- Any change to `apps/board/server.js`, `board.json`'s shape, or component props/emits contracts other than `Column.vue` dropping its `accent` prop.
- The drag-to-done feature itself — only the shared touch point in `Column.vue`'s body wrapper is called out above.
