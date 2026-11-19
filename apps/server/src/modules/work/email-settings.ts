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

/**
 * Where an installation's email settings live (issue #458, migration 0244).
 *
 * One row. The SMTP password is one installation-owned secret, sealed with the
 * installation secrets key exactly as the skill storage credentials are, so
 * this row carries only its id and revision. Nothing here returns the password,
 * the ciphertext or the secret's id.
 */

export const EMAIL_SETTINGS_ID = "installation";
export const EMAIL_SECRET_NAME = "Installation email SMTP password";
export const EMAIL_SECRET_PROVIDER = "smtp";

export type EmailSecurity = "starttls" | "tls";
export const EMAIL_SECURITIES: readonly EmailSecurity[] = ["starttls", "tls"];

export type EmailTestOutcome =
  | "delivered"
  | "not_configured"
  | "unreachable"
  | "auth_refused"
  | "from_refused"
  | "tls_failed"
  | "timeout"
  | "server_error";

export type StoredEmailSettings = Readonly<{
  host: string;
  port: number;
  security: EmailSecurity;
  username: string | null;
  fromAddress: string;
  fromName: string;
  secretId: string | null;
  credentialRevision: number | null;
  credentialUpdatedAt: string | null;
  lastTestOutcome: EmailTestOutcome | null;
  lastTestAt: string | null;
  lastTestAddress: string | null;
  version: number;
}>;

type Queryable = Pick<PgTransactionClient, "query">;

const COLUMNS = `host, port, security, username,
  from_address as "fromAddress", from_name as "fromName",
  secret_id as "secretId", credential_revision as "credentialRevision",
  to_char(credential_updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "credentialUpdatedAt",
  last_test_outcome as "lastTestOutcome",
  to_char(last_test_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastTestAt",
  last_test_address as "lastTestAddress", version`;

export async function readEmailSettings(
  query: Queryable,
  options: { readonly lock?: boolean } = {},
): Promise<StoredEmailSettings | null> {
  const found = await query.query<StoredEmailSettings>(
    `select ${COLUMNS} from bakery.installation_email_settings
      where id = $1${options.lock ? " for update" : ""}`,
    [EMAIL_SETTINGS_ID],
  );
  return found.rows[0] ?? null;
}

/** The page's state word, derived from the last test since the last save. */
export function emailState(
  stored: StoredEmailSettings | null,
): "off" | "not_tested" | "working" | "not_working" {
  if (stored === null) return "off";
  if (stored.lastTestOutcome === null) return "not_tested";
  return stored.lastTestOutcome === "delivered" ? "working" : "not_working";
}

/** The safe projection: no password, ciphertext, key id or secret id. */
export function emailProjection(stored: StoredEmailSettings | null) {
  return {
    state: emailState(stored),
    host: stored?.host ?? null,
    port: stored?.port ?? null,
    security: stored?.security ?? null,
    username: stored?.username ?? null,
    passwordStored: stored?.secretId != null,
    passwordSavedAt: stored?.credentialUpdatedAt ?? null,
    fromAddress: stored?.fromAddress ?? null,
    fromName: stored?.fromName ?? null,
    lastTest: stored === null || stored.lastTestOutcome === null ||
        stored.lastTestAt === null
      ? null
      : {
        outcome: stored.lastTestOutcome,
        testedAt: stored.lastTestAt,
        address: stored.lastTestAddress,
      },
    version: stored?.version ?? 0,
  };
}

export type SealedPassword = Readonly<{
  secretId: string;
  versionId: string;
  revision: number;
  created: boolean;
  keyId: string;
  cipher: SecretCipher;
}>;

