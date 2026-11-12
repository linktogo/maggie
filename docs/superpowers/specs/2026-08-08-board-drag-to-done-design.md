# Board Drag-to-Done — Design

**Date:** 2026-08-08
**Status:** Approved (pending written-spec review)

## Purpose

A session only ever leaves the board via the `SessionEnd` hook. That hook
does not fire on a hard kill or crash — a documented, accepted gap (see
`2026-08-05-board-multi-session-cards-design.md`,
`2026-08-07-board-token-usage-design.md`). When it doesn't fire, a stale
card sits on the board indefinitely with no way to clear it, even though the
user can see from their own terminal that the session is over.

This adds a manual escape hatch: dragging a session's card onto the **Done**
column closes it exactly as `SessionEnd` would — removed from `board.json`,
appended to `history.jsonl` — without depending on a hook that may never
fire for that session.

Note: `done` is listed in `STATES` (`board.js`) but no hook has ever set it
in practice (`Stop` maps to `question`, not `done` — the original plan of
Claude self-reporting completion into a deposited command was never built).
This feature does not resurrect `done` as a status a session parks in; the
Done column stays a drop target only, and a closed session disappears from
the board the same way a normal completion does today.

## Decisions (locked during brainstorming)

- **Granularity: per session, not per repo card.** A repo card can list
  several sessions across different columns (multi-session cards). The drag
  source is an individual `SessionRow`, and only that session is closed.
- **Confirm before closing.** A native `window.confirm()` — the app has no
  modal component today and this is a low-frequency, easily-cancelled
  action; a custom modal isn't justified.
- **Closing removes the card; it does not settle into Done.** Matches
  today's semantics of a completed session (gone from the board, recorded in
  history) rather than introducing a new "sits in Done" state. The row
  vanishing right after the confirm is the feedback — no extra toast.
