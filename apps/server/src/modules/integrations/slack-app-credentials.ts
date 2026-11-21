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
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { encryptInstallationSecret } from "../secrets/crypto.ts";

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

/** What the settings screen shows about the app, with no secret in sight. */
export type SlackAppSettings = Readonly<{
  appId: string;
  clientId: string;
  /** When each secret was written. A saved secret is only its date, as Linear's is. */
  signingSecretSavedAt: string;
  clientSecretSavedAt: string;
  /** The row version a save must quote, so a second editor cannot overwrite blind. */
  version: number;
  detailsCheckedAt: string | null;
  detailsCheckResult: SlackCheckResult | null;
  lastRequestAt: string | null;
  lastRequestFailedAt: string | null;
}>;

/** What Slack said when the client ID and secret were last checked. */
export type SlackCheckResult =
  | "accepted"
  | "client_id_refused"
  | "client_secret_refused"
  | "unreachable";

/** The four values a save carries; the two secrets may be omitted to keep them. */
export type SlackAppDraft = Readonly<{
  appId: string;
  clientId: string;
  clientSecret?: string;
  signingSecret?: string;
}>;

/**
 * The settings, or null when no app is configured.
 *
 * The two "saved at" times come from the secrets themselves -- the version's
 * creation time -- rather than from a duplicated column, so a rotated secret cannot
 * report the date of the one it replaced.
 */
export async function readSlackAppSettings(
  transaction: Pick<PgTransactionClient, "query">,
): Promise<SlackAppSettings | null> {
  const result = await transaction.query<{
    appId: string;
    clientId: string;
    signingSavedAt: Date;
    clientSavedAt: Date;
    version: number;
    detailsCheckedAt: Date | null;
    detailsCheckResult: SlackCheckResult | null;
    lastRequestAt: Date | null;
    lastRequestFailedAt: Date | null;
  }>(
    `select settings.external_app_id as "appId",
            settings.client_id as "clientId",
            signing_version.created_at as "signingSavedAt",
            client_version.created_at as "clientSavedAt",
            settings.version,
            settings.details_checked_at as "detailsCheckedAt",
            settings.details_check_result as "detailsCheckResult",
            settings.last_request_at as "lastRequestAt",
            settings.last_request_failed_at as "lastRequestFailedAt"
       from bakery.slack_app_settings as settings
       join bakery.secrets as signing on signing.id = settings.signing_secret_id
       join bakery.secret_versions as signing_version
         on signing_version.id = signing.active_version_id
       join bakery.secrets as client on client.id = settings.client_secret_id
       join bakery.secret_versions as client_version
         on client_version.id = client.active_version_id
      where settings.id`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    appId: row.appId,
    clientId: row.clientId,
    signingSecretSavedAt: row.signingSavedAt.toISOString(),
    clientSecretSavedAt: row.clientSavedAt.toISOString(),
    version: row.version,
    detailsCheckedAt: row.detailsCheckedAt?.toISOString() ?? null,
    detailsCheckResult: row.detailsCheckResult,
    lastRequestAt: row.lastRequestAt?.toISOString() ?? null,
    lastRequestFailedAt: row.lastRequestFailedAt?.toISOString() ?? null,
  };
}

/**
 * Writes one installation-owned secret's next revision and points the secret at it.
 *
 * Rotation is an insert plus a pointer move: the old ciphertext stays readable for
 * anything that already opened it, and the settings row never names a revision that
 * does not exist.
 */
