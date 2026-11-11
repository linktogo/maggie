#!/usr/bin/env node
// Also the command the agent hooks run (see `hookCommand`), so it stays executable on its own.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { select } from '@inquirer/prompts';
import { main } from '../src/main.js';

// Interactive single-project picker shown when --repo is omitted on a TTY.
function selectRepo(repos) {
  return select({
    message: 'Quel projet charger dans le workspace ?',
    choices: repos.map((repo) => ({
      name: `${repo.name} (${repo.technologies.join(', ')})`,
      value: repo.name,
    })),
  });
}

// Shown when a checkout already exists: reuse it, reinstall fresh, or clone
// into a new timestamped directory.
function onExisting(repo) {
  return select({
    message: `${repo.name} existe déjà dans le workspace. Que faire ?`,
    choices: [
      { name: 'Réutiliser le checkout existant', value: 'reuse' },
      { name: `Réinstaller à neuf (${repo.name}-reinstall)`, value: 'reinstall' },
      { name: `Nouveau dossier horodaté (${repo.name}-<timestamp>)`, value: 'timestamp' },
    ],
  });
}

export function run(argv) {
  return main(argv, { selectRepo, onExisting }).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(process.argv.slice(2));
}
