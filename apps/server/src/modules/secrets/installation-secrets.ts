import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  decryptInstallationSecret,
  encryptInstallationSecret,
  loadSecretKey,
  type SecretCipher,
  SecretCipherSchema,
} from "./crypto.ts";

/** Anything with a node-postgres `query`: a pool, a client or a transaction. */
export type SecretQueryable = Pick<PgTransactionClient, "query">;

/** A value sealed as the next revision of an installation-owned secret. */
export type SealedInstallationSecret = Readonly<{
  secretId: string;
  versionId: string;
  revision: number;
  created: boolean;
  keyId: string;
  cipher: SecretCipher;
}>;

/**
 * Seals a value as revision 1 of a new installation secret, or as the next
 * revision of the one `current` names. The key must be configured: with none the
 * request cannot store a secret, and says so rather than storing it in the clear.
 */
export async function sealInstallationSecret(
  secretsKey: SecretsKeyConfig | undefined,
  current: Readonly<{ secretId: string; revision: number }> | null,
  plaintext: string,
): Promise<SealedInstallationSecret> {
  let key: CryptoKey;
  try {
    key = await loadSecretKey(secretsKey);
  } catch {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "secrets_key_unavailable" },
    });
  }
  const keyId = secretsKey!.keyId;
  const created = current === null;
  const secretId = created ? crypto.randomUUID() : current.secretId;
  const revision = created ? 1 : current.revision + 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId },
    plaintext,
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

/** Writes a sealed version and makes it the active one. */
export async function writeInstallationSecretVersion(
  transaction: SecretQueryable,
  sealed: SealedInstallationSecret,
  options: Readonly<{ name: string; provider: string; principalId: string }>,
): Promise<void> {
  if (sealed.created) {
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, null, null, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [sealed.secretId, options.name, options.provider],
    );
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
      options.principalId,
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

/** The active revision number of an installation secret, or null when absent. */
export async function readInstallationSecretRevision(
  query: SecretQueryable,
  secretId: string,
): Promise<number | null> {
  const result = await query.query<{ revision: number | null }>(
    `select active_version_revision as revision from bakery.secrets
      where id = $1 and organization_id is null and application_id is null`,
    [secretId],
  );
  return result.rows[0]?.revision ?? null;
}

/**
 * Decrypts the active version in memory. The caller must not log, trace or
 * return it. Any failure collapses to one content-free code.
 */
export async function openInstallationSecret(
  query: SecretQueryable,
  secretsKey: SecretsKeyConfig | undefined,
  secretId: string,
): Promise<string> {
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
      [secretId],
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
    return new TextDecoder().decode(bytes);
  } catch {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "secret_unreadable" },
    });
  } finally {
    bytes?.fill(0);
  }
}
