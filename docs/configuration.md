# Configuration

Both CLIs (`maggie` and `maggie workspace`) read the same JSON config describing
the target repositories. It can be a local file (`--config`) or live in a **separate repository** fetched
with `--config-repo` — the latter is how an organization shares one config
across everyone's machine without committing its repo list into this project.
`repos.example.json` documents the shape.

## Schema

```json
{
  "defaultTargets": ["claude", "copilot"],
  "repos": [
    {
      "name": "example-api",
      "url": "https://github.com/example-org/example-api.git",
      "technologies": ["nestjs", "postgres"],
      "targets": ["claude", "cursor"]
    },
    {
      "name": "example-local",
      "url": "https://github.com/example-org/example-local.git",
      "path": "/absolute/path/to/example-local",
      "technologies": ["vuejs"]
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `repos` | yes | Non-empty array. Validation fails on an empty or absent list. |
| `repos[].name` | yes | Identifier used everywhere else — board keys, `--repo`, CI status folders. |
| `repos[].url` | yes | Clone URL. SSH and scp-style forms (`git@host:org/repo.git`, `ssh://…`) are rewritten to HTTPS before cloning. |
| `repos[].technologies` | yes | Non-empty array, matched against `skills/<techno>/`. See [Skills library](skills-library.md). |
| `repos[].targets` | no | Output formats for this repo. Falls back to `defaultTargets`. |
| `repos[].path` | no | Path to an existing local checkout — see below. |
| `defaultTargets` | no | Applied to every repo that omits `targets`. A repo that ends up with zero targets is a validation error. |

Known targets: `claude`, `copilot`, `cursor`, `windsurf`. An unknown target is
rejected at load time with the list of valid ones.

### `path`

Points at an existing checkout outside the workspace folder. Typically
absolute — a relative value resolves against the **current working directory**,
not the config file's location.

Only `maggie workspace` consumes it: status tracking, hooks and dependency install
are wired up there instead of cloning into `--workspace` (cloning into `path`
first if it does not exist yet). `maggie` ignores it and always clones into its
own temporary work dir.

## Where the config comes from

Both CLIs resolve their config from **exactly one** of two flags. Passing both,
or neither, is an error.

### `--config <path>`

Read a local JSON file.

```bash
maggie --config repos.example.json
```

### `--config-repo <url>`

Shallow-clone a git repository into a temp dir and read the config from it.
This is how a shared, organization-owned config repo is consumed.

```bash
maggie --config-repo https://github.com/example-org/ai-config.git
```

The file read defaults to `repos.json` at the repo root. Override it with
`--config-file <path-in-repo>`:

```bash
maggie --config-repo <url> --config-file environments/prod.json
```

SSH and scp-style repo URLs are rewritten to HTTPS automatically, and the
checkout is removed once the config has been read.

Cloning uses ambient git credentials. A private config repo therefore needs
whatever the local machine already uses to clone it — there is no token flag.
