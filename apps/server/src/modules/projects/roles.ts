import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";

const ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ROLE_LIST_LIMIT = 25;
const MAX_ROLE_LIST_LIMIT = 100;
const ROLE_LIST_ORDERING = "createdAt:asc,id:asc";

export const MAX_REPOSITORY_BINDING_CANDIDATES = 32;

export type RepositoryRoleBinding = {
  id: string;
  organizationId: string;
  applicationId: string;
  role: string;
  alias: string | null;
  repositoryId: string;
  repositorySlug: string | null;
  provenance: string | null;
  archivedAt: string | null;
  version: number;
};

export type RepositoryRoleBindingCreateInput = {
  repositoryId: string;
  role: string;
  alias?: string | null;
  provenance?: string | null;
};

export type RepositoryRoleBindingUpdateInput = {
  repositoryId?: string;
  role?: string;
  alias?: string | null;
  provenance?: string | null;
  archivedAt?: string | null;
};

export type RepositoryRoleBindingListOptions = {
  limit?: number;
  cursor?: string;
};

export type RepositoryRoleBindingPage = {
  items: RepositoryRoleBinding[];
  nextCursor: string | null;
};

type RepositoryRoleBindingRow = {
  id: string;
  organization_id: string;
  application_id: string;
  repository_id: string;
  repository_slug: string | null;
  role: string;
  alias: string | null;
  provenance: string | null;
  archived_at: Date | string | null;
  version: number;
};

function toRepositoryRoleBinding(
  row: RepositoryRoleBindingRow,
): RepositoryRoleBinding {
  return {
    id: row.id,
    organizationId: row.organization_id,
    applicationId: row.application_id,
    role: row.role,
    alias: row.alias,
    repositoryId: row.repository_id,
    repositorySlug: row.repository_slug,
    provenance: row.provenance,
    archivedAt: row.archived_at === null
      ? null
      : row.archived_at instanceof Date
      ? row.archived_at.toISOString()
      : new Date(row.archived_at).toISOString(),
    version: row.version,
  };
}

export function normalizeRoleBindingKey(
  value: unknown,
  path: readonly (string | number)[],
): string {
  if (typeof value !== "string") {
    throw unprocessable(path, "binding_key_invalid");
  }
  const normalized = value.trim().toLowerCase();
  if (!ROLE_KEY_PATTERN.test(normalized)) {
    throw unprocessable(path, "binding_key_invalid");
  }
  return normalized;
}

function normalizeOptionalAlias(
  value: unknown,
  path: readonly (string | number)[],
): string | null {
  return value === undefined || value === null
    ? null
    : normalizeRoleBindingKey(value, path);
}

function normalizeProvenance(
  value: unknown,
  path: readonly (string | number)[],
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    value !== value.trim()
  ) {
    throw unprocessable(path, "provenance_invalid");
  }
  return value;
}

function assertPositiveVersion(
  value: unknown,
  path: readonly (string | number)[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw unprocessable(path, "version_invalid");
  }
  return value;
}

function assertUuid(
  value: unknown,
  path: readonly (string | number)[],
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw unprocessable(path, "uuid_invalid");
  }
  return value;
}

function normalizeListLimit(value: unknown): number {
  const limit = value ?? DEFAULT_ROLE_LIST_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ROLE_LIST_LIMIT
  ) {
    throw unprocessable(["limit"], "limit_invalid");
  }
  return limit;
}

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

async function assertActiveApplication(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
): Promise<void> {
  const result = await transaction.query<{ archived_at: Date | string | null }>(
    `select archived_at
       from bakery.applications
      where organization_id = $1 and id = $2
      for share`,
    [organizationId, applicationId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "application_archived" },
    });
  }
}

async function assertActiveRepository(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  repositoryId: string,
): Promise<void> {
  const result = await transaction.query<{
    id: string;
    archived_at: Date | string | null;
  }>(
    `select id, archived_at
       from bakery.repositories
      where organization_id = $1 and application_id = $2 and id = $3
      for update`,
    [organizationId, applicationId, repositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_archived" },
    });
  }
}

function normalizeCreateInput(
  input: RepositoryRoleBindingCreateInput,
): {
  repositoryId: string;
  role: string;
  alias: string | null;
  provenance: string | null;
} {
  return {
    repositoryId: assertUuid(input.repositoryId, ["repositoryId"]),
    role: normalizeRoleBindingKey(input.role, ["role"]),
    alias: normalizeOptionalAlias(input.alias, ["alias"]),
    provenance: normalizeProvenance(input.provenance, ["provenance"]),
  };
}

