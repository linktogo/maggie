import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@linktogo/maggie-retro-doc';
import { AgentError } from './errors.js';

// <techno>/<name>: two plain segments, so an id can never climb out of the skills directory.
const SKILL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

function readSkillFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text.trim();
  return text.slice(end + 4).trim();
}

export function listSkills(skillsDir) {
  const skills = [];
  for (const techno of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!techno.isDirectory()) continue;
    for (const entry of readdirSync(path.join(skillsDir, techno.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const text = readSkillFile(path.join(skillsDir, techno.name, entry.name, 'SKILL.md'));
      if (text === null) continue;
      skills.push({
        id: `${techno.name}/${entry.name}`,
        techno: techno.name,
        name: entry.name,
        description: parseFrontmatter(text).description ?? '',
      });
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadSkill(skillsDir, id) {
  if (typeof id !== 'string' || !SKILL_ID.test(id)) {
    throw new AgentError('invalid', `invalid skill: ${String(id)}`);
  }
  const text = readSkillFile(path.join(skillsDir, ...id.split('/'), 'SKILL.md'));
  if (text === null) throw new AgentError('not-found', `unknown skill: ${id}`);
  return { id, body: stripFrontmatter(text) };
}
