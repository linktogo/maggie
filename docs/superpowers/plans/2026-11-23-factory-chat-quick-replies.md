# Factory chat: medium-width layout and quick replies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the conversation the room between `md` and `xl`, and offer one-click answers to an agent's choice question.

**Architecture:** A pure parser (`quickReplies.js`) turns the last agent message into choices; `FactoryPage` computes them and hands them to `FactoryComposer`, which renders the chips above its form and sends a click through its existing `submit` path. Layout changes are Tailwind classes in `FactoryPage` / `FactoryConversation` plus a project `<select>` in the Requests pane.

**Tech Stack:** Vue 3 SFCs, Tailwind v4, vitest + @vue/test-utils (100% coverage gate, `nx run board:test`).

**Spec:** `docs/superpowers/specs/2026-11-23-factory-chat-quick-replies-design.md`

## Global Constraints

- Breakpoints: three columns from `xl` (1280 px) up; `md`–`xl` two columns `[20rem | 1fr]`; below `md` unchanged.
- At most 6 choices; labels trimmed to 60 characters; ordered items sent as `<n>. <label>`.
- Yes/no auxiliaries — EN: should, shall, do, does, can, could, would, will, is, are, may; FR: dois-je, faut-il, veux-tu, voulez-vous, souhaites-tu, souhaitez-vous, est-ce.
- Chips only when the thread is idle and resumable and the last message is an agent text question; only for the last message.
- Every new string in en/fr/de/es (`i18n.test.js` checks the key sets match).

## Review Focus

- A question whose list is followed by more paragraphs (list in the middle): choices come from the **last** list only, still offered → test in Task 1.
- A list in an agent message that is *not* a question (a summary ending with a full stop): no chips → Task 1.
- More than 6 items: only the first 6 → Task 1.
- A click while a previous send is pending, or a refused send: no double send; the chips stay usable after a refusal → Task 2.
- A project selected from the `<select>` at md–xl navigates exactly like a click in the Projects pane → Task 3.

---

### Task 1: `quickReplies.js` parser

**Files:**
- Create: `apps/board/src/quickReplies.js`, `apps/board/src/quickReplies.test.js`
- Modify: `apps/board/src/FactoryConversation.vue` (import `asksQuestion` instead of its local copy)

**Interfaces:**
- Produces: `asksQuestion(text: string): boolean` (moved verbatim from `FactoryConversation.vue`);
  `quickReplies(messages: Message[], { yes: string, no: string }): Array<{ label: string, text: string }>` — `[]` when nothing applies. It looks only at `messages.at(-1)`; it requires `role === 'agent'`, `kind === 'text'` and `asksQuestion(content)`. Idle/resumable is the caller's concern.

- [ ] **Step 1: Write the failing tests** in `quickReplies.test.js`:
  - ordered list `1. **In memory** — quickest…` / `2. **PostgreSQL with TypeORM** — matches…` / `3. **Prisma** — new dependency` ending `Which one do you want?` → `[{label:'In memory',text:'1. In memory'},{label:'PostgreSQL with TypeORM',text:'2. PostgreSQL with TypeORM'},{label:'Prisma',text:'3. Prisma'}]`
  - bullet list `- Keep it - simple` / `* Rewrite: from scratch` → labels `Keep it`, `Rewrite` (separator rule), texts equal labels (unordered)
  - two lists, question after the second → only the second list's items
  - 8 items → 6 returned; an 80-char label → 60 chars
  - `Should I also add the migration?` → `[{label:'Yes',text:'Yes'},{label:'No',text:'No'}]` with `{ yes:'Yes', no:'No' }`; `Faut-il ajouter la migration ?` → yes/no too
  - `What should the module be called?` → `[]` (no list, not an auxiliary)
  - last message from the user, a `step`, or an agent text ending with `.` → `[]`; empty `messages` → `[]`
  - `asksQuestion` keeps its current behaviour (`'Ok?**'` true, `'Ok.'` false)
- [ ] **Step 2:** `npx vitest run apps/board/src/quickReplies.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement. List lines: `/^\s*(\d+)[.)]\s+(.+)$/` (ordered) or `/^\s*[-*+]\s+(.+)$/`; a group is consecutive list lines (blank lines inside allowed); take the last group. Label: leading `**x**`/`__x__` content if present, else text before the first ` — `, ` – `, ` - ` or `:`; strip `*`, `_`, `` ` ``; trim; cut at 60. Yes/no: last sentence of the last line containing `?`, lower-cased, starts with an auxiliary from Global Constraints. In `FactoryConversation.vue`, replace the local `asksQuestion` with the import.
- [ ] **Step 4:** Same command → PASS; `npx vitest run apps/board/src/FactoryConversation.test.js` still PASS.
- [ ] **Step 5:** Commit `feat(factory): parse an agent's choice question into quick replies`.

### Task 2: chips above the composer, sent on click

**Files:**
- Modify: `apps/board/src/FactoryComposer.vue`, `apps/board/src/FactoryComposer.test.js`, `apps/board/src/FactoryPage.vue`, `apps/board/src/FactoryPage.test.js`, `apps/board/src/locales/{en,fr,de,es}.js`

