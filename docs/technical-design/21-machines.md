# Machines

Organization-owned machines: onboarding, harnesses, provider accounts and remote maintenance.

[Open the desktop and mobile mocks in Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/K-0)

Status: proposed implementation contract derived from the approved [Machines mocks in Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/K-0). This chapter owns the machine product behavior and the catalog additions below. Issue [B08.05] machine readiness adds the enrollment replacement/re-pair columns, the machine inventory and readiness tables, the provider-account/binding/auth-attempt records, the routes and the `worker`/`worker_enrollment` event scopes described below, via migration `0124_issue59_machine_readiness.sql` reconciled into `api-catalog.json` and `transport-schemas.json`. The installer and the runtime acceptance lanes remain unrun.

## User stories

| Story | User outcome | Acceptance |
|---|---|---|
| M01 · Bring my machine | As an organization Admin, I can connect my Linux server or Mac with one setup command, so Bakery can use compute I already own. | Setup installs the worker when absent, pairs it only to the selected organization, and starts its OS service. Repeating setup does not duplicate the machine. |
| M02 · See it connect | As an Admin, I can follow a vertical stepper and press **Start Listening**, so I know when setup worked. | A machine that checked in before the click is still found. Connected, verifying and ready are distinct; no timer manufactures success. |
| M03 · Understand capacity | As a Developer, I can see my organization's machines, supported harnesses, toolchains and current work, so I understand why a task is running or queued. | Stale, offline, incompatible and busy are explicit. I cannot view another organization's machines or change machine settings. |
| M04 · Manage harnesses | As an Admin, I can inspect and install approved Pi, Claude Code and Codex versions on a machine. | The UI distinguishes discovered external installs from Bakery-managed installs, reports actual versions, and never silently replaces an external installation. |
| M05 · Connect providers | As an Admin, I can connect the accounts a machine's harnesses use, so work follows our chosen provider and billing route. | Account identity, auth health, supported actions and known usage are visible; credentials are not. Unsupported remote login has an explicit terminal handoff. |
| M06 · Update safely | As an Admin, I can review an available update and apply it remotely without surprising active sessions. | Checks are automatic; installation is Admin-triggered. New claims pause, active work finishes, the update is verified, and failure has a recovery action. |
| M07 · Recover and retire | As an Admin, I can diagnose, re-pair, pause or revoke a machine from any device. | Lost connectivity never looks like successful removal. Revocation stops authority immediately; deleting cloud metadata does not claim to erase the host. |
| M08 · Use any screen | As an organization member, I can use the same machine views on phone, browser or desktop. | Shared operations, permissions and design tokens; reconnect after phone sleep; keyboard, touch, reduced-motion and long-content coverage. |

## Ownership and authority

- A registered worker identity belongs to exactly one organization. The organization onboards and operates its own machines initially; hosted provisioning is future work. A machine's organization is immutable. Moving it requires revocation, local cleanup and enrollment into the other organization. Do not share its credentials, worktrees, provider bindings or caches across organizations. The installer refuses a second organization in the same installation root.
- **Admin** manages enrollment, machine settings, provider bindings and maintenance. **Developer** reads safe machine/inventory status and uses permitted capacity through normal task admission. Owning a task does not grant maintenance rights. Worker credentials authenticate only the enrolled host and its granted protocol operations.
- Web and desktop call the same typed operations. OAuth MCP may expose safe reads and Admin maintenance actions with the existing read/operate/admin scopes and live organization membership. Enrollment tokens and provider-login secrets stay in the interactive web/terminal flow, outside model context. No extra role or blanket machine shell tool is introduced.
- The registered identity proves possession of a credential, not trustworthy hardware attestation. Advertised toolchains and check results are bounded host reports checked against policy. Same-user unsandboxed access to supervisor secrets fails readiness; the Mac isolation boundary must be demonstrated before scheduling work.

## Onboarding UX

**Add machine** first collects a display name, intended Linux/macOS platform, architecture and task-slot ceiling. Architecture can be confirmed during setup; a mismatch requires an Admin correction, not silently broader capability grants. Store this intent in the enrollment; registration does not override the slot/capability ceiling.

The connection screen uses the approved vertical sequence:

1. **Copy this command.** Show a verified, version-pinned setup command and a separate masked, short-lived enrollment token. Copy feedback means the clipboard write succeeded.
2. **Go into the machine.** Explain SSH for a server or Terminal for the Mac. Browser/desktop location is not the execution host.
3. **Paste into your terminal.** Setup checks prerequisites, installs if necessary, asks for the token through hidden input, pairs and starts the service. Installation errors remain visible in the terminal before the machine can report them remotely.
4. **Start Listening.** Load the enrollment's current status and subscribe to changes. Show **Listening → Connected, verifying → Ready for work**. A failed check shows **Connected, needs attention**, with the failed check and next action.

