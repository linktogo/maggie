import { buildDocument } from '../frontmatter.js';

function applyTo(globs) {
  if (!Array.isArray(globs) || globs.length === 0) return '**';
  return globs.join(',');
}

export default {
  id: 'copilot',
  render(skill) {
    const content = buildDocument(
      { description: skill.description, applyTo: applyTo(skill.globs) },
      skill.body,
      skill.source,
    );
    return { path: `.github/instructions/${skill.name}.instructions.md`, content };
  },
};
