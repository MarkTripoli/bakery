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
import {
  isSkillStorageBackend,
  type R2Credentials,
  R2CredentialsSchema,
  SKILL_STORAGE_CONFIG_INVALID,
  SkillStorageBackend,
} from "./skill-storage-config.ts";
import { SkillFileStoreError } from "./storage-port.ts";

/** The only row: skill object storage is one installation-wide setting. */
export const SKILL_STORAGE_SETTINGS_ID = "installation";
/** Display label of the installation-owned secret holding the R2 pair. */
export const SKILL_STORAGE_SECRET_NAME = "Skill object storage R2 credentials";
export const SKILL_STORAGE_SECRET_PROVIDER = "r2";

/** Anything with a node-postgres `query`: a pool, a client or a transaction. */
export type SettingsQueryable = Pick<PgTransactionClient, "query">;

export const StoredSkillStorageSettingsSchema = z.object({
  backend: z.enum(["filesystem", "r2"]).describe(
    "Adapter that holds skill bundle objects now.",
  ),
  accountId: z.string().nullable().describe(
    "Saved Cloudflare account id, or null before the first save; validated before use.",
  ),
  bucket: z.string().nullable().describe(
    "Saved bucket name, or null before the first save; validated before use.",
  ),
  endpointOverride: z.string().nullable().describe(
    "Loopback fixture endpoint, or null; only a test environment honours it.",
  ),
  secretId: z.string().uuid().nullable().describe(
    "Installation-owned secret holding the encrypted credential pair, or null before credentials are saved.",
  ),
  credentialRevision: z.number().int().positive().nullable().describe(
    "Active revision of the credential secret, or null when none is stored.",
  ),
  credentialUpdatedAt: z.string().nullable().describe(
    "RFC3339 time the credentials were last replaced, or null.",
  ),
  updatedAt: z.string().describe("RFC3339 time the settings last changed."),
  version: z.number().int().positive().describe(
    "Monotonic settings revision used as If-Match and as the resolver cache key.",
  ),
}).strict().describe(
  "The installation skill storage settings row as stored; carries no credential value.",
);
export type StoredSkillStorageSettings = z.infer<
  typeof StoredSkillStorageSettingsSchema
>;

// Explicit projection: ciphertext, nonces and key ids are never selected here.
const projection = `select settings.backend,
  settings.account_id as "accountId", settings.bucket,
  settings.endpoint_override as "endpointOverride",
  settings.secret_id as "secretId",
  secret.active_version_revision as "credentialRevision",
  to_char(settings.credential_updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "credentialUpdatedAt",
  to_char(settings.updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
  settings.version
 from bakery.skill_storage_settings as settings
 left join bakery.secrets as secret on secret.id = settings.secret_id`;

/** Reads the settings row, locking it when asked; null before any save. */
export async function readSkillStorageSettings(
  query: SettingsQueryable,
  options: { readonly lock?: boolean } = {},
): Promise<StoredSkillStorageSettings | null> {
  const result = await query.query(
    `${projection} where settings.id = $1${
      options.lock ? " for update of settings" : ""
    }`,
    [SKILL_STORAGE_SETTINGS_ID],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const parsed = StoredSkillStorageSettingsSchema.safeParse(row);
  if (!parsed.success || !isSkillStorageBackend(parsed.data.backend)) {
    throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
  }
  return parsed.data;
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
export async function sealSkillStorageCredentials(
  secretsKey: SecretsKeyConfig | undefined,
  stored: StoredSkillStorageSettings | null,
  credentials: R2Credentials,
): Promise<SealedCredentials> {
  const key = await loadSecretKey(secretsKey);
  const keyId = secretsKey!.keyId;
  const created = stored?.secretId == null || stored.credentialRevision == null;
  const secretId = created ? crypto.randomUUID() : stored.secretId!;
  const revision = created ? 1 : stored.credentialRevision! + 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId },
    JSON.stringify(R2CredentialsSchema.parse(credentials)),
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
export async function writeSkillStorageSecretVersion(
  transaction: SettingsQueryable,
  sealed: SealedCredentials,
  stored: StoredSkillStorageSettings | null,
  principalId: string | null,
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
        SKILL_STORAGE_SECRET_NAME,
        SKILL_STORAGE_SECRET_PROVIDER,
      ],
    );
  } else if (
    stored?.secretId !== sealed.secretId ||
    stored.credentialRevision == null ||
    stored.credentialRevision + 1 !== sealed.revision
  ) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (principalId === null) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
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
export type SkillStorageSettingsWrite = {
  readonly accountId: string;
  readonly bucket: string;
  readonly secretId: string | null;
  /** True when this save replaced the credential pair. */
  readonly credentialsReplaced: boolean;
  readonly principalId: string;
};

