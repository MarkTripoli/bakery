import { z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  decryptInstallationSecret,
  encryptInstallationSecret,
  loadSecretKey,
  type SecretCipher,
  SecretCipherSchema,
} from "../secrets/crypto.ts";
import { type BackupInterval, isBackupInterval } from "./schedule.ts";

/** Both settings are one installation-wide row. */
export const BACKUP_SETTINGS_ID = "installation";
/** Display label and provider of the installation-owned secret holding the pair. */
export const BACKUP_OFFSITE_SECRET_NAME = "Backup off-site S3 credentials";
export const BACKUP_OFFSITE_SECRET_PROVIDER = "s3-backup";

/** Anything with a node-postgres `query`: a pool, a client or a transaction. */
export type SettingsQueryable = Pick<PgTransactionClient, "query">;

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

export type StoredBackupSchedule = {
  readonly enabled: boolean;
  readonly interval: BackupInterval;
  readonly timeOfDayUtc: string;
  readonly daysToKeep: number;
  readonly updatedAt: string;
  readonly version: number;
};

/** What a read answers before the first save: off, with the defaults of the column. */
export const DEFAULT_BACKUP_SCHEDULE = Object.freeze(
  {
    enabled: false,
    interval: "daily",
    timeOfDayUtc: "03:00",
    daysToKeep: 30,
  } as const,
);

/** Reads the schedule row, locking it when asked; null before any save. */
export async function readBackupSchedule(
  query: SettingsQueryable,
  options: { readonly lock?: boolean } = {},
): Promise<StoredBackupSchedule | null> {
  const result = await query.query<{
    enabled: boolean;
    interval: string;
    timeOfDayUtc: string;
    daysToKeep: number;
    updatedAt: string;
    version: number;
  }>(
    `select enabled, interval_kind as "interval",
            time_of_day_utc as "timeOfDayUtc", days_to_keep as "daysToKeep",
            to_char(updated_at at time zone 'UTC', ${TIMESTAMP}) as "updatedAt",
            version
       from bakery.backup_schedule_settings where id = $1${
      options.lock ? " for update" : ""
    }`,
    [BACKUP_SETTINGS_ID],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (!isBackupInterval(row.interval)) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return { ...row, interval: row.interval };
}

export type BackupScheduleWrite = {
  readonly enabled: boolean;
  readonly interval: BackupInterval;
  readonly timeOfDayUtc: string;
  readonly daysToKeep: number;
  readonly principalId: string;
};

/**
 * Inserts the first row or updates the stored one at the next version.
 * Returns false when a concurrent first save or a newer version won.
 */
export async function upsertBackupSchedule(
  transaction: SettingsQueryable,
  stored: StoredBackupSchedule | null,
  write: BackupScheduleWrite,
): Promise<boolean> {
  if (stored === null) {
    const inserted = await transaction.query(
      `insert into bakery.backup_schedule_settings (id, enabled, interval_kind,
         time_of_day_utc, days_to_keep, updated_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing
       returning id`,
      [
        BACKUP_SETTINGS_ID,
        write.enabled,
        write.interval,
        write.timeOfDayUtc,
        write.daysToKeep,
        write.principalId,
      ],
    );
    return inserted.rows.length === 1;
  }
  const updated = await transaction.query(
    `update bakery.backup_schedule_settings
        set enabled = $3, interval_kind = $4, time_of_day_utc = $5,
            days_to_keep = $6, updated_by = $7, updated_at = now(),
            version = version + 1
      where id = $1 and version = $2
      returning id`,
    [
      BACKUP_SETTINGS_ID,
      stored.version,
      write.enabled,
      write.interval,
      write.timeOfDayUtc,
      write.daysToKeep,
      write.principalId,
    ],
  );
  return updated.rows.length === 1;
}

/* ------------------------------------------------------------------ */
/* Off-site destination                                                */
/* ------------------------------------------------------------------ */

/** The credential pair: one encrypted payload, never returned or logged. */
export const BackupS3CredentialsSchema = z.object({
  accessKeyId: z.string().min(1).max(256).describe(
    "Access key id of the account that writes backups to the off-site bucket.",
  ),
  secretAccessKey: z.string().min(1).max(1024).describe(
    "Secret access key of that account; only ever held in memory or as installation-scoped AES-GCM ciphertext.",
  ),
}).strict().describe(
  "Off-site destination credential pair stored as one encrypted installation secret payload; never returned to a user, logged, traced or audited.",
);
export type BackupS3Credentials = z.infer<typeof BackupS3CredentialsSchema>;

export type StoredBackupOffsite = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly secretId: string | null;
  readonly credentialRevision: number | null;
  readonly credentialUpdatedAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
};

