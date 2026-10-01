# Security Policy

## Supported versions

Only the latest released version of `maggie` receives security fixes. The `0.x`
releases published under the former `ai-sync` name are no longer maintained.

| Version | Supported |
|---|---|
| 1.2.x | ✅ |
| 0.x (`ai-sync`) | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/linktogo/maggie/security/advisories/new)
on this repository. If that is unavailable to you, email **security@linktogo.fr**.

Please include:

- the affected component (`maggie` CLI, `maggie-workspace` CLI, board server, a library);
- the version or commit you tested;
- reproduction steps or a proof of concept;
- the impact you believe it has.

You can expect an acknowledgement within **5 business days** and a status update
within **10 business days**. We will let you know when a fix ships and will
credit you in the advisory unless you prefer to stay anonymous.

## Scope notes

A few properties of this project are worth knowing before reporting:

- **The CLIs execute git and package-manager commands on your machine.** They
  clone repositories from URLs listed in the config, run `pnpm install` /
  `mvn dependency:go-offline` in those checkouts, and shell out to `gh` when
  `--pr` is passed. Treat a config file — and the repository serving it via
  `--config-repo` — as trusted input: pointing either at content you do not
  control is equivalent to running that content's install scripts.
- **`maggie-workspace bootstrap` writes Claude Code hooks** into each checkout's
  `.claude/settings.local.json`. Those hooks run this CLI's `status` subcommand
  on session events.
- **The board server (`apps/board/server.js`) is a local development tool.** It
  serves the built dashboard and reads `board.json`. It has no authentication
  and is not intended to be exposed to a network: it binds to the loopback
  interface only (`127.0.0.1`), answers only requests addressed to
  `localhost`/`127.0.0.1`/`[::1]`, and refuses state-changing requests that
  carry a non-local `Origin` header. Reports that it can be reached or driven
  from another host or from a web page are in scope.

Findings that require an attacker to already control the config file, the target
repositories, or the local machine are documentation issues rather than
vulnerabilities — but please still tell us, since the fix may be a clearer
warning in the docs.
