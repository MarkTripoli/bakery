import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type contractSchemas,
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  type TicketSourcePolicy,
  TicketSourcePolicyInputSchema,
} from "@bakery/contracts/ticket-admission";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import { canonicalJson } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { authorityVerdict } from "../integrations/fact-reads.ts";
import { resolveRepositoryId } from "../integrations/pull-requests.ts";
import { lockAuthority } from "../integrations/write-authority.ts";
import { recordReadiness } from "./ticket-admission.ts";
import {
  type TicketOperationDependencies,
  ticketReads,
} from "./ticket-operation-runner.ts";
import { loadTicketSource } from "./ticket-query.ts";
import { parseTicketSourcePolicy } from "./ticket-policy.ts";
import { lockSourceForUpdate } from "./ticket-store.ts";
import {
  inSavepoint,
  runTicketSourceStep,
  SYNC_OPERATION_LIMIT,
} from "./ticket-sync.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Ticket source commands: create, update, preview and sync. Each commits its
 * state change, an audit row and the catalog's domain event in one
 * transaction. The events carry no outbox delivery key: they only announce
 * that a safe projection changed. A source is configuration, so these write
 * no link, request, task or run; preview records snapshots and reports only,
 * and sync goes through the one shared step.
 */

type SourceCreate = z.output<typeof contractSchemas.TicketSourceCreate>;
type SourceUpdate = z.output<typeof contractSchemas.TicketSourceUpdate>;
type OperationReceipt = z.output<typeof contractSchemas.TicketOperationReceipt>;
type SourceOutput = z.output<typeof contractSchemas.TicketSource>;

/**
 * The policy to store from one a client sent. `automatic.since` is the
 * server's: now when automatic admission is switched on (on create, on every
 * false-to-true flip, and when a disabled source is enabled again, which the
 * caller passes as no `previous`), unchanged while it stays on, null while
 * off. Whatever the client sent for it is ignored.
 */
function storedPolicy(
  value: unknown,
  previous: TicketSourcePolicy | null,
  now: Date,
): TicketSourcePolicy {
  const parsed = TicketSourcePolicyInputSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      ["policy"],
      "ticket_source_policy_invalid",
      parsed.error,
    );
  }
  const enabled = parsed.data.automatic.enabled;
  const since = !enabled
    ? null
    : previous?.automatic.enabled === true
    ? previous.automatic.since
    : now.toISOString();
  return parseTicketSourcePolicy({
    ...parsed.data,
    automatic: { enabled, since },
  });
}

/** The delegation principal must be a member of the organization; its permissions are checked live on every admission. */
async function requireDelegationPrincipal(
  transaction: PgTransactionClient,
  organizationId: string,
  policy: TicketSourcePolicy,
): Promise<void> {
  if (policy.delegation === null) return;
  try {
    await resolveOrganizationActor(
      transaction,
      toPrincipalId(policy.delegation.principalId),
      toOrganizationId(organizationId),
    );
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    throw unprocessable(
      ["policy", "delegation", "principalId"],
      "delegation_principal_unknown",
    );
  }
}

/** Audit row and domain event of one source operation, in the caller's transaction. */
async function recordSourceFact(
  context: ActionContext,
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  source: SourceOutput,
  operation: string,
  eventType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    operation,
    resourceType: "ticket_source",
    resourceId: source.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    applicationId: source.applicationId,
    repositoryId: source.repositoryId,
    eventType,
    aggregateId: source.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      actor.organizationId,
      source.id,
      eventType,
    ),
    payload: { resourceId: source.id, resourceVersion: source.version },
    traceId: context.traceId,
  });
}

