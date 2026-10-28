import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSkills, loadSkill } from '../src/skills.js';

let skillsDir;
let brokenDir;

before(async () => {
  skillsDir = await mkdtemp(path.join(tmpdir(), 'agent-skills-'));
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(
    path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'),
    '---\nname: nx-monorepo\ndescription: Keep an Nx workspace tidy\n---\n\n# Nx\n\nUse affected.\n',
  );
  await mkdir(path.join(skillsDir, 'vuejs', 'composition'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'composition', 'SKILL.md'), 'No frontmatter here.\n');
  await mkdir(path.join(skillsDir, 'vuejs', 'draft'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'notes.txt'), 'not a skill');
  await writeFile(path.join(skillsDir, 'README.md'), 'not a techno');
  await mkdir(path.join(skillsDir, 'vuejs', 'unterminated'), { recursive: true });
  await writeFile(path.join(skillsDir, 'vuejs', 'unterminated', 'SKILL.md'), '---\nname: x\nnever closed\n');

  brokenDir = await mkdtemp(path.join(tmpdir(), 'agent-skills-broken-'));
  await mkdir(path.join(brokenDir, 'vuejs', 'broken', 'SKILL.md'), { recursive: true }); // a directory, so reading it fails with EISDIR
});

after(async () => {
  await rm(skillsDir, { recursive: true, force: true });
  await rm(brokenDir, { recursive: true, force: true });
});

test('listSkills walks <techno>/<name>/SKILL.md, sorted, skipping what is not a skill', () => {
  assert.deepEqual(listSkills(skillsDir), [
    { id: 'nx/monorepo', techno: 'nx', name: 'monorepo', description: 'Keep an Nx workspace tidy' },
    { id: 'vuejs/composition', techno: 'vuejs', name: 'composition', description: '' },
    { id: 'vuejs/unterminated', techno: 'vuejs', name: 'unterminated', description: '' },
  ]);
});

test('listSkills does not swallow a real read error', () => {
  assert.throws(() => listSkills(brokenDir), (err) => err.code === 'EISDIR');
});

test('loadSkill returns the body without its frontmatter', () => {
  assert.deepEqual(loadSkill(skillsDir, 'nx/monorepo'), { id: 'nx/monorepo', body: '# Nx\n\nUse affected.' });
});

test('loadSkill keeps a file with no (or unterminated) frontmatter whole', () => {
  assert.equal(loadSkill(skillsDir, 'vuejs/composition').body, 'No frontmatter here.');
  assert.match(loadSkill(skillsDir, 'vuejs/unterminated').body, /never closed/);
});

test('loadSkill refuses ids that are not <techno>/<name>', () => {
  for (const bad of ['../etc/passwd', 'nx', 'nx/monorepo/extra', '/abs/path', 'nx/..', '', 42, undefined]) {
    assert.throws(() => loadSkill(skillsDir, bad), (err) => err.code === 'invalid');
  }
});

test('loadSkill reports an unknown skill, and rethrows a real read error', () => {
  assert.throws(() => loadSkill(skillsDir, 'nx/absent'), (err) => err.code === 'not-found' && /unknown skill: nx\/absent/.test(err.message));
  assert.throws(() => loadSkill(brokenDir, 'vuejs/broken'), (err) => err.code === 'EISDIR');
});
