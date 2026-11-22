# Threat matrix: adversarial concurrency and bounded load

Issue #48. Each row names a threat, the invariant that must hold, and the test
files that prove it. A row whose proof is missing is a gap, not a pass. Budgets
for the load rows live in
[load-acceptance-budgets.json](load-acceptance-budgets.json), committed before
any measurement.

| Threat                                 | Invariant                                                                                                                              | Proof                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant references across organizations | Another organization's id answers as an unknown id; nothing is read or changed                                                         | `tests/integration/enforce-live-organization-roles-grants-and-tenant-isolation_test.ts`, `tests/integration/blob-upload-tenancy_test.ts`, `tests/rails/event-export-history-and-tenant-pinning_test.ts`                                                        |
| Revocation racing an in-flight write   | A demotion or removal is ordered wholly before or after each request; a write never commits after the role it relied on was taken away | `tests/integration/run-adversarial-concurrency-and-bounded-load-acceptance_test.ts` (demotion during a write; mutual demotion), `tests/security/agent-file-writes_test.ts`, `tests/integration/complete-bounded-artifact-reads-imports-and-provenance_test.ts` |
| CSRF and hostile origins               | A browser request from another origin is refused                                                                                       | `tests/integration/bootstrap-better-auth-and-invite-only-organization-identity_test.ts`, `tests/browser/bootstrap-better-auth-and-invite-only-organization-identity.spec.ts`                                                                                   |
| OAuth (MCP)                            | Tokens carry only granted scopes; transports answer alike                                                                              | `tests/integration/implement-oauth-protected-mcp-server-and-transport-parity_test.ts`                                                                                                                                                                          |
| SSRF                                   | Private and loopback destinations are refused; redirects across origins are not followed                                               | `tests/integration/backup-destination-socket_test.ts`, `tests/integration/implement-the-integration-sdk-manifests-and-capability-gate_test.ts`                                                                                                                 |
| Oversized uploads and bodies           | Bodies past the cap are refused with 413 while reading, declared or not; healthy writes proceed                                        | `tests/integration/run-adversarial-concurrency-and-bounded-load-acceptance_test.ts` (oversized flood), `tests/integration/blob-upload-routes_test.ts`                                                                                                          |
| Collaborative drafts (Loro)            | Malformed, oversized or wrong-root updates fail closed; state compacts at the epoch cap                                                | `tests/unit/persist-bounded-loro-drafts-and-authenticated-mutation-receipts_test.ts`, `tests/integration/compact-collaborative-draft-state-at-the-epoch-cap_test.ts`                                                                                           |
| Plugins                                | Plugin jobs run behind an install-scoped broker; upgrades roll back state                                                              | `tests/integration/run-plugin-jobs-behind-an-isolated-install-scoped-broker_test.ts`, `tests/integration/stage-plugin-upgrades-with-compatible-state-rollback_test.ts`                                                                                         |
| Worker credentials                     | A session credential resolves only to its own lease                                                                                    | `tests/integration/issue-a-session-credential-on-claim_test.ts`, `tests/integration/resolve-a-session-credential-to-its-lease_test.ts`                                                                                                                         |
| Effect replay                          | An accepted effect never runs twice; replay stops at its deadline                                                                      | `tests/integration/outbox-replay-safety_test.ts`, `tests/integration/implement-the-external-effect-executor-and-read-only-reconciliation_test.ts`                                                                                                              |
| Simultaneous budget reservations       | Held reservations never exceed the cap                                                                                                 | `tests/integration/run-adversarial-concurrency-and-bounded-load-acceptance_test.ts` (sixteen admissions)                                                                                                                                                       |
| Simultaneous publishes                 | One draft makes exactly one immutable version                                                                                          | `tests/integration/run-adversarial-concurrency-and-bounded-load-acceptance_test.ts` (eight publishes)                                                                                                                                                          |
| Simultaneous claims                    | Claims never exceed a worker's slots; one organization's backlog never takes another's worker                                          | `tests/integration/outbox-concurrent-claims_test.ts`, `tests/integration/run-adversarial-concurrency-and-bounded-load-acceptance_test.ts` (flooded queue), `tests/load/run-bounded-load-acceptance_test.ts` (slot-limited worker)                              |
| Slow and greedy event consumers        | A slow consumer is closed; one person's sockets are capped; fifty clients still get live events inside budget                          | `tests/integration/deliver-bounded-authorized-websocket-events-and-replay_test.ts`, `tests/load/run-bounded-load-acceptance_test.ts` (fifty event clients)                                                                                                     |
| Load on list and replay reads          | Reads stay inside their latency budget over the reference workload, by index, never by sequential scan                                 | `tests/load/run-bounded-load-acceptance_test.ts`                                                                                                                                                                                                               |

## Event delivery and fairness

Live event delivery to clients is per organization: each socket polls its own
organization's event clock every 500 ms and never reads the shared outbox, so
one organization's flood of events does not delay another's clients (the
fifty-client load test measures this path). Worker queues are per organization
as well.

The outbox, which dispatches workflow wake-ups, is first in, first out across
organizations: a backlog from one organization delays another's wake-ups by its
length, though every row still progresses. No acceptance criterion of #48 asks
for per-organization ordering there, so it is not added; healthy work
progresses, which AC2 requires.

## Running it

`pnpm test:load` runs the load lane against the test database. It runs nightly
and on a maintainer dispatch (`nightly / bounded load` in
`.github/workflows/ci.yml`), not on pull requests. A missed budget fails the
lane; a budget changes only in a reviewed commit to the budgets file.
