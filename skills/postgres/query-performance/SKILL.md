---
name: postgres-query-performance
description: Diagnose and fix slow PostgreSQL queries with indexes and EXPLAIN
globs: ["**/*.sql", "**/*.repository.ts"]
---

# PostgreSQL query performance

Before optimizing, measure. Guessing at indexes wastes time and disk.

## Diagnose

- Run `EXPLAIN (ANALYZE, BUFFERS)` on the real query with realistic parameters.
- Watch for `Seq Scan` on large tables in the hot path, high `rows` estimates
  that diverge from actual, and nested-loop joins over big row counts.
- Reproduce against production-sized data — plans flip as tables grow.

## Fix

- Index the columns used in `WHERE`, `JOIN`, and `ORDER BY`. A composite index
  order matters: most selective / equality columns first, range columns last.
- Add partial indexes for queries that always filter the same predicate
  (`WHERE deleted_at IS NULL`).
- Select only the columns you need; avoid `SELECT *` in application queries.
- Kill N+1 patterns: fetch related rows in one query with a join or
  `WHERE id = ANY($1)` rather than a query per parent row.
- Keep transactions short; long-running ones bloat dead tuples and block
  `VACUUM`.

## Verify

Re-run `EXPLAIN ANALYZE` after the change and confirm the plan uses the index
and the total time dropped. An index that the planner ignores is dead weight —
remove it.
