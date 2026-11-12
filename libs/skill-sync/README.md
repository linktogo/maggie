# @linktogo/maggie-skill-sync

Resolves which skills apply to a repository — by matching its `technologies`
against `skills/<techno>/` — and drives the
[maggie](https://github.com/linktogo/maggie) pipeline: clone, render, branch,
commit, push, and optionally open a pull request.

```js
import { run } from '@linktogo/maggie-skill-sync';

const results = await run(config, { skillsDir: 'skills', dryRun: true, logger: console });
```

Pass `strict: true` to turn "this technology matched no skills" from a warning
into an error — useful in CI to catch a typo'd technology.
