import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_PATH = '.maggie/manifest.json';
const SCHEMA_VERSION = 1;
const BLOCK_ID = /^[a-z0-9][a-z0-9-]*$/;

const empty = () => ({ version: SCHEMA_VERSION, paths: [], blocks: [] });

function isSafeRelativePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  if (path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function isSafeBlock(candidate) {
  return candidate !== null && typeof candidate === 'object'
    && isSafeRelativePath(candidate.path) && typeof candidate.id === 'string' && BLOCK_ID.test(candidate.id);
}

/**
 * The manifest maggie left in a checkout: the files it generated (`paths`) and the
 * managed blocks it owns inside hand-written files (`blocks`, `{ path, id }`).
 */
export async function readManifest(dir, { warn = console.warn } = {}) {
  const file = path.join(dir, MANIFEST_PATH);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return empty();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`${file}: manifest is not a JSON object, treating as no manifest`);
      return empty();
    }
    const rawPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
    const paths = rawPaths.filter(isSafeRelativePath);
    const rawBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
    const blocks = rawBlocks.filter(isSafeBlock).map(({ path: p, id }) => ({ path: p, id }));
    const unsafe = rawPaths.length - paths.length + rawBlocks.length - blocks.length;
    if (unsafe > 0) {
      warn(`${file}: ignoring ${unsafe} unsafe path(s) outside the repo`);
    }
    return { version: parsed.version ?? SCHEMA_VERSION, paths, blocks };
  } catch (err) {
    warn(`${file}: invalid JSON, treating as no manifest (${err.message})`);
    return empty();
  }
}

const blockKey = (block) => `${block.path}#${block.id}`;

export async function writeManifest(dir, paths, blocks = []) {
  const full = path.join(dir, MANIFEST_PATH);
  await mkdir(path.dirname(full), { recursive: true });
  const byKey = new Map(blocks.map((block) => [blockKey(block), { path: block.path, id: block.id }]));
  const sortedBlocks = [...byKey.keys()].sort().map((key) => byKey.get(key));
  const body = { version: SCHEMA_VERSION, paths: [...paths].sort(), blocks: sortedBlocks };
  await writeFile(full, `${JSON.stringify(body, null, 2)}\n`);
}

export function stalePaths(oldPaths, newPaths) {
  const newSet = new Set(newPaths);
  return oldPaths.filter((p) => !newSet.has(p));
}

export function staleBlocks(oldBlocks, newBlocks) {
  const newSet = new Set(newBlocks.map(blockKey));
  return oldBlocks.filter((block) => !newSet.has(blockKey(block)));
}
