// Regenerates every screenshot under docs/images.
//
//   NODE_PATH="$(npm root -g)" node docs/screenshots/capture.mjs
//
// Requires the board to be built (`npm run board:build`) and Playwright with a
// Chromium available (`npm i -g playwright && playwright install chromium`).
//
// Each scene below owns the demo data of the image it writes: the board is
// served from apps/board/dist with a stub API, so /api/board, /api/config,
// /api/ci and /api/history return exactly that data and nothing depends on a
// real workspace. Relative timestamps ("45 min ago") are derived from the run
// time, so re-running reproduces the same captions.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'apps/board/dist');
const OUT = path.join(ROOT, 'docs/images');
const PORT = 5177;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const MIN = 60_000, H = 3_600_000;

const usage = (i, o, cw, cr) => ({
  inputTokens: i, outputTokens: o, cacheCreationInputTokens: cw, cacheReadInputTokens: cr,
});
const session = (sessionId, o) => [sessionId, { sessionId, pendingMessages: [], events: [], ...o }];

// ─── demo data ────────────────────────────────────────────────────────────────

// board-{en,fr,de,es}: three repos, one idle, from the i18n docs.
const localesBoard = {
  version: 2,
  repos: {
    'oc-idle': { sessions: {} },
    'oc-be': {
      sessions: Object.fromEntries([session('s-be', {
        // One Copilot session so the board shot shows both agent badges.
        status: 'inprogress', agent: 'copilot', title: 'add tests', lastEvent: 'UserPromptSubmit',
        updatedAt: ago(4 * H), startedAt: ago(5 * H),
        lastPrompt: 'add coverage for the parser',
      })]),
    },
    'oc-auth': {
      sessions: Object.fromEntries([session('s-auth', {
        status: 'question', title: 'fix login redirect', lastEvent: 'Stop',
        updatedAt: ago(4 * H), startedAt: ago(5 * H),
        lastPrompt: 'fix the auth redirect loop on logout',
        usage: usage(4000, 2000, 1000, 4300),
        events: [{ event: 'Stop', at: ago(4 * H) }],
      })]),
    },
  },
};

// send-message-*: the messaging docs, with repo metadata in the side panel.
const messaging = {
  version: 2,
  repos: {
    'example-web': {
      sessions: Object.fromEntries([session('s-web', {
        status: 'inprogress', title: 'Add a dark-mode toggle to the header navigation',
        lastEvent: 'UserPromptSubmit', updatedAt: ago(1 * H), startedAt: ago(2 * H),
        lastPrompt: 'Add a persisted dark-mode toggle in the top navigation bar.',
        worktree: 'feat/dark-mode', usage: usage(9000, 2900, 6000, 20000),
      })]),
    },
    'example-api': {
      sessions: Object.fromEntries([session('s-api', {
        status: 'question', title: 'Fix the login redirect loop on logout',
        lastEvent: 'Stop', updatedAt: ago(1 * H), startedAt: ago(3 * H),
        lastPrompt: 'The logout flow redirects back to /login in an infinite loop. Track down the cause and fix it.',
        worktree: 'fix/login-loop', usage: usage(14300, 4000, 6000, 40000),
        events: [{ event: 'Stop', at: ago(1 * H) }],
      })]),
    },
    'example-local-checkout': {
      sessions: Object.fromEntries([session('s-checkout', {
        status: 'question', title: 'Migrate the settings page to the composition API',
        lastEvent: 'Notification', updatedAt: ago(1 * H), startedAt: ago(2 * H),
        lastPrompt: 'Convert SettingsPage.vue from the options API to <script setup>.',
        usage: usage(4900, 2000, 3000, 13000),
        pendingMessages: [{ text: 'Use pinia for the store, not vuex.', at: ago(1 * H) }],
        events: [{ event: 'Notification', at: ago(1 * H) }, { event: 'UserPromptSubmit', at: ago(1 * H) }],
      })]),
    },
  },
};

const messagingConfig = {
  repos: {
    'example-web': { url: 'https://github.com/example-org/example-web.git', technologies: ['vuejs', 'claude', 'windsurf'] },
    'example-api': { url: 'https://github.com/example-org/example-api.git', technologies: ['nodejs', 'claude'] },
    'example-local-checkout': { url: 'https://github.com/example-org/example-local-checkout.git', technologies: ['vuejs', 'claude', 'windsurf'] },
  },
};

const messagingCi = {
  generatedAt: new Date(now).toISOString(),
  repos: Object.fromEntries(Object.keys(messagingConfig.repos)
    .map((n) => [n, { users: {}, unavailable: 'status repo not configured' }])),
};

