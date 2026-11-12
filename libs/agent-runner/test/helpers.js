import { EventEmitter } from 'node:events';
import { createRunManager } from '../src/run.js';

export function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end(data) { child.input = data; } });
  child.kill = (signal) => { child.killed = signal; };
  return child;
}

export function harness(options = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = fakeChild();
    calls.push({ command, args, opts, child });
    return child;
  };
  const manager = createRunManager({ spawn, now: () => new Date('2026-10-26T10:00:00.000Z'), ...options });
  return { manager, calls };
}
