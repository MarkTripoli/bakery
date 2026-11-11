# Backend rails

This document defines the reusable backend rails. The entity and endpoint inventory belongs in the main Bakery design; examples below name only enough actions to make the rails implementable.

## Decisions and boundaries

Bakery is a TypeScript/Deno modular monolith at first. Hono owns HTTP routing; `apps/server` hosts the Deno + Mastra + Inngest HTTP handler; `apps/worker` runs prepared execution hosts; and `apps/web` is the React client. Postgres owns durable state; Inngest owns durable workflow execution; Bakery owns tasks, conversations, runs, artifacts, permissions, worker jobs, inbound/outbox records, and audit facts. A local process runs the same application code and contracts as a distributed installation.

The application is split by dependency direction:

```text
apps/web, apps/server, apps/worker (composition only)
                    |
modules/<context>/application -> domain -> ports
                    ^                         |
packages/config, packages/contracts  adapters (Postgres, providers)
```

`packages/contracts` contains versioned Zod schemas, DTO types, event envelopes, faults, and generated OpenAPI. `packages/ui` contains shared web components; `packages/config` contains validated configuration. A context may import another context's public application port or contract, never its `domain`, store, or adapter. Platform contains no context imports. `apps/*` may compose modules but may not contain business rules. Do not add a command-bus framework: a plain typed action registry is the adapter boundary.

The proposed source layout is deliberately small:

```text
apps/web/src
apps/server/src/{main.ts,app.ts,platform,modules/<context>/{domain,application,ports,adapters,v1}}
apps/worker/src/{main.ts,worker-contract.ts}
packages/contracts/src/{v1,events.ts,faults.ts,openapi.ts}
packages/ui/src
packages/config/src
```

The module anatomy follows Alidade's proven split: `v1/routes.ts` wires paths only, `v1/handlers.ts` parses, calls the application port, and returns, `v1/types.ts` holds version DTOs, and version-agnostic domain/store/service code stays outside `v1`; centralized guards own authorization. This is stated in Alidade's repository rules (AGENTS.md, lines 35–39).

## Commands, queries, and schemas

Every state change is a registered command; every read is a registered query. Registration is explicit and checked at startup:

```ts
import type { ActionName } from "@bakery/contracts/v1/actions"; // generated literal union
type CommandDefinition<I, O> = {
  name: ActionName; // generated from api-catalog.json, e.g. tasks.create
  version: 1;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  authorize: (actor: Actor, input: I) => Promise<void>;
  idempotency: "required" | "natural" | "none";
  execute: (ctx: CommandContext, input: I) => Promise<O>;
};
```

The initial registry should include catalog actions such as `tasks.create`, `runs.create`, `runs.control`, `runs.retry`, `artifacts.create`, `worker.claim`, `worker.events`, and `worker.result`. Queries include `tasks.get`, `tasks.list`, `runs.get`, `artifacts.get`, and `workers.list`. These names are stable action identifiers, not HTTP verbs. `POST /v1/tasks` and an MCP `bakery_tasks_create` tool both invoke the exact `tasks.create` definition. The plain typed registry rejects unknown names, validates the input once, calls the central authorization function, and applies the idempotency policy before execution.

Zod is the source of truth for input/output/event schemas. The contract package exports the schema and inferred TypeScript type together. OpenAPI is generated from those schemas during `contracts:generate`; CI fails if the generated document is stale or if a breaking diff is found. The converter must run under Deno's import map; select a Deno-compatible Zod-to-OpenAPI converter in the first compatibility spike rather than adding an HTTP framework solely for documentation. JSON Schema exposed to MCP and harness adapters is generated from the same schema. Runtime validation remains mandatory at every trust boundary, including webhooks, MCP, worker reports, and Inngest events.

The logical model in [`data-model.json`](data-model.json) is authoritative for names used by this rail: `workflow_runs` contains the durable run, `run_steps` contains stable semantic nodes, `jobs` is the capacity queue, `job_attempts` is the fenced execution lease, and `attempt_events` is the worker journal. Recovery compares `jobs.current_fence`, `job_attempts.fence` and `job_attempts.last_event_seq` against contiguous `attempt_events.local_seq`. Intake dedupe uses `inbound_events`; client-visible sequencing uses `domain_events`; delivery uses `outbox`; unsafe request replay uses `idempotency_records`; uncertain provider/Git effects use `external_effects`. Worker registration accepts a worker-generated base64 credential containing at least 32 random bytes, stores only `worker_hosts.credential_hash` plus its monotonic generation, and never returns the credential. The added enrollment, steering, preview-grant, merge-evidence, and budget records remain durable control-plane state. `workflow_runs.repository_profile_id` may be null for cloud-only import/schedule work, while a code job requires both repository and profile; `jobs.repository_id` may be null only for an explicitly registered host action such as MCP discovery. This document does not rename or duplicate those logical records.

