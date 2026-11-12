import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WORKSPACE,
  classifyKind,
  collectRepoContext,
  collectSourceFiles,
  listRepoCandidates,
  orderSources,
  parseFrontmatter,
  planBatches,
  readSource,
  resolveRepoArg,
} from '../src/sources.js';

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

test('listRepoCandidates defaults to the workspace maggie-workspace bootstraps into', () => {
  const root = makeRepo({ [`${DEFAULT_WORKSPACE}/alpha/.git/HEAD`]: 'ref\n' });
  assert.deepEqual(
    listRepoCandidates({ cwd: root }).map((candidate) => candidate.name).slice(1),
    ['alpha (wk/)'],
  );
  assert.equal(resolveRepoArg('alpha', { cwd: root }), path.join(root, DEFAULT_WORKSPACE, 'alpha'));
});

test('collectSourceFiles skips hidden directories inside a location it scans', () => {
  const root = makeRepo({
    'specs/kept.md': SPEC,
    'specs/.archive/dropped.md': SPEC,
  });
  assert.deepEqual(collectSourceFiles(root), ['specs/kept.md']);
});

test('collectRepoContext falls back to the directory name when the manifest names nothing', () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ version: '1.0.0' }) });
  const context = collectRepoContext(root);
  assert.equal(context.name, path.basename(root));
  assert.equal(context.description, '');
});

test('planBatches falls back to its own limit, and listRepoCandidates to the current directory', () => {
  const sources = [{ path: 'a', chars: 10 }, { path: 'b', chars: 10 }];
  assert.equal(planBatches(sources).length, 1);
  assert.equal(listRepoCandidates()[0].path, path.resolve(process.cwd()));
});