export async function createRepositoryRoleBinding(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  input: RepositoryRoleBindingCreateInput,
): Promise<RepositoryRoleBinding> {
  const value = normalizeCreateInput(input);
  await assertActiveApplication(transaction, organizationId, applicationId);
  await assertActiveRepository(
    transaction,
    organizationId,
    applicationId,
    value.repositoryId,
  );
  const inserted = await boundedMutation(() =>
    transaction.query<RepositoryRoleBindingRow>(
      `insert into bakery.repository_role_bindings (
         id, organization_id, application_id, repository_id,
         role, alias, provenance
       ) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, organization_id, application_id, repository_id,
         (select slug from bakery.repositories
           where organization_id = $2 and application_id = $3 and id = $4)
           as repository_slug,
         role, alias, provenance, archived_at, version`,
      [
        crypto.randomUUID(),
        organizationId,
        applicationId,
        value.repositoryId,
        value.role,
        value.alias,
        value.provenance,
      ],
    )
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("PROJECTS_ROLE_BINDING_INSERT_FAILED");
  return toRepositoryRoleBinding(row);
}

export async function updateRepositoryRoleBinding(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  bindingId: string,
  expectedVersion: number,
  input: RepositoryRoleBindingUpdateInput,
): Promise<RepositoryRoleBinding> {
  const normalizedBindingId = assertUuid(bindingId, ["bindingId"]);
  const version = assertPositiveVersion(expectedVersion, ["version"]);
  await assertActiveApplication(transaction, organizationId, applicationId);
  const existingResult = await transaction.query<{
    repository_id: string;
    role: string;
    alias: string | null;
    provenance: string | null;
    archived_at: Date | string | null;
    version: number;
  }>(
    `select b.repository_id, b.role, b.alias, b.provenance,
        b.archived_at, b.version
       from bakery.repository_role_bindings b
       join bakery.repositories r
         on r.organization_id = b.organization_id
        and r.application_id = b.application_id
        and r.id = b.repository_id
      where b.organization_id = $1 and b.application_id = $2 and b.id = $3
      for update of b`,
    [organizationId, applicationId, normalizedBindingId],
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (existing.version !== version) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }

  const repositoryId = input.repositoryId === undefined
    ? existing.repository_id
    : assertUuid(input.repositoryId, ["repositoryId"]);
  const role = input.role === undefined
    ? existing.role
    : normalizeRoleBindingKey(input.role, ["role"]);
  const alias = input.alias === undefined
    ? existing.alias
    : normalizeOptionalAlias(input.alias, ["alias"]);
  const provenance = input.provenance === undefined
    ? existing.provenance
    : normalizeProvenance(input.provenance, ["provenance"]);
  const archivedAt = input.archivedAt === undefined
    ? existing.archived_at
    : input.archivedAt;
  if (input.archivedAt !== null && input.archivedAt !== undefined) {
    if (
      typeof input.archivedAt !== "string" ||
      Number.isNaN(Date.parse(input.archivedAt))
    ) {
      throw unprocessable(["archivedAt"], "timestamp_invalid");
    }
  }

  if (archivedAt === null || repositoryId !== existing.repository_id) {
    await assertActiveRepository(
      transaction,
      organizationId,
      applicationId,
      repositoryId,
    );
  }

  const updated = await boundedMutation(() =>
    transaction.query<RepositoryRoleBindingRow>(
      `update bakery.repository_role_bindings b
          set repository_id = $4,
              role = $5,
              alias = $6,
              provenance = $7,
              archived_at = $8::timestamptz,
              updated_at = now(),
              version = version + 1
        where b.organization_id = $1
          and b.application_id = $2
          and b.id = $3
          and b.version = $9
        returning b.id, b.organization_id, b.application_id, b.repository_id,
          (select slug from bakery.repositories r
            where r.organization_id = b.organization_id
              and r.application_id = b.application_id
              and r.id = b.repository_id) as repository_slug,
          b.role, b.alias, b.provenance, b.archived_at, b.version`,
      [
        organizationId,
        applicationId,
        normalizedBindingId,
        repositoryId,
        role,
        alias,
        provenance,
        archivedAt ?? null,
        version,
      ],
    )
  );
  const row = updated.rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  return toRepositoryRoleBinding(row);
}

export async function listRepositoryRoleBindings(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  secret: string,
  principalId: string,
  options: RepositoryRoleBindingListOptions = {},
): Promise<RepositoryRoleBindingPage> {
  const limit = normalizeListLimit(options.limit);
  const binding: CursorBinding = {
    action: "projects.roles.list",
    principalId,
    organizationId,
    ordering: ROLE_LIST_ORDERING,
    filters: JSON.stringify({ applicationId }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, options.cursor, binding);
  const result = await transaction.query<
    RepositoryRoleBindingRow & { cursor_created_at: string }
  >(
    `select b.id, b.organization_id, b.application_id, b.repository_id,
        r.slug as repository_slug, b.role, b.alias, b.provenance,
        b.archived_at, b.version,
        to_char(
          b.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as cursor_created_at
       from bakery.repository_role_bindings b
       join bakery.applications a
         on a.organization_id = b.organization_id
        and a.id = b.application_id
       and a.archived_at is null
       join bakery.repositories r
         on r.organization_id = b.organization_id
        and r.application_id = b.application_id
        and r.id = b.repository_id
      where b.organization_id = $1
        and b.application_id = $2
        and (
          $3::timestamptz is null or
          (b.created_at, b.id) > ($3::timestamptz, $4::uuid)
        )
      order by b.created_at asc, b.id asc
      limit $5`,
    [
      organizationId,
      applicationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map(toRepositoryRoleBinding),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}
