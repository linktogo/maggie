# Design — AI Factory (serveur d'agents + onglet du board)

**Date** : 2026-10-26
**Statut** : En attente de relecture

## Objectif

Faire de Maggie une « AI factory » : depuis un nouvel onglet du board, lancer des
agents IA (Claude Code ou GitHub Copilot, en mode CLI, en local) sur les repos de
la config. Un serveur Node.js indépendant reçoit les requêtes, choisit le provider
et exécute le CLI ; le board n'est qu'un client.

## Décisions cadrées

| Sujet | Décision |
|---|---|
| Type de run | Prompt libre **ou** skill prédéfini (`skills/<techno>/<name>/SKILL.md`) |
| Provider | Défaut côté serveur (`--provider` / `MAGGIE_AGENT_PROVIDER`), override par requête parmi `claude-cli` et `copilot` |
| Provider absent | Le run échoue avec un message explicite (`ENOENT`), pas de fallback silencieux |
| Sécurité | Loopback `127.0.0.1` + bearer token généré au démarrage + contrôle `Host`/`Origin` + allowlist de repos |
| Streaming | SSE par run, historique rejoué à la connexion |
| Persistance | Aucune en V1 : les runs vivent en mémoire |
| Architecture | `libs/agent-runner` (logique) + `apps/agents` (transport HTTP) + onglet dans `apps/board` |

## Architecture

```
libs/agent-runner      logique pure, sans HTTP, spawn injectable
apps/agents            serveur HTTP/SSE indépendant, dépend de agent-runner
apps/board             onglet /factory + proxy /api/factory/* vers apps/agents
```

`libs/retro-doc` reste inchangée. `agent-runner` y réutilise `providerCommand`
pour que l'invocation de `claude -p` et `copilot` reste identique.

### `libs/agent-runner` (`@linktogo/maggie-agent-runner`)

| Module | Rôle |
|---|---|
| `providers.js` | `AGENT_PROVIDERS = ['claude-cli','copilot']`, `detectProviders()` (CLI présent sur le PATH), `resolveProvider({requested, fallback})` |
| `skills.js` | `listSkills(skillsDir)`, `loadSkill(skillsDir, 'techno/name')` ; nom validé par regex, jamais de `..` ni de chemin absolu |
| `repos.js` | `resolveRepo(allowlist, name)` : renvoie le chemin d'un repo de l'allowlist, `null` sinon |
| `run.js` | `createRunManager({spawn, now, timeoutMs})` : `start`, `get`, `list`, `cancel`, `subscribe(id, listener)` |

Cycle d'un run : `running` → `succeeded` | `failed` | `cancelled` | `timed-out`.
Événements émis : `stdout`, `stderr`, `status`. L'historique est conservé pour
rejouer le flux à un abonné tardif. Le prompt est envoyé sur stdin (comme
retro-doc), avec `cwd` = checkout du repo. Un seul run actif par repo ; le modèle
est validé par `^[A-Za-z0-9][\w.:/-]*$` (jamais lu comme une option).

### `apps/agents` (serveur indépendant)

Serveur `node:http` sans dépendance, port `4318` par défaut, `127.0.0.1` uniquement.
Au démarrage il génère un token et l'écrit dans `~/.maggie/agents.token` (mode
`0600`), sans jamais le logger.

| Route | Rôle |
|---|---|
| `GET /health` | providers disponibles, provider par défaut |
| `GET /skills` | skills disponibles |
| `POST /runs` | `{repo, provider?, model?, prompt}` ou `{repo, skill, provider?, model?}` → `202 {id}` |
| `GET /runs`, `GET /runs/:id` | liste et état |
| `GET /runs/:id/events` | flux SSE |
| `DELETE /runs/:id` | annulation (SIGTERM) |

Contrôles sur chaque requête : token valide (`401`), `Host` loopback (`403`),
`Origin` absent ou égal à l'origine du board (`403`). Erreurs : `400` entrée
invalide, `404` repo/skill/run inconnu, `409` run déjà actif sur le repo.

Configuration : `--port`, `--provider`, `--repos <repos.json>` (même format que
`repos.example.json`), `--skills <dir>`.

### Onglet « AI Factory » dans `apps/board`

- Route `/factory`, `FactoryPage.vue`, composable `useFactory.js`, entrée dans la
  navigation, chaînes dans les 4 locales (fr, en, de, es).
- Formulaire : repo, provider, modèle, prompt libre ou skill.
- Panneau de sortie en direct (SSE), bouton d'arrêt, liste des runs récents.
- Le navigateur ne voit jamais le token : le board expose `/api/factory/*`, lit le
  fichier token côté serveur et relaie les appels (SSE compris) vers `apps/agents`.
  Les gardes `Host`/`Origin` existantes du board s'appliquent.
- Si `apps/agents` ne répond pas, la page affiche l'état « serveur d'agents
  injoignable » et la commande pour le démarrer.

## Tests et qualité

- TDD, `node --test`, couverture 100 % (lignes, fonctions, branches) sur
  `libs/agent-runner` et `apps/agents`, comme exigé par CONTRIBUTING.
- `spawn` injecté : aucun vrai CLI lancé dans les tests.
- Tests Vue de `FactoryPage` et `useFactory` (EventSource simulé) ; tests du proxy
  dans `server.test.js` du board.
- Projets Nx `agent-runner` et `agents`, script racine `npm run agents`.
- Documentation : `docs/ai-factory.md`, README, CONTRIBUTING, CHANGELOG.

## Hors périmètre (V1)

Persistance des runs après redémarrage, file d'attente multi-agents, workflows
enchaînés, authentification multi-utilisateurs, exécution à distance.
