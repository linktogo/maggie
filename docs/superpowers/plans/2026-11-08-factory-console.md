# Console Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir depuis une conversation Factory un shell interactif (xterm.js) lancé par le serveur agents dans le dossier du repo du thread.

**Architecture:** `libs/agent-runner/src/terminals.js` gère des pty `node-pty` (injectables) ; `apps/agents` expose `/terminals/*` (SSE + POST) derrière le token ; le proxy du board relaie ces routes ; côté Vue, `useTerminal` + `FactoryConsole` dans un onglet qui n'apparaît qu'au clic sur **Console**.

**Tech Stack:** Node ≥ 22.13, `node:test` (gate 100 % sur lib/agents), `node-pty`, Vue 3 + Vitest/jsdom, `@xterm/xterm`, `@xterm/addon-fit`.

**Spec:** `docs/superpowers/specs/2026-11-08-factory-console-design.md`

## Global Constraints

- **Aucun commit par l'agent** (CLAUDE.md utilisateur) : chaque tâche se termine par un checkpoint listant les fichiers à stager ; l'humain commite.
- Préfixer les commandes shell par `rtk` (CLAUDE.md) ; `node` vient de nvm (`~/.nvm/versions/node/v26.13.0/bin`) s'il n'est pas sur le PATH.
- Gate 100 % lignes/fonctions/branches sur `libs/agent-runner` et `apps/agents` ; `apps/board` exempté mais chaque nouveau module a ses tests.
- Ids de terminal : `tm_<16 hex>` ; `maxTerminals = 4`, `graceMs = 5_000`, tampon rejoué **64 Kio**, saisie ≤ **64 Kio** par requête, `cols` 1–500, `rows` 1–200 (entiers).
- Shell : `env.SHELL`, sinon `/bin/sh` (POSIX) / `env.ComSpec ?? 'cmd.exe'` (Windows) ; args `['-l']` hors Windows ; `name: 'xterm-256color'`.
- Erreurs via `AgentError` (`invalid` 400, `not-found` 404, `busy` 409, `too-large` 413) ; terminal désactivé/indisponible → 503 `{ error: 'terminal-unavailable', detail }`.
- Console active par défaut, coupée par `maggie-agents --no-terminal`.
- Versions exactes pour les nouvelles dépendances du board (comme `dompurify`, `marked`).
- Toute nouvelle chaîne UI passe par i18n (`de`, `en`, `es`, `fr`).

## Review Focus

1. **UTF-8 coupé entre deux chunks pty** (un `é` à cheval) : l'affichage doit rester correct → le pty tourne en `encoding: null` (Buffers), transport en base64, xterm reçoit des `Uint8Array` (Task 1, Task 4).
2. **Coller un gros texte (> 64 Kio)** : ne doit pas renvoyer 413 → le client découpe en morceaux ≤ 16 384 caractères (≤ 64 Kio en UTF-8), envoyés dans l'ordre (Task 4).
3. **Shell qui meurt avant l'abonnement** (`SHELL` invalide, `exit` immédiat) : l'onglet doit afficher « Processus terminé », pas rester vide → l'`exit` est mémorisé et rejoué au premier abonné (Task 1).
4. **Double clic sur Console** pendant l'ouverture : un seul shell → `open()` ignoré tant que `status` vaut `opening`/`open` (Task 4).
5. **Fermeture de l'onglet navigateur** : le DELETE ne doit pas être annulé par l'unload → `fetch(..., { keepalive: true })` sur `close()` (Task 4) ; le délai de grâce serveur reste le filet (Task 1).

---

### Task 1: Gestionnaire de terminaux (`libs/agent-runner`)

