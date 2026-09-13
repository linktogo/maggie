import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRetroDoc, runRetroDoc } from '../src/pipeline.js';

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

test('runRetroDoc reads a repository, writes the document under it, and says what it used', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'target', description: 'a target repo' }),
    'README.md': '# target\n',
    'docs/superpowers/specs/2026-06-14-sync-design.md': SPEC,
    'docs/superpowers/plans/2026-06-20-sync-plan.md': PLAN,
  });
  const prompts = [];
  const result = await runRetroDoc({
    repoRoot: root,
    complete: async ({ prompt, label }) => {
      prompts.push({ prompt, label });
      return label === 'synthesis' ? '## Orientation\n\nBody.' : 'digest';
    },
    generator: 'GitHub Copilot CLI',
    now: () => new Date('2026-09-13T00:00:00Z'),
  });

  assert.equal(result.outPath, path.join(root, 'docs/ai/retro-documentation.md'));
  assert.deepEqual(result.sources.map((source) => source.kind), ['spec', 'plan']);
  assert.ok(existsSync(result.outPath), 'the output directory is created on the way');
  const written = readFileSync(result.outPath, 'utf8');
  assert.equal(written, result.markdown);
  assert.match(written, /by `GitHub Copilot CLI` on 2026-09-13/);
  assert.match(written, /# Retro-documentation — target/);
  assert.match(prompts.at(-1).prompt, /"target"/);
});

test('runRetroDoc honours the include list, the output path and the language', async () => {
  const root = makeRepo({ 'design/a.md': SPEC, 'docs/superpowers/specs/skipped.md': PLAN });
  const prompts = [];
  const result = await runRetroDoc({
    repoRoot: root,
    include: ['design'],
    out: 'ai/doc.md',
    lang: 'français',
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return '## Orientation\n\nCorps.';
    },
    generator: 'claude-opus-5',
  });
  assert.equal(result.outPath, path.join(root, 'ai/doc.md'));
  assert.ok(existsSync(result.outPath));
  assert.ok(prompts.join('\n').includes('design/a.md'));
  assert.ok(!prompts.join('\n').includes('skipped.md'));
  assert.match(prompts.at(-1), /in français/);
});

test('runRetroDoc refuses to invent a document for a repository with no design record', async () => {
  const root = makeRepo({ 'README.md': '# repo\n' });
  await assert.rejects(
    runRetroDoc({ repoRoot: root, complete: async () => 'never called', generator: 'x' }),
    /Found no spec or plan under/,
  );
});

test('runRetroDoc lets the caller supply the writer, so nothing has to touch the disk', async () => {
  const root = makeRepo({ 'specs/a.md': SPEC });
  const written = [];
  const result = await runRetroDoc({
    repoRoot: root,
    complete: async () => '## Orientation\n\nBody.',
    generator: 'x',
    write: async (file, contents) => written.push({ file, contents }),
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].contents, result.markdown);
  assert.equal(existsSync(path.join(root, 'docs/ai/retro-documentation.md')), false);
});