// Explicit projection: ciphertext, nonces and key ids are never selected here.
const offsiteProjection = `select settings.endpoint, settings.region,
  settings.bucket, settings.prefix, settings.secret_id as "secretId",
  secret.active_version_revision as "credentialRevision",
  to_char(settings.credential_updated_at at time zone 'UTC', ${TIMESTAMP})
    as "credentialUpdatedAt",
  to_char(settings.updated_at at time zone 'UTC', ${TIMESTAMP}) as "updatedAt",
  settings.version
 from bakery.backup_offsite_settings as settings
 left join bakery.secrets as secret on secret.id = settings.secret_id`;

/** Reads the destination row, locking it when asked; null before any save. */
export async function readBackupOffsite(
  query: SettingsQueryable,
  options: { readonly lock?: boolean } = {},
): Promise<StoredBackupOffsite | null> {
  const result = await query.query<StoredBackupOffsite>(
    `${offsiteProjection} where settings.id = $1${
      options.lock ? " for update of settings" : ""
    }`,
    [BACKUP_SETTINGS_ID],
  );
  return result.rows[0] ?? null;
}

/** The sealed credential pair and the revision it is bound to. */
export type SealedCredentials = {
  readonly secretId: string;
  readonly versionId: string;
  readonly revision: number;
  readonly created: boolean;
  readonly keyId: string;
  readonly cipher: SecretCipher;
};

/** Encrypts the pair under the installation binding of its next revision. */
export async function sealBackupCredentials(
  secretsKey: SecretsKeyConfig | undefined,
  stored: StoredBackupOffsite | null,
  credentials: BackupS3Credentials,
): Promise<SealedCredentials> {
  const key = await loadSecretKey(secretsKey);
  const keyId = secretsKey!.keyId;
  const created = stored?.secretId == null || stored.credentialRevision == null;
  const secretId = created ? crypto.randomUUID() : stored.secretId!;
  const revision = created ? 1 : stored.credentialRevision! + 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId },
    JSON.stringify(BackupS3CredentialsSchema.parse(credentials)),
  );
  return {
    secretId,
    versionId: crypto.randomUUID(),
    revision,
    created,
    keyId,
    cipher,
  };
}

/**
 * Stores a sealed credential version. A new secret gets revision 1; a stored
 * one moves to the next revision and keeps the earlier versions for audit. A
 * concurrent rotation that moved the revision first fails the precondition.
 */
export async function writeBackupSecretVersion(
  transaction: SettingsQueryable,
  sealed: SealedCredentials,
  stored: StoredBackupOffsite | null,
  principalId: string,
): Promise<void> {
  if (sealed.created) {
    if (stored?.secretId != null || sealed.revision !== 1) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, null, null, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [
        sealed.secretId,
        BACKUP_OFFSITE_SECRET_NAME,
        BACKUP_OFFSITE_SECRET_PROVIDER,
      ],
    );
  } else if (
    stored?.secretId !== sealed.secretId ||
    stored.credentialRevision == null ||
    stored.credentialRevision + 1 !== sealed.revision
  ) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    `insert into bakery.secret_versions (id, organization_id, application_id,
       secret_id, revision, ciphertext, nonce, key_id, created_by)
     values ($1, null, null, $2, $3, $4, $5, $6, $7)`,
    [
      sealed.versionId,
      sealed.secretId,
      sealed.revision,
      sealed.cipher.ciphertext,
      sealed.cipher.nonce,
      sealed.keyId,
      principalId,
    ],
  );
  await transaction.query(
    sealed.created
      ? `update bakery.secrets set active_version_id = $2
          where id = $1 and organization_id is null and application_id is null`
      : `update bakery.secrets set active_version_id = $2,
           active_version_revision = $3, generation = generation + 1,
           invalidation_generation = invalidation_generation + 1,
           version = version + 1, updated_at = now()
          where id = $1 and organization_id is null and application_id is null`,
    sealed.created
      ? [sealed.secretId, sealed.versionId]
      : [sealed.secretId, sealed.versionId, sealed.revision],
  );
}

