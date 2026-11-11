/**
 * Drop Node's "SQLite is an experimental feature" notice, and print every other warning the way Node does.
 * Lives apart from main.js: main.js loads node:sqlite when imported, so bin/agents.js installs this first.
 */
export function installSqliteWarningFilter(proc = process, print = console.error) {
  proc.removeAllListeners('warning');
  proc.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
    print(`${warning.name}: ${warning.message}`);
  });
}
