const SUMMARY_FIELDS = ['file_path', 'command', 'pattern', 'url', 'description'];
const SUMMARY_MAX = 120;

/** One-line description of a tool call: its first meaningful input field, cut to 120 characters. */
export function summarizeTool(tool, input) {
  const field = SUMMARY_FIELDS.find((name) => input?.[name]);
  return field ? String(input[field]).slice(0, SUMMARY_MAX) : '';
}

/** Turns one decoded stream-json line into normalized messages. */
function parseClaudeLine(line) {
  if (line.trim() === '') return [];
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [{ kind: 'text', content: line }];
  }
  if (event?.type === 'system' && event.subtype === 'init') return [{ kind: 'session', sessionId: event.session_id ?? null }];
  if (event?.type === 'assistant') {
    const out = [];
    const content = event.message?.content;
    // A malformed block is skipped: one bad event must not break the whole stream.
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text') {
        if (typeof block.text === 'string') out.push({ kind: 'text', content: block.text });
      } else if (block?.type === 'tool_use') {
        const input = block.input ?? {};
        out.push({ kind: 'step', content: { tool: block.name, summary: summarizeTool(block.name, input), input } });
      }
    }
    return out;
  }
  if (event?.type === 'result') {
    return [{
      kind: 'result',
      sessionId: event.session_id ?? null,
      costUsd: event.total_cost_usd ?? null,
      durationMs: event.duration_ms ?? null,
      isError: event.is_error === true,
    }];
  }
  return [];
}

/**
 * Incremental parser for an agent's stdout. Claude Code's stream-json is split
 * into lines and normalized; Copilot's plain output is passed through as text.
 */
export function createStreamParser(provider) {
  if (provider !== 'claude-cli') {
    return { push: (text) => [{ kind: 'text', content: text }], end: () => [] };
  }
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      return lines.flatMap(parseClaudeLine);
    },
    end() {
      const rest = buffer;
      buffer = '';
      return parseClaudeLine(rest);
    },
  };
}
