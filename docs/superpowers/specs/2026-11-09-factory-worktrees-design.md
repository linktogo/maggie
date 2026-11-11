# Design — Worktrees Factory (threads isolés et parallèles)

**Date** : 2026-11-09
**Statut** : En revue

## Objectif

Permettre à plusieurs agents de travailler **en parallèle** sur un même repo, chacun
**isolé** dans son propre `git worktree` sur une branche dédiée, sans jamais toucher au
checkout principal de l'utilisateur.

Aujourd'hui un thread tourne dans le checkout du repo (`<workspace>/<name>` ou `path`),
un seul run est autorisé par repo (`409 busy`) et deux threads d'un même repo partagent
les mêmes fichiers.

## Décisions cadrées

| Sujet | Décision |
|---|---|
| Activation | Au choix **par requête** : case « Worktree isolé », cochée par défaut. Décochée = comportement actuel (checkout partagé) |
| Base | `git fetch origin`, puis nouvelle branche depuis la branche par défaut du remote (`origin/HEAD`) |
| Branche | `factory/<thread-id>-<slug du titre>` |
| Emplacement | `<workspace>/.worktrees/<repo>/<thread-id>` |
| Fetch en échec | Requête refusée avec un message explicite, pas de repli silencieux |
| Suppression | Bouton manuel « Supprimer le worktree » + suppression avec le thread (`DELETE /threads/:id`). L'archivage garde le worktree |
| Worktree sale | Suppression refusée (`409 worktree-dirty`) sauf `force` |
| Branche | Conservée si elle a des commits d'avance sur la base, supprimée sinon |
| Parallélisme | Verrou par `cwd` (et non plus par repo) + plafond global `--max-runs` (défaut 4) |
| Providers | Claude et Copilot, identique (la Factory pilote git elle-même) |
| Mécanisme | Module `worktrees.js` dans `libs/agent-runner` ; pas de `claude --worktree` (non portable, perte de contrôle du nettoyage) ni de clones complets (coût disque/temps) |

## Architecture

### `libs/agent-runner` — `src/worktrees.js`

`createWorktreeManager({ workspace, execFile })` — `execFile` injectable (défaut
`node:child_process` promisifié), comme `spawn` dans `run.js`. Toutes les commandes git
sont lancées avec un tableau d'arguments (jamais de shell).

- `create({ repo, repoDir, threadId, title })`
  1. `git -C <repoDir> fetch origin` ; échec → `AgentError('git', 'git fetch failed: …')`.
  2. `git -C <repoDir> symbolic-ref --short refs/remotes/origin/HEAD` → `origin/<default>` ;
     absent → `AgentError('invalid', '<repo> has no origin/HEAD …')` (message suggérant
     `git remote set-head origin -a`).
  3. Branche `factory/<threadId>-<slug>` : slug = titre en minuscules, `[a-z0-9]` et `-`,
     au plus 40 caractères, `task` si vide.
  4. `git -C <repoDir> worktree add -b <branch> <path> <base>` avec
     `path = <workspace>/.worktrees/<repo>/<threadId>` (dossiers parents créés).
  5. Retourne `{ path, branch, base }`.
- `status({ path, base })` → `{ exists, dirty, ahead }` : `git status --porcelain`
  (non vide = sale) et `git rev-list --count <base>..HEAD`. Dossier absent →
  `{ exists: false, dirty: false, ahead: 0 }`.
- `remove({ repoDir, path, branch, base, force = false })`
  - sale et pas `force` → `AgentError('dirty', 'the worktree has uncommitted changes')` ;
  - `git worktree remove [--force] <path>` (dossier déjà absent → `git worktree prune`) ;
  - `ahead === 0` → `git branch -D <branch>` ; sinon la branche est gardée.
  - Retourne `{ branchKept: boolean }`.

Toute autre commande git en échec (`worktree add` sur une branche ou un dossier
existant…) → `AgentError('git', <stderr git>)`.

Exporté depuis `src/index.js`. `AgentError` gagne deux codes : `dirty` (→ HTTP 409,
`{ error: 'worktree-dirty' }`) et `git` (→ HTTP 502, `{ error: 'git-failed', detail }`).
Le code `unavailable` existant reste réservé à la console.

### Store — migration

Colonnes nullables ajoutées à `threads` : `worktree_path`, `branch`, `base`.
`createThread` accepte un `id` optionnel (format `th_<hex>` validé) ; le store exporte
`newThreadId()`, utilisé par le service pour nommer le worktree avant de créer le thread. La vue
`thread` expose `worktree: { path, branch, base } | null`. `updateThread` accepte
`worktree: null` pour effacer les trois colonnes.

### Run manager — verrou et plafond

- Le refus `busy` porte sur un run actif ayant le **même `cwd`** (au lieu du même `repo`).
- Nouveau `maxActive` (défaut 4) : au-delà, `AgentError('busy', 'too many agents running (max N)')`.
  Les deux messages sont distincts.

### Thread service

- `start(body)` accepte `worktree: boolean` (défaut `false` côté API ; c'est l'UI qui
  coche par défaut).
  - Avec worktree : `id = newThreadId()`, `worktrees.create({ threadId: id, … })`, puis le
    run démarre avec `cwd = worktree.path`, puis `createThread({ id, worktree, … })`. Si `manager.start` lève (plafond, validation),
    le worktree est supprimé (`force`, branche vide) avant de relancer l'erreur : aucun
    thread ni worktree ne reste derrière.
  - Sans worktree : inchangé (`cwd = repos.resolve(repo)`).
- `cwdOf(thread)` = `thread.worktree?.path ?? repos.resolve(thread.repo)` ; utilisé par
  `reply` et la console.
