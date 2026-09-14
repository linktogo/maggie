## Orientation

`linktogo-workspace` is a multi-application workspace for MyAsso, a multi-tenant association-management platform, together with related services and shared libraries. It serves association administrators, members, volunteers, independent workers, and the teams who build and operate the platform. The repository contains the main Next.js application under `apps/my-asso`, several NestJS services such as `apps/api-event` and `apps/api-ae`, the deployed Angular landing page under `apps/landing-next`, reusable packages under `libs/`, operational scripts under `scripts/`, and the design record under `specs/` and `docs/`.

The README describes Next.js 15, Firebase, Firestore, Firebase App Hosting, and Genkit AI as core parts of MyAsso. The workspace also contains Angular 21 landing-page code, NestJS APIs, shared React UI in `libs/lk-ui`, and integrations with services including Google Drive, Meta, Frama.space, email, and image processing. The repository has no declared top-level description beyond this product context.

A change normally starts with the design record rather than with an isolated implementation. The repository uses Speckit commands and feature records containing specifications, research, data models, contracts, plans, quickstarts, and tasks. An agent should first determine whether a document is a proposal, an implementation plan, or a status report; later records may refine or contradict earlier ones, and the supplied record often says explicitly when work remains unimplemented. Code and deployed behavior remain authoritative over design documents.

The top-level workspace includes `package.json`, `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock`; the README's development commands use Yarn:

```bash
yarn dev
yarn build
yarn genkit:dev
```

Environment setup is documented in `docs/ENVIRONMENT_SETUP.md`. Feature specifications are indexed by `FEATURES_REGISTRY.md`; new feature records are initialized with `node scripts/init-feature-spec.js create <numero> <nom-feature>` and the registry is refreshed with `node scripts/init-feature-spec.js update-registry`.

The domain documents linked below preserve the detailed history. They are connected by the platform's tenant model, shared Firebase and Next.js patterns, feature toggles, localization, reusable UI, and test-quality requirements. Do not infer that a plan shipped merely because it lists files or completed-looking tasks.

| Domain record | Document |
|---|---|
| Association operations and governance | [association-operations-and-governance.md](./association-operations-and-governance.md) |
| Auto-entrepreneur finance and training | [entrepreneur-finance-and-training.md](./entrepreneur-finance-and-training.md) |
| Communications and engagement | [communications-and-engagement.md](./communications-and-engagement.md) |
| Cloud assets and media workflows | [cloud-assets-and-media.md](./cloud-assets-and-media.md) |
| Meta social integration | [meta-social-integration.md](./meta-social-integration.md) |
| Landing page experience | [landing-page-experience.md](./landing-page-experience.md) |
| Platform configuration and shared UI | [platform-configuration-and-shared-ui.md](./platform-configuration-and-shared-ui.md) |
| Localization and test quality | [localization-and-test-quality.md](./localization-and-test-quality.md) |

## Glossary

**authGroupId** — The association or tenant identifier used to isolate tenant-owned data and operations.

**Admin SDK** — The server-side Firebase access layer; unlike the client SDK, it bypasses Firestore Security Rules and therefore must apply `authGroupId` filtering itself.

**Client SDK** — The frontend Firebase access layer used for authenticated reads and, where the design permits, direct Firestore operations subject to Security Rules.

**Feature toggle** — A tenant-scoped switch that enables or disables a capability, with later designs supporting independent `dev`, `test`, and `prod` states.

**Fiscal year** — The existing `FiscalYear` concept reused to scope events and registrations; event years may be civil or school-year periods.

**LocaleContext / `useLocale()`** — The existing localization mechanism exposing the current locale and translation lookup for MyAsso UI.

**Main space** — The protected MyAsso application area under `apps/my-asso/src/app/(main)`.

**PDP** — A private accredited dematerialization partner for electronic invoicing; the AE Formation V1 uses `ManualPdpAdapter`, while a real provider adapter remains dependent on partner selection.

**Speckit** — The repository's spec-driven development workflow, exposed through commands such as `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, and `/speckit.implement`.

**Tenant-scoped** — Stored, queried, and authorized in the context of one `authGroupId`; global data is an explicit exception, such as system legal templates.

**V1 / V2** — Phased delivery labels in the design record. They indicate intended scope and priority, not by themselves a claim that either phase is deployed.

## Invariants that cut across domains

1. **Tenant isolation is mandatory for tenant data.** Firestore collections, API services, contexts, and server operations that handle association or AE data must preserve `authGroupId`; this is established throughout the feature records, including `specs/027-tresorerie-crm-calendrier/data-model.md`, `specs/030-module-ae-formation/plan.md`, and the calendar, tracking, toggle, and legal designs.

2. **Admin SDK paths must enforce isolation and authorization in application code.** The `api-ae` contracts explicitly require `ApiKeyGuard` plus `authGroupId` filtering because Admin SDK access bypasses Firestore rules; the same principle is repeated for dedicated backend services such as `api-juridique`.

