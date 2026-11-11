# AI Factory

Launch local AI coding agents from the board and keep the conversation going. Every request is a **thread**:
a persisted conversation with one agent in one repository. You browse threads per project (an allowlisted
repo) and per request, reply to a thread, and the agent resumes its own session. History lives in
`~/.maggie/factory.db` (SQLite) and survives restarts. Requires **Node.js >= 22.13** (`node:sqlite`). Three pieces:

| Piece | What it is |
|---|---|
| [`libs/agent-runner`](../libs/agent-runner) | the logic: providers, repo allowlist, skills, run lifecycle, thread store and service |
| `apps/agents` (`maggie-agents`) | an independent Node.js server: HTTP + SSE, bearer token, loopback only |
| the board's **AI Factory** tab | a three-pane message center (projects, requests, conversation); it relays to the server through `/api/factory/*` |

## Start it

```bash
npm run agents -- --repos repos.json --workspace wk      # the server (default port 4318)
npm start                                                  # the board; open the "AI Factory" tab
```

| Flag | Default | Meaning |
|---|---|---|
| `--repos <file>` | required | repos the agents may run in, same format as `repos.example.json` (see note below) |
| `--config-repo <url>` | none | read the repos from `repos.json` in a git repository instead of `--repos` (one of the two is required); `--config-file <path>` picks another file |
| `--workspace <dir>` | `wk` | where checkouts live: `<workspace>/<name>`, unless the repo pins a `path` |
| `--provider` | `$MAGGIE_AGENT_PROVIDER`, else `claude-cli` | provider used when a request names none |
| `--port` | `4318` | loopback port, an integer from 0 to 65535 |
| `--skills <dir>` | the repository's `skills/` | skills offered by `GET /skills` |
| `--timeout <s>` | `600` | a run is killed after this long; a number greater than 0 |
| `--max-runs <n>` | `4` | agent runs allowed at once across all repos; an integer, 1 or more. Beyond it a request is refused with `409` (no queue) |
| `--allow-origin <origin>` | none | an `Origin` the server accepts (repeatable); none by default |
| `--token-file <file>` | `~/.maggie/agents.token` | where the token is written |
| `--db <file>` | `~/.maggie/factory.db` | SQLite file holding the threads, kept `0600` (its directory is created `0700`). The server refuses to start when it cannot be opened (no in-memory fallback) |
| `--trust-repos` | off | before listening, mark the checked-out repos as trusted in `~/.claude.json` (see below) |
| `--no-terminal` | off | disable the console (interactive shell from a conversation, see below) |

Claude Code ignores a repository's `.claude/settings.json` permissions until its trust dialog has been accepted,
and a server-launched run cannot answer that dialog. `--trust-repos` does what accepting it would: it sets
`hasTrustDialogAccepted` for each configured repo that is checked out. It is opt-in, since it grants those repos'
own permissions; only use it for repositories you trust.

`--repos` is parsed by `@linktogo/maggie-config` (`loadConfig`), so it is validated like the sync config:
every repo needs `targets`, or the file needs a top-level `defaultTargets`, as in `repos.example.json`.

The board finds the server with `npm start -- --agents-url <url> --agents-token-file <file>` (defaults:
`http://127.0.0.1:4318` and `~/.maggie/agents.token`). Pass the same file as the server's `--token-file`
when you moved it.

## Threads

A request creates a thread and starts its first run; the agent's text, its tool steps (collapsed per turn) and
the outcome of each run (duration, cost when known) are stored as messages. While a run is active the thread is
`running`; afterwards it is `idle` (waiting for you), or `failed` when the first run ended before any session or
answer existed. `archived` threads are hidden from the default list. A reply to an idle thread starts a new run
that resumes the agent session.

- **Resume is Claude only.** Claude threads resume with `claude --resume <session_id>`; a Copilot thread keeps
  its first answer as plain text and cannot be resumed (restart it as a new request). If Claude has purged the
  session, that reply's run ends with the outcome `failed` and an explicit message, the thread goes back to
  `idle`, and the board offers to restart it as a new request.
- **Restarts.** On startup, once the port is bound (a second instance that fails to bind leaves the live one's
  threads alone) and before the token file is written, threads still `running` (the server was killed) become
  `idle`, or `failed` when they have no session, with an "interrupted by a restart" message; the server logs
  `recovered N interrupted thread(s)`.