/**
 * Inserts the first settings row or updates the stored one, both at the next
 * version. The first row takes the column default (filesystem): the application role has
 * no INSERT on backend, and saving never switches.
 * Returns false when a concurrent first save or a newer version won.
 */
export async function upsertSkillStorageSettings(
  transaction: SettingsQueryable,
  stored: StoredSkillStorageSettings | null,
  write: SkillStorageSettingsWrite,
): Promise<boolean> {
  if (stored === null) {
    const inserted = await transaction.query(
      `insert into bakery.skill_storage_settings (id, account_id,
         bucket, secret_id, credential_updated_at, updated_by)
       values ($1, $2, $3, $4, now(), $5)
       on conflict (id) do nothing
       returning id`,
      [
        SKILL_STORAGE_SETTINGS_ID,
        write.accountId,
        write.bucket,
        write.secretId,
        write.principalId,
      ],
    );
    return inserted.rows.length === 1;
  }
  const updated = await transaction.query(
    `update bakery.skill_storage_settings
        set account_id = $3, bucket = $4, secret_id = coalesce($5, secret_id),
          credential_updated_at = case when $6::boolean then now()
            else credential_updated_at end,
          updated_by = $7, updated_at = now(), version = version + 1
      where id = $1 and version = $2
      returning id`,
    [
      SKILL_STORAGE_SETTINGS_ID,
      stored.version,
      write.accountId,
      write.bucket,
      write.secretId,
      write.credentialsReplaced,
      write.principalId,
    ],
  );
  return updated.rows.length === 1;
}

/** Operation name of the audit row the paused switch writes. */
export const SKILL_STORAGE_SWITCH_OPERATION = "skillStorageSettings.switch";

/**
 * Writes the active backend and bumps the version, so every running resolver
 * re-reads on its next operation. The paused switch procedure calls this only
 * after the target inventory verified. The owner connection has no principal,
 * so `updated_by` is cleared (the last administrator no longer owns the row's
 * state) and one audit row names the operator, the backends and the version,
 * in the same statement.
 */
export async function setSkillStorageBackend(
  query: SettingsQueryable,
  expectedVersion: number,
  backend: SkillStorageBackend,
  audit: { readonly previous: SkillStorageBackend; readonly operator: string },
): Promise<void> {
  const updated = await query.query(
    `with updated as (
       update bakery.skill_storage_settings
          set backend = $3, updated_by = null, updated_at = now(),
              version = version + 1
        where id = $1 and version = $2
        returning id, version
     ), audited as (
       insert into bakery.audit_events (organization_id, principal_id,
         operation, resource_type, resource_id, outcome, request_id, trace_id,
         details)
       select null, null, $4, 'skill_storage_settings', updated.id,
         'succeeded', $7, $7,
         jsonb_build_object('from', $5::text, 'backend', $3::text,
           'version', updated.version, 'operator', $6::text,
           'databaseRole', current_user)
         from updated
     )
     select id from updated`,
    [
      SKILL_STORAGE_SETTINGS_ID,
      expectedVersion,
      backend,
      SKILL_STORAGE_SWITCH_OPERATION,
      audit.previous,
      audit.operator,
      crypto.randomUUID(),
    ],
  );
  if (updated.rows.length !== 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
}

/**
 * Decrypts the active credential pair in memory. The caller must not log,
 * trace or return it. Any failure collapses to one fixed, content-free code.
 */
export async function openSkillStorageCredentials(
  query: SettingsQueryable,
  secretsKey: SecretsKeyConfig | undefined,
  settings: Pick<StoredSkillStorageSettings, "secretId">,
): Promise<R2Credentials> {
  if (settings.secretId === null) {
    throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
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
    return R2CredentialsSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  } catch {
    throw new SkillFileStoreError("SKILL_FILE_CREDENTIAL_INVALID");
  } finally {
    bytes?.fill(0);
  }
}
