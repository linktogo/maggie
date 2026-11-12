# Factory Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chaque thread Factory peut tourner dans son propre `git worktree` (branche `factory/<id>-<slug>` depuis `origin/<default>`), ce qui permet plusieurs agents en parallèle sur un même repo sans toucher au checkout principal.

**Architecture:** Un module `worktrees.js` (git via `execFile` injectable) dans `libs/agent-runner` ; le store persiste `worktree_path/branch/base` ; le run manager verrouille par `cwd` avec un plafond global ; le thread service choisit le `cwd` (worktree ou checkout) pour les runs et la console. Le serveur agents expose `DELETE /threads/:id/worktree`, le board relaie et affiche case, badge et suppression.

**Tech Stack:** Node.js ≥ 22.13 (`node:sqlite`, `node:test`), Vue 3 + Vitest (board), Nx.

**Spec:** `docs/superpowers/specs/2026-11-09-factory-worktrees-design.md`

## Global Constraints

- Couverture 100 % (gate existant de chaque projet Nx) ; aucun test ne lance git ni une CLI réelle (`execFile`/`spawn` injectés).
- git toujours via `execFile('git', [...args])`, jamais de shell ; le client n'envoie jamais de chemin.
- Branche : `factory/<threadId>-<slug>` ; slug `[a-z0-9-]`, ≤ 40 caractères, `task` si vide.
- Emplacement : `<workspace>/.worktrees/<repo>/<threadId>`.
- Base : `git fetch origin` puis `origin/<default>` lu par `git symbolic-ref --short refs/remotes/origin/HEAD`.
- Codes d'erreur : `dirty` → 409 `{ error: 'worktree-dirty' }` ; `git` → 502 `{ error: 'git-failed', detail }` ; `unavailable` reste réservé à la console.
- `--max-runs` : entier ≥ 1, défaut 4. `force` n'accepte que `1`, sinon 400.
- Archivage : ne touche jamais au worktree. Une branche avec commits d'avance n'est jamais supprimée.
- **Commits** : l'agent ne commite pas ; chaque tâche se termine par un point de commit que l'humain exécute.

## Review Focus

- Titre avec accents/emoji/uniquement de la ponctuation → slug ASCII valide (`é` → `e`, vide → `task`) — test dans Task 1.
- Le run refusé après création du worktree (plafond atteint) → worktree et branche supprimés, aucun thread en base — test dans Task 4.
- Reprise (`reply`) d'un thread dont le worktree a été supprimé via l'UI → reprise dans le checkout principal, sans erreur — test dans Task 4.
- Deux threads worktree sur le même repo en parallèle + une requête sans worktree sur le checkout : les trois démarrent (cwd distincts), un second run sans worktree est `409` — test dans Task 3.
- Console ouverte pour un thread worktree → `cwd` du worktree et non du checkout, et un `thread` inconnu → 404 — test dans Task 5.

---

### Task 1: Module `worktrees.js` et codes d'erreur

**Files:**
- Create: `libs/agent-runner/src/worktrees.js`
- Modify: `libs/agent-runner/src/index.js` (export)
- Test: `libs/agent-runner/test/worktrees.test.js`, `libs/agent-runner/test/index.test.js`

**Interfaces:**
- Produces:
  - `slugify(title: string): string`
  - `createWorktreeManager({ workspace: string, execFile?: (cmd, args, opts) => Promise<{ stdout, stderr }> })` →
    - `create({ repo, repoDir, threadId, title }) → Promise<{ path, branch, base }>`
    - `status({ path, base }) → Promise<{ exists: boolean, dirty: boolean, ahead: number }>`
    - `remove({ repoDir, path, branch, base, force = false }) → Promise<{ branchKept: boolean }>`
  - Erreurs : `AgentError('git', msg)`, `AgentError('dirty', 'the worktree has uncommitted changes')`, `AgentError('invalid', …)` pour `origin/HEAD` absent.
- Défaut `execFile` : `promisify(child_process.execFile)` ; `exists` injectable (défaut `existsSync`) ; `mkdir` des parents via `fs.promises.mkdir({ recursive: true })` injectable.

- [ ] **Step 1: Écrire les tests (faux `execFile` qui enregistre les appels et répond par table `args.join(' ') → résultat | Error`)**