function sourceId(context: ActionContext): string {
  if (!context.params.id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return context.params.id;
}

/**
 * `ticketSources.create`: Admin. The connection, the repository resource and
 * the application must be live parts of this organization, the repository
 * must be the one the resource maps to, and the policy must parse under the
 * strict stored schema with a delegation principal that exists here.
 */
export async function createTicketSource(
  context: ActionContext,
  input: SourceCreate,
): Promise<SourceOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const policy = storedPolicy(input.policy, null, new Date());
  const scope = await transaction.query<
    { installationId: string; externalId: string; displayName: string }
  >(
    `select connection.installation_id as "installationId",
            resource.external_id as "externalId",
            resource.display_name as "displayName"
       from bakery.integration_connections as connection
       join bakery.integration_resources as resource
         on resource.organization_id = connection.organization_id
        and resource.connection_id = connection.id
      where connection.organization_id = $1 and connection.id = $2
        and connection.archived_at is null
        and resource.id = $3 and resource.kind = 'repository'
        and resource.archived_at is null`,
    [organizationId, input.connectionId, input.resourceId],
  );
  const resource = scope.rows[0];
  if (!resource) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const locked = await lockAuthority(transaction, {
    organizationId,
    connectionId: input.connectionId,
    installationId: resource.installationId,
    resourceId: input.resourceId,
  });
  const verdict = authorityVerdict({
    purpose: "fact_refresh",
    installationId: resource.installationId,
    resourceId: input.resourceId,
    eventKind: "issues",
  }, { ...locked, tracked: true });
  if (verdict !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "resource_unavailable" },
    });
  }
  if (input.externalContainerId !== resource.externalId) {
    throw unprocessable(["externalContainerId"], "external_container_mismatch");
  }
  const application = await transaction.query(
    `select 1 from bakery.applications
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, input.applicationId],
  );
  if (application.rows.length === 0) {
    throw unprocessable(["applicationId"], "application_not_found");
  }
  // The fixed preset runs in one repository, so the source must name it.
  if (input.repositoryId == null) {
    throw unprocessable(["repositoryId"], "repository_required");
  }
  const resolved = await resolveRepositoryId(transaction, {
    organizationId,
    connectionId: input.connectionId,
    externalId: resource.externalId,
    displayName: resource.displayName,
  });
  if (resolved !== input.repositoryId) {
    throw unprocessable(["repositoryId"], "repository_mismatch");
  }
  const owner = await transaction.query<{ application_id: string }>(
    `select application_id from bakery.repositories
      where organization_id = $1 and id = $2`,
    [organizationId, input.repositoryId],
  );
  if (owner.rows[0]?.application_id !== input.applicationId) {
    throw unprocessable(["repositoryId"], "repository_not_in_application");
  }
  await requireDelegationPrincipal(transaction, organizationId, policy);

  const id = crypto.randomUUID();
  const inserted = await transaction.query(
    `insert into bakery.ticket_sources (
       id, organization_id, integration_connection_id,
       integration_resource_id, application_id, repository_id,
       external_container_id, enabled, policy
     ) values ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)
     on conflict (organization_id, integration_connection_id,
                  external_container_id) do nothing
     returning id`,
    [
      id,
      organizationId,
      input.connectionId,
      input.resourceId,
      input.applicationId,
      input.repositoryId,
      input.externalContainerId,
      JSON.stringify(policy),
    ],
  );
  if (inserted.rows.length === 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_source_exists" },
    });
  }
  const created = await loadTicketSource(transaction, organizationId, id);
  await recordSourceFact(
    context,
    transaction,
    { organizationId, principalId },
    created,
    "ticketSources.create",
    "ticket.source_changed",
    {
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      applicationId: input.applicationId,
      automaticEnabled: policy.automatic.enabled,
    },
  );
  return created;
}

/**
 * `ticketSources.update`: Admin, `If-Match` against the source version. A
 * changed policy advances `policy_revision`; a toggle of `enabled` alone does
 * not, except that enabling a disabled source whose automatic admission is on
 * restamps `automatic.since` to now, so an issue labeled while the source was
 * off waits for adoption, and that changes the policy. The row is locked `for
 * update` first, so a concurrent admission (which holds it `for share`)
 * finishes before the revision moves.
 */
export async function updateTicketSource(
  context: ActionContext,
  input: SourceUpdate,
): Promise<SourceOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (input.enabled === undefined && input.policy === undefined) {
    throw unprocessable(["enabled"], "ticket_source_update_empty");
  }
  const id = sourceId(context);
  const current = await lockSourceForUpdate(transaction, organizationId, id);
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const reenabled = !current.enabled && input.enabled === true;
  const policy = input.policy === undefined && !reenabled
    ? current.policy
    : storedPolicy(
      input.policy ?? current.policy,
      reenabled ? null : current.policy,
      new Date(),
    );
  const policyChanged = canonicalJson(policy) !== canonicalJson(current.policy);
  if (policyChanged) {
    await requireDelegationPrincipal(transaction, organizationId, policy);
  }
  await transaction.query(
    `update bakery.ticket_sources
        set enabled = $3, policy = $4::jsonb,
            policy_revision = policy_revision + $5,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      id,
      input.enabled ?? current.enabled,
      JSON.stringify(policy),
      policyChanged ? 1 : 0,
    ],
  );
  const updated = await loadTicketSource(transaction, organizationId, id);
  await recordSourceFact(
    context,
    transaction,
    { organizationId, principalId },
    updated,
    "ticketSources.update",
    "ticket.source_changed",
    {
      enabled: updated.enabled,
      policyChanged,
      policyRevision: updated.policyRevision,
    },
  );
  return updated;
}

