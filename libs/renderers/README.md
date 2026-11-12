# @linktogo/maggie-renderers

Renders an agent skill into each target platform's on-disk format for
[maggie](https://github.com/linktogo/maggie). Known targets: `claude`,
`copilot`, `cursor`, `windsurf`.

```js
import { getRenderer, knownTargets } from '@linktogo/maggie-renderers';

const render = getRenderer('claude');
```

One skill source, written once as `skills/<techno>/<name>/SKILL.md`, produces
the Claude Code skill file, the Copilot instructions file, the Cursor rule, and
the Windsurf rule.