- **Limits.** A message is at most 32 KB, a stored tool input 4 KB, a list page 50 threads.

Providers are `claude-cli` (`claude -p --permission-mode acceptEdits`) and `copilot` (`copilot --allow-all-tools`); the CLI must be
installed and logged in. A request may override the provider, but only among those two; if its CLI is
missing the run fails with an explicit message (`Could not run ...`), never with a silent fallback.

## Worktrees

A request may ask for an isolated `git worktree` (`worktree: true`; the board's new-request form ticks the box by
default). That lets several agents work on the same repository at once without touching its main checkout.

- **Base.** The server runs `git fetch origin`, reads the default branch with
  `git symbolic-ref --short refs/remotes/origin/HEAD` (when it is missing, the request fails with a `400` naming
  `git remote set-head origin -a`), and branches from `origin/<default>`. A failing git command is a
  `502 git-failed` with git's output, and no thread is created.
- **Branch and location.** The branch is `factory/<threadId>-<slug>` (the slug is the title as `[a-z0-9-]`,
  40 characters at most, `task` when empty); the worktree lives in `<workspace>/.worktrees/<repo>/<threadId>`.
  The client never sends a path.
- **Fresh checkout.** A new worktree holds only what git tracks: no `node_modules`, no build output, and no
  untracked files such as `.env`. The agent may need to install the dependencies (or be told where the
  configuration lives) before it can build or test. With `--trust-repos`, each new worktree is also marked as
  trusted for Claude Code.
- **Lifecycle.** The thread's runs (first run, replies) and its console use the worktree as their working
  directory. If the run is refused after the worktree was created (for instance at the `--max-runs` ceiling), the
  worktree and its branch are removed again and no thread is left behind. Archiving a thread leaves its worktree
  alone. `DELETE /threads/:id/worktree` removes it; `DELETE /threads/:id` removes it too, then the thread. Both
  are `409` while a run is active and `409 worktree-dirty` when the worktree has uncommitted changes, unless
  `?force=1` is given (those changes are then lost).
- **No resume after removal.** A Claude session belongs to its working directory: after its worktree is removed,
  a thread can no longer be resumed (its session is forgotten); restart it as a new request. The thread and its
  history stay. A worktree folder deleted by hand while the server runs is never swapped for the main checkout:
  replies and the console are refused with a `400` until the worktree is removed from the thread.
- **Branch kept.** The branch is deleted with the worktree only when it has no commits beyond its base; a branch
  with commits ahead is always kept, and the response says so (`branchKept: true`). Once the worktree itself is
  gone, a branch that git fails to count or delete is kept as well (logged, never an error).
- **Startup.** After recovering interrupted threads, the server forgets the worktree (and the Claude session) of
  any thread whose folder no longer exists (`[<id>] worktree missing, cleared`; the thread can no longer be
  resumed) and logs the folders of `.worktrees/` that no thread knows (`orphan worktree: <path>`). It never
  deletes anything.

## Console

