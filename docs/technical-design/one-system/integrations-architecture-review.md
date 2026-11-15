> Companion of [chapter 25, One engine](../25-one-engine.md). Where this document and [owner-decisions.md](owner-decisions.md) differ, the owner decisions win.

# Integrations architecture: independent review

Reviewed proposal: PR #379 (`rig/31-integrations-design`, §12 of
`docs/technical-design/09-integrations.md`) and the brief's summary of it.
Evidence is cited at **`origin/main` 07988a409** (`git show origin/main:<path>`).
The primary clone's working tree (`d05a5de96`) is 130 commits behind `origin/main`
and is missing the Slack and grants work, so its line numbers are not used.
Nothing in the repo was modified.

## Executive verdict

The direction is right, and it is needed: on `origin/main`, 30 of the 40 `.ts` files
in `apps/server/src/modules/integrations/` (18.8k lines) mention GitHub, and Slack is
now landing in the same flat folder (`slack-*.ts`, migrations 0149/0153). But six parts
of #379 are wrong or will not survive contact with the code:

1. **Step 3 of the migration plan cannot be done as written.** It `git mv`s
   `callbacks.ts`, `ticket-reads.ts`, `pull-requests.ts` and `github-transport.ts`
   into the package. Those files import `platform/database.ts`, `auth/application/*`,
   `secrets/crypto.ts`, `@bakery/persistence` and `platform/retry-after.ts`. That
   breaks #379's own rule that packages never depend on `apps/*`, and it creates a
   cycle between `apps/server` and the package. Seams have to be cut in place first,
   and the move comes last.
2. **Provider-owned migrations are the wrong default here.** Today no table is
   GitHub-only. `0143_github_intake.sql` creates five generic tables. The ledger is a
   single global, append-only sequence. Migration roots are hand-listed in five or more
   places, and one of those lists has already drifted. The rule should be that core owns
   all tables and providers own JSON schemas.
3. **The deepest GitHub coupling is in contracts and data shapes, not file location.**
   Examples: `packages/contracts/src/ticket-admission.ts` (`githubActorIds`, numeric ids,
   `owner/name`), the `TicketSourceReader` types, `kind = 'repository'` hard-coded in
   core SQL, GitHub-App-shaped `NOT NULL` columns, and `inbound_events.registration_id`.
   #379 promises "contracts identical" in every step. Linear therefore needs an
   explicit breaking-contract slice, and the plan has none.
4. **Several port mappings in §12.3 are wrong.** `resolveRepositoryId`,
   `authorityVerdict` / `lockAuthority`, `readIssueRouteTarget` and
   `createTicketFactIndex` are SQL over core tables, so they belong in core, not behind
   provider ports. Ticket URL building belongs to Tickets, not to `CodeProvider`. The
   webhook path is `/v1/webhooks/github`, not `/intake/github`.
5. **The host broker cannot express the next three providers.** Linear's GraphQL reads
   are `POST`, and `request.ts:118-120` bans read-only `POST`. Jira needs a `cloudId`
   path prefix and Basic auth. GitLab self-managed needs a per-installation origin,
   while `HostAuthProfile` has one fixed origin and bearer placement only. This
   host-side work is the real cost of "Linear next".
6. **Co-location has concrete build and rail pitfalls that #379 does not list.** UI
   guardrails scan only `apps/web/src/`. The lint/fmt directory lists are explicit. Test
   lanes are rooted at `tests/<lane>`. i18n is one typed catalog. Code runs under both
   Deno and tsc. A top-level `integrations/` directory escapes the rail that keeps
   packages in the lint gate.

The enforcement can be built mostly from mechanisms the repo already has: the
`no-client-server-import` lint rule, the regex rails, the UI guardrail ratchet ledger
with merge-base contraction, the harness conformance corpus, and the required
`fast / backend rails` and `fast / provider conformance` lanes.

---

## A. Verdicts

### A1. Is the GitHub leakage what #379 describes? Partly. It is understated in the places that matter.

#379 is right that the lifecycle hard-codes GitHub. It misses three things:

- Some "GitHub-coupled" imports from `work` are **generic functions that happen to live
  in GitHub-heavy files**. These need a file split, not a port.
- The **public ticket contract and the stored JSON shapes** are GitHub-shaped.
- The **web Issues pages**, which are the generic Tickets UI, are GitHub-coupled too,
  and they are outside #379's scope.

#### Integrations module, file by file

