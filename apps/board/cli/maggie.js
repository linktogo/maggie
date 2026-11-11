// The `maggie` command: `maggie` starts the board and the server, `maggie --board` the board only,
// `maggie --server` the server only. Every other option is passed on to whichever of them it belongs to;
// `maggie sync` and `maggie workspace` run the skill sync and the workspace bootstrap.
//
// Everything that touches the outside (the board, the server, the sync, the workspace) is injected,
// bin/maggie.js wires the real ones.

// Options each side understands, and whether they take a value. `both` goes to both sides.
const OPTIONS = new Map(Object.entries({
  // board
  port: { to: 'board', value: true },
  dist: { to: 'board', value: true },
  config: { to: 'board', value: true },
  'status-repo': { to: 'board', value: true },
  'ci-interval': { to: 'board', value: true },
  'ci-state': { to: 'board', value: true },
  'ci-cache': { to: 'board', value: true },
  'agents-url': { to: 'board', value: true },
  'agents-token-file': { to: 'board', value: true },
  // server
  provider: { to: 'server', value: true },
  repos: { to: 'server', value: true },
  workspace: { to: 'server', value: true },
  skills: { to: 'server', value: true },
  'allow-origin': { to: 'server', value: true },
  'token-file': { to: 'server', value: true },
  db: { to: 'server', value: true },
  timeout: { to: 'server', value: true },
  'max-runs': { to: 'server', value: true },
  'trust-repos': { to: 'server', value: false },
  'no-terminal': { to: 'server', value: false },
  // when both run, `--port` is the board's: the server's is `--server-port`
  'server-port': { to: 'server', value: true, as: 'port' },
  // both
  'config-repo': { to: 'both', value: true },
  'config-file': { to: 'both', value: true },
}));

export const USAGE = `Usage:
  maggie [options]            start the board and the server
  maggie --board [options]    start the board only
  maggie --server [options]   start the server only
  maggie sync [options]       render the skills into the repositories
  maggie workspace [options]  bootstrap a local workspace

Options go to the part they belong to (see docs/board-dashboard.md and docs/ai-factory.md).
With both running, --port is the board's and --server-port the server's.`;

const SUBCOMMANDS = new Set(['sync', 'workspace']);

// A bare `--board` / `--server` picks what to start. `--board <file>` and `--board=<file>` keep
// their older meaning (the board file), so only a `--board` with no value is a flag.
function pickMode(argv) {
  const mode = { board: false, server: false };
  const rest = [];
  argv.forEach((arg, i) => {
    const next = argv[i + 1];
    if (arg === '--server') mode.server = true;
    else if (arg === '--board' && (next === undefined || next.startsWith('--'))) mode.board = true;
    else rest.push(arg);
  });
  return { mode, rest };
}

// Split the options between the board and the server.
function splitOptions(args) {
  const board = [];
  const server = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s) : [null];
    const spec = OPTIONS.get(flag);
    if (!spec) throw new Error(`Unknown option: ${arg}`);
    let tokens = [`--${spec.as ?? flag}`];
    if (spec.value) {
      const value = inline ?? args[(i += 1)];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      tokens = [...tokens, value];
    }
    if (spec.to !== 'server') board.push(...tokens);
    if (spec.to !== 'board') server.push(...tokens);
  }
  return { board, server };
}

// The board reaches the server at its default address with its default token file: where the
// server was asked to listen, or to put its token, has to reach the board too.
function wire(board, server) {
  const wired = [...board];
  const valueOf = (flag) => server[server.indexOf(flag) + 1];
  if (server.includes('--port') && !board.includes('--agents-url')) {
    wired.push('--agents-url', `http://127.0.0.1:${valueOf('--port')}`);
  }
  if (server.includes('--token-file') && !board.includes('--agents-token-file')) {
    wired.push('--agents-token-file', valueOf('--token-file'));
  }
  return wired;
}

export async function main(argv, { runBoard, runServer, runSync, runWorkspace, log = console.log, proc = process }) {
  const [first, ...others] = argv;
  if (first === '--help' || first === '-h') {
    log(USAGE);
    return;
  }
  if (SUBCOMMANDS.has(first)) {
    await (first === 'sync' ? runSync : runWorkspace)(others);
    return;
  }

  const { mode, rest } = pickMode(argv);
  if (mode.board !== mode.server) {
    await (mode.board ? runBoard : runServer)(rest);
    return;
  }

  const { board, server } = splitOptions(rest);
  const agents = await runServer(server);
  const closed = new Promise((resolve) => agents.once('close', resolve));
  // Ctrl-C closes the server; the board's own handler would otherwise exit before it is done.
  const boardProc = {
    once: (signal, handler) => proc.once(signal, handler),
    exit: (code) => closed.then(() => proc.exit(code)),
  };
  await runBoard(wire(board, server), { proc: boardProc });
}
