import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// The few xterm.js calls FactoryConsole needs, so the component can be tested
// without a canvas (jsdom has none).
export function createXterm(el, theme) {
  const xterm = new Terminal({ theme, fontFamily: FONT, fontSize: 13, cursorBlink: true });
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(el);
  return {
    get cols() { return xterm.cols; },
    get rows() { return xterm.rows; },
    fit: () => fitAddon.fit(),
    onData: (cb) => xterm.onData(cb),
    write: (bytes) => xterm.write(bytes),
    setTheme: (next) => { xterm.options.theme = next; },
    // A reopened shell starts on a blank screen, without the modes the last one left set.
    clear: () => xterm.reset(),
    focus: () => xterm.focus(),
    dispose: () => xterm.dispose(),
  };
}
