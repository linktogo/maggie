import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MODEL,
  DEFAULT_OUT,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORKSPACE,
  PROVIDERS,
  planBatches,
} from '@linktogo/maggie-retro-doc';
import { formatDryRun, main, parseArgs } from './retro-doc.js';

function makeRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'retro-doc-cli-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) };
}

const SPEC = '# Design — Sync\n\nWe chose a renderer registry because each platform is a pure module.\n';
const PLAN = '# Sync Implementation Plan\n\n- [ ] Write the renderer registry.\n';

test('parseArgs leaves the repository and the provider unset, so a terminal can be asked', () => {
  const options = parseArgs([]);
  assert.equal(options.repo, null);
  assert.equal(options.provider, null);
  assert.equal(options.model, null);
  assert.equal(options.out, DEFAULT_OUT);
  assert.equal(options.workspace, DEFAULT_WORKSPACE);
  assert.equal(options.timeout, DEFAULT_TIMEOUT_SECONDS);
  assert.deepEqual(options.include, []);
  assert.equal(options.dryRun, false);
});

test('parseArgs reads every flag, and --include repeats', () => {
  const options = parseArgs([
    '--repo', '/tmp/x',
    '--workspace', 'checkouts',
    '--provider', 'copilot',
    '--provider-command', 'copilot --allow-all-tools',
    '--out', 'docs/out.md',
    '--include', 'a',
    '--include', 'b',
    '--model', 'claude-sonnet-5',
    '--lang', 'français',
    '--max-chars', '1234',
    '--timeout', '60',
    '--stdout',
    '--dry-run',
  ]);
  assert.deepEqual(options, {
    repo: '/tmp/x',
    workspace: 'checkouts',
    provider: 'copilot',
    providerCommand: 'copilot --allow-all-tools',
    out: 'docs/out.md',
    include: ['a', 'b'],
    model: 'claude-sonnet-5',
    lang: 'français',
    maxChars: 1234,
    timeout: 60,
    stdout: true,
    dryRun: true,
    help: false,
  });
});

