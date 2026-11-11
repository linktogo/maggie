# Design — Console Factory (shell interactif dans une conversation)

**Date** : 2026-11-08
**Statut** : En revue

## Objectif

Depuis une conversation de la Factory, ouvrir un vrai terminal interactif dans le
navigateur, sur un shell lancé dans le dossier du repo du thread, pour inspecter ou
lancer des commandes (git, tests…) à côté de l'agent. Le pseudo-terminal est géré
par un processus Node.js (le serveur agents), sans helper Python.

## Décisions cadrées

| Sujet | Décision |
|---|---|
| Contenu | `$SHELL -l` dans le dossier du repo du thread (pas de `claude --resume`) |
| Lien | Le terminal est rattaché au **repo** du thread, pas à sa session : marche avec Claude et Copilot |
| Hébergement | Serveur agents (`apps/agents`), qui exécute déjà des commandes derrière token + loopback ; le board ne fait que relayer |
| PTY | `node-pty` (vrai pty, resize, ConPTY sous Windows), chargé paresseusement |
| Transport | SSE pour la sortie, POST pour l'entrée et le redimensionnement — le modèle du proxy existant, sans WebSocket |
| Durée de vie | Le shell meurt avec son onglet : ✕, changement de conversation/repo, fermeture/rechargement de la page |
| UI | Onglets `Conversation \| Console` qui n'apparaissent qu'au clic sur le bouton **Console** |
| Activation | Active par défaut, coupée par `maggie-agents --no-terminal` |
| Persistance | Aucune : ni en base, ni rattachement après fermeture |

## Architecture

```
navigateur (xterm.js)
   │  POST /api/factory/terminals            ← Origin contrôlé par le board
   │  GET  /api/factory/terminals/:id/events (SSE)
   │  POST /api/factory/terminals/:id/input|resize, DELETE
   ▼
apps/board  agentsProxy  ── ajoute le bearer token ──▶  apps/agents  /terminals/*
                                                          │
                                                          ▼
                                         libs/agent-runner  terminals.js ── node-pty ── $SHELL
```

### `libs/agent-runner` — `src/terminals.js`

`createTerminalManager({ repos, loadPty, shell, env, maxTerminals = 4, graceMs = 5_000, idleMs, now, setTimer })`

- `loadPty` (défaut `() => import('node-pty')`) est injectable, comme `spawn` dans
  `run.js`. Le manager expose `available()` → `{ ok: true }` ou
  `{ ok: false, reason }` si le module natif ne se charge pas ; le serveur
  démarre dans tous les cas.
- `shell` : `env.SHELL`, sinon `/bin/sh` (POSIX) ou `env.ComSpec ?? 'cmd.exe'` (Windows).
- `open({ repo, cols, rows })` : `cwd = repos.resolve(repo)` (lève `not-found`
  si inconnu), spawn `shell` avec `['-l']` hors Windows, `name: 'xterm-256color'`,
  `env` du processus. Id `tm_<16 hex>` (`randomBytes(8)`). Au-delà de
  `maxTerminals` vivants → `AgentError('busy')`. Retourne `{ id, repo, cwd }`.
