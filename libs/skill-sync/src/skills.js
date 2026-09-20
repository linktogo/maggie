import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSkill } from './skill.js';

export async function resolveSkills(skillsDir, technologies, { warn = console.warn, strict = false } = {}) {
  const byName = new Map();
  const collisions = [];
  for (const techno of technologies) {
    const technoDir = path.join(skillsDir, techno);
    let entries;
    try {
      entries = await readdir(technoDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        const message = `No skills directory for technology "${techno}" (${technoDir})`;
        if (strict) throw new Error(message, { cause: err });
        warn(message);
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(technoDir, entry.name, 'SKILL.md');
      const skill = parseSkill(await readFile(skillFile, 'utf8'), skillFile);
      skill.source = `skills/${techno}/${entry.name}/SKILL.md`;
      const existing = byName.get(skill.name);
      if (existing && existing.techno !== techno) {
        const message = `Skill "${skill.name}" is defined by both "${existing.techno}" and "${techno}"; using ${skillFile} (last technology wins)`;
        if (strict) {
          collisions.push(message);
        } else {
          warn(message);
        }
      }
      byName.set(skill.name, { skill, techno });
    }
  }
  if (collisions.length > 0) {
    throw new Error(collisions.join('\n'));
  }
  return [...byName.values()].map((entry) => entry.skill);
}
