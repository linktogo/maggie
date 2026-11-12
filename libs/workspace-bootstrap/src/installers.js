import path from 'node:path';
import { pnpmCommand, mavenCommand } from './platform.js';

// Declarative registry: one entry per ecosystem. The first installer whose
// marker file is present in the work directory wins.
const INSTALLERS = [
  {
    name: 'node',
    marker: 'package.json',
    label: 'pnpm',
    resolve: (workDir, { platform, offline }) => ({
      command: pnpmCommand(platform),
      args: ['install', offline ? '--offline' : '--prefer-offline'],
    }),
  },
  {
    name: 'maven',
    marker: 'pom.xml',
    label: 'mvn',
    resolve: async (workDir, { exists, platform, offline }) => ({
      command: await mavenCommand(workDir, { exists, platform }),
      args: offline ? ['-o', 'dependency:go-offline'] : ['dependency:go-offline'],
    }),
  },
];

// Returns { name, label, command, args } for the matching ecosystem, or null
// when the work directory has no recognised marker file.
export async function planInstall(workDir, { exists, platform = process.platform, offline = false }) {
  for (const inst of INSTALLERS) {
    if (await exists(path.join(workDir, inst.marker))) {
      const { command, args } = await inst.resolve(workDir, { exists, platform, offline });
      return { name: inst.name, label: inst.label, command, args };
    }
  }
  return null;
}
