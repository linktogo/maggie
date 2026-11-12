# @linktogo/maggie-git

Thin wrapper around `git` and the GitHub `gh` CLI used by
[maggie](https://github.com/linktogo/maggie): clone, branch, commit, push, and
open pull requests. SSH and scp-style remotes are rewritten to HTTPS before
cloning.

```js
import { clone } from '@linktogo/maggie-git';

await clone('https://github.com/example-org/example-api.git', '/tmp/checkout', { depth: 1 });
```
