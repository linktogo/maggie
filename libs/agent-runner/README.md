# @linktogo/maggie-agent-runner

Run local AI agent CLIs on a repository checkout for [maggie](https://github.com/linktogo/maggie)'s
AI Factory. No HTTP in here: this is the logic the `maggie-agents` server wraps.

```js
import { buildPrompt, createRunManager, listSkills } from '@linktogo/maggie-agent-runner';

const manager = createRunManager({ timeoutMs: 10 * 60_000 });
const run = manager.start({ repo: 'api', cwd: '/home/me/wk/api', provider: 'claude-cli', prompt: 'fix the failing test' });
manager.subscribe(run.id, (event) => console.log(event.type, event.data));
```

Providers: `claude-cli` (`claude -p`) and `copilot` (`copilot --allow-all-tools`). The prompt goes
in on stdin. `spawn` is injectable, so tests never launch a real CLI.
