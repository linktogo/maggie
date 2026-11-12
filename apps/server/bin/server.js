#!/usr/bin/env node
import { installSqliteWarningFilter } from '../src/warnings.js';

// Before main.js: its imports load node:sqlite, and static imports are hoisted.
installSqliteWarningFilter();
const { main } = await import('../src/main.js');

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
