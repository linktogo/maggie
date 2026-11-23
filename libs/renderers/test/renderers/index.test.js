import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRenderer, knownTargets, renderRepo, mergeBlock } from '../../src/renderers/index.js';

test('knownTargets lists every platform', () => {
  assert.deepEqual(knownTargets().sort(), ['agents', 'claude', 'copilot', 'cursor', 'windsurf']);
});

test('getRenderer returns the matching renderer', () => {
  assert.equal(getRenderer('claude').id, 'claude');
});

test('getRenderer throws on unknown target', () => {
  assert.throws(() => getRenderer('nope'), /Unknown target: nope/);
});

const skill = { name: 's', description: 'D', body: '# B', source: 'skills/x/s/SKILL.md' };
const withFiles = {
  ...skill,
  resources: [
    { path: 'scripts/run.sh', content: Buffer.from('echo hi') },
    { path: 'references/api.md', content: Buffer.from('# API') },
  ],
};

test('renderRepo renders each skill for each target', () => {
  const files = renderRepo(['claude', 'cursor'], [skill]);
  assert.deepEqual(files.map((f) => f.path), ['.claude/skills/s/SKILL.md', '.cursor/rules/s.mdc']);
});

test('renderRepo treats a skill without a resources field like one with none', () => {
  const files = renderRepo(['copilot'], [{ ...skill, resources: [] }]);
  assert.deepEqual(files.map((f) => f.path), ['.github/instructions/s.instructions.md']);
  assert.doesNotMatch(files[0].content, /Supporting files/);
});

test('renderRepo copies supporting files next to the skill for directory formats', () => {
  const files = renderRepo(['claude', 'agents'], [withFiles]);
  assert.deepEqual(files.map((f) => f.path), [
    '.claude/skills/s/SKILL.md',
    '.claude/skills/s/scripts/run.sh',
    '.claude/skills/s/references/api.md',
    '.agents/skills/s/SKILL.md',
    '.agents/skills/s/scripts/run.sh',
    '.agents/skills/s/references/api.md',
    'AGENTS.md',
  ]);
  assert.equal(files[1].content.toString(), 'echo hi');
  assert.doesNotMatch(files[0].content, /Supporting files/);
});

test('renderRepo puts supporting files once under .maggie/skills for single-file formats, and points at them', () => {
  const files = renderRepo(['copilot', 'cursor', 'windsurf'], [withFiles]);
  assert.deepEqual(files.map((f) => f.path), [
    '.github/instructions/s.instructions.md',
    '.maggie/skills/s/scripts/run.sh',
    '.maggie/skills/s/references/api.md',
    '.cursor/rules/s.mdc',
    '.windsurf/rules/s.md',
  ]);
  for (const rule of [files[0], files[3], files[4]]) {
    assert.match(rule.content, /## Supporting files/);
    assert.match(rule.content, /- `.maggie\/skills\/s\/scripts\/run.sh`/);
  }
});

test('renderRepo adds the AGENTS.md index block for the agents target only when there are skills', () => {
  assert.equal(renderRepo(['agents'], []).length, 0);
  const files = renderRepo(['agents', 'claude'], [skill]);
  const index = files.find((f) => f.path === 'AGENTS.md');
  assert.equal(index.block, 'skills');
  assert.equal(files.filter((f) => f.block).length, 1);
});

test('renderRepo throws on an unknown target', () => {
  assert.throws(() => renderRepo(['nope'], [skill]), /Unknown target: nope/);
});

test('block helpers are re-exported', () => {
  assert.match(mergeBlock('', 'x', 'y'), /maggie:begin x/);
});