Watching is a presentation choice: pairing and verification proceed whether the page is open or not. **Stop Listening** closes this view's subscription only. **Cancel enrollment** invalidates an unused token; it cannot undo completed registration. If registration wins that transaction race, show the resulting machine and its explicit revoke action. **Generate new token** atomically cancels a still-pending predecessor and creates a new enrollment; an expired predecessor remains an expired audit record. Never issue another usable token for a consumed enrollment.

The token has a ten-minute default lifetime, is returned once and never appears in a command, URL, event, log, browser storage or ordinary GET response. After a page reload, an already-connected machine remains discoverable; an unfinished enrollment whose token was lost requires replacement. Mobile sleep pauses observation, not the worker.

## One-command installation with npx

Use a small npm bootstrap with one `bin` entry that installs and launches the compiled Deno worker. Node/npm are needed for this installation option, not for the installed daemon. The proposed package name is `@bakery/worker`; ownership and publication are not verified. Do not execute the example until the package and release are published and verified. The UI substitutes an exact approved release for `VERIFIED_VERSION`, never `latest` or a user-supplied package/URL.

```text
Proposed command shape — not published or runnable yet:
  npx @bakery/worker@VERIFIED_VERSION setup --server https://bakery.example

Terminal interaction:
  Target: Linux / arm64
  Worker release: exact approved version
  Install location and OS service: shown before modification
  Enrollment token: [hidden input]
  Organization and requested capacity: returned by enrollment inspection
  Continue with this organization? [confirm locally]
  Installing → Pairing → Starting service → Checking tools
  Connected. Return to Bakery and select Start Listening.

Existing installation:
  bakery-worker pair --server https://bakery.example
  bakery-worker status
  bakery-worker doctor
  bakery-worker drain
```

