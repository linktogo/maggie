import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
  target.cacheReadInputTokens += delta.cacheReadInputTokens;
}

// Every Claude Code hook payload carries transcript_path, a local JSONL file
// where each assistant turn has a message.usage object (and a message.model
// naming which model produced it). board.json never gets token counts from
// the hook payload itself — this is the only source.
export async function readTranscriptUsage(transcriptPath, { read = readFile } = {}) {
  let raw;
  try {
    raw = await read(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY_USAGE, byModel: {} };
  }
  const totals = { ...EMPTY_USAGE };
  const byModel = {};
  const seenMessageIds = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) continue;
    // Claude Code writes one JSONL line per content block (thinking/text/tool_use)
    // of a single API response, repeating the same usage on every line for that
    // response, keyed by the same message.id — count each response's usage once.
    const messageId = entry.message?.id;
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    const delta = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    };
    addUsage(totals, delta);

    // A session can span multiple models if the user switches mid-session;
    // attribute each turn's usage to the model that produced it so cost can
    // be computed per model instead of a single blended rate.
    const model = entry.message?.model;
    if (model) {
      const bucket = byModel[model] ?? { ...EMPTY_USAGE };
      addUsage(bucket, delta);
      byModel[model] = bucket;
    }
  }
  return { ...totals, byModel };
}

// Copilot CLI persists a session as a machine-readable event stream
// (`~/.copilot/session-state/<id>/events.jsonl`, the file `agentStop` hands over
// as transcriptPath). Two shapes carry usage, and both are handled:
//
//  - a per-turn event with `data.usage` plus the model that produced it, which
//    is what exists mid-session while turns are still running;
//  - `session.shutdown` (and any other event carrying `data.modelMetrics`),
//    whose per-model totals are cumulative and authoritative — when one shows
//    up it replaces whatever was accumulated rather than adding to it.
//
// Copilot names its cache counters differently from Claude Code; they are
// mapped onto the board's field names here so board.json stays one shape.
function copilotUsage(usage) {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheWriteTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadTokens ?? 0,
  };
}

function totalsOf(byModel) {
  const totals = { ...EMPTY_USAGE };
  for (const bucket of Object.values(byModel)) addUsage(totals, bucket);
  return totals;
}

export async function readCopilotTranscriptUsage(transcriptPath, { read = readFile } = {}) {
  let raw;
  try {
    raw = await read(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY_USAGE, byModel: {} };
  }
  let byModel = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const metrics = entry?.data?.modelMetrics;
    if (metrics && typeof metrics === 'object') {
      byModel = {};
      for (const [model, payload] of Object.entries(metrics)) {
        if (payload?.usage) byModel[model] = copilotUsage(payload.usage);
      }
      continue;
    }
    const usage = entry?.data?.usage;
    const model = entry?.data?.model ?? entry?.data?.modelId;
    if (!usage || !model) continue;
    const bucket = byModel[model] ?? { ...EMPTY_USAGE };
    addUsage(bucket, copilotUsage(usage));
    byModel[model] = bucket;
  }
  return { ...totalsOf(byModel), byModel };
}

export function resolveHistoryPath(boardPath) {
  return path.join(path.dirname(boardPath), 'history.jsonl');
}

export async function appendHistoryEntry(historyPath, entry, opts = {}) {
  const { append = appendFile, ensureDir = mkdir } = opts;
  await ensureDir(path.dirname(historyPath), { recursive: true });
  await append(historyPath, `${JSON.stringify(entry)}\n`);
}
