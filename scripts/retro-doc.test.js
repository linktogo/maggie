import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_MODEL,
  DEFAULT_OUT,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WORKSPACE,
  PROVIDERS,
  createCliComplete,
  createComplete,
  describeProvider,
  listRepoCandidates,
  providerCommand,
  resolveRepoArg,
  runCommand,
  buildDigestPrompt,
  buildSynthesisPrompt,
  classifyKind,
  collectRepoContext,
  collectSourceFiles,
  estimateCost,
  estimateTokens,
  formatDryRun,
  generateRetroDoc,
  main,
  orderSources,
  parseArgs,
  parseFrontmatter,
  planBatches,
  readSource,
  renderOutput,
} from './retro-doc.js';

function makeRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'retro-doc-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
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

test('collectSourceFiles reads the default spec and plan locations', () => {
  const root = makeRepo({
    'docs/superpowers/specs/2026-06-14-sync-design.md': SPEC,
    'docs/superpowers/plans/2026-06-14-sync-plan.md': PLAN,
    'docs/configuration.md': '# Configuration\n',
    'README.md': '# repo\n',
  });
  assert.deepEqual(collectSourceFiles(root), [
    'docs/superpowers/plans/2026-06-14-sync-plan.md',
    'docs/superpowers/specs/2026-06-14-sync-design.md',
  ]);
});

test('collectSourceFiles never walks into node_modules or other build output', () => {
  const root = makeRepo({
    'specs/real.md': SPEC,
    'specs/node_modules/pkg/fake-spec.md': SPEC,
    'specs/dist/generated.md': SPEC,
  });
  assert.deepEqual(collectSourceFiles(root), ['specs/real.md']);
});

test('collectSourceFiles takes --include over the defaults, and accepts a single file', () => {
  const root = makeRepo({
    'docs/specs/ignored.md': SPEC,
    'design/one.md': SPEC,
    'design/two.md': PLAN,
    'notes/solo.md': SPEC,
  });
  assert.deepEqual(collectSourceFiles(root, { include: ['design', 'notes/solo.md'] }), [
    'design/one.md',
    'design/two.md',
    'notes/solo.md',
  ]);
});

test('collectSourceFiles ignores an include path that does not exist', () => {
  const root = makeRepo({ 'design/one.md': SPEC });
  assert.deepEqual(collectSourceFiles(root, { include: ['design', 'gone'] }), ['design/one.md']);
});

test('collectSourceFiles falls back to design-shaped names under docs/ when no known location exists', () => {
  const root = makeRepo({
    'docs/2026-01-01-board-design.md': SPEC,
    'docs/rfc-0001.md': SPEC,
    'docs/configuration.md': '# Configuration\n',
    'docs/notes.txt': 'not markdown',
  });
  assert.deepEqual(collectSourceFiles(root), ['docs/2026-01-01-board-design.md', 'docs/rfc-0001.md']);
});

test('collectSourceFiles returns nothing for a repository with no design record', () => {
  const root = makeRepo({ 'README.md': '# repo\n' });
  assert.deepEqual(collectSourceFiles(root), []);
});

test('parseFrontmatter reads a YAML block and tolerates its absence', () => {
  assert.deepEqual(parseFrontmatter('---\ntitle: "A spec"\nDate: 2026-06-14\n---\n# body\n'), {
    title: 'A spec',
    date: '2026-06-14',
  });
  assert.deepEqual(parseFrontmatter('# body\n'), {});
  assert.deepEqual(parseFrontmatter('---\nunterminated: yes\n'), {});
});

test('classifyKind separates plans, specs and decision records', () => {
  assert.equal(classifyKind('docs/superpowers/plans/a.md'), 'plan');
  assert.equal(classifyKind('plans/a.md'), 'plan');
  assert.equal(classifyKind('docs/x-plan.md'), 'plan');
  assert.equal(classifyKind('docs/superpowers/specs/a.md'), 'spec');
  assert.equal(classifyKind('docs/2026-01-01-board-design.md'), 'spec');
  assert.equal(classifyKind('docs/adr/0001-use-nx.md'), 'decision-record');
  assert.equal(classifyKind('docs/whatever.md'), 'design-doc');
});

test('readSource takes the title from the first heading and the date from the file name', () => {
  const root = makeRepo({ 'docs/superpowers/specs/2026-06-14-sync-design.md': SPEC });
  const source = readSource(root, 'docs/superpowers/specs/2026-06-14-sync-design.md');
  assert.equal(source.title, 'Design — Sync');
  assert.equal(source.date, '2026-06-14');
  assert.equal(source.kind, 'spec');
  assert.equal(source.chars, SPEC.length);
});

