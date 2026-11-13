# Bakery engineering rules

Hard rules and entry points: [AGENTS.md](../AGENTS.md). This file holds the
conventions behind them. Rules that a hook, lint or rail already enforces are
named with their enforcer rather than restated.

## GitHub issue and PR authoring

Issue/PR descriptions: use the repo-local `bakery-authoring` skill. Templates
and enforcement: [.github/AUTHORING.md](../.github/AUTHORING.md). Description
checks never authorize execution, prove tests or replace independent review.

## Section navigation is a shared design standard

Areas with multiple sibling sections MUST use `SectionNavigation` from
[DESIGN.md](technical-design/DESIGN.md#section-navigation): wide screens, 224px
text-first sub-sidebar below page header; narrow screens, same ordered section
index/menu. Preserve selected parent through detail/action routes. Local tabs:
views within section.

Canonical account area: **Settings**, one entry, one route tree. No second User
settings or Personal settings area. Organization owns members, invitations, role
changes, shared settings. Settings shows only signed-in user's effective access,
read-only. Use shared UI primitives/semantic tokens; no feature-local shells.

## React UI follows Atomic Design

Shared React components live in `packages/ui` and consumers import semantic
names from `@bakery/ui`. Each public component has exactly one entry and one
Atomic Design level in `docs/technical-design/ui-baselines/components.json`.
Atoms, molecules, organisms and templates compose toward lower levels; raw
tokens, theming, fonts, focus and responsive rules are foundations. Product
pages in `apps/web` own routing, queries and mutations. Do not add pass-through
wrappers just to fill a level, or introduce a parallel component inventory.

Run the gallery browser checks when revising shared UI. Every catalog entry must
have a real rendered specimen, and its screenshot is a baseline for iteration
rather than proof that every product screen is complete.

The pull request route can skip the Paper parity lanes, so a change to a story,
a catalog entry or `docs/technical-design/ui-baselines/runtime-cases.json` runs
them locally before merge, as `.github/workflows/ci.yml` does, after
`pnpm --dir packages/ui build-storybook` and with the web dev server running:

- `ui / paper parity runtime`: `capture:stories -- --all --web-base-url <URL>`,
  then `compare:paper -- --cycle 1`.
- `ui / paper parity artifacts`: `paper:site:check`,
  `paper:site:check -- --site artifacts`, `render:paper:worker-dark -- --check`,
  then `capture:<site> -- --all --web-base-url <URL>` and
  `compare:paper -- --manifest <site> --cycle 1` for `artifacts`, `enterprise`
  and `worker-dark`. The worker-dark digest covers only the one runtime context
  its renderer reads (`worker-dark-mocks/runtime-context.json`, derived from
  `runtime-cases.json`), so a new runtime case needs no repin; editing the
  `paper-detail-light-phone` context does, and
  `render:paper:worker-dark -- --write` regenerates the file and the digest.
  `capture:worker-dark` still needs exactly one registered runtime case for
  the worker detail story (same args, dark, coarse); a second case matching
  those fails the capture, not the digest.
- `ui / paper parity entitlements`:
  `node packages/ui/scripts/paper-jsx-to-html.mjs --site entitlements --check`,
  then `capture:<site> -- --all --web-base-url <URL>` and
  `compare:paper -- --manifest <site> --cycle 1` for `entitlements` and
  `settings`.

Each script name runs as `pnpm --dir packages/ui <script>`; all run with
`FONTCONFIG_FILE` from `scripts/ci/paper-fontconfig.sh` and at most two capture
workers (`BAKERY_CAPTURE_JOBS=2`).

## Zod descriptions

Contract generation and CI reject missing or blank descriptions; review rejects
meaningless ones. A good description explains purpose and correct use
(provenance, units, format, constraints, omission/null behavior, side effects),
not the field name. Composition (`.optional()`, `.extend()`, `.pick()`,
transforms, ...) must preserve or replace the description. The described schema
is the source of truth; no handwritten duplicate types. Generation boundary:
[backend contract rails](technical-design/04-backend-and-errors.md).

## Local validation

Deno is the only formatter and linter; do not add ESLint, Prettier or
lint-staged. Before declaring a change complete: `pnpm fmt`, `pnpm lint`,
`pnpm typecheck`, then the narrowest relevant test lane (`pnpm test:unit`,
`pnpm test:rails`, ...). `pnpm hooks:install` enables the versioned
`.githooks/`: `pre-commit` runs the lint and suppression guard on staged files
(`BAKERY_SKIP_CHECKS=1` skips it), `commit-msg` enforces Conventional Commits.
CI re-runs both; never suppress a gate. Suppression rules live in
`pnpm lint:suppressions`.

## Backend implementation

### TypeScript value and import conventions

- Shared cross-layer roles, actions, error codes, and ownership identifiers MUST
  have one readonly constant definition with a derived union and type guard
  where validation is needed. Consumers MUST NOT duplicate raw literals.
- Distinct domain primitives and stateful records MUST cross trust or
  persistence boundaries through described Zod schemas, inferred or branded
  value-object types, and named constructors. Application and adapter
  signatures use those value objects instead of raw primitives.
- Reused structured records MUST use named types; do not repeat anonymous object
  shapes across application and adapter boundaries.
- Server code MUST import workspace packages through their published `@bakery/*`
  exports rather than upward relative paths.

### Runtime configuration

Application and worker code reads runtime configuration only through
`@bakery/config`; no raw `Deno.env`/`process.env` reads at call sites. Tooling
and test harnesses may snapshot `Deno.env.toObject()` only to feed a
`@bakery/config` reader or drive compose.

### PostgreSQL responsibility boundary

- PostgreSQL owns storage structure and relational integrity only: tables,
  columns, primary and foreign keys, `NOT NULL`, `UNIQUE`, indexes.
- TypeScript owns domain validation, authorization, lifecycle transitions,
  retries and other business rules. No `CHECK` constraints, triggers, stored
  routines, rules, views or policies for them. Row-level security is rejected by
  `tests/rails/no-row-level-security_test.ts`; organization isolation is
  explicit predicates in application code.
- Keep data changes out of schema migrations. Backfills are versioned, bounded,
  idempotent TypeScript scripts using `@bakery/config`.
- Deployed migrations remain immutable but are not precedent.

### Delivery discipline

- Trace the full flow before edits. Reuse existing operations and tools; no
  speculative framework, service or abstraction.
- Keep catalog, described Zod schemas, migrations, generated transports and
  tests consistent in one change.
- All transports share one operation/authorization boundary. Recheck live
  tenant/resource authority; previews, labels, prompts and schema text grant
  none.
- Atomically commit state, replay response, audit and outbox. Provider I/O stays
  outside transactions. Reconcile uncertain effects before repeating a
  mutation.
- Integration/E2E claims require real Postgres, Inngest and workers; missing
  services or skipped required lanes fail.
- Independent review before merge; never approve your own work, weaken tests or
  invent passing evidence.
