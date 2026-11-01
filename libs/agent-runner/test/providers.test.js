import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentError } from '../src/errors.js';
import {
  AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER, commandFor, detectProviders, findOnPath, resolveProvider, validateModel,
} from '../src/providers.js';

test('two CLI providers are offered, Claude Code first', () => {
  assert.deepEqual(AGENT_PROVIDERS, ['claude-cli', 'copilot']);
  assert.equal(DEFAULT_AGENT_PROVIDER, 'claude-cli');
});

test('commandFor builds the CLI invocation, the prompt travelling on stdin', () => {
  assert.deepEqual(commandFor('claude-cli'), { command: 'claude', args: ['-p'] });
  assert.deepEqual(commandFor('claude-cli', 'sonnet'), { command: 'claude', args: ['-p', '--model', 'sonnet'] });
  assert.deepEqual(commandFor('copilot'), { command: 'copilot', args: ['--allow-all-tools'] });
});

test('findOnPath returns the first PATH entry holding an executable', () => {
  const access = (file) => { if (file !== path.join('/b', 'claude')) throw new Error('ENOENT'); };
  assert.equal(findOnPath('claude', { env: { PATH: '/a:/b' }, platform: 'linux', access }), path.join('/b', 'claude'));
});

test('findOnPath returns null when nothing matches or PATH is unset', () => {
  const access = () => { throw new Error('ENOENT'); };
  assert.equal(findOnPath('claude', { env: { PATH: '/a:/b' }, platform: 'linux', access }), null);
  assert.equal(findOnPath('claude', { env: {}, platform: 'linux', access }), null);
});

test('findOnPath tries the PATHEXT extensions on Windows', () => {
  const access = (file) => { if (!file.endsWith('claude.CMD')) throw new Error('ENOENT'); };
  const found = findOnPath('claude', { env: { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' }, platform: 'win32', access });
  assert.ok(found.endsWith('claude.CMD'));
});

test('findOnPath falls back to .EXE and .CMD when PATHEXT is unset on Windows', () => {
  const access = (file) => { if (!file.endsWith('claude.EXE')) throw new Error('ENOENT'); };
  const found = findOnPath('claude', { env: { PATH: 'C:\\a' }, platform: 'win32', access });
  assert.ok(found.endsWith('claude.EXE'));
});

test('findOnPath checks the real file system by default', () => {
  const found = findOnPath(path.parse(process.execPath).name, {
    env: { PATH: path.dirname(process.execPath), PATHEXT: path.extname(process.execPath) },
  });
  assert.notEqual(found, null);
});

test('detectProviders lists the providers whose CLI is installed', () => {
  const access = (file) => { if (!file.endsWith(`${path.sep}copilot`)) throw new Error('ENOENT'); };
  assert.deepEqual(detectProviders({ env: { PATH: '/bin' }, platform: 'linux', access }), ['copilot']);
});

test('detectProviders reads the real environment by default', () => {
  assert.ok(Array.isArray(detectProviders()));
});

test('resolveProvider prefers the requested provider, then the fallback', () => {
  assert.equal(resolveProvider({ requested: 'copilot', fallback: 'claude-cli' }), 'copilot');
  assert.equal(resolveProvider({ requested: undefined, fallback: 'claude-cli' }), 'claude-cli');
  assert.equal(resolveProvider({ requested: null, fallback: 'copilot' }), 'copilot');
});

test('resolveProvider refuses anything that is not a CLI provider', () => {
  assert.throws(() => resolveProvider({ requested: 'claude', fallback: 'claude-cli' }), (err) => {
    assert.ok(err instanceof AgentError);
    assert.equal(err.code, 'invalid');
    assert.match(err.message, /unknown provider: claude/);
    return true;
  });
});

test('validateModel accepts an identifier and nothing that could read as an option', () => {
  assert.equal(validateModel(undefined), null);
  assert.equal(validateModel(null), null);
  assert.equal(validateModel('claude-opus-5'), 'claude-opus-5');
  for (const bad of ['--allow-all-tools', '', 42, 'a b']) {
    assert.throws(() => validateModel(bad), (err) => err instanceof AgentError && err.code === 'invalid');
  }
});
