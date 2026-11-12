# @linktogo/maggie-workspace-bootstrap

Backs the `maggie-workspace` CLI from
[maggie](https://github.com/linktogo/maggie): clones the configured
repositories into a workspace, installs their dependencies cache-first, wires
status hooks for a local coding agent — Claude Code or GitHub Copilot CLI —
into each checkout, and maintains the shared `board.json` kanban state.

```js
import { setSessionStatus } from '@linktogo/maggie-workspace-bootstrap';

await setSessionStatus('/ws/.maggie/board.json', 'example-api', 'sess-1', 'done');
```

Board states are `todo`, `inprogress`, `question`, and `done`. Each repo tracks
one entry per agent session (keyed by the session id the hook payload carries);
writes are atomic and keep a bounded per-session event history. Every session
records the `agent` that produced it, set once.

`agents.js` is the registry the rest of the library reads: where each agent's
settings file lives (`.claude/settings.local.json`,
`.github/copilot/settings.local.json`), how to build its hook block, and how to
read one back for drift detection.

Each session also tracks `startedAt` (set once) and `usage` — an
`{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }`
object recomputed from the session's transcript on every end-of-turn event
(`Stop` / `agentStop`), kept `null` until the first one. `tokens.js` holds both
readers — Claude Code's transcript JSONL and Copilot's
`session-state/<id>/events.jsonl` event stream, whose per-model
`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` are mapped onto
the same four counters — plus the `history.jsonl` helpers.