async function writeInstallationSecret(
  transaction: PgTransactionClient,
  input: {
    readonly secretId: string | null;
    readonly name: string;
    readonly value: string;
    readonly principalId: string;
    readonly key: CryptoKey;
    readonly keyId: string;
  },
): Promise<string> {
  const secretId = input.secretId ?? crypto.randomUUID();
  const previous = input.secretId === null ? 0 : (await transaction.query<
    { revision: number }
  >(
    `select active_version_revision as revision from bakery.secrets
      where id = $1`,
    [secretId],
  )).rows[0]?.revision ?? 0;
  const revision = previous + 1;
  const cipher = await encryptInstallationSecret(
    input.key,
    { secretId, revision, keyId: input.keyId },
    input.value,
  );
  if (input.secretId === null) {
    await transaction.query(
      `insert into bakery.secrets
         (id, name, provider, active_version_revision, created_at, updated_at)
       values ($1, $2, $3, 1, now(), now())`,
      [secretId, input.name, SLACK_PROVIDER],
    );
  }
  const versionId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.secret_versions
       (id, secret_id, revision, ciphertext, nonce, key_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      versionId,
      secretId,
      revision,
      cipher.ciphertext,
      cipher.nonce,
      input.keyId,
      input.principalId,
    ],
  );
  await transaction.query(
    `update bakery.secrets
        set active_version_id = $2, active_version_revision = $3,
            generation = generation + 1,
            invalidation_generation = invalidation_generation + 1,
            version = version + 1, updated_at = now()
      where id = $1`,
    [secretId, versionId, revision],
  );
  return secretId;
}

/**
 * Saves the app details, keeping a secret that was omitted.
 *
 * "Replace details" sends only what changed, so an omitted secret is not a
 * cleared one: the stored revision stays active and its saved date does not move.
 * The version check is the same one the Linear pair uses -- a second editor's save
 * is refused rather than silently overwriting the first -- and the audit row names
 * which secrets were replaced and nothing about their values.
 */
