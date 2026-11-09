import { test, expect, vi } from 'vitest';

const instances = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this.calls = [];
      instances.push(this);
    }

    loadAddon(addon) { this.addon = addon; }

    open(el) { this.el = el; }

    onData(cb) { this.dataCb = cb; }

    write(data) { this.calls.push(['write', data]); }

    clear() { this.calls.push(['clear']); }

    reset() { this.calls.push(['reset']); }

    focus() { this.calls.push(['focus']); }

    dispose() { this.calls.push(['dispose']); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { this.fitted = (this.fitted ?? 0) + 1; }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { createXterm } = await import('./xtermAdapter.js');

test('createXterm opens an xterm with the fit addon in the element, with the theme', () => {
  const el = document.createElement('div');
  const theme = { background: '#fff' };
  const term = createXterm(el, theme);
  const [xterm] = instances;
  expect(xterm.el).toBe(el);
  expect(xterm.options).toMatchObject({ theme, cursorBlink: true });
  expect(xterm.options.fontFamily).toMatch(/monospace/);
  term.fit();
  expect(xterm.addon.fitted).toBe(1);
  expect([term.cols, term.rows]).toEqual([80, 24]);
});

test('the adapter forwards data, writes, theme, clear, focus and dispose', () => {
  const term = createXterm(document.createElement('div'), {});
  const xterm = instances.at(-1);
  const typed = [];
  term.onData((d) => typed.push(d));
  xterm.dataCb('ls');
  term.write(new Uint8Array([1]));
  term.setTheme({ background: '#000' });
  term.clear();
  term.focus();
  term.dispose();
  expect(typed).toEqual(['ls']);
  expect(xterm.options.theme).toEqual({ background: '#000' });
  expect(xterm.calls).toEqual([['write', new Uint8Array([1])], ['reset'], ['focus'], ['dispose']]);
});
