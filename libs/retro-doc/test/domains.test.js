import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW_SLUG, extractJsonArray, parseDomains, slugify, wholeRepository } from '../src/domains.js';

const sources = [
  { path: 'specs/sync.md', title: 'Sync', kind: 'spec', date: '2026-01-01' },
  { path: 'specs/board.md', title: 'Board', kind: 'spec', date: '2026-02-01' },
  { path: 'plans/board.md', title: 'Board plan', kind: 'plan', date: '2026-02-02' },
];

const plan = JSON.stringify([
  { slug: 'skill-sync', title: 'Skill sync', summary: 'Rendering skills into repos.', sources: ['specs/sync.md'] },
  { slug: 'board', title: 'Status board', summary: 'The dashboard.', sources: ['specs/board.md', 'plans/board.md'] },
]);

test('slugify makes a file name out of anything, and never an empty one', () => {
  assert.equal(slugify('Skill sync'), 'skill-sync');
  assert.equal(slugify('Rétro-documentation & CI'), 'retro-documentation-ci');
  assert.equal(slugify('  --Board--  '), 'board');
  assert.equal(slugify(''), 'domain');
  assert.equal(slugify('***', 'fallback'), 'fallback');
  assert.equal(slugify(null), 'domain');
  assert.equal(slugify('x'.repeat(80)).length, 60);
});

test('extractJsonArray reads the array out of prose and code fences alike', () => {
  assert.deepEqual(extractJsonArray('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('Here you go:\n```json\n[{"a":1}]\n```\nHope that helps!'), [{ a: 1 }]);
  assert.equal(extractJsonArray('no array here'), null);
  assert.equal(extractJsonArray('[not json]'), null);
  assert.equal(extractJsonArray('{"a":1}'), null);
  assert.equal(extractJsonArray(']['), null);
});

test('parseDomains keeps the domains the model proposed, with their sources', () => {
  const domains = parseDomains(plan, sources);
  assert.deepEqual(domains.map((domain) => domain.slug), ['skill-sync', 'board']);
  assert.equal(domains[0].title, 'Skill sync');
  assert.equal(domains[0].summary, 'Rendering skills into repos.');
  assert.deepEqual(domains[1].sources, ['specs/board.md', 'plans/board.md']);
});

test('parseDomains gives every document a home, even one the plan forgot', () => {
  const domains = parseDomains(JSON.stringify([
    { slug: 'a', title: 'A', sources: ['specs/sync.md'] },
    { slug: 'b', title: 'B', sources: ['specs/board.md'] },
  ]), sources);
  // plans/board.md was claimed by nobody: it joins the widest domain rather than vanishing.
  assert.deepEqual(domains.flatMap((domain) => domain.sources).sort(), [
    'plans/board.md', 'specs/board.md', 'specs/sync.md',
  ]);
});

test('parseDomains drops what it cannot use: no title, unknown paths, duplicate slugs', () => {
  const domains = parseDomains(JSON.stringify([
    { slug: 'ok', title: 'Ok', sources: ['specs/sync.md', 'does/not/exist.md'] },
    { slug: 'ok', title: 'Ok again', sources: ['specs/board.md'] },
    { title: '   ' },
    'not an object',
    null,
    { slug: 'no-title-here' },
  ]), sources);
  assert.deepEqual(domains.map((domain) => domain.slug), ['ok', 'ok-2']);
  assert.ok(domains[0].sources.includes('specs/sync.md'));
  assert.ok(!domains.some((domain) => domain.sources.includes('does/not/exist.md')), 'a path that is not in the record is not written into a document');
  assert.equal(domains[1].summary, '');
});

test('parseDomains derives a slug from the title when the model omitted one', () => {
  const domains = parseDomains(JSON.stringify([{ title: 'Release automation', sources: [] }]), sources);
  assert.equal(domains[0].slug, 'release-automation');
});

test('parseDomains caps how many documents a run will write', () => {
  const many = Array.from({ length: 20 }, (unused, i) => ({ slug: `d${i}`, title: `D${i}`, sources: [] }));
  assert.equal(parseDomains(JSON.stringify(many), sources).length, 8);
  assert.equal(parseDomains(JSON.stringify(many), sources, { max: 3 }).length, 3);
});

test('an unreadable plan documents the repository in one piece rather than failing the run', () => {
  for (const answer of ['I could not do that', '[]', '', null, JSON.stringify([{ sources: [] }])]) {
    const domains = parseDomains(answer, sources);
    assert.deepEqual(domains.map((domain) => domain.slug), [OVERVIEW_SLUG]);
    assert.deepEqual(domains[0].sources, sources.map((source) => source.path));
    assert.match(domains[0].summary, /could not be split/);
  }
  assert.deepEqual(wholeRepository(sources)[0].sources, sources.map((source) => source.path));
});

test('parseDomains ignores a title that is not text and a sources field that is not a list', () => {
  const domains = parseDomains(JSON.stringify([
    { slug: 'numeric', title: 42, sources: [] },
    { slug: 'loose', title: 'Loose', sources: 'specs/sync.md' },
  ]), sources);
  assert.deepEqual(domains.map((domain) => domain.slug), ['loose']);
  // Nothing was claimed, so every document lands in the only domain there is.
  assert.deepEqual(domains[0].sources, sources.map((source) => source.path));
});

test('an orphan document joins the domain that already carries the most of its neighbours', () => {
  const four = [...sources, { path: 'plans/sync.md', title: 'Sync plan', kind: 'plan', date: '2026-01-02' }];
  const domains = parseDomains(JSON.stringify([
    { slug: 'small', title: 'Small', sources: ['specs/sync.md'] },
    { slug: 'big', title: 'Big', sources: ['specs/board.md', 'plans/board.md'] },
  ]), four);
  assert.deepEqual(domains[0].sources, ['specs/sync.md']);
  assert.deepEqual(domains[1].sources, ['specs/board.md', 'plans/board.md', 'plans/sync.md']);
});

test('a title that leaves nothing to slugify still gets a file name', () => {
  const domains = parseDomains(JSON.stringify([{ title: '***', sources: [] }]), sources);
  assert.deepEqual(domains.map((domain) => domain.slug), ['domain-1']);
  assert.equal(domains[0].title, '***');
});
