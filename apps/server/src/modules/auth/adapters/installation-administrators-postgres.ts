import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import type { PgTransactionClient } from "../../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../../platform/postgres-errors.ts";
import type { InstallationActor } from "../application/authority.ts";

type AdministratorRow = {
  principalId: string;
  displayName: string;
  grantedByPrincipalId: string;
  bootstrap: boolean;
  revokedAt: Date | null;
  version: number;
  updatedAt: Date;
  cursorCreatedAt: string;
};

const ADMINISTRATOR_COLUMNS = `administrator.principal_id as "principalId",
  principal.display_name as "displayName",
  administrator.granted_by_principal_id as "grantedByPrincipalId",
  coalesce(settings.bootstrap_principal_id = administrator.principal_id, false) as bootstrap,
  administrator.revoked_at as "revokedAt", administrator.version,
  administrator.updated_at as "updatedAt",
  to_char(administrator.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"`;
const ADMINISTRATOR_FROM = `bakery.installation_administrators as administrator
  join bakery.principals as principal on principal.id = administrator.principal_id
  join bakery.installation_settings as settings on settings.id = true`;

function administrator(row: AdministratorRow) {
  return contractSchemas.InstallationAdministrator.parse({
    principalId: row.principalId,
    displayName: row.displayName,
    grantedByPrincipalId: row.grantedByPrincipalId,
    bootstrap: row.bootstrap,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function getAdministrator(
  transaction: PgTransactionClient,
  target: string,
) {
  const result = await transaction.query<AdministratorRow>(
    `select ${ADMINISTRATOR_COLUMNS} from ${ADMINISTRATOR_FROM}
     where administrator.principal_id = $1`,
    [target],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return administrator(result.rows[0]);
}

export async function listInstallationAdministrators(
  transaction: PgTransactionClient,
  actor: InstallationActor,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const binding: CursorBinding = {
    action: AuthImplementedAction.InstallationAdministratorsList,
    principalId: actor.subject.principalId,
    ordering: "createdAt:asc,id:asc",
    filters: "all",
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<AdministratorRow>(
    `select ${ADMINISTRATOR_COLUMNS} from ${ADMINISTRATOR_FROM}
     where $1::timestamptz is null
       or (administrator.created_at, administrator.principal_id) > ($1::timestamptz, $2::uuid)
     order by administrator.created_at, administrator.principal_id limit $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(administrator),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursorCreatedAt,
        id: last.principalId,
      })
      : null,
  };
}

export async function createInstallationAdministrator(
  transaction: PgTransactionClient,
  actor: InstallationActor,
  target: string,
) {
  if (target === actor.subject.principalId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const principal = await transaction.query(
    `select id from bakery.principals
     where id = $1 and principal_type = $2 and disabled_at is null`,
    [target, PrincipalType.Human],
  );
  if (principal.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const grant = await transaction.query(
    "select principal_id from bakery.installation_administrators where principal_id = $1",
    [target],
  );
  if (grant.rows.length !== 0) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const now = new Date();
  try {
    await transaction.query(
      `insert into bakery.installation_administrators (
        principal_id, granted_by_principal_id, created_at, updated_at, version
      ) values ($1, $2, $3, $3, 1)`,
      [target, actor.subject.principalId, now],
    );
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    throw error;
  }
  return await getAdministrator(transaction, target);
}

export async function revokeInstallationAdministrator(
  transaction: PgTransactionClient,
  actor: InstallationActor,
  target: string,
  expectedVersion: number,
) {
  if (target === actor.subject.principalId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const current = await getAdministrator(transaction, target);
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  if (current.revokedAt !== null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const result = await transaction.query(
    `update bakery.installation_administrators
     set revoked_at = $2, updated_at = $2, version = version + 1
     where principal_id = $1 and revoked_at is null and version = $3 returning principal_id`,
    [target, new Date(), expectedVersion],
  );
  if (result.rowCount !== 1) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  return await getAdministrator(transaction, target);
}
