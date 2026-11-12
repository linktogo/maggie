import claude from './claude.js';
import copilot from './copilot.js';
import cursor from './cursor.js';
import windsurf from './windsurf.js';

const renderers = { claude, copilot, cursor, windsurf };

export function getRenderer(id) {
  const renderer = renderers[id];
  if (!renderer) throw new Error(`Unknown target: ${id}`);
  return renderer;
}

export function knownTargets() {
  return Object.keys(renderers);
}