- `get(id)` enrichit `thread.worktree` de `status()` (`dirty`, `ahead`, `exists`).
- `removeWorktree(id, { force })` : `409` pendant un run ; appelle `worktrees.remove`,
  puis `updateThread(id, { worktree: null })`. Le thread reste ; ses reprises se feront
  dans le checkout principal.
- `remove(id, { force })` : supprime d'abord le worktree (même règle `dirty`), puis le thread.
- `setStatus('archived')` ne touche pas au worktree.

### Démarrage (`apps/agents/src/main.js`)

- Option `--max-runs <n>` (entier ≥ 1, défaut 4).
- Après la récupération des threads interrompus : pour chaque thread avec worktree dont
  le dossier n'existe plus → `worktree: null`, log `[thread] worktree missing, cleared`.
- Les dossiers de `.worktrees/` sans thread sont listés dans le log, jamais supprimés.

### `apps/agents` — routes

| Méthode | Route | Changement |
|---|---|---|
| POST | `/threads` | champ `worktree?: boolean` ; `thread.worktree` dans la réponse |
| GET | `/threads/:id` | `thread.worktree` avec `{ path, branch, base, exists, dirty, ahead }` |
| DELETE | `/threads/:id/worktree?force=1` | 200 `{ thread, branchKept }` ; 404 sans worktree ; 409 run actif ou `worktree-dirty` |
| DELETE | `/threads/:id?force=1` | supprime aussi le worktree ; 409 `worktree-dirty` sans `force` |
| POST | `/terminals` | accepte `{ thread, cols, rows }` (cwd résolu côté serveur) en plus de `{ repo, … }` |
| GET | `/health` | ajoute `limits: { maxRuns }` |

`force` n'accepte que `1` ; toute autre valeur → 400. Le client n'envoie jamais de chemin.

### `apps/board`

- **Proxy** (`agentsProxy.js`) : `ROUTE` accepte `DELETE /threads/:id/worktree` et la query `force`.
- **`FactoryNewRequest.vue`** : case « Worktree isolé (nouvelle branche depuis origin) »,
  cochée par défaut, envoyée en `worktree`.
- **`FactoryConversation.vue`** : badge `⎇ <branch>` dans l'en-tête, pastille « modifié »
  si `dirty`, tooltip avec chemin, base et commits d'avance. Action « Supprimer le
  worktree » : confirmation ; sur `worktree-dirty`, seconde confirmation « Forcer (les
  changements non commités seront perdus) ». La suppression du thread suit le même flux.
- **`FactoryThreads.vue`** : icône ⎇ sur les threads avec worktree.
- **Console** (`useTerminal` / `FactoryConsole.vue`) : ouverture avec `thread` au lieu
  de `repo`.
- Icône ajoutée à `icons.js` ; clés i18n `factory.worktree.*` dans chaque locale.

## Sécurité

- Aucun chemin fourni par le client : le worktree est calculé côté serveur à partir du
  workspace, du nom de repo allowlisté et de l'id de thread (`th_…`, format validé).
- git lancé via `execFile` avec arguments en tableau ; le slug est restreint à `[a-z0-9-]`.
- `.worktrees/` est sous le workspace déjà utilisé ; aucune nouvelle classe de privilège.
- Suppression destructive (`force`) uniquement sur demande explicite, double confirmation
  côté UI.

## Erreurs

| Cas | Comportement |
|---|---|
| `git fetch` échoue (réseau, auth) | 502 `git-failed` avec la sortie git ; aucun thread créé |
| Pas d'`origin/HEAD` | 400 avec la commande à lancer |
| `worktree add` échoue (branche ou dossier existant) | 502 `git-failed` avec le message git ; aucun thread créé |
| Plafond global atteint | 409 « too many agents running (max N) » ; worktree nettoyé |
| Checkout partagé occupé | 409 « a run is already active on <repo> » (inchangé) |
| Worktree sale à la suppression | 409 `worktree-dirty` ; l'UI propose de forcer |
| Worktree supprimé à la main | `exists: false` au `GET` ; nettoyé au démarrage |

## Tests (gate 100 %)

- `worktrees.test.js` (faux `execFile`) : fetch en échec, `origin/HEAD` absent, slug
  (accents, vide, longueur), worktree add, status sale/propre/absent, remove avec et sans
  `force`, branche gardée/supprimée, prune si dossier absent.
- `store.test.js` : migration d'une base existante, `worktree` lu/écrit/effacé.
- `run.test.js` : verrou par `cwd` (deux cwd d'un même repo en parallèle), plafond `maxActive`.
- `threads.test.js` : start avec/sans worktree, nettoyage si le run est refusé, `cwdOf`
  pour reply, `removeWorktree`, `remove` avec `dirty`/`force`, archivage sans effet.
- `apps/agents` `server.test.js` / `main.test.js` : nouvelles routes et codes, `force`
  invalide, `/terminals` avec `thread`, `--max-runs`, nettoyage au démarrage.
- `agentsProxy.test.js` : route worktree acceptée, voisines refusées.
- Board : case par défaut, badge/pastille, flux de suppression avec forçage, console sur `thread`.
- Vérification manuelle : deux requêtes en parallèle sur le même repo, chacune avec sa
  console dans son worktree ; checkout principal inchangé (`git status`).

## Documentation

`docs/ai-factory.md` : section « Worktrees », flag `--max-runs`, nouvelles routes, mise à
jour de « One active run per repo » dans les limitations.

## Hors périmètre

- Revue du diff, merge, push ou PR depuis le board.
- Choix de la branche de base dans le formulaire.
- Réglage par repo dans `repos.json`.
- Nettoyage automatique des dossiers orphelins de `.worktrees/`.
- File d'attente quand le plafond est atteint.
