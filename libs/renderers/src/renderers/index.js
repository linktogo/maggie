import agents from './agents.js';
import claude from './claude.js';
import copilot from './copilot.js';
import cursor from './cursor.js';
import windsurf from './windsurf.js';

const renderers = { agents, claude, copilot, cursor, windsurf };

// Where the supporting files of a skill go for targets whose format is a single file
// (Copilot, Cursor, Windsurf): one shared copy, which the rendered rule points at.
export const SHARED_RESOURCES_DIR = '.maggie/skills';

export function getRenderer(id) {
  const renderer = renderers[id];
  if (!renderer) throw new Error(`Unknown target: ${id}`);
  return renderer;
}

export function knownTargets() {
  return Object.keys(renderers);
}

function withResourceNote(skill, dir) {
  const list = skill.resources.map((resource) => `- \`${dir}/${resource.path}\``).join('\n');
  const note = `## Supporting files\n\nThis skill comes with supporting files; paths it mentions are relative to \`${dir}/\`:\n\n${list}`;
  return { ...skill, body: `${skill.body.trim()}\n\n${note}` };
}

/**
 * Every file a repository gets for `skills` on `targets`, in a stable order: each
 * skill's rendering per target, its supporting files (`skill.resources`, copied next to
 * the skill for directory formats, once under `.maggie/skills/` for single-file ones),
 * and the repository-level index of targets that have one (the AGENTS.md block).
 * A file with a `block` id is a managed block to merge into the file, not the whole file.
 */
export function renderRepo(targets, skills) {
  const files = [];
  const shared = new Set();
  for (const skill of skills) {
    const resources = skill.resources ?? [];
    for (const target of targets) {
      const renderer = getRenderer(target);
      if (resources.length === 0) {
        files.push(renderer.render(skill));
      } else if (renderer.resourceRoot) {
        files.push(renderer.render(skill));
        const root = renderer.resourceRoot(skill);
        for (const resource of resources) files.push({ path: `${root}/${resource.path}`, content: resource.content });
      } else {
        const dir = `${SHARED_RESOURCES_DIR}/${skill.name}`;
        files.push(renderer.render(withResourceNote(skill, dir)));
        for (const resource of resources) {
          const file = `${dir}/${resource.path}`;
          if (shared.has(file)) continue;
          shared.add(file);
          files.push({ path: file, content: resource.content });
        }
      }
    }
  }
  for (const target of targets) {
    const renderer = getRenderer(target);
    if (renderer.renderIndex && skills.length > 0) files.push(renderer.renderIndex(skills));
  }
  return files;
}

export { blockMarkers, mergeBlock, readBlock, removeBlock, renderBlock } from '../block.js';