/** Encrypts the password under the installation binding of its next revision. */
export async function sealEmailPassword(
  secretsKey: SecretsKeyConfig | undefined,
  stored: StoredEmailSettings | null,
  password: string,
): Promise<SealedPassword> {
  let key: CryptoKey;
  try {
    key = await loadSecretKey(secretsKey);
  } catch {
    // No usable secrets key: the password cannot be stored safely, so nothing
    // is saved. The page never sees why, only that the save is not possible.
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const keyId = secretsKey!.keyId;
  const created = stored?.secretId == null || stored.credentialRevision == null;
  const secretId = created ? crypto.randomUUID() : stored.secretId!;
  const revision = created ? 1 : stored.credentialRevision! + 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId },
    password,
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
 * Stores a sealed version. A new secret gets revision 1; a stored one moves to
 * the next revision and keeps the earlier versions for audit. A concurrent
 * rotation that moved the revision first fails the precondition.
 */
export async function writeEmailSecretVersion(
  transaction: Queryable,
  sealed: SealedPassword,
  stored: StoredEmailSettings | null,
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
      [sealed.secretId, EMAIL_SECRET_NAME, EMAIL_SECRET_PROVIDER],
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

/**
 * Takes a stored password out of use. The application role cannot delete secret
 * rows, so the secret is revoked: it is never decrypted again, and its
 * ciphertext stays only as sealed audit history.
 */
export async function revokeEmailSecret(
  transaction: Queryable,
  secretId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.secrets
        set revoked_at = now(),
            invalidation_generation = invalidation_generation + 1,
            version = version + 1, updated_at = now()
      where id = $1 and organization_id is null and application_id is null
        and revoked_at is null`,
    [secretId],
  );
}

export type EmailSettingsWrite = Readonly<{
  host: string;
  port: number;
  security: EmailSecurity;
  username: string | null;
  fromAddress: string;
  fromName: string;
  /** Set when a new password was sealed in this save. */
  sealed: SealedPassword | null;
  principalId: string;
}>;

/**
 * Inserts the first settings row or replaces the stored one at the next
 * version, clearing the last test: a result for settings that no longer exist
 * would be a lie. Returns false when a concurrent save moved the version.
 */
export async function upsertEmailSettings(
  transaction: Queryable,
  stored: StoredEmailSettings | null,
  write: EmailSettingsWrite,
): Promise<boolean> {
  if (stored === null) {
    const inserted = await transaction.query(
      `insert into bakery.installation_email_settings (
         id, host, port, security, username, from_address, from_name,
         secret_id, credential_revision, credential_updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         case when $8::uuid is null then null else now() end, $10)
       on conflict (id) do nothing returning id`,
      [
        EMAIL_SETTINGS_ID,
        write.host,
        write.port,
        write.security,
        write.username,
        write.fromAddress,
        write.fromName,
        write.sealed?.secretId ?? null,
        write.sealed?.revision ?? null,
        write.principalId,
      ],
    );
    return inserted.rows.length === 1;
  }
  const updated = await transaction.query(
    `update bakery.installation_email_settings
        set host = $3, port = $4, security = $5, username = $6,
            from_address = $7, from_name = $8,
            secret_id = coalesce($9::uuid, secret_id),
            credential_revision = coalesce($10::integer, credential_revision),
            credential_updated_at = case when $9::uuid is null
              then credential_updated_at else now() end,
            last_test_outcome = null, last_test_at = null,
            last_test_address = null,
            version = version + 1, updated_at = now(), updated_by = $11
      where id = $1 and version = $2
      returning id`,
    [
      EMAIL_SETTINGS_ID,
      stored.version,
      write.host,
      write.port,
      write.security,
      write.username,
      write.fromAddress,
      write.fromName,
      write.sealed?.secretId ?? null,
      write.sealed?.revision ?? null,
      write.principalId,
    ],
  );
  return updated.rows.length === 1;
}

/** Records the outcome of a test against the settings that were tested. */
export async function recordEmailTest(
  transaction: Queryable,
  version: number,
  outcome: EmailTestOutcome,
  address: string | null,
  principalId: string,
): Promise<void> {
  // Only the version that was tested: a save that landed while the test was
  // running leaves its own, empty, test status.
  await transaction.query(
    `update bakery.installation_email_settings
        set last_test_outcome = $3, last_test_at = now(),
            last_test_address = $4, updated_by = $5
      where id = $1 and version = $2`,
    [EMAIL_SETTINGS_ID, version, outcome, address, principalId],
  );
}

/**
 * Opens the stored password in memory, for one send. Null when no password is
 * stored. A missing or wrong secrets key, a revoked secret or a version that
 * does not open all answer the same conflict, so the page learns only that
 * email cannot be sent, not why.
 */
export async function openEmailPassword(
  query: Queryable,
  secretsKey: SecretsKeyConfig | undefined,
  stored: StoredEmailSettings,
): Promise<string | null> {
  if (stored.secretId === null) return null;
  try {
    const key = await loadSecretKey(secretsKey);
    const found = await query.query<{
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
         and secret.application_id is null and secret.revoked_at is null`,
      [stored.secretId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error("MISSING");
    const bytes = await decryptInstallationSecret(
      key,
      { secretId: row.secretId, revision: row.revision, keyId: row.keyId },
      SecretCipherSchema.parse({
        ciphertext: new Uint8Array(row.ciphertext),
        nonce: new Uint8Array(row.nonce),
      }),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
}
