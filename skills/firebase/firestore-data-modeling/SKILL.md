---
name: firebase-firestore-data-modeling
description: Model Firestore data for the queries you actually run, not for normalization
globs: ["**/*.ts", "**/*.js", "firestore.indexes.json"]
---

# Firestore data modeling

Firestore is a NoSQL document store. Model around the reads your app performs;
denormalize on purpose rather than mirroring a relational schema.

## Rules

- Design collections from your query patterns first. There are no joins — if you
  need data together, store it together (embed) or duplicate the few fields you
  render in lists.
- Keep documents small and bounded. Use subcollections for unbounded growth
  (a `messages` subcollection under a `chat`) instead of a growing array field.
- Every query must be backed by an index. Composite queries need a composite
  index declared in `firestore.indexes.json` — add it rather than relying on the
  console's auto-suggest link in production.
- Denormalized copies drift: update all copies in a single batched write or a
  transaction, and keep the write path that maintains them in one place.
- Avoid document-level write hotspots (a single counter hammered by everyone);
  use distributed counters (sharded) or increment on the server.
- Paginate with cursors (`startAfter(lastDoc)`), never large `offset`s — Firestore
  bills and scans every skipped document.

## Anti-patterns

- A relational schema with "foreign key" ids you then N+1 fetch client-side.
- Unbounded arrays inside a document (they must be read/written whole and hit the
  1 MiB document limit).
- Reading a whole collection to count it — keep a maintained counter instead.
