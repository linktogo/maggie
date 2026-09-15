import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = {
  'm3 light': ["m3.css", "html[data-theme='m3']"],
  'm3 dark': ["m3.css", "html[data-theme='m3'][data-mode='dark']"],
  'expressive light': ["expressive.css", "html[data-theme='expressive']"],
  'expressive dark': ["expressive.css", "html[data-theme='expressive'][data-mode='dark']"],
  'classic light': ["classic.css", "html[data-theme='classic']"],
  'classic dark': ["classic.css", "html[data-theme='classic'][data-mode='dark']"],
  legacy: ["legacy.css", "html[data-theme='legacy']"],
};

// Text on its own surface, and every "ink on its own fill" pair the board
// renders. `min` is the WCAG AA ratio: 4.5 for body text, 3 for the faint
// placeholder and empty-state ink, which never carries unique information.
const PAIRS = [
  ['--color-ink', '--color-surface', 4.5],
  ['--color-ink-strong', '--color-surface', 4.5],
  ['--color-ink-soft', '--color-surface', 4.5],
  ['--color-ink-muted', '--color-surface', 4.5],
  ['--color-ink-faint', '--color-surface', 3],
  ['--color-ink', '--color-surface-muted', 4.5],
  ['--color-ink-muted', '--color-panel', 4.5],
  ['--color-on-accent', '--color-accent', 4.5],
  ['--color-on-accent-soft', '--color-accent-soft', 4.5],
  ['--color-todo-on-soft', '--color-todo-soft', 4.5],
  ['--color-inprogress-on-soft', '--color-inprogress-soft', 4.5],
  ['--color-question-on-soft', '--color-question-soft', 4.5],
  ['--color-done-on-soft', '--color-done-soft', 4.5],
  ['--color-on-status', '--color-todo-solid', 4.5],
  ['--color-on-status', '--color-inprogress-solid', 4.5],
  ['--color-on-status', '--color-question-solid', 4.5],
  ['--color-on-status', '--color-done-solid', 4.5],
  ['--color-ci-failure-on-soft', '--color-ci-failure-soft', 4.5],
  ['--color-ci-running-on-soft', '--color-ci-running-soft', 4.5],
  ['--color-ci-neutral-on-soft', '--color-ci-neutral-soft', 4.5],
  ['--color-ci-success-on-soft', '--color-ci-success-soft', 4.5],
  ['--color-agent-claude-on-soft', '--color-agent-claude-soft', 4.5],
  ['--color-agent-copilot-on-soft', '--color-agent-copilot-soft', 4.5],
  ['--color-worktree-on-soft', '--color-worktree-soft', 4.5],
];

// legacy is frozen (apps/board/src/themes/legacy.css: "Do not improve
// anything in it — a shade that moves is a migration bug", acceptance is
// pixel parity with docs/images/board/) so its values cannot move to satisfy
// a gate that did not exist when they were chosen. Three of its pairs sit
// below the bar; each is named here rather than hidden behind a lowered
// threshold:
//  - placeholder ink (slate-400 on white, ~2.7:1) — the one the plan named.
//  - white --color-on-status on --color-question-solid (amber-600, ~3.2:1)
//    and on --color-done-solid (emerald-600, ~3.65:1) — the live board's
//    filled status pills already render this today (legacy.css is a
//    transcription of what ships now, per Task 4), so this gate surfaces a
//    pre-existing contrast shortfall rather than one this feature
//    introduced; freezing forbids fixing it here.
const EXEMPT = new Set([
  'legacy|--color-ink-faint|--color-surface',
  'legacy|--color-on-status|--color-question-solid',
  'legacy|--color-on-status|--color-done-solid',
]);

// Same jsdom caveat as themes/contract.test.js: resolve the directory once
// through fileURLToPath rather than letting jsdom's URL resolve a relative
// path against a file: base.
const THEMES_DIR = dirname(fileURLToPath(import.meta.url));

function declarations(file, selector) {
  const css = readFileSync(join(THEMES_DIR, file), 'utf8');
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.trim().replace(/\s+/g, ' ').replace(/^[\s\S]*\*\//, '').trim() !== selector) continue;
    const out = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
    return out;
  }
  throw new Error(`no block ${selector} in ${file}`);
}

// Accepts #rgb, #rrggbb and rgb(r g b / a); alpha is composited over `over`,
// because that is what the eye sees. Classic's inks are black at 87%, 60%…
function parse(value, over = [255, 255, 255]) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i);
  if (!rgb) throw new Error(`cannot parse color: ${value}`);
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
  const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  return [r, g, b].map((c, i) => Math.round(c * a + over[i] * (1 - a)));
}

function luminance([r, g, b]) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test.each(Object.entries(FILES))('%s meets AA on every pair it renders', (name, [file, selector]) => {
  const vars = declarations(file, selector);
  const ground = parse(vars['--color-ground']);
  const failures = [];

  for (const [ink, surface, min] of PAIRS) {
    if (EXEMPT.has(`${name.split(' ')[0]}|${ink}|${surface}`)) continue;
    const bg = parse(vars[surface], ground);
    const ratio = contrast(parse(vars[ink], bg), bg);
    if (ratio < min) failures.push(`${ink} on ${surface}: ${ratio.toFixed(2)}:1 (needs ${min})`);
  }

  expect(failures).toEqual([]);
});
