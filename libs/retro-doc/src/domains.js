// A repository's design record does not divide itself into domains — the model
// is asked to propose them, and this module is what refuses to trust the answer
// blindly: an LLM asked for JSON returns JSON *most* of the time.

export const OVERVIEW_SLUG = 'overview';

export function slugify(value, fallback = 'domain') {
  const slug = String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** The single domain a repository has when the plan could not be read. */
export function wholeRepository(sources) {
  return [{
    slug: OVERVIEW_SLUG,
    title: 'The repository as a whole',
    summary: 'The design record could not be split into domains, so it is documented in one piece.',
    sources: sources.map((source) => source.path),
  }];
}

/** Pull the first JSON array out of an answer that may be fenced, prefaced, or both. */
export function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    // The slice runs from "[" to "]", so a successful parse is always an array.
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Turn the planning answer into domains we are willing to write files for:
 * unique slugs, a title, and only source paths that actually exist. Anything
 * unusable falls back to documenting the repository in one piece, because an
 * unreadable plan is not a reason to fail a run that has already paid for its
 * digests.
 */
export function parseDomains(answer, sources, { max = 8 } = {}) {
  const known = new Map(sources.map((source) => [source.path, source]));
  const entries = extractJsonArray(String(answer ?? '')) ?? [];
  const taken = new Set();
  const domains = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) continue;
    let slug = slugify(entry.slug || title, `domain-${domains.length + 1}`);
    while (taken.has(slug)) slug = `${slug}-${taken.size + 1}`;
    taken.add(slug);
    domains.push({
      slug,
      title,
      summary: typeof entry.summary === 'string' ? entry.summary.trim() : '',
      sources: (Array.isArray(entry.sources) ? entry.sources : []).filter((file) => known.has(file)),
    });
    if (domains.length === max) break;
  }

  if (domains.length === 0) return wholeRepository(sources);

  // A document nobody claimed would silently vanish from the output, so it is
  // handed to the domain that already carries the most of its neighbours.
  const claimed = new Set(domains.flatMap((domain) => domain.sources));
  const orphans = sources.filter((source) => !claimed.has(source.path)).map((source) => source.path);
  if (orphans.length > 0) {
    const widest = domains.reduce((best, domain) => (domain.sources.length > best.sources.length ? domain : best), domains[0]);
    widest.sources = [...widest.sources, ...orphans];
  }
  return domains;
}