test('readSource prefers frontmatter, and falls back to the file name when there is no heading', () => {
  const root = makeRepo({
    'specs/a.md': '---\ntitle: From frontmatter\ndate: 2025-12-01\n---\n# Ignored heading\n',
    'specs/b.md': 'no heading at all\n',
  });
  const a = readSource(root, 'specs/a.md');
  assert.equal(a.title, 'From frontmatter');
  assert.equal(a.date, '2025-12-01');
  const b = readSource(root, 'specs/b.md');
  assert.equal(b.title, 'b');
  assert.equal(b.date, null);
});

test('collectRepoContext names the repository from package.json and keeps the README head', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: '@linktogo/maggie', description: 'Sync AI agent skills' }),
    'README.md': '# maggie\n',
    'docs/x.md': '',
    'node_modules/pkg/index.js': '',
  });
  const context = collectRepoContext(root);
  assert.equal(context.name, '@linktogo/maggie');
  assert.equal(context.description, 'Sync AI agent skills');
  assert.equal(context.readme, '# maggie\n');
  assert.deepEqual(context.entries, ['README.md', 'docs/', 'package.json']);
});

test('collectRepoContext survives an unreadable manifest and a missing README', () => {
  const root = makeRepo({ 'package.json': '{ not json' });
  const context = collectRepoContext(root);
  assert.equal(context.name, path.basename(root));
  assert.equal(context.readme, '');
});

test('planBatches never splits a document and never truncates one over the limit', () => {
  const sources = [
    { path: 'a', chars: 40 },
    { path: 'b', chars: 40 },
    { path: 'c', chars: 500 },
    { path: 'd', chars: 10 },
  ];
  const batches = planBatches(sources, 100);
  assert.deepEqual(
    batches.map((batch) => batch.map((source) => source.path)),
    [['a', 'b'], ['c'], ['d']],
  );
  assert.equal(planBatches([], 100).length, 0);
});

test('orderSources reads the record chronologically and leaves undated documents last', () => {
  const ordered = orderSources([
    { path: 'specs/z.md', date: null },
    { path: 'plans/b.md', date: '2026-08-10' },
    { path: 'specs/a.md', date: '2026-06-14' },
    { path: 'specs/b.md', date: '2026-08-10' },
    { path: 'plans/a.md', date: null },
  ]);
  assert.deepEqual(ordered.map((source) => source.path), [
    'specs/a.md',
    'plans/b.md',
    'specs/b.md',
    'plans/a.md',
    'specs/z.md',
  ]);
});

test('estimateTokens and estimateCost report a price only for a known model', () => {
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateCost('claude-opus-5', 1e6, 1e6), 30);
  assert.equal(estimateCost('some-future-model', 1e6, 1e6), null);
});

test('buildDigestPrompt wraps each document with its path, kind and date', () => {
  const prompt = buildDigestPrompt([
    { path: 'specs/a.md', kind: 'spec', date: '2026-06-14', title: 'A', text: 'body A' },
    { path: 'plans/b.md', kind: 'plan', date: null, title: 'B', text: 'body B' },
  ]);
  assert.match(prompt, /Digest the following 2 document\(s\)/);
  assert.match(prompt, /<document path="specs\/a.md" kind="spec" date="2026-06-14" title="A">\nbody A\n<\/document>/);
  assert.match(prompt, /date="unknown"/);
});

