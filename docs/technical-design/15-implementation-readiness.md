# Implementation readiness

The technical map is a design contract. Passing its catalog, workflow-fixture and browser checks does not establish a running factory. Build in the order below; each gate names observable behavior before the next slice depends on it.

## Smallest useful build

| Slice | Deliver | Gate before continuing |
|---|---|---|
| 0 · Runtime compatibility | Pinned Deno/Hono/Mastra/Inngest dependencies; isolated executable probe | Typecheck and run a deterministic tool through HTTP; discover one Inngest function |
| 1 · Foundation | Shared Compose/dev-container setup from [Runtime](05-runtime-and-protocols.md), Turbo commands, shared schemas/errors, Postgres migrations, Better Auth organizations/members and account-protection hooks, one task command | Fresh-checkout bootstrap and hot reload work without external accounts; two organizations cannot read, reference or mutate each other's task; exact idempotent replay survives server restart; pending MFA cannot access protected resources |
| 2 · Durable execution | One fixed workflow, outbox, real local Inngest, fake worker with leases, artifact publication and event replay | Kill/restart server and worker; exactly one accepted result and artifact; no lost wakeup; stale fence and canceled success rejected |
| 3 · One real harness | One enrolled prepared host, explicit billing route, pinned skill, local filesystem bundle | Run a bounded fixture, interrupt after a checkpoint, recover in a fresh workspace, preserve evidence and enforce the budget cap |
| 4 · Product path | Shared shell, responsive task/chat/artifact screens, questions and comments; authenticator, backup-code and passkey settings/flows | Two users converge after reconnect; 320px and desktop checks; keyboard/focus and permission revocation; required Paper/Storybook parity; account-protection gates below |
| 5 · GitHub intake | Native shared App, install/resource selection, ready-label intake, read-only repository/issue sync | Signed duplicate/out-of-order webhook fixtures; explicit repository partitions between organizations; cursor traversal across many repositories |
| 6 · Controlled effects | GitHub progress writes, review/repair, merge and deployment evidence | Timeout after provider acceptance reconciles without duplicate effects; exact-head checks; revoke before dispatch; failed deployment retains known-good release |
| 7 · Additional interfaces | Slack through shared operations, local MCP OAuth, automations, remaining harnesses | Same authorization and transcript through all interfaces; schedule downtime/overlap; MCP protocol and scope conformance; Linux/macOS capability routing |

The full schema is the destination, not a requirement to migrate unused tables in slice 1. Build slices 1–3 against a fixed published workflow before adding the configurable interpreter. Then run the same behavior through the canonical JSON definition and prove equivalent definitions from the editor, YAML and typed SDK. The [workflow direction is accepted](06-workflows-delivery-and-acceptance.md); catalog reconciliation and those authoring surfaces remain implementation work. Each slice is independently reviewable and leaves an executable acceptance command. Plugin execution and marketplace publication remain stretch work; their ownership, version and scope boundaries are already modeled.

## Compatibility evidence and limits

An isolated runtime probe with its own pinned dependencies and lockfile was run during design. **Observed:** Deno 2.9.1 on macOS arm64 typechecked and passed all three tests with Mastra 1.64.0, Inngest 4.20.0, Hono 4.13.7 and Zod 4.5.4. The test process had no network permission. Dependency installation skipped a transitive `protobufjs` lifecycle script; this probe does not exercise protobuf-dependent paths.