A conversation's **Console** button opens an interactive shell (`$SHELL -l`) in the thread's repository
checkout (or in its worktree, when it has one), in a tab next to the conversation. The shell runs on a pseudo-terminal from
[node-pty](https://github.com/microsoft/node-pty), in the agents server; the board relays it like the other
routes. It dies with its tab: closing it, opening another conversation or closing the page kills it (5 s after
its last reader leaves). At most 4 shells run at once; the last 64 KiB of output are replayed when the tab
reconnects within those 5 s.

node-pty is a native, optional dependency: it ships prebuilt binaries for macOS and Windows, and elsewhere
compiles one with node-gyp at install time (Python and a C++ toolchain). When it cannot load, the server still
starts, `/health` reports `terminal: { available: false, reason }` and the button is disabled with that reason.

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
- one active run per checkout or worktree (and `--max-runs` overall), a timeout per run (SIGTERM, then SIGKILL after a 5 s grace); live output
  buffers are bounded (events, characters and number of runs); the history in `factory.db` is a plain `0600`
  file readable by your user, in a `0700` directory, so treat it like your shell history;
- the console is a shell as your user in an allowlisted checkout: anyone who can drive the board locally can
  use it. Opening one, typing in it and closing it are `POST`/`DELETE` requests, so the board's `Origin` check
  applies; terminal ids (`tm_` + 16 random hex digits) are never listed. `--no-terminal` turns it off.

**Agent permissions are the CLI's own.** `claude -p --permission-mode acceptEdits` may edit files in the
repository without asking, while shell commands and other tools still need allowed tools configured in the
target repository's `.claude/settings.json` (see `--trust-repos`); `copilot --allow-all-tools` lets Copilot
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
| `GET /health` | `{ providers: { available, default }, repos, terminal: { available, reason? }, limits: { maxRuns } }` |
| `GET /skills` | `{ skills: [{ id, techno, name, description }] }` |
| `GET /projects` | `{ projects: [{ repo, threads, running, lastActivity }] }` for every allowlisted repo |
| `GET /threads?repo=&status=&q=&before=` | `{ threads }`, newest first, 50 per page; `q` searches titles and text messages; archived excluded unless `status=archived` |
| `POST /threads` | `{ repo, provider?, model?, prompt?, skill?, worktree? }` (a prompt or a skill; `worktree` defaults to `false`) -> `202 { thread }`; starts the first run, in a new worktree when asked |
| `GET /threads/:id` | `{ thread, messages }`; `thread.worktree` is `null` or `{ path, branch, base, exists, dirty, ahead }` |
| `POST /threads/:id/messages` | `{ prompt }` -> `202 { thread }`; resumes the session. `409` thread or repo busy, `400` not resumable |
| `GET /threads/:id/events?after=` | SSE: `message` events and `status`. With `after=<message id>` (`0` for all), the messages stored past that id are replayed first, then new ones stream live (replay and subscription happen in the same tick, so none is missed); without it, only newly stored messages. Ends when the thread leaves `running`; a thread that is not running gets its backlog, then its status, and the stream ends. A non-integer `after` is a `400` |
| `DELETE /threads/:id/run` | SIGTERM the active run -> `202`; `404` when none |
| `PATCH /threads/:id` | `{ status: 'archived' \| 'idle' }`; `409` while running |
| `DELETE /threads/:id/worktree?force=1` | remove the thread's worktree -> `200 { thread, branchKept }`; `404` without worktree, `409` while running or `worktree-dirty` (unless `force=1`) |
| `DELETE /threads/:id?force=1` | permanent delete with its messages and its worktree; `409` while running or `worktree-dirty` (unless `force=1`) |
| `POST /terminals` | `{ repo, cols, rows }` or `{ thread, cols, rows }` (the shell opens in the thread's worktree or checkout; unknown thread `404`) (cols 1-500, rows 1-200) -> `201 { terminal: { id, repo, cwd } }`; `409` when 4 are open |
| `GET /terminals/:id/events` | SSE: `data` events (pty bytes in base64), then `exit` (`{ code, signal }`) and the stream ends |
| `POST /terminals/:id/input` | `{ data }` (at most 64 KiB) -> `204` |
| `POST /terminals/:id/resize` | `{ cols, rows }` -> `204` |
| `DELETE /terminals/:id` | kill the shell -> `204` |

Errors: `400` invalid input, `401` bad token, `403` Host/Origin, `404` unknown repo/skill/thread, `409` thread
running, checkout or worktree busy, or `--max-runs` reached; `409 { "error": "worktree-dirty", "detail" }` uncommitted changes in a worktree to remove (retry with `?force=1`); `413` body too large; `502 { "error": "git-failed", "detail" }` a git command failed; `force` accepts only `1` (anything else is a `400`); `503 { "error": "terminal-unavailable", "detail" }` console disabled or node-pty missing. The board exposes the same routes (and only those, with their
methods) under `/api/factory/*`; when the agents server or its token file is missing, the relay answers
`503 { "error": "agents-unavailable", "detail": ... }`.

The earlier `/runs` API (`POST /runs`, `GET /runs/:id/events`, `DELETE /runs/:id`) was removed: threads
replace it, and its routes now answer `404`.

## Known limitations

- **Windows `.cmd` shims.** `claude` or `copilot` installed as a `.cmd` shim are detected, but Node cannot
  spawn them without a shell; the run then fails with an explicit message.
- **Shutdown.** SIGINT/SIGTERM stops the server (and removes the token file) and kills open console shells,
  but does not cancel active agent runs.
- **One active run per checkout or worktree, at most `--max-runs` at once, no queue.** A second request on a
  busy checkout or worktree, or one beyond the ceiling, is refused with `409`.

## Not in this version

Run queues, Copilot resume, full-text search, export, chained workflows, remote execution.
