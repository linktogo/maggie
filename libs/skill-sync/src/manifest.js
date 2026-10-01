import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_PATH = '.maggie/manifest.json';
const SCHEMA_VERSION = 1;

function isSafeRelativePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  if (path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

export async function readManifest(dir, { warn = console.warn } = {}) {
  const file = path.join(dir, MANIFEST_PATH);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: SCHEMA_VERSION, paths: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`${file}: manifest is not a JSON object, treating as no manifest`);
      return { version: SCHEMA_VERSION, paths: [] };
    }
    const rawPaths = Array.isArray(parsed.paths) ? parsed.paths : [];
    const paths = rawPaths.filter(isSafeRelativePath);
    if (paths.length !== rawPaths.length) {
      warn(`${file}: ignoring ${rawPaths.length - paths.length} unsafe path(s) outside the repo`);
    }
    return { version: parsed.version ?? SCHEMA_VERSION, paths };
  } catch (err) {
    warn(`${file}: invalid JSON, treating as no manifest (${err.message})`);
    return { version: SCHEMA_VERSION, paths: [] };
  }
}

export async function writeManifest(dir, paths) {
  const full = path.join(dir, MANIFEST_PATH);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `${JSON.stringify({ version: SCHEMA_VERSION, paths: [...paths].sort() }, null, 2)}\n`);
}

export function stalePaths(oldPaths, newPaths) {
  const newSet = new Set(newPaths);
  return oldPaths.filter((p) => !newSet.has(p));
}