It exercises a deterministic Mastra tool through Hono with validated input/output and an Inngest v4 HTTP discovery endpoint under Deno. It makes no model call and does not start a database, worker or workflow engine. Passing it proves those imports and boundaries can execute together, not that a workflow survives a crash. The [Mastra tool API](https://mastra.ai/docs/agents/overview), [Inngest HTTP serving model](https://www.inngest.com/docs/learn/serving-inngest-functions) and [Deno npm support](https://docs.deno.com/runtime/fundamentals/node/) informed this probe.

The next independent checks are deliberately bounded:

| Check | Required evidence | Current boundary |
|---|---|---|
| Local development stack | Both Compose and dev-container startup; local auth/installation-settings/filesystem storage; deterministic task-to-artifact path through real Postgres/Inngest; restart preserves state with external credentials unset | Required; configuration and runtime checks unimplemented |
| Real Inngest persistence | Durable server image pinned, engine Postgres plus persistent Redis configured; restart during a wait; one resumed result | Unrun |
| Postgres execution | Real transaction rollback, organization isolation, concurrent claim, outbox crash and stale-fence rejection | Unrun |
| Better Auth + MCP | Generated provider schema, PKCE/resource audience/scope checks and MCP 2026-07-28 conformance | Unrun |
| Better Auth account protection | Pinned two-factor/passkey plugins under Deno/Hono/Postgres; generated migrations; enrollment, recovery and real WebAuthn checks; password/GitHub/passkey sign-in cannot bypass required MFA; direct endpoints enforce fresh proof and ownership | Provider documentation checked 2026-09-08; runtime unrun |
| Harness subprocess | Codex subscription or Pi OpenRouter route, explicit limits, cancellation and credential isolation | Unrun |
| R2/filesystem parity | Conditional immutable publication, crash recovery, hash verification and safe materialization | Unrun |
| Recovery | Quiesced complete backup, isolated restore, key availability, no external replay; measured RPO/RTO | Unrun |

No runtime dependency is adopted merely because its package imports. A failing check gets one focused fix or a recorded compatibility decision before dependent implementation begins. No live account, model-billing or deployment test is implied by a fixture result.

## Review gaps reconciled

| Finding | Canonical decision / location |
|---|---|
| Missing organization/integration/ticket/plugin records | One [logical model](data-model.json), [operation catalog](api-catalog.json), and [transport schema catalog](transport-schemas.json); inventory and ERDs generated from them |
| Global human role | Better Auth membership supplies each organization's Admin/Developer role; installation administration remains separate |
| Integration request/result drift | Versioned action/resource input; read result versus accepted effect receipt; shared capability guards in [Integrations](09-integrations.md) |
| Zero-iteration repair failure | Seed-preserving repeat state; only completed iteration outputs replace the candidate; bounded repair behavior in [Workflows](06-workflows-delivery-and-acceptance.md) |
| Worker credential and journal disagreement | Worker generates credential; server stores hash and never returns it. Changed committed duplicate is `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Automation enum/projection drift | `coalesce_one` or `skip`; explicit pending firing and skipped-count projection across runtime, schema and API |
| Unregistered action / foreign expression syntax | `integration.action` is registered; the same `$input`, `$step`, `$repeat` expression grammar applies throughout |
| Artifact retention and incomplete recovery | Pin fields, byte tombstones, reference-safe collection, capacity gates and full recovery set in [Artifacts](14-artifacts.md) |
| Oversized first delivery / stale totals | Sequential gates above; generated inventory and dynamic verification totals replace independent counts |

## Delivery acceptance

The [account-protection plan](04-backend-and-errors.md#account-protection-totp-backup-codes-and-passkeys)
is part of delivery: prove single-use recovery under concurrency, safe regeneration,
rate limits, expired/replayed challenges, cross-user denial, last-method protection,
session revocation and restart/key restore. Test Safari/iOS and desktop browser handoff
in addition to a virtual WebAuthn authenticator. Authentication mock/layout checks
do not satisfy these server gates.

[Repository rules](22-repository-rules.md) adds organization inheritance,
repository overrides, immutable policy snapshots and commit/title/description/
magic-value checks to slices 5–6. Reconcile its proposed contracts before
generation. Prove lock enforcement across UI/REST/MCP, stale-policy and
metadata-only PR/MR invalidation, and unavailable required-check blocking before
automatic merge; the editable mocks are design evidence only.

[Machines](21-machines.md#design-system-mapping-and-acceptance) adds fresh-install, enrollment-race, readiness, provider-binding and remote-maintenance gates. The proposed `npx` package is not published, the added routes/records/scopes are not generated into the catalogs, and no installation or update has been exercised on a real worker. Prove one native worker path before expanding to every platform/harness; UI simulation is not that evidence.

The first end-to-end slice is done when an organization member submits one task, a durable workflow leases one worker, and the client sees one verified artifact after a forced restart. It must reject cross-organization references, mismatched retries, stale-worker results and canceled success. At that point add the next capability; a large green documentation report cannot substitute for this proof.
