---
name: cloudflare-worker-deployment
description: Deploy Cloudflare Workers with Wrangler, environments, secrets, and bindings
globs: ["wrangler.toml", "wrangler.jsonc", "src/**/*.ts", ".github/workflows/*.yml"]
---

# Cloudflare Worker deployment

Workers are configured by `wrangler.toml` (or `wrangler.jsonc`) and deployed with
Wrangler. Treat that file as the source of truth — it is committed; secrets are
not.

## Configuration

- Pin `compatibility_date` (and any needed `compatibility_flags`) so runtime
  behavior is reproducible. Bump it deliberately, not implicitly.
- Set `main` to the entry module and `name` to the Worker's name. Use
  per-environment overrides under `[env.<name>]` (e.g. `[env.production]`,
  `[env.staging]`) with their own routes and bindings.
- Declare resource bindings in config, access them via the typed `env` argument —
  never hardcode: KV (`[[kv_namespaces]]`), R2 (`[[r2_buckets]]`), D1
  (`[[d1_databases]]`), Queues, Durable Objects, and service bindings to other
  Workers.

## Deploy

```bash
wrangler dev                       # local runtime (workerd) for iteration
wrangler deploy                    # deploy the top-level (default) environment
wrangler deploy --env production   # deploy a named environment
wrangler versions upload           # upload a version without shifting traffic
wrangler rollback                  # revert to the previous deployment
```

- Routing: attach the Worker with a `route`/`routes` (a zone pattern) or a
  `workers.dev` subdomain, or a Custom Domain — declared per environment.
- Static assets / full-stack: serve a front-end via the `[assets]` binding or use
  a framework preset rather than embedding files by hand.

## Secrets & CI

- Never put secrets in `wrangler.toml`. Set them with `wrangler secret put <NAME>`
  (per environment); read them from `env`. Use `.dev.vars` for local only, and
  git-ignore it.
- In CI, authenticate with a scoped `CLOUDFLARE_API_TOKEN` (Workers edit
  permission) and `CLOUDFLARE_ACCOUNT_ID` from CI secrets, then run
  `wrangler deploy --env <env>`. Do not commit tokens.

## Anti-patterns

- Committing API tokens or secret values into `wrangler.toml` or the repo.
- Deploying straight to production with no staging environment or version upload.
- Reading config from `process.env` instead of the Worker `env` bindings.
