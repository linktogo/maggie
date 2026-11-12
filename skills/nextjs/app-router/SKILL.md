---
name: nextjs-app-router
description: Structure a Next.js App Router project with correct server/client boundaries
globs: ["app/**/*.tsx", "app/**/*.ts"]
---

# Next.js App Router

Components are Server Components by default. Only opt into the client when you
need interactivity — it ships JavaScript to the browser.

## Rules

- Add `'use client'` only to leaf components that use state, effects, event
  handlers, or browser APIs. Keep it as low in the tree as possible.
- Do data fetching in Server Components (async components, `fetch`, or a
  server-side data layer). Do not fetch in a `useEffect` to render the first
  paint.
- Never import server-only code (DB clients, secrets, `fs`) into a client
  component. Guard server modules with `import 'server-only'`.
- Use the file conventions: `layout.tsx` for shared shells, `loading.tsx` for
  Suspense fallbacks, `error.tsx` for error boundaries, `page.tsx` for routes.
- Mutations go through Server Actions or route handlers, then
  `revalidatePath`/`revalidateTag` to refresh cached data — do not manually
  patch client state and hope it matches the server.

## Anti-patterns

- Marking a whole page `'use client'` to fix one interactive widget.
- Passing non-serializable values (functions, class instances) from a Server to
  a Client Component as props.
- Leaking an API key into a client bundle by importing config that reads it.