3. **Secrets and credentials must stay server-side and protected at rest.** Meta secrets and tokens use AES-256-GCM with legacy-compatible decryption; Frama.space credentials are encrypted; AE PDP keys are not exposed to clients; API keys must not appear in logs or client responses. Sources: the Meta integration design, `specs/025-frama-space-assets-integration/plan.md`, and `specs/030-module-ae-formation/spec.md`.

4. **Existing models and behavior are extended rather than silently replaced.** Event-year work reuses `FiscalYear`; volunteer registrations reuse the event `fiscalYearId` pattern; AE treasury remains separate from `AccountingContext` and association members; feature-toggle environments retain legacy fields and resolve `environments[env]`, then `isEnabled`, then `false`. Sources: the event-year, AE, and feature-toggle records.

5. **Destructive or irreversible operations require explicit protection.** Event rollover is non-destructive; submitted votes are immutable except for administrator cancellation; toggle history is immutable; closed formation cases are read-only except for administrators; manual calendar-event deletion is restricted to admins. Sources: the corresponding specifications and plans.

6. **User-visible text follows the repository's localization rules.** MyAsso supports French, English, German, and Spanish; new UI strings are expected in all four locale files and should be accessed through `useLocale()`/`t()` or the established locale API. The i18n records define matching key structures, consistent variables, and checks for hardcoded French.

7. **Pure domain logic should be separated so it can be tested independently.** Examples include `apps/my-asso/src/lib/event-year.ts`, `filterRegistrationsByFiscalYear`, `resolveEnvState`, breadcrumb parsing, and photo slot mapping. The event-year plan explicitly places calculations in a pure library because contexts are excluded from coverage collection.

8. **External integrations must fail explicitly without breaking unrelated user work.** Drive token refresh and retries, legal-service retries with non-blocking failure, Meta diagnostics, image-processing errors that allow subsequent images to continue, and tracking writes that never block navigation are all recorded patterns. Silent user-facing degradation does not mean suppressing operational logs where the design requires them.

9. **Feature flags and access checks must be applied at every relevant surface.** The AE suite is controlled by `portal-auto-entrepreneur`; photo access uses `events-photos-personnalise`; feature-toggle management is itself an explicit exception because it is the flag system; navigation and pages must not expose disabled or unauthorized operations.

10. **Tests are part of the delivery contract, not an optional afterthought.** Existing records set project-specific thresholds including 90% coverage for selected `my-asso` paths and the unit-test initiative's targets for `api-ae`; new feature plans commonly require tests for every new file, while the green-suite work requires `npx nx run-many --all --target=test` to succeed.

11. **A design record's status must be respected.** Documents marked planning, approved/awaiting implementation, draft, or unchecked do not establish shipped behavior. Conversely, records marked implemented still need to be read alongside explicit limitations, deployment gaps, or contradictions. This rule is supported by the status signals throughout the supplied specs and plans.

## How work gets done here

Work is organized around a spec-driven flow: clarify the user need, record decisions and constraints, research the existing architecture, define data models and contracts where needed, create an implementation plan, break it into tasks, implement, and validate. The repository advertises `/speckit.constitution`, `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, and `/speckit.implement`; `FEATURES_REGISTRY.md` and `specs/` are the navigation points for that record.

Testing is layered. Pure helpers and UI components are unit-tested with Jest or the repository's existing test runners; NestJS services use testing modules and mocked Firebase services; external APIs, Firebase, OAuth, and secrets are mocked for unit tests. The global command documented by the coverage work is:

```bash
npx nx run-many --all --target=test
```

Coverage is checked separately where thresholds apply, especially `apps/my-asso/jest.config.js` and `apps/api-ae/jest.config.ts`. The repository-wide records describe 90% targets for the principal test denominators, with selected wrappers, boilerplate, and difficult external adapters excluded. A green ordinary test run and a passing coverage gate are separate requirements.

Review should compare implementation against the relevant spec, plan, contracts, Security Rules, indexes, translations, and tests. Manual staging checks are required when a real external integration cannot be exercised locally, notably Meta OAuth and multi-page selection, public calendar feeds, deployment-sensitive PDF generation, and Firebase deployment of rules, indexes, or scheduled functions. Where design documents disagree, use the later explicit decision or status signal, and report unresolved tension rather than inventing a resolution.

Release and operations use the repository's existing Firebase/App Hosting and service-specific deployment conventions. Secrets belong in environment or platform secret configuration, not in `apphosting.yaml` or source. Cron and public endpoints have distinct authentication requirements such as `X-Cron-Secret`, `X-API-Key`, signed public URLs, or deliberate `@Public()` exceptions. Deployment is not implied by source or task completion: verify the relevant Firebase rules, indexes, functions, service routes, and staging behavior before calling a feature released.
