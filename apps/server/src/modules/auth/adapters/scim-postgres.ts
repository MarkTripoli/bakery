import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";

type Queryable = Pick<PgTransactionClient, "query">;

type ConnectionRow = {
  id: string;
  createdAt: Date;
  revokedAt: Date | null;
};

type CredentialRow = {
  id: string;
  prefix: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

/** Path of the SCIM 2.0 service under the public origin. */
export const SCIM_BASE_PATH = "/api/auth/scim/v2";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function credentialStatus(row: CredentialRow, now: Date) {
  if (row.revokedAt) return "revoked" as const;
  return row.expiresAt.getTime() <= now.getTime()
    ? "expired" as const
    : "active" as const;
}

/**
 * The organization's SCIM connection with credential metadata. Secrets and
 * digests are never selected, so no caller can leak them.
 */
export async function readScimConnection(
  transaction: Queryable,
  organizationId: string,
  publicBaseUrl: string | undefined,
  now: Date = new Date(),
) {
  const connection = await transaction.query<ConnectionRow>(
    `select id, created_at as "createdAt", revoked_at as "revokedAt"
    from bakery.scim_connections
    where organization_id = $1`,
    [organizationId],
  );
  const row = connection.rows[0];
  if (!row) {
    return {
      status: "none" as const,
      id: null,
      baseUrl: null,
      createdAt: null,
      credentials: [],
    };
  }
  const credentials = await transaction.query<CredentialRow>(
    `select id, prefix, expires_at as "expiresAt",
      last_used_at as "lastUsedAt", created_at as "createdAt",
      revoked_at as "revokedAt"
    from bakery.scim_credentials
    where connection_id = $1
    order by created_at desc, id desc`,
    [row.id],
  );
  return {
    status: row.revokedAt ? "revoked" as const : "active" as const,
    id: row.id,
    baseUrl: publicBaseUrl
      ? `${publicBaseUrl.replace(/\/+$/, "")}${SCIM_BASE_PATH}`
      : null,
    createdAt: iso(row.createdAt),
    credentials: credentials.rows.map((credential) => ({
      id: credential.id,
      prefix: credential.prefix,
      status: credentialStatus(credential, now),
      expiresAt: credential.expiresAt.toISOString(),
      lastUsedAt: iso(credential.lastUsedAt),
      createdAt: credential.createdAt.toISOString(),
      revokedAt: iso(credential.revokedAt),
    })),
  };
}

/**
 * Revokes the connection and every credential, so the identity provider can no
 * longer authenticate. Allowed with or without a licence: ending provisioning
 * access must never be a paid action. Returns the connection id, or null when
 * the connection was already revoked and nothing changed.
 */
export async function revokeScimConnection(
  transaction: Queryable,
  organizationId: string,
): Promise<string | null> {
  const connection = await transaction.query<
    { id: string; revokedAt: Date | null }
  >(
    `select id, revoked_at as "revokedAt"
    from bakery.scim_connections
    where organization_id = $1
    for update`,
    [organizationId],
  );
  const row = connection.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.revokedAt) return null;
  await transaction.query(
    `update bakery.scim_credentials
    set revoked_at = current_timestamp
    where connection_id = $1 and revoked_at is null`,
    [row.id],
  );
  await transaction.query(
    `update bakery.scim_connections
    set revoked_at = current_timestamp, updated_at = current_timestamp,
      version = version + 1
    where id = $1`,
    [row.id],
  );
  return row.id;
}
