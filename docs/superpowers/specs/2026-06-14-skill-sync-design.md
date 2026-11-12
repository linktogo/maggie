# Design — Synchronisation de skills multi-plateformes

**Date** : 2026-06-14
**Statut** : Validé (en attente de plan d'implémentation)

## Objectif

Fournir des scripts Node.js qui, à partir d'une liste JSON de repositories, clonent
chaque repo et y ajoutent des skills d'agents IA en fonction des technologies
assignées au repo. Les skills sont écrits une seule fois sous forme canonique dans
`ai-sync`, puis « traduits » (adaptation de format déterministe) vers chaque
plateforme cible (Claude Code, GitHub Copilot, Cursor, Windsurf).

`ai-sync` est la **source de vérité** des skills.

## Décisions cadrées

| Sujet | Décision |
|---|---|
| Source des skills | Auteurés et versionnés dans `ai-sync`, arborescence par techno |
| Cibles supportées | Claude Code, GitHub Copilot, Cursor, Windsurf |
| Sélection des cibles | Globale par défaut (`defaultTargets`), override par repo (`targets`) |
| Nature de la traduction | Adaptation de format déterministe : corps markdown identique, seuls le chemin et le frontmatter changent. Pas de LLM. |
| Workflow git | Clone → génération → branche → commit → push. PR opt-in via `--pr`. |
| Ré-exécution | Régénération complète (écrasement). La PR/le diff montre les changements. Optimisation no-op si rien ne change. |
| Architecture | Registry de renderers (un module par plateforme) + pipeline |

## Architecture

Approche retenue : **registry de renderers**. Pipeline en quatre préoccupations
isolées (chargement config, résolution des skills, rendu par plateforme, opérations
git), chaque plateforme étant un petit renderer testable indépendamment.

### Structure du projet

```
ai-sync/
  skills/
    <techno>/                    # ex: nestjs, react, postgres
      <skill-name>/
        SKILL.md                 # skill canonique (source de vérité)
  repos.json                     # liste des repos + cibles par défaut
  src/
    index.js                     # entrée CLI (parsing des flags)
    config.js                    # charge + valide repos.json
    skills.js                    # résout les skills par techno
    renderers/
      index.js                   # registry des renderers
      claude.js
      copilot.js
      cursor.js
      windsurf.js
    git.js                       # clone, branche, commit, push, PR
    pipeline.js                  # orchestration
  test/
    fixtures/skills/             # arborescence de skills minimale pour les tests
  package.json
```

### Dépendances

- `gray-matter` : parse/sérialise le frontmatter (lecture des sources, ré-émission par renderer).
- `child_process` natif : opérations `git` et `gh`.
- `node:test` + `node:assert` : tests (zéro dépendance supplémentaire).

## Formats de données

### Skill canonique

`skills/nestjs/module-structure/SKILL.md` :

```markdown
---
name: nestjs-module-structure
description: Comment structurer les modules NestJS
globs: ["**/*.ts"]        # optionnel : scoping fichier pour Cursor/Copilot
---

# Module structure
... corps markdown, identique pour toutes les plateformes ...
```

Le frontmatter porte le minimum nécessaire aux renderers : `name`, `description`,
et `globs` (optionnel). Le corps est repris tel quel par toutes les cibles.

### Liste des repos (`repos.json`)

```json
{
  "defaultTargets": ["claude", "copilot"],
  "repos": [
    {
      "name": "example-api",
      "url": "git@github.com:example-org/example-api.git",
      "technologies": ["nestjs", "postgres"],
      "targets": ["claude", "cursor"]
    }
  ]
}
```

- `defaultTargets` : cibles appliquées à tout repo sans champ `targets`.
- `repos[].targets` : optionnel, surcharge `defaultTargets` pour ce repo.

## Renderers

Chaque renderer exporte `{ id, render(skill) → { path, content } }`. Le corps est
identique ; seuls le chemin de sortie et le frontmatter varient.

À partir de `nestjs-module-structure` (avec `globs: ["**/*.ts"]`) :

**claude** → `.claude/skills/nestjs-module-structure/SKILL.md`
```markdown
---
name: nestjs-module-structure
description: Comment structurer les modules NestJS
---
... corps ...
```

**copilot** → `.github/instructions/nestjs-module-structure.instructions.md`
```markdown
---
description: Comment structurer les modules NestJS
applyTo: "**/*.ts"          # dérivé de globs (défaut "**")
---
... corps ...
```

**cursor** → `.cursor/rules/nestjs-module-structure.mdc`
```markdown
---
description: Comment structurer les modules NestJS
globs: "**/*.ts"            # globs joints en chaîne
alwaysApply: false          # true si aucun glob
---
... corps ...
```

**windsurf** → `.windsurf/rules/nestjs-module-structure.md`
```markdown
---
description: Comment structurer les modules NestJS
globs: "**/*.ts"
---
... corps ...
```

**Registry** (`renderers/index.js`) : map `{ claude, copilot, cursor, windsurf }`.
Le pipeline résout chaque cible demandée vers son renderer ; une cible inconnue
provoque une erreur de validation explicite au démarrage.

## Pipeline & flux

Pour chaque repo :

1. **Clone** dans un work-dir temporaire (`os.tmpdir()/ai-sync/<repo-name>`, nettoyé
   après). Si déjà cloné, `git fetch` + reset propre.
2. **Résolution des skills** (`skills.js`) : union des skills de `skills/<techno>/`
   pour chaque techno du repo. Déduplication par `name`.
3. **Résolution des cibles** : `repo.targets ?? config.defaultTargets`.
4. **Rendu** : pour chaque skill × chaque cible → renderer → écriture du fichier dans
   le clone.
5. **Git** (`git.js`) : branche `ai-sync/update-skills` → `git add` des chemins
   générés → commit → push. Si `--pr`, ouverture de PR via `gh pr create`.

**Optimisation no-op** : après écriture, si `git status` est propre, on skip
branche/commit/push/PR pour ce repo (pas de PR vide à chaque run).

## Interface CLI

```
node src/index.js --config repos.json
  --pr             # ouvre une PR via gh après le push (sinon push seul)
  --dry-run        # génère + affiche le diff, sans aucune opération git
  --work-dir DIR   # override du répertoire de clone
  --repo NAME      # ne traiter qu'un repo (debug)
```

## Gestion d'erreurs

- **Isolation par repo** : un repo en échec (clone, push, PR…) est loggé et collecté,
  sans interrompre les autres.
- **Techno sans dossier** `skills/<techno>/` → warning, on continue (les autres
  technos du repo s'appliquent).
- **Cible inconnue** dans la config → erreur de validation au démarrage (fail-fast
  avant tout clone).
- **`git` ou `gh` absent** → erreur claire au démarrage.
- **Rapport final** : récapitulatif (repos OK / skipés / en erreur) + code de sortie
  non-zero si au moins un échec.

## Tests

Runner : `node:test` + `node:assert` natifs.

**Règle de couverture : 100 % strict sur `src/`.** Aucun module ne ship sans test.
Couverture mesurée via le runner natif (`node --test --experimental-test-coverage`),
avec un seuil **bloquant à 100 %** des lignes, branches et fonctions sur `src/`,
vérifié en CI (le build échoue en dessous de 100 %). Aucune exclusion par défaut :
toute ligne non couverte doit être soit testée, soit supprimée. Tout nouveau module
ajouté doit arriver avec ses tests.

Chaque module de `src/` a une couverture dédiée :

**Unitaires (modules purs) :**
- **Renderers** (`renderers/*.js`) : pour chacun, un skill canonique → assertion du
  chemin ET du contenu (frontmatter correct + corps préservé). Cas `globs`
  présent/absent (`alwaysApply` Cursor, `applyTo` défaut Copilot).
- **renderers/index.js** : résolution d'une cible vers son renderer ; cible inconnue
  → erreur.
- **config.js** : config valide OK ; cible inconnue → erreur ; champs requis manquants
  → erreur ; résolution `targets ?? defaultTargets`.
- **skills.js** : union multi-techno, déduplication par `name`, techno sans dossier
  → warning sans crash.

**Intégration (sans réseau ni gh) :**
- **git.js** : repo git local *bare* comme remote dans un tmpdir → clone, branche,
  add, commit, push vérifiés contre le bare remote. `gh pr create` mocké (binaire
  factice sur le `PATH` du test ou injection de dépendance) pour couvrir le chemin
  `--pr` sans réseau.
- **pipeline.js** : run complet depuis une arborescence `skills/` fixture vers un ou
  plusieurs bare repos → fichiers aux bons chemins, commit/push présents, rapport
  final correct.
- **index.js (CLI)** : parsing des flags (`--pr`, `--dry-run`, `--work-dir`,
  `--repo`), `--dry-run` n'effectue aucune opération git, code de sortie non-zero en
  cas d'échec. Le pipeline est injecté/mocké pour isoler le parsing.
- **No-op** : second run sans changement → aucune nouvelle branche/commit.
- **Isolation d'erreur** : un repo à l'URL invalide → loggé, les autres passent, code
  de sortie non-zero.

**Fixtures** : `test/fixtures/skills/` minimal (1-2 technos) + helper montant un bare
repo temporaire.
