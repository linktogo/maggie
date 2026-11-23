import { buildDocument } from '../frontmatter.js';

// The Agent Skills open standard (agentskills.io): one directory per skill under
// `.agents/skills/`, read by Codex, Gemini CLI, OpenCode, Goose and the other agents
// that follow it. The standard wants the directory named after the skill.
export const SKILLS_DIR = '.agents/skills';

// A Markdown table cell: one line, with backslashes escaped before the pipes they
// would otherwise un-escape (a trailing `\` would swallow the column separator).
function cell(text) {
  return String(text).replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export default {
  id: 'agents',
  resourceRoot(skill) {
    return `${SKILLS_DIR}/${skill.name}`;
  },
  render(skill) {
    const content = buildDocument(
      { name: skill.name, description: skill.description },
      skill.body,
      skill.source,
    );
    return { path: `${SKILLS_DIR}/${skill.name}/SKILL.md`, content };
  },
  // The repository-level index, written as a managed block of AGENTS.md so that whatever
  // the team wrote around it is kept. An agent reading AGENTS.md learns which skills exist
  // and where they are, without having to discover the directory on its own.
  renderIndex(skills) {
    const rows = [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `| [\`${skill.name}\`](${SKILLS_DIR}/${skill.name}/SKILL.md) | ${cell(skill.description)} |`);
    const content = [
      '## Agent skills',
      '',
      `This repository ships agent skills in \`${SKILLS_DIR}/\`. Before a task, read the`,
      '`SKILL.md` of every skill whose description matches it, and follow it.',
      '',
      '| Skill | When to use it |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
    return { path: 'AGENTS.md', block: 'skills', content };
  },
};
