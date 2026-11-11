#!/usr/bin/env node
// `maggie`, and `maggie-board` (the board alone, same as `maggie --board`).
import { main } from '../cli/maggie.js';
import { runCli as runBoard } from '../server.js';

const only = process.argv[1].endsWith('board.js') ? ['--board'] : [];

main([...only, ...process.argv.slice(2)], {
  runBoard,
  runServer: async (args) => {
    // Before the server: it loads node:sqlite, and static imports are hoisted.
    const { installSqliteWarningFilter } = await import('@lk/maggie-server/warnings');
    installSqliteWarningFilter();
    const { main: startServer } = await import('@lk/maggie-server');
    return startServer(args);
  },
  runSync: async (args) => {
    const { main: sync } = await import('../cli/sync/src/main.js');
    process.exitCode = await sync(args);
  },
  runWorkspace: async (args) => {
    const { run } = await import('../cli/workspace/bin/workspace.js');
    await run(args);
  },
}).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
