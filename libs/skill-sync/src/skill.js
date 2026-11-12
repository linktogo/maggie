import matter from 'gray-matter';

export function parseSkill(content, source) {
  const { data, content: body } = matter(content);
  if (!data.name) throw new Error(`${source}: skill frontmatter missing "name"`);
  if (!data.description) throw new Error(`${source}: skill frontmatter missing "description"`);
  let globs;
  if (data.globs !== undefined) {
    if (!Array.isArray(data.globs)) {
      throw new Error(`${source}: "globs" must be an array`);
    }
    globs = data.globs;
  }
  return { name: data.name, description: data.description, globs, body: body.trim() };
}
