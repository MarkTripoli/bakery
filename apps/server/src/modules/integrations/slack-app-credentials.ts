/**
 * Reading the Slack app Bakery signs and speaks as (#415).
 *
 * Two facts shape this read:
 *
 * - **The signing secret is the app's, not a workspace's.** Slack signs every
 *   request with the secret of the app the request is for, so the secret cannot be
 *   found from anything inside the request -- the team id lives in the body, and the
 *   body may only be decoded after the signature checks. It is read from settings,
 *   then the verified request's workspace is matched against the post it names.
 * - **Nothing here returns a plaintext secret to a caller that could log it.** The
 *   reader hands back the stored cipher binding; decrypting is a separate, explicit
 *   step whose result never leaves memory.
 *
 * Absence is not an error: an installation with no Slack app configured answers
 * `null`, and the ingress then behaves as if it does not exist -- 404 and a log line
 * naming the variable a person would set -- rather than accepting requests it cannot
 * verify.
 */
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";

/** The provider name the settings row is stored under, in `bakery.secrets`. */
export const SLACK_PROVIDER = "slack";

/**
 * A stored secret as this module hands it on: the ciphertext and the binding it was
 * written under, never a plaintext value. The shape matches the one the GitHub App
 * reader returns, so `openAppSecret` decrypts either.
 */
export type StoredSecret = Readonly<{
  secretId: string;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}>;

export type SlackAppCredentials = Readonly<{
  /** Slack's app id (`A...`), the value a request's `api_app_id` must carry. */
  appId: string;
  /** The app's OAuth client id: the audience of a signing-in token. */
  clientId: string;
  /** Encrypted HMAC key for `x-slack-signature`; decrypt at the point of use. */
  signingSecret: StoredSecret;
  /** Encrypted OAuth client secret, used by the installation flow only. */
  clientSecret: StoredSecret;
}>;

/**
 * The configured app, or null when none is.
 *
 * The two secrets are joined through their active version exactly as the GitHub App
 * reader does it, so a rotated secret is picked up without a second code path and a
 * missing version cannot produce an empty ciphertext that decrypts to "".
 */
export async function readSlackAppCredentials(
  transaction: Pick<PgTransactionClient, "query">,
): Promise<SlackAppCredentials | null> {
  const result = await transaction.query<{
    appId: string;
    clientId: string;
    signingSecretId: string;
    signingRevision: number;
    signingKeyId: string;
    signingCiphertext: Uint8Array;
    signingNonce: Uint8Array;
    clientSecretId: string;
    clientRevision: number;
    clientKeyId: string;
    clientCiphertext: Uint8Array;
    clientNonce: Uint8Array;
  }>(
    `select settings.external_app_id as "appId",
            settings.client_id as "clientId",
            signing.id as "signingSecretId",
            signing_version.revision as "signingRevision",
            signing_version.key_id as "signingKeyId",
            signing_version.ciphertext as "signingCiphertext",
            signing_version.nonce as "signingNonce",
            client.id as "clientSecretId",
            client_version.revision as "clientRevision",
            client_version.key_id as "clientKeyId",
            client_version.ciphertext as "clientCiphertext",
            client_version.nonce as "clientNonce"
       from bakery.slack_app_settings as settings
       join bakery.secrets as signing on signing.id = settings.signing_secret_id
         and signing.organization_id is null and signing.application_id is null
       join bakery.secret_versions as signing_version
         on signing_version.id = signing.active_version_id
         and signing_version.secret_id = signing.id
       join bakery.secrets as client on client.id = settings.client_secret_id
         and client.organization_id is null and client.application_id is null
       join bakery.secret_versions as client_version
         on client_version.id = client.active_version_id
         and client_version.secret_id = client.id
      where settings.id`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    appId: row.appId,
    clientId: row.clientId,
    signingSecret: {
      secretId: row.signingSecretId,
      revision: row.signingRevision,
      keyId: row.signingKeyId,
      ciphertext: row.signingCiphertext,
      nonce: row.signingNonce,
    },
    clientSecret: {
      secretId: row.clientSecretId,
      revision: row.clientRevision,
      keyId: row.clientKeyId,
      ciphertext: row.clientCiphertext,
      nonce: row.clientNonce,
    },
  };
}

/** The same read, on a pool, for a caller that has no transaction open yet. */
export async function loadSlackAppCredentials(
  database: PgDatabase,
): Promise<SlackAppCredentials | null> {
  return await withPgTransaction(
    database,
    (transaction) => readSlackAppCredentials(transaction),
  );
}
