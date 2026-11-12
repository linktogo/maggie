---
name: postgres-migrations
description: Write safe, reversible, zero-downtime PostgreSQL schema migrations
globs: ["**/migrations/**/*.sql", "**/migrations/**/*.ts"]
---

# PostgreSQL migrations

Every schema change ships as a migration that is forward-only in production but
reversible in review. Never edit the database by hand.

## Rules

- One logical change per migration; give it a timestamped, descriptive name.
- Each migration is idempotent-safe to re-run where the tooling supports it, and
  has a matching `down` that truly reverses `up`.
- Make column additions non-breaking: add nullable or with a default, backfill
  in a separate step, then add the `NOT NULL` constraint once data is clean.
- Adding an index on a large table? Use `CREATE INDEX CONCURRENTLY` (outside a
  transaction) so writes are not blocked.
- Renames and drops are two-phase: deploy code that tolerates both shapes, then
  drop the old column in a later migration once nothing reads it.

## Zero-downtime checklist

1. Additive change (new column/table/index) — safe.
2. Deploy application code that writes both old and new.
3. Backfill existing rows in batches.
4. Switch reads to the new shape.
5. Remove the old shape in a follow-up migration.

## Anti-patterns

- `ALTER TABLE ... SET NOT NULL` on a populated column in the same migration
  that adds it, with no default — it rewrites and locks the table.
- Destructive `DROP`/`TRUNCATE` with no reversible path and no backup step.
