import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  ORGANIZATION_RULES_MAX_BYTES,
  type OrganizationRepositoryRuleEntry,
  OrganizationRepositoryRulesSchema,
  organizationRulesBytes,
} from "@bakery/contracts/repository-rules";
import type {
  CatalogActionName,
  CatalogPermissionKey,
} from "@bakery/contracts/contracts";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import { freshActor } from "../auth/adapters/access-postgres.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { authorize } from "../auth/application/authorize.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

const VERSIONS_ORDERING = "revision:desc,id:desc";
const VERSION_COLUMNS =
  "id, organization_id, revision, config, digest, created_by, created_at";

export type RuleVersionRow = {
  id: string;
  organization_id: string;
  revision: number;
  config: { entries?: unknown } | null;
  digest: string;
  created_by: string | null;
  created_at: Date | string;
};

type CursorQueryInput = { cursor?: string; limit?: number };
type PublishInput = { expectedRevision: number; entries: unknown[] };

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function storedEntries(row: RuleVersionRow): OrganizationRepositoryRuleEntry[] {
  try {
    const entries = row.config?.entries ?? [];
    return JSON.parse(
      JSON.stringify(entries),
    ) as OrganizationRepositoryRuleEntry[];
  } catch {
    throw new Error("REPOSITORY_RULE_VERSION_CONFIG_INVALID");
  }
}

/**
 * Digest of a published baseline: SHA-256 hex of the canonical JSON of
 * `{ revision, entries }`. The stored `config` column holds that same object,
 * so a reader recomputes it from the returned revision and entries.
 */
export async function repositoryRuleVersionDigest(
  revision: number,
  entries: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson({ revision, entries }));
}

export function toRuleVersion(row: RuleVersionRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    revision: row.revision,
    entries: storedEntries(row),
    digest: row.digest,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
  };
}

/**
 * Serializes publishers per organization and re-checks the caller under the lock.
 *
 * The lock key is deliberately the shared `bakery:organization:<id>` key:
 * membership, role and binding changes (`organization-postgres.ts`,
 * `access-postgres.ts`) take the same key, so once it is held no role change
 * can commit until this transaction ends. Re-resolving the actor here
 * (`freshActor`, which takes the same lock) therefore cannot race a
 * demotion: a role removed while this request waited is refused with the
 * same denial the pre-lock check gives (403 for a write).
 */
export async function lockAndReauthorize(
  context: ActionContext,
  permission: CatalogPermissionKey = "repositoryRule:manage",
  action: CatalogActionName = "repositoryRuleVersions.create",
): Promise<OrganizationActor> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const actor = (context as Partial<AuthorizedActionContext>).authority;
  if (!actor || !("organizationId" in actor)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const live = await freshActor(transaction, actor as OrganizationActor);
  if (live.organizationId !== organizationId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  authorize(live, permission, { action });
  return live;
}

/**
 * Authorizes a further permission for the caller. Uses the live actor when
 * the organization lock was already taken (and the actor re-resolved under
 * it); otherwise the actor the authority runner resolved for this request.
 * Taking the organization lock here would invert the lock order, because the
 * application and repository row locks are already held at this point.
 */
export function authorizeAlso(
  context: ActionContext,
  live: OrganizationActor | undefined,
  permission: CatalogPermissionKey,
  action: CatalogActionName,
): void {
  const actor = live ??
    (context as Partial<AuthorizedActionContext>).authority;
  if (!actor || !("organizationId" in actor)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  authorize(actor as OrganizationActor, permission, { action });
}

/**
 * The single reader of an organization's latest published rule version.
 * The organization predicate is explicit: tenant isolation lives here.
 */
export async function readLatestRuleVersionRow(
  transaction: PgTransactionClient,
  organizationId: string,
): Promise<RuleVersionRow | undefined> {
  const result = await transaction.query<RuleVersionRow>(
    `select ${VERSION_COLUMNS}
       from bakery.organization_repository_rule_versions
      where organization_id = $1
      order by revision desc
      limit 1`,
    [organizationId],
  );
  return result.rows[0];
}

/**
 * Reads the latest published baseline. With no published revision the answer
 * is the canonical empty baseline: revision 0, no entries, the digest of that
 * baseline, and null author and timestamp. There is no ETag; the revision in
 * the body is the version, like `installationSettings.get`.
 */
export async function getRepositoryRules(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const row = await readLatestRuleVersionRow(transaction, organizationId);
  if (!row) {
    return {
      organizationId,
      revision: 0,
      entries: [] as OrganizationRepositoryRuleEntry[],
      digest: await repositoryRuleVersionDigest(0, []),
      createdAt: null,
      createdBy: null,
    };
  }
  const { id: _id, ...rest } = toRuleVersion(row);
  return rest;
}

export async function publishRepositoryRuleVersion(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as PublishInput;
  requireCommandMetadata(context);

  await lockAndReauthorize(context);
  const max = await transaction.query<{ max: number }>(
    `select coalesce(max(revision), 0)::integer as max
       from bakery.organization_repository_rule_versions
      where organization_id = $1`,
    [organizationId],
  );
  const current = max.rows[0]?.max ?? 0;
  if (current !== value.expectedRevision) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const revision = current + 1;
  const parsed = OrganizationRepositoryRulesSchema.safeParse({
    revision,
    entries: value.entries,
  });
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  if (
    organizationRulesBytes(parsed.data.entries) > ORGANIZATION_RULES_MAX_BYTES
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["entries"],
          code: "repository_rules_too_large",
          message:
            `Organization rules must stay within ${ORGANIZATION_RULES_MAX_BYTES} canonical bytes so every run can carry them.`,
        }],
      },
    });
  }
  const config = { revision, entries: parsed.data.entries };
  const digest = await repositoryRuleVersionDigest(revision, config.entries);
  const id = crypto.randomUUID();
  let inserted;
  try {
    inserted = await transaction.query<RuleVersionRow>(
      `insert into bakery.organization_repository_rule_versions (
         id, organization_id, revision, config, digest, created_by
       ) values ($1, $2, $3, $4::jsonb, $5, $6)
       returning ${VERSION_COLUMNS}`,
      [
        id,
        organizationId,
        revision,
        JSON.stringify(config),
        digest,
        principalId,
      ],
    );
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "PRECONDITION_FAILED", cause: error });
    }
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) throw new Error("REPOSITORY_RULE_VERSION_INSERT_FAILED");
  // No outbox row on purpose (agents precedent): an unmapped Inngest event
  // would make outbox delivery fail with EVENT_TRIGGER_UNMAPPED.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "repositoryRuleVersions.create",
    resourceType: "repository_rule_version",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "repositoryRules.published",
    aggregateId: id,
    aggregateVersion: revision,
    payload: { resourceId: id, resourceVersion: revision },
    traceId: context.traceId,
  });
  return toRuleVersion(row);
}

export function createRepositoryRuleVersionsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "repositoryRuleVersions.list",
      principalId,
      organizationId,
      ordering: VERSIONS_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<RuleVersionRow>(
      `select ${VERSION_COLUMNS}
         from bakery.organization_repository_rule_versions
        where organization_id = $1
          and ($2::integer is null or (revision, id) < ($2, $3::uuid))
        order by revision desc, id desc
        limit $4`,
      [
        organizationId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toRuleVersion),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: last.revision,
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}
