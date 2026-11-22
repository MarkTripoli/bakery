import type { ActionContext } from "@bakery/contracts/action-registry";
import { isUuid, type JsonValue } from "@bakery/contracts/contracts";
import { parseIdempotencyKey, StandardError } from "@bakery/contracts/http";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { loadSnapshot } from "../catalog/authority-snapshot-postgres.ts";
import type {
  ActiveIntegration,
  ActiveIntegrationRegistry,
  AuthoritySnapshotPort,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import {
  type IntegrationInvokeResult,
  invokeIntegration,
} from "../catalog/integration-invoke.ts";
import { organizationActor } from "./auth-attempts.ts";
import { slugForGateId } from "./registry.ts";

/**
 * Authority snapshots that open a short transaction per load.
 *
 * Local to this module rather than imported from `effects/dispatch.ts`, because
 * that file's own rail reserves it for `dispatch.ts` alone: the executor's write
 * path may not be reached from anywhere else. This is the read-side twin of it
 * and pulls in none of that.
 */
function standaloneSnapshotsOf(
  database: PgDatabase,
  snapshotsFor: (transaction: PgTransactionClient) => AuthoritySnapshotPort,
): AuthoritySnapshotPort {
  return {
    load: (key) =>
      withPgTransaction(database, (tx) => snapshotsFor(tx).load(key)),
  };
}

/**
 * The production door for the registered integration send path.
 *
 * Before this file there was no server caller anywhere: `invokeIntegration` was
 * exported and fully implemented but unreached, `getBySlug` had no caller, and
 * every dependency in the chain already took an `ActiveIntegrationRegistry` that
 * nothing handed over. The chain was correct and unreachable - the same shape as
 * `deployedIntegrationsDefects` in the previous slice, and invisible to a green
 * suite for the same reason.
 *
 * The provider NAME is what this route resolves. A connection records the
 * install's gate id, and reaching the registry by name needs the slug, so the
 * join is gate-id -> slug (the identity registry's own mapping) -> `getBySlug`:
 * the first production use of the by-name lookup.
 */

/** What a connection invoke needs beyond the request context. */
export type ConnectionInvokeDeps = Readonly<{
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
  /** Snapshot loader bound to an open transaction, for the executor's claim. */
  snapshotsFor(transaction: PgTransactionClient): AuthoritySnapshotPort;
  leaseSeconds?: number;
}>;

/**
 * Resolves the deployed integration that owns a connection, by name.
 *
 * Answers `undefined` rather than throwing when the install names a provider this
 * build does not deploy, so the caller decides between 404 and refusal; that keeps
 * one lookup convention with `identityForSlug` and `getBySlug`.
 */
export function activeIntegrationForConnection(
  registry: ActiveIntegrationRegistry,
  gateId: string,
): ActiveIntegration | undefined {
  const slug = slugForGateId(gateId);
  return slug === undefined ? undefined : registry.getBySlug(slug);
}

/**
 * Sends one registered integration action through the shared gate.
 *
 * The action's transport effect decides the path: a read action invokes its
 * handler directly, a write action records and drives an effect in the ledger.
 * Either way the authority check inside `invokeIntegration` is the one the gate
 * owns, so this handler adds a door and no second opinion about authorization.
 */
export async function invokeConnectionAction(
  context: ActionContext,
  deps: ConnectionInvokeDeps,
  input: Readonly<{ action: string; arguments: unknown }>,
): Promise<IntegrationInvokeResult> {
  const { actor } = organizationActor(context);
  const connectionId = context.params.id;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    // The router mounts this only under `/v1/integration-connections/{id}/actions`,
    // so a missing id is an internal wiring fault, not caller input.
    throw new StandardError({ code: "INTERNAL" });
  }
  // A connection id is a uuid. Anything else cannot name a connection, so it is
  // answered as absent rather than handed to a query that would fail its cast
  // and surface as a 500 for what is really a bad path.
  if (!isUuid(connectionId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  // A caller that names an idempotency key is asking for a deliberate repeat to
  // be distinguishable from a retry: the ledger collapses an equal resend under
  // the same key and treats a different key as a new intent. Dropping the header
  // here would make every repeat look like a retry of the first one.
  const suppliedKey = context.request?.headers.get("idempotency-key") ??
    null;
  const idempotencyKey = suppliedKey === null
    ? undefined
    : parseIdempotencyKey(suppliedKey);

  // The REST door names an action, not a version: the catalog says the host
  // resolves the action's current registered version and the target resource
  // under the caller's grant. An unknown id resolves to version 0, which matches
  // nothing, so `invokeIntegration` raises its own unknown-action refusal instead
  // of this door inventing a second error shape for the same condition.
  const actionVersion = actionVersionOf(deps.registry, input.action);
  const { resourceId, arguments: actionArguments } = splitInvocationArguments(
    input.arguments,
  );

  return await invokeIntegration({
    database: contextDatabase(context),
    registry: deps.registry,
    snapshotsFor: deps.snapshotsFor,
    providerRequests: deps.providerRequests,
    snapshots: standaloneSnapshotsOf(
      contextDatabase(context),
      deps.snapshotsFor,
    ),
    ...(deps.leaseSeconds === undefined
      ? {}
      : { leaseSeconds: deps.leaseSeconds }),
    signal: context.signal,
  }, {
    organizationId: actor.organizationId,
    actorRef: actor.subject.principalId,
    connectionId,
    input: {
      actionId: input.action,
      actionVersion,
      resourceId,
      arguments: actionArguments,
    },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

/**
 * The transaction the action runner opened for this request.
 *
 * `invokeIntegration` drives the effect ledger, which must see the same rows the
 * authority check read, so the database comes from the action context rather than
 * from a process-wide pool that could observe a different snapshot.
 */
function contextDatabase(context: ActionContext): PgDatabase {
  const value = (context as ActionContext & { database?: PgDatabase }).database;
  if (!value) throw new StandardError({ code: "INTERNAL" });
  return value;
}

/**
 * The `+action grant` half of the catalog's `Developer+action grant` tier.
 *
 * `authorizeOrganizationAction` refuses every access tier outside the three base
 * organization policies unless the action names its own guard, and this tier is
 * one of them: the role check alone would let a Developer invoke any action on
 * any connection. This guard answers the other half - the caller holds a live
 * out-of-bakery grant for the exact action and resource the request names - and
 * the gate still re-reads the whole snapshot per invocation for binding, health,
 * availability and the grant's action version.
 *
 * Without it the route was refused for EVERY caller, the connection's own Admin
 * included: the authority layer threw `requires an action-specific authorization
 * guard` before the handler ran, so the gate never saw a request. A refusal test
 * alone could not see that - it passes for the wrong reason - which is why the
 * granted call is the one that proves the door.
 */
export async function authorizeActionGrant(
  context: ActionContext,
  input: unknown,
): Promise<void> {
  const { context: authorized, actor } = organizationActor(context);
  const connectionId = context.params.id;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const value = (input ?? {}) as { action?: unknown; arguments?: unknown };
  if (typeof value.action !== "string" || value.action.length === 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid invocation input",
    });
  }
  const { resourceId } = splitInvocationArguments(value.arguments);
  if (
    !await holdsExternalActionGrant(authorized.transaction, {
      organizationId: actor.organizationId as string,
      connectionId,
      capability: value.action,
      resourceId,
      principalId: actor.subject.principalId as string,
      role: actor.role ?? null,
    })
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

/**
 * Whether the principal, directly or through its organization role, holds a
 * live out-of-Bakery grant for one capability (an action id) on one resource
 * of one connection. The gate re-reads the whole snapshot per invocation; this
 * is the guard that runs before it.
 */
export async function holdsExternalActionGrant(
  transaction: PgTransactionClient,
  grant: Readonly<{
    organizationId: string;
    connectionId: string;
    capability: string;
    resourceId: string;
    principalId: string;
    role: string | null;
  }>,
): Promise<boolean> {
  const granted = await transaction.query(
    `select 1 from bakery.integration_grants
      where organization_id = $1 and connection_id = $2
        and direction = 'out_of_bakery'
        and capability = $3 and resource_id = $4
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and (
          (subject_type = 'principal' and subject_principal_id = $5)
          or (subject_type = 'organization_role' and subject_role = $6)
        )`,
    [
      grant.organizationId,
      grant.connectionId,
      grant.capability,
      grant.resourceId,
      grant.principalId,
      grant.role,
    ],
  );
  return granted.rows.length > 0;
}

/**
 * The version the registry currently declares for an action id.
 *
 * A registry activation mounts exactly one version per action id, so the first
 * match is the current one. Answers 0 when nothing declares the id, which
 * `findActiveAction` then fails to match, so the caller gets the gate's own
 * unknown-action refusal rather than a second error shape.
 */
function actionVersionOf(
  registry: ActiveIntegrationRegistry,
  actionId: string,
): number {
  for (const integration of registry.integrations) {
    for (const action of integration.actions) {
      if (action.id === actionId) return action.version;
    }
  }
  return 0;
}

/**
 * Split the REST body into the resource selector and the action's own arguments.
 *
 * The REST contract names the target resource inside `arguments`, because a
 * client posting to `/v1/integration-connections/{id}/actions` has no second
 * place to put it. `IntegrationActionInput` carries `resourceId` as its own
 * field, and each action's handler declares a STRICT argument object that knows
 * nothing about resources.
 *
 * So the selector has to be lifted out here, not merely read here. Passing the
 * body through untouched made every strict-input action unreachable: the gate
 * resolved the resource, then refused the same body as `invalid action
 * arguments` because it still contained `resourceId`. Nested invocations could
 * not see it - only a granted call that reaches the handler's own parse can.
 */
function splitInvocationArguments(argumentsInput: unknown): {
  resourceId: string;
  arguments: Readonly<Record<string, unknown>>;
} {
  const value = (argumentsInput ?? {}) as Record<string, unknown>;
  const { resourceId, ...argumentsWithoutResource } = value;
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid invocation input",
    });
  }
  return { resourceId, arguments: argumentsWithoutResource };
}

/**
 * The response the catalog declares for this route: one `ActionResult` shape.
 *
 * A read carries its handler output. A write carries the ledger's effect id and
 * never claims provider completion - `accepted` says the send was recorded, and
 * `result` stays null until reconciliation proves an outcome. The internal result
 * carries the resolved action and its handler, which are not JSON and must never
 * be sent.
 */
export type ConnectionInvokeResponse = Readonly<{
  accepted: boolean;
  operation: string;
  externalEffectId: string | null;
  result: JsonValue;
}>;

/** Projects an internal invocation result onto the catalog's response shape. */
export function toConnectionInvokeResponse(
  result: IntegrationInvokeResult,
): ConnectionInvokeResponse {
  if (result.route === "direct") {
    return {
      accepted: true,
      operation: result.action.id,
      externalEffectId: null,
      result: asJson(result.output),
    };
  }
  return {
    accepted: true,
    operation: result.action.id,
    externalEffectId: result.prepare.effectId,
    // Only a confirmed effect has a proven result; an uncertain one has none, and
    // reporting the safe result of an unproven write would overstate it.
    result: result.run.outcome === "confirmed"
      ? asJson(result.run.effect.safeResult)
      : null,
  };
}

/**
 * Narrows a handler's output to the declared JSON shape.
 *
 * The gate validates a handler's output against its own schema before returning
 * it, so a value that reaches here is already contract-shaped; this narrows the
 * static type without re-deciding the contract, and a non-JSON value would have
 * failed that validation rather than arrive as one.
 */
function asJson(value: unknown): JsonValue {
  return value === undefined ? null : value as JsonValue;
}

/** A snapshot port bound to one transaction, for the executor's claim path. */
export function transactionSnapshots(
  transaction: PgTransactionClient,
  registry: ActiveIntegrationRegistry,
): AuthoritySnapshotPort {
  return { load: (key) => loadSnapshot(transaction, registry, key) };
}

/** Builds the dependency set once per process, with the activated registry. */
export function connectionInvokeDeps(
  registry: ActiveIntegrationRegistry,
  providerRequests: ProviderRequestPort,
): ConnectionInvokeDeps {
  return {
    registry,
    providerRequests,
    snapshotsFor: (transaction) => transactionSnapshots(transaction, registry),
  };
}