`npx` executes a package binary and can fetch an exact requested package version into npm's cache. Retain its package-install prompt; the bootstrap must not depend on npm lifecycle scripts. Run setup outside a repository and invoke the verified installed worker by absolute path, not an arbitrary executable found in a project's `PATH`. [npm npx reference](https://docs.npmjs.com/cli/v11/commands/npx/)

The bootstrap performs these bounded steps:

| Step | Contract |
|---|---|
| Preflight | Detect OS, architecture, supported libc/runtime prerequisites, available disk, writable install root and service manager. Check the existing installation and connection before modifying it. Report unsupported targets plainly. |
| Acquire | Download from the fixed Bakery release origin. Verify a signed release manifest with the shipped trust root, then digest and size of the exact platform binary. Bound redirects, download size and archive expansion; reject traversal, symlinks and path collisions. Manifest includes release, target, digest, size, protocol compatibility, state format and expiry. |
| Install | Stage outside worktrees; atomically activate only after verification. Preserve an existing working install on failure. A non-destructive rerun resumes or reports already installed; it does not change versions or organizations implicitly. Never run the whole npm package as root. |
| Pair | Use hidden input, or a protected input descriptor for headless setup. Inspect the token over TLS to display organization/intent before consuming it. Worker creates its own random credential and retries registration with the same enrollment/idempotency identity. No `--token` flag or environment-variable shortcut. |
| Service | Linux: dedicated unprivileged worker service with a narrow local privilege step for account/service installation. macOS: user LaunchAgent and explicit logged-in-session dependency for Xcode/keychain. Show the exact system changes; npm's prompt is not consent to arbitrary privilege escalation. |
| Verify | Wait for service health and accepted registration, then report actual checks. Preserve safe local diagnostics when Bakery cannot be reached. The web page decides readiness from server-confirmed state. |

The package itself is executable supply-chain input: verifying its downloaded worker cannot retroactively make a compromised bootstrap trustworthy. Release acceptance verifies npm publisher ownership, a pinned dependency graph, provenance/signatures where supported, and the bootstrap artifact. Trust-root rotation must be authorized by the previous root or an explicit out-of-band operator action.

Use `deno compile` to produce platform releases that include the worker runtime. Initial release targets are tested Linux glibc x64/arm64 and macOS x64/arm64; cross-compilation support is not a substitute for running each acceptance lane. Deno permissions are fixed at compile time; OS isolation still protects against native subprocess access. [Deno compile reference](https://docs.deno.com/runtime/reference/cli/compile/)

Linux native capacity also requires the unprivileged `/usr/bin/bwrap` namespace probe used by the worker. The readiness check reports `needs_attention` and refuses native scheduling when bubblewrap or user/PID namespace support is absent. The installer does not install packages, alter host security policy, use sudo for a harness, or choose a privileged fallback. CI proves the exact probe on the target runner; local availability is not treated as evidence for another machine or image.

For machines without Node, offer a verified native release download with the same `setup` flow. Do not install Node, Xcode, SDKs or harnesses silently. Local single-machine mode uses the same enrollment/service contracts and the local Bakery origin; trusted local HTTPS needs no Cloudflare account. Plain HTTP is limited to deliberate loopback development, never a remote worker. No inbound worker port, SSH password storage or new tunnel is required.

## State and readiness

Keep operator intent, connection liveness and verified readiness separate. A single writable `online` flag cannot represent them safely.

| Dimension | Values and authority |
|---|---|
| Enrollment | `pending`, `consumed`, `canceled`, `expired`; server time and a locked registration/cancel transaction decide the winner. `worker_host_id` is assigned on successful consumption. |
| Desired mode | `accepting`, `paused`, `draining`, `revoked`; Admin intent. Pause stops new claims; drain also waits for active attempts/processes to settle. Revoked is terminal for that credential generation. |
| Connectivity | `online`, `stale`, `offline`; derived from authenticated server receipt time, never worker clocks or Admin PATCH. Starting point: heartbeat every 10 seconds with jitter, stale after 30 seconds, offline after 60. Existing attempt leases retain their own deadlines. |
| Readiness | `checking`, `ready`, `needs_attention`; derived from current-generation checks, protocol compatibility, credential state and scheduling policy. Losing connectivity makes readiness unusable even if the last check passed. |
| Capacity | Configured slot ceiling, active leased attempts, eligible capabilities and available slots; calculated server-side. A host's reported free slots do not bypass the claim lock. |

Required check IDs cover supervisor health, credential isolation, filesystem/spool access, disk threshold, supported worker protocol, and each requested harness/toolchain. Results include status (`pass`, `fail`, `unknown`, `not_applicable`), safe reason, observation/expiry time, checker version, component digest and host generation. The server assigns receipt time and rejects stale generations. Checks expire after five minutes initially, and immediately after a relevant update, configuration change or process restart. Unknown required checks block that capability. An unavailable optional iOS toolchain does not block unrelated verified web capacity.

A check is fresh only when its host generation equals the host's current credential generation, its inventory revision equals the current one and `expires_at` is in the future; a check from an old generation or an expired check cannot restore ready. A fresh failed `credential_isolation` check (and every other non-capability check) blocks all claims; a fresh failed `capability:<cap>` check blocks that capability only. With no fresh checks for a dimension, readiness is `checking`, never falsely ready.

**Ready for work** requires live connectivity, accepting mode and at least one permitted execution capability with fresh checks; each task still needs its exact harness, toolchain, resource grants and provider route. Provider outages can block that route without making the entire machine offline. A signed-in provider is not proof of remaining quota.

The claim gate closes the same loop: `worker.claim` returns no assignment (`204`) when the desired mode is not `accepting`, the host status is `revoked`, or a fresh failed blocking check exists, instead of advertising capacity.

## Live status and I/O path

```text
Admin → workers.enroll → transaction(enrollment intent + token hash)
CLI → enrollment inspection → hidden-token confirmation
CLI → worker.register → transaction(host + credential hash + enrollment link + event)
OS service → worker.heartbeat → transaction(receipt + check status + event/outbox)

Start Listening → enrollment snapshot + highwater from one database snapshot
               → existing /v1/events subscribe(enrollment, after=highwater cursor)
               → replay changes that happened between snapshot and subscribe
               → invalidate/refetch safe status → show connected/checking/ready
```

Extend the existing `/v1/sync` and `/v1/events` scope union with `worker_enrollment` and `worker`. Every snapshot, replay and delivery checks current organization membership and resource authority. Enrollment status is Admin-only; safe worker status is visible to Developers. Keep a consumed enrollment addressable and able to project its linked machine's verification state so the transition cannot lose events. Subscription filters resolve that same authorized link. No client-supplied host ID establishes ownership. `EnrollmentStatus` snapshots and replay resolve the true machine even when registration races cancel, replace or an early check-in, because the locked register/cancel transaction decides the single winner.

The status read returns `EnrollmentStatus { enrollmentId, organizationId, state, expiresAt, workerHostId?, worker?, version, snapshotCursor }`; `worker` is a bounded safe status projection, never credential material. Worker events contain resource/version hints, not terminal output. Add `worker_enrollment.updated`, `worker.inventory_changed`, `worker.readiness_changed`, `worker.maintenance_updated` and `worker.provider_binding_changed`; retain the existing registration/health/update events. Their payloads carry only `resourceId`/`resourceVersion` references, never tokens or provider responses. Add nullable organization-constrained worker/enrollment references to the event envelope and stored event scope, rather than hiding authorization in arbitrary payload JSON.

Before subscribing, read current status: an early registration is success, not a timeout. On cursor expiry, refetch the scoped snapshot. On a dropped stream, show reconnecting and preserve the last confirmed state. After five seconds disconnected, use one bounded REST poll every five seconds with backoff to 30 seconds; stop on cancel, expiry, logout, loss of permission or leaving the screen. Abort superseded requests; older resource versions cannot replace newer state. Pause background-tab polling and refetch on visibility return. Waiting does not reserve a task slot or run an LLM.

## Harness and provider management

The daemon inventories the worker binary, Pi, Claude Code, Codex and declared toolchains through versioned host adapters. Each adapter implements bounded discovery, version inspection, compatibility checks and supported maintenance verbs using fixed executables/argument arrays. It is not a user-supplied shell script. Capabilities such as remote login or rollback are explicit adapter features, not promises every CLI can satisfy.

Inventory includes component ID/kind, actual version, install owner (`bakery` or `external`), adapter version, update channel, compatible available version, last check, verification state and maintenance support. Externally managed installations are read-only until the Admin explicitly adopts a supported install; adoption verifies ownership, path and recovery support before any change. A changed binary invalidates dependent checks and session-resume compatibility.

Check Bakery's approved release index on startup and at most every six hours with jitter, ETag caching and bounded retries. Record check time and distinguish **up to date**, **update available**, **unknown/offline** and **unsupported**. Failure to fetch releases does not stop an otherwise healthy pinned harness. “Update all” creates independently tracked operations for selected compatible components and reports partial outcomes; it is not a cross-machine transaction.

Provider configuration separates an organization-owned provider account from its per-machine/harness binding:

- A binding names provider, billing route (`subscription`, `api_metered` or `local`), harness, account reference and credential location. Model selection remains per task/default policy; a machine does not force one model globally.
- Subscription login stays with the host-native harness account. Bakery records safe identity/status metadata, not copied browser sessions. A supported provider device/browser login can be initiated remotely through a scoped expiring auth attempt; otherwise show the adapter's local terminal-login instructions and recheck afterward. Never invent an OAuth/device flow for an unsupported harness. State/PKCE and callback validation remain adapter-owned where applicable.
- API credentials use existing encrypted secret records and an explicit host/harness grant. Prefer brokered access when supported. Direct harness credentials must be restricted to the work they can perform; an arbitrary shell running with those credentials can read them. They never inherit the supervisor's worker credential or privileged integration secrets.
- Account health and quota are keyed to verified provider/billing account identity. Multiple machines using the same account share its observation; never multiply remaining usage. Different organizations do not discover each other's account identity through deduplication. A display email alone does not prove the same billing account. Unknown/unverifiable quota remains null, with source and observation time.
- Reconnect and disconnect affect the named binding. Disconnect blocks new use immediately, fences affected active authorization where needed, and requests best-effort local credential cleanup; an offline machine cannot acknowledge erasure. Revoke a shared provider secret/account only through a separate explicit action showing all affected bindings.

## Remote maintenance and recovery

Default policy: automatic checks, **Admin-triggered installs/updates**, and **wait for active work to finish**. The update review shows component, current/target version, source, compatibility, active attempts, expected interruption and rollback support. No silent paid-provider fallback or automatic major-version migration.

```text
queued → waiting_for_idle → staging → applying → verifying → succeeded
   └────────── before applying ──────────→ canceled / expired
staging/applying/verifying → reconciling → failed / rolled_back / succeeded
```

Create one durable `worker_maintenance_operations` record for a typed verb: `refresh_inventory`, `verify`, `install_component`, `update_component`, `rollback_component` or `remove_component`. Store the exact target component/version/manifest digest, requesting principal, expected inventory revision, captured desired mode, deadline and result. This is a host-operation journal, not another general workflow engine. Inngest waits/retries via the existing outbox; the existing task-attempt command enum remains steer/follow-up/cancel.

Heartbeat returns a separate bounded `maintenanceAssignments` list. Each assignment binds operation ID, host ID, credential generation, expected inventory revision, monotonic maintenance fence and execution deadline. The worker stores its phase and receipts durably before changing local state. Duplicate delivery replays the same acknowledgment; it never executes an update twice. Reports authenticate the current host generation/fence and reject changed duplicate payloads. Check current Admin membership, host mode, component support and policy again before dispatch and the irreversible switch phase.

Serialize mutating maintenance per host with a database uniqueness guard and a supervisor lock. Close the claim gate under the same host-row lock used by scheduling. Existing attempts may finish on their pinned versions; default idle wait is 30 minutes, after which the operation needs attention without canceling work. An explicit separate task cancellation remains available. Offline queued requests expire after 24 hours and never execute unexpectedly on a later reconnect. Read-only version discovery may continue while work runs.

Stage and verify first. Atomically switch the Bakery-managed binary only when no affected processes remain. Worker self-update uses a separate OS-supervised launcher/recovery helper, so the process being replaced is not its own sole watchdog. Record the prior release and compatible state backup. Run local health and await accepted control-service check-in before reporting success. The service can restart while the browser is closed.

A lost acknowledgment or control-service outage leaves the result **reconciling**, not failed-and-retried blindly. Inspect the actual installed digest and local receipt when connectivity returns. Local health failure may restore a known-good compatible release; unavailable server connectivity alone is not proof the new binary is defective. No rollback across an incompatible state migration. An adapter without safe rollback reports that before installation and retains an explicit recovery path. Resume claims only after verified completion/recovery and only if the latest Admin mode still permits them; never overwrite a newer pause/revoke. If the deadline/fence expires during a local switch, perform only the bounded local safety/recovery step already authorized, keep claims closed, and reconcile under renewed authority before further changes.

Cancel before applying prevents dispatch or staging continuation. After the switch starts, report cancellation requested and reconcile; do not kill an installer halfway through a filesystem change. Revocation denies network authority immediately and triggers local stop at the next observation, but Bakery cannot prove an offline process exited. Preserve quarantined worktrees and audit history until reconciled. Removing the daemon itself requires local uninstall; revocation alone does not delete files, third-party tools or credentials.

Re-pairing consumes an enrollment bound to the exact revoked host and expected credential generation, preserving its historical identity. Atomically replace the credential hash/generation and invalidate old-generation reports. Start the new generation paused and checking; an Admin resumes it after verification. Archiving hides a revoked machine from the default list without erasing attempt, billing or maintenance history. Local uninstall stops the service and removes only Bakery-owned binaries/service files; worktrees, caches and credentials need an explicit local cleanup selection.

## Data-model additions

All records inherit Bakery IDs, timestamps and optimistic versions. New relationships use composite `(organization_id, id)` foreign keys and live authorization. JSON fields below are bounded, versioned, described contracts—not arbitrary configuration. Every Zod parent, field, union member and derived schema requires meaningful metadata descriptions.

| Record | Fields / change | Integrity and purpose |
|---|---|---|
| `worker_enrollments` | Add intended name, OS, architecture, slot ceiling, `state`, `canceled_at`, nullable `worker_host_id`, nullable `replacement_of_id`, nullable `target_worker_host_id` and `expected_credential_generation` | Pending intent survives reload. Token consumption/cancel is atomic; linked/re-pair host is in the same organization. Re-pair binds the exact existing host and replaces its generation without transferring organization. No normal response contains token hash. |
| `worker_hosts` | Add `desired_mode`, `inventory_revision`, `protocol_version`, `readiness_revision`, `archived_at`; keep last heartbeat receipt and credential generation | Split intent from derived liveness/readiness. Remove client writes to observed versions or online/offline state. Archive only after revocation; retain identity referenced by attempts. |
| `worker_components` | `organization_id`, `worker_host_id`, stable adapter/component key, kind, actual version/digest, install owner, available version, channel, observation time and structured support flags | Unique `(worker_host_id, component_key)`; changing inventory increments host inventory revision. Paths stay host-local unless a scoped diagnostic explicitly needs one. |
| `worker_checks` | `organization_id`, `worker_host_id`, optional component FK, check ID/version, host generation, inventory revision, status, observed/received/expiry times and safe Problem reference | One latest result per host/check/component; history goes to bounded audit/diagnostic evidence. Stale reports cannot replace a newer result or grant capability. |
| `model_provider_accounts` | `organization_id`, provider key, verified account/billing identity when known, billing route, safe display identity, auth/usage observation metadata and optional existing secret FK | Organization-owned identity and quota source, not one allowance per machine. Do not merge unverified identities; no new secret vault or duplicate spending ledger. |
| `worker_provider_bindings` | `organization_id`, host/component/account FKs, enabled state, auth mode/location, optional secret FK, auth generation, last checked time and safe problem | Explicit authorized account placement. Provider identity is not mutable freeform config. Native credentials remain local; secret references never imply unrestricted access. |
| `worker_provider_auth_attempts` | `organization_id`, binding FK, requesting principal, host generation, flow/state, expiry, encrypted temporary protocol state and result | Single active attempt per binding; bounded lifetime, one winning completion, authenticated identity and replay protection. Login challenge/reveal responses are session-scoped and non-cacheable, not events. |
| `worker_enrollment_mutations` | `organization_id`, enrollment FK, verb (`cancel`/`replace`/`re-pair`), idempotency key and TTL | Admin-side idempotency ledger for cancel/replace/re-pair; unique per enrollment+verb+key so a retried Admin mutation replays its original outcome instead of double-consuming a token. |
| `worker_inventory_replays` | `organization_id`, worker host FK, report ID | Idempotent inventory report ledger keyed `(worker_host_id, report_id)`; an identical replay returns the same acknowledgment, a changed duplicate is rejected. |
| `worker_provider_auth_reports` | `organization_id`, attempt FK, report ID | Replay ledger for provider-auth reports keyed `(attempt_id, report_id)`; an identical replay returns the same acknowledgment, a changed or duplicate completion is `STATE_CONFLICT`. |
| `worker_maintenance_operations` | `organization_id`, host/component FKs, typed verb, exact target pin, actor, expected inventory/host generations, phase, fence/expiry, idempotency key, desired-mode revision, safe result and diagnostic reference | One nonterminal mutating operation per host. Atomic phase/version transitions and deduplicated receipts. Terminal records retained for audit; no raw shell command input. |
| `domain_events` | Add nullable worker/enrollment scope FKs and typed event payloads | Organization-constrained subscriptions work before a task exists. Public payloads contain references/versions, not tokens or provider responses. |

Use existing artifact/blob storage for bounded diagnostic bundles when needed, with the worker scope and retention explicitly authorized. Keep ordinary status structured and small. Do not place full stdout, environment dumps or harness resume handles into these tables or the event stream.

## REST, MCP and worker contract additions

These are the required catalog deltas, not routes already shipped. Preserve `/v1/workers` and existing operation names; the user-facing label is **Machines**. List endpoints use the existing opaque cursor `Page<T>`, default 25/max 100. All mutations require idempotency keys; PATCH requires `If-Match`. Creates that enqueue host work return `202` with a durable tracking location; ordinary enrollment creation returns `201`.

| Operation | REST | Access and result |
|---|---|---|
| `workers.enroll` (extend) | `POST /v1/worker-enrollments` | Admin; persist intended configuration and return one-use token + enrollment ID/expiry. |
| `workerEnrollments.get` | `GET /v1/worker-enrollments/{id}` | Admin; safe `EnrollmentStatus` and snapshot cursor. |
| `workerEnrollments.cancel` | `PATCH /v1/worker-enrollments/{id}` | Admin; If-Match + Idempotency-Key. Only cancel pending state. A consumed registration returns `STATE_CONFLICT` with no identity leak; an expired enrollment stays an audit record. |
| `workerEnrollments.replace` | `POST /v1/worker-enrollments/{id}/replacements` | Admin; atomically invalidate unused predecessor and issue a new token. An expired predecessor remains expired; never reissue a token for a consumed enrollment. |
| `worker.inspectEnrollment` | `POST /v1/worker/enrollment-inspection` | Enrollment-token proof; bounded organization/intent/expiry preview, no consumption or additional authority. Rate-limited, no-store. |
| `worker.register` (extend) | `POST /v1/worker/registration` | Enrollment proof; enforce intended platform/slot/capability ceiling, persist enrollment-to-host link atomically. |
| `workers.list/get/update` (refine) | Existing `/v1/workers` routes | Developer reads safe `WorkerHost` projection including `desiredMode`, derived connectivity (`online`/`stale`/`offline` from server receipt time) and readiness (`checking`/`ready`/`needs_attention`) with `readinessReason`; no credential material and no client-writable liveness. Admin `workers.update` (If-Match) changes name and desired mode only — `WorkerUpdate.status` maps `online`→`accepting`, `offline`→`paused`, `draining`→`draining`, `revoked`→`revoked`; slots/capabilities/toolchain versions are accepted within the enrolled ceiling. Observed fields remain server-derived. |
| `workers.repairEnrollment` | `POST /v1/workers/{id}/enrollments` | Admin; exact same-organization host/generation target, one-use re-pair token. Old generation remains revoked; active work is fenced. |
| `workers.revoke` | `POST /v1/workers/{id}/revocations` | Admin; invalidate credential generation, claims and subscriptions; retain historical identity and record cleanup as unconfirmed if offline. |
| `workers.archive` | `POST /v1/workers/{id}/archives` | Admin; revoked hosts only, preserve historical references, return safe archived state. List can explicitly include archived hosts. |
| `workerComponents.list` | `GET /v1/workers/{id}/components` | Developer; typed installed/available/support projection. |
| `workerMaintenance.create/list` | `POST/GET /v1/workers/{id}/maintenance` | Admin creates typed pinned operation; Developer reads redacted progress. |
| `workerMaintenance.get/cancel` | `GET /v1/workers/{id}/maintenance/{operationId}`; `POST .../{operationId}/cancellations` | Developer reads; Admin requests cancellation under phase rules. |
| `modelProviderAccounts.list` | `GET /v1/model-provider-accounts` | Admin; `Page<ModelProviderAccount>` of organization-owned provider accounts — provider, `billing_identity`/`identity_hash` unique per `(organization_id, provider, identity_hash)` so cross-org identities never discover each other, billing route, safe `display_identity`, `verified_at`, `auth_state` (`unknown`/`signed_in`/`signed_out`/`invalid`) and quota source/remaining/observed time. Quota is null when unknown, never coerced to zero. No billing identity value is returned. Developers see only non-sensitive availability in worker projections. |
| `workerProviderBindings.list/create/update` | `GET/POST /v1/workers/{id}/provider-bindings`; `PATCH .../{bindingId}` | Admin; select a verified existing account or declare a new provider/billing route for authentication, configure placement or disable binding. Unique per `(worker_host_id, component_key, provider)`; carries `billing_route`, `enabled`, `auth_mode` (`host_native`/`api_secret`), `credential_location` (`harness_host`/`bakery_secret`), optional secret/account FK, `auth_generation`, `last_checked_at` and a safe problem — never credential values. |
| `workerProviderAuth.create/get/cancel` | `POST /v1/workers/{id}/provider-bindings/{bindingId}/auth-attempts`; `GET/PATCH .../auth-attempts/{authAttemptId}` | Admin; create issues a bound, expiring attempt (`remote_device`/`remote_browser`/`terminal` flow), GET returns safe state only. The challenge is delivered once, at create/request time, to the initiating principal; responses are session-scoped and no-store, and protected challenge material is never returned raw or emitted as an event. Terminal-only adapters return an explicit terminal handoff (`flow=terminal`, safe local login instructions) instead of a fabricated remote login. |
| `worker.reportInventory` | `POST /v1/worker/inventory` | Current worker; bounded inventory/check report with report ID, boot ID, expected revision and current generation. Rejected when the report host generation differs from the current credential generation or the expected inventory revision mismatches; components declaring capabilities outside the host's granted set are rejected (`UNPROCESSABLE`). An accepted report bumps `inventory_revision` on component changes and `readiness_revision`, and emits `worker.inventory_changed`/`worker.readiness_changed`. Safe allowlist, bounded response acknowledgment. |
| `worker.heartbeat` (extend) | Existing heartbeat route | Current worker; add maintenance assignments/acks and supported provider-auth commands in distinct typed fields. Existing task commands unchanged. |
| `worker.reportMaintenance` | `POST /v1/worker/maintenance/{operationId}/reports` | Current worker + maintenance fence; monotonically sequenced phase/check/receipt reports. Duplicate exact report returns the same result. |
| `worker.reportProviderAuth` | `POST /v1/worker/provider-auth-attempts/{id}/reports` | Current worker + matching binding/auth/host generation; `challenge_requested` -> server-generated bounded challenge stored encrypted (never returned raw); completion -> binds the verified account inside the same organization transaction, deduplicating identity by org+provider+`identity_hash`, bumps the binding `auth_generation` and records a safe redacted result. An identical replayed report returns the same acknowledgment; a changed or duplicate completion is `STATE_CONFLICT`. Cross-binding or stale-generation completion is rejected (`AUTH_FORBIDDEN`/`STATE_CONFLICT`). Credentials never persist. |

Remote maintenance/auth dispatch uses host-generation-bound assignments through authenticated heartbeat responses; each kind has its own schema, deadline and idempotent receipt. Provider auth never piggybacks on a task prompt. A new verified account discovered during authentication is linked in the same organization transaction; raw claims do not create a verified account identity.

Expose read/maintenance MCP tools only after the matching registry operation exists, with the same generated input/output and current grants. Token-producing enrollment, inspection and interactive auth-challenge routes have no MCP tool. Every list and error follows [the shared transport contract](02-transports-and-operations.md); no machine-specific RPC bus, worker WebSocket or exception hierarchy.

## Errors, limits and notifications

Use `StandardError({ slug, status, params?, cause? })`, throwing guards and `problemResponse`. Reuse `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `AUTH_EXPIRED`, `PRECONDITION_FAILED`, `STATE_CONFLICT`, `UNPROCESSABLE`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `MALFORMED_REQUEST`, `BODY_TOO_LARGE`, `WORKER_UNAVAILABLE`, `DEPENDENCY_UNAVAILABLE`, `DEPENDENCY_TIMEOUT` and `RATE_LIMITED`. New machine routes map consumed/canceled enrollment races to `STATE_CONFLICT`, slot-ceiling violations and capability escape attempts in inventory reports to `UNPROCESSABLE`, and cross-binding or stale-generation worker provider-auth reports to `AUTH_FORBIDDEN`; see [Backend rails](04-backend-and-errors.md) for the canonical mappings. Register bounded machine reason codes in params/check results (for example `unsupported_platform`, `release_verification_failed`, `externally_managed`, `check_failed`, `maintenance_in_progress`); they are not another exception tree. Invalid/expired token responses reveal no foreign-organization identity. After stream upgrade, use its existing safe problem frame or close/resync path.

Defaults: inventory/check report ≤256 KiB and 100 entries, safe diagnostic text ≤8 KiB, at most 20 maintenance/auth assignments per heartbeat, and one active mutating maintenance operation per host. Protocol errors and subprocess output pass explicit allowlists/redaction before events, traces or logs. Use host, enrollment, operation and trace IDs for correlation. Observe check-in latency, pairing failure reason, stale duration, update duration/outcome and reconciliation backlog; do not count installer activity as model token usage.

Create durable organization-visible activity for enrollment success, failed verification, prolonged disconnection and maintenance terminal outcomes. Notify the requesting Admin when action is required, using the shared communication/outbox interfaces; dedupe by resource/generation/transition. A routine heartbeat or unchanged failed version check is not a notification. If Slack is unavailable, the web/desktop activity remains authoritative.

## Design-system mapping and acceptance

Reuse the approved Paper shell and existing `Button`, code/log, field, feedback, status and inspector contracts. Compose the stepper from these primitives, with no machine-specific palette or font. **Machines** is the product label; `worker_*` remains internal vocabulary. The page families are inventory, add-machine details, connect/listen/ready, harnesses, provider bindings, update review/progress, and settings/recovery.

The 160ms copied feedback and 220ms confirmed-state transition are semantic additions to the shared motion scale, not per-screen literals: `--duration-feedback`, `--duration-status` and `--distance-status-enter` (4px). Keep existing 120/180/240ms roles. The listening signal has a shared `--duration-listening-cycle` (1200ms) opacity-only loop while subscribed. Stop the loop when hidden or disconnected. Reduced motion has instant changes and a static signal. Paper shows static state frames; Storybook demonstrates behavior with the same tokens. Retain focus, announce state with `aria-live="polite"`, and never autofocus a success card.

| Acceptance lane | Evidence required before shipping |
|---|---|
| Fresh install | Clean Linux x64/arm64 and Mac x64/arm64; Node-assisted and native paths; no Deno preinstall; permission refusal, unsupported platform, interrupted download, bad signature, failed service start and idempotent rerun. |
| Enrollment | Expired/replaced/canceled token; wrong organization; forbidden capability/slot/platform; two registrants racing; lost response retry; exact same-host re-pair; no credential leakage. |
| Realtime | Registered before click; snapshot/subscribe race; duplicate/out-of-order update; expired cursor; tab sleep/reload; early registration followed by verification failure; permission revoked while listening. |
| Readiness | Authenticated but unsafe host cannot claim; old check/generation cannot restore ready; offline Mac never reroutes iOS work to Linux; partial capability failure preserves valid capacity. |
| Maintenance | Busy host waits; new claims stop atomically; duplicate delivery; external install protection; concurrent Admin changes; cancel/revoke offline; crash before/after binary switch; worker self-update; incompatible rollback and unknown outcome reconciliation. |
| Provider bindings | Supported remote flow and terminal fallback; shared-account usage not duplicated; unknown quota; expired login; cross-org account/binding denial; offline disconnect never claims credential erasure. |
| UI parity | Light/dark, 320/390 phone and tablet/desktop modes, 200% zoom, keyboard, 44px touch targets, long labels, pseudo-locale/RTL, reduced motion, focus retention, no clipping and all errors/retries. Compare actual Paper component geometry and tokens. |
| Contract parity | Reconcile these records/routes/scopes/events into data-model.json, api-catalog.json and transport-schemas.json together; recursive schema descriptions, generated REST/MCP parity, org FKs and matching ERDs. No implementation uses a generic JSON escape hatch. |

All runtime acceptance lanes remain unrun. The approved mocks and this chapter specify what to build; they do not establish a published installer, installed daemon or verified machine.
