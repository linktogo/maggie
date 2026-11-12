// SQLite-backed store of agent threads and their messages (node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { AgentError } from './errors.js';

const MAX_STEP_INPUT_CHARS = 4096;
const DEFAULT_PAGE = 50;

const THREAD_ID = /^th_[0-9a-f]{16}$/;

export const MIGRATIONS = [
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    skill TEXT,
    title TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_thread ON messages(thread_id, id);
  CREATE INDEX threads_repo ON threads(repo, updated_at DESC);`,
  `ALTER TABLE threads ADD COLUMN worktree_path TEXT;
  ALTER TABLE threads ADD COLUMN worktree_branch TEXT;
  ALTER TABLE threads ADD COLUMN worktree_base TEXT;`,
];

const toWorktree = (row) => (row.worktree_path === null
  ? null
  : { path: row.worktree_path, branch: row.worktree_branch, base: row.worktree_base });

const toThread = (row) => ({
  id: row.id, repo: row.repo, provider: row.provider, model: row.model, skill: row.skill, title: row.title,
  sessionId: row.session_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  worktree: toWorktree(row),
});

const toMessage = (row) => ({
  id: row.id, threadId: row.thread_id, role: row.role, kind: row.kind, content: JSON.parse(row.content),
  runId: row.run_id, createdAt: row.created_at,
});

const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

/** Cap a step's `input` so its JSON stays within MAX_STEP_INPUT_CHARS. */
function capStepInput(content) {
  if (content?.input === undefined) return content;
  const json = JSON.stringify(content.input);
  if (json.length <= MAX_STEP_INPUT_CHARS) return content;
  return { ...content, input: { truncated: true, preview: json.slice(0, MAX_STEP_INPUT_CHARS) } };
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[version]);
    db.exec(`PRAGMA user_version = ${version + 1}`);
    db.exec('COMMIT');
  }
}

/** Open (and migrate) a thread store; `path` defaults to an in-memory database. */
export function createThreadStore({ path = ':memory:', now = () => new Date(), randomId = () => randomBytes(8).toString('hex') } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);

  const stamp = () => now().toISOString();
  const insertThread = db.prepare(`INSERT INTO threads (id, repo, provider, model, skill, title, session_id, status, created_at, updated_at,
    worktree_path, worktree_branch, worktree_base) VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', ?, ?, ?, ?, ?)`);
  // A Claude session belongs to its working directory: once the worktree is gone the
  // session cannot be resumed anywhere else, so it is forgotten with the worktree.
  const clearWorktree = db.prepare(`UPDATE threads SET worktree_path = NULL, worktree_branch = NULL, worktree_base = NULL,
    session_id = NULL WHERE id = ?`);
  const selectWorktrees = db.prepare('SELECT * FROM threads WHERE worktree_path IS NOT NULL ORDER BY rowid');
  const selectThread = db.prepare('SELECT * FROM threads WHERE id = ?');
  const patchThread = db.prepare('UPDATE threads SET status = COALESCE(?, status), session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?');
  const removeThread = db.prepare('DELETE FROM threads WHERE id = ?');
  const insertMessage = db.prepare('INSERT INTO messages (thread_id, role, kind, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const selectMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
  const selectMessages = db.prepare('SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id');
  const selectStats = db.prepare(`SELECT repo, COUNT(*) AS threads, SUM(status = 'running') AS running, MAX(updated_at) AS lastActivity
    FROM threads WHERE status != 'archived' GROUP BY repo ORDER BY repo`);
  const selectRunning = db.prepare(`SELECT id, session_id,
    EXISTS (SELECT 1 FROM messages WHERE thread_id = threads.id AND role = 'agent') AS answered
    FROM threads WHERE status = 'running'`);

  const getThread = (id) => {
    const row = selectThread.get(id);
    return row ? toThread(row) : null;
  };

  const newThreadId = () => `th_${randomId()}`;

  const updateThread = (id, { status, sessionId, worktree } = {}) => {
    if (worktree === null) clearWorktree.run(id);
    patchThread.run(status ?? null, sessionId ?? null, stamp(), id);
    return getThread(id);
  };

  const addMessage = (threadId, { role, kind, content, runId = null }) => {
    const stored = kind === 'step' ? capStepInput(content) : content;
    const { lastInsertRowid } = insertMessage.run(threadId, role, kind, JSON.stringify(stored), runId, stamp());
    return toMessage(selectMessage.get(lastInsertRowid));
  };

  return {
    newThreadId,

    createThread({ id, repo, provider, model = null, skill = null, title, worktree = null }) {
      if (id === undefined) id = newThreadId();
      else if (!THREAD_ID.test(id)) throw new AgentError('invalid', 'invalid thread id');
      const at = stamp();
      insertThread.run(id, repo, provider, model, skill, title, at, at, worktree?.path ?? null, worktree?.branch ?? null, worktree?.base ?? null);
      return getThread(id);
    },

    listWorktrees() {
      return selectWorktrees.all().map((row) => ({ id: row.id, repo: row.repo, worktree: toWorktree(row) }));
    },

    getThread,
    updateThread,

    deleteThread(id) {
      removeThread.run(id);
    },

    listThreads({ repo, status, q, before, limit = DEFAULT_PAGE } = {}) {
      const where = [];
      const params = [];
      if (status === 'archived') where.push("status = 'archived'");
      else where.push("status != 'archived'");
      if (status && status !== 'archived') { where.push('status = ?'); params.push(status); }
      if (repo) { where.push('repo = ?'); params.push(repo); }
      if (before) { where.push('updated_at < ?'); params.push(before); }
      if (q) {
        const like = `%${escapeLike(q)}%`;
        where.push(`(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.kind = 'text' AND m.content LIKE ? ESCAPE '\\'))`);
        params.push(like, like);
      }
      const sql = `SELECT * FROM threads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, rowid DESC LIMIT ?`;
      return db.prepare(sql).all(...params, limit).map(toThread);
    },

    projectStats() {
      return selectStats.all().map((row) => ({ ...row }));
    },

    addMessage,

    listMessages(threadId, { after = 0 } = {}) {
      return selectMessages.all(threadId, after).map(toMessage);
    },

    recoverInterrupted() {
      const rows = selectRunning.all();
      for (const row of rows) {
        updateThread(row.id, { status: row.session_id || row.answered ? 'idle' : 'failed' });
        addMessage(row.id, { role: 'system', kind: 'status', content: { outcome: 'interrupted', error: 'interrupted by a restart' } });
      }
      return rows.length;
    },

    close() {
      db.close();
    },
  };
}
