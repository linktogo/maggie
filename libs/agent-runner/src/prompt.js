import { AgentError } from './errors.js';

export const MAX_PROMPT_CHARS = 100_000;

/** The text written to the agent's stdin: a free prompt, a skill, or a skill applied to a task. */
export function buildPrompt({ prompt, skill = null }) {
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') {
    throw new AgentError('invalid', 'prompt must be a string');
  }
  const task = (prompt ?? '').trim();
  if (task.length > MAX_PROMPT_CHARS) {
    throw new AgentError('invalid', `prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  }
  if (!skill && !task) throw new AgentError('invalid', 'a prompt or a skill is required');
  if (!skill) return task;
  const head = `Apply the following skill to this repository.\n\n${skill.body}`;
  return task ? `${head}\n\n---\n\nTask:\n${task}` : head;
}
