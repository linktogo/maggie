---
name: firebase-security-rules
description: Enforce access control in Firebase Security Rules, never in client code
globs: ["firestore.rules", "storage.rules", "**/*.rules"]
---

# Firebase Security Rules

Security Rules are the authorization boundary. The client is untrusted — a check
in your React/Next code is UX, not security.

## Rules

- Default deny. Start from `allow read, write: if false;` and open up only the
  specific paths and operations each role needs.
- Authenticate then authorize: gate on `request.auth != null` and then on
  identity/ownership (`request.auth.uid == resource.data.ownerId`) or a role
  claim (`request.auth.token.admin == true`).
- Validate writes in rules: check field types, required fields, and immutability
  (`request.resource.data.ownerId == resource.data.ownerId`) so a client can't
  escalate by editing a field.
- Scope each rule tightly by operation. Split `write` into `create`, `update`,
  `delete` when they have different conditions.
- Rules do not filter queries — they authorize document access. A `list` query
  must be constrained so every returned document satisfies the rule; otherwise it
  is rejected. Design queries and rules together.
- Test rules with the emulator (`@firebase/rules-unit-testing`) in CI: assert
  both the allowed and the denied cases.

## Anti-patterns

- Relying on the app to "only request the user's own data" while rules allow any
  authenticated read.
- Putting secrets or admin logic behind rules that trust a client-set field.
- Custom claims changed but never refreshed on the client token (force a token
  refresh after a role change).
