import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSkill } from './skill.js';

// Directories of a skill that belong to the skills library, not to the repositories:
// `evals/` holds the cases `maggie eval` runs, and is never rendered.
const LIBRARY_ONLY = new Set(['evals']);

/**
 * The supporting files of a skill (scripts, references, assets: everything in its
 * directory but SKILL.md, `evals/` and dotfiles), as POSIX paths relative to it, sorted.
 */
export async function loadResources(skillDir) {
  const files = new Map();
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && (entry.name === 'SKILL.md' || LIBRARY_ONLY.has(entry.name))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.set(rel, await readFile(full));
    }
  }
  await walk(skillDir, '');
  return [...files.keys()].sort().map((rel) => ({ path: rel, content: files.get(rel) }));
}

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
      const skillDir = path.join(technoDir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const skill = parseSkill(await readFile(skillFile, 'utf8'), skillFile);
      skill.source = `skills/${techno}/${entry.name}/SKILL.md`;
      skill.dir = skillDir;
      skill.resources = await loadResources(skillDir);
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
