#!/usr/bin/env node
import { runCli } from '../server.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
