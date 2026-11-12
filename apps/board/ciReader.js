import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defaultExec } from '@linktogo/maggie-git';
import { parseUpdate, buildState, normalizeState } from '@linktogo/maggie-ci-status';

const EMPTY = { version: 1, lastSyncAt: null, lastSyncError: null, repos: {} };

export function createCiReader({
  statusRepo = null,
  token = null,
  branch = 'ci-status',
  stateFile,
  cacheDir,
  exec = defaultExec,
  now = () => new Date().toISOString(),
  logger = console,
  readdirImpl = readdir,
  env: baseEnv = process.env,
} = {}) {
  let running = false;

  function redact(message) {
    return token ? String(message).split(token).join('***') : String(message);
  }

  // The token reaches git as an `http.<origin>.extraheader` handed over through
  // GIT_CONFIG_* environment variables, never as part of the clone URL: a URL
  // credential is persisted in plain text as the checkout's `remote.origin.url`
  // and shows up in `ps` and in git's own error messages. Scoping the header
  // to the status repo's origin keeps it from following a redirect elsewhere.
  function gitOptions(options = {}) {
    const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
    if (token) {
      let key = 'http.extraheader';
      try {
        key = `http.${new URL(statusRepo).origin}/.extraheader`;
      } catch {
        // Not an absolute URL (an scp-style remote, say): apply to every host.
      }
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      // Appended after any GIT_CONFIG_* entries the environment already carries.
      const index = Number(baseEnv.GIT_CONFIG_COUNT) || 0;
      env.GIT_CONFIG_COUNT = String(index + 1);
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${basic}`;
    }
    return { ...options, env };
  }

  async function syncCheckout() {
    if (!existsSync(path.join(cacheDir, '.git'))) {
      await mkdir(path.dirname(cacheDir), { recursive: true });
      await exec('git', ['clone', '--depth', '1', '--branch', branch, '--single-branch', '--', statusRepo, cacheDir], gitOptions());
      return;
    }
    await exec('git', ['fetch', '--depth', '1', 'origin', branch], gitOptions({ cwd: cacheDir }));
    await exec('git', ['reset', '--hard', `origin/${branch}`], { cwd: cacheDir });
  }

  function isMissingEntry(err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
  }

  async function readEntries() {
    const root = path.join(cacheDir, 'updates');
    const logins = await readdirImpl(root).catch((err) => {
      if (isMissingEntry(err)) return [];
      throw err;
    });
    const entries = [];
    for (const login of logins) {
      const files = await readdirImpl(path.join(root, login)).catch((err) => {
        if (isMissingEntry(err)) return [];
        throw err;
      });
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const repo = file.slice(0, -'.json'.length);
        const raw = await readFile(path.join(root, login, file), 'utf8');
        const parsed = parseUpdate(raw, { login, repo });
        if (!parsed.ok) {
          logger.warn(`  ⚠ ci: skipping updates/${login}/${file}: ${parsed.reason}`);
          continue;
        }
        entries.push({ login, repo, update: parsed.update });
      }
    }
    return entries;
  }

  async function readState() {
    try {
      return JSON.parse(await readFile(stateFile, 'utf8'));
    } catch {
      return EMPTY;
    }
  }

  async function writeState(state) {
    const tmp = `${stateFile}.tmp`;
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, stateFile);
  }

  async function tick() {
    if (!statusRepo || running) return;
    running = true;
    try {
      await syncCheckout();
      const { repos } = buildState(await readEntries(), now());
      await writeState({ version: 1, lastSyncAt: now(), lastSyncError: null, repos });
    } catch (err) {
      logger.warn(`  ⚠ ci: sync failed: ${redact(err.message)}`);
      try {
        const previous = await readState();
        await writeState({ ...previous, lastSyncError: redact(err.message) });
      } catch (writeErr) {
        logger.warn(`  ⚠ ci: failed to record sync error: ${redact(writeErr.message)}`);
      }
    } finally {
      running = false;
    }
  }

  async function read(names = null) {
    const generatedAt = now();
    if (!statusRepo) {
      const repos = Object.fromEntries(
        (names ?? []).map((n) => [n, { users: {}, unavailable: 'status repo not configured' }]),
      );
      return { generatedAt, lastSyncError: null, repos };
    }
    const state = await readState();
    const wanted = names ?? Object.keys(state.repos ?? {});
    const repos = {};
    for (const name of wanted) {
      const users = state.repos?.[name]?.users ?? {};
      repos[name] = {
        users: Object.fromEntries(
          Object.entries(users).map(([login, run]) => [
            login,
            { state: normalizeState(run.status, run.conclusion), run },
          ]),
        ),
      };
    }
    return { generatedAt, lastSyncError: state.lastSyncError ?? null, repos };
  }

  return { tick, read };
}
