import { translateOr } from './i18n.js';

// Codes that reach the board from outside it — hook event names, CI states and
// conclusions, server-side reasons — are shown through these, so a known code
// reads in the selected language and an unknown one still reads as sent.

export const CI_UNREACHABLE = 'unreachable';

const CI_REASONS = {
  'status repo not configured': 'ci.reason.notConfigured',
  [CI_UNREACHABLE]: 'ci.reason.unreachable',
};

export function eventLabel(event) {
  return event ? translateOr(`event.${event}`, event) : '';
}

export function ciStateLabel(state) {
  return state ? translateOr(`ci.state.${state}`, state) : '';
}

export function ciConclusionLabel(conclusion) {
  return conclusion ? translateOr(`ci.conclusion.${conclusion}`, conclusion) : '';
}

export function ciReasonLabel(reason) {
  if (!reason) return '';
  return CI_REASONS[reason] ? translateOr(CI_REASONS[reason], reason) : reason;
}
