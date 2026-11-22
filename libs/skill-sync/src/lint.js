import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { loadResources } from './skills.js';

// Deterministic checks on the skills library, before anything is rendered into a
// repository. A skill runs with the agent's full permissions in every repository it
// is synced to, so the library is scanned like a dependency: structure (what the
// Agent Skills standard requires), secrets, and the patterns of the published skill
// supply-chain attacks (remote code piped to a shell, instructions hidden from the
// reader or aimed at the user's back, credential access).
//
// A finding is silenced by naming its rule in a comment on the same line or the line
// above: `<!-- maggie-lint-ignore pipe-to-shell -->` (or `# maggie-lint-ignore ...`
// in a script). Silencing is per rule, never blanket.

export const RULES = {
  'missing-skill-file': { severity: 'error', summary: 'a skill directory without a SKILL.md' },
  'invalid-frontmatter': { severity: 'error', summary: 'SKILL.md frontmatter that does not parse or misses name/description' },
  'name-format': { severity: 'error', summary: 'a name that is not 1-64 lowercase letters, digits and single hyphens' },
  'description-length': { severity: 'error', summary: 'a description longer than 1024 characters' },
  'duplicate-name': { severity: 'error', summary: 'two skills with the same name' },
  secret: { severity: 'error', summary: 'what looks like a credential (cloud key, token, private key)' },
  'pipe-to-shell': { severity: 'error', summary: 'remote or encoded content piped into a shell' },
  'prompt-injection': { severity: 'error', summary: 'instructions to override earlier ones or to act behind the user\'s back' },
  'hidden-unicode': { severity: 'error', summary: 'invisible or bidirectional characters that hide text from a reviewer' },
  'credential-access': { severity: 'warning', summary: 'a reference to credential files (SSH keys, cloud credentials, .netrc)' },
  'dangerous-command': { severity: 'warning', summary: 'a destructive or safety-bypassing command' },
  'insecure-url': { severity: 'warning', summary: 'a plain-http or raw-IP URL' },
  'html-comment': { severity: 'warning', summary: 'an HTML comment, invisible in rendered Markdown, in a SKILL.md' },
};

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

const LINE_RULES = [
  ['secret', [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  ]],
  ['pipe-to-shell', [
    /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i,
    /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(iex|Invoke-Expression)\b/i,
    /\bbase64\s+(-d|--decode)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
  ]],
  ['prompt-injection', [
    /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions|rules|prompts?|directions|guidelines)\b/i,
    /\b(do\s+not|don't|never)\s+(tell|inform|notify|alert|show)\s+the\s+user\b/i,
    /\bwithout\s+(telling|informing|asking|notifying|alerting)\s+the\s+user\b/i,
    /\byou\s+are\s+now\s+in\s+(developer|jailbreak|god|dan)\s+mode\b/i,
  ]],
  ['hidden-unicode', [/[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u]],
  ['credential-access', [
    /~\/\.ssh\b|\bid_(rsa|ecdsa|ed25519)\b/,
    /~\/\.aws\/credentials\b|~\/\.config\/gcloud\b|~\/\.netrc\b|\.git-credentials\b|\/etc\/shadow\b/,
  ]],
  ['dangerous-command', [
    /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~\/?|\$HOME\/?)(\s|$|\*)/,
    /--dangerously-skip-permissions\b/,
    /\bchmod\s+(-R\s+)?777\b/,
    /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)[^\n]*\b(main|master)\b/,
  ]],
  ['insecure-url', [
    /\bhttp:\/\/(?!localhost\b|127\.0\.0\.1\b|0\.0\.0\.0\b|\[::1\])/i,
    /\bhttps?:\/\/(?!127\.)\d{1,3}(\.\d{1,3}){3}\b/i,
  ]],
];

const IGNORE = /maggie-lint-ignore\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/;

function ignoredOn(line) {
  const match = IGNORE.exec(line ?? '');
  return match ? new Set(match[1].split(',').map((rule) => rule.trim())) : new Set();
}

function finding(rule, file, line, message) {
  return { severity: RULES[rule].severity, rule, file, line, message };
}