/**
 * `ticketSources.preview`: Admin. Records the snapshot and a readiness report
 * of each issue of one provider page (at most 25), read before the
 * transaction opened. It writes no link, request, task or run. An issue that
 * cannot be recorded is skipped; the others commit.
 */
export function createTicketSourcePreviewHandler(
  dependencies: TicketOperationDependencies,
) {
  return async (
    context: ActionContext,
    _input: unknown,
  ): Promise<OperationReceipt> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const id = sourceId(context);
    // Several tickets in one transaction: the source `for update` first, as
    // sync does. Each ticket then takes the application row and holds it to
    // the commit, so a single-ticket operation (ticket, then application)
    // that held a later ticket of the page would wait on the application
    // while the preview waits on that ticket. Every other writer takes the
    // source `for share` first and now waits here instead.
    await lockSourceForUpdate(transaction, organizationId, id);
    const { issues } = ticketReads(context, "preview");
    let recorded = 0;
    let skipped = 0;
    for (const [number, prefetch] of issues) {
      try {
        await inSavepoint(
          transaction,
          `ticket_preview_${recorded + skipped}`,
          () =>
            recordReadiness({
              reader: dependencies.reader,
              budget: dependencies.budget,
              readsAllowed: false,
              transaction,
            }, {
              organizationId,
              sourceId: id,
              number,
              intent: null,
              origin: "poll",
              caller: null,
              prefetch,
              signal: context.signal,
              trace: { requestId: context.requestId, traceId: context.traceId },
            }),
        );
        recorded += 1;
      } catch (error) {
        if (!(error instanceof StandardError)) throw error;
        skipped += 1;
      }
    }
    await recordSourceFact(
      context,
      transaction,
      { organizationId, principalId },
      await loadTicketSource(transaction, organizationId, id),
      "ticketSources.preview",
      "ticket.preview_requested",
      { recorded, skipped },
    );
    return { operationId: crypto.randomUUID(), status: "completed" };
  };
}

/**
 * `ticketSources.sync`: Admin. One bounded step through `runTicketSourceStep`
 * over the candidates the probe selected and the runner read. The step owns
 * the source's progress columns; the failed candidates and a rate limit show in
 * the source's health, and the receipt says `failed` when the step stopped early.
 */
export function createTicketSourceSyncHandler(
  dependencies: TicketOperationDependencies,
) {
  return async (
    context: ActionContext,
    _input: unknown,
  ): Promise<OperationReceipt> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const id = sourceId(context);
    const { issues } = ticketReads(context, "sync");
    const step = await runTicketSourceStep({
      reader: dependencies.reader,
      budget: dependencies.budget,
      factIndex: dependencies.factIndex,
      readsAllowed: false,
      transaction,
    }, {
      organizationId,
      sourceId: id,
      limit: SYNC_OPERATION_LIMIT,
      prefetched: issues,
      signal: context.signal,
    });
    await recordSourceFact(
      context,
      transaction,
      { organizationId, principalId },
      await loadTicketSource(transaction, organizationId, id),
      "ticketSources.sync",
      "ticket.sync_requested",
      {
        outcome: step.outcome,
        health: step.health,
        problemCode: step.problemCode,
        candidates: step.results.length,
        failed: step.results.filter((entry) => entry.status === "failed")
          .length,
      },
    );
    return {
      operationId: crypto.randomUUID(),
      status: step.outcome === "completed" ? "completed" : "failed",
    };
  };
}
