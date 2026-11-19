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
import type {
  TicketReadinessReport,
  TicketSourcePolicy,
} from "@bakery/contracts/ticket-admission";
import type { TicketPrefetch } from "./ticket-prefetch.ts";
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
import { previewReadiness, TICKET_PRESET_ID } from "./ticket-admission.ts";
import {
  type TicketOperationDependencies,
  ticketReads,
} from "./ticket-operation-runner.ts";
import { loadTicketSource } from "./ticket-query.ts";
import {
  intentFromLabels,
  parsePreviewFilters,
  storedTicketSourcePolicy,
} from "./ticket-policy.ts";
import { lockSource, lockSourceForUpdate } from "./ticket-store.ts";
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
type PreviewCreate = z.output<typeof contractSchemas.TicketPreviewCreate>;
type PreviewResult = z.output<typeof contractSchemas.TicketPreviewResult>;
type SourceOutput = z.output<typeof contractSchemas.TicketSource>;
type RulesReplace = z.output<typeof contractSchemas.TicketRoutingRulesReplace>;
type RuleSetOutput = z.output<typeof contractSchemas.TicketRoutingRuleSet>;

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
  const policy = storedTicketSourcePolicy(input.policy, null, new Date());
  const scope = await transaction.query<
    {
      installationId: string;
      provider: string;
      externalId: string;
      displayName: string;
    }
  >(
    `select connection.installation_id as "installationId",
            connection.provider as "provider",
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
       id, organization_id, provider, integration_connection_id,
       integration_resource_id, application_id, repository_id,
       external_container_id, enabled, policy
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9::jsonb)
     on conflict (organization_id, integration_connection_id,
                  external_container_id) do nothing
     returning id`,
    [
      id,
      organizationId,
      // Named, never defaulted: the default was dropped so a source cannot be
      // admitted without saying which provider it belongs to. The connection is
      // the authority on that, so the source inherits it rather than assuming.
      resource.provider,
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
    : storedTicketSourcePolicy(
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

type StoredRule = {
  id: string;
  provider_label_id: string;
  label_name: string;
  repository_id: string;
  role: string;
  preset_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

async function storedRules(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<StoredRule[]> {
  const result = await transaction.query<StoredRule>(
    `select id, provider_label_id, label_name, repository_id, role, preset_id,
            version,
            created_at, updated_at
       from bakery.ticket_routing_rules
      where organization_id = $1 and ticket_source_id = $2
      order by provider_label_id, repository_id`,
    [organizationId, sourceId],
  );
  return result.rows;
}

function ruleSetOutput(
  organizationId: string,
  source: { id: string; policyRevision: number; version: number },
  rules: readonly StoredRule[],
): RuleSetOutput {
  return {
    ticketSourceId: source.id,
    policyRevision: source.policyRevision,
    version: source.version,
    rules: rules.map((rule) => ({
      id: rule.id,
      organizationId,
      ticketSourceId: source.id,
      labelId: rule.provider_label_id,
      labelName: rule.label_name,
      repositoryId: rule.repository_id,
      role: rule.role,
      presetId: rule.preset_id,
      version: rule.version,
      createdAt: rule.created_at.toISOString(),
      updatedAt: rule.updated_at.toISOString(),
    })),
  } as RuleSetOutput;
}

/**
 * `ticketRoutingRules.get`: the label routing rules of one source with the
 * source's policy revision and version. A missing or foreign source is 404.
 */
export async function getTicketRoutingRules(
  context: ActionContext,
): Promise<RuleSetOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const source = await loadTicketSource(
    transaction,
    organizationId,
    sourceId(context),
  );
  return ruleSetOutput(
    organizationId,
    source,
    await storedRules(transaction, organizationId, source.id),
  );
}

/**
 * `ticketRoutingRules.replace` (#31): Admin, `If-Match` against the source
 * version. Replaces the source's rules as a whole. A rule whose label and
 * repository survive keeps its id, and its version moves only when its role or
 * preset changed; a removed rule is deleted (the targets that pinned it keep
 * their pins). Any change advances the source's policy revision and version
 * once, under the source row `for update`, so an admission holding it
 * `for share` finishes first and the next one is judged on the new rules.
 * Every target must be a live repository of the source's application with a
 * live role binding (alias) for the rule's role. Rules match the provider's
 * label id, so a rename (a new labelName for the same id) keeps routing.
 */
export async function replaceTicketRoutingRules(
  context: ActionContext,
  input: RulesReplace,
): Promise<RuleSetOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const id = sourceId(context);
  const current = await lockSourceForUpdate(transaction, organizationId, id);
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const wanted = new Map<
    string,
    {
      labelId: string;
      labelName: string;
      repositoryId: string;
      role: string;
      presetId: string;
    }
  >();
  input.rules.forEach((rule, index) => {
    const key = `${rule.labelId}\u0000${rule.repositoryId}`;
    if (wanted.has(key)) {
      throw unprocessable(["rules", index], "routing_rule_duplicate");
    }
    wanted.set(key, {
      labelId: rule.labelId,
      labelName: rule.labelName,
      repositoryId: rule.repositoryId,
      role: rule.role,
      presetId: rule.presetId ?? TICKET_PRESET_ID,
    });
  });
  const repositoryIds = [
    ...new Set([...wanted.values()].map((rule) => rule.repositoryId)),
  ];
  if (repositoryIds.length > 0) {
    const live = await transaction.query<{ id: string }>(
      `select id from bakery.repositories
        where organization_id = $1 and application_id = $2
          and archived_at is null and id = any($3::uuid[])`,
      [organizationId, current.applicationId, repositoryIds],
    );
    const usable = new Set(live.rows.map((row) => row.id));
    const index = input.rules.findIndex((rule) =>
      !usable.has(rule.repositoryId)
    );
    if (index >= 0) {
      throw unprocessable(
        ["rules", index, "repositoryId"],
        "routing_repository_unavailable",
      );
    }
    // A routed target runs as a lane of a coordination plan, which names its
    // repository by the application's role binding alias for that role.
    const bound = await transaction.query<
      { repository_id: string; role: string }
    >(
      `select distinct repository_id, role
         from bakery.repository_role_bindings
        where organization_id = $1 and application_id = $2
          and alias is not null and archived_at is null
          and repository_id = any($3::uuid[])`,
      [organizationId, current.applicationId, repositoryIds],
    );
    const pairs = new Set(
      bound.rows.map((row) => `${row.repository_id}\u0000${row.role}`),
    );
    const unbound = input.rules.findIndex((rule) =>
      !pairs.has(`${rule.repositoryId}\u0000${rule.role}`)
    );
    if (unbound >= 0) {
      throw unprocessable(["rules", unbound, "role"], "routing_role_unbound");
    }
  }
  const existing = await storedRules(transaction, organizationId, id);
  let changed = false;
  for (const rule of existing) {
    const key = `${rule.provider_label_id}\u0000${rule.repository_id}`;
    const next = wanted.get(key);
    if (next === undefined) {
      await transaction.query(
        `delete from bakery.ticket_routing_rules
          where organization_id = $1 and id = $2`,
        [organizationId, rule.id],
      );
      changed = true;
    } else if (
      next.role !== rule.role || next.presetId !== rule.preset_id ||
      next.labelName !== rule.label_name
    ) {
      await transaction.query(
        `update bakery.ticket_routing_rules
            set role = $3, preset_id = $4, label_name = $5,
                updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2`,
        [organizationId, rule.id, next.role, next.presetId, next.labelName],
      );
      changed = true;
    }
    wanted.delete(key);
  }
  for (const rule of wanted.values()) {
    await transaction.query(
      `insert into bakery.ticket_routing_rules (
         id, organization_id, ticket_source_id, provider_label_id,
         label_name, repository_id, role, preset_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        organizationId,
        id,
        rule.labelId,
        rule.labelName,
        rule.repositoryId,
        rule.role,
        rule.presetId,
      ],
    );
    changed = true;
  }
  if (changed) {
    await transaction.query(
      `update bakery.ticket_sources
          set policy_revision = policy_revision + 1,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [organizationId, id],
    );
  }
  const updated = await loadTicketSource(transaction, organizationId, id);
  const rules = await storedRules(transaction, organizationId, id);
  await recordSourceFact(
    context,
    transaction,
    { organizationId, principalId },
    updated,
    "ticketRoutingRules.replace",
    "ticket.source_changed",
    {
      rulesChanged: changed,
      rules: rules.length,
      policyRevision: updated.policyRevision,
    },
  );
  return ruleSetOutput(organizationId, updated, rules);
}

/**
 * `ticketSources.preview`: Admin (#69). Judges each issue the runner read (at
 * most 25, read before this transaction opened) under the draft policy the
 * input carries, or the saved one, as a poll would judge it, and answers with
 * the buckets. It stores nothing behind the answer: no snapshot, report,
 * link, request, task or run, and never the draft. A draft is validated as
 * `ticketSources.update` validates a replacement. An issue that cannot be
 * judged is counted in `skipped`. Only the audit row and the catalog event
 * record that a preview ran.
 */
export function createTicketSourcePreviewHandler(
  dependencies: TicketOperationDependencies,
) {
  return async (
    context: ActionContext,
    input: PreviewCreate,
  ): Promise<PreviewResult> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const id = sourceId(context);
    const saved = await lockSource(transaction, organizationId, id);
    const filters = parsePreviewFilters(input.filters);
    const draft = input.policy === undefined || input.policy === null
      ? null
      : storedTicketSourcePolicy(input.policy, saved.policy, new Date());
    if (draft !== null) {
      await requireDelegationPrincipal(transaction, organizationId, draft);
    }
    const { issues } = ticketReads(context, "preview");
    const entries: PreviewResult["issues"] = [];
    let skipped = 0;
    for (const [number, prefetch] of issues) {
      const labels = prefetch.issue.kind === "present"
        ? prefetch.issue.snapshot.labels
        : null;
      if (
        filters.labels !== undefined &&
        !(labels ?? []).some((label) => filters.labels!.includes(label))
      ) {
        continue;
      }
      try {
        const { report, policy } = await inSavepoint(
          transaction,
          `ticket_preview_${entries.length + skipped}`,
          () =>
            previewReadiness({
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
            }, draft),
        );
        entries.push(previewEntry(number, prefetch, report, policy));
      } catch (error) {
        if (!(error instanceof StandardError)) throw error;
        skipped += 1;
      }
    }
    const counts = { wouldStart: 0, planOnly: 0, held: 0, blocked: 0 };
    for (const entry of entries) {
      if (entry.outcome === "would_start") counts.wouldStart += 1;
      else if (entry.outcome === "plan_only") counts.planOnly += 1;
      else if (entry.outcome === "held") counts.held += 1;
      else counts.blocked += 1;
    }
    await recordSourceFact(
      context,
      transaction,
      { organizationId, principalId },
      await loadTicketSource(transaction, organizationId, id),
      "ticketSources.preview",
      "ticket.preview_requested",
      { draft: draft !== null, evaluated: entries.length, skipped },
    );
    return {
      sourceId: id,
      policyRevision: saved.policyRevision,
      draft: draft !== null,
      evaluatedAt: new Date().toISOString(),
      counts,
      issues: entries,
      skipped,
    };
  };
}

/** One issue's bucket: the hold wins, then a ready verdict by its label's intent, else blocked. */
function previewEntry(
  number: number,
  prefetch: TicketPrefetch,
  report: TicketReadinessReport,
  policy: TicketSourcePolicy,
): PreviewResult["issues"][number] {
  const labels = prefetch.issue.kind === "present"
    ? prefetch.issue.snapshot.labels
    : [];
  const { intent, hold } = intentFromLabels(labels, policy);
  const outcome = hold
    ? "held"
    : report.verdict !== "ready"
    ? "blocked"
    : intent === "start"
    ? "would_start"
    : intent === "plan"
    ? "plan_only"
    : "blocked";
  const reasons: string[] = [];
  for (const check of report.checks) {
    if (check.status !== "pass" && !reasons.includes(check.reason)) {
      reasons.push(check.reason);
    }
  }
  return {
    number,
    title: prefetch.issue.kind === "present"
      ? prefetch.issue.snapshot.title
      : null,
    outcome,
    verdict: report.verdict,
    reasons,
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
