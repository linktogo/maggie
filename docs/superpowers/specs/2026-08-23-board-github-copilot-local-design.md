# Local GitHub Copilot CLI sessions on the board — Design

**Date:** 2026-08-23
**Status:** Implemented

## Purpose

The board only ever knew one local agent. Every piece of session tracking —
which settings file hooks live in, which lifecycle events map to which kanban
state, how a payload is shaped, where token usage comes from, how a message
typed on the dashboard gets back into a running session — was written against
Claude Code and hardcoded to it.

GitHub Copilot CLI is the same kind of tool: a terminal agent, running locally
in a checkout, with its own lifecycle hooks. This feature makes the board track
Copilot sessions the same way it tracks Claude Code ones, side by side on one
`board.json`.

Scope is the **local CLI**, not the VS Code Copilot extension and not the cloud
agent: the board's whole model is "a session running in a checkout on this
machine", and only the CLI fits it.

## Decisions

- **`--agent <claude|copilot>` selects the hook flavour; `--editor` keeps its
  own job.** `--editor` has always been "which launch command do I print", and
  conflating the two would have made `--editor vscode` ambiguous. `--editor`
  now defaults to `--agent`, so `--agent copilot` alone does the obvious thing,
  and passing both still works when they should differ.
- **Copilot hooks go in `.github/copilot/settings.local.json`.** Copilot loads
  hooks from several places; this one is the exact twin of
  `.claude/settings.local.json` — user-specific, gitignored, merged from an
  inline `hooks` block. Wiring a developer's local board state into the
  committed `.github/hooks/*.json` would push machine-specific paths into the
  repo for everyone.
- **camelCase event names, camelCase payloads.** Copilot accepts PascalCase
  aliases that produce Claude-compatible snake_case payloads, which is tempting
  as a shortcut. The native camelCase names are used instead, and the CLI
  normalizes both key styles on the way in, so neither agent's format is the
  "real" one.

### Event mapping

| Board action | Claude Code | Copilot CLI |
|---|---|---|
| `inprogress` | `UserPromptSubmit` | `userPromptSubmitted` |
| `question` (blocked on a human) | `Notification` (`permission_prompt`, `idle_prompt`) | `notification` (`permission_prompt`, `elicitation_dialog`, `agent_idle`) |
| `question` (turn ended) | `Stop` | `agentStop` |
| close the session | `SessionEnd` | `sessionEnd` |
| deliver queued messages | `UserPromptSubmit` | `sessionStart`, `notification` |

- **Message delivery had to move.** Under Claude Code the `UserPromptSubmit`
  hook prints queued messages to stdout and they land in the conversation.
  Copilot **drops the output of a `userPromptSubmitted` command hook**, so that
  path does not exist. It does honour an `{"additionalContext": "…"}` reply on
  `sessionStart` and on `notification`, injected as a prepended user message —
  so the queue drains there instead. The side effect is an improvement: a
  message sent while the agent sits idle or on a permission prompt reaches it on
  that notification, rather than waiting for the next prompt.
- **A `messages` subcommand rather than a status write on `sessionStart`.** A
  session that has just started is not `inprogress`, and inventing a state for
  it would put a misleading card on the board. `messages` drains the queue and
  writes nothing else.
- **stdout is a contract under Copilot, not free text.** Copilot parses a
  hook's stdout as JSON, so the human-readable `repo [session] → state` line
  moves to stderr for `--agent copilot`, and stdout carries either one JSON
  object or nothing. Under Claude Code stdout stays what it was.
- **Token usage from `events.jsonl`.** Copilot's `agentStop` hands over a
  `transcriptPath` pointing at its session event stream
  (`~/.copilot/session-state/<id>/events.jsonl`). Two shapes there carry usage:
  per-turn events with `data.usage` and a model, and cumulative `modelMetrics`
  on `session.shutdown`. The reader accumulates the first and lets the second
  replace what was accumulated, since it is authoritative. Copilot's
  `cacheReadTokens`/`cacheWriteTokens` map onto the board's
  `cacheReadInputTokens`/`cacheCreationInputTokens`, so `board.json` keeps one
  usage shape and the existing cards and charts need no per-agent branch.
- **Sessions record their agent, once.** `board.json` sessions and
  `history.jsonl` entries carry `agent`; a session row shows it as a badge.
  `null` on entries written before this feature, rendered as `claude` — which is
  what they were.
- **Hook reconciliation detects, it is not configured.** The board server has no
  agent flag and `repos.json` gains no field. On start, each checkout is
  reconciled for whichever agents' settings files are present, falling back to
  Claude Code when it has neither — so a repo bootstrapped for Copilot is not
  silently re-wired for Claude Code.

## Shape

`libs/workspace-bootstrap/src/agents.js` is the registry the rest of the code
reads: per agent, where the settings file lives, how to build a hook block, how
to read one back for drift detection, and how to install it. `bootstrap.js`,
`reconcile.js` and the CLI dispatch through it rather than branching on the
agent name, so a third local agent is a registry entry plus a hooks module.
