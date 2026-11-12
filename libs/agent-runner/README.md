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

Options of `createRunManager`: `spawn`, `now`, `timeoutMs`, `killGraceMs`, `maxEvents`, `maxOutputChars`, `maxRuns`.

## Terminals

`createTerminalManager({ repos })` opens interactive shells (`$SHELL -l`) in a repository checkout,
one [node-pty](https://github.com/microsoft/node-pty) pseudo-terminal each — the Factory console.

```js
const terminals = createTerminalManager({ repos });
const { id } = await terminals.open({ repo: 'api', cols: 80, rows: 24 });
const unsubscribe = terminals.subscribe(id, (event) => console.log(event.type)); // 'data' (Buffer), then 'exit'
terminals.write(id, 'git status\r');
```

A terminal lives while someone reads it: once its last subscriber leaves (or none ever comes) it is
killed after `graceMs` (5 s). The last 64 KiB of output are replayed to each new subscriber. At most
4 shells run at once.

`node-pty` is a native module, loaded lazily: `available()` reports `{ ok: false, reason }` when it
cannot load, and the rest of the library keeps working. It ships prebuilt binaries for macOS and
Windows; elsewhere its install script compiles one with node-gyp, which needs Python and a C++
toolchain **at install time only**.

Options of `createTerminalManager`: `repos`, `loadPty`, `shell`, `platform`, `env`, `maxTerminals`,
`graceMs`, `setTimer`, `clearTimer`, `randomId`, `log`.