- **Reappearance after close is accepted.** If a hook still fires for that
  `sessionId` afterward (the process wasn't actually dead), the card
  reappears on the next poll. This is a manual point-in-time override, not a
  permanent block on that session ID — consistent with the board already
  being a live reflection of the latest hook events, not a ledger.
- **No shared helper with the hook's `runSessionEnd`.** Both close a
  session, but `runSessionEnd` has a deliberate resilience guarantee (a
  history-write failure must never block removing the card — see its
  comment in `apps/workspace/src/main.js`) and a transcript-based usage
  source the board server doesn't have. Forcing them through one function
  would either weaken that guarantee or add a branch to route around it. The
  new `closeSession` helper is a separate, smaller function; the ~8 lines of
  overlap (append history, delete session, write board) aren't enough
  duplication to justify coupling two call sites with different failure
  semantics.
- **Action-style endpoint (`POST /api/sessions/close` with a JSON body),
  not a RESTful path.** Keeps the server's existing flat `pathname`
  dispatch (no path-templating/decoding needed) and mirrors the CLI's own
  action-style verb (`ai-workspace status <repo> <state>`).

## Architecture overview

```text
SessionRow.vue (draggable)
  │ dragstart → dataTransfer = { repo, sessionId }
  ▼
Column.vue (status === 'done' only: dragover/drop target)
  │ drop → emit('close-session', { repo, sessionId })
  ▼
App.vue
  │ window.confirm(...)
  │ fetchImpl('/api/sessions/close', POST, {repo, sessionId})
  ▼
server.js → closeSession(boardPath, repo, sessionId)      (new, board.js)
  │  read board → find session
  │  ├─ not found → { closed: false }                      (404 to client)
  │  └─ found:
  │      appendHistoryEntry(history.jsonl, {repo, sessionId,
  │        title, startedAt, endedAt: now, usage: session.usage})
  │      delete session from board, write board
  │      → { closed: true }                                 (200 to client)
  ▼
App.vue: refresh() (existing useBoard refresh) → card disappears
```

## Section 1 — `closeSession` (`libs/workspace-bootstrap/src/board.js`)

```js
import { resolveHistoryPath, appendHistoryEntry } from './tokens.js';

export async function closeSession(boardPath, repo, sessionId, opts = {}) {
  const {
    historyPath = resolveHistoryPath(boardPath),
    now = () => new Date().toISOString(),
    ...io
  } = opts;
  const board = await readBoard(boardPath, io);
  const session = board.repos[repo]?.sessions?.[sessionId];
  if (!session) return { closed: false };
  await appendHistoryEntry(historyPath, {
    repo, sessionId,
    title: session.title ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: now(),
    usage: session.usage ?? null,
  }, io);
  delete board.repos[repo].sessions[sessionId];
  await writeBoard(boardPath, board, io);
  return { closed: true };
}
```

- No transcript to read from the UI path, so `usage` is always whatever the
  board already has (last computed on the session's most recent `Stop`).
- A missing session (already closed by the real `SessionEnd`, or a stale
  drag target) is not an error — it's reported back as `{ closed: false }`
  and the caller treats it as a no-op.
- Exported alongside the existing `board.js` functions from
  `libs/workspace-bootstrap/src/index.js`.

## Section 2 — Board server (`apps/board/server.js`)

```js
async function readJSONBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveCloseSession(boardPath, req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const { repo, sessionId } = body ?? {};
  if (!repo || !sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'repo and sessionId are required' }));
    return;
  }
  const result = await closeSession(boardPath, repo, sessionId);
  res.writeHead(result.closed ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
```

`createBoardServer`'s request handler routes
`POST /api/sessions/close` to it, checking `req.method === 'POST'`
alongside the existing `url.pathname` checks.

## Section 3 — Frontend (`apps/board/src`)

- **`SessionRow.vue`**: new `repoName` prop (passed from `Card.vue`, which
  already knows its own `name`). Root element gets `draggable="true"` and
  `@dragstart`:

  ```js
  function onDragStart(e) {
    e.dataTransfer.setData('application/json', JSON.stringify({
      repo: props.repoName, sessionId: props.session.sessionId,
    }));
    e.dataTransfer.effectAllowed = 'move';
  }
  ```

  Cursor styling (`cursor-grab` / `active:cursor-grabbing`) signals the row
  is draggable.
- **`Card.vue`**: passes `:repo-name="name"` to each `SessionRow`.
- **`Column.vue`**: only when `props.status === 'done'`, the body wrapper
  gets `@dragover.prevent="dragOver = true"`, `@dragleave="dragOver = false"`,
  and `@drop="onDrop"`; a `dragOver` ref toggles a highlight ring
  (`ring-2 ring-emerald-400`) for drop-target feedback. `onDrop` parses the
  `dataTransfer` payload and emits `close-session`. Other columns render as
  today, with no drag listeners attached.
- **`App.vue`**: handles `@close-session="onCloseSession"` from the Done
  column:

  ```js
  async function onCloseSession({ repo, sessionId }) {
    const label = repos.value[repo]?.sessions?.[sessionId]?.title ?? sessionId;
    if (!window.confirm(`Marquer la session « ${label} » de ${repo} comme terminée ?`)) return;
    await fetchImpl('/api/sessions/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, sessionId }),
    });
    await refresh();
  }
  ```

  `refresh` is destructured from the existing `useBoard(...)` return value
  (already exposed, just not currently used by `App.vue`).

## Section 4 — Testing

Coverage gate is 100% (`CONTRIBUTING.md`); every new branch needs a test.

- **`libs/workspace-bootstrap/test/board.test.js`**: `closeSession` appends
  a history entry and removes the session when found; returns
  `{closed:false}` and touches neither file when the repo/session doesn't
  exist; falls back to `null` usage when the session has none yet.
- **`apps/board/server.test.js`**: `POST /api/sessions/close` closes an
  existing session (200, board updated, history line appended); returns 404
  for an unknown repo/session without modifying either file; returns 400 for
  a missing `repo`/`sessionId` or unparsable body.
- **`apps/board/src/SessionRow.test.js`**: dragstart sets the
  `application/json` payload to `{repo, sessionId}` for the row's own
  session.
- **`apps/board/src/Column.test.js`** (new): for the `done` column, a
  `drop` with a valid payload emits `close-session` with `{repo,
  sessionId}` and clears the hover-highlight state; `dragover` sets the
  highlight state. For a non-`done` column, no drag listeners fire (`drop`
  emits nothing).
- **`apps/board/src/App.test.js`**: a `close-session` event, once
  confirmed (mock `window.confirm` → `true`), POSTs to
  `/api/sessions/close` with the right body and triggers a board refresh;
  declining the confirm makes no request.

## Out of scope (YAGNI)

- Dragging between any other pair of columns — only "→ Done" is requested.
- Reordering cards within a column.
- Blocking a `sessionId` from ever reappearing after a manual close — an
  accepted, explicit trade-off (see Decisions).
- Touch/mobile drag support — native HTML5 drag-and-drop is desktop-mouse
  only; out of scope like the rest of the board's desktop-first layout.
- A custom confirm modal, undo, or toast feedback beyond the row
  disappearing.
