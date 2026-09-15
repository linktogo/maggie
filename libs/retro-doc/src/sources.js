import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_OUT = 'docs/ai/retro-documentation.md';

/** Split output: a front page plus one document per domain, under this directory. */
export const DEFAULT_OUT_DIR = 'docs/ai/retro-doc';

export const DEFAULT_LANG = 'English';

export const DEFAULT_MAX_CHARS = 200000;

export const DEFAULT_WORKSPACE = 'wk';

/** Where specs and plans usually live. Scanned recursively for Markdown. */
export const DEFAULT_ROOTS = [
  'docs/superpowers/specs',
  'docs/superpowers/plans',
  '.superpowers/specs',
  '.superpowers/plans',
  'docs/specs',
  'docs/plans',
  'docs/adr',
  'docs/architecture/decisions',
  'specs',
  'plans',
];

/** Used only when none of DEFAULT_ROOTS exists: any doc named like a spec or a plan. */
export const FALLBACK_ROOT = 'docs';

export const FALLBACK_NAME = /(spec|plan|design|adr|rfc)/i;

const SKIP_DIRS = new Set(['node_modules', '.git', '.nx', 'dist', 'build', 'coverage', 'wk', 'vendor']);

/**
 * The repositories this run could document: the current directory first, then
 * every checkout of the workspace `maggie-workspace` bootstraps into.
 */
export function listRepoCandidates({ cwd = process.cwd(), workspace = DEFAULT_WORKSPACE } = {}) {
  const candidates = [{ name: `${path.basename(path.resolve(cwd))} (current directory)`, path: path.resolve(cwd) }];
  const workspaceDir = path.resolve(cwd, workspace);
  if (existsSync(workspaceDir) && statSync(workspaceDir).isDirectory()) {
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const abs = path.join(workspaceDir, entry.name);
      if (existsSync(path.join(abs, '.git'))) candidates.push({ name: `${entry.name} (${workspace}/)`, path: abs });
    }
  }
  return candidates;
}

/** `--repo` takes a path, or the name of a checkout in the workspace. */
export function resolveRepoArg(value, { cwd = process.cwd(), workspace = DEFAULT_WORKSPACE } = {}) {
  const asPath = path.resolve(cwd, value);
  if (existsSync(asPath)) return asPath;
  const inWorkspace = path.resolve(cwd, workspace, value);
  if (existsSync(inWorkspace)) return inWorkspace;
  return asPath;
}

function walkMarkdown(absDir, repoRoot, accept, found) {
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(abs, repoRoot, accept, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && accept(entry.name)) {
      found.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
    }
  }
}

/**
 * Resolve the spec/plan corpus of a repository, as repo-relative POSIX paths.
 * `include` overrides the default locations; when nothing is configured and no
 * default location exists, fall back to docs/ entries named like a design doc.
 */
export function collectSourceFiles(repoRoot, { include = [] } = {}) {
  const roots = include.length > 0 ? include : DEFAULT_ROOTS;
  const found = [];
  for (const root of roots) {
    const abs = path.resolve(repoRoot, root);
    if (!existsSync(abs)) continue;
    const stats = statSync(abs);
    if (stats.isDirectory()) walkMarkdown(abs, repoRoot, () => true, found);
    else if (abs.toLowerCase().endsWith('.md')) found.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
  }
  if (found.length === 0 && include.length === 0) {
    const abs = path.resolve(repoRoot, FALLBACK_ROOT);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      walkMarkdown(abs, repoRoot, (name) => FALLBACK_NAME.test(name), found);
    }
  }
  return [...new Set(found)].sort();
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fields = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match) fields[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

export function classifyKind(relPath) {
  const lower = relPath.toLowerCase();
  if (lower.includes('/plans/') || lower.startsWith('plans/') || lower.includes('-plan.')) return 'plan';
  if (lower.includes('/adr') || lower.includes('/rfc')) return 'decision-record';
  if (lower.includes('/specs/') || lower.startsWith('specs/') || lower.includes('-design.') || lower.includes('-spec.')) return 'spec';
  return 'design-doc';
}

export function readSource(repoRoot, relPath) {
  const text = readFileSync(path.resolve(repoRoot, relPath), 'utf8');
  const frontmatter = parseFrontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(text);
  const dated = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(relPath));
  return {
    path: relPath,
    kind: classifyKind(relPath),
    title: frontmatter.title || (heading ? heading[1].trim() : path.basename(relPath, '.md')),
    date: dated ? dated[1] : frontmatter.date || null,
    text,
    chars: text.length,
  };
}

/** Read the repository's own front page, so the synthesis knows what it is looking at. */
export function collectRepoContext(repoRoot) {
  const context = { name: path.basename(path.resolve(repoRoot)), description: '', readme: '', entries: [] };
  const manifest = path.resolve(repoRoot, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name) context.name = pkg.name;
      if (pkg.description) context.description = pkg.description;
    } catch {
      /* an unreadable manifest is not worth failing the run over */
    }
  }
  for (const name of ['README.md', 'readme.md']) {
    const abs = path.resolve(repoRoot, name);
    if (existsSync(abs)) {
      context.readme = readFileSync(abs, 'utf8').slice(0, 4000);
      break;
    }
  }
  context.entries = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  return context;
}

/** Group sources into digest calls without ever splitting — or truncating — a document. */
export function planBatches(sources, maxChars = DEFAULT_MAX_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const source of sources) {
    if (current.length > 0 && size + source.chars > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(source);
    size += source.chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Chronological, undated last: the synthesis is told to prefer the recent over the old. */
export function orderSources(sources) {
  return [...sources].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return a.path.localeCompare(b.path);
  });
}
