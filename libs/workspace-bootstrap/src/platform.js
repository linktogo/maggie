import path from 'node:path';

// OS-aware resolution of external commands.

// On Windows, package-manager entry points are `.cmd` shims, which
// `child_process.execFile` cannot resolve without `shell: true`. Returning the
// `.cmd` name keeps execFile working there while staying plain `pnpm` on
// POSIX (macOS, Linux).
export function pnpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

// Editors and local agents we know how to launch into a workspace directory.
export const EDITORS = ['claude', 'copilot', 'vscode'];

// Build the shell command we print for the user to copy/paste.
//
// The directory is always quoted so paths with spaces work (common on Windows,
// e.g. `C:\Users\John Doe\...`). On Windows `cd /d` also switches drive, so the
// command works even when the workspace lives on a different drive than the
// current one. `&&` is honoured by cmd.exe and PowerShell 7+.
export function launchCommand(editor, dir, platform = process.platform) {
  const quoted = `"${dir}"`;
  if (editor === 'vscode') return `code ${quoted}`;
  const cd = platform === 'win32' ? `cd /d ${quoted}` : `cd ${quoted}`;
  // `claude` and `copilot` are both terminal agents launched from the directory.
  return `${cd} && ${editor}`;
}

// Resolve the Maven binary. Prefer the repo's wrapper (mvnw / mvnw.cmd) for a
// pinned, reproducible Maven version; otherwise use the system mvn. On Windows
// the `.cmd` shims are used, consistent with pnpmCommand.
export async function mavenCommand(workDir, { exists, platform = process.platform }) {
  const wrapperName = platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const wrapper = path.join(workDir, wrapperName);
  if (await exists(wrapper)) return wrapper;
  return platform === 'win32' ? 'mvn.cmd' : 'mvn';
}
