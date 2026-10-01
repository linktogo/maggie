import { buildDocument } from '../frontmatter.js';

export default {
  id: 'windsurf',
  render(skill) {
    const hasGlobs = Array.isArray(skill.globs) && skill.globs.length > 0;
    const frontmatter = hasGlobs
      ? { description: skill.description, globs: skill.globs.join(',') }
      : { description: skill.description };
    const content = buildDocument(frontmatter, skill.body, skill.source);
    return { path: `.windsurf/rules/${skill.name}.md`, content };
  },
};
