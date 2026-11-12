---
name: platform-aware-cli-commands
description: Use when a Node CLI shells out to external tools (pnpm/npm/npx, editors) or prints copy-paste shell commands and must run on Windows as well as macOS/Linux — symptoms include ENOENT spawning pnpm on Windows, broken paths with spaces, `cd` not switching drives, or a coverage gate failing on an OS branch that never runs on your dev machine.
---

# Platform-Aware CLI Commands

## Overview

Node CLIs that spawn binaries or emit shell snippets break on Windows in non-obvious ways. Centralize every platform decision in one small, **injectable** module so the rest of the code stays OS-agnostic and each branch stays testable.

**Core principle:** No bare `process.platform` checks scattered across the codebase. One module resolves command names and shell syntax; everything else calls it.

## When to Use

- Spawning package managers via `child_process.execFile`/`spawn` (pnpm, npm, npx, yarn)
- Printing `cd … && tool` commands for the user to copy/paste
- Building any tool meant to run on Windows **and** POSIX
- A coverage gate fails because an OS branch never executes on your machine

**Not for:** path math (use `node:path`) or temp dirs (use `os.tmpdir()`) — already portable.

## The Two Windows Traps

1. **`.cmd` shims.** `execFile('pnpm', …)` fails with `ENOENT` on Windows because `pnpm` is `pnpm.cmd`. `git`/`gh` ship as `.exe` and resolve fine. Resolve the shim name per platform — don't reach for `shell: true`, which changes argument-escaping semantics for every call.
2. **Printed shell commands.** Unquoted paths break on spaces (`C:\Users\John Doe`); `cd` won't switch drive without `/d`; `&&` works in cmd.exe and PowerShell 7+, not PowerShell 5.1.

## Core Pattern

```js
// platform.js — the ONLY place process.platform is read.
export function pnpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function launchCommand(editor, dir, platform = process.platform) {
  const quoted = `"${dir}"`;                 // always quote → handles spaces
  if (editor === 'vscode') return `code ${quoted}`;
  const cd = platform === 'win32' ? `cd /d ${quoted}` : `cd ${quoted}`;
  return `${cd} && claude`;                   // cmd.exe + pwsh7
}
```

The **injectable `platform` argument** defaults to `process.platform` but lets tests drive both branches:

```js
assert.equal(pnpmCommand('win32'), 'pnpm.cmd');
assert.equal(pnpmCommand('linux'), 'pnpm');
```

Without injection the `win32` branch never runs on a Mac/Linux CI, so a 100%-branch coverage gate fails. Injection makes OS code testable.

## Quick Reference

| Concern | POSIX | Windows | Fix |
|---|---|---|---|
| pnpm/npm/npx spawn | `pnpm` | `pnpm.cmd` | resolve name per platform |
| git/gh spawn | `git` | `git.exe` | none needed |
| path in printed cmd | quote | quote | always `"${dir}"` |
| change dir | `cd` | `cd /d` | drive switch on Windows |
| chain commands | `&&` | `&&` (cmd/pwsh7) | document pwsh 5.1 caveat |

## Common Mistakes

- **`shell: true` to silence ENOENT** — forces you to escape every arg; resolving the `.cmd` name is cleaner.
- **Inline `process.platform ? …` at call sites** — scatters branches you cannot cover; centralize and inject.
- **Skipping quotes** because your dev paths have no spaces — Windows user paths do.
