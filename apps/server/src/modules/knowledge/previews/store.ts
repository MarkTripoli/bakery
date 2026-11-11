import type {
  PgDatabase,
  PgTransactionClient,
} from "../../../platform/database.ts";
import { sha256Hex } from "../../../platform/canonical-json.ts";
import {
  PREVIEW_GRANT_TTL_SECONDS,
  PREVIEW_SESSION_TTL_SECONDS,
  randomPreviewSecret,
} from "./shared.ts";

export type PreviewGrantTarget = {
  readonly organizationId: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly versionId: string;
  readonly principalId: string;
};

export type CreatedPreviewGrant = {
  readonly grantId: string;
  /** The one-use secret. It leaves this module once, in the create response. */
  readonly secret: string;
  readonly expiresAt: string;
};

export async function insertPreviewGrant(
  transaction: PgTransactionClient,
  target: PreviewGrantTarget,
): Promise<CreatedPreviewGrant> {
  const secret = randomPreviewSecret();
  const result = await transaction.query<{ id: string; expires_at: Date }>(
    `insert into bakery.artifact_preview_grants
       (organization_id, task_id, artifact_id, artifact_version_id,
        principal_id, token_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
     returning id, expires_at`,
    [
      target.organizationId,
      target.taskId,
      target.artifactId,
      target.versionId,
      target.principalId,
      await sha256Hex(secret),
      PREVIEW_GRANT_TTL_SECONDS,
    ],
  );
  const row = result.rows[0];
  return {
    grantId: row.id,
    secret,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export type PreviewGrantOwner = {
  readonly principalId: string;
  readonly revoked: boolean;
};

export async function readPreviewGrantOwner(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<PreviewGrantOwner | null> {
  const result = await transaction.query<
    { principal_id: string; revoked_at: Date | null }
  >(
    `select principal_id, revoked_at from bakery.artifact_preview_grants
      where organization_id = $1 and id = $2 for update`,
    [organizationId, grantId],
  );
  const row = result.rows[0];
  return row
    ? { principalId: row.principal_id, revoked: row.revoked_at !== null }
    : null;
}

/** Revokes the grant and every session it opened. Safe to repeat. */
export async function revokePreviewGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.artifact_preview_grants set revoked_at = now()
      where organization_id = $1 and id = $2 and revoked_at is null`,
    [organizationId, grantId],
  );
  await transaction.query(
    `update bakery.artifact_preview_sessions set revoked_at = now()
      where organization_id = $1 and grant_id = $2 and revoked_at is null`,
    [organizationId, grantId],
  );
}

export type ExchangedPreviewSession = {
  readonly sessionId: string;
  readonly secret: string;
};

/**
 * One statement consumes an unexpired, unrevoked, unconsumed grant and opens
 * its session, so a replayed or racing exchange can win at most once.
 */
export async function exchangePreviewGrant(
  database: PgDatabase,
  grantSecret: string,
): Promise<ExchangedPreviewSession | null> {
  const sessionId = crypto.randomUUID();
  const secret = randomPreviewSecret();
  const result = await database.query<{ id: string }>(
    `with consumed as (
       update bakery.artifact_preview_grants
          set consumed_at = now()
        where token_hash = $1
          and consumed_at is null
          and revoked_at is null
          and expires_at > now()
        returning id, organization_id
     )
     insert into bakery.artifact_preview_sessions
       (id, organization_id, grant_id, session_hash, expires_at)
     select $2::uuid, consumed.organization_id, consumed.id, $3,
            now() + make_interval(secs => $4)
       from consumed
     returning id`,
    [
      await sha256Hex(grantSecret),
      sessionId,
      await sha256Hex(secret),
      PREVIEW_SESSION_TTL_SECONDS,
    ],
  );
  return result.rows.length === 1 ? { sessionId, secret } : null;
}

export type PreviewSessionRecord = {
  readonly sessionHash: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly taskId: string;
  readonly artifactId: string;
  readonly versionId: string;
  readonly expired: boolean;
  readonly revoked: boolean;
};

export async function readPreviewSession(
  database: PgDatabase,
  sessionId: string,
): Promise<PreviewSessionRecord | null> {
  const result = await database.query<{
    session_hash: string;
    organization_id: string;
    principal_id: string;
    task_id: string;
    artifact_id: string;
    artifact_version_id: string;
    expired: boolean;
    revoked: boolean;
  }>(
    `select s.session_hash, s.organization_id, g.principal_id, g.task_id,
            g.artifact_id, g.artifact_version_id,
            s.expires_at <= now() as expired,
            (s.revoked_at is not null or g.revoked_at is not null) as revoked
       from bakery.artifact_preview_sessions s
       join bakery.artifact_preview_grants g
         on g.organization_id = s.organization_id and g.id = s.grant_id
      where s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row
    ? {
      sessionHash: row.session_hash,
      organizationId: row.organization_id,
      principalId: row.principal_id,
      taskId: row.task_id,
      artifactId: row.artifact_id,
      versionId: row.artifact_version_id,
      expired: row.expired,
      revoked: row.revoked,
    }
    : null;
}