/** Line-level findings for one text file. `markdown` adds the SKILL.md-only rules. */
export function lintText(text, file, { markdown = false } = {}) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const ignored = new Set([...ignoredOn(line), ...ignoredOn(lines[index - 1])]);
    const scanned = index === 0 ? line.replace(/^﻿/, '') : line;
    for (const [rule, patterns] of LINE_RULES) {
      if (ignored.has(rule)) continue;
      const hit = patterns.find((pattern) => pattern.test(scanned));
      if (hit) findings.push(finding(rule, file, index + 1, `${RULES[rule].summary}: ${excerpt(scanned, hit, rule)}`));
    }
    if (markdown && !ignored.has('html-comment') && /<!--/.test(line) && !/<!--\s*maggie-lint-ignore\b/.test(line)) {
      findings.push(finding('html-comment', file, index + 1, `${RULES['html-comment'].summary}: reviewers reading the rendered page will not see it`));
    }
  });
  return findings;
}

// The matched text, with secrets masked so the report does not leak them again.
function excerpt(line, pattern, rule) {
  const [match] = line.match(pattern);
  if (rule === 'secret') return `${match.slice(0, 6)}…`;
  if (rule === 'hidden-unicode') return `U+${match.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  return JSON.stringify(match.length > 60 ? `${match.slice(0, 57)}...` : match);
}

async function subdirectories(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
}

function lintFrontmatter(raw, file) {
  let data;
  try {
    ({ data } = matter(raw));
  } catch (err) {
    return { findings: [finding('invalid-frontmatter', file, 1, `frontmatter does not parse: ${err.message.split('\n')[0]}`)], name: null };
  }
  const findings = [];
  for (const key of ['name', 'description']) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') {
      findings.push(finding('invalid-frontmatter', file, 1, `frontmatter is missing "${key}"`));
    }
  }
  const name = typeof data.name === 'string' ? data.name : null;
  if (name && (!NAME.test(name) || name.length > MAX_NAME)) {
    findings.push(finding('name-format', file, 1, `"${name}" must be 1-${MAX_NAME} lowercase letters, digits and single hyphens`));
  }
  if (typeof data.description === 'string' && data.description.length > MAX_DESCRIPTION) {
    findings.push(finding('description-length', file, 1, `description is ${data.description.length} characters, over ${MAX_DESCRIPTION}`));
  }
  return { findings, name };
}

/**
 * Lint every skill of the library at `skillsDir` (`<techno>/<skill>/SKILL.md` and its
 * supporting files). Paths in the findings start at the library's own directory name.
 */
export async function lintLibrary(skillsDir) {
  const root = path.basename(skillsDir);
  const findings = [];
  const names = new Map();
  for (const techno of await subdirectories(skillsDir)) {
    for (const dir of await subdirectories(path.join(skillsDir, techno))) {
      const skillDir = path.join(skillsDir, techno, dir);
      const display = (rel) => `${root}/${techno}/${dir}/${rel}`;
      let raw;
      try {
        raw = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        findings.push(finding('missing-skill-file', display('SKILL.md'), 0, `${display('')} has no SKILL.md`));
        continue;
      }
      const front = lintFrontmatter(raw, display('SKILL.md'));
      findings.push(...front.findings);
      if (front.name) {
        const first = names.get(front.name);
        if (first) findings.push(finding('duplicate-name', display('SKILL.md'), 1, `"${front.name}" is already the name of ${first}`));
        else names.set(front.name, display('SKILL.md'));
      }
      findings.push(...lintText(raw, display('SKILL.md'), { markdown: true }));
      for (const resource of await loadResources(skillDir)) {
        if (resource.content.includes(0)) continue;
        findings.push(...lintText(resource.content.toString('utf8'), display(resource.path)));
      }
    }
  }
  return findings;
}

/** Human-readable report lines, errors first. */
export function formatFindings(findings) {
  const order = { error: 0, warning: 1 };
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `${f.severity === 'error' ? '✗' : '⚠'} ${f.file}:${f.line} ${f.rule}: ${f.message}`);
}
