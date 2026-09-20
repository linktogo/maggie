import { buildDocument } from '../frontmatter.js';

export default {
  id: 'claude',
  render(skill) {
    const content = buildDocument(
      { name: skill.name, description: skill.description },
      skill.body,
      skill.source,
    );
    return { path: `.claude/skills/${skill.name}/SKILL.md`, content };
  },
};
