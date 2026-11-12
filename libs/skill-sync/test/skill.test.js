import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkill } from '../src/skill.js';

const valid = `---
name: nestjs-module-structure
description: How to structure NestJS modules
globs: ["**/*.ts"]
---

# Module structure
Body here.
`;

test('parseSkill extracts name, description, globs and trimmed body', () => {
  const skill = parseSkill(valid, 'a/SKILL.md');
  assert.deepEqual(skill, {
    name: 'nestjs-module-structure',
    description: 'How to structure NestJS modules',
    globs: ['**/*.ts'],
    body: '# Module structure\nBody here.',
  });
});

test('parseSkill leaves globs undefined when absent', () => {
  const skill = parseSkill('---\nname: a\ndescription: b\n---\nBody', 'x');
  assert.equal(skill.globs, undefined);
});

test('parseSkill requires name', () => {
  assert.throws(() => parseSkill('---\ndescription: b\n---\nx', 'f'), /missing "name"/);
});

test('parseSkill requires description', () => {
  assert.throws(() => parseSkill('---\nname: a\n---\nx', 'f'), /missing "description"/);
});

test('parseSkill rejects non-array globs', () => {
  assert.throws(
    () => parseSkill('---\nname: a\ndescription: b\nglobs: "x"\n---\ny', 'f'),
    /"globs" must be an array/,
  );
});
