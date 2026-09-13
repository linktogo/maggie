import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDERS,
  createAnthropicComplete,
  createCliComplete,
  createComplete,
  describeProvider,
  estimateCost,
  estimateTokens,
  providerCommand,
  runCommand,
} from '../src/providers.js';

/** A spawn stand-in: records the call, then plays back the child process it was told to. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, failWith = null, silent = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    let written = '';
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (data) => { written = data; calls.push({ command, args, options, input: written }); } };
    child.kill = (signal) => calls.push({ killed: signal });
    queueMicrotask(() => {
      if (failWith) return child.emit('error', new Error(failWith));
      if (silent) return;
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('estimateTokens and estimateCost report a price only for a known model', () => {
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateCost('claude-opus-5', 1e6, 1e6), 30);
  assert.equal(estimateCost('some-future-model', 1e6, 1e6), null);
});

test('providerCommand runs the documented command for each CLI provider', () => {
  assert.deepEqual(providerCommand('claude-cli'), { command: 'claude', args: ['-p'] });
  assert.deepEqual(providerCommand('claude-cli', { model: 'claude-opus-5' }), {
    command: 'claude',
    args: ['-p', '--model', 'claude-opus-5'],
  });
  assert.deepEqual(providerCommand('copilot'), { command: 'copilot', args: ['--allow-all-tools'] });
  assert.deepEqual(providerCommand('copilot', { model: 'claude-sonnet-4.5' }), {
    command: 'copilot',
    args: ['--allow-all-tools', '--model', 'claude-sonnet-4.5'],
  });
});

test('providerCommand lets --provider-command replace the command entirely', () => {
  assert.deepEqual(providerCommand('copilot', { model: 'ignored', override: '  /usr/bin/copilot  --banner  off ' }), {
    command: '/usr/bin/copilot',
    args: ['--banner', 'off'],
  });
});

test('describeProvider names the generator that goes in the document header', () => {
  assert.equal(describeProvider({ provider: 'claude' }), DEFAULT_MODEL);
  assert.equal(describeProvider({ provider: 'claude', model: 'claude-sonnet-5' }), 'claude-sonnet-5');
  assert.equal(describeProvider({ provider: 'claude-cli' }), 'claude CLI');
  assert.equal(describeProvider({ provider: 'copilot' }), 'GitHub Copilot CLI');
  assert.equal(describeProvider({ provider: 'copilot', model: 'gpt-5' }), 'GitHub Copilot CLI (gpt-5)');
  assert.equal(describeProvider({ provider: 'copilot', providerCommand: 'gh copilot' }), 'gh CLI');
});

test('runCommand feeds the prompt on stdin and resolves with stdout', async () => {
  const spawn = fakeSpawn({ stdout: 'the answer\n' });
  const out = await runCommand({ command: 'copilot', args: ['--allow-all-tools'], input: 'a prompt', spawn });
  assert.equal(out, 'the answer\n');
  assert.deepEqual(spawn.calls[0].args, ['--allow-all-tools']);
  assert.equal(spawn.calls[0].input, 'a prompt');
  assert.deepEqual(spawn.calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('runCommand reports a non-zero exit with what the command printed on stderr', async () => {
  const spawn = fakeSpawn({ code: 2, stderr: 'not logged in' });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', spawn }),
    /`copilot` exited with code 2: not logged in/,
  );
});

test('runCommand says which command is missing when it cannot be spawned', async () => {
  const spawn = fakeSpawn({ failWith: 'spawn copilot ENOENT' });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', spawn }),
    /Could not run `copilot`: spawn copilot ENOENT/,
  );
});

test('runCommand kills a CLI that never answers, rather than hanging the run', async () => {
  const spawn = fakeSpawn({ silent: true });
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', timeoutMs: 20, spawn }),
    /`copilot` produced nothing after 0s — raise --timeout/,
  );
  assert.ok(spawn.calls.some((call) => call.killed === 'SIGTERM'));
});

test('createCliComplete folds the system prompt into the message the CLI reads', async () => {
  const spawn = fakeSpawn({ stdout: '## Orientation\n\nBody.\n' });
  const complete = createCliComplete({ provider: 'copilot', spawn });
  const answer = await complete({ system: 'SYSTEM RULES', prompt: 'THE DOCUMENTS' });
  assert.equal(answer, '## Orientation\n\nBody.');
  assert.match(spawn.calls[0].input, /SYSTEM RULES[\s\S]*THE DOCUMENTS/);
});

test('createCliComplete refuses an empty answer instead of writing an empty document', async () => {
  const complete = createCliComplete({ provider: 'claude-cli', spawn: fakeSpawn({ stdout: '  \n' }) });
  await assert.rejects(complete({ system: 's', prompt: 'p' }), /`claude` returned nothing/);
});

test('createComplete routes a CLI provider to the CLI, not to the Anthropic SDK', async () => {
  const spawn = fakeSpawn({ stdout: 'done' });
  const complete = await createComplete({ provider: 'copilot', model: null, timeoutMs: 1000, spawn });
  assert.equal(await complete({ system: 's', prompt: 'p' }), 'done');
  assert.equal(spawn.calls[0].command, 'copilot');
});

test('PROVIDERS is what the CLI and the board are allowed to offer', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'claude-cli', 'copilot']);
  assert.equal(DEFAULT_PROVIDER, 'claude');
});

/** An Anthropic SDK stand-in: records the request, plays back one message. */
function fakeSdk(message) {
  const requests = [];
  const loadSdk = async () => ({
    default: class {
      constructor() {
        this.messages = {
          stream: (request) => {
            requests.push(request);
            return { finalMessage: async () => message };
          },
        };
      }
    },
  });
  loadSdk.requests = requests;
  return loadSdk;
}

