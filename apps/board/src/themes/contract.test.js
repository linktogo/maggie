import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The board's vitest config runs under jsdom, whose global `URL` resolves a
// relative path against a `file:` base non-deterministically (sometimes
// returning the base unchanged instead of appending the path) — even after
// importing Node's own URL class to shadow it. Resolving the directory once
// via `fileURLToPath` and joining plain path strings sidesteps that entirely.
const THEMES_DIR = dirname(fileURLToPath(import.meta.url));

// A deliberately dumb parser: theme files are flat lists of declarations, so
// matching `selector { … }` and pulling the custom property names out is
// enough — and it fails loudly if someone nests a rule or hides a brace in a
// comment, which is exactly the discipline these files need.
function blocks(file) {
  const css = readFileSync(join(THEMES_DIR, file), 'utf8');
  const out = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.trim().replace(/\s+/g, ' ').replace(/^[\s\S]*\*\//, '').trim();
    const names = [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();
    if (names.length > 0) out[key] = names;
  }
  return out;
}

const contract = blocks('contract.css');
const CONTRACT = [...contract['@theme'], ...contract[':root']].sort();

const THEMEABLE = ['m3', 'expressive', 'classic'];

test('the contract declares 73 variables', () => {
  expect(CONTRACT).toHaveLength(73);
  expect(new Set(CONTRACT).size).toBe(73);
});

test.each(THEMEABLE)('%s defines the whole contract in light', (name) => {
  const light = blocks(`${name}.css`)[`html[data-theme='${name}']`];
  expect(light).toEqual(CONTRACT);
});

test.each(THEMEABLE)('%s defines the whole contract in dark', (name) => {
  const dark = blocks(`${name}.css`)[`html[data-theme='${name}'][data-mode='dark']`];
  expect(dark).toEqual(CONTRACT);
});

test('legacy defines the whole contract and stays light only', () => {
  const found = blocks('legacy.css');
  expect(Object.keys(found)).toEqual(["html[data-theme='legacy']"]);
  expect(found["html[data-theme='legacy']"]).toEqual(CONTRACT);
});
