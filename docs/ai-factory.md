# AI Factory

Launch local AI coding agents from the board. Three pieces:

| Piece | What it is |
|---|---|
| [`libs/agent-runner`](../libs/agent-runner) | the logic: providers, repo allowlist, skills, run lifecycle |
| `apps/agents` (`maggie-agents`) | an independent Node.js server: HTTP + SSE, bearer token, loopback only |
| the board's **AI Factory** tab | a form and a live console; it relays to the server through `/api/factory/*` |

## Start it

```bash
npm run agents -- --repos repos.json --workspace wk      # the server (default port 4318)
npm start                                                  # the board; open the "AI Factory" tab
```

| Flag | Default | Meaning |
|---|---|---|
| `--repos <file>` | required | repos the agents may run in, same format as `repos.example.json` (see note below) |
| `--workspace <dir>` | `wk` | where checkouts live: `<workspace>/<name>`, unless the repo pins a `path` |
| `--provider` | `$MAGGIE_AGENT_PROVIDER`, else `claude-cli` | provider used when a request names none |
| `--port` | `4318` | loopback port, an integer from 0 to 65535 |
| `--skills <dir>` | the repository's `skills/` | skills offered by `GET /skills` |
| `--timeout <s>` | `600` | a run is killed after this long; a number greater than 0 |
| `--allow-origin <origin>` | none | an `Origin` the server accepts (repeatable); none by default |
| `--token-file <file>` | `~/.maggie/agents.token` | where the token is written |

`--repos` is parsed by `@linktogo/maggie-config` (`loadConfig`), so it is validated like the sync config:
every repo needs `targets`, or the file needs a top-level `defaultTargets`, as in `repos.example.json`.

The board finds the server with `npm start -- --agents-url <url> --agents-token-file <file>` (defaults:
`http://127.0.0.1:4318` and `~/.maggie/agents.token`). Pass the same file as the server's `--token-file`
when you moved it.

Providers are `claude-cli` (`claude -p`) and `copilot` (`copilot --allow-all-tools`); the CLI must be
installed and logged in. A request may override the provider, but only among those two; if its CLI is
missing the run fails with an explicit message (`Could not run ...`), never with a silent fallback.

## Security model

The server executes commands on your machine, so:

- it binds to `127.0.0.1` and refuses any `Host` that is not `localhost`, `127.0.0.1` or `[::1]`
  (DNS rebinding);
- every request needs `Authorization: Bearer <token>`; the token is generated at startup and written to a
  `0600` file (created exclusively, after removing a stale one) once the server is listening, so a second
  instance that fails to bind never deletes the token of the running one. The file is deleted when the
  server stops. The board reads it server-side: the browser never sees it, and the board's relay returns
  only the upstream status and content type;
- a request carrying an `Origin` is refused unless allowed with `--allow-origin`;
- clients send a repository **name**, resolved against the allowlist, never a path; skill ids are
  `<techno>/<name>` and cannot leave the skills directory; the model is validated as an identifier;
- one active run per repository, a timeout per run (SIGTERM, then SIGKILL after a 5 s grace), output
  kept in memory only and bounded (events, characters and number of runs).

**Agent permissions are the CLI's own.** `claude -p` runs with Claude Code's default non-interactive
permissions (it can read, but file edits and shell commands need a permission mode or allowed tools
configured in the target repository's `.claude/settings.json`); `copilot --allow-all-tools` lets Copilot
use every tool without asking. Review what you point an agent at.

## Run manager (library)

`createRunManager` from `@linktogo/maggie-agent-runner` takes these options:

| Option | Default | Meaning |
|---|---|---|
| `spawn` | `node:child_process` `spawn` | injectable, tests never start a real CLI |
| `now` | `() => new Date()` | clock |
| `timeoutMs` | `600000` | a run is terminated after this long |
| `killGraceMs` | `5000` | SIGKILL sent if the CLI is still alive this long after SIGTERM |
| `maxEvents` | `2000` | events kept per run for replay |
| `maxOutputChars` | `2000000` | output text kept per run |
| `maxRuns` | `100` | runs kept; finished ones are dropped first |

`start()` validates `repo`, `cwd` and `provider` before spawning anything.

## API

| Route | |
|---|---|
| `GET /health` | `{ providers: { available, default }, repos }` |
| `GET /skills` | `{ skills: [{ id, techno, name, description }] }` |
| `POST /runs` | `{ repo, provider?, model?, prompt? , skill? }` (a prompt or a skill) -> `202 { id, run }` |
| `GET /runs`, `GET /runs/:id` | runs, newest first / one run |
| `GET /runs/:id/events` | SSE: `stdout`, `stderr`, `status` events; history replayed, ends on the final status |
| `DELETE /runs/:id` | SIGTERM the agent -> `202` |

Errors: `400` invalid input, `401` bad token, `403` Host/Origin, `404` unknown repo/skill/run, `409` repo
busy, `413` body too large. The board exposes the same routes under `/api/factory/*`; when the agents
server or its token file is missing, the relay answers `503 { "error": "agents-unavailable", "detail": ... }`.

## Known limitations

- **Windows `.cmd` shims.** `claude` or `copilot` installed as a `.cmd` shim are detected, but Node cannot
  spawn them without a shell; the run then fails with an explicit message.
- **Shutdown.** SIGINT/SIGTERM stops the server (and removes the token file) but does not cancel active
  agent runs.
- **Runs are in memory only.** They are lost on restart.

## Not in this version

Persistence across restarts, queues, chained workflows, remote execution.