test('createAnthropicComplete streams the request and joins the text blocks it gets back', async () => {
  const loadSdk = fakeSdk({
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'not part of the document' },
      { type: 'text', text: '## Orientation\n\n' },
      { type: 'text', text: 'Body.\n' },
    ],
  });
  const complete = await createAnthropicComplete({ loadSdk });
  const answer = await complete({ system: 'RULES', prompt: 'DOCUMENTS', maxTokens: 64000 });

  assert.equal(answer, '## Orientation\n\nBody.');
  assert.deepEqual(loadSdk.requests[0], {
    model: DEFAULT_MODEL,
    max_tokens: 64000,
    system: 'RULES',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'DOCUMENTS' }],
  });
});

test('createAnthropicComplete asks for the model it was given', async () => {
  const loadSdk = fakeSdk({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  const complete = await createAnthropicComplete({ model: 'claude-sonnet-5', loadSdk });
  await complete({ system: 's', prompt: 'p', maxTokens: 16000 });
  assert.equal(loadSdk.requests[0].model, 'claude-sonnet-5');
});

test('createAnthropicComplete reports a refusal instead of writing an empty document', async () => {
  const refused = await createAnthropicComplete({
    loadSdk: fakeSdk({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
  });
  await assert.rejects(refused({ system: 's', prompt: 'p', maxTokens: 10 }), /The model declined this request \(cyber\)/);

  const unexplained = await createAnthropicComplete({
    loadSdk: fakeSdk({ stop_reason: 'refusal', content: [] }),
  });
  await assert.rejects(unexplained({ system: 's', prompt: 'p', maxTokens: 10 }), /\(unspecified\)/);
});

test('createComplete routes the API provider to the SDK', async () => {
  const loadSdk = fakeSdk({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'from the API' }] });
  const complete = await createComplete({ provider: 'claude', model: 'claude-opus-5', loadSdk });
  assert.equal(await complete({ system: 's', prompt: 'p', maxTokens: 10 }), 'from the API');
  assert.equal(loadSdk.requests.length, 1);
});

test('runCommand reports a bare non-zero exit, with nothing to quote from stderr', async () => {
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', spawn: fakeSpawn({ code: 1 }) }),
    /`copilot` exited with code 1$/,
  );
});

test('runCommand really does spawn a process and feed it stdin', async () => {
  const out = await runCommand({
    command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    input: 'round trip',
  });
  assert.equal(out, 'round trip');
});

test('createCliComplete runs the command for real when nothing is injected', async () => {
  const complete = createCliComplete({
    provider: 'copilot',
    override: `${process.execPath} -e process.stdout.write("##Orientation")`,
  });
  assert.equal(await complete({ system: 's', prompt: 'p' }), '##Orientation');
});

test('createAnthropicComplete loads the SDK itself when no loader is injected', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key-nothing-is-sent';
  try {
    assert.equal(typeof (await createAnthropicComplete()), 'function');
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('runCommand ignores a CLI that finishes after it was already given up on', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => child.emit('close', 0), 30);
    return child;
  };
  await assert.rejects(
    runCommand({ command: 'copilot', args: [], input: 'x', timeoutMs: 5, spawn }),
    /produced nothing after/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
});
