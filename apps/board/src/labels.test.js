import { test, expect, afterEach } from 'vitest';
import { eventLabel, ciStateLabel, ciConclusionLabel, ciReasonLabel, CI_UNREACHABLE } from './labels.js';
import { DEFAULT_LOCALE, locale } from './i18n.js';

afterEach(() => { locale.value = DEFAULT_LOCALE; });

test('known codes are translated in the selected language', () => {
  locale.value = 'fr';
  expect(eventLabel('UserPromptSubmit')).toBe('Prompt envoyé');
  expect(ciStateLabel('failure')).toBe('en échec');
  expect(ciConclusionLabel('cancelled')).toBe('annulé');
  expect(ciReasonLabel('status repo not configured')).toBe('dépôt de statut non configuré');
  expect(ciReasonLabel(CI_UNREACHABLE)).toBe('statut CI injoignable');
});

test('unknown codes are shown as they came', () => {
  locale.value = 'de';
  expect(eventLabel('PreCompact')).toBe('PreCompact');
  expect(ciStateLabel('weird')).toBe('weird');
  expect(ciConclusionLabel('action_required')).toBe('action_required');
  expect(ciReasonLabel('git fetch failed: 403')).toBe('git fetch failed: 403');
});

test('missing values render as empty text', () => {
  expect(eventLabel(undefined)).toBe('');
  expect(ciStateLabel(null)).toBe('');
  expect(ciConclusionLabel(null)).toBe('');
  expect(ciReasonLabel(null)).toBe('');
});
