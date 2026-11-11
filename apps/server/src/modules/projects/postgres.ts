import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { JsonValue } from "@bakery/contracts/contracts";
import { RepositoryVersionedProfileConfigSchema } from "@bakery/contracts/repository-inspection";
import { RepositoryProfileConfigSchema } from "@bakery/contracts/repository-profile-config";
import type { PgTransactionClient } from "../../platform/database.ts";
import { assertRepositoryOverridesAllowed } from "../repository-rules/effective.ts";
import {
  authorizeAlso,
  lockAndReauthorize,
} from "../repository-rules/postgres.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { nextOrganizationSequence } from "../../platform/event-clock.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import { accessScopeClause } from "../auth/application/bindings.ts";
import {
  encodedByteLength,
  profileConfigFitsInspectionBudget,
} from "./inspection-budget.ts";
import { changedRetainedFields } from "./rules-retention.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REPOSITORY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const APPLICATIONS_ORDERING = "createdAt:desc,id:desc";
const REPOSITORIES_ORDERING = "createdAt:desc,id:desc";
const PROFILES_ORDERING = "createdAt:desc,id:desc";

const APPLICATION_COLUMNS =
  "id, slug, name, description, archived_at, created_at, updated_at, version";
const REPOSITORY_COLUMNS = `id, application_id, slug,
  integration_connection_id, provider_repo_id, owner, name, default_branch,
  active_profile_id, archived_at, created_at, updated_at, version`;
const PROFILE_COLUMNS =
  "id, repository_id, revision, config, digest, created_by, created_at, updated_at, version";

type ApplicationRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
};

type RepositoryRow = {
  id: string;
  application_id: string;
  slug: string | null;
  integration_connection_id: string;
  provider_repo_id: string;
  owner: string;
  name: string;
  default_branch: string;
  active_profile_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
};

type ProfileRow = {
  id: string;
  repository_id: string;
  revision: number;
  config: unknown;
  digest: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  version: number;
};

type CursorQueryInput = {
  cursor?: string;
  limit?: number;
};

type ApplicationCreateInput = {
  slug: string;
  name: string;
  description: string;
};

type ApplicationUpdateInput = {
  slug?: string;
  name?: string;
  description?: string;
  archivedAt?: string | null;
};

type RepositoryCreateInput = {
  applicationId: string;
  slug: string;
  integrationConnectionId: string;
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
};

type RepositoryUpdateInput = {
  name?: string;
  defaultBranch?: string;
  archivedAt?: string | null;
  activeProfileId?: string;
};

type RepositoryProfileCreateInput = {
  revision: number;
  config: unknown;
  budgetCaps?: unknown;
  digest: string;
  expectedOrganizationRulesRevision?: number;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toApplication(row: ApplicationRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toRepository(row: RepositoryRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    slug: row.slug,
    integrationConnectionId: row.integration_connection_id,
    providerRepoId: row.provider_repo_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    activeProfileId: row.active_profile_id,
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toProfile(row: ProfileRow) {
  let config: JsonValue;
  try {
    config = JSON.parse(JSON.stringify(row.config)) as JsonValue;
  } catch {
    throw new Error("PROJECTS_READ_PROFILE_CONFIG_INVALID");
  }
  return {
    id: row.id,
    repositoryId: row.repository_id,
    revision: row.revision,
    config,
    digest: row.digest,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

/**
 * Wraps a mutation so a unique-constraint collision (application slug,
 * repository slug, repository provider identity, profile revision) surfaces as
 * `STATE_CONFLICT` and a check/foreign-key/malformed-literal failure
 * surfaces as `UNPROCESSABLE`. Copy of `organization-postgres.ts:264-278`;
 * each module keeps its own so a change to one boundary's error mapping
 * never silently reaches another.
 */
async function boundedMutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    const code = postgresErrorCode(error);
    if (code === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "STATE_CONFLICT", cause: error });
    }
    if (["22001", "22P02", "23502", "23503", "23514"].includes(code ?? "")) {
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    }
    throw error;
  }
}

/**
 * A publish must name the repository's next unclaimed revision. `for
 * update` on the repository row in `createProfile` serializes concurrent
 * publishes so a racing revision-N request either observes the committed
 * max here or blocks until it can; the `(repository_id, revision)` unique
 * constraint remains the backstop `boundedMutation` maps to `STATE_CONFLICT`.
 */
export function assertNextRevision(
  currentMax: number,
  requested: number,
): void {
  const expectedRevision = currentMax + 1;
  if (requested !== expectedRevision) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "revision_not_next", expectedRevision },
    });
  }
}

