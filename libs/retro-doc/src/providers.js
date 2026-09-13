import { spawn as nodeSpawn } from 'node:child_process';

export const DEFAULT_MODEL = 'claude-opus-5';

export const DEFAULT_PROVIDER = 'claude';

export const PROVIDERS = ['claude', 'claude-cli', 'copilot'];

export const DEFAULT_TIMEOUT_SECONDS = 600;

/** Approximate, for the --dry-run estimate only. USD per million tokens. */
export const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

export function estimateCost(model, inputTokens, outputTokens) {
  const price = PRICING[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

/** How the generator is named in the document header and in --dry-run. */
export function describeProvider({ provider, model = null, providerCommand: override = null }) {
  if (provider === 'claude') return model ?? DEFAULT_MODEL;
  const { command } = providerCommand(provider, { override });
  const name = command === 'copilot' ? 'GitHub Copilot CLI' : `${command} CLI`;
  return model ? `${name} (${model})` : name;
}

/**
 * How each CLI provider is invoked. The prompt goes in on stdin — both CLIs
 * accept it that way — so a 200 000-character batch never has to fit in argv.
 */
export function providerCommand(provider, { model = null, override = null } = {}) {
  if (override) {
    const [command, ...args] = override.split(/\s+/).filter(Boolean);
    return { command, args };
  }
  const modelArgs = model ? ['--model', model] : [];
  if (provider === 'claude-cli') return { command: 'claude', args: ['-p', ...modelArgs] };
  // `--allow-all-tools` is what GitHub documents for non-interactive runs: without
  // it the CLI can stop on an approval prompt no one is there to answer.
  return { command: 'copilot', args: ['--allow-all-tools', ...modelArgs] };
}

export function runCommand({ command, args, input, timeoutMs = 0, spawn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`\`${command}\` produced nothing after ${Math.round(timeoutMs / 1000)}s — raise --timeout or check that it is logged in.`));
        }, timeoutMs)
      : null;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => settle(reject, new Error(`Could not run \`${command}\`: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) settle(resolve, stdout);
      else settle(reject, new Error(`\`${command}\` exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`));
    });
    child.stdin.end(input);
  });
}

/**
 * A `complete` backed by a local agent CLI. Neither CLI takes a system prompt,
 * so it is folded into the message — they are the same instructions either way.
 */
export function createCliComplete({ provider, model = null, override = null, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000, spawn = nodeSpawn }) {
  const { command, args } = providerCommand(provider, { model, override });
  return async ({ system, prompt }) => {
    const stdout = await runCommand({ command, args, input: `${system}\n\n---\n\n${prompt}`, timeoutMs, spawn });
    const text = stdout.trim();
    if (!text) throw new Error(`\`${command}\` returned nothing. Run it once by hand to check it is logged in.`);
    return text;
  };
}

/** The SDK is loaded through this, so a caller that never picks the API provider never pays for it. */
export const loadAnthropicSdk = () => import('@anthropic-ai/sdk');

/** A `complete` backed by the Anthropic API, streamed: the synthesis call is far too long not to be. */
export async function createAnthropicComplete({ model = DEFAULT_MODEL, loadSdk = loadAnthropicSdk } = {}) {
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic();
  return async ({ system, prompt, maxTokens }) => {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error(`The model declined this request (${message.stop_details?.category ?? 'unspecified'}).`);
    }
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  };
}

/** Resolve the provider the run was asked for into a `complete` function. */
export async function createComplete({ provider, model, providerCommand: override = null, timeoutMs, spawn, loadSdk }) {
  if (provider === 'claude') return createAnthropicComplete({ model, loadSdk });
  return createCliComplete({ provider, model, override, timeoutMs, spawn });
}
