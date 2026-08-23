import { describe, it, expect } from 'vitest';
import { agentOf, agentLabel, agentPillClass } from './agentBadge.js';

describe('agentBadge', () => {
  it('falls back to claude for sessions recorded before the board had an agent dimension', () => {
    expect(agentOf({})).toBe('claude');
    expect(agentOf({ agent: null })).toBe('claude');
    expect(agentOf(undefined)).toBe('claude');
  });

  it('reads the agent a session was recorded with', () => {
    expect(agentOf({ agent: 'copilot' })).toBe('copilot');
  });

  it('labels the known agents and passes an unknown one through', () => {
    expect(agentLabel('claude')).toBe('Claude Code');
    expect(agentLabel('copilot')).toBe('GitHub Copilot CLI');
    expect(agentLabel('cursor')).toBe('cursor');
  });

  it('gives each known agent its own pill, and an unknown one a neutral pill', () => {
    expect(agentPillClass('claude')).toContain('amber');
    expect(agentPillClass('copilot')).toContain('sky');
    expect(agentPillClass('cursor')).toContain('slate');
  });
});