/** Non-secret fields a save writes. */
export type BackupOffsiteWrite = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly secretId: string | null;
  /** True when this save replaced the credential pair. */
  readonly credentialsReplaced: boolean;
  readonly principalId: string;
};

/**
 * Inserts the first destination row or updates the stored one, both at the
 * next version. Returns false when a concurrent first save or a newer version
 * won.
 */
export async function upsertBackupOffsite(
  transaction: SettingsQueryable,
  stored: StoredBackupOffsite | null,
  write: BackupOffsiteWrite,
): Promise<boolean> {
  if (stored === null) {
    const inserted = await transaction.query(
      `insert into bakery.backup_offsite_settings (id, endpoint, region,
         bucket, prefix, secret_id, credential_updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, now(), $7)
       on conflict (id) do nothing
       returning id`,
      [
        BACKUP_SETTINGS_ID,
        write.endpoint,
        write.region,
        write.bucket,
        write.prefix,
        write.secretId,
        write.principalId,
      ],
    );
    return inserted.rows.length === 1;
  }
  const updated = await transaction.query(
    `update bakery.backup_offsite_settings
        set endpoint = $3, region = $4, bucket = $5, prefix = $6,
            secret_id = coalesce($7, secret_id),
            credential_updated_at = case when $8::boolean then now()
              else credential_updated_at end,
            updated_by = $9, updated_at = now(), version = version + 1
      where id = $1 and version = $2
      returning id`,
    [
      BACKUP_SETTINGS_ID,
      stored.version,
      write.endpoint,
      write.region,
      write.bucket,
      write.prefix,
      write.secretId,
      write.credentialsReplaced,
      write.principalId,
    ],
  );
  return updated.rows.length === 1;
}

/**
 * Decrypts the active credential pair in memory. The caller must not log,
 * trace, audit or return it except on the runner route. Any failure collapses
 * to one content-free error.
 */
export async function openBackupCredentials(
  query: SettingsQueryable,
  secretsKey: SecretsKeyConfig | undefined,
  settings: Pick<StoredBackupOffsite, "secretId">,
): Promise<BackupS3Credentials> {
  if (settings.secretId === null) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  let bytes: Uint8Array | undefined;
  try {
    const key = await loadSecretKey(secretsKey);
    const result = await query.query<{
      secretId: string;
      revision: number;
      keyId: string;
      ciphertext: Uint8Array;
      nonce: Uint8Array;
    }>(
      `select version.secret_id as "secretId", version.revision,
         version.key_id as "keyId", version.ciphertext, version.nonce
       from bakery.secrets as secret
       join bakery.secret_versions as version
         on version.id = secret.active_version_id
         and version.secret_id = secret.id
       where secret.id = $1 and secret.organization_id is null
         and secret.application_id is null`,
      [settings.secretId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("MISSING");
    bytes = await decryptInstallationSecret(
      key,
      { secretId: row.secretId, revision: row.revision, keyId: row.keyId },
      SecretCipherSchema.parse({
        ciphertext: new Uint8Array(row.ciphertext),
        nonce: new Uint8Array(row.nonce),
      }),
    );
    return BackupS3CredentialsSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch {
    throw new StandardError({ code: "STATE_CONFLICT" });
  } finally {
    bytes?.fill(0);
  }
}
