// Which local agent drives a session. Sessions recorded before the board grew
// an agent dimension carry no `agent`, and were all Claude Code ones.
const DEFAULT_AGENT = 'claude';

const LABELS = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot CLI',
};

const PILL = {
  claude: 'bg-amber-100 text-amber-700',
  copilot: 'bg-sky-100 text-sky-700',
};

export function agentOf(session) {
  return session?.agent ?? DEFAULT_AGENT;
}

export function agentLabel(agent) {
  return LABELS[agent] ?? agent;
}

export function agentPillClass(agent) {
  return PILL[agent] ?? 'bg-slate-200 text-slate-600';
}
