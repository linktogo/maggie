# @linktogo/maggie-renderers

Renders an agent skill into each target platform's on-disk format for
[maggie](https://github.com/linktogo/maggie). Known targets: `agents`,
`claude`, `copilot`, `cursor`, `windsurf`.

```js
import { getRenderer, knownTargets, renderRepo, mergeBlock } from '@linktogo/maggie-renderers';

const render = getRenderer('claude');
// Everything a repository gets: each skill per target, its supporting files, and
// the AGENTS.md index block (a file with a `block` id is merged with mergeBlock).
const files = renderRepo(['agents', 'claude'], skills);
```

One skill source, written once as `skills/<techno>/<name>/SKILL.md`, produces
the Agent Skills directory (`.agents/skills/`), the Claude Code skill file, the
Copilot instructions file, the Cursor rule, and the Windsurf rule.