**Interfaces:**
- Consumes: `quickReplies(messages, { yes, no })` from Task 1.
- Produces: `FactoryComposer` prop `choices: Array<{label,text}>` (default `[]`); chips `data-test="factory-quick-reply"`, other chip `data-test="factory-quick-other"`; container `data-test="factory-quick-replies"`. Locale keys `factory.quick.label` (aria label of the group: EN "Quick replies", FR "Réponses rapides"), `factory.quick.other` ("Other…" / "Autre…"), `factory.quick.yes` ("Yes"/"Oui"), `factory.quick.no` ("No"/"Non"); de/es translated.

- [ ] **Step 1: Write the failing tests** in `FactoryComposer.test.js`:
  - with `choices` and an idle resumable thread: one chip per choice showing its label, plus Other…; clicking chip 2 calls `send('2. PostgreSQL with TypeORM')` once
  - two quick clicks while `send` is pending → `send` called once; chips `disabled` while sending
  - `send` resolving `false` → chips enabled again, textarea draft untouched
  - Other… focuses `[data-test=factory-reply]` (`document.activeElement`) and sends nothing
  - running thread or `resumable=false` → no `factory-quick-replies`
  - empty `choices` → no `factory-quick-replies`
  In `FactoryPage.test.js`: an opened idle claude-cli thread whose last message is the 3-option question passes 3 choices to `FactoryComposer` (`findComponent(FactoryComposer).props('choices')`).
- [ ] **Step 2:** `npx vitest run apps/board/src/FactoryComposer.test.js apps/board/src/FactoryPage.test.js` → FAIL.
- [ ] **Step 3:** In `FactoryComposer.vue`, factor the send part of `submit` into `async function sendText(text): Promise<boolean>` (guards `resumable`/`blocked`, sets `sending`), used by `submit` (clears the draft on success) and by a chip click (leaves the draft alone). Render the chips above the `<form>` as rounded pills (`rounded-chip border border-line bg-surface-muted px-2.5 py-1 text-xs`, numbered label `2 · PostgreSQL…`), Other… with a dashed border; a `ref` on the textarea for focus. In `FactoryPage.vue`: `const choices = computed(() => quickReplies(messages.value, { yes: t('factory.quick.yes'), no: t('factory.quick.no') }))`, passed as `:choices`.
- [ ] **Step 4:** Same command → PASS; `npx vitest run apps/board/src/i18n.test.js` → PASS.
- [ ] **Step 5:** Commit `feat(factory): quick reply chips above the composer`.

### Task 3: give the conversation the room between md and xl

**Files:**
- Modify: `apps/board/src/FactoryPage.vue`, `apps/board/src/FactoryPage.test.js`, `apps/board/src/FactoryConversation.vue`, locales (`factory.projectSelect`: EN "Project", FR "Projet", de/es)

**Interfaces:**
- Produces: `<select data-test="factory-project-select">` in the Requests pane, options `project.repo` (with thread count), `v-model` bound to the current repo, change → `go('/factory/<repo>')`.

- [ ] **Step 1: Write the failing tests** in `FactoryPage.test.js`:
  - the grid has classes `md:grid-cols-[20rem_minmax(0,1fr)]` and `xl:grid-cols-[15rem_20rem_minmax(0,1fr)]`; the Projects section has `xl:flex` and `md:hidden`
  - `factory-project-select` lists every project and selecting `example-web` pushes `/factory/example-web` (router spy, like the Projects pane test)
  - the select is rendered even with no repo selected (md–xl entry point), alongside `factory-pick-project`
- [ ] **Step 2:** `npx vitest run apps/board/src/FactoryPage.test.js` → FAIL.
- [ ] **Step 3:** Grid: `md:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[15rem_20rem_minmax(0,1fr)]`. Projects pane classes: below `md` keep `pane(1)` behaviour, then `md:hidden xl:flex`. Requests pane: a `hidden md:block xl:hidden` header holding the labelled select (class `control w-full font-mono`). `FactoryConversation.vue` header: `h3` gets `min-w-0 flex-1`, the badge group `min-w-0 max-w-full`, the provider chip `max-w-full truncate`, the worktree badge `max-w-full min-w-0` with the branch text in a `truncate` span.
- [ ] **Step 4:** `npx nx run board:test --skip-nx-cache` → all pass, coverage 100% statements/branches/functions/lines.
- [ ] **Step 5:** Browser check: build (`cd apps/board && npx vite build`), run the mocked Factory script at 820, 1024, 1440 and 390 px; the chat column is ≥ 480 px at 820 px, badges not cut, chips visible above the composer. Commit `fix(factory): give the conversation the room between md and xl`.

### Task 4: docs and changelog

**Files:** `docs/ai-factory.md` (a short "Quick replies" paragraph and the two-column layout note), `CHANGELOG.md` (in the not-yet-published `## [2.2.0]` section, since this PR ships it → Added: quick replies; Fixed: squeezed conversation between 800 and 1280 px).

- [ ] **Step 1:** Write both entries; `pnpm run lint` and `pnpm test` pass.
- [ ] **Step 2:** Commit `docs(factory): quick replies and the medium-width layout`, push the branch.