| File (origin/main) | GitHub dependency (evidence) | Where it goes | What it needs instead |
|---|---|---|---|
| `connections.ts:15,133` | `createConnection` special-cases `GITHUB_PROVIDER_ID` | core | `registry.byProviderId(id).connect.kind` (data) |
| `installations.ts:12,67,114-117` | hard-codes `providerId: GITHUB_PROVIDER_ID` and "one GitHub provider" filter | core | registry slug↔UUID map, read from `installation.provider` |
| `installation-fan-out.ts:4` | `GITHUB_PROVIDER` in audit/event details | core | row's `provider` |
| `auth-attempts.ts:18-30` | GitHub authorize/install URL builders + allowlist | core attempt store | `ConnectStrategy.begin()` returns allowlisted steps |
| `callbacks.ts` (1452 lines; `:100` sets `?githubConnection=`) | setup/OAuth callback convergence, user-token installation and repo-admin verification, mixed with claim/bind/audit SQL | split: core `completeAttempt` (claim, bind, audit, fan-out) + GitHub `connect.complete()` | `ConnectStrategy.complete()` → `VerifiedAuthorization` (no DB) |
| `postgres.ts:28,35` (+ manifest flow, credential storage) | provider constants, App manifest, three GitHub secrets | split: core app-registration store + GitHub `AppRegistrationStrategy` | `AppRegistrationStrategy` (GitHub manifest; generic "client credentials" for OAuth providers) |
| `token-broker.ts:177` | `createGitHubAppJwt`, `mintInstallationToken` | core cache/invalidation + provider mint | `CredentialStrategy.mint()` with declared secret slots |
| `reconcile.ts:63` | `ReconcileDependencies.github: GitHubAppClient` | core | `InstallationLifecycle.readState()` |
| `discoveries.ts` | App JWT, `listInstallationRepositories` | core job | `ResourceDiscovery.listPage()` |
| `checks.ts` | GitHub probe | core health folding | `HealthProbe` |
| `intake-routes.ts:121,156,231` | `x-hub-signature-256`, `x-github-delivery`, `GitHubAppPath.Webhook` | core receiver at `/v1/webhooks/:provider` | `WebhookIngress.verify/classify` |
| `intake-receipts.ts:30,93,205` | `verifyGitHubSignature`, `REPOSITORY_RESOURCE_KIND` | core receipts | ingress port + resource kind from registry |
| `intake-events.ts` | GitHub event schemas and projection | provider | `classify()` |
| `intake-workflow.ts` | route processor uses `GitHubReadFailure`, `pull-requests` | core processor | `FactSource.refresh(subject)` |
| `fact-reads.ts:143` vs `:103,274` | `authorityVerdict` is generic; `subjectOf` / `permissionsFor` are GitHub | split: `core/facts/authority.ts` + provider subjects | none for the verdict |
| `write-authority.ts:62` | `kind = 'repository'` | core | resource kind as a parameter |
| `sync-checkpoints.ts:6,22,96`, `fact-sweep.ts` | streams `issues/pull_requests/checks`, GitHub page size, offset+edge cursor | core lease/rest/backoff engine | provider `SyncStream` with an opaque, provider-validated cursor |
| `remote-facts.ts` | 2 mentions (comments) | core | provider-validated summary schema |
| `pull-requests.ts:120` `resolveRepositoryId` | **pure SQL on `bakery.repositories`** | **core (projects)**, *not* `CodeProvider` as #379 §12.3 says | none |
| `ticket-reads.ts:372` `createTicketSourceReader` | GitHub issue reads | provider (Tickets adapter) | `TicketsPort` |
| `ticket-reads.ts:755,783,809` `readIssueRouteTarget`, `createTicketFactIndex` | SQL over `inbound_event_routes` / `integration_remote_facts`, keyed on `eventKind === "issues"` | **core intake** (#379 puts them behind `TicketsProvider`; wrong) | normalized subject from `ingress.classify` |
| `github-app.ts`, `github-app-key.ts`, `intake-signature.ts` | GitHub protocol | provider | — |
| `github-transport.ts` | imports `platform/retry-after.ts` | provider, after moving retry-after parsing into the SDK or making it injected | — |
| `slack-scope.ts`, `slack-identity.ts` | already pure ("a plain function of its arguments") | provider (`integration-slack`) | — |
| `slack-identity-links.ts`, `slack-identity-attempts.ts` | SQL stores keyed on `provider = 'slack'` | **core** identity-link store with a provider parameter | none. Identity linking is cross-family: Tickets "mapped member" authority needs it as well. |
| `lifecycle-workflow.ts`, `discovery-workflow.ts`, `discovery-queue.ts`, `intake-retention.ts`, `intake-body.ts`, `grants.ts` | none, or comments only | core as-is | — |

Core SQL hard-codes `kind = 'repository'` in nine places: `checks.ts:149`,
`discoveries.ts:455`, `fact-sweep.ts:190`, `intake-workflow.ts:372`, `remote-facts.ts:248`,
`sync-checkpoints.ts:384,440`, `ticket-reads.ts:208` and `write-authority.ts:62`. In
addition, `callbacks.ts` inserts `'repository'` and `intake-receipts.ts:93` declares
`REPOSITORY_RESOURCE_KIND`. Linear sources are teams and Jira sources are projects.

#### Tickets family: `work/ticket-*` and contracts

| Location | Coupling | Fix |
|---|---|---|
| `work/ticket-admission.ts:30-31`, `ticket-source-command.ts:25-27` | import `authorityVerdict`, `lockAuthority`, `resolveRepositoryId` | after the split, import from core modules (no port needed) |
| `work/ticket-workflows.ts:6-7` | `eventRouteId` and `readIssueRouteTarget` from integrations | core intake route-target reader |
| `work/ticket-source-reader.ts:8,46,63,161` | the port is GitHub-shaped: `repositoryFullName`, `number`, `{kind:"pull_request"}`, `page` paging; `readActorRole` returns GitHub repo permission | replace with `TicketsPort` (C) |
| `work/ticket-store.ts:423,470-478` | dedupe on "GitHub issue id"; key and URL `https://github.com/${repo}/issues/${n}` | `TicketsPort.present()`. This is the Tickets family; #379 wrongly puts it on `CodeProvider`. |
| `work/ticket-snapshot.ts:49` | task footer `GitHub: owner/repo#n` | `present().label` |
| `work/ticket-readiness.ts:60,323,598-599` | "GitHub installation", `pull_request_not_ticket`, `github_actor:` evidence, `delegation.githubActorIds` | generic installation, `not_a_ticket`, `external_actor:`, `externalActorIds` |
| **`packages/contracts/src/ticket-admission.ts:353,371,375,379,410,541-600`** | public wire contract: GitHub label names, `owner/name`, decimal-only ids, issue number, `githubActorIds`, `state: open/closed`, `stateReason`, "One GitHub issue" | **breaking contract change** (pre-approved by repo rules, but it needs the contract-migration rebind). #379's "contracts identical" means it never happens. |
| `work/migrations/bakery/0145_ticket_admission.sql` | `ticket_sources.provider default 'github'`; otherwise generic (`external_container_id`, `external_ticket_id text`, `key`, `number text null`) | drop the default; the DB is mostly fine |
| Web `pages/issue-state.ts:219-257` (`kind: "github"` fix actions), `IssuesPage.tsx:284-291` (`issues.noGithub.*`), `OrganizationIntegrationsPage.tsx:42` (`CONNECTION_OUTCOME_PARAMETER = "githubConnection"`) | generic Tickets/Integrations UI names GitHub | in scope for requirement 1. Add to the neutral-zone rail (B2). |

Other GitHub paths outside the integrations module: `secrets/broker.ts` and
`secrets/preflight.ts` verify project secrets only against `https://api.github.com/user`.
That is a second, GitHub-only credential path for worker git access, and it belongs to
the Code family later.

**Provider identity is split three ways.** `bakery.github` is the SDK manifest id
(`catalog/integration-providers/github.ts:160`). `"github"` is the DB `provider` column
(`postgres.ts:28`). `a1fbffc0-…` is the UUIDv5 public `providerId` (`postgres.ts:35`).
On top of that there are two provider lists: the catalog's
`deployedIntegrations = [githubIntegration]` (`integration-gate-registry.ts:7`) and the
implicit GitHub wiring in `app.ts`. One manifest must own all three ids.

### A2. One package per provider: **sound, but change the location to `packages/integration-<slug>/`.**

- `pnpm-workspace.yaml` and root `package.json#workspaces` only cover `apps/*` and
  `packages/*`. `tests/rails/workspace_test.ts:56,77` forces every directory under `apps`
  or `packages` into the `fmt` and `lint` scripts, so a new `packages/integration-x`
  is automatically pulled into the lint gate. The same thing happened when
  `packages/worker-bootstrap` landed on main. A top-level `integrations/` directory
  escapes that rail. Its files would silently skip `deno lint`/`fmt`, and it would also
  need edits to the pnpm workspace, root workspaces, `classify-changes.ts` (unknown
  paths default to the full CI route, which runs against the 5–15 minute CI target),
  and `check-ui-architecture.mjs` discovery.
- Use a `src/` layout. `check-ui-architecture.mjs:196` only walks `<package>/src`.
- If the owner insists on a top-level `integrations/`, add it to `workspace_test.ts`'s
  parent list in the same PR. The other touchpoints are listed in B.

### A3. Separate `/server`, `/web`, `/manifest` entries: **sound, but `exports` alone enforces nothing.**

- `package.json#exports` only constrains bare-specifier resolution through
  `node_modules`. A relative import such as `../../packages/integration-github/src/server/x.ts`
  bypasses it. `apps/worker` already imports `../../../packages/contracts/src/*.ts` in
  violation of `docs/engineering-rules.md` §"TypeScript value and import conventions"
  (for example `apps/worker/src/types.ts:2`, `task-brief.ts:1`). That is proof the
  convention is not enforced. Rails B1/B5 are needed.
- Add a `./testing` entry for conformance fixtures. Use no `./*` wildcard export.

### A4. Hosts keep only a generic core: **sound. Make the rule sharper.**

Provider packages are **pure protocol adapters**. They contain no SQL and do not import
`pg`, `postgres`, `@bakery/persistence`, `inngest` or `hono`. They do not call `Deno.*`,
`process.env` or bare `fetch`. Everything goes through host-injected ports.

The repo already has a model for this. `slack-scope.ts` and `slack-identity.ts` are
"a plain function of its arguments" with no I/O. The SQL-bearing Slack files are
generic stores that belong in core.

This is also why #379 step 3 fails (A9).

### A5. One static registry: **sound. Unify, don't add.**

- One server registry should replace both `deployedIntegrations` and the hard-coded
  lifecycle wiring. #379 says this, which is good.
- One web registry is also needed, and the two must be parity-checked (B4). Server
  and web registries are separate import graphs, so no type can tie them together.
- `GET /v1/integration-providers` is in the doc but not implemented. It should be a
  projection of the in-memory registry. Do not add an `integration_providers` table
  until in-flight effects need version retention.

### A6. The SDK as base layer: **needs change.**

- Keep `mod.ts` runtime-portable and React-free. The README and §11 say "No Deno APIs,
  fetch, node:* or server imports" and "not … React".
- Add **`@bakery/integration-sdk/provider`** for the server types and validators.
- Add **`@bakery/integration-sdk/web`** for types only (`import type` from react). A
  rail asserts that `mod.ts` and `provider.ts` never reach react.
- Use interfaces plus `define*()`/`activate*()` validators, matching `defineIntegration`
  (`activation.ts`). Do not use base classes. This satisfies requirement 3 ("extends or
  implements") and §7's ban on a base-class framework.

### A7. Install/auth strategies: **needs change.**

- **OAuth2 should be one core implementation parameterized by provider data** (an
  `OAuth2Profile`: endpoints, scopes, token-response schema, identity probe). Linear,
  GitLab and Jira should not each implement `exchange`/`refresh`. That gives one
  audited PKCE/state/refresh/rotation path, reusing `integration_auth_attempts`, which
  is already provider-generic (0130).
- **API tokens** work the same way: core stores and encrypts the token, and the provider
  supplies a verification probe.
- **Only the GitHub App needs provider-specific connect code**: two-step install and
  authorize in either order, user-token installation verification, and App JWT.
- Separate **installation-level app registration** (GitHub manifest flow, or a "client
  id/secret/webhook secret" form for OAuth apps) from **organization-level connect**.
  #379 conflates them under `InstallStrategy`.
- Take discovery out of the install strategy (`discoverResources`). It runs repeatedly
  from the discovery and reconcile jobs and needs paging. Search is needed too: GitLab
  can have thousands of projects.
- Generalizing the data model is a **core migration**:
  - `integration_app_registrations` has GitHub-App `NOT NULL` columns
    (`0129:11,22`: `external_app_id bigint`, `private_key_secret_id`, `owner_id bigint`,
    `slug`, `html_url`) and `unique (provider)`.
  - Slack already worked around this: `0149_external_identity_links.sql:8` stores its
    own `external_app_id text` because "registrations for non-GitHub apps arrive with
    the install flow".
  - The fix is to make the GitHub columns nullable and add `provider_metadata jsonb`.
    This is a core migration, not a provider one.

### A8. Webhook verifier and normalizer: **sound idea, wrong signatures and missing cases.**

- `verify(request: Request, secret)` (#379 §12.2) hands the provider an unbounded body.
  Core must do the bounded read first (`intake-body.ts`, 256 KiB). The verifier should
  take `(body: Uint8Array, headers, secrets[] for rotation, now)`.
- "Normalize to provider-neutral events" should be **classify into intake intents**
  (`lifecycle | discovery | refresh{subject}`). Webhooks are wake-up hints (10-tickets
  §Delivery). The existing pipeline stores the provider kind plus a bounded projection
  and routes by purpose.
- For existing rows, compute normalized subjects **on read** via
  `ingress.classify(stored kind)`. That keeps step-wise "no behaviour change" and needs
  no data migration.
- Endpoint scope differs by provider. GitHub is app-level. Linear, GitLab and Jira are
  per tenant: Linear per workspace or OAuth app, GitLab per project or group, Jira
  dynamic webhooks per app with expiry.
- `inbound_events.registration_id uuid not null references integration_app_registrations`
  (`0143:27`) cannot hold connection-scoped endpoints. Generalizing it is a core
  migration plus a `/v1/webhooks/{provider}/{endpointKey}` route (§4 already anticipates
  "an opaque registration endpoint identifier").
- Add **subscription lifecycle hooks** (`ensureSubscriptions`, periodic refresh). Jira
  dynamic webhooks expire, and GitLab hooks are created by API.
- **Path:** `/v1/webhooks/:provider`. GitHub's URL is registered on GitHub's side in the
  App manifest's `hook_attributes.url`, so it must stay byte-identical. It is just the
  `provider=github` instance, so no alias is needed. #379's `/intake/github →
  /intake/:slug` names the action id (`intake.github`), not the route.

### A9. Family ports: do the shapes fit GitHub, Linear, GitLab and Jira?

Provider facts marked *(verify)* should be confirmed against current provider docs
before the port is frozen.

| Semantic | GitHub | Linear | GitLab | Jira | Port decision |
|---|---|---|---|---|---|
| Ticket container | repository | team (or project) | project | project (+ site `cloudId`) | `TicketSourceHandle.container {kind, externalId, displayName}`; resource kinds declared per provider (`linear.team`, …); core SQL stops saying `'repository'` |
| Ticket identity | numeric id + per-repo number | UUID + `TEAM-123` identifier (team key can change) | global id + per-project `iid` | numeric-string id + `PROJ-123` key (changes on move) | `TicketRef {externalId: opaque string; ordinal: number \| null}`; dedupe on `externalId` only; key and URL from `present()` |
| Issue vs PR | **one number namespace; issues API returns PRs** | no PRs (attachments) | separate issues and MRs | none (dev-info panel) | `readTicket → not_a_ticket` (generic); change requests are Code-family only |
| Request trigger | labels | labels + typed workflow states | labels (incl. scoped `a::b`) + open/closed | labels + statuses/transitions | **Label is the shared core trigger** (all four have labels). Status triggers are an **optional capability** (`capabilities.triggers` includes `"status"`). Policy stores trigger **ids** plus display names (10-tickets already asks for ids; the contract stores names only). |
| Who applied the trigger | issue events `labeled` + actor | issue history (added label ids + actor) *(verify)* | resource label events + user | changelog items + author | shared required method `readTriggerProvenance` |
| Actor authority | collaborator permission admin/maintain/write/triage/read | workspace role + team membership *(verify)* | access level 10–50 | project roles/permissions (awkward for a third-party user check) *(verify)* | provider declares an ordered **role ladder**; the port returns `{rank, roleName}`; policy stores the minimum rank. `permission: admin\|write\|read\|none` in the contract is GitHub-only. |
| Delegated actors | numeric user ids | UUIDs | numeric | `accountId` (opaque) | `externalActorIds: string[]` (opaque, bounded) |
| Links | sub-issues + issue dependencies | parent/sub-issues + blocks relations | linked items/epics (tier-dependent) | issue links + subtasks/epics | **optional sub-port `links`** with capability flags. Keep "unknown is never zero". |
| Blocker done | merged PR closes issue (`readPredecessorProof`) | state type `completed` (+ attached PR) | closed by MR | status category Done | required `readResolution → done\|open\|canceled\|unknown`. A merged-change proof via the Code port is a **policy option** (open question). |
| Change feed | app webhooks + `since` page scan | webhooks + GraphQL `updatedAt` filter with relay cursor | webhooks + `updated_after`, keyset/page | dynamic webhooks + JQL `updated >=` with `nextPageToken` | `listChanged(cursor: opaque)`. The provider owns the cursor Zod schema; core owns lease, rest and backoff (`sync-checkpoints`). Replaces `{page, since}` (`ticket-source-reader.ts:161`). |
| Body format | Markdown | Markdown | Markdown | **ADF JSON** (v3) | the port returns normalized Markdown plus `bodyTooLarge`. ADF→Markdown is a provider job. Acceptance-criteria parsing stays generic. |
| Progress comment and reconciliation | HTML-comment marker `<!-- bakery-effect:uuid -->` + bot id | marker survival unverified | notes | **ADF drops HTML comments**; use comment properties *(verify)* | writes are **SDK actions through the effect ledger**, each with its own `reconcile`. The port only names the action ref (`writes.progressComment`). The marker scheme is GitHub-specific and must not leak into Tickets. |
| Visibility | public/private repo | private workspace | public/internal/private, confidential issues | permissions/security levels | `public \| restricted` |
| Rate limits | headers | complexity points | `RateLimit-*` | 429 + `Retry-After` | already normalized (`TicketReadFailure.retryAfterSeconds`). Keep it. |
| Transport | REST (+ GraphQL) | **GraphQL only, `POST`** | REST; **self-managed origins** | REST under `api.atlassian.com/ex/jira/{cloudId}`; Basic for API tokens | **Host broker work:** a GraphQL template kind (fixed, pinned document; read vs write from operation type), since `request.ts:118-120` makes `effect:"read"` ⇔ GET/HEAD; a `binding:` path prefix; per-installation origin with SSRF controls (§7 "custom URLs require a reviewed adapter"); Basic and raw-`Authorization` placements (`integration-gate-profiles.ts:18` allows bearer only) |
| Webhook auth | HMAC-SHA256 body, `X-Hub-Signature-256` | HMAC-SHA256 `Linear-Signature` + body timestamp freshness | `X-Gitlab-Token` shared-secret equality | differs by registration type *(verify)* | verifier gets bytes + headers + secret set + `now`. Core supplies constant-time compare and HMAC helpers. |

**How 09's "share equivalent semantics only, declare optional features separately"
maps onto the interfaces:**

- Required methods are the ones all four providers support: read, list changed,
  present, trigger provenance, actor authority, resolution.
- Optional semantics are **capability flags in the manifest** plus **optional sub-ports**
  whose presence is tied to the flag at type level. For example, `links` is required
  if and only if `capabilities.links === true`.
- `activateProviders` re-checks the flags at runtime.
- Core branches **on capability, never on slug**. An unsupported capability yields an
  explicit readiness reason (for example `provider_capability_missing`), never a silent
  pass.
- Writes are never port methods. They are named SDK action refs, so the effect ledger
  and `integration-effect-door_test.ts` keep holding.

**Code port:** keep it minimal and derived from real consumers: PR/MR identity, current
SHAs, check-run facts and merge state, for GitHub and later GitLab. It excludes
`resolveRepositoryId` (core).

**Chat port:** do not define it yet. Slack today is identity linking plus installation
classification. Identity linking is a cross-family core capability: Tickets needs
"mapped member" authority from it as well. Define `ChatPort` when the first message
consumer lands. The engineering rules say "no speculative framework".

### A10. Provider migrations inside provider packages: **wrong for this codebase now.**

How the migration system works:

- One global ledger `bakery.schema_migrations`.
- Versions `NNNN_name` are ordered lexicographically across all sources.
- Any unapplied migration must sort after the latest applied one
  (`migrate.ts:51-56,125` `MIGRATION_ORDER_VIOLATION`).
- History can never shrink (`migration-definition.ts:156` `MIGRATION_REMOVED_FROM_HISTORY`).
- Sources are a hand-written list (`tasks.ts:209-218`).

Why provider migrations do not fit:

- **Migrations are permanent.** A provider package's migrations stay part of history
  even if the provider is unregistered, so "self-contained, removable module" cannot
  hold for schema anyway.
- **Root lists are hand-maintained and already drift.** The migration roots are
  duplicated in `tasks.ts`, three `--allow-read=` flag lists in
  `apps/server/package.json:11+`, `scripts/lib/postgresql-boundary.ts:75-83`,
  `tests/rails/no-row-level-security_test.ts:5-14` and `classify-changes.ts:92`. **They
  have already drifted:** `postgresql-boundary.ts` omits
  `apps/server/src/modules/projects/migrations`, which `no-row-level-security_test.ts:9`
  includes. The PostgreSQL responsibility-boundary rail does not scan projects
  migrations today. Adding per-provider roots multiplies this.
- **There are no GitHub-only tables to move.** `0143_github_intake.sql` creates
  `inbound_events`, `inbound_event_routes`, `integration_remote_facts`,
  `integration_sync_checkpoints` and `pull_requests`, all generic. `0129`
  registrations are core-shaped with GitHub columns. #379 step 3 ("GitHub's tables'
  migrations into its `server/migrations/`") has nothing correct to move. Moving
  generic DDL into the GitHub package would invert ownership.
- **Provider SQL breaks the pure-adapter rule (A4)** and the writer-door rails.

**Rule:**

- Core owns every table.
- Provider state lives in core-owned `jsonb` columns, validated by **provider-owned,
  described Zod schemas with a schema version**. Today that means `connections.config`
  + `config_schema_version`, `resources.capability_snapshot`, checkpoint cursors,
  fact summaries, `ticket_sources.policy` provider parts, and registration
  `provider_metadata`.
- Provider packages contain **no `.sql` and no SQL strings** (rail B6).
- Escape hatch, only by ADR when a provider needs relational queries over its own data:
  - provider tables named `bakery.integration_<slug>_*`;
  - FKs only into core, never referenced by core;
  - registered in the single `MIGRATION_SOURCES` list (B3);
  - still in the global sequence;
  - written only by a declared store (writer-door rail);
  - permanent once deployed.

The existing 0129–0157 files stay where they are. Moving them across directories is
mechanically possible (same version and checksum), but they are core.

### A11. Co-locating web and server code in one package: **workable. Concrete pitfalls:**

1. **Two type checkers.**
   - `/server` + `/manifest` go through Deno (`deno check`, byonm via `node_modules`
     or a root `deno.json` import map).
   - `/web` + `/manifest` go through `tsc` 7 (`apps/web/tsconfig.json`:
     `moduleResolution: Bundler`, DOM lib, `jsx: react-jsx`).
   - `manifest.ts` and `contracts/` must type-check under both: no Deno globals, no DOM,
     no React. `packages/contracts` already lives with this.
   - The package `typecheck` script needs both commands, for example
     `deno check src/manifest.ts src/server/mod.ts && tsc -p tsconfig.web.json`.
     `turbo run typecheck` picks it up.
2. **Resolution drift.**
   - Deno resolves `@bakery/*` through `node_modules` symlinks (byonm) or explicit
     `deno.json` imports (the SDK is mapped there). Vite and tsc use pnpm symlinks.
   - In the primary clone, root `node_modules/@bakery/*` symlinks point into a stale
     worktree (`../../../bakery-worktrees/issue-40-integration/...`). Expect "works in
     one worktree, not another" until `pnpm install`.
   - Adding a package requires lockfile changes (`--frozen-lockfile` in CI).
   - Map the provider entries in `deno.json` explicitly, and rail that the maps match
     `exports`.
3. **The UI guardrails will not see provider web code.**
   - `ui/raw-element-in-app` applies only under `APP_SOURCE_PREFIX = "apps/web/src/"`
     (`check-ui-architecture.mjs:82,1001-1060`). Extend it to `packages/integration-*/src/web/`.
   - The lint rule `no-client-server-import` treats only `apps/web` and `packages/ui` as
     client roots (`contract-quality.ts:391-396`).
   - `isServerOnlyImport` does not recognize `@bakery/integration-*/server` (`:398-407`).
4. **Tests won't run where #379 puts them.**
   - `scripts/run-tests.ts:35-39` roots every lane at `tests/<lane>`, so
     `integrations/github/tests/` would be silently skipped.
   - Keep tests in `tests/provider` (and the other lanes), parameterized over the
     registry, with fixtures exported from each package's `./testing`.
   - Deno unit tests of web logic only work on `.ts` files without JSX. Keep the
     `model.ts` vs view split that PR #378 already uses.
5. **i18n is one typed catalog.**
   - `MessageKey = keyof typeof en.json` (`packages/i18n/src/keys.ts`), plus generated
     pseudo-locales, `catalogVersion`, and `validate-catalogs.ts`. A package-local
     `i18n/` (#379 step 7) needs a compose generator with a `--check` mode.
   - Simplest enforceable rule for now: provider strings stay in the central catalog
     under `integrations.<slug>.*`, and a rail checks namespace ownership (B8).
   - Add the generator only if the owner wants literal co-location.
6. **Bundle leakage.**
   - Nothing stops `vite build` from bundling a server module today except the lint
     rule, and lint can be suppressed with a named `deno-lint-ignore`, which
     `check-suppressions.ts:23` permits.
   - Add a Vite `resolveId` guard (B5).
7. **Docker.**
   - Both Dockerfiles `COPY . /workspace`, so packages ship automatically.
   - `.dockerignore` excludes `/tests` but not package-local test fixtures. Keep fixtures
     small or ignore them.
8. **CI routing.** Add a `classify-changes.ts` row for `packages/integration-` (to
   `provider_tests` + `integration_tests` + browser lanes for `/web`). Otherwise every
   provider PR runs the full route.

### A12. Conflicts with the SDK trust model and the docs

- **Who owns credentials.** The SDK README says "host owns activation, credentials,
  origins, grants and the broker", and §11 says credential exchange stays outside SDK
  actions. #379 puts `install.ts auth.ts transport.ts` in the provider package. Reconcile
  it explicitly as two tiers in one package:
  - **definition tier:** SDK manifest, actions and templates. Data plus handlers, still
    eligible for future isolation.
  - **driver tier:** first-party, statically registered, reviewed. It may contribute a
    host auth profile and strategies, but runs only through injected ports: an
    origin-bound credentialed transport, *declared* secret slots (no `getSecret(name)`),
    and a clock. It gets no DB, env, or bare `fetch`.
  - Lint/rail: definition-tier files never import driver-tier files.
- **React in the SDK.** "SDK owns … not React" → slot types go in a **separate entry**
  (`@bakery/integration-sdk/web`, types only).
- **§7 layout.** `apps/server/src/modules/integrations/providers/github/` is superseded
  as the final home, but it is the right **intermediate** home during the migration.
- **§3.** `integration_providers` becomes a projection of the registry, not a table,
  until version retention is needed.
- **§4.** Generalize to `/v1/webhooks/{provider}[/{endpointKey}]`. Generalize
  `inbound_events.registration_id`.
- **HostAuthProfile.** Document the new needs: GraphQL templates, path-prefix bindings,
  per-installation origins, Basic/raw placements. Also fix the doc comment that says
  external identity values are "decimal" (`integration-gate-profiles.ts:10`);
  Linear/Jira ids are not.
- **10-tickets.** The policy YAML (`provider: github`, label names) and the contract
  table must say trigger ids and opaque ids. "Repository or project binding" already
  allows non-repo containers.
- **#379 fixes before merge:**
  - path `/v1/webhooks/github`;
  - drop provider migrations;
  - reorder steps (seams before moves);
  - correct the §12.3 mappings;
  - `packages/integration-<slug>` location;
  - add the contract-genericity slice;
  - scope the neutral-zone rail to include `work/ticket-*`, the contracts file and the
    web Issues pages, not just `core/`.

---

## B. Guardrails and enforcement, in priority order

Two existing house patterns are reused throughout:

- **Rails tests:** Deno tests in `tests/rails`, regex over comment-stripped source, as in
  `integration-effect-door_test.ts`. They run in the required PR lane `fast / backend rails`.
- **Ratchet ledger:** JSON counts per `rule|file|subject` that may only shrink. It is
  validated against the merge base, like `validateGuardrailContraction` in
  `check-ui-architecture.mjs:579` and `ui:architecture:check -- --base`. Because the rig
  has no human reviewer, comparing against the merge base is what stops an agent from
  "fixing" a failure by raising the ledger.

Deno lint has no warn level, so **report-only mode lives in the ledger, not in lint.**
Lint rules are enabled for a zone once that zone is clean.

**Exists** means already in the repo. **New** means to add. **Extend** means modify an
existing mechanism.

**P0: land before any code moves (slice 1)**

1. **Import-boundary rail (New), the authoritative check.**
   - Files: `tests/rails/integration-boundaries_test.ts` with
     `scripts/check-integration-boundaries.ts --base <sha>` (run in the rails job).
   - Zones: a declarative `docs/technical-design/integration-baselines/zones.json`.
   - It parses `import`/`export … from`/`import()` specifiers after stripping comments
     and resolves relative paths. Rules:
     - **a.** Web zones (`apps/web/**`, `packages/ui/**`, `packages/integration-*/src/web/**`)
       never reach `apps/server/**`, `@bakery/integration-*/server`, or
       `packages/integration-*/src/server/**`.
     - **b.** Only `apps/server/src/modules/integrations/registry.ts` imports
       `@bakery/integration-*/server`. Only `apps/web/src/integrations/registry.ts`
       imports `/web`. `/manifest` may be imported by core.
     - **c.** No cross-provider imports.
     - **d.** No relative import leaves a package root. This also catches the existing
       `apps/worker → ../../../packages/contracts/src`; baseline it.
     - **e.** Provider zones import only from an allowlist:
       - `server`: `@bakery/integration-sdk{,/provider}`, `@bakery/contracts/{http,integrations,ticket-admission}`, `zod`, own package;
       - `web`: plus `react`, `@bakery/ui`, `@bakery/i18n`, `@bakery/integration-sdk/web`;
       - `manifest`/`contracts`: `zod`, `@bakery/integration-sdk/provider`, `@bakery/contracts/*`.
     - **f.** Provider zones deny `pg|postgres|@bakery/persistence|inngest|hono|node:*|npm:*`,
       `Deno.`, `process.env` and bare `fetch(`.
     - **g.** Neutral zones (B2) never import provider-pending files.
   - A "provider-pending" zone covers today's `github-*.ts`, `callbacks.ts`, `slack-*.ts`
     and the other files in A1. Rule f is relaxed there until each file is lifted, so
     in-flight Slack work is not blocked.
   - Fails: the rails lane.
2. **Provider-neutral zone ratchet (New).**
   - Same script. It counts provider tokens in neutral zones:
     - `apps/server/src/modules/integrations/**` minus provider-pending files;
     - `apps/server/src/modules/work/ticket-*.ts`, `coordination-plan.ts`;
     - `apps/server/src/modules/projects/**`;
     - `packages/contracts/src/{ticket-admission,integrations,implemented-actions}.ts`;
     - `apps/web/src/pages/integrations/**` minus `providers/`;
     - `apps/web/src/pages/{Issue*,issue-*}.ts{,x}`;
     - `packages/i18n/locales/en.json` keys outside `integrations.<slug>.*`.
   - Tokens are derived from registered slugs:
     - `github|gitlab|jira`: case-insensitive substring;
     - `linear`: only as an identifier segment or `"linear"` / `linear.` string literal,
       because "linear" is an English word;
     - plus brand markers (`octokit`, `x-hub-signature`, `api.github.com`).
   - Ledger: `integration-baselines/provider-literals.json`, snapshotted at slice 1 and
     shrink-only. Stale entries fail (as `ui/guardrail-baseline-stale` does). At zero the
     ledger file is deleted and the rule becomes strict.
3. **Single migration-source registry + glob rail (New, fixes existing drift).**
   - Export `MIGRATION_SOURCES` from one module (for example
     `apps/server/src/migration-sources.ts`). Consume it in `tasks.ts`,
     `scripts/lib/postgresql-boundary.ts`, `no-row-level-security_test.ts` and
     `migration-source-registration_test.ts`.
   - A rail globs every `**/migrations/**/*.sql` outside `node_modules` and asserts the
     directory is registered. It also asserts that the `--allow-read=` lists in
     `apps/server/package.json` equal the registry.
   - Expect the boundary scanner to see `projects/migrations` for the first time. Baseline
     any findings.
   - Plus: **no `.sql` files and no `insert into|update|delete from` SQL strings under
     `packages/integration-*`**.
4. **Suppression ban (Extend `scripts/ci/check-suppressions.ts`).** Reject
   `deno-lint-ignore` that names `bakery-boundaries/*` or `no-client-server-import`.
   Fails in `pnpm lint`.

**P1: with the first seams**

5. **Bundler guard (New).**
   - A Vite plugin in `apps/web/vite.config.ts` with `enforce: "pre"`. Its `resolveId`
     calls `this.resolve(...)` and `this.error()` when the resolved id matches
     `/apps/server/` or `/packages/integration-[^/]+/src/server/`. This fails `vite dev`
     and `@bakery/web#build`.
   - A rail asserts the plugin stays wired, in the same way `workspace_test.ts` asserts
     config strings.
   - Optional: a sentinel string exported by each `/server` entry and grepped in `dist/`.
6. **Lint rule for fast feedback (Extend `scripts/lint/contract-quality.ts`).**
   - Add `packages/integration-*/src/web` to `isClientRoot` (`:391`).
   - Teach `isServerOnlyImport` (`:398`) `@bakery/integration-*/server` and `/src/server/`.
   - Add `no-provider-internal-import` and `no-cross-provider-import` rules. Enable each
     per directory only when its ledger zone is clean.
7. **Type-level conformance (New, `@bakery/integration-sdk/provider`).**
   - `defineServerProvider<const M>(manifest, impl: ServerImpl<M>)`: every family in
     `M.families` must have its port, undeclared families are `?: never`, and
     capability-gated sub-ports are required or forbidden (C).
   - `defineWebProvider<const M>(…)`: a connect kind without a host renderer
     (`github-app`) requires `ConnectStep`.
   - The registries are `as const satisfies readonly ServerProvider[]` /
     `ProviderWebModule[]`.
   - Fails: `pnpm typecheck` (required lane).
8. **Runtime activation parity (Extend, modeled on `activateDeployedIntegrations`).**
   `activateProviders(list)` fails startup on any of:
   - schema-invalid manifest;
   - duplicate slug, integration id or UUID;
   - `manifest.integrationId !== integration.manifest.id`;
   - families or capabilities without ports;
   - resource kinds not in the SDK manifest;
   - `tickets.writes` refs not declared as actions;
   - missing host auth profile.

   A unit test runs it on the real registry. Also derive `deployedIntegrations` from it,
   so there is one list.
9. **Registry completeness and parity rail (New).**
   - Every `packages/integration-*/package.json` (excluding `-sdk`) must:
     - be imported by both registries, or be listed in an explicit `excluded` array with
       a reason;
     - be a dependency of `apps/server` and `apps/web` (`/web` only);
     - expose exactly `./manifest`, `./server`, `./web`, `./testing`;
     - have its entries mapped in `deno.json`;
     - appear in the conformance list.
   - The server and web registries' slug sets must be equal. Compare the server list
     (imported) against the web registry's import specifiers (parsed), because Deno
     cannot import the TSX graph.
10. **Conformance suite (New, in the existing required `fast / provider conformance` lane).**
    - `tests/provider/integration-provider-conformance_test.ts`, parameterized over
      `SERVER_PROVIDERS`, mirroring `tests/helpers/harness-conformance.ts`
      (`CONFORMANCE_ADAPTERS`).
    - Fixtures come from each package's `./testing`; the harness lives in
      `@bakery/integration-sdk/testing`.
    - Cases:
      - manifest and activation;
      - ingress: exact-bytes accept; tamper, wrong secret, stale timestamp and rotation
        overlap rejected; classification is bounded and secret-free;
      - connect: `begin` returns only allowlisted URLs; `complete` rejects foreign state
        and replay;
      - credentials: mint narrowing honours resource and permission scope;
      - tickets: truncated labels fail closed; rate-limit mapping; `not_a_ticket`, gone
        and moved; cursor round-trips through its schema; outputs bounded;
        `present()` is deterministic;
      - writes: every declared write action has a `reconcile` that returns `uncertain`
        on absence or truncation.
    - A rail asserts the conformance list equals the registry. The existing
      `integration-effect-door_test.ts` already scans `packages/`, so provider code
      cannot call `handler.invoke`.

**P2: as zones are lifted**

11. **UI guardrail scope (Extend).** `APP_SOURCE_PREFIX` becomes a list that includes
    `packages/integration-*/src/web/`, so raw-element, style-escape and catalog rules
    apply. Add a rail forbidding `fetch(` in provider web code; it must use the
    host-passed typed API.
12. **i18n namespace ownership (New rail + Extend `validate-catalogs.ts`).**
    - Keys `integrations.<slug>.*` may be referenced only from that package or via
      manifest-declared keys.
    - Every manifest i18n key exists in `en.json` and in both pseudo-locales.
    - Neutral zones may not reference `*.<slug>.*` keys literally. For example,
      `settings.connections.github.heading` used in a generic view fails.
13. **Writer-door for core integration tables (New, pattern of `ticket-writer-door_test.ts`).**
    Only the core store files may write `integration_*`, `inbound_*`, `pull_requests` and
    `external_identity_links`. This backs up B1f even if an import slips through.
14. **CI routing (Extend `classify-changes.ts`).** Add a `packages/integration-` row.
15. **Contract neutrality (enforced by B2 on `packages/contracts/src/ticket-admission.ts`).**
    Once at zero, any new `github*` field in a public contract fails.

---

## C. Target layout and minimal interfaces

```text
packages/
  integration-sdk/
    mod.ts            (unchanged) manifest, defineAction/defineIntegration, request templates
                      + GraphQL template kind
    provider.ts       NEW  @bakery/integration-sdk/provider: ProviderManifest, strategies,
                           ingress, family ports, defineServerProvider, activateProviders
    web.ts            NEW  @bakery/integration-sdk/web: slot types only (import type react)
    testing.ts        + provider conformance harness and fake host transport
    src/provider/{manifest,connect,credentials,ingress,activation}.ts
    src/provider/families/{tickets,code}.ts
    src/web/slots.ts
  integration-github/                @bakery/integration-github
    package.json      exports ./manifest ./server ./web ./testing  (no "./*")
    tsconfig.web.json
    src/manifest.ts   ProviderManifest (data only; shared)
    src/contracts/    provider-internal Zod: config, cursors, payloads, template I/O.
                      Never public DTOs.
    src/server/mod.ts defineServerProvider(manifest, {...})
    src/server/{app-registration,connect,credentials,ingress,discovery,lifecycle,health}.ts
    src/server/{tickets,code}.ts
    src/server/actions.ts   today's catalog/integration-providers/github.ts + host auth profile
    src/server/client/      today's github-app.ts, github-transport.ts, github-app-key.ts
                            (pure; transport injected)
    src/web/mod.ts          defineWebProvider(manifest, {...})
    src/web/{ConnectStep,AppRegistrationPanel}.tsx
                            today's use-github-connect, github-connect-handoff,
                            ExistingGitHubAppForm
    src/testing/mod.ts      recorded fixtures for the conformance suite
  integration-slack/        same shape (slack-scope, slack-identity)
apps/server/src/modules/integrations/        core: provider-neutral, ratchet-enforced
  registry.ts             the ONLY importer of @bakery/integration-*/server
  lifecycle/              connections, installations, auth-attempts (+ generic OAuth2 and
                          API-token strategies), app-registrations, reconcile, checks,
                          discovery, fan-out, grants, identity-links
  intake/                 /v1/webhooks/:provider receiver, receipts, route processor,
                          retention, route-target, fact-index
  facts/                  remote-facts, checkpoint engine, sweep, authority (lock + verdict)
  credentials/            broker cache/invalidation, host transport
  migrations/bakery/      ALL integration tables (0129–0157 stay)
apps/server/src/modules/projects/repository-binding.ts   resolveRepositoryId (moved from pull-requests)
apps/server/src/modules/work/ticket-*.ts                 depend on TicketsPort via registry.ticketsFor(connectionId)
apps/web/src/integrations/registry.ts                    the ONLY importer of @bakery/integration-*/web
apps/web/src/pages/integrations/                         generic pages + generic connect renderers (oauth2, api-token)
```

```ts
// ---- @bakery/integration-sdk/provider: shared data (importable by web via /manifest) ----
export const FAMILY_IDS = ["tickets", "code"] as const; // "chat" added when a consumer exists
export type FamilyId = typeof FAMILY_IDS[number];

export type ProviderManifest = Readonly<{
  slug: string; // DB `provider` value and /v1/webhooks/{slug}
  integrationId: `bakery.${string}`; // SDK manifest id (catalog gate)
  providerUuid: string; // UUIDv5(urn:bakery:integration-provider:<slug>); public providerId
  nameKey: string; // i18n key, integrations.<slug>.name
  families: readonly FamilyId[];
  appRegistration: null | { kind: "github-manifest" } | {
    kind: "client-credentials";
    fields: readonly CredentialField[];
  };
  connect:
    | { kind: "github-app" }
    | { kind: "oauth2"; siteSelection: boolean }
    | { kind: "api-token"; fields: readonly CredentialField[] };
  ingress: null | { scope: "app" | "connection" };
  resourceKinds: readonly {
    id: string;
    nameKey: string;
    serves: readonly FamilyId[];
  }[];
  tickets?: TicketsCapabilities; // required iff families includes "tickets"
}>;
export type CredentialField = Readonly<{
  id: string;
  labelKey: string;
  secret: boolean;
  format: "text" | "email" | "https-origin";
}>;

// ---- host-injected context: providers never see DB, env or bare fetch ----
export type DriverContext = Readonly<{
  provider: ProviderRequestPort; // existing SDK port: pinned templates, host-credentialed
  signal: AbortSignal;
  now(): Date;
}>;

// ---- connect (org level) ----
export interface ConnectStrategy {
  begin(
    i: {
      state: string;
      pkceChallenge: string;
      callbackUrl: URL;
      reconnect: ConnectionRef | null;
    },
  ): Promise<{ steps: readonly URL[] }>; // host re-validates the allowlist
  complete(
    i: CallbackInput,
    ctx: DriverContext & { secrets: DeclaredSecrets },
  ): Promise<VerifiedAuthorization | { failure: ConnectFailureCode }>;
}
export type VerifiedAuthorization = Readonly<{
  installation: {
    externalAuthorizationId: string;
    externalAccountId: string;
    accountLabel: string;
    grantedPermissions: Readonly<Record<string, "read" | "write">>;
  };
  credential:
    | { kind: "app-installation" }
    | {
      kind: "oauth2";
      accessToken: SecretValue;
      refreshToken: SecretValue | null;
      expiresAt: string | null;
    }
    | { kind: "api-token"; token: SecretValue };
}>;
// oauth2 and api-token are implemented ONCE in core from this data:
export type OAuth2Profile = Readonly<{
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  tokenResponse: z.ZodType<OAuthTokenResponse>;
  identify(ctx: DriverContext): Promise<VerifiedAuthorization["installation"]>;
}>;

// ---- credentials (call time) ----
export interface CredentialStrategy {
  readonly secretSlots: readonly string[]; // host decrypts only these
  mint(i: {
    binding: ResourceBinding;
    permissions: Readonly<Record<string, "read" | "write">>;
    secrets: Readonly<Record<string, Uint8Array>>;
    ctx: DriverContext;
  }): Promise<
    {
      token: SecretValue;
      expiresAt: Date;
      placement: "bearer" | "basic" | "raw-authorization";
    }
  >;
}

// ---- webhook ingress (core does the bounded read, receipt, dedupe, routes, retention) ----
export interface WebhookIngress {
  readonly maxBodyBytes: number; // <= core cap (256 KiB)
  verify(
    i: {
      body: Uint8Array;
      headers: Headers;
      secrets: readonly Uint8Array[];
      now: Date;
    },
  ): Promise<
    { ok: true; delivery: VerifiedDelivery } | {
      ok: false;
      reason: "signature" | "stale" | "malformed";
    }
  >;
  classify(d: VerifiedDelivery):
    | { kind: "ignored"; reason: "unsupported_event" | "ping" }
    | { kind: "challenge"; body: unknown }
    | {
      kind: "routed";
      externalAuthorizationId: string;
      projection: BoundedProjection;
      intents: readonly IntakeIntent[];
    };
}
export type IntakeIntent =
  | { purpose: "lifecycle" }
  | { purpose: "discovery" }
  | {
    purpose: "refresh";
    subject: "ticket" | "change" | "check";
    resourceExternalId: string;
    subjectExternalId: string;
  };

// ---- Tickets family ----
export type TicketsCapabilities = Readonly<{
  triggers: readonly ("label" | "status")[]; // "label" mandatory in v1
  links: boolean;
  roleLadder: readonly string[]; // ordered low -> high; policy stores the min rank
}>;
export type TicketRef = Readonly<{ externalId: string; ordinal: number | null }>;
export type TicketSourceHandle = Readonly<{
  organizationId: string;
  connectionId: string;
  resourceId: string;
  container: { kind: string; externalId: string; displayName: string };
}>;
export type TicketRead =
  | {
    kind: "present";
    snapshot: NormalizedTicket;
    providerUpdatedAt: string;
    visibility: "public" | "restricted";
  }
  | { kind: "not_a_ticket" }
  | { kind: "gone" }
  | { kind: "moved" }
  | TicketReadFailure; // existing shape
export interface TicketsPort<C extends TicketsCapabilities> {
  present(
    s: TicketSourceHandle,
    r: TicketRef,
  ): { key: string; url: string; label: string };
  readTicket(
    s: TicketSourceHandle,
    r: TicketRef,
    ctx: DriverContext,
  ): Promise<TicketRead>;
  listChanged(
    s: TicketSourceHandle,
    cursor: unknown | null,
    ctx: DriverContext,
  ): Promise<
    | {
      kind: "present";
      items: readonly TicketChange[];
      next: unknown | null;
      done: boolean;
    }
    | TicketReadFailure
  >;
  readonly cursorSchema: z.ZodType; // core stores the cursor opaque, provider validates it
  readTriggerProvenance(
    s: TicketSourceHandle,
    r: TicketRef,
    t: TriggerRef,
    ctx: DriverContext,
  ): Promise<TriggerProvenance>;
  readActorAuthority(
    s: TicketSourceHandle,
    actor: { externalUserId: string },
    ctx: DriverContext,
  ): Promise<
    | { kind: "present"; rank: number; roleName: string }
    | { kind: "absent" }
    | TicketReadFailure
  >;
  readResolution(
    s: TicketSourceHandle,
    r: TicketRef,
    ctx: DriverContext,
  ): Promise<
    | { kind: "done" | "open" | "canceled" | "unknown"; linkedChanges: readonly ChangeRef[] }
    | TicketReadFailure
  >;
  links: C["links"] extends true ? TicketLinksPort : undefined;
  writes: Readonly<{ progressComment: ExactRef }>; // SDK action, executed via the effect ledger
}

// ---- server provider + typed conformance ----
type FamilyPorts<M extends ProviderManifest> = {
  tickets: TicketsPort<NonNullable<M["tickets"]>>;
  code: CodePort;
};
export type ServerImpl<M extends ProviderManifest> = Readonly<
  {
    integration: DefinedIntegration; // integration.manifest.id must equal M.integrationId
    hostProfile: HostAuthProfile;
    connect: M["connect"]["kind"] extends "github-app" ? ConnectStrategy
      : M["connect"]["kind"] extends "oauth2" ? OAuth2Profile
      : ApiTokenProbe;
    credentials: CredentialStrategy;
    ingress: M["ingress"] extends null ? undefined : WebhookIngress;
    lifecycle: InstallationLifecycle;
    discovery: ResourceDiscovery;
    health: HealthProbe;
    families:
      & { [F in M["families"][number]]: FamilyPorts<M>[F] }
      & { [F in Exclude<FamilyId, M["families"][number]>]?: never };
  }
>;
export declare function defineServerProvider<const M extends ProviderManifest>(
  manifest: M,
  impl: ServerImpl<M>,
): ServerProvider<M>;

// ---- @bakery/integration-sdk/web (types only) ----
export type ProviderWebModule<M extends ProviderManifest = ProviderManifest> =
  & Readonly<{
    manifest: M;
    AppRegistrationPanel?: ComponentType<{ api: IntegrationsWebApi }>; // default: generic credential form
    ConnectionSection?: ComponentType<
      { connection: ConnectionView; api: IntegrationsWebApi }
    >;
    describeResource?(r: ResourceView): string;
    describePermission?(name: string, level: string): string;
  }>
  & (M["connect"]["kind"] extends "github-app" // no generic renderer for app installs
    ? { ConnectStep: ComponentType<ConnectStepProps> }
    : { ConnectStep?: ComponentType<ConnectStepProps> });
export type ConnectStepProps = Readonly<{
  organizationId: string;
  reconnect: string | null;
  api: IntegrationsWebApi; // typed client subset; slots never call fetch
  onOutcome(o: ConnectOutcome): void;
}>;

// ---- registries ----
// apps/server/src/modules/integrations/registry.ts
export const SERVER_PROVIDERS = [githubProvider, slackProvider] as const satisfies
  readonly ServerProvider[];
export const providers = activateProviders(SERVER_PROVIDERS); // throws on drift
// apps/web/src/integrations/registry.ts
export const WEB_PROVIDERS = [githubWeb] as const satisfies readonly ProviderWebModule[];
```

---

## D. Migration plan: GitHub into a package, in small mergeable slices

The principle is to **cut seams in place, then lift**. While a provider is "pending",
its implementation lives in `apps/server/src/modules/integrations/providers/<slug>/`,
which §7 already prescribes. A zone becomes a package only when it is import-clean.
Every slice must lower the ledger, which keeps the ratchet honest.

| # | Slice | Behaviour change | Enforcement switched on |
|---|---|---|---|
| 0 | Fix #379 (A12 list), then merge the doc | none | — |
| 1 | B1–B4: boundary rail + neutral-zone ledger snapshotted at today's counts (merge-base contraction), `MIGRATION_SOURCES` + glob rail (scans `projects` migrations for the first time; baseline any findings), suppression ban | none | ratchet live: no zone may get worse. In-flight Slack/#378 work keeps going in provider-pending zones. |
| 2 | SDK `provider`/`web` entries: types, `defineServerProvider`, `activateProviders`, conformance harness skeleton. No callers. | none | typecheck covers the new types |
| 3 | Server registry, built **in place** from today's files. `deployedIntegrations` derives from it. The slug/integration-id/UUID map replaces `GITHUB_PROVIDER{,_ID}` in `connections`, `installations`, `installation-fan-out`, `auth-attempts` audit details. Stored values are unchanged (`"github"`). | none | B8 activation parity; ledger drops |
| 4 | Split mixed files in place: `fact-reads` → `facts/authority.ts` + GitHub subjects; `write-authority` takes the resource kind; `resolveRepositoryId` → projects; `ticket-reads` → core `intake/route-target` + `fact-index` + GitHub reader; Slack link/attempt stores → core `identity-links`. `work` imports only core + port. | none | lint `no-provider-internal-import` on `modules/work` |
| 5 | Ingress seam: `/v1/webhooks/:provider` (GitHub URL byte-identical), GitHub `WebhookIngress`; route target classifies on read | none | — |
| 6 | Credentials seam: generic broker cache + GitHub `CredentialStrategy` | none | — |
| 7a/7b | Connect seam: `auth-attempts` + `callbacks` split (core claim/bind/audit vs GitHub install/authorize convergence). The biggest slice, so two PRs. | none | — |
| 8 | App-registration seam: `postgres.ts` → core store + GitHub manifest strategy | none | — |
| 9 | Lifecycle, discovery, health seams (`reconcile`, `discoveries`, `checks`) | none | — |
| 10 | Facts seam: checkpoint engine + GitHub `SyncStream`s, route processor + `FactSource` | none | `providers/github/` must now pass B1f (provider rules) |
| 11a | **Pilot lift with Slack** (its pure files already meet B1f): `packages/integration-slack` | none | package-zone rules, B5 Vite guard, B9 parity |
| 11b | Lift GitHub: `git mv providers/github → packages/integration-github/src/server`, plus `catalog/integration-providers/github.ts` and the `github-app` host profile. Registry import switch. | none | provider package rules enforced |
| 12 | `TicketsPort` (C) with the GitHub adapter wrapping today's reader. `present()` replaces `ticket-store.ts:478` and `ticket-snapshot.ts:49` (same strings for GitHub). `pull_request → not_a_ticket` mapped back to today's reason code. | none | conformance suite (B10) for tickets |
| 12′ | **In parallel:** a Linear spike against `TicketsPort` and the broker, using recorded fixtures only, not merged. Freeze the port only after two implementations (rule of two). | — | — |
| 13 | **Breaking contract slice (pre-approved by repo rules):** `ticket-admission.ts` generalization (opaque ids, container, `externalActorIds`, trigger ids, role rank). Generic operation ids for `integrationAuth.github*` / `intake.github`; URLs unchanged; audit history keeps old names. Broker: GraphQL templates, path-prefix bindings, placements. Core migration generalizing `integration_app_registrations` and `inbound_events.registration_id`. Rebind `contract-migrations/*.json`. | **yes (wire contract)** | B2 at zero for contracts |
| 14 | Web (after #378 merges): move `pages/integrations/providers/github/*`, `app/github-connect-handoff.ts`, `screens/ExistingGitHubAppForm.tsx` into `/web`. Generic oauth2/api-token renderers. Rename `?githubConnection=` (`callbacks.ts:100` + `OrganizationIntegrationsPage.tsx:42`) in one PR; it is a Bakery-internal redirect. Neutralize the Issues pages via manifest names. | redirect param name only | B11, B12, web lint rules; ledger → 0 |
| 15 | Delete the ledger, so the rails run strict. Linear lands as a pure addition: package + two registry lines + `OAuth2Profile`. | — | strict |

**PR #378.** Do not hold it for the architecture. It already isolates the connect hook in
`pages/integrations/providers/github/use-github-connect.ts`, and `model.ts` is
essentially provider-neutral. Ask for only the cheap things:

- no new `github` identifiers in generic files, for example
  `settings.connections.github.heading` in `ConnectionView` (use a provider display-name
  lookup keyed by `connection.provider`);
- keep `githubConnection` confined to the existing parameter.

Merge it before slice 1, so its counts land in the initial ledger snapshot. Otherwise
whichever lands second must re-snapshot. Slice 14 extracts it.

**PR #379.** Request changes for the A12 list before merge. In particular: step 3 must
come after the seams, and the provider-migrations recommendation (§12.7 Q1) must flip.

---

## E. Open questions for the product owner

1. **Self-hosted instances:** are GitLab self-managed, GitHub Enterprise Server or Jira
   Data Center in scope? A yes makes per-installation API origins (with SSRF controls)
   a host requirement, and that is the largest broker change.
2. **"Ready" on Linear/Jira:** label only, matching GitHub, or also a workflow
   status/transition such as "Ready for agent"?
3. **Connection methods:** are pasted API/personal tokens (Jira API token, GitLab PAT,
   Linear API key) acceptable, or OAuth/App installs only?
4. **Dependency completion on trackers without code:** is "blocker is Done" enough to
   admit dependent work, or must there be a merged change, as GitHub requires today?