test('parseArgs rejects an unknown flag, a missing value and a non-numeric --max-chars', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option: --nope/);
  assert.throws(() => parseArgs(['--repo']), /--repo needs a value/);
  assert.throws(() => parseArgs(['--out', '--stdout']), /--out needs a value/);
  assert.throws(() => parseArgs(['--max-chars', 'many']), /positive integer/);
  assert.throws(() => parseArgs(['--max-chars', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--timeout', 'soon']), /positive integer/);
  assert.throws(() => parseArgs(['--provider', 'gemini']), /--provider expects one of claude, claude-cli, copilot/);
});

test('parseArgs accepts every provider it advertises', () => {
  for (const provider of PROVIDERS) {
    assert.equal(parseArgs(['--provider', provider]).provider, provider);
  }
  assert.equal(DEFAULT_PROVIDER, 'claude');
});

test('parseArgs accepts both spellings of help', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('formatDryRun lists the sources, the call count and an indicative price', () => {
  const sources = [
    { path: 'specs/a.md', kind: 'spec', date: '2026-01-01', chars: 4000 },
    { path: 'plans/b.md', kind: 'plan', date: null, chars: 4000 },
  ];
  const out = formatDryRun({
    sources,
    batches: planBatches(sources, 5000),
    provider: 'claude',
    model: 'claude-opus-5',
    generator: 'claude-opus-5',
    out: '/tmp/repo/docs/ai/retro-documentation.md',
  });
  assert.match(out, /Sources: 2 document\(s\), 8000 characters/);
  assert.match(out, /specs\/a.md/);
  assert.match(out, /Calls: 2 digest \+ 1 synthesis, through claude-opus-5/);
  assert.match(out, /Estimated cost: ~\$\d+\.\d\d \(list price, indicative\)/);
  assert.match(out, /Would write: \/tmp\/repo\/docs\/ai\/retro-documentation.md/);
});

test('formatDryRun admits when it cannot price the model', () => {
  const out = formatDryRun({ sources: [], batches: [], provider: 'claude', model: 'some-future-model', generator: 'some-future-model', out: 'x' });
  assert.match(out, /Estimated cost: unknown for this model/);
});

test('formatDryRun does not quote an API price for a CLI provider', () => {
  const out = formatDryRun({ sources: [], batches: [], provider: 'copilot', model: null, generator: 'GitHub Copilot CLI', out: 'x' });
  assert.match(out, /through GitHub Copilot CLI/);
  assert.match(out, /billed by your CLI subscription/);
});

test('main --help prints the usage and succeeds', async () => {
  const io = capture();
  assert.equal(await main(['--help'], io), 0);
  assert.match(io.out.join('\n'), /Usage: node scripts\/retro-doc.js/);
});

test('main reports a bad flag with the usage and fails', async () => {
  const io = capture();
  assert.equal(await main(['--bogus'], io), 1);
  assert.match(io.err.join('\n'), /Unknown option: --bogus/);
});

test('main fails when the repository does not exist', async () => {
  const io = capture();
  assert.equal(await main(['--repo', path.join(tmpdir(), 'retro-doc-absent-repo')], io), 1);
  assert.match(io.err.join('\n'), /No such repository/);
});

test('main fails when the repository holds no design record', async () => {
  const root = makeRepo({ 'README.md': '# repo\n' });
  const io = capture();
  assert.equal(await main(['--repo', root], io), 1);
  assert.match(io.err.join('\n'), /Found no spec or plan/);
});

test('main --dry-run never calls the model', async () => {
  const root = makeRepo({ 'docs/superpowers/specs/2026-06-14-sync-design.md': SPEC });
  const io = capture();
  const code = await main(['--repo', root, '--dry-run'], {
    ...io,
    completeFactory: () => {
      throw new Error('the dry run must not reach the API');
    },
  });
  assert.equal(code, 0);
  assert.match(io.out.join('\n'), /Sources: 1 document\(s\)/);
});

test('main writes the document under the repository and reports where', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'target', description: 'a target repo' }),
    'README.md': '# target\n',
    'docs/superpowers/specs/2026-06-14-sync-design.md': SPEC,
    'docs/superpowers/plans/2026-06-20-sync-plan.md': PLAN,
  });
  const io = capture();
  const seen = [];
  const code = await main(['--repo', root, '--model', 'claude-sonnet-5'], {
    ...io,
    completeFactory: async ({ model }) => {
      seen.push(model);
      return async ({ label }) => (label === 'synthesis' ? '## Orientation\n\nBody.' : 'digest');
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(seen, ['claude-sonnet-5']);
  const written = path.join(root, DEFAULT_OUT);
  assert.ok(existsSync(written));
  const markdown = readFileSync(written, 'utf8');
  assert.match(markdown, /# Retro-documentation — target/);
  assert.match(markdown, /`docs\/superpowers\/plans\/2026-06-20-sync-plan.md`/);
  assert.match(io.out.join('\n'), /Wrote .*retro-documentation.md/);
  const specRow = markdown.indexOf('2026-06-14-sync-design.md');
  const planRow = markdown.indexOf('2026-06-20-sync-plan.md');
  assert.ok(specRow < planRow, 'the source index is chronological, like the batches sent to the model');
});

test('main --stdout prints the document and writes nothing', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC });
  const io = capture();
  const code = await main(['--repo', root, '--stdout'], {
    ...io,
    write: () => assert.fail('--stdout must not write a file'),
    completeFactory: async () => async () => '## Orientation\n\nBody.',
  });
  assert.equal(code, 0);
  assert.match(io.out.join('\n'), /# Retro-documentation —/);
  assert.equal(existsSync(path.join(root, DEFAULT_OUT)), false);
});