**Files:**
- Create: `libs/agent-runner/src/terminals.js`
- Create: `libs/agent-runner/test/terminals.test.js`
- Modify: `libs/agent-runner/src/index.js` (export)
- Modify: `libs/agent-runner/test/index.test.js` (surface publique)
- Modify: `libs/agent-runner/package.json` (dépendance `node-pty`, version exacte courante)
- Modify: `pnpm-workspace.yaml` (`allowBuilds: node-pty: true`, commentaire comme pour nx), `package-lock.json` via `npm install`
- Modify: `libs/agent-runner/README.md` (section Terminals + note node-gyp/Python à l'install hors macOS/Windows)

**Interfaces:**
- Consumes: `repos.resolve(name) -> string` (lève `not-found`), `AgentError` de `./errors.js`.
- Produces:
  - `export const TERMINAL_LIMITS = { maxTerminals: 4, graceMs: 5000, bufferBytes: 65536, maxInputBytes: 65536, maxCols: 500, maxRows: 200 }`
  - `export function createTerminalManager({ repos, loadPty = () => import('node-pty'), shell, platform = process.platform, env = process.env, maxTerminals, graceMs, setTimer = setTimeout, clearTimer = clearTimeout, randomId })`
  - `available(): Promise<{ ok: true } | { ok: false, reason: string }>` — charge `loadPty` une fois (mémoïsé).
  - `open({ repo, cols, rows }): Promise<{ id, repo, cwd }>`
  - `subscribe(id, onEvent): () => void` — `onEvent({ type: 'data', data: Buffer })` / `onEvent({ type: 'exit', code, signal })`
  - `write(id, data: string)`, `resize(id, cols, rows)`, `kill(id)`, `killAll()`, `size(): number`

- [ ] **Step 1: Écrire les tests qui échouent** — `terminals.test.js`, avec un faux pty `{ onData(cb), onExit(cb), write(d), resize(c, r), kill(), pid }` piloté par le test et un faux `setTimer` qui stocke les callbacks :
  - `open spawns the shell in the repo with a login flag and xterm-256color` : `spawn` appelé avec `('/bin/zsh', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/ws/api', env, encoding: null })` ; résultat `{ id: /^tm_[0-9a-f]{16}$/, repo: 'api', cwd: '/ws/api' }`.
  - `shell falls back to /bin/sh, and to ComSpec without -l on win32` (`env.ComSpec` absent → `cmd.exe`).
  - `open rejects an unknown repo with not-found` et `rejects cols 0, 501, rows 201, 1.5 with invalid`.
  - `the fifth open is busy while four are alive` ; après `exit` d'un des quatre, l'ouverture réussit.
  - `data is broadcast as Buffers; string chunks are converted from utf8`.
  - `a late subscriber gets the last 64 KiB replayed first` : émettre 70 000 octets, nouvel abonné reçoit exactement les 65 536 derniers.
  - `exit before any subscriber is replayed to the first one` (Review Focus 3) ; après `exit`, `size()` décrémente et `write` lève `not-found`.
  - `the last unsubscribe kills after graceMs unless someone resubscribes` ; `a terminal never subscribed is killed after graceMs`.
  - `write rejects more than 64 KiB (utf8 bytes) with too-large`, `write/resize/kill on an unknown id throw not-found`.
  - `killAll kills every live pty`.
  - `available reports the load error reason and open throws terminal-unavailable` : `loadPty` rejette `new Error('no prebuilt')` → `{ ok: false, reason: 'no prebuilt' }`, `open` lève `AgentError('unavailable', …)`.

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `rtk node --test libs/agent-runner/test/terminals.test.js`
Expected: FAIL — `Cannot find module '../src/terminals.js'`

- [ ] **Step 3: Implémenter `createTerminalManager` dans `terminals.js`**

Map `id → { pty, repo, cwd, buffer: Buffer[], bufferSize, subscribers: Set, exited: null | {code, signal}, timer }`. `randomId` par défaut `() => randomBytes(8).toString('hex')`. Le tampon est une liste de Buffers tronquée par l'avant à `bufferBytes`. Le minuteur de grâce est armé à l'`open` et à chaque passage à zéro abonné, annulé à l'abonnement. Ajouter le code `'unavailable'` à `AgentError` si `errors.js` restreint les codes (vérifier `errors.test.js`).

- [ ] **Step 4: Vérifier le passage et la couverture**

Run: `rtk npx nx run agent-runner:test` (ou la commande `node --test --experimental-test-coverage … --test-coverage-lines=100 …` de `libs/agent-runner/project.json`)
Expected: PASS, 100 % lignes/fonctions/branches.

- [ ] **Step 5: Installer `node-pty` et vérifier le chargement réel**

Run: `rtk npm install` puis `node -e "import('node-pty').then(m => console.log(typeof m.spawn))"`
Expected: `function`

- [ ] **Step 6: Checkpoint** — fichiers à stager : ceux de la liste ci-dessus. Message suggéré : `feat(agent-runner): terminal manager on node-pty`.

---

### Task 2: Routes `/terminals` du serveur agents

**Files:**
- Modify: `apps/agents/src/server.js`
- Modify: `apps/agents/test/server.test.js`

**Interfaces:**
- Consumes: le manager de Task 1 (`available`, `open`, `subscribe`, `write`, `resize`, `kill`).
- Produces: `createAgentsServer({ …, terminals = null })` ; routes :
  - `GET /health` → ajoute `terminal: { available: true }` ou `{ available: false, reason }` (`reason: 'disabled'` si `terminals === null`).
  - `POST /terminals` `{ repo, cols, rows }` → 201 `{ terminal: { id, repo, cwd } }`
  - `GET /terminals/:id/events` → SSE `event: data\ndata: <base64>\n\n`, `event: exit\ndata: {"code":0,"signal":null}\n\n` puis `res.end()`
  - `POST /terminals/:id/input` `{ data: string }` → 204 ; `POST /terminals/:id/resize` `{ cols, rows }` → 204 ; `DELETE /terminals/:id` → 204
  - Regex : `/^\/terminals(?:\/(tm_[0-9a-f]{16})(\/events|\/input|\/resize)?)?$/`

- [ ] **Step 1: Écrire les tests qui échouent** — faux manager enregistrant les appels, passé via `options.server.terminals` dans `boot` :
  - `health reports the terminal as disabled without a manager` / `as available` / `as unavailable with its reason`.
  - `POST /terminals opens a shell and answers 201` (corps relayé tel quel au manager).
  - `the events stream sends data as base64 and ends after exit` : le faux manager émet `Buffer.from('é')` puis exit → corps SSE contient `data: w6k=` puis `event: exit`.
  - `closing the events stream unsubscribes`.
  - `input, resize and delete answer 204 and reach the manager`.
  - `an input body that is not { data: string } is invalid (400)`, `unknown terminal is 404` (manager lève `not-found`).
  - `without a manager every /terminals route is 503 terminal-unavailable`, et manager `unavailable` → 503 avec `detail`.
  - `the routes still require the bearer token` (401 sans).

- [ ] **Step 2: Lancer et vérifier l'échec**

Run: `rtk node --test apps/agents/test/server.test.js`
Expected: FAIL sur les nouveaux tests (404 au lieu de 201/204).

- [ ] **Step 3: Implémenter** une fonction `terminalRoute(req, res, id, sub)` à côté de `threadRoute`, mappage `'unavailable' → 503` dans `STATUS_BY_CODE` avec le corps `{ error: 'terminal-unavailable', detail: err.message }`. `/health` devient `async` pour `await terminals.available()`.

- [ ] **Step 4: Vérifier le passage et la couverture**

Run: `rtk npx nx run agents:test`
Expected: PASS, 100 %.

- [ ] **Step 5: Checkpoint** — `apps/agents/src/server.js`, `apps/agents/test/server.test.js`. Message : `feat(agents): /terminals routes over SSE`.

---

### Task 3: Câblage `main.js` (`--no-terminal`, arrêt)

**Files:**
- Modify: `apps/agents/src/main.js`
- Modify: `apps/agents/test/main.test.js`
- Modify: `apps/agents/README.md` (option, prérequis node-pty)

**Interfaces:**
- Consumes: `createTerminalManager` (Task 1), `createAgentsServer({ terminals })` (Task 2).
- Produces: `main(argv, { …, createTerminals = createTerminalManager })` ; option booléenne `no-terminal` (défaut `false`).

- [ ] **Step 1: Écrire les tests qui échouent**
  - `the terminal manager is created with the repo resolver and passed to the server` (faux `createTerminals`).
  - `--no-terminal passes terminals: null` et loggue `  console disabled (--no-terminal)`.
  - `SIGINT kills every terminal` : le handler `onSignal` appelle `killAll()`.
  - `a terminal opened or exited is logged` : `[tm_…] shell on api` / `[tm_…] exited 0` (le manager reçoit `log`).

- [ ] **Step 2: Vérifier l'échec** — Run: `rtk node --test apps/agents/test/main.test.js` — Expected: FAIL.

- [ ] **Step 3: Implémenter** : ajouter `log` aux options de `createTerminalManager` (Task 1 : appel `log` à l'open et à l'exit — ajouter les deux tests correspondants dans `terminals.test.js`), créer le manager après `repos`, `killAll()` dans le handler de signal avant `server.close()`.

- [ ] **Step 4: Vérifier** — Run: `rtk npx nx run-many -t test -p agents agent-runner` — Expected: PASS, 100 %.

- [ ] **Step 5: Checkpoint** — fichiers ci-dessus (+ `terminals.*` si touchés). Message : `feat(agents): --no-terminal and shutdown of open shells`.

---

### Task 4: Proxy du board + composable `useTerminal`

**Files:**
- Modify: `apps/board/agentsProxy.js` (`ROUTE`)
- Modify: `apps/board/agentsProxy.test.js`
- Create: `apps/board/src/useTerminal.js`
- Create: `apps/board/src/useTerminal.test.js`

**Interfaces:**
- Consumes: routes de Task 2 via `/api/factory/terminals…`.
- Produces: `useTerminal({ fetchImpl = fetch, EventSourceImpl = globalThis.EventSource, win = globalThis.window, flushMs = 10, resizeMs = 100 })` →
  `{ status: Ref<'idle'|'opening'|'open'|'exited'|'disconnected'|'error'>, exitCode: Ref<number|null>, error: Ref<string|null>, cwd: Ref<string|null>, open(repo, { cols, rows }, onData: (bytes: Uint8Array) => void): Promise<void>, write(data: string): void, resize(cols, rows): void, close(): Promise<void> }`
  - Constante exportée `INPUT_CHUNK_CHARS = 16384`.

- [ ] **Step 1: Tests proxy qui échouent** — `terminal routes are relayed` (POST `/terminals`, GET `…/events`, POST `…/input`, POST `…/resize`, DELETE `/terminals/tm_…`) et `neighbouring terminal paths are refused` (`/terminals/tm_123`, `/terminals/tm_<16hex>/other`, `/terminals/x/events` → 404 `unknown factory route`).

- [ ] **Step 2: Tests `useTerminal` qui échouent** (Vitest, fake timers, faux fetch/EventSource) :
  - `open posts the size then follows the events` : POST `/api/factory/terminals` corps `{ repo: 'api', cols: 80, rows: 24 }`, puis `EventSource('/api/factory/terminals/tm_…/events')`, `status === 'open'`, `cwd` renseigné.
  - `data events are decoded from base64 to bytes` : `'w6k='` → `Uint8Array [0xc3, 0xa9]` (Review Focus 1).
  - `keystrokes within 10 ms are sent in one POST, in order, one request at a time`.
  - `a paste longer than 16384 chars is split into ordered chunks` (Review Focus 2).
  - `resize is debounced to the last size`.
  - `a second open while opening or open is ignored` (Review Focus 4).
  - `exit sets exited with its code and closes the stream` ; `a stream error sets disconnected without reconnecting`.
  - `a failed POST sets error with the server message` (`{ error: 'unknown repository: x' }`).
  - `close sends DELETE with keepalive and runs on pagehide and on unmount` (Review Focus 5).

- [ ] **Step 3: Vérifier l'échec** — Run: `rtk node --test apps/board/agentsProxy.test.js` et `cd apps/board && rtk npx vitest run src/useTerminal.test.js` — Expected: FAIL.

- [ ] **Step 4: Implémenter** — `ROUTE` : ajouter l'alternative `terminals(\/tm_[0-9a-f]{16}(\/events|\/input|\/resize)?)?` ; `useTerminal` suit le style de `useThreads` (`api()` interne, `onUnmounted` si dans un composant via `getCurrentInstance()`). Décodage : `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))`.

- [ ] **Step 5: Vérifier** — mêmes commandes — Expected: PASS.

- [ ] **Step 6: Checkpoint** — 4 fichiers. Message : `feat(board): relay terminal routes and useTerminal composable`.

---

### Task 5: Composant `FactoryConsole.vue`

**Files:**
- Create: `apps/board/src/FactoryConsole.vue`
- Create: `apps/board/src/FactoryConsole.test.js`
- Modify: `apps/board/package.json` (`@xterm/xterm`, `@xterm/addon-fit`, versions exactes), `package-lock.json`
- Modify: `apps/board/src/locales/{de,en,es,fr}.js` (`factory.console.exited` « Processus terminé (code {code}) », `factory.console.disconnected`, `factory.console.reopen`, `factory.console.close`)

**Interfaces:**
- Consumes: `useTerminal` (Task 4).
- Produces: `<FactoryConsole :repo="string" :fetch-impl :event-source-impl :terminal-factory="(el, theme) => xterm-like" @closed />` — expose `focus()`. Ouvre le shell au montage, `close()` au démontage. `terminalFactory` par défaut crée `new Terminal({ theme, fontFamily, cursorBlink: true })` + `FitAddon` ; injectable pour les tests.

- [ ] **Step 1: Tests qui échouent** (faux terminal `{ open(el), write(bytes), onData(cb), loadAddon(), dispose(), cols, rows }`, faux fit, `ResizeObserver` stub) :
  - `mounting opens a shell sized from the fitted terminal` (`open('api', { cols, rows }, …)`).
  - `pty bytes are written to the terminal`, `keystrokes from the terminal reach write()`.
  - `a container resize refits and sends the new size`.
  - `exited shows the code and a reopen button that opens a new shell`; `disconnected shows the same button`.
  - `the header shows the cwd`; `unmount closes the shell and disposes the terminal`.
  - `the theme comes from the CSS tokens` (`--color-surface`, `--color-ink` lus via `getComputedStyle`).

- [ ] **Step 2: Vérifier l'échec** — Run: `cd apps/board && rtk npx vitest run src/FactoryConsole.test.js` — Expected: FAIL.

- [ ] **Step 3: Installer les dépendances et implémenter** — Run: `rtk npm install -E -w apps/board @xterm/xterm @xterm/addon-fit` ; importer `@xterm/xterm/css/xterm.css` dans le composant.

- [ ] **Step 4: Vérifier** — même commande + `rtk npx vitest run` complet du board et `rtk lint` — Expected: PASS, pas de nouvelle alerte.

- [ ] **Step 5: Checkpoint** — fichiers ci-dessus. Message : `feat(board): FactoryConsole xterm component`.

---

### Task 6: Onglets Conversation / Console

**Files:**
- Modify: `apps/board/src/FactoryPage.vue`, `apps/board/src/FactoryPage.test.js`
- Modify: `apps/board/src/FactoryConversation.vue`, `apps/board/src/FactoryConversation.test.js` (bouton dans l'en-tête)
- Modify: `apps/board/src/icons.js` (icône `terminal`, Material Symbols Outlined, viewBox existant)
- Modify: `apps/board/src/locales/{de,en,es,fr}.js` (`factory.console.open` « Console », `factory.console.unavailable` « Console indisponible : {reason} », `factory.tabs.conversation`, `factory.tabs.console`)

**Interfaces:**
- Consumes: `FactoryConsole` (Task 5), `health.value.terminal` (Task 2) via `useThreads`.
- Produces: `FactoryConversation` émet `console` et reçoit `consoleAvailable: boolean`, `consoleReason: string`, `consoleOpen: boolean`. Dans `FactoryPage` : `consoleOpen = ref(false)`, `tab = ref('conversation' | 'console')`.

- [ ] **Step 1: Tests qui échouent** (`data-test` : `factory-console-button`, `factory-tabs`, `factory-tab-conversation`, `factory-tab-console`, `factory-console-close`, `factory-console`) :
  - `without a console there are no tabs` (état ①).
  - `clicking Console opens the shell and selects the console tab` (état ②) ; `clicking it again selects the tab without a second console`.
  - `switching back to Conversation keeps the console mounted (v-show)` (état ③).
  - `the tab close button unmounts the console and removes the tabs`.
  - `opening another thread or project closes the console`.
  - `the button is disabled with the reason when health.terminal.available is false` (tooltip via `tooltip.js`).

- [ ] **Step 2: Vérifier l'échec** — Run: `cd apps/board && rtk npx vitest run src/FactoryPage.test.js src/FactoryConversation.test.js` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — dans `FactoryPage`, le bloc `<template v-else-if="current">` : barre d'onglets si `consoleOpen`, conversation + composer sous `v-show="tab === 'conversation'"`, `<FactoryConsole v-if="consoleOpen" v-show="tab === 'console'" :repo="current.repo">`. `watch(threadId)` et `watch(repo)` remettent `consoleOpen=false`, `tab='conversation'`.

- [ ] **Step 4: Vérifier** — Run: `cd apps/board && rtk npx vitest run && rtk lint` — Expected: PASS.

- [ ] **Step 5: Checkpoint** — fichiers ci-dessus. Message : `feat(board): console tab in Factory conversations`.

---

### Task 7: Documentation sécurité et vérification réelle

**Files:**
- Modify: `SECURITY.md` (déjà modifié dans l'arbre de travail : **ajouter** la puce sans réécrire le reste)
- Modify: `CONTRIBUTING.md` si l'installation demande désormais une étape (node-gyp hors macOS/Windows)

- [ ] **Step 1: Ajouter à « Scope notes »** la puce : la console Factory ouvre un shell en tant que l'utilisateur dans un repo de la config ; quiconque peut piloter le board en local peut s'en servir ; `maggie-agents --no-terminal` la coupe ; les routes de création et de saisie sont soumises au contrôle d'`Origin`.

- [ ] **Step 2: Suite complète** — Run: `rtk npm test` — Expected: tous les projets PASS, gates à 100 %.

- [ ] **Step 3: Vérification manuelle** (skill `run`) : lancer `maggie-agents` et le board, ouvrir une conversation, cliquer **Console** ; vérifier prompt dans le bon `cwd`, `ls --color`, `vim` + redimensionnement de la fenêtre, `é` affiché, collage de > 64 Kio, retour sur Conversation puis Console (historique intact), ✕ → `ps` ne montre plus le shell, fermeture de l'onglet navigateur → shell tué en ≤ 5 s, `--no-terminal` → bouton désactivé avec la raison.

- [ ] **Step 4: Checkpoint** — `SECURITY.md` (+ `CONTRIBUTING.md`). Message : `docs: security scope of the Factory console`.