The API stays under `/v1`. Additive fields are compatible; a breaking change requires a new major route and an explicit migration. Every paginated collection uses the shared cursor/keyset contract in chapter 02. Reject page-number/offset/skip inputs; authenticate cursor context and recheck grants before each indexed seek. Finite bounded embedded arrays remain part of their parent representation. JSON requests are bounded before parsing and accept `application/json` or `+json`. These are directly reusable Alidade rules (API-STANDARDS.md, lines 50–87).

## Schema descriptions are mandatory semantic metadata

Every Zod schema/type and every field requires a meaningful non-empty
description, without exceptions. This includes nested objects, array items,
record keys/values, union members, enums, reused primitives, derived schemas,
internal contracts, examples and tests. The repository rule is in
[the engineering rules](../engineering-rules.md).

Attach `.describe(...)` or `.meta({ description: ... })` to the final schema
and to its children. Explain purpose and correct use, including units, source,
scope and absence semantics where relevant. Comments, field-name repetition,
`TODO` and generated filler do not satisfy the rule. Re-describe after schema
composition: Zod metadata belongs to a specific instance and can be lost by
refinement. [Zod metadata](https://zod.dev/metadata).

```ts
const RunInput = z.strictObject({
  taskId: z.uuid().describe("Task UUID in the current authorized organization whose workflow should run."),
}).describe("Run admission input; server policy resolves the workflow and execution authority.");
type RunInput = z.infer<typeof RunInput>;
```

Descriptions survive JSON Schema, OpenAPI, MCP, SDK and action/skill catalog
generation. Registration and `contracts:generate` must reject missing/blank
descriptions recursively; CI also fails if generation loses them. Review checks
semantic usefulness. Human interface labels remain localized separately;
descriptions contain no secrets and grant no authority. The JSON design
inventories are not compiled Zod schemas: generation must obtain real semantic
descriptions before emitting contracts, never fabricate them from field names.

The current SDK specimen enforces descriptions when registering actions and
integrations. A design-time probe verified
schema graphs, emitted root metadata, and rejection after a child's metadata
is lost. Production contract generation/CI wiring remains an implementation gate.

## Standard errors

Use [Standard errors](12-standard-errors.md) for `StandardError`, throwing guards, `toProblem`, `problemResponse`, the fault catalog and REST/MCP error envelopes. These shared contracts apply to every backend module.

### Machine readiness and provider-binding mappings

The issue-59 machine routes (see [Machines](21-machines.md)) stay inside this registry and map their bounded reason codes as follows:

| Situation | Code | Rule |
|---|---|---|
| Admin cancel/replace/re-pair racing a consumed enrollment | `409 STATE_CONFLICT` | The locked register/cancel transaction decides the single winner; the conflict response carries an authorized machine reference (or safe expired state) and leaks no foreign-organization or token identity. An expired enrollment stays an audit record and never becomes cancelable. |
| Registration or inventory exceeding the enrolled slot ceiling | `422 UNPROCESSABLE` | Slot/capability/toolchain admission stays within the ceiling fixed at enrollment. |
| Inventory report declaring capabilities outside the host's granted set | `422 UNPROCESSABLE` | Capability escapes are rejected per component inside the bounded report; the report as a whole is not partially applied. |
| Worker provider-auth completion for another binding, a stale host/generation or a non-active attempt | `403 AUTH_FORBIDDEN` | Worker bearer credential authenticates the host, not the binding; the attempt's generation and binding scope are rechecked server-side before any identity binding. |
| Changed or duplicate provider-auth completion report | `409 STATE_CONFLICT` | Replay of the identical report returns its saved acknowledgment; a materially different completion for a bound attempt conflicts inside the same organization transaction. |
| Enrollment inspection with an invalid/expired token | Rate-limited token-proof response | No-store response, no consumption, no added authority, and never an out-of-scope identity reveal. Error mappings follow the shared catalog. |

Sync scoping: `/v1/sync` and `/v1/events` subscription scopes include `worker_enrollment` and `worker`, realized through the new nullable organization-constrained `worker_host_id`/`worker_enrollment_id` columns on `domain_events` with composite org FKs and indexes; subscriptions always recheck live membership/authority. The provider-auth challenge and login reveal responses are session-scoped, non-cacheable and no-store; they are delivered once to the initiating principal at create/request time and are never domain events.

## Live tenant authority

Bakery owns organization lifecycle, principal-keyed memberships, invitations
and exact action grants. Better Auth remains the human authentication provider
for users, credentials and sessions; its organization, member and invitation
rows are retained only for migration or compatibility inspection and are not a
runtime authority source. A human membership is always role-bearing; a service
or worker membership may use role null for grant-only access or an Admin or
Developer permission bundle. The initial role set is exactly `Admin` and
`Developer`, selected per organization and never stored in a session or
treated as a global human role.

The authorization predicate is additive and fail-closed:

```text
enabled principal
AND eligible organization relationship
AND (membership role satisfies action OR live exact permission_grant matches)
AND every required actor-kind, tenant, resource and action-specific guard
```

The database adds no second isolation authority: PostgreSQL row-level security
is not permitted, and every organization-owned query carries an explicit
organization predicate enforced by the `tests/rails/no-row-level-security_test.ts`
rail.

`permission_grants` contains exact capability, expiry, revocation and policy
revision state. It has no role column, wildcard or prefix inheritance, and an
exact grant never promotes a principal to a role. A missing membership may
retain exact-only service or worker access; an explicit inactive membership
denies organization access even when grants remain. Deleting a membership
revokes that principal's organization grants atomically, while role demotion
alone preserves independent exact grants. Human grant-only access is not
introduced. Effective-access projections may show `role: null` for the
documented exact-grant-only non-human relationship, but resource authorization
still runs when an action executes.

`Bakery-Organization-Id` selects REST organization context and never grants
authority. Required-context routes declare the organization path parameter and
the shared registry rejects a header/path mismatch. The three Better Auth
1.7.3-compatible recipient invitation routes are the narrow exception: GET
`/api/auth/organization/get-invitation` takes query `id`; POST
`/api/auth/organization/accept-invitation` and POST
`/api/auth/organization/reject-invitation` take body `invitationId`. They use
authenticated-principal scope, derive organization from the validated live
invitation, require the current enabled human recipient, and accept no
caller-supplied recipient, organization or authority. Absent and foreign
invitation IDs collapse to the same safe not-found response. Compatibility
envelopes preserve Better Auth field names; `inviterId` and `inviterEmail` are
null when a Bakery service or worker inviter has no provider identity or email,
never fabricated.

## Transport mapping

All transports call the same command/query registry and therefore share validation, authorization, idempotency, and fault codes.

* REST uses `/v1` resources and transition resources. A synchronous command returns `200`/`201`; a queued run returns `202` with a tracking `Location`. `GET` uses `304` when an ETag matches. Problem responses include `Allow`, `Retry-After`, `ETag`, and `Idempotent-Replayed` when applicable.
* WebSocket is `/v1/events` and is strictly a notification channel. It supports only authenticated `subscribe`, `resume`, `ack`, and `ping` messages; all domain writes remain REST or MCP actions. Server batches carry the exact Event envelope from the schema inventory. A protocol failure carries `{type:"problem", requestId, problem}`. Sequence gaps trigger scoped replay through `/v1/sync`; the client never treats socket disconnect as a run failure.
* MCP 2026-07-28 uses stateless POST requests and OAuth 2.1 before dispatch. It exposes command definitions as tools and queries as read tools. Generated input schemas are used in tool registration. Dispatched tool errors use `resultType: "complete"`, set `isError: true` and include the bounded Problem Details object in `structuredContent`; the text is a short catalog detail. MCP authentication identifies the actor, and the server still calls the same authorization guard.
* Harness adapters normalize native output into the registered `workerEvents` discriminated union. Job assignments validate against `workerActions`; terminal result fields are mutually exclusive by status. Unknown event/action types fail validation. Worker/harness/provider identities remain separate.
* Inngest events use versioned names such as `bakery/run.requested.v1`. The Inngest function records the run/step before doing work, calls Mastra or a worker through the adapter, and reports a durable result. Inngest retry policy handles transient function execution; Bakery state remains the source of task/run truth. A terminal `Fault` is recorded, while a retryable fault schedules the next attempt with bounded backoff.

## Request path and asynchronous failure path

```text
Request -> request context -> bounded body/schema parse -> authenticate
        -> command/query registry -> centralized authorize
        -> Postgres transaction (idempotency claim + state + outbox) -> response/ack
                                                     |
                                                     v
                                             dispatcher/Inngest/worker
                                                     |
                                  attempt-event claim -> sequence check -> state transition
```

For skill uploads, bounded validation and verified immutable object writes are a preparation phase before this transaction; the transactional action receives only metadata and verified references. It rechecks authorization and idempotency before publishing. Provider/file I/O never runs inside the transaction shown below.

Synchronous pseudocode:

```ts
async function handle(request: Request) {
  const ctx = requestContext(request); // requestId, traceId, actor, deadline
  try {
    const definition = registry.require(ctx.commandName);
    const input = definition.input.parse(await readBoundedJson(request));
    const actor = await authenticate(request);
    await definition.authorize(actor, input);
    const output = await db.transaction(async (tx) => {
      const replay = await idempotency.claimOrReplay(tx, ctx, input, definition);
      if (replay) return replay;
      const result = await definition.execute({ ...ctx, tx, actor }, input);
      const encoded = serializeValidatedResponse(definition, result);
      await idempotency.complete(tx, ctx, encoded); // exact status/body committed with the mutation
      return encoded;
    });
    return response(output, ctx); // commit happened before this line
  } catch (error) {
    return problemResponse(error, ctx); // shared toProblem + locale/header mapper
  }
}
```

Asynchronous result pseudocode:

```ts
async function acceptWorkerMessage(message: WorkerMessage) {
  const ctx = requestContextFromMessage(message);
  return db.transaction(async (tx) => {
    const job = await tx.jobs.lock(message.jobId);
    const attempt = await tx.jobAttempts.lock(message.attemptId);
    if (!job || !attempt || attempt.worker_host_id !== ctx.workerHostId || attempt.lease_token_hash !== hash(ctx.leaseToken)) {
      return ack(message, "LEASE_FENCED");
    }
    const prior = await tx.attemptEvents.get(message.attemptId, message.local_seq);
    if (prior) return prior.payloadDigest === serverDigest(message) ? prior.savedAck : ack(message, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    // A read-only replay of a committed event precedes expiry/fence checks.
    if (attempt.fence !== message.fence || job.current_fence !== message.fence || attempt.status === "lost") {
      return ack(message, "LEASE_FENCED");
    }
    if (attempt.lease_expires_at < ctx.now || !["leased", "running", "canceling"].includes(attempt.status)) return ack(message, "LEASE_EXPIRED");
    if (isTerminal(job.status)) return ack(message, "ALREADY_TERMINAL");
    if (job.cancel_requested_at && message.type === "job.succeeded") return ack(message, "CANCEL_REQUESTED");
    if (message.local_seq !== attempt.last_event_seq + 1) return ack(message, "EXPECTED_SEQUENCE");
    await tx.attemptEvents.insert(message, { digest: serverDigest(message) }); // consume only contiguous events
    await tx.jobAttempts.advance(attempt, message.local_seq);
    if (message.type === "job.failed") await tx.jobs.failOrRetry(job, boundedWorkerFault(message.fault));
    else if (message.type === "job.succeeded") await tx.jobs.complete(job, message.result);
    else if (message.type === "job.cancelled") await tx.jobs.cancel(job, { processExitConfirmed: true });
    else await tx.jobs.applyEvent(job, message);
    // Each terminal helper ends the attempt and updates step/job + completion outbox.
    const response = ack(message, "applied");
    await tx.attemptEvents.saveAck(message.attemptId, message.local_seq, response);
    return response;
  });
}
```

`EXPECTED_SEQUENCE` is a 409 response/ack and does not mark the gap event consumed; the worker replays the missing local sequence. Identical duplicates receive a byte-identical acknowledgment. A canceled job cannot be resurrected by a late success or progress event. The worker persists a checkpoint before acknowledging a long step. If it disappears, the lease expires, the old process/workspace is fenced and quarantined, and reconciliation checks uncertain effects before allocating a new attempt. A new attempt may use a fresh workspace; it must not blindly resume the same worktree. A late result from an old attempt is durably ignored. If the completion acknowledgment is lost, the same event is replayed and attempt-event dedupe applies it once.

The `worker.result` action is the terminal adapter over this same journal path. It inserts the terminal `attempt_events` row at `localSeq`, computes its digest from the received canonical bytes, and applies the terminal transition in the same transaction. It does not maintain a second result ledger or trust a client digest. Cancellation and terminal completion arbitrate under the job lock: a committed terminal result makes later cancellation `ALREADY_TERMINAL`; a committed cancellation request rejects a later success with `CANCEL_REQUESTED`. Both event and result routes normalize to the same semantic event envelope before hashing; transport path, bearer token, request ID and server receipt timestamp are excluded from that digest. An identical saved acknowledgment may be read after lease expiry; it performs no state mutation.

## Transactions, idempotency, and outbox

`withPgTransaction` discards an aborted request's pooled client, even after its
query and rollback finish. PostgreSQL `CancelRequest` travels on a separate
connection and can arrive late; reusing that backend could cancel the next
borrower's unrelated query. Successful non-aborted transactions remain reusable;
rollback failures retain their existing discard behavior. Cancellation adds no
automatic retry or change to authentication or committed outcomes.

Every mutation that changes user-visible state and emits a durable event uses one Postgres transaction. The transaction writes the state row/version, an append-only audit fact, and an outbox row. The outbox dispatcher leases rows with `FOR UPDATE SKIP LOCKED`, delivers stable Inngest wakeups or invokes the trusted effect executor for Slack/GitHub destinations, and marks delivery attempts. Every provider mutation, including a notification, requires its persisted external-effect identity; the dispatcher cannot call a provider directly without that ledger. External calls never run inside the database transaction. Outbox records are retained until successful delivery plus the configured recovery window. WebSockets independently tail authorized domain_events; they are not an outbox destination. Other integration effects use the external_effects reconciliation ledger.

Budget reservations are durable rows committed with the action intent. Caps are enforced per provider installation and UTC calendar month, and per workflow run lifetime; concurrent reservations lock the relevant `budget_accounts` rows. A provider quota or cap failure releases the reservation in the same state transition and maps to `PROVIDER_QUOTA_EXCEEDED` or `BUDGET_CAP_EXCEEDED`; unknown external effects remain reserved until reconciliation.

Unsafe REST and MCP commands use an explicit `Idempotency-Key`, except when the
catalog declares a natural idempotency key for the command. Replay scope is
organization for organization-scoped commands; `installation` is the explicit
non-organization boundary for principal-scoped and installation-admin commands.
Completed receipts remain actor-scoped by `principal_id` and action. The command
mutation, outbox intent, and serialized response status/body are committed with
the completed receipt in the same transaction. The response is returned only
after commit.
A crash after commit but before the response is safe: a duplicate
replays the exact stored result and sets `Idempotent-Replayed: true`; an active
concurrent request returns `IDEMPOTENCY_IN_FLIGHT`; a different fingerprint
returns the stable `IDEMPOTENCY_PAYLOAD_MISMATCH`.

Verified provider webhooks first become `inbound_events`, keyed by provider registration and external delivery ID; schedule ticks instead admit deduplicated `automation_firings` under their schedule identity. For webhook receipts, identical duplicates are acknowledged and a changed digest is rejected. Worker messages become `attempt_events`, keyed by attempt and `local_seq`, with identical duplicates acknowledged byte-for-byte and changed duplicates rejected. Event sequence and state-version checks reject or defer out-of-order messages. Migrations are append-only and checksum-recorded; Alidade's migration runner provides the useful baseline of a `schema_migrations` table, sorted files, checksums, and one transaction per migration (migrate.ts, lines 4–41).

For destructive commands, when no explicit `Idempotency-Key` is supplied, the
catalog must declare natural idempotency. `createNormalizedCommandMetadata`
then derives `natural:<action>:<target>` for route-only identity, or
`natural:<action>:<target>:<field>:<encodedValue>` when the catalog declares a
required string input identity field. The explicit key wins. A `DELETE`
request may include a strong `If-Match`.
The validator participates in the request digest: the same key with a changed
or newly added validator returns `422 IDEMPOTENCY_PAYLOAD_MISMATCH`. A stale
supplied validator returns `412 PRECONDITION_FAILED` before any mutation. An
omitted validator leaves a natural `DELETE` unconditional; a `PATCH` requires
the validator, and an omitted `PATCH` validator returns `428 PRECONDITION_REQUIRED`
before mutation.

## Skill file storage boundary

The catalog service depends on one small port, with the two requested implementations selected at startup. Postgres owns metadata and authority; the store only owns immutable bytes. There is no new storage service or local S3 emulator.

```ts
interface SkillFileStore {
  putIfAbsent(key: SkillObjectKey, bytes: Uint8Array): Promise<void>;
  read(key: SkillObjectKey): Promise<Uint8Array>;
}
// R2SkillFileStore: private S3-compatible API.
// FilesystemSkillFileStore: native Deno filesystem beneath one configured root.
// Both enforce the 10MiB revision limit and hash-check content in the caller.
```

`SkillObjectKey` is generated from validated IDs and SHA256 values, never caller paths. `putIfAbsent` must not replace existing bytes: an existing object is accepted only after its bytes match the expected hash and size. R2 supports conditional `PutObject` with `If-None-Match`; use a current compatible S3 client and explicitly verify this behavior in the Deno spike. The filesystem adapter writes a private temporary regular file, flushes it, and publishes with an atomic no-replace operation on the same filesystem; reject symlinks and keep the root inaccessible to harness processes. Confirm crash durability on Linux and macOS. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

The importer validates a complete regular-file inventory, safe paths, license and capability manifest without executing scripts. It computes hashes from bytes and the revision digest from the canonical manifest. It writes the immutable objects, reads back/verifies their hashes, and only then publishes the version in a short Postgres transaction. Remote-source workflow imports can checkpoint draft metadata, but Inngest steps and events carry only IDs/digests. Direct local uploads keep decoded bytes in a bounded request buffer until the external writes finish; they never persist upload content in Postgres.

Publication rechecks the caller's current permission, expected revision, entry path and verified manifest, then commits file metadata, version/pointer changes, idempotency response and event atomically. Object I/O is outside that transaction. A timeout or crash before publication leaves inaccessible objects or a draft; retries verify/reuse the same keys. A lost database response replays the committed idempotency result. A source ref that changes content under the same import request fails its pinned-digest check. R2's object operations are strongly consistent, but that does not create a distributed transaction with Postgres. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

For the initial personal installation, retain published and retired versions so pinned runs stay reproducible. Retiring blocks new selection without deleting bytes. There is no automatic object expiry or garbage collection of revision content. Orphan cleanup is an explicit maintenance operation with imports/publication paused and a database reference check; add online collection only when measured storage usage warrants its coordination cost. Imported content never supplies store credentials or its own execution permissions.

Store outages/missing objects map to bounded retryable `DEPENDENCY_UNAVAILABLE`; timeouts use `DEPENDENCY_TIMEOUT`. Hash mismatch maps to terminal `SKILL_CONTENT_INTEGRITY_FAILED`, blocks execution/publication and records the version/file IDs in a redacted diagnostic. Do not expose keys or bytes in the fault. Neither failure permits falling back to a mutable upstream skill.

## Auth, authorization, and secret handling

The MCP contract in chapter 02 is normative for protocol errors and OAuth challenges. OAuth failures return HTTP 401/403 with the provider challenge before tool dispatch; they are not successful JSON-RPC tool results. Validated domain failures retain Bakery Problem Details.

Admin and Developer are the only initial roles. Better Auth owns browser sessions and remote MCP authentication; Bakery maps the authenticated user to a `principals` row and resolves an `Actor` containing subject, selected organization, live membership role, repository scope, and capabilities. A human can be Admin in one organization and Developer in another; there is no global human role. Installation administration is a separate explicit grant. Organization selection from a request or token is checked against live membership, never trusted as authority. `authorize(action, actor, input)` is called in the plain action registry, so REST, MCP, automations, and worker reports cannot bypass it. Resource ownership and repository scope are checked in centralized guards. Tenant queries require organization context except the documented recipient invitation routes, and composite foreign keys prevent cross-organization references. The application boundary is the sole isolation authority: no transaction-local session setting and no Postgres row-level security provides a second boundary. Pool connections never retain an organization setting between requests. Background steps carry a pinned organization ID and recheck current grants at effect time. Additive scopes support more roles without replacing these boundaries.

GitHub installation identity, worker identity, and harness authentication are separate principals. A worker can report only jobs leased to its worker identity. Secrets are stored by reference to the configured secret store. A trusted provider broker injects short-lived, scoped credentials into provider calls where possible. A harness with arbitrary shell access cannot promise absolute secret invisibility; if a credential must enter that environment, issue a short-lived workspace-scoped credential, isolate the control plane from the build sandbox, record the scope and expiry, and revoke it after the attempt. Credentials never enter model context, artifacts, memory, Problem Details body, or logs through Bakery-owned paths.

### Account protection: TOTP, backup codes and passkeys

**Included in the implementation plan; runtime verification is unrun.** Account settings
adds optional authenticator-app TOTP, recovery codes and passkeys to the existing
invite-only account flow. Reuse the approved [Authentication screens](auth-mocks/AUTH-FLOWS.md)
and [Paper page](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/V-0).
These are personal account methods across memberships; organization Admin does not
gain access to another person's factors or recovery codes.

**Provider support, checked 2026-09-08:** Better Auth's `twoFactor` plugin supports
TOTP enrollment, verification, disablement and single-use backup codes. Its default
sign-in enforcement covers credentials, not social/OAuth or passkey sign-in;
`allowPasswordless` does not change that boundary. The separate `@better-auth/passkey`
plugin supports registration, sign-in, listing, renaming and deletion. Pin compatible
server/client packages and prove them under Deno/Hono/Postgres before enabling the feature.
[Two-factor reference](https://better-auth.com/docs/plugins/2fa),
[passkey reference](https://better-auth.com/docs/plugins/passkey).

| Flow | Provider client surface | Bakery requirement |
|---|---|---|
| Enroll / verify authenticator | `twoFactor.enable`, `twoFactor.verifyTotp` | Issuer Bakery; six digits, 30-second period; `skipVerificationOnEnable: false`. Fresh identity proof → QR/manual key → verified code → save recovery codes. |
| Recover / replace codes / disable | `twoFactor.verifyBackupCode`, `twoFactor.generateBackupCodes`, `twoFactor.disable` | Codes shown only when generated; copy/download and saved acknowledgement. Regeneration and disable require fresh identity plus factor proof. Failure preserves the prior configuration. |
| Add / use / manage passkey | `passkey.addPasskey`, `signIn.passkey`, `passkey.listUserPasskeys`, `passkey.updatePasskey`, `passkey.deletePasskey` | Native browser ceremony; authenticated enrollment, safe labels, ownership and last-method checks. Cancellation changes nothing. |

**Server enforcement.** For the initial policy, an account with TOTP enabled must
complete TOTP or recovery-code verification after every primary sign-in, including
GitHub and passkeys. A passkey is not yet a substitute for this extra check. Do not
enable trusted-device bypass. Passwordless management must prove an available method
freshly; do not enable `allowPasswordless` as a substitute for that proof.

The request path is `primary sign-in → pending factor → verified session → Actor →
existing authorization guards`. Persist verification evidence against the server
session with expiry; never infer it from `user.twoFactorEnabled`, a client flag or
a redirect. Guard protected REST reads/writes, both WebSockets, auth-management
endpoints and human OAuth consent/token issuance. Pending sessions may only continue
authentication, recovery or sign-out. Security changes invalidate affected assurance;
an older session must not bypass newly enabled protection. Worker/service credentials
remain separate. Direct provider endpoints must enforce the same rules as the UI.

**Storage and transport.** Generate migrations from the pinned plugins: the user
enrollment flag, `twoFactor`, `passkey`, and provider verification/session records.
Use provider-supported private session fields for any additional assurance metadata;
accept no client writes to them. Better Auth documents schema generation and extensions
in its [database contract](https://better-auth.com/docs/concepts/database).
Keep TOTP material and recoverable backup-code storage encrypted in Postgres with
restorable, protected keys. No parallel Bakery credential tables, R2 artifacts, model
context or generic idempotency replay. Retain only passkey public credential data;
the private key stays with the authenticator. Safe UI projections expose enabled
status, remaining-code count and the current user's credential summaries.

Provider routes remain under `/api/auth/*`, using the official client and required
cookie/CSRF behavior; do not duplicate them as `/v1` or MCP tools. Preserve provider
error envelopes there. Bakery guards use existing `StandardError`, throwing guards
and `problemResponse`; no new exception hierarchy. Map failures to safe UI copy and
audit outcome metadata. Never record passwords, QR payloads, codes or WebAuthn challenges.

**Local and desktop.** Configure an explicit stable RP ID and allowed auth origins;
exclude preview domains. Use HTTPS outside loopback; localhost is a separate local
passkey realm. Require WebAuthn user verification and verify the assertion server-side;
do not rely on device labels or frontend options. Desktop uses the existing system-browser
auth handoff. Provide password/recovery fallback for unsupported or canceled ceremonies.

**Release gates.** Test real provider endpoints for pending-session access denial,
GitHub/passkey bypass, fresh proof on disable/regeneration/removal, cross-user access,
concurrent backup-code consumption, TOTP replay/clock tolerance, expired challenges,
rate limits, session revocation, restart and key restore. Verify WebAuthn origin/RP ID,
user verification and replay checks with a virtual authenticator, then Safari/iOS and
desktop browser handoff. No SMS/email codes, trust-device UI or public passkey signup
in this slice. Missing provider guarantees block release until a focused adapter/hook
fix is proved; mock success is not security evidence.

## Installation settings

Installation settings persist registration mode and organization-creation policy in Postgres. The server reads current settings at each policy boundary, so changes take effect on the next request without a process restart.

Invitation registration and existing-user sign-in remain separate. Closing registration blocks new account creation while preserving sign-in, recovery, and the explicit CLI bootstrap of the first installation administrator. Organization creation follows its own policy and still requires server-verified identity and authorization.

Settings control availability alongside permissions; they never grant roles, membership, or resource access. The installation-administrator actions use versioned compare-and-swap updates and expose only safe capability values to public clients.

**Implementation acceptance:** demonstrate both policy values through the authenticated settings action, verify every account-creation path and organization-creation path, preserve existing-user sign-in, and prove unauthorized callers cannot read or change administrative settings.

## Observability and redaction

Every request, command, event, job attempt, and Inngest step receives `requestId`; distributed spans propagate W3C `traceparent` and `traceId`. Logs use structured fields: action, actor hash, repository ID, task/run/job IDs, outcome code, duration, retry count, and provider category. Payloads are omitted by default; allowlisted metadata and SHA-256 digests are used for correlation. Redaction recursively replaces keys matching `authorization`, `cookie`, `token`, `secret`, `password`, `private_key`, `credential`, and provider-specific variants. Prompts, source code, diffs, artifact bodies, and full webhook payloads are never logged by default. Fault `cause` is attached to an error span with the same redaction filter, while clients see only the safe catalog detail.

## Deterministic quality rails

The root Turborepo commands are `dev`, `build`, `lint`, `typecheck`, `test`, `test:rails`, and `contracts:generate`; service startup, migrations, deployment, and dispatch are never cached. Build/typecheck/test tasks depend on package predecessors and cache only declared outputs, following Alidade's small Turbo task graph (turbo.json, lines 1–35).

Required checks are:

1. Strict TypeScript/Deno check, lint, import-boundary check, generated-contract freshness, OpenAPI compatibility diff, and migration checksum check.
2. Pure tests for every fault mapping, schema, authorization guard, cursor, idempotency fingerprint, event sequence rule, and retry classification. Test clocks, IDs, request IDs, and provider responses are injected from small server test fixtures; no runtime test framework package is required.
3. Postgres integration tests run the same repository adapters as production and exercise unique constraints, transaction rollback, inbound/outbox restart, leases, concurrent claims, and stale attempts. The test must fail clearly when the required local database is unavailable; a skipped lane is reported as unverified.
4. HTTP contract tests assert status, headers, Problem Details schema, stable uppercase `code`, configured lowercase `type`, and absence of internal detail. MCP and worker contract tests run against the same registry.
5. A local proving test submits work through REST and MCP, executes a real workflow, kills a worker after a checkpoint, restarts it, verifies one completion and one durable audit trail, and confirms duplicate/out-of-order messages are harmless.
6. Web rails run Playwright at 320×568, 360×800, 430×932, 768×1024, 1024×768, and 320×480 at font scales 1 and 1.3 plus pseudo-locale. They assert no unannotated overflow, accidental truncation, or interactive target below 44×44. This reuses the deterministic Alidade rail shape (design-rails.ts, lines 1–13 and 40–143).

## Failure and recovery matrix

| Failure | Durable action | Client/transport result |
|---|---|---|
| Duplicate unsafe request | Idempotency row replays exact response | `200` replay with `Idempotent-Replayed` |
| Key reused with another payload | Keep original claim; record audit | `422 IDEMPOTENCY_PAYLOAD_MISMATCH` |
| Concurrent duplicate | Leave first lease active | `409 IDEMPOTENCY_IN_FLIGHT`; retry with backoff |
| Duplicate webhook/worker event | `inbound_events`/`attempt_events` digest check returns duplicate | Byte-identical ack; no second transition |
| Out-of-order event | Leave gap unconsumed; replay missing `local_seq` | `409 EXPECTED_SEQUENCE` ack |
| Worker loss | Fence old attempt, quarantine old process/workspace, reconcile effects, then allocate a fresh attempt | UI shows reconciling/retrying; no silent host fallback |
| Late old-attempt result | Host/token/fence mismatch is durably ignored | Worker ack; run remains current |
| Lost completion ack | Event is resent; attempt-event dedupe applies once | Eventually terminal state |
| Provider quota/outage | Record quota/effect status, back off, and apply spend/concurrency guard | `429 PROVIDER_QUOTA_EXCEEDED` or `503` |
| Stale `If-Match` or evidence revision | Reject state mutation; retain evidence | `412 PRECONDITION_FAILED` or run repair state |
| Review loop stalls | Inngest deadline closes step and records fault | Retry within budget, then `DEPENDENCY_TIMEOUT` |
| Deployment failure | Keep prior release pointer; record failed promotion | Task is failed/retryable; preview remains inspectable |
| Broken Bakery update | Health gate blocks promotion; repair task uses last known good | Rollback and explicit `INTERNAL` incident reference |

## Acceptance boundary

The compatibility and build gates in [Implementation readiness](15-implementation-readiness.md) separate observed checks from unrun runtime acceptance. An implementation is ready when one registry definition can be exercised through REST, WS, MCP, harness, and Inngest with the same input schema, authorization decision, idempotency behavior, event IDs, and stable `Fault` code. The local stack must preserve task/run/artifact/audit/inbound/outbox state across process restarts. A green unit lane alone is insufficient: Postgres, contract, worker-recovery, and responsive rails are separate reported lanes.

## Observed Alidade evidence

This proposal was based on a read-only inspection of Alidade at commit `8add4420945e0c499878a57150457cf37c43c26b` (`chore: preserve local authorization handoff`). The checkout was dirty, so these are implementation patterns to adapt, not a claim about its current release state. The strongest reusable rails were:

* bounded content-type/body reading and schema parsing in platform/http.ts, lines 24–86;
* centralized auth signature, expiry, account, and nonce checks in accounts/service.ts, lines 42–65;
* explicit route wiring and `Allow` handling in observations/v1/routes.ts, lines 12–23;
* handler order of parse → verify → identity check → store, with `201`/`200` duplicate behavior in observations/v1/handlers.ts, lines 22–47;
* storage parity, duplicate content IDs, concurrency, nonce replay, and restart checks in storage.integration.test.ts, lines 43–121;
* deterministic responsive rails for fonts, overflow, truncation, and touch targets in design-rails.ts, lines 40–143.

Skipped runtime implementation and deployment because the agreed Bakery goal is design-only; add them when the parent design selects the first implementation band.
