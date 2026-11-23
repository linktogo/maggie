import { parseArgs } from 'node:util';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EVAL_TIMEOUT_MS, evaluateSkill as defaultEvaluate, formatReport, loadEvals as defaultLoadEvals,
  resolveSkills as defaultResolveSkills,
} from '@linktogo/maggie-skill-sync';
import { resolveSkillsDir } from './main.js';

async function technologies(skillsDir) {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

function positiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got ${value}`);
  return n;
}

// `maggie eval`: run the evals of the skills library (or of `--skill <name>`) with a real
// agent, each case without and with the skill, and report what the skill changes.
export async function evalMain(argv, deps = {}) {
  const {
    evaluateSkill = defaultEvaluate,
    loadEvals = defaultLoadEvals,
    resolveSkills = defaultResolveSkills,
    listTechnologies = technologies,
    logger = console,
    cwd,
    exists,
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: {
      skills: { type: 'string' },
      skill: { type: 'string', multiple: true },
      agent: { type: 'string', default: 'claude-cli' },
      model: { type: 'string' },
      runs: { type: 'string', default: '1' },
      timeout: { type: 'string', default: String(DEFAULT_EVAL_TIMEOUT_MS / 1000) },
      'work-dir': { type: 'string' },
      keep: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'fail-on-regression': { type: 'boolean', default: false },
    },
  });
  const runs = positiveInteger(values.runs, '--runs');
  const timeoutMs = positiveInteger(values.timeout, '--timeout') * 1000;
  const skillsDir = resolveSkillsDir(values.skills, { cwd, exists });
  const wanted = values.skill ?? null;

  const skills = await resolveSkills(skillsDir, await listTechnologies(skillsDir), { warn: () => {} });
  const selected = wanted ? skills.filter((s) => wanted.includes(s.name)) : skills;
  const unknown = (wanted ?? []).filter((name) => !skills.some((s) => s.name === name));
  if (unknown.length > 0) throw new Error(`no such skill in ${skillsDir}: ${unknown.join(', ')}`);

  const reports = [];
  for (const skill of selected) {
    const cases = await loadEvals(skill.dir);
    if (cases.length === 0) {
      if (wanted) logger.log(`- ${skill.name}: no evals (add ${path.join(skill.dir, 'evals')}/<case>.json)`);
      continue;
    }
    reports.push(await evaluateSkill(skill, cases, {
      agent: values.agent,
      model: values.model ?? null,
      runs,
      timeoutMs,
      workDir: values['work-dir'] ? path.resolve(cwd ?? process.cwd(), values['work-dir']) : os.tmpdir(),
      keep: values.keep,
      logger: values.json ? { log() {} } : logger,
    }));
  }

  if (values.json) {
    logger.log(JSON.stringify({ skillsDir, reports }, null, 2));
  } else if (reports.length === 0) {
    logger.log(`no skill with evals in ${skillsDir}`);
  } else {
    for (const report of reports) for (const line of formatReport(report)) logger.log(line);
  }
  return values['fail-on-regression'] && reports.some((r) => r.delta < 0) ? 1 : 0;
}
