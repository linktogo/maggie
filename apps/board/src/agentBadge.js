// Which local agent drives a session. Sessions recorded before the board grew
// an agent dimension carry no `agent`, and were all Claude Code ones.
const DEFAULT_AGENT = 'claude';

const LABELS = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot CLI',
};

const PILL = {
  claude: 'bg-agent-claude-soft text-agent-claude-on-soft',
  copilot: 'bg-agent-copilot-soft text-agent-copilot-on-soft',
};

export function agentOf(session) {
  return session?.agent ?? DEFAULT_AGENT;
}

export function agentLabel(agent) {
  return LABELS[agent] ?? agent;
}

export function agentPillClass(agent) {
  return PILL[agent] ?? 'bg-ci-neutral-soft text-ci-neutral-on-soft';
}
