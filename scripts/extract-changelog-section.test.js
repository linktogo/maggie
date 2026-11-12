import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChangelogSection } from './extract-changelog-section.js';

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- nothing yet',
  '',
  '## [0.2.0] - 2026-08-10',
  '',
  '### Added',
  '',
  '- Thing one.',
  '- Thing two.',
  '',
  '## [0.1.0]',
  '',
  'Initial release.',
  '',
  '[Unreleased]: https://github.com/linktogo/maggie/compare/v0.2.0...HEAD',
].join('\n');

test('extractChangelogSection returns the body between two headings', () => {
  const out = extractChangelogSection(SAMPLE, '0.2.0');
  assert.equal(out, '### Added\n\n- Thing one.\n- Thing two.\n');
});

test('extractChangelogSection stops before the trailing link-reference block', () => {
  const out = extractChangelogSection(SAMPLE, '0.1.0');
  assert.equal(out, 'Initial release.\n');
});

test('extractChangelogSection throws for a version with no section', () => {
  assert.throws(() => extractChangelogSection(SAMPLE, '9.9.9'), /no section for 9\.9\.9/);
});