```js
test('slugify keeps ascii words, strips accents, caps at 40, falls back to task', () => {
  assert.equal(slugify('Fix the Login page!'), 'fix-the-login-page');
  assert.equal(slugify('Réparer l’été'), 'reparer-l-ete');
  assert.equal(slugify('🚀 !!!'), 'task');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.doesNotMatch(slugify('x'.repeat(39) + ' y'), /-$/);
});
test('create fetches, reads origin/HEAD and adds the worktree', async () => {
  // origin/HEAD → 'origin/main'
  const wt = await manager.create({ repo: 'api', repoDir: '/wk/api', threadId: 'th_0123456789abcdef', title: 'Fix login' });
  assert.deepEqual(wt, { path: '/wk/.worktrees/api/th_0123456789abcdef', branch: 'factory/th_0123456789abcdef-fix-login', base: 'origin/main' });
  assert.deepEqual(calls.map((c) => c.args), [
    ['-C', '/wk/api', 'fetch', 'origin'],
    ['-C', '/wk/api', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['-C', '/wk/api', 'worktree', 'add', '-b', 'factory/th_0123456789abcdef-fix-login', '/wk/.worktrees/api/th_0123456789abcdef', 'origin/main'],
  ]);
});
test('create: fetch failure → AgentError git with git stderr', ...);           // code 'git', message contient 'git fetch failed'
test('create: missing origin/HEAD → invalid mentioning git remote set-head origin -a', ...);
test('create: worktree add failure → AgentError git', ...);
test('status: dirty when porcelain is not empty, ahead from rev-list --count', ...); // { exists: true, dirty: true, ahead: 2 }
test('status: missing directory → { exists: false, dirty: false, ahead: 0 } without calling git', ...);
test('remove: dirty without force → dirty, nothing removed', ...);
test('remove: force passes --force; ahead 0 deletes the branch → branchKept false', ...);
test('remove: ahead > 0 keeps the branch → branchKept true', ...);
test('remove: missing directory → worktree prune, then branch rule', ...);
```

- [ ] **Step 2: Lancer et vérifier l'échec** — `npx nx run agent-runner:test` → FAIL (module introuvable).
- [ ] **Step 3: Implémenter `src/worktrees.js`** — slug via `normalize('NFKD')`, suppression des diacritiques, `[^a-z0-9]+` → `-`, trim des `-`, coupe à 40 puis re-trim. Les erreurs `execFile` deviennent `AgentError('git', stderr.trim() || err.message)`. Exporter `slugify` et `createWorktreeManager` depuis `index.js` (mettre à jour `index.test.js`).
- [ ] **Step 4: Relancer** — `npx nx run agent-runner:test` → PASS, couverture 100 %.
- [ ] **Step 5: Point de commit (humain)** — `feat(agent-runner): git worktree manager`.

---

### Task 2: Store — colonnes worktree et id fourni

**Files:**
- Modify: `libs/agent-runner/src/store.js`
- Test: `libs/agent-runner/test/store.test.js`

**Interfaces:**
- Produces:
  - `MIGRATIONS[1]` : `ALTER TABLE threads ADD COLUMN worktree_path TEXT; … branch TEXT; … base TEXT;`
  - `newThreadId(): string` exporté par la fabrique du store (`store.newThreadId()`), format `th_<16 hex>` (même `randomId`).
  - `createThread({ id?, repo, provider, model, skill, title, worktree?: { path, branch, base } | null })` ; `id` hors format `/^th_[0-9a-f]{16}$/` → `AgentError('invalid')`.
  - Vue thread : `worktree: { path, branch, base } | null`.
  - `updateThread(id, { status?, sessionId?, worktree?: null })` : `worktree: null` efface les trois colonnes (le `COALESCE` actuel ne peut pas mettre `NULL` : requête dédiée).
  - `listWorktrees(): Array<{ id, repo, worktree }>` (threads ayant un `worktree_path`).

- [ ] **Step 1: Tests**
  - une base créée en version 1 (exécuter `MIGRATIONS[0]` à la main, `user_version = 1`) est migrée : un thread existant a `worktree: null` ;
  - `createThread` avec `id` et `worktree` relit les deux ; un `id` invalide est refusé ;
  - `updateThread(id, { worktree: null })` efface, `updateThread(id, { status: 'idle' })` ne touche pas au worktree ;
  - `listWorktrees()` ne renvoie que les threads avec worktree.