export async function saveSlackAppSettings(
  transaction: PgTransactionClient,
  input: SlackAppDraft & {
    readonly principalId: string;
    /** The row version the caller saw; omitted only for a first save. */
    readonly expectedVersion?: number;
    readonly key: CryptoKey;
    readonly keyId: string;
    readonly operation: string;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<SlackAppSettings> {
  const existing = await transaction.query<{
    version: number;
    signingSecretId: string;
    clientSecretId: string;
  }>(
    `select version, signing_secret_id as "signingSecretId",
            client_secret_id as "clientSecretId"
       from bakery.slack_app_settings where id = true for update`,
  );
  const stored = existing.rows[0] ?? null;
  if (stored === null && input.expectedVersion !== undefined) {
    // Nothing is registered, so there is no version to hold the caller to.
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (stored !== null) {
    if (input.expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (input.expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  }

  const signingSecretId = input.signingSecret === undefined
    ? stored?.signingSecretId
    : await writeInstallationSecret(transaction, {
      secretId: stored?.signingSecretId ?? null,
      name: "Slack signing secret",
      value: input.signingSecret,
      principalId: input.principalId,
      key: input.key,
      keyId: input.keyId,
    });
  const clientSecretId = input.clientSecret === undefined
    ? stored?.clientSecretId
    : await writeInstallationSecret(transaction, {
      secretId: stored?.clientSecretId ?? null,
      name: "Slack client secret",
      value: input.clientSecret,
      principalId: input.principalId,
      key: input.key,
      keyId: input.keyId,
    });
  // A first save must carry both: there is nothing to keep.
  if (signingSecretId === undefined || clientSecretId === undefined) {
    throw unprocessable(["clientSecret", "signingSecret"], "secret_required");
  }

  if (stored === null) {
    await transaction.query(
      `insert into bakery.slack_app_settings
         (external_app_id, client_id, signing_secret_id, client_secret_id)
       values ($1, $2, $3, $4)`,
      [input.appId, input.clientId, signingSecretId, clientSecretId],
    );
  } else {
    await transaction.query(
      `update bakery.slack_app_settings
          set external_app_id = $2, client_id = $3, signing_secret_id = $4,
              client_secret_id = $5, updated_at = now(), version = version + 1,
              -- A replaced secret makes the previous check meaningless.
              details_checked_at = case when $6::boolean then null
                else details_checked_at end,
              details_check_result = case when $6::boolean then null
                else details_check_result end
        where id = true and version = $1`,
      [
        stored.version,
        input.appId,
        input.clientId,
        signingSecretId,
        clientSecretId,
        input.signingSecret !== undefined || input.clientSecret !== undefined,
      ],
    );
  }

  await appendAudit(transaction, {
    organizationId: null,
    principalId: input.principalId,
    operation: input.operation,
    resourceType: "slack_app_settings",
    resourceId: input.appId,
    details: {
      replaced: stored !== null,
      clientSecretReplaced: input.clientSecret !== undefined,
      signingSecretReplaced: input.signingSecret !== undefined,
    },
    requestId: input.requestId,
    traceId: input.traceId,
  });
  const saved = await readSlackAppSettings(transaction);
  if (saved === null) {
    throw new Error("slack settings disappeared while saving");
  }
  return saved;
}

/**
 * Removes the app details, and nothing else.
 *
 * Identity links and organization connections are kept: the design's dialog promises
 * they work again when details are entered again, and deleting them would silently
 * unlink people over a credential rotation. The secrets go, because the app they
 * belonged to no longer exists here, and with them the only two rows that ever
 * named them.
 */
export async function removeSlackAppSettings(
  transaction: PgTransactionClient,
  input: {
    readonly principalId: string;
    readonly operation: string;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<void> {
  const removed = await transaction.query<{
    appId: string;
    signingSecretId: string;
    clientSecretId: string;
  }>(
    `delete from bakery.slack_app_settings
      returning external_app_id as "appId",
                signing_secret_id as "signingSecretId",
                client_secret_id as "clientSecretId"`,
  );
  const row = removed.rows[0];
  if (row === undefined) return;
  // The secrets go with the row: nothing outside a saved app can address them,
  // so leaving them behind would be ciphertext with no reader and one more copy
  // of a credential to have to explain. `0303` grants the delete that needs.
  const secretIds = [row.signingSecretId, row.clientSecretId];
  // The active version is named by the secret row, so it is cleared first.
  await transaction.query(
    `update bakery.secrets set active_version_id = null
      where id = any($1::uuid[])`,
    [secretIds],
  );
  await transaction.query(
    `delete from bakery.secret_versions where secret_id = any($1::uuid[])`,
    [secretIds],
  );
  await transaction.query(
    `delete from bakery.secrets where id = any($1::uuid[])`,
    [secretIds],
  );
  await appendAudit(transaction, {
    organizationId: null,
    principalId: input.principalId,
    operation: input.operation,
    resourceType: "slack_app_settings",
    resourceId: row.appId,
    details: {},
    requestId: input.requestId,
    traceId: input.traceId,
  });
}

/** Records that a check ran and what Slack answered, for the screen's first row. */
export async function recordSlackCheck(
  transaction: Pick<PgTransactionClient, "query">,
  result: SlackCheckResult,
  audit: {
    readonly principalId: string;
    readonly operation: string;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<void> {
  await transaction.query(
    `update bakery.slack_app_settings
        set details_checked_at = now(), details_check_result = $1
      where id = true`,
    [result],
  );
  // A check is a command, like a save: it spends a request and changes what the
  // screen reports, so the ledger names who asked and what Slack said.
  await appendAudit(transaction, {
    organizationId: null,
    principalId: audit.principalId,
    operation: audit.operation,
    resourceType: "slack_app_settings",
    resourceId: "slack-app",
    details: { result },
    requestId: audit.requestId,
    traceId: audit.traceId,
  });
}

/**
 * Records how a real request from Slack went, for the screen's second row.
 *
 * This is the only way the signing secret is ever "tested": Slack signs with it, so
 * a request that verified proves it and one that did not proves it wrong. Both times
 * are kept, so a screen can say "Last accepted …" and still warn that a later one
 * failed.
 */
export async function recordSlackRequest(
  transaction: Pick<PgTransactionClient, "query">,
  outcome: "accepted" | "refused",
): Promise<void> {
  await transaction.query(
    outcome === "accepted"
      ? `update bakery.slack_app_settings set last_request_at = now()
          where id = true`
      : `update bakery.slack_app_settings set last_request_failed_at = now()
          where id = true`,
  );
}