/** Content digest a publisher must match; also how the server verifies theirs. */
export async function profileDigest(config: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(config));
}

type RepositoryApplicationRow = {
  application_id: string;
  archived_at: Date | null;
};

// Match run admission's lock order: application before repository.
async function lockRepositoryApplication(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
): Promise<RepositoryApplicationRow> {
  const result = await transaction.query<RepositoryApplicationRow>(
    `select a.id as application_id, a.archived_at
       from bakery.applications a
       join bakery.repositories r
         on r.organization_id = a.organization_id and r.application_id = a.id
      where r.organization_id = $1 and r.id = $2
      for share of a`,
    [organizationId, repositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

function assertApplicationActive(archivedAt: Date | null): void {
  if (archivedAt !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "application_archived" },
    });
  }
}

async function assertApplication(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
): Promise<void> {
  const result = await transaction.query<{ archived_at: Date | null }>(
    `select archived_at from bakery.applications
      where organization_id = $1 and id = $2
      for share`,
    [organizationId, applicationId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  assertApplicationActive(row.archived_at);
}

/**
 * Writes the single audit-trail row a successful projects command leaves
 * behind, independent of how many domain-event facts it appends — one
 * command must always leave exactly one audit row, even `createProfile`'s
 * auto-activation path, which appends two domain events.
 */
async function recordAudit(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    requestId: string;
    traceId: string;
    /** Small integer-only facts; never free text or rule content. */
    details?: Record<string, number>;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type, resource_id,
       outcome, request_id, trace_id, details
     ) values ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8::jsonb)`,
    [
      options.organizationId,
      options.principalId,
      options.operation,
      options.resourceType,
      options.resourceId,
      options.requestId,
      options.traceId,
      JSON.stringify(options.details ?? {}),
    ],
  );
}

/**
 * Appends one domain-event fact. `applications.created`,
 * `repositories.created`, `repositories.updated` and
 * `repository.profile_created` have no Inngest trigger mapped
 * (`packages/contracts/src/events.ts`), so unlike `work/postgres.ts`
 * `appendSuccessFacts` this never writes a `bakery.outbox` row — an outbox
 * row for an unmapped event type fails permanently
 * (`platform/outbox-events.ts:51-54`).
 */
async function recordDomainEvent(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    eventType: string;
    applicationId: string | null;
    repositoryId: string | null;
    aggregateId: string;
    aggregateVersion: number;
    traceId: string;
  },
): Promise<void> {
  const sequence = await nextOrganizationSequence(
    transaction,
    options.organizationId,
  );
  await transaction.query(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       application_id, repository_id, aggregate_id, aggregate_version,
       payload, trace_id
     ) values ($1, $2, $3, 1, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      options.organizationId,
      sequence,
      options.eventType,
      options.applicationId,
      options.repositoryId,
      options.aggregateId,
      options.aggregateVersion,
      JSON.stringify({
        resourceId: options.aggregateId,
        resourceVersion: options.aggregateVersion,
      }),
      options.traceId,
    ],
  );
}

// -- Applications -----------------------------------------------------------

export function createApplicationsListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId, accessScope } =
      requireWorkTransaction(context);
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "applications.list",
      principalId,
      organizationId,
      ordering: APPLICATIONS_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    // Listing through resource bindings returns only what they reach.
    const scoped = accessScope === undefined
      ? { sql: "true", values: [] as unknown[] }
      : accessScopeClause(
        accessScope,
        { application: "id", repository: null },
        5,
      );
    const result = await transaction.query<
      ApplicationRow & { cursor_created_at: string }
    >(
      `select ${APPLICATION_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.applications
         where organization_id = $1
           and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
           and ${scoped.sql}
         order by created_at desc, id desc
         limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
        ...scoped.values,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toApplication),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getApplication(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const applicationId = context.params.id;
  if (!applicationId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<ApplicationRow>(
    `select ${APPLICATION_COLUMNS}
       from bakery.applications
      where organization_id = $1 and id = $2`,
    [organizationId, applicationId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toApplication(row);
}

export const createApplication = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as ApplicationCreateInput;
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<ApplicationRow>(
      `insert into bakery.applications (id, organization_id, slug, name, description)
       values ($1, $2, $3, $4, $5)
       returning ${APPLICATION_COLUMNS}`,
      [id, organizationId, value.slug, value.name, value.description],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("PROJECTS_APPLICATION_INSERT_FAILED");
  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: "applications.create",
    resourceType: "application",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await recordDomainEvent(transaction, {
    organizationId,
    eventType: "applications.created",
    applicationId: id,
    repositoryId: null,
    aggregateId: id,
    aggregateVersion: row.version,
    traceId: context.traceId,
  });
  return toApplication(row);
};

export const updateApplication = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as ApplicationUpdateInput;
  const applicationId = context.params.id;
  if (!applicationId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const updated = await boundedMutation(() =>
    transaction.query<ApplicationRow>(
      `update bakery.applications
          set slug = coalesce($4, slug),
              name = coalesce($5, name),
              description = coalesce($6, description),
              archived_at = case when $7::boolean then $8::timestamptz else archived_at end,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${APPLICATION_COLUMNS}`,
      [
        organizationId,
        applicationId,
        expectedVersion,
        value.slug ?? null,
        value.name ?? null,
        value.description ?? null,
        value.archivedAt !== undefined,
        value.archivedAt ?? null,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) {
    const visible = await transaction.query(
      "select 1 from bakery.applications where organization_id = $1 and id = $2",
      [organizationId, applicationId],
    );
    throw new StandardError({
      code: visible.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: "applications.update",
    resourceType: "application",
    resourceId: applicationId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await recordDomainEvent(transaction, {
    organizationId,
    eventType: "applications.updated",
    applicationId,
    repositoryId: null,
    aggregateId: applicationId,
    aggregateVersion: row.version,
    traceId: context.traceId,
  });
  return toApplication(row);
};

// -- Repositories -------------------------------------------------------

export function createRepositoriesListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId, accessScope } =
      requireWorkTransaction(context);
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "repositories.list",
      principalId,
      organizationId,
      ordering: REPOSITORIES_ORDERING,
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    // Listing through resource bindings returns only what they reach.
    const scoped = accessScope === undefined
      ? { sql: "true", values: [] as unknown[] }
      : accessScopeClause(accessScope, {
        application: "application_id",
        repository: "id",
      }, 5);
    const result = await transaction.query<
      RepositoryRow & { cursor_created_at: string }
    >(
      `select ${REPOSITORY_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.repositories
         where organization_id = $1
           and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
           and ${scoped.sql}
         order by created_at desc, id desc
         limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
        ...scoped.values,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toRepository),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getRepository(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const repositoryId = context.params.id;
  if (!repositoryId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<RepositoryRow>(
    `select ${REPOSITORY_COLUMNS}
       from bakery.repositories
      where organization_id = $1 and id = $2`,
    [organizationId, repositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toRepository(row);
}

export const createRepository = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as RepositoryCreateInput;
  await assertApplication(transaction, organizationId, value.applicationId);
  const slugMatch = typeof value.slug === "string"
    ? REPOSITORY_SLUG_PATTERN.exec(value.slug)
    : null;
  if (!slugMatch || slugMatch[0] !== value.slug) {
    throw unprocessable(["slug"], "slug_invalid");
  }
  if (!IDENTITY_PATTERN.test(value.owner)) {
    throw unprocessable(["owner"], "owner_invalid");
  }
  if (!IDENTITY_PATTERN.test(value.name)) {
    throw unprocessable(["name"], "name_invalid");
  }
  const providerRepoId = value.providerRepoId.trim();
  if (providerRepoId === "") {
    throw unprocessable(["providerRepoId"], "provider_repo_id_blank");
  }
  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<RepositoryRow>(
      `insert into bakery.repositories (
         id, organization_id, application_id, slug,
         integration_connection_id, provider_repo_id, owner, name,
         default_branch
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${REPOSITORY_COLUMNS}`,
      [
        id,
        organizationId,
        value.applicationId,
        value.slug,
        value.integrationConnectionId,
        providerRepoId,
        value.owner,
        value.name,
        value.defaultBranch,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("PROJECTS_REPOSITORY_INSERT_FAILED");
  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: "repositories.create",
    resourceType: "repository",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await recordDomainEvent(transaction, {
    organizationId,
    eventType: "repositories.created",
    applicationId: value.applicationId,
    repositoryId: id,
    aggregateId: id,
    aggregateVersion: row.version,
    traceId: context.traceId,
  });
  return toRepository(row);
};

export const updateRepository = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as RepositoryUpdateInput;
  const repositoryId = context.params.id;
  if (!repositoryId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const metadata = requireCommandMetadata(context);
  const expectedVersion = metadata.expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const application = await lockRepositoryApplication(
    transaction,
    organizationId,
    repositoryId,
  );
  const repositoryResult = await transaction.query<{
    application_id: string;
    archived_at: Date | null;
    default_branch: string;
    active_profile_id: string | null;
    version: number;
  }>(
    `select application_id, archived_at, default_branch, active_profile_id, version
       from bakery.repositories
      where organization_id = $1 and id = $2 and application_id = $3
      for update`,
    [organizationId, repositoryId, application.application_id],
  );
  const repository = repositoryResult.rows[0];
  if (!repository) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (repository.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (value.name !== undefined && !IDENTITY_PATTERN.test(value.name)) {
    throw unprocessable(["name"], "name_invalid");
  }
  if (
    repository.archived_at !== null && value.archivedAt !== null &&
    (value.activeProfileId !== undefined || value.defaultBranch !== undefined)
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_archived" },
    });
  }
  if (
    value.archivedAt === null || value.activeProfileId !== undefined ||
    value.defaultBranch !== undefined
  ) {
    assertApplicationActive(application.archived_at);
  }
  const targetDefaultBranch = value.defaultBranch ??
    repository.default_branch;
  const readProfileForActivation = async (profileId: string) => {
    const result = await transaction.query<{
      config: unknown;
      digest: string;
      has_observation: boolean;
    }>(
      `select p.config, p.digest,
          exists (
            select 1
              from bakery.repository_profile_observations o
             where o.organization_id = p.organization_id
               and o.profile_id = p.id
          ) as has_observation
         from bakery.repository_profiles p
        where p.organization_id = $1
          and p.repository_id = $2
          and p.id = $3`,
      [organizationId, repositoryId, profileId],
    );
    return result.rows[0];
  };
  if (
    value.activeProfileId === undefined &&
    value.defaultBranch !== undefined &&
    targetDefaultBranch !== repository.default_branch &&
    repository.active_profile_id !== null
  ) {
    const currentProfile = await readProfileForActivation(
      repository.active_profile_id,
    );
    const parsedConfig = currentProfile === undefined
      ? { success: false as const }
      : RepositoryProfileConfigSchema.safeParse(currentProfile.config);
    if (
      currentProfile === undefined ||
      currentProfile.has_observation ||
      !parsedConfig.success ||
      (await profileDigest(parsedConfig.data)) !== currentProfile.digest
    ) {
      throw unprocessable(["defaultBranch"], "profile_stale");
    }
  }
  if (value.activeProfileId !== undefined) {
    if (
      repository.active_profile_id !== null &&
      repository.active_profile_id !== value.activeProfileId
    ) {
      const currentProfile = await readProfileForActivation(
        repository.active_profile_id,
      );
      if (currentProfile?.has_observation) {
        throw unprocessable(
          ["activeProfileId"],
          "legacy_v1_config_only_required",
        );
      }
    }
    const profileRow = await readProfileForActivation(value.activeProfileId);
    if (!profileRow) {
      throw unprocessable(["activeProfileId"], "profile_not_in_repository");
    }
    const parsedConfig = RepositoryProfileConfigSchema.safeParse(
      profileRow.config,
    );
    if (!parsedConfig.success || profileRow.has_observation) {
      throw unprocessable(
        ["activeProfileId"],
        "legacy_v1_config_only_required",
      );
    }
    if ((await profileDigest(parsedConfig.data)) !== profileRow.digest) {
      throw unprocessable(["activeProfileId"], "profile_digest_mismatch");
    }
    if (parsedConfig.data.branches.base !== targetDefaultBranch) {
      throw unprocessable(["activeProfileId"], "profile_stale");
    }
  }
  const archivedAtProvided = value.archivedAt !== undefined;
  const updated = await boundedMutation(() =>
    transaction.query<RepositoryRow>(
      `update bakery.repositories
          set name = coalesce($4, name),
              default_branch = coalesce($5, default_branch),
              active_profile_id = coalesce($6, active_profile_id),
              archived_at = case when $7::boolean then $8::timestamptz else archived_at end,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $3
        returning ${REPOSITORY_COLUMNS}`,
      [
        organizationId,
        repositoryId,
        expectedVersion,
        value.name ?? null,
        value.defaultBranch ?? null,
        value.activeProfileId ?? null,
        archivedAtProvided,
        value.archivedAt ?? null,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) {
    const visible = await transaction.query(
      "select 1 from bakery.repositories where organization_id = $1 and id = $2",
      [organizationId, repositoryId],
    );
    throw new StandardError({
      code: visible.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: "repositories.update",
    resourceType: "repository",
    resourceId: repositoryId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await recordDomainEvent(transaction, {
    organizationId,
    eventType: "repositories.updated",
    applicationId: row.application_id,
    repositoryId,
    aggregateId: repositoryId,
    aggregateVersion: row.version,
    traceId: context.traceId,
  });
  return toRepository(row);
};

// -- Repository profiles -------------------------------------------------

export function createProfilesListHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const repositoryId = context.params.id;
    if (!repositoryId) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const visible = await transaction.query(
      "select 1 from bakery.repositories where organization_id = $1 and id = $2",
      [organizationId, repositoryId],
    );
    if (visible.rows.length !== 1) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const query = input as CursorQueryInput;
    const binding: CursorBinding = {
      action: "repositoryProfiles.list",
      principalId,
      organizationId,
      ordering: PROFILES_ORDERING,
      filters: JSON.stringify({ repositoryId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      ProfileRow & { cursor_created_at: string }
    >(
      `select ${PROFILE_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.repository_profiles
         where repository_id = $1
           and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
         order by created_at desc, id desc
         limit $4`,
      [
        repositoryId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visibleRows = result.rows.slice(0, limit);
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map(toProfile),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

type RepositoryForProfileRow = {
  id: string;
  application_id: string;
  default_branch: string;
  archived_at: Date | null;
  active_profile_id: string | null;
  version: number;
};

export const createProfile = async (
  context: ActionContext,
  input: unknown,
) => {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as RepositoryProfileCreateInput;
  const repositoryId = context.params.id;
  if (!repositoryId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const parsedConfig = RepositoryProfileConfigSchema.safeParse(value.config);
  if (!parsedConfig.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: parsedConfig.error.issues.map((issue) => ({
          path: ["config", ...issue.path],
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  const publishesFixedPolicy = parsedConfig.data.fixedPolicy !== undefined;
  // An explicit `repositoryRules` key (even `entries: []`, an explicit "no
  // overrides") is a statement about overrides and activates the profile.
  const statesRepositoryRules = parsedConfig.data.repositoryRules !== undefined;
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  // The existing fixed-policy path keeps its early guard. Rule-caused
  // activation is checked after the organization-scoped repository lookup so
  // a foreign or unknown repository answers 404 before any 428.
  if (publishesFixedPolicy && expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (
    parsedConfig.data.repositoryRules !== undefined &&
    !profileConfigFitsInspectionBudget(
      encodedByteLength(canonicalJson(parsedConfig.data)),
    )
  ) {
    // The observed config repeats these bytes in the inspection input, which
    // onboarding bounds with this same rule; refuse what could never onboard.
    throw unprocessable(
      ["config", "repositoryRules"],
      "repository_rules_too_large",
    );
  }

  let liveActor: Awaited<ReturnType<typeof lockAndReauthorize>> | undefined;
  const overrides = parsedConfig.data.repositoryRules;
  const expectedOrganizationRulesRevision =
    value.expectedOrganizationRulesRevision;
  if (overrides !== undefined) {
    if (expectedOrganizationRulesRevision === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    // Lock order: the shared organization advisory lock is taken BEFORE the
    // application/repository row locks below, on every path that takes both.
    // The auth adapters that hold the organization lock (membership, role,
    // binding, access) only issue plain MVCC reads against
    // bakery.applications / bakery.repositories, which never wait on row
    // locks, and no handler holding those row locks requests the organization
    // lock afterwards, so there is no ordering inversion. Holding the lock
    // also serializes this publish with organization rule publication, so the
    // revision read in assertRepositoryOverridesAllowed cannot go stale
    // before the insert, and the publisher's authority is re-resolved under
    // it (a demotion that committed while this request waited is refused).
    liveActor = await lockAndReauthorize(
      context,
      "repositoryProfile:manage",
      "repositoryProfiles.create",
    );
  }

  const application = await lockRepositoryApplication(
    transaction,
    organizationId,
    repositoryId,
  );
  assertApplicationActive(application.archived_at);
  const repositoryResult = await transaction.query<RepositoryForProfileRow>(
    `select id, application_id, default_branch, archived_at,
        active_profile_id, version
       from bakery.repositories
      where organization_id = $1 and id = $2 and application_id = $3
      for update`,
    [organizationId, repositoryId, application.application_id],
  );
  const repository = repositoryResult.rows[0];
  if (!repository) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // The active profile, read under the repository row lock. A publication
  // that omits `repositoryRules` while the active profile carries non-empty
  // overrides is the restore of the organization rules, so it activates too.
  const activeResult = repository.active_profile_id === null
    ? undefined
    : await transaction.query<{
      config: unknown;
      digest: string;
      has_observation: boolean;
    }>(
      `select p.config, p.digest,
        exists (
          select 1
            from bakery.repository_profile_observations o
           where o.organization_id = p.organization_id
             and o.profile_id = p.id
        ) as has_observation
       from bakery.repository_profiles p
      where p.organization_id = $1
        and p.repository_id = $2
        and p.id = $3`,
      [organizationId, repositoryId, repository.active_profile_id],
    );
  const currentProfile = activeResult?.rows[0];
  const parsedActiveConfig = currentProfile === undefined
    ? { success: false as const }
    : RepositoryVersionedProfileConfigSchema.safeParse(currentProfile.config);
  // An unparsable active config is never treated as carrying overrides.
  const activeCarriesRepositoryRules = parsedActiveConfig.success &&
    (parsedActiveConfig.data.repositoryRules?.entries.length ?? 0) > 0;
  const activatesOnPublish = publishesFixedPolicy || statesRepositoryRules ||
    activeCarriesRepositoryRules;
  // A strict-v1 active profile whose base branch no longer matches the
  // repository default branch is replaced by any new profile (existing
  // behaviour, no If-Match). It is still a replacing activation.
  const parsedCurrentV1 = currentProfile === undefined
    ? { success: false as const }
    : RepositoryProfileConfigSchema.safeParse(currentProfile.config);
  const activatesOnDefaultBranchMismatch = !activatesOnPublish &&
    repository.active_profile_id !== null &&
    currentProfile !== undefined && !currentProfile.has_observation &&
    parsedCurrentV1.success &&
    (await profileDigest(parsedCurrentV1.data)) === currentProfile.digest &&
    parsedCurrentV1.data.branches.base !== repository.default_branch;
  // Any activation that replaces an existing active profile (fixed-policy or
  // rules caused; the first profile of a repository is not a replacement)
  // needs `repository:manage`, the permission PATCH activation needs, because
  // publishing needs only `repositoryProfile:manage`. It runs BEFORE the
  // If-Match comparisons so a create-only principal learns neither the
  // repository version nor whether the active profile carries overrides.
  // Checked with the live actor when the organization lock was taken (rules
  // key), otherwise the request's resolved actor: the lock cannot be taken
  // after the row locks without inverting the lock order.
  if (
    (activatesOnPublish || activatesOnDefaultBranchMismatch) &&
    repository.active_profile_id !== null
  ) {
    authorizeAlso(
      context,
      liveActor,
      "repository:manage",
      "repositories.update",
    );
  }
  if (activatesOnPublish && expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (activatesOnPublish && repository.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  // Rules-only activation: caused by `repositoryRules` (an explicit key or
  // restoring over active overrides), not by the config's own fixedPolicy
  // (that path keeps its existing semantics) and replacing an active profile.
  // Saving rules changes rules only, so two more things hold over ANY active
  // profile, observed or not:
  // 1. It needs `repository:manage` (checked above, before the If-Match
  //    comparisons, for every activation that replaces an active profile).
  // 2. It must retain the active baseline (workflow, branches, worktree,
  //    agentBindings) and carry the active fixedPolicy; other configuration
  //    changes go through normal publish plus PATCH activation. The replaced
  //    observed profile's inspection evidence (checkPolicy) is superseded until
  //    onboarding is re-run, which is an accepted consequence.
  // 3. It fails closed on an active config that does not parse.
  const rulesCausedActivation = !publishesFixedPolicy && activatesOnPublish &&
    repository.active_profile_id !== null;
  if (rulesCausedActivation) {
    if (!parsedActiveConfig.success) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "configuration_profile_unavailable" },
      });
    }
    const changed = changedRetainedFields(
      parsedActiveConfig.data,
      parsedConfig.data,
    );
    if (changed.length > 0) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: {
          issues: [{
            path: ["config"],
            code: "repository_rules_must_retain_config",
            message: `Rules publication changed retained fields: ${
              changed.join(", ")
            }.`,
          }],
        },
      });
    }
  }
  if (repository.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_archived" },
    });
  }

  const maxResult = await transaction.query<{ max: number }>(
    `select coalesce(max(revision), 0) as max
       from bakery.repository_profiles
      where organization_id = $1 and repository_id = $2`,
    [organizationId, repositoryId],
  );
  assertNextRevision(maxResult.rows[0]?.max ?? 0, value.revision);

  if (parsedConfig.data.branches.base !== repository.default_branch) {
    throw unprocessable(
      ["config", "branches", "base"],
      "base_branch_mismatch",
    );
  }

  const digest = value.digest.toLowerCase();
  if ((await profileDigest(parsedConfig.data)) !== digest) {
    throw unprocessable(["digest"], "digest_mismatch");
  }

  if (
    overrides !== undefined && expectedOrganizationRulesRevision !== undefined
  ) {
    await assertRepositoryOverridesAllowed(
      transaction,
      organizationId,
      expectedOrganizationRulesRevision,
      overrides,
    );
  }

  const id = crypto.randomUUID();
  const inserted = await boundedMutation(() =>
    transaction.query<ProfileRow>(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision,
         config, budget_caps, digest, created_by
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       returning ${PROFILE_COLUMNS}`,
      [
        id,
        organizationId,
        repository.application_id,
        repositoryId,
        value.revision,
        JSON.stringify(parsedConfig.data),
        value.budgetCaps === undefined
          ? null
          : JSON.stringify(value.budgetCaps),
        digest,
        principalId,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("PROJECTS_PROFILE_INSERT_FAILED");

  // Auto-activation decision. Like fixedPolicy, a publication that states
  // repository rule overrides (any `repositoryRules` key, including
  // `entries: []`) or that replaces an active profile carrying overrides
  // (omitting the field restores the organization rules) activates itself.
  // Overrides, and their removal, must take effect, and the alternatives
  // cannot deliver that: PATCH activation refuses a v1 profile while the
  // active profile is an observed v2 (legacy_v1_config_only_required), and
  // onboarding derives the next v2 from the ACTIVE baseline. The replaced
  // observed profile's inspection evidence is superseded until the Admin
  // re-runs onboarding, which derives a fresh v2 from this new active
  // baseline and carries the overrides (deriveRepositoryInspectionConfig).
  // Guarded by the repository If-Match checked above. A publication with no
  // key on a repository whose active profile has no overrides behaves as
  // before: activated only for fixedPolicy, a first profile, or the
  // default-branch-mismatch case (which, like every replacing activation,
  // needs repository:manage).
  const shouldAutoActivate = activatesOnPublish ||
    repository.active_profile_id === null || activatesOnDefaultBranchMismatch;

  if (shouldAutoActivate) {
    const activated = await transaction.query<{ version: number }>(
      `update bakery.repositories
          set active_profile_id = $3, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $4
        returning version`,
      [organizationId, repositoryId, id, repository.version],
    );
    const activatedVersion = activated.rows[0]?.version;
    if (activatedVersion === undefined) {
      throw new Error("PROJECTS_REPOSITORY_ACTIVATE_FAILED");
    }
    await recordDomainEvent(transaction, {
      organizationId,
      eventType: "repositories.updated",
      applicationId: repository.application_id,
      repositoryId,
      aggregateId: repositoryId,
      aggregateVersion: activatedVersion,
      traceId: context.traceId,
    });
  }

  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: "repositoryProfiles.create",
    resourceType: "repository_profile",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
    ...(overrides !== undefined &&
        expectedOrganizationRulesRevision !== undefined
      ? {
        details: {
          organizationRulesRevision: expectedOrganizationRulesRevision,
        },
      }
      : {}),
  });
  await recordDomainEvent(transaction, {
    organizationId,
    eventType: "repository.profile_created",
    applicationId: repository.application_id,
    repositoryId,
    aggregateId: id,
    aggregateVersion: 1,
    traceId: context.traceId,
  });

  return toProfile(row);
};