// worktree-badge/*: the worktree docs.
const worktree = {
  version: 2,
  repos: {
    'cli-tools': { sessions: {} },
    'example-api': {
      sessions: Object.fromEntries([
        session('s-api-1', {
          status: 'inprogress', title: 'Add login redirect handling',
          lastEvent: 'UserPromptSubmit', updatedAt: ago(45 * MIN), startedAt: ago(2 * H),
          lastPrompt: 'Fix the login redirect so returning users land back on the page they came from.',
          worktree: 'feat/login-redirect', usage: usage(35100, 8000, 42000, 200000),
        }),
        session('s-api-2', {
          status: 'question', title: 'Bump dependencies',
          lastEvent: 'Stop', updatedAt: ago(39 * MIN), startedAt: ago(1 * H),
          lastPrompt: 'Update all minor and patch dependencies and run the test suite.',
          usage: usage(9000, 3000, 7000, 60000),
        }),
      ]),
    },
    'web-dashboard': {
      sessions: Object.fromEntries([session('s-dash', {
        status: 'inprogress', title: 'Dark mode toggle',
        lastEvent: 'UserPromptSubmit', updatedAt: ago(42 * MIN), startedAt: ago(2 * H),
        lastPrompt: 'Add a persisted dark mode toggle to the settings page.',
        worktree: 'feat/dark-mode', usage: usage(20000, 5000, 20000, 120000),
      })]),
    },
  },
};

const history = [
  {
    repo: 'oc-auth', sessionId: 's-auth', title: 'add tests',
    startedAt: '2026-08-17T09:00:00.000Z', endedAt: '2026-08-17T09:25:00.000Z',
    usage: usage(4000, 2000, 1000, 20000),
  },
  {
    repo: 'oc-be', sessionId: 's-be', title: 'fix login',
    startedAt: '2026-08-16T09:00:00.000Z', endedAt: '2026-08-16T09:10:00.000Z',
    usage: usage(12000, 5000, 3000, 90000),
  },
];

const EMPTY_CI = { generatedAt: new Date(now).toISOString(), repos: {} };

// ─── stub server ──────────────────────────────────────────────────────────────

let api = { board: { version: 2, repos: {} }, config: { repos: {} }, ci: EMPTY_CI, history: [] };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/board') return json(api.board);
  if (url.pathname === '/api/config') return json(api.config);
  if (url.pathname === '/api/ci') return json(api.ci);
  if (url.pathname === '/api/history') return json(api.history);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  try {
    const data = await readFile(path.join(DIST, rel));
    res.writeHead(200, { 'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(path.join(DIST, 'index.html')));
  }
});
await new Promise((r) => server.listen(PORT, r));

// ─── scenes ───────────────────────────────────────────────────────────────────

const scenes = [
  ...['en', 'fr', 'de', 'es'].map((locale) => ({
    out: `board/board-${locale}.png`, locale, width: 1240, height: 430,
    api: { board: localesBoard, config: { repos: {} }, ci: EMPTY_CI, history: [] },
    target: 'main',
  })),
  {
    out: 'board/history-es.png', locale: 'es', width: 1240, height: 730, route: '/history',
    api: { board: localesBoard, config: { repos: {} }, ci: EMPTY_CI, history },
    target: 'main',
  },
  {
    out: 'board/send-message-board.png', locale: 'en', width: 1320, height: 860,
    api: { board: messaging, config: messagingConfig, ci: messagingCi, history: [] },
    target: 'main',
  },
  {
    out: 'board/send-message-card.png', locale: 'en', width: 1320, height: 860,
    api: { board: messaging, config: messagingConfig, ci: messagingCi, history: [] },
    async prep(page) {
      await page.locator('[data-test="message-input"]').nth(1)
        .fill('Use the shared AuthGuard, and add a regression test.');
    },
    target: (page) => page.locator('section.min-w-0').nth(2),
  },
  {
    out: 'board/send-message-detail.png', locale: 'en', width: 1320, height: 860,
    api: { board: messaging, config: messagingConfig, ci: messagingCi, history: [] },
    async prep(page) {
      await page.locator('[data-test="message-input"]').nth(1).fill('Use the shared AuthGuard, an');
      await page.locator('[data-test="session-row"]').nth(2).click();
      await page.locator('[data-test="detail-message-input"]').first()
        .fill('Keep the URL query params in sync with the store.');
    },
    target: 'main',
    fullPage: true,
  },
  {
    out: 'worktree-badge/board.png', locale: 'en', width: 1360, height: 840,
    api: { board: worktree, config: { repos: {} }, ci: EMPTY_CI, history: [] },
    target: 'main',
  },
  {
    out: 'worktree-badge/card.png', locale: 'en', width: 1360, height: 840,
    api: { board: worktree, config: { repos: {} }, ci: EMPTY_CI, history: [] },
    target: (page) => page.locator('[data-test="column-body"]').nth(1).locator('> div').first(),
  },
];

const browser = await chromium.launch();

for (const scene of scenes) {
  api = scene.api;
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((locale) => {
    localStorage.setItem('maggie:locale', locale);
    localStorage.setItem('maggie:sound', '0');
    // Headless Chromium reports notifications as denied, which swaps the
    // "enable" button for a "blocked" notice. The docs show the default state.
    if (globalThis.Notification) {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    }
  }, scene.locale);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${scene.route ?? '/'}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (scene.prep) await scene.prep(page);
  await page.waitForTimeout(300);

  const file = path.join(OUT, scene.out);
  if (scene.fullPage) {
    await page.screenshot({ path: file, fullPage: true });
  } else {
    const locator = typeof scene.target === 'function'
      ? scene.target(page)
      : page.locator(scene.target).first();
    await locator.screenshot({ path: file });
  }
  console.log('wrote', scene.out);
  await context.close();
}

await browser.close();
server.close();