- [ ] **Step 2: Lancer** → FAIL.
- [ ] **Step 3: Implémenter** dans `store.js`.
- [ ] **Step 4: Relancer** `npx nx run agent-runner:test` → PASS.
- [ ] **Step 5: Point de commit (humain)** — `feat(agent-runner): store thread worktrees`.

---

### Task 3: Run manager — verrou par `cwd` et plafond global

**Files:**
- Modify: `libs/agent-runner/src/run.js`, `libs/agent-runner/src/index.js`
- Test: `libs/agent-runner/test/run.test.js`

**Interfaces:**
- Produces: option `maxActive` (défaut `DEFAULT_MAX_ACTIVE = 4`, exportée) ; `record.cwd` stocké.
  - même `cwd` actif → `AgentError('busy', \`a run is already active on ${repo}\`)` (message inchangé) ;
  - `maxActive` runs actifs → `AgentError('busy', \`too many agents running (max ${maxActive})\`)`.

- [ ] **Step 1: Tests** — deux runs `repo: 'api'` avec `cwd` `/wk/.worktrees/api/a` et `/b` démarrent tous deux ; un troisième sur `/wk/api` aussi ; un quatrième sur `/wk/api` → busy « already active on api » ; avec `maxActive: 2`, le troisième → « too many agents running (max 2) » ; un run terminé libère sa place. Adapter le test existant « one run per repo » au `cwd`.
- [ ] **Step 2: Lancer** → FAIL.
- [ ] **Step 3: Implémenter** (contrôle par `cwd` d'abord, puis plafond).
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Point de commit (humain)** — `feat(agent-runner): lock runs per cwd with a global cap`.

---

### Task 4: Thread service — démarrer, reprendre et supprimer avec worktree ; console sur `cwd`

**Files:**
- Modify: `libs/agent-runner/src/threads.js`, `libs/agent-runner/src/terminals.js`
- Test: `libs/agent-runner/test/threads.test.js`, `libs/agent-runner/test/terminals.test.js`

**Interfaces:**
- Consumes: Task 1 (`worktrees`), Task 2 (`newThreadId`, `createThread({ id, worktree })`, `updateThread({ worktree: null })`), Task 3.
- Produces:
  - `createThreadService({ …, worktrees })` (nouveau paramètre ; `null` = fonctionnalité absente → `worktree: true` refusé en `invalid`).
  - `start(body) → Promise<thread>` (**devient async**) ; `body.worktree` doit être booléen si présent, sinon `invalid`.
  - `cwdOf(id) → string` : `thread.worktree?.path ?? repos.resolve(thread.repo)` ; `not-found` si thread inconnu.
  - `describe(id) → Promise<{ thread, messages } | null>` : comme `get`, avec `thread.worktree` enrichi par `worktrees.status` (`exists`, `dirty`, `ahead`). `get` reste synchrone et inchangé.
  - `removeWorktree(id, { force }) → Promise<{ thread, branchKept }>` : `busy` si running, `not-found` (« this thread has no worktree ») sans worktree.
  - `remove(id, { force } = {}) → Promise<void>` (**devient async**) : supprime le worktree d'abord (même règle `dirty`) puis le thread.
  - `terminals.open({ repo, cwd?, cols, rows })` : `cwd` fourni par le serveur (jamais par le client) remplace `repos.resolve(repo)`.

- [ ] **Step 1: Tests (faux `worktrees` en mémoire, harness de run existant)**
  - `start({ repo, prompt, worktree: true })` : `create` appelé avec `threadId === thread.id` et le titre, le run a `cwd` = chemin du worktree, `thread.worktree` renseigné ;
  - `start` sans `worktree` : aucun appel à `create`, `cwd` = checkout ;
  - `create` qui lève `git` → l'erreur remonte, aucun thread en base ;
  - plafond atteint après `create` → `remove({ force: true })` appelé, erreur `busy` relancée, aucun thread ;
  - `worktree: 'yes'` → `invalid` ;
  - `reply` utilise `cwdOf` ; après `removeWorktree`, `reply` tourne dans le checkout ;
  - `describe` fusionne `status` ; `removeWorktree` : busy pendant un run, `dirty` propagé, `force` transmis, `worktree` effacé en base ;
  - `remove` : `dirty` sans `force` → thread conservé ; avec `force` → worktree puis thread supprimés ; thread sans worktree → comme avant ;
  - `setStatus('archived')` n'appelle pas `worktrees.remove` ;
  - `terminals.open({ repo, cwd: '/x' })` spawn dans `/x` sans appeler `repos.resolve`.
- [ ] **Step 2: Lancer** → FAIL.
- [ ] **Step 3: Implémenter.** Ordre dans `start` avec worktree : `id = store.newThreadId()` → `await worktrees.create` → `manager.start({ cwd })` (en cas d'erreur : `await worktrees.remove({ …, force: true })`, avaler une erreur de nettoyage en `log`, relancer l'erreur d'origine) → `store.createThread({ id, worktree, … })`.
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Point de commit (humain)** — `feat(agent-runner): threads in their own worktree`.

---

### Task 5: Serveur agents — routes, options, démarrage, docs

**Files:**
- Modify: `apps/agents/src/server.js`, `apps/agents/src/main.js`, `docs/ai-factory.md`, `SECURITY.md` (seulement si la puce console mérite une mention des worktrees)
- Test: `apps/agents/test/server.test.js`, `apps/agents/test/main.test.js`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `STATUS_BY_CODE` : ajoute `dirty: 409` ; réponse `{ error: 'worktree-dirty', detail }` pour `dirty`, `{ error: 'git-failed', detail }` en 502 pour `git`.
  - `THREAD_PATH` : `(\/messages|\/events|\/run|\/worktree)?`.
  - `POST /threads` : `await threads.start(body)`. `GET /threads/:id` : `await threads.describe(id)`.
  - `DELETE /threads/:id/worktree[?force=1]` → 200 `{ thread, branchKept }` ; `DELETE /threads/:id[?force=1]` → 204 ; `parseForce(url)` : absent → `false`, `1` → `true`, autre → 400.
  - `POST /terminals` : `{ thread, cols, rows }` → `thread` doit matcher `th_[0-9a-f]{16}` sinon 400, inconnu → 404 ; `terminals.open({ repo: thread.repo, cwd: threads.cwdOf(id), cols, rows })`. `{ repo, … }` inchangé.
  - `GET /health` : ajoute `limits: { maxRuns }` (nouveau paramètre `maxRuns` de `createAgentsServer`).
  - `main.js` : `--max-runs <n>` (validation comme `--port`/`--timeout`), `createRunManager({ maxActive })`, `createWorktreeManager({ workspace })` injectable (`createWorktrees`), passé au thread service ; après `recoverInterrupted` : pour chaque `store.listWorktrees()` dont le dossier est absent → `updateThread(id, { worktree: null })` + log `[<id>] worktree missing, cleared` ; dossiers de `<workspace>/.worktrees/<repo>/*` sans thread → log `  orphan worktree: <path>` (lecture seulement, absence du dossier tolérée).

- [ ] **Step 1: Tests serveur** (faux `threads`) : chaque nouvelle route et code (200/204/400 `force=2`/404 sans worktree/409 running/409 `worktree-dirty`/502 `git-failed`), `POST /threads` avec `worktree: true` transmis, `GET /threads/:id` renvoie `describe`, `POST /terminals` avec `thread` (cwd transmis, `thread` invalide 400, inconnu 404), `/health.limits`.
- [ ] **Step 2: Tests main** : `--max-runs 0`/`abc` refusés, `--max-runs 6` → `maxActive: 6` et `limits.maxRuns: 6`, worktree manquant effacé et loggé, orphelin loggé et non supprimé.
- [ ] **Step 3: Lancer** `npx nx run agents:test` → FAIL.
- [ ] **Step 4: Implémenter** `server.js` et `main.js`.
- [ ] **Step 5: Relancer** `npx nx run agents:test` → PASS, couverture 100 %.
- [ ] **Step 6: Docs** — `docs/ai-factory.md` : section « Worktrees » (case, base, emplacement, cycle de vie, branche gardée), ligne `--max-runs` dans la table des flags, routes ajoutées/modifiées dans « API », erreurs `worktree-dirty`/`git-failed`, limitation « One active run per repo » remplacée par « one active run per checkout or worktree, at most `--max-runs` at once, no queue ».
- [ ] **Step 7: Point de commit (humain)** — `feat(agents): worktree routes and --max-runs`.

---

### Task 6: Board — proxy

**Files:**
- Modify: `apps/board/agentsProxy.js`
- Test: `apps/board/agentsProxy.test.js`

**Interfaces:**
- Produces: `ROUTE` accepte `threads/th_…/worktree` ; la query string (`force=1`) est déjà relayée — vérifier, sinon la relayer.

- [ ] **Step 1: Tests** — `DELETE /api/factory/threads/th_0123456789abcdef/worktree?force=1` relayé avec la query ; `/worktrees`, `/worktree/x` refusés (404) ; statut 502 et corps `git-failed` relayés tels quels.
- [ ] **Step 2: Lancer** `npx nx run board:test-agents-proxy` → FAIL.
- [ ] **Step 3: Implémenter** (regex).
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Point de commit (humain)** — `feat(board): relay the worktree route`.

---

### Task 7: Board — UI (case, badge, suppression, console)

**Files:**
- Modify: `apps/board/src/useThreads.js`, `apps/board/src/useTerminal.js`, `apps/board/src/FactoryNewRequest.vue`, `apps/board/src/FactoryConversation.vue`, `apps/board/src/FactoryThreads.vue`, `apps/board/src/FactoryConsole.vue`, `apps/board/src/FactoryPage.vue`, `apps/board/src/icons.js`, `apps/board/src/locales/{en,fr,de,es}.js`
- Test: les `*.test.js` correspondants

**Interfaces:**
- Consumes: Task 5 (routes et formes JSON).
- Produces:
  - `useThreads.create({ repo, provider, model, prompt, skill, worktree })` ;
  - `useThreads.removeWorktree(id, { force = false }) → Promise<{ ok: true } | { ok: false, dirty: boolean }>` (recharge le thread si ok) ;
  - `useThreads.remove(id, { force })` : même retour (`dirty` sur 409 `worktree-dirty`) ;
  - `useTerminal.open({ thread } | { repo }, { cols, rows }, onData)` — le premier argument devient un objet ;
  - `FactoryConsole` prop `thread` (string, requise) remplace `repo` ;
  - `FactoryConversation` émet `remove-worktree` ; `FactoryPage` orchestre les deux confirmations (`window.confirm` injectable via prop `confirmImpl` pour les tests, comme les autres `*Impl`).
- Clés i18n (4 locales) : `factory.worktree.option` (« Isolated worktree (new branch from origin) »), `factory.worktree.badge`, `factory.worktree.dirty`, `factory.worktree.tooltip` (`{path}`, `{base}`, `{ahead}`), `factory.worktree.remove`, `factory.worktree.confirm`, `factory.worktree.confirmForce` (« Force? Uncommitted changes will be lost »), `factory.worktree.missing`.
- Icône `branch` dans `icons.js` (emoji de repli `⎇`).

- [ ] **Step 1: Tests**
  - `FactoryNewRequest` : case `data-test="factory-worktree"` cochée par défaut, `submit` contient `worktree: true`, décochée → `false` ;
  - `useThreads` : `create` envoie `worktree` ; `removeWorktree` → `DELETE …/worktree` puis `…?force=1` ; 409 `worktree-dirty` → `{ ok: false, dirty: true }` ;
  - `FactoryConversation` : badge `data-test="factory-worktree-badge"` avec la branche si `thread.worktree`, absent sinon ; pastille `dirty` ; libellé `missing` si `exists: false` ; bouton `remove-worktree` émis ;
  - `FactoryPage` : refus de la 1re confirmation → aucun appel ; dirty → 2e confirmation → appel avec `force` ; refus de la 2e → rien ;
  - `FactoryThreads` : icône ⎇ sur les threads avec worktree ;
  - `useTerminal`/`FactoryConsole` : `POST /terminals` avec `{ thread, cols, rows }` ;
  - `i18n.test.js` existant : les nouvelles clés présentes dans toutes les locales.
- [ ] **Step 2: Lancer** `npx nx run board:test` → FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Relancer** `npx nx run board:test` puis `npm run lint` → PASS.
- [ ] **Step 5: Vérification manuelle** — `npm run agents -- --repos repos.json --workspace wk` + `npm start` : deux requêtes worktree en parallèle sur un même repo, une console dans chacune (`pwd`, `git branch --show-current`), `git status` du checkout principal inchangé ; supprimer un worktree sale → double confirmation ; branche avec commits conservée (`git branch --list 'factory/*'`).
- [ ] **Step 6: Point de commit (humain)** — `feat(board): worktree option, badge and removal`.
