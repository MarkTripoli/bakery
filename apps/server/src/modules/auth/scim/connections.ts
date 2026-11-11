import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../../platform/database.ts";
import type {
  ScimCreateInput,
  ScimCredentialIssue,
  ScimRotateInput,
} from "./host.ts";
import { mintScimSecret } from "./credentials.ts";

type Queryable = Pick<PgTransactionClient, "query">;

const DAY_MS = 24 * 60 * 60 * 1000;

async function insertCredential(
  transaction: Queryable,
  connectionId: string,
  input: ScimCreateInput,
  now: Date,
): Promise<ScimCredentialIssue> {
  const minted = await mintScimSecret();
  const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.scim_credentials (
      connection_id, organization_id, created_by_principal_id,
      prefix, secret_sha256, expires_at, created_at
    ) values ($1, $2, $3, $4, $5, $6, $7)
    returning id`,
    [
      connectionId,
      input.organizationId,
      input.principalId,
      minted.prefix,
      minted.sha256,
      expiresAt,
      now,
    ],
  );
  return {
    connectionId,
    credentialId: inserted.rows[0].id,
    secret: minted.secret,
    expiresAt,
  };
}

/**
 * Creates the organization's connection and its first credential, or
 * re-activates a revoked connection with a fresh credential. An active
 * connection conflicts: rotation, not creation, replaces its credential.
 */
export async function createScimConnection(
  transaction: Queryable,
  input: ScimCreateInput,
): Promise<ScimCredentialIssue> {
  const now = input.now ?? new Date();
  await transaction.query(
    `select pg_advisory_xact_lock(
      hashtextextended('bakery:scim:' || $1::text, 0)
    )`,
    [input.organizationId],
  );
  const existing = await transaction.query<
    { id: string; revokedAt: Date | null }
  >(
    `select id, revoked_at as "revokedAt"
    from bakery.scim_connections
    where organization_id = $1
    for update`,
    [input.organizationId],
  );
  const row = existing.rows[0];
  if (row && row.revokedAt === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  let connectionId: string;
  if (row) {
    connectionId = row.id;
    await transaction.query(
      `update bakery.scim_connections
      set revoked_at = null, updated_at = $2, version = version + 1
      where id = $1`,
      [connectionId, now],
    );
  } else {
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.scim_connections (
        organization_id, created_by_principal_id, created_at, updated_at
      ) values ($1, $2, $3, $3)
      returning id`,
      [input.organizationId, input.principalId, now],
    );
    connectionId = inserted.rows[0].id;
  }
  return await insertCredential(transaction, connectionId, input, now);
}

/**
 * Issues a replacement credential and retires the earlier ones: at once, or
 * after a grace so the identity provider can switch over. Credentials are never
 * edited, so a rotation cannot overwrite a stored digest.
 */
export async function rotateScimConnection(
  transaction: Queryable,
  input: ScimRotateInput,
): Promise<ScimCredentialIssue> {
  const now = input.now ?? new Date();
  await transaction.query(
    `select pg_advisory_xact_lock(
      hashtextextended('bakery:scim:' || $1::text, 0)
    )`,
    [input.organizationId],
  );
  const existing = await transaction.query<
    { id: string; revokedAt: Date | null }
  >(
    `select id, revoked_at as "revokedAt"
    from bakery.scim_connections
    where organization_id = $1
    for update`,
    [input.organizationId],
  );
  const row = existing.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.revokedAt !== null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  if (input.previousExpireMinutes === 0) {
    await transaction.query(
      `update bakery.scim_credentials
      set revoked_at = $2
      where connection_id = $1 and revoked_at is null`,
      [row.id, now],
    );
  } else {
    const retireAt = new Date(
      now.getTime() + input.previousExpireMinutes * 60_000,
    );
    await transaction.query(
      `update bakery.scim_credentials
      set expires_at = least(expires_at, $2)
      where connection_id = $1 and revoked_at is null`,
      [row.id, retireAt],
    );
  }
  return await insertCredential(transaction, row.id, input, now);
}
