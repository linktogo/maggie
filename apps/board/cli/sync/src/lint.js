import { parseArgs } from 'node:util';
import { lintLibrary, formatFindings } from '@linktogo/maggie-skill-sync';
import { resolveSkillsDir } from './main.js';

// `maggie lint`: scan the skills library before it reaches any repository.
// Exits 1 on an error-level finding (on any finding with --strict).
export async function lintMain(argv, { lint = lintLibrary, logger = console, cwd, exists } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      skills: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const skillsDir = resolveSkillsDir(values.skills, { cwd, exists });
  const findings = await lint(skillsDir);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;

  if (values.json) {
    logger.log(JSON.stringify({ skillsDir, errors, warnings, findings }, null, 2));
  } else {
    for (const line of formatFindings(findings)) logger.log(line);
    logger.log(findings.length === 0
      ? `✓ ${skillsDir}: no findings`
      : `${errors} error(s), ${warnings} warning(s) in ${skillsDir}`);
  }
  return errors > 0 || (values.strict && warnings > 0) ? 1 : 0;
}
