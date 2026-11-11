# Bakery web host

Shared component specimens live in the package Storybook. Start it from the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/ui storybook
```

The web host retains the theme bootstrap and the host-owned Settings navigation
fixture used by its browser contract checks. Shared stories use local demo
state; they do not call the Bakery API or authenticate users.

Paper and [the design specification](../../docs/technical-design/DESIGN.md)
provide the visual reference. Components use native HTML controls where they
cover the interaction. The public API lives in `packages/ui/src/index.ts`;
product screens import from `@bakery/ui` and own their routing and data calls.

## Repository task scope

Repository and profile selections on `/projects/onboarding` update its deep link
without resetting the page scroll. A stale-profile conflict preserves the draft
and brings its notice into view and focus, unless another control already has
focus. Task submission remains disabled until the refreshed active profile is
explicitly reviewed again.

The desktop/mobile `tests/projects-onboarding.spec.ts` checks cover this
recovery, including keyboard continuation and retaining focus moved during a
pending request.

The task inbox retains the current rows while a filter or page query fetches.
Cursor controls stay disabled during placeholder, fetch, offline, reconnecting,
and error states, so a retained page cursor cannot navigate after a failed
refetch. A successful retry enables navigation using the refreshed cursor. Task
run controls preserve an uncertain receipt through a failed parent refresh and
remain disabled until the authoritative task/run identity is valid again.

The API client exposes pinned run admission with a caller-owned idempotency key.
Unknown outcomes require an explicit retry with the same immutable input and
key; late or mismatched receipts do not establish admission. This transport
boundary does not publish a coding preset or provide its plan producer or
executor.

## Checks

```sh
pnpm --dir packages/ui build-storybook
pnpm ui:stories:check
pnpm --dir packages/ui exec playwright test
```

Playwright opens Storybook and checks the canonical story bindings and component
interactions. Visual comparison against Paper remains a later phase.

Shared components are organized as atoms, molecules, organisms, and templates.
The [authored catalog](../../docs/technical-design/ui-baselines/components.json)
owns their semantic IDs and design responsibilities. Storybook binds every ID to
one real React specimen so omissions can be detected by browser checks.