- La sortie est diffusée aux abonnés ; les derniers **64 Kio** sont gardés en
  tampon et rejoués à chaque nouvel abonné (le prompt initial n'est pas perdu
  entre le POST et l'ouverture du flux).
- `subscribe(id, onEvent)` → `unsubscribe`. Événements `{ type: 'data', data: Buffer }`
  puis `{ type: 'exit', code, signal }`. Quand le dernier abonné se désabonne, un
  minuteur de `graceMs` démarre ; sans nouvel abonné à son échéance → `kill`.
  Un terminal ouvert mais jamais suivi est tué de la même façon.
- `write(id, data)`, `resize(id, cols, rows)`, `kill(id)`, `killAll()`.
  Id inconnu → `not-found`. Après `exit`, le terminal est retiré de la table.
- Validation : `cols` 1–500, `rows` 1–200 (entiers) → sinon `invalid`.

Exporté depuis `src/index.js`. `node-pty` devient une dépendance de
`@linktogo/maggie-agent-runner`.

### `apps/agents`

`server.js` reçoit `terminals` (le manager, ou `null` avec `--no-terminal`).

| Méthode | Route | Réponse |
|---|---|---|
| GET | `/health` | ajoute `terminal: { available: bool, reason? }` |
| POST | `/terminals` `{ repo, cols, rows }` | 201 `{ terminal: { id, repo, cwd } }` |
| GET | `/terminals/:id/events` | SSE : `event: data` (`data` = octets en base64), `event: exit` (`{ code, signal }`) puis fin |
| POST | `/terminals/:id/input` `{ data }` (UTF-8, ≤ 64 Kio) | 204 |
| POST | `/terminals/:id/resize` `{ cols, rows }` | 204 |
| DELETE | `/terminals/:id` | 204 |

Regex de route : `^/terminals(/tm_[0-9a-f]{16}(/events|/input|/resize)?)?$`.
Terminal désactivé ou PTY indisponible → 503 `{ error: 'terminal-unavailable', detail }`.
La fermeture de la réponse SSE désabonne (déclenche le délai de grâce).
`main.js` : option `--no-terminal`, `killAll()` sur SIGINT/SIGTERM, une ligne de
log par terminal ouvert/fermé (`[tm_…] shell on <repo>` / `exited <code>`).

### `apps/board`

**Proxy** (`agentsProxy.js`) : `ROUTE` accepte en plus exactement les routes
ci-dessus. Le reste ne change pas (token ajouté côté serveur, SSE relayé sans
buffer, abandon de l'amont à la fermeture côté navigateur). `server.js` est
inchangé : les POST/DELETE passent déjà par le contrôle d'`Origin`.

**`src/useTerminal.js`** (`fetchImpl`, `EventSourceImpl` injectés, comme `useThreads`) :

- état : `id`, `status` (`idle | opening | open | exited | disconnected | error`),
  `exitCode`, `error`, `cwd`.
- `open(repo, { cols, rows }, onData)` : POST puis `EventSource` sur `/events` ;
  décode le base64 en `Uint8Array` pour `onData`.
- `write(data)` : regroupe les frappes ~10 ms, une seule requête en vol, ordre
  préservé.
- `resize(cols, rows)` : debounce ~100 ms.
- `close()` : DELETE + fermeture du flux ; appelé sur `onUnmounted` et `pagehide`.
- `onerror` du flux → `disconnected`, pas de reconnexion automatique.

**`src/FactoryConsole.vue`** : monte `@xterm/xterm` + `@xterm/addon-fit`, couleurs
lues depuis les tokens du thème actif (clair/sombre), `ResizeObserver` → `fit()` →
`resize`. Affiche `cwd` ; en `exited`/`disconnected`, une ligne d'état et un
bouton **Rouvrir**.

**Intégration** (`FactoryPage.vue` / `FactoryConversation.vue`) :

1. Par défaut : conversation seule, bouton **Console** (icône ajoutée à
   `icons.js`, tooltip) dans l'en-tête, à côté de provider · model.
2. Clic : le shell s'ouvre ; les onglets `Conversation | ● Console ✕`
   apparaissent, Console actif sur toute la hauteur du pane. Un nouveau clic
   alors qu'un shell existe ramène sur l'onglet Console, sans en ouvrir un second.
3. Retour sur Conversation : le shell reste vivant (xterm reste monté, caché par
   `v-show`, flux ouvert). ✕, changement de conversation/repo ou fermeture de la
   page le tue et les onglets disparaissent.

Le bouton est désactivé (tooltip explicatif) quand `health.terminal.available`
est faux. Clés i18n `factory.console.*` dans chaque fichier de `src/locales`.

Dépendances ajoutées au board : `@xterm/xterm`, `@xterm/addon-fit` (versions exactes).

## Sécurité

Pas de nouvelle classe de privilège (la Factory fait déjà exécuter du code dans
ces repos), mais un shell direct est plus frontal :

- Board : loopback, contrôle `Host` (DNS rebinding), contrôle `Origin` sur la
  création, la saisie, le resize et la fermeture — une page tierce ne peut ni
  ouvrir un shell ni y taper.
- Le flux SSE n'envoie aucun en-tête CORS : illisible depuis une autre origine.
  Les ids ne sont jamais listés.
- Serveur agents : token + loopback + refus de toute `Origin`, inchangés.
- `cwd` limité aux repos connus de `repos.resolve`, aucun chemin libre ; plafond
  de shells, bornes `cols`/`rows`, taille max de saisie.
- `SECURITY.md` : nouvelle puce de scope — la console Factory ouvre un shell en
  tant que l'utilisateur ; quiconque peut piloter le board en local peut s'en
  servir ; `--no-terminal` la coupe.
- `node-pty` : module natif. Binaires précompilés pour macOS/Windows ; ailleurs,
  compilation node-gyp (Python + compilateur) **à l'installation uniquement**.
  Documenté dans le README de `apps/agents`.

## Erreurs

| Cas | Comportement |
|---|---|
| `node-pty` absent / ne se charge pas | `/health` → `terminal.available: false` + raison ; bouton désactivé |
| `--no-terminal` | idem, raison « désactivée » |
| Repo inconnu | 404, message dans l'onglet |
| Plafond atteint | 409, message dans l'onglet |
| Échec du spawn | 500 avec le message |
| Serveur agents arrêté | message « unavailable » existant |
| Shell terminé (`exit`) | « Processus terminé (code n) » + Rouvrir |
| Flux coupé | « Déconnecté » + Rouvrir ; le serveur tue l'orphelin après `graceMs` |

## Tests (gate 100 %)

- `terminals.test.js` : faux `loadPty` (échec de chargement inclus), ouverture,
  `cwd`, plafond, tampon rejoué, write/resize/kill, validation, sortie du
  processus, délai de grâce et terminal jamais suivi (fake timers), `killAll`.
- `apps/agents` `server.test.js` : chaque route avec un faux manager, codes HTTP,
  SSE base64 + `exit`, désabonnement à la fermeture, `--no-terminal`, `/health`.
- `main.test.js` : option `--no-terminal`, `killAll` au signal.
- `agentsProxy.test.js` : nouvelles routes acceptées, voisines refusées.
- `useTerminal.test.js` : batching et ordre des frappes, debounce du resize,
  décodage, `exit`, `onerror`, `close` sur unmount/`pagehide`.
- `FactoryConsole.test.js` : `@xterm/xterm` mocké, fit/resize, Rouvrir.
- `FactoryPage.test.js` / `FactoryConversation.test.js` : les 3 états des
  onglets, clic répété, kill au changement de conversation, bouton désactivé.
- Vérification manuelle : board + agents lancés, shell ouvert depuis le
  navigateur, `vim`/couleurs/resize, fermeture de l'onglet → processus disparu.

## Hors périmètre

- Rattachement à un shell après rechargement, plusieurs consoles par conversation.
- `claude --resume` interactif dans la console.
- Persistance ou export de la sortie du terminal.