test('buildSynthesisPrompt carries the language, the repository context and the source inventory', () => {
  const prompt = buildSynthesisPrompt({
    context: { name: 'maggie', description: 'd', entries: ['apps/', 'libs/'], readme: '# maggie' },
    digests: ['### A digest'],
    lang: 'français',
    sources: [{ path: 'specs/a.md', title: 'A', kind: 'spec', date: '2026-06-14' }],
  });
  assert.match(prompt, /retro-documentation of the repository "maggie" in français/);
  assert.match(prompt, /top-level entries: apps\/, libs\//);
  assert.match(prompt, /- specs\/a.md — A \(spec, 2026-06-14\)/);
  assert.match(prompt, /### A digest/);
});

test('buildSynthesisPrompt says so rather than lying when the repository has no README', () => {
  const prompt = buildSynthesisPrompt({
    context: { name: 'x', description: '', entries: [], readme: '' },
    digests: [],
    sources: [],
  });
  assert.match(prompt, /No README found\./);
  assert.match(prompt, /description: none declared/);
});

test('renderOutput frames the body with a regeneration warning and a source index', () => {
  const markdown = renderOutput({
    body: '## Orientation\n\nIt syncs skills.',
    context: { name: 'maggie' },
    sources: [
      { path: 'specs/a.md', title: 'A | with pipe', kind: 'spec', date: '2026-06-14' },
      { path: 'plans/b.md', title: 'B', kind: 'plan', date: null },
    ],
    generator: 'claude-opus-5',
    generatedAt: '2026-09-13',
  });
  assert.match(markdown, /^<!-- Generated by scripts\/retro-doc.js/);
  assert.match(markdown, /# Retro-documentation — maggie/);
  assert.match(markdown, /Reconstructed from 2 design document\(s\) by `claude-opus-5` on 2026-09-13/);
  assert.match(markdown, /## Orientation/);
  assert.match(markdown, /\| 2026-06-14 \| spec \| A \\\| with pipe \| `specs\/a.md` \|/);
  assert.match(markdown, /\| — \| plan \| B \| `plans\/b.md` \|/);
});

test('generateRetroDoc digests each batch, then synthesises once from the digests', async () => {
  const calls = [];
  const complete = async ({ system, prompt, maxTokens, label }) => {
    calls.push({ label, maxTokens, system: system.slice(0, 20), prompt });
    return label === 'synthesis' ? '## Orientation\n\nSynthesised.' : `digest of ${label}`;
  };
  const sources = [
    { path: 'specs/a.md', title: 'A', kind: 'spec', date: '2026-01-01', text: 'a'.repeat(80), chars: 80 },
    { path: 'plans/b.md', title: 'B', kind: 'plan', date: '2026-02-01', text: 'b'.repeat(80), chars: 80 },
  ];
  const logged = [];
  const { markdown, digests } = await generateRetroDoc({
    sources,
    context: { name: 'maggie', description: '', entries: [], readme: '' },
    complete,
    generator: 'claude-opus-5',
    maxChars: 100,
    log: (message) => logged.push(message),
    now: () => new Date('2026-09-13T00:00:00Z'),
  });

  assert.deepEqual(calls.map((call) => call.label), ['digest 1/2', 'digest 2/2', 'synthesis']);
  assert.deepEqual(digests, ['digest of digest 1/2', 'digest of digest 2/2']);
  assert.equal(calls.at(-1).maxTokens, 64000);
  assert.match(calls.at(-1).prompt, /digest of digest 2\/2/);
  assert.match(markdown, /Synthesised\./);
  assert.match(markdown, /on 2026-09-13/);
  assert.equal(logged.length, 3);
});

test('generateRetroDoc sends the full text of every source, never a truncation', async () => {
  const text = 'x'.repeat(5000);
  const sent = [];
  await generateRetroDoc({
    sources: [{ path: 'specs/a.md', title: 'A', kind: 'spec', date: null, text, chars: text.length }],
    context: { name: 'maggie', description: '', entries: [], readme: '' },
    complete: async ({ prompt }) => {
      sent.push(prompt);
      return 'ok';
    },
    generator: 'claude-opus-5',
    maxChars: 10,
  });
  assert.ok(sent[0].includes(text));
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

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) };
}

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

test('listRepoCandidates offers the current directory first, then the workspace checkouts', () => {
  const root = makeRepo({
    'wk/alpha/.git/HEAD': 'ref: refs/heads/main\n',
    'wk/beta/.git/HEAD': 'ref: refs/heads/main\n',
    'wk/not-a-checkout/readme.md': '# no .git here\n',
    'wk/.maggie/board.json': '{}',
  });
  const candidates = listRepoCandidates({ cwd: root, workspace: 'wk' });
  assert.equal(candidates.length, 3);
  assert.match(candidates[0].name, /\(current directory\)$/);
  assert.equal(candidates[0].path, path.resolve(root));
  assert.deepEqual(candidates.slice(1).map((c) => c.name), ['alpha (wk/)', 'beta (wk/)']);
  assert.equal(candidates[1].path, path.join(root, 'wk', 'alpha'));
});

test('listRepoCandidates works in a repository with no workspace at all', () => {
  const root = makeRepo({ 'README.md': '# repo\n' });
  assert.equal(listRepoCandidates({ cwd: root, workspace: 'wk' }).length, 1);
});

test('resolveRepoArg takes a path, or the name of a workspace checkout', () => {
  const root = makeRepo({ 'wk/alpha/.git/HEAD': 'ref\n', 'sibling/README.md': '# x\n' });
  assert.equal(resolveRepoArg('alpha', { cwd: root, workspace: 'wk' }), path.join(root, 'wk', 'alpha'));
  assert.equal(resolveRepoArg('sibling', { cwd: root, workspace: 'wk' }), path.join(root, 'sibling'));
  assert.equal(resolveRepoArg('nowhere', { cwd: root, workspace: 'wk' }), path.join(root, 'nowhere'));
});

test('providerCommand runs the documented command for each CLI provider', () => {
  assert.deepEqual(providerCommand('claude-cli'), { command: 'claude', args: ['-p'] });
  assert.deepEqual(providerCommand('claude-cli', { model: 'claude-opus-5' }), {
    command: 'claude',
    args: ['-p', '--model', 'claude-opus-5'],
  });
  assert.deepEqual(providerCommand('copilot'), { command: 'copilot', args: ['--allow-all-tools'] });
  assert.deepEqual(providerCommand('copilot', { model: 'claude-sonnet-4.5' }), {
    command: 'copilot',
    args: ['--allow-all-tools', '--model', 'claude-sonnet-4.5'],
  });
});

test('providerCommand lets --provider-command replace the command entirely', () => {
  assert.deepEqual(providerCommand('copilot', { model: 'ignored', override: '  /usr/bin/copilot  --banner  off ' }), {
    command: '/usr/bin/copilot',
    args: ['--banner', 'off'],
  });
});

test('describeProvider names the generator that goes in the document header', () => {
  assert.equal(describeProvider({ provider: 'claude' }), DEFAULT_MODEL);
  assert.equal(describeProvider({ provider: 'claude', model: 'claude-sonnet-5' }), 'claude-sonnet-5');
  assert.equal(describeProvider({ provider: 'claude-cli' }), 'claude CLI');
  assert.equal(describeProvider({ provider: 'copilot' }), 'GitHub Copilot CLI');
  assert.equal(describeProvider({ provider: 'copilot', model: 'gpt-5' }), 'GitHub Copilot CLI (gpt-5)');
  assert.equal(describeProvider({ provider: 'copilot', providerCommand: 'gh copilot' }), 'gh CLI');
});

/** A spawn stand-in: records the call, then plays back the child process it was told to. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, failWith = null, silent = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    let written = '';
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (data) => { written = data; calls.push({ command, args, options, input: written }); } };
    child.kill = (signal) => calls.push({ killed: signal });
    queueMicrotask(() => {
      if (failWith) return child.emit('error', new Error(failWith));
      if (silent) return;
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('runCommand feeds the prompt on stdin and resolves with stdout', async () => {
  const spawn = fakeSpawn({ stdout: 'the answer\n' });
  const out = await runCommand({ command: 'copilot', args: ['--allow-all-tools'], input: 'a prompt', spawn });
  assert.equal(out, 'the answer\n');
  assert.deepEqual(spawn.calls[0].args, ['--allow-all-tools']);
  assert.equal(spawn.calls[0].input, 'a prompt');
  assert.deepEqual(spawn.calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('runCommand reports a non-zero exit with what the command printed on stderr', async () => {
  const spawn = fakeSpawn({ code: 2, stderr: 'not logged in' });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', spawn }),
    /`copilot` exited with code 2: not logged in/,
  );
});

test('runCommand says which command is missing when it cannot be spawned', async () => {
  const spawn = fakeSpawn({ failWith: 'spawn copilot ENOENT' });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', spawn }),
    /Could not run `copilot`: spawn copilot ENOENT/,
  );
});

test('runCommand kills a CLI that never answers, rather than hanging the run', async () => {
  const spawn = fakeSpawn({ silent: true });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', timeoutMs: 20, spawn }),
    /`copilot` produced nothing after 0s — raise --timeout/,
  );
  assert.ok(spawn.calls.some((call) => call.killed === 'SIGTERM'));
});

test('createCliComplete folds the system prompt into the message the CLI reads', async () => {
  const spawn = fakeSpawn({ stdout: '## Orientation\n\nBody.\n' });
  const complete = createCliComplete({ provider: 'copilot', spawn });
  const answer = await complete({ system: 'SYSTEM RULES', prompt: 'THE DOCUMENTS' });
  assert.equal(answer, '## Orientation\n\nBody.');
  assert.match(spawn.calls[0].input, /SYSTEM RULES[\s\S]*THE DOCUMENTS/);
});

test('createCliComplete refuses an empty answer instead of writing an empty document', async () => {
  const complete = createCliComplete({ provider: 'claude-cli', spawn: fakeSpawn({ stdout: '  \n' }) });
  await assert.rejects(complete({ system: 's', prompt: 'p' }), /`claude` returned nothing/);
});

test('createComplete routes a CLI provider to the CLI, not to the Anthropic SDK', async () => {
  const spawn = fakeSpawn({ stdout: 'done' });
  const complete = await createComplete({ provider: 'copilot', model: null, timeoutMs: 1000, spawn });
  assert.equal(await complete({ system: 's', prompt: 'p' }), 'done');
  assert.equal(spawn.calls[0].command, 'copilot');
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
