import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkills } from '../src/skills.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/skills');

test('resolveSkills returns the union across technologies, skipping non-directories', async () => {
  const skills = await resolveSkills(fixtures, ['nestjs', 'react']);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['nestjs-module-structure', 'react-component']);
});

test('resolveSkills warns and continues when a technology has no directory', async () => {
  const warnings = [];
  const skills = await resolveSkills(fixtures, ['nestjs', 'missing'], {
    warn: (m) => warnings.push(m),
  });
  assert.equal(skills.length, 1);
  assert.match(warnings[0], /No skills directory for technology "missing"/);
});

test('resolveSkills dedupes by skill name (last technology wins)', async () => {
  const skills = await resolveSkills(fixtures, ['nestjs', 'nestjs']);
  assert.equal(skills.length, 1);
});

test('resolveSkills rethrows non-ENOENT errors (e.g. ENOTDIR when techno resolves to a file)', async () => {
  await assert.rejects(
    () => resolveSkills(fixtures, ['nestjs/_notdir.txt']),
    (err) => err.code !== 'ENOENT',
  );
});

test('resolveSkills throws instead of warning on a missing technology in strict mode', async () => {
  await assert.rejects(
    () => resolveSkills(fixtures, ['nestjs', 'missing'], { strict: true }),
    /No skills directory for technology "missing"/,
  );
});

test('resolveSkills warns on a name collision between two technologies, naming both and which file wins', async () => {
  const warnings = [];
  const skills = await resolveSkills(fixtures, ['a', 'b'], {
    warn: (m) => warnings.push(m),
  });
  assert.equal(skills.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skill "shared-skill" is defined by both "a" and "b"/);
  assert.match(warnings[0], /using .*b[/\\]shared[/\\]SKILL\.md/);
  assert.match(warnings[0], /last technology wins/);
});

test('resolveSkills under strict throws once, listing every collision found, not just the first', async () => {
  await assert.rejects(
    () => resolveSkills(fixtures, ['a', 'b', 'c'], { strict: true }),
    (err) => {
      assert.match(err.message, /"a" and "b"/);
      assert.match(err.message, /"b" and "c"/);
      return true;
    },
  );
});

test('resolveSkills does not warn when the same technology is listed twice', async () => {
  const warnings = [];
  await resolveSkills(fixtures, ['nestjs', 'nestjs'], {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
});

test('resolveSkills attaches the canonical skills/<techno>/<name>/SKILL.md source path', async () => {
  const skills = await resolveSkills(fixtures, ['nestjs', 'react']);
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName['nestjs-module-structure'].source, 'skills/nestjs/module-structure/SKILL.md');
  assert.equal(byName['react-component'].source, 'skills/react/component/SKILL.md');
});