test('main honours --out and --include together', async () => {
  const root = makeRepo({ 'design/a.md': SPEC, 'docs/superpowers/specs/skipped.md': PLAN });
  const io = capture();
  const prompts = [];
  await main(['--repo', root, '--include', 'design', '--out', 'ai/doc.md'], {
    ...io,
    completeFactory: async () => async ({ prompt }) => {
      prompts.push(prompt);
      return '## Orientation\n\nBody.';
    },
  });
  assert.ok(existsSync(path.join(root, 'ai/doc.md')));
  assert.ok(prompts.join('\n').includes('design/a.md'));
  assert.ok(!prompts.join('\n').includes('skipped.md'));
});

test('main asks which repository and which LLM to use when neither was given', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC, 'wk/alpha/.git/HEAD': 'ref\n' });
  const io = capture();
  const asked = [];
  const factoryArgs = [];
  const code = await main([], {
    ...io,
    cwd: root,
    interactive: true,
    selectRepo: async (candidates) => {
      asked.push(candidates.map((c) => c.name));
      return candidates[0].path;
    },
    selectProvider: async () => {
      asked.push('provider');
      return 'copilot';
    },
    completeFactory: async (args) => {
      factoryArgs.push(args);
      return async () => '## Orientation\n\nBody.';
    },
  });

  assert.equal(code, 0);
  assert.equal(asked.length, 2);
  assert.match(asked[0].join(' '), /current directory/);
  assert.equal(asked[1], 'provider');
  assert.equal(factoryArgs[0].provider, 'copilot');
  assert.equal(factoryArgs[0].timeoutMs, DEFAULT_TIMEOUT_SECONDS * 1000);
  assert.match(readFileSync(path.join(root, DEFAULT_OUT), 'utf8'), /by `GitHub Copilot CLI`/);
});

test('main asks nothing when it is not attached to a terminal', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC });
  const io = capture();
  const seen = [];
  const code = await main(['--dry-run'], {
    ...io,
    cwd: root,
    interactive: false,
    selectRepo: () => assert.fail('a non-interactive run must not ask'),
    selectProvider: () => assert.fail('a non-interactive run must not ask'),
    completeFactory: async (args) => {
      seen.push(args);
      return async () => '';
    },
  });
  assert.equal(code, 0);
  assert.match(io.out.join('\n'), /Sources: 1 document\(s\)/);
});

test('main never asks which LLM to use for a dry run, which calls none of them', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC });
  const io = capture();
  const code = await main(['--dry-run'], {
    ...io,
    cwd: root,
    interactive: true,
    selectRepo: async (candidates) => candidates[0].path,
    selectProvider: () => assert.fail('a dry run must not ask which LLM to spend on'),
  });
  assert.equal(code, 0);
  assert.match(io.out.join('\n'), /through claude-opus-5/);
});

test('main resolves --repo against the workspace, so a checkout name is enough', async () => {
  const root = makeRepo({ 'wk/alpha/.git/HEAD': 'ref\n', 'wk/alpha/docs/specs/a.md': SPEC });
  const io = capture();
  const code = await main(['--repo', 'alpha', '--dry-run'], { ...io, cwd: root, interactive: false });
  assert.equal(code, 0);
  assert.match(io.out.join('\n'), /docs\/specs\/a.md/);
  assert.match(io.out.join('\n'), new RegExp(`Would write: ${path.join(root, 'wk', 'alpha')}`.replace(/[/\\]/g, '.')));
});

test('main passes --provider-command through to the factory', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC });
  const io = capture();
  const factoryArgs = [];
  await main(['--repo', root, '--provider', 'copilot', '--provider-command', 'copilot --banner off', '--timeout', '30', '--stdout'], {
    ...io,
    cwd: root,
    interactive: false,
    completeFactory: async (args) => {
      factoryArgs.push(args);
      return async () => '## Orientation\n\nBody.';
    },
  });
  assert.deepEqual(factoryArgs, [{ provider: 'copilot', model: null, providerCommand: 'copilot --banner off', timeoutMs: 30000 }]);
  assert.match(io.out.join('\n'), /by `GitHub Copilot CLI`/);
});
