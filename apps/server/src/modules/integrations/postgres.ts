import { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import type { SecretsKeyConfig } from "@bakery/config";
import type {
  AuthorizedActionContext,
  InstallationActor,
} from "../auth/application/authority.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { loadSecretKey, SecretCipherSchema } from "../secrets/crypto.ts";
import {
  buildGitHubAppManifest,
  GitHubAppConversionSchema,
  gitHubAppRegistrationUrl,
} from "./github-app.ts";

type Registration = z.output<typeof contractSchemas.IntegrationAppRegistration>;
type ManifestStart = z.output<
  typeof contractSchemas.IntegrationAppManifestStart
>;
type AuthRedirect = z.output<typeof contractSchemas.AuthRedirect>;

/** The only provider this module registers today. */
export const GITHUB_PROVIDER = "github";
/**
 * Provider id of the bundled native GitHub entry: UUIDv5 of
 * `urn:bakery:integration-provider:github` in the URL namespace. Fixed so
 * integrationConnections.create can name GitHub before the
 * integration_providers registry exists; that registry seeds this id.
 */
export const GITHUB_PROVIDER_ID = "a1fbffc0-eeec-541c-b2a1-93179931917e";
const UNIQUE_VIOLATION = "23505";
const SELECTED_UNIQUE = "integration_resources_selected_unique";

/**
 * Another connection already holds a selected repository of the same
 * installation (migration 0137's partial unique index). Only that index's
 * violation means the repository is taken; anything else stays an error.
 */
export function isSelectionTaken(error: unknown): boolean {
  const value = error as { code?: unknown; constraint?: unknown } | null;
  return value?.code === UNIQUE_VIOLATION &&
    value.constraint === SELECTED_UNIQUE;
}

/** Settings page the manifest callback returns the administrator to. */
export const INTEGRATIONS_SETTINGS_PATH = "/settings/installation/integrations";

/** Coarse callback outcome carried to the settings page; never a provider detail. */
export const RegistrationOutcome = Object.freeze(
  {
    Registered: "registered",
    StateRejected: "state_rejected",
    AlreadyRegistered: "already_registered",
    ConversionFailed: "conversion_failed",
    StorageFailed: "storage_failed",
  } as const,
);
export type RegistrationOutcome =
  (typeof RegistrationOutcome)[keyof typeof RegistrationOutcome];

/** 303 target for an outcome; only the outcome name travels in the URL. */
export function outcomeRedirect(outcome: RegistrationOutcome): AuthRedirect {
  return {
    status: "303",
    location: `${INTEGRATIONS_SETTINGS_PATH}?githubAppRegistration=${outcome}`,
  };
}

export type IntegrationsDependencies = {
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
};

function authorized(context: ActionContext): AuthorizedActionContext {
  const value = context as Partial<AuthorizedActionContext>;
  if (!value.transaction || !value.principal || !value.authority) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return value as AuthorizedActionContext;
}

/** The live installation administrator the authority runner resolved. */
export function installationActor(context: ActionContext): {
  context: AuthorizedActionContext;
  actor: InstallationActor;
} {
  const value = authorized(context);
  const actor = value.authority as Partial<InstallationActor>;
  if (
    actor.installationAdministrator !== true || !actor.subject ||
    actor.subject.principalId !== value.principal.principalId ||
    actor.subject.principalType !== PrincipalType.Human
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return { context: value, actor: actor as InstallationActor };
}

/** The browser session that will have to present the state again. */
export function requireBrowserSession(context: ActionContext): string {
  const sessionId = context.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new StandardError({ code: "SESSION_REQUIRED" });
  }
  return sessionId;
}

const unregistered: Registration = {
  provider: GITHUB_PROVIDER,
  status: "unregistered",
  appId: null,
  slug: null,
  name: null,
  clientId: null,
  ownerLogin: null,
  ownerId: null,
  ownerType: null,
  htmlUrl: null,
  permissions: null,
  events: null,
  clientSecretConfigured: false,
  privateKeyConfigured: false,
  webhookSecretConfigured: false,
  clientSecretRevision: null,
  privateKeyRevision: null,
  webhookSecretRevision: null,
  registeredByPrincipalId: null,
  registeredAt: null,
  version: 0,
};

// Explicit projection: secret ids, ciphertext, nonces and key ids are never selected.
const projection = `select registration.external_app_id::text as "appId",
  registration.slug, registration.name, registration.client_id as "clientId",
  registration.owner_login as "ownerLogin",
  registration.owner_id::text as "ownerId", registration.owner_type as "ownerType",
  registration.html_url as "htmlUrl", registration.permissions,
  registration.events,
  exists (select 1 from bakery.secrets s where s.id = registration.client_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "clientSecretConfigured",
  exists (select 1 from bakery.secrets s where s.id = registration.private_key_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "privateKeyConfigured",
  exists (select 1 from bakery.secrets s where s.id = registration.webhook_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "webhookSecretConfigured",
  (select s.active_version_revision from bakery.secrets s where s.id = registration.client_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "clientSecretRevision",
  (select s.active_version_revision from bakery.secrets s where s.id = registration.private_key_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "privateKeyRevision",
  (select s.active_version_revision from bakery.secrets s where s.id = registration.webhook_secret_id
    and s.organization_id is null and s.active_version_id is not null) as "webhookSecretRevision",
  registration.registered_by as "registeredByPrincipalId",
  to_char(registration.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "registeredAt",
  registration.version
  from bakery.integration_app_registrations as registration
  where registration.provider = $1`;

type RegistrationRow =
  & Omit<Registration, "provider" | "status" | "appId" | "ownerId">
  & {
    appId: string;
    ownerId: string;
  };

export async function readRegistration(
  transaction: PgTransactionClient,
): Promise<Registration> {
  const result = await transaction.query<RegistrationRow>(projection, [
    GITHUB_PROVIDER,
  ]);
  const row = result.rows[0];
  if (!row) return unregistered;
  return contractSchemas.IntegrationAppRegistration.parse({
    ...row,
    provider: GITHUB_PROVIDER,
    status: "registered",
    appId: Number(row.appId),
    ownerId: Number(row.ownerId),
  });
}

/** integrationAppRegistrations.get */
export function getRegistration(context: ActionContext): Promise<Registration> {
  const { context: value } = installationActor(context);
  return readRegistration(value.transaction);
}

async function registrationExists(
  transaction: PgTransactionClient,
): Promise<boolean> {
  const result = await transaction.query(
    "select 1 from bakery.integration_app_registrations where provider = $1",
    [GITHUB_PROVIDER],
  );
  return result.rows.length > 0;
}

/** Unpadded base64url, as GitHub state and RFC 7636 values use. */
export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

/** integrationAppRegistrations.begin */
export async function beginRegistration(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IntegrationAppRegistrationBegin>,
  dependencies: IntegrationsDependencies,
): Promise<ManifestStart> {
  const { context: value, actor } = installationActor(context);
  const sessionId = requireBrowserSession(value);
  // Refuse before GitHub creates an App whose credentials could not be stored.
  await loadSecretKey(dependencies.secretsKey);
  if (await registrationExists(value.transaction)) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "provider_registered" },
    });
  }
  const manifest = buildGitHubAppManifest(dependencies.publicBaseUrl, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.public === undefined ? {} : { public: input.public }),
  });
  const random = crypto.getRandomValues(new Uint8Array(32));
  const state = base64Url(random);
  random.fill(0);
  const attemptId = crypto.randomUUID();
  const inserted = await value.transaction.query<{ expiresAt: string }>(
    `insert into bakery.integration_app_registration_attempts (
       id, provider, state_hash, initiating_principal_id, session_id,
       organization_login, expires_at
     ) values ($1, $2, $3, $4, $5, $6, now() + interval '1 hour')
     returning to_char(expires_at at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"`,
    [
      attemptId,
      GITHUB_PROVIDER,
      await sha256Hex(state),
      actor.subject.principalId,
      sessionId,
      input.organizationLogin ?? null,
    ],
  );
  const expiresAt = inserted.rows[0].expiresAt;
  // The state is a bearer value until consumed: never in the audit trail.
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.IntegrationAppRegistrationsBegin,
    resourceType: "integration_app_registration_attempt",
    resourceId: attemptId,
    details: {
      provider: GITHUB_PROVIDER,
      organizationLogin: input.organizationLogin ?? null,
      expiresAt,
    },
  });
  return {
    provider: GITHUB_PROVIDER,
    registrationUrl: gitHubAppRegistrationUrl(state, input.organizationLogin),
    manifest: JSON.stringify(manifest),
    state,
    expiresAt,
  };
}

export type AttemptClaim =
  | { kind: "claimed"; attemptId: string }
  | { kind: "rejected" }
  /** Claimed, but an App is already stored: convert only to record the orphan. */
  | { kind: "registered"; attemptId: string };

/**
 * Consumes the attempt in one conditional update: the hash, the initiating
 * principal, the browser session and an unexpired lifetime must all match.
 * Runs in its own committed transaction before any GitHub call.
 */
export async function claimAttempt(
  context: ActionContext,
  state: string,
): Promise<AttemptClaim> {
  const { context: value, actor } = installationActor(context);
  const sessionId = requireBrowserSession(value);
  const claimed = await value.transaction.query<{ id: string }>(
    `update bakery.integration_app_registration_attempts
        set consumed_at = now()
      where state_hash = $1 and provider = $2 and consumed_at is null
        and expires_at > now() and initiating_principal_id = $3
        and session_id = $4
      returning id`,
    [
      await sha256Hex(state),
      GITHUB_PROVIDER,
      actor.subject.principalId,
      sessionId,
    ],
  );
  const attemptId = claimed.rows[0]?.id;
  if (!attemptId) return { kind: "rejected" };
  if (await registrationExists(value.transaction)) {
    return { kind: "registered", attemptId };
  }
  return { kind: "claimed", attemptId };
}

/** Records a terminal outcome on a claimed attempt, with the App GitHub created if any. */
export async function recordAttemptOutcome(
  transaction: PgTransactionClient,
  attemptId: string,
  outcome: RegistrationOutcome,
  app?: { id: number; slug: string },
): Promise<void> {
  await transaction.query(
    `update bakery.integration_app_registration_attempts
        set outcome = $2, external_app_id = $3, slug = $4
      where id = $1 and consumed_at is not null`,
    [attemptId, outcome, app?.id ?? null, app?.slug ?? null],
  );
}

const SecretKindSchema = z.enum(["clientSecret", "privateKey", "webhookSecret"])
  .describe(
    "Which GitHub App credential an encrypted installation secret holds.",
  );
type SecretKind = z.infer<typeof SecretKindSchema>;

export const SECRET_NAMES: Readonly<Record<SecretKind, string>> = Object.freeze(
  {
    clientSecret: "GitHub App client secret",
    privateKey: "GitHub App private key",
    webhookSecret: "GitHub App webhook secret",
  },
);

const PreparedSecretSchema = z.object({
  secretId: z.string().uuid().describe(
    "New installation-owned secret id the ciphertext is bound to.",
  ),
  versionId: z.string().uuid().describe(
    "New revision-1 secret version id that will hold the ciphertext.",
  ),
  cipher: SecretCipherSchema.describe(
    "AES-GCM ciphertext and nonce under the installation-scoped binding.",
  ),
}).strict().describe("One encrypted GitHub App credential ready to store.");

/** Request-private result of the claim, conversion and encryption passes. */
export const RegistrationPreparationSchema = z.object({
  attemptId: z.string().uuid().describe(
    "Claimed registration attempt this preparation completes.",
  ),
  keyId: z.string().min(1).describe(
    "Key identity the three ciphertexts were sealed with.",
  ),
  app: GitHubAppConversionSchema.omit({
    client_secret: true,
    webhook_secret: true,
    pem: true,
  }).extend({
    owner: z.object({
      login: z.string().describe("Login of the account that owns the App."),
      id: z.number().int().positive().describe("Numeric id of the App owner."),
      type: z.string().describe("Account type of the App owner."),
    }).strict().describe("Owner identity reduced to login, id and type."),
  }).describe(
    "Converted App identity without any credential; the only App fields stored in clear.",
  ),
  secrets: z.object({
    clientSecret: PreparedSecretSchema.describe(
      "Encrypted OAuth client secret.",
    ),
    privateKey: PreparedSecretSchema.describe("Encrypted App private key."),
    webhookSecret: PreparedSecretSchema.describe("Encrypted webhook secret.")
      .nullable().describe(
        "Encrypted webhook secret, or null when GitHub generated none.",
      ),
  }).strict().describe("The three encrypted App credentials."),
}).strict().describe(
  "Request-local registration preparation; never an input, response, audit or log payload.",
);
export type RegistrationPreparation = z.infer<
  typeof RegistrationPreparationSchema
>;

/**
 * Stores the converted App and its three encrypted credentials, marks the
 * attempt registered and audits it, all in the action's one transaction.
 */
export async function storeRegistration(
  context: ActionContext,
  prepared: RegistrationPreparation,
): Promise<AuthRedirect> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  for (const kind of SecretKindSchema.options) {
    const secret = prepared.secrets[kind];
    if (secret === null) continue;
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, null, null, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [secret.secretId, SECRET_NAMES[kind], GITHUB_PROVIDER],
    );
    await transaction.query(
      `insert into bakery.secret_versions (id, organization_id, application_id,
         secret_id, revision, ciphertext, nonce, key_id, created_by)
       values ($1, null, null, $2, 1, $3, $4, $5, $6)`,
      [
        secret.versionId,
        secret.secretId,
        secret.cipher.ciphertext,
        secret.cipher.nonce,
        prepared.keyId,
        principalId,
      ],
    );
    await transaction.query(
      `update bakery.secrets set active_version_id = $2
        where id = $1 and organization_id is null and application_id is null`,
      [secret.secretId, secret.versionId],
    );
  }
  const registrationId = crypto.randomUUID();
  const app = prepared.app;
  await transaction.query(
    `insert into bakery.integration_app_registrations (
       id, provider, external_app_id, slug, name, client_id, owner_login,
       owner_id, owner_type, html_url, permissions, events, client_secret_id,
       private_key_secret_id, webhook_secret_id, status, registered_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
       $13, $14, $15, 'registered', $16)`,
    [
      registrationId,
      GITHUB_PROVIDER,
      app.id,
      app.slug,
      app.name,
      app.client_id,
      app.owner.login,
      app.owner.id,
      app.owner.type,
      app.html_url,
      JSON.stringify(app.permissions),
      JSON.stringify(app.events),
      prepared.secrets.clientSecret.secretId,
      prepared.secrets.privateKey.secretId,
      prepared.secrets.webhookSecret?.secretId ?? null,
      principalId,
    ],
  );
  await transaction.query(
    `update bakery.integration_app_registration_attempts
        set outcome = $2, external_app_id = $3, slug = $4, registration_id = $5
      where id = $1 and consumed_at is not null`,
    [
      prepared.attemptId,
      RegistrationOutcome.Registered,
      app.id,
      app.slug,
      registrationId,
    ],
  );
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.GitHubManifestCallback,
    resourceType: "integration_app_registration",
    resourceId: registrationId,
    details: {
      provider: GITHUB_PROVIDER,
      appId: app.id,
      slug: app.slug,
      ownerLogin: app.owner.login,
    },
  });
  return outcomeRedirect(RegistrationOutcome.Registered);
}

type RegistrationPut = z.output<
  typeof contractSchemas.IntegrationAppRegistrationPut
>;

/** One stored credential: its secret record and active revision. */
type StoredSecret = { secretId: string; revision: number };

/** The registered App as the put path needs it; never a secret value. */
export type StoredRegistration = {
  version: number;
  appId: number;
  secrets: Record<SecretKind, StoredSecret | null>;
};

/** Reads the registration and its active secret revisions, locking the row when asked. */
export async function readStoredRegistration(
  transaction: PgTransactionClient,
  lock = false,
): Promise<StoredRegistration | null> {
  const result = await transaction.query<{
    version: number;
    appId: string;
    clientSecretId: string;
    clientSecretRevision: number;
    privateKeyId: string;
    privateKeyRevision: number;
    webhookSecretId: string | null;
    webhookSecretRevision: number | null;
  }>(
    `select registration.version, registration.external_app_id::text as "appId",
       registration.client_secret_id as "clientSecretId",
       client_secret.active_version_revision as "clientSecretRevision",
       registration.private_key_secret_id as "privateKeyId",
       private_key.active_version_revision as "privateKeyRevision",
       registration.webhook_secret_id as "webhookSecretId",
       webhook_secret.active_version_revision as "webhookSecretRevision"
     from bakery.integration_app_registrations as registration
     join bakery.secrets as client_secret
       on client_secret.id = registration.client_secret_id
     join bakery.secrets as private_key
       on private_key.id = registration.private_key_secret_id
     left join bakery.secrets as webhook_secret
       on webhook_secret.id = registration.webhook_secret_id
     where registration.provider = $1${
      lock ? " for update of registration" : ""
    }`,
    [GITHUB_PROVIDER],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    version: row.version,
    appId: Number(row.appId),
    secrets: {
      clientSecret: {
        secretId: row.clientSecretId,
        revision: row.clientSecretRevision,
      },
      privateKey: {
        secretId: row.privateKeyId,
        revision: row.privateKeyRevision,
      },
      webhookSecret: row.webhookSecretId === null ||
          row.webhookSecretRevision === null
        ? null
        : {
          secretId: row.webhookSecretId,
          revision: row.webhookSecretRevision,
        },
    },
  };
}

/**
 * Preconditions checked before GitHub is called and again under the row lock:
 * a registration needs the caller's If-Match version and the same App; a new
 * one takes no If-Match and needs a client secret.
 */
export function assertPutPreconditions(
  stored: StoredRegistration | null,
  request: { appId: number; clientSecretSupplied: boolean },
  expectedVersion: number | undefined,
): void {
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    if (stored.appId !== request.appId) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "app_mismatch" },
      });
    }
    return;
  }
  if (expectedVersion !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (!request.clientSecretSupplied) {
    throw new StandardError({
      code: "MALFORMED_REQUEST",
      params: {
        issues: [{
          path: ["clientSecret"],
          code: "required",
          message: "A new registration needs the client secret.",
        }],
      },
    });
  }
}

/** Secret record and revision each supplied credential will be written as. */
export type SecretVersionTarget = StoredSecret & { created: boolean };

/** Next revision of a stored secret, or revision 1 of a new installation secret. */
export function secretVersionTargets(
  stored: StoredRegistration | null,
  input: RegistrationPut,
): Record<SecretKind, SecretVersionTarget | null> {
  const target = (kind: SecretKind, supplied: boolean) => {
    if (!supplied) return null;
    const current = stored?.secrets[kind];
    return current
      ? {
        secretId: current.secretId,
        revision: current.revision + 1,
        created: false,
      }
      : { secretId: crypto.randomUUID(), revision: 1, created: true };
  };
  return {
    clientSecret: target("clientSecret", input.clientSecret !== undefined),
    privateKey: target("privateKey", true),
    webhookSecret: target("webhookSecret", input.webhookSecret !== undefined),
  };
}

const PreparedSecretVersionSchema = z.object({
  secretId: z.string().uuid().describe(
    "Installation-owned secret the new version belongs to; new when created is true.",
  ),
  versionId: z.string().uuid().describe(
    "New secret version id that will hold the ciphertext.",
  ),
  revision: z.number().int().positive().describe(
    "Revision the ciphertext is bound to: 1 for a new secret, else the active revision plus one.",
  ),
  created: z.boolean().describe(
    "True when the secret record itself is new rather than a further revision of a stored one.",
  ),
  cipher: SecretCipherSchema.describe(
    "AES-GCM ciphertext and nonce under the installation-scoped binding.",
  ),
}).strict().describe(
  "One encrypted GitHub App credential version ready to store.",
);

/** Request-private result of the probe, GitHub confirmation and encryption passes. */
export const RegistrationPutPreparationSchema = z.object({
  keyId: z.string().min(1).describe(
    "Key identity the ciphertexts were sealed with.",
  ),
  expectedVersion: z.number().int().positive().nullable().describe(
    "Registration version the caller's If-Match named, or null for a new registration.",
  ),
  app: RegistrationPreparationSchema.shape.app.describe(
    "App identity GitHub reported for the submitted key; the only App fields stored in clear.",
  ),
  secrets: z.object({
    clientSecret: PreparedSecretVersionSchema.nullable().describe(
      "Encrypted client secret, or null to keep the stored version.",
    ),
    privateKey: PreparedSecretVersionSchema.describe(
      "Encrypted private key; always written because every put proves it.",
    ),
    webhookSecret: PreparedSecretVersionSchema.nullable().describe(
      "Encrypted webhook secret, or null to keep the stored one or store none.",
    ),
  }).strict().describe("Encrypted credential versions this put writes."),
}).strict().describe(
  "Request-local put preparation; never an input, response, audit or log payload.",
);
export type RegistrationPutPreparation = z.infer<
  typeof RegistrationPutPreparationSchema
>;

async function writeSecretVersion(
  transaction: PgTransactionClient,
  kind: SecretKind,
  secret: z.infer<typeof PreparedSecretVersionSchema>,
  stored: StoredSecret | null,
  keyId: string,
  principalId: string,
): Promise<void> {
  if (secret.created) {
    if (stored !== null || secret.revision !== 1) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, null, null, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [secret.secretId, SECRET_NAMES[kind], GITHUB_PROVIDER],
    );
  } else if (
    stored === null || stored.secretId !== secret.secretId ||
    stored.revision + 1 !== secret.revision
  ) {
    // Another put rotated this secret after the probe read it.
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    `insert into bakery.secret_versions (id, organization_id, application_id,
       secret_id, revision, ciphertext, nonce, key_id, created_by)
     values ($1, null, null, $2, $3, $4, $5, $6, $7)`,
    [
      secret.versionId,
      secret.secretId,
      secret.revision,
      secret.cipher.ciphertext,
      secret.cipher.nonce,
      keyId,
      principalId,
    ],
  );
  await transaction.query(
    secret.created
      ? `update bakery.secrets set active_version_id = $2
          where id = $1 and organization_id is null and application_id is null`
      : `update bakery.secrets set active_version_id = $2,
           active_version_revision = $3, generation = generation + 1,
           invalidation_generation = invalidation_generation + 1,
           version = version + 1, updated_at = now()
          where id = $1 and organization_id is null and application_id is null`,
    secret.created
      ? [secret.secretId, secret.versionId]
      : [secret.secretId, secret.versionId, secret.revision],
  );
}

/**
 * integrationAppRegistrations.put, after GitHub confirmed the App: stores a
 * new registration, or writes the next revision of each supplied secret and
 * refreshes the App identity. Earlier secret versions stay for audit.
 */
export async function putRegistration(
  context: ActionContext,
  prepared: RegistrationPutPreparation,
): Promise<Registration> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const stored = await readStoredRegistration(transaction, true);
  // The probe saw no registration (it refuses a missing If-Match otherwise),
  // so one stored now was committed by a concurrent first registration.
  if (stored && prepared.expectedVersion === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "provider_registered" },
    });
  }
  assertPutPreconditions(
    stored,
    {
      appId: prepared.app.id,
      clientSecretSupplied: prepared.secrets.clientSecret !== null,
    },
    prepared.expectedVersion ?? undefined,
  );
  for (const kind of SecretKindSchema.options) {
    const secret = prepared.secrets[kind];
    if (secret === null) continue;
    await writeSecretVersion(
      transaction,
      kind,
      secret,
      stored?.secrets[kind] ?? null,
      prepared.keyId,
      principalId,
    );
  }
  const app = prepared.app;
  let registrationId: string;
  if (stored === null) {
    registrationId = crypto.randomUUID();
    await transaction.query(
      `insert into bakery.integration_app_registrations (
         id, provider, external_app_id, slug, name, client_id, owner_login,
         owner_id, owner_type, html_url, permissions, events, client_secret_id,
         private_key_secret_id, webhook_secret_id, status, registered_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
         $12::jsonb, $13, $14, $15, 'registered', $16)`,
      [
        registrationId,
        GITHUB_PROVIDER,
        app.id,
        app.slug,
        app.name,
        app.client_id,
        app.owner.login,
        app.owner.id,
        app.owner.type,
        app.html_url,
        JSON.stringify(app.permissions),
        JSON.stringify(app.events),
        prepared.secrets.clientSecret!.secretId,
        prepared.secrets.privateKey.secretId,
        prepared.secrets.webhookSecret?.secretId ?? null,
        principalId,
      ],
    );
  } else {
    const updated = await transaction.query<{ id: string }>(
      `update bakery.integration_app_registrations
          set slug = $3, name = $4, client_id = $5, owner_login = $6,
            owner_id = $7, owner_type = $8, html_url = $9,
            permissions = $10::jsonb, events = $11::jsonb,
            webhook_secret_id = coalesce($12, webhook_secret_id),
            updated_at = now(), version = version + 1
        where provider = $1 and version = $2
        returning id`,
      [
        GITHUB_PROVIDER,
        stored.version,
        app.slug,
        app.name,
        app.client_id,
        app.owner.login,
        app.owner.id,
        app.owner.type,
        app.html_url,
        JSON.stringify(app.permissions),
        JSON.stringify(app.events),
        prepared.secrets.webhookSecret?.secretId ?? null,
      ],
    );
    if (!updated.rows[0]) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    registrationId = updated.rows[0].id;
  }
  const revision = (kind: SecretKind) =>
    prepared.secrets[kind]?.revision ?? stored?.secrets[kind]?.revision ??
      null;
  // Identity and revision numbers only: no secret value, ciphertext or key id.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.IntegrationAppRegistrationsPut,
    resourceType: "integration_app_registration",
    resourceId: registrationId,
    details: {
      provider: GITHUB_PROVIDER,
      appId: app.id,
      slug: app.slug,
      ownerLogin: app.owner.login,
      replaced: stored !== null,
      rotated: SecretKindSchema.options.filter((kind) =>
        prepared.secrets[kind] !== null
      ),
      clientSecretRevision: revision("clientSecret"),
      privateKeyRevision: revision("privateKey"),
      webhookSecretRevision: revision("webhookSecret"),
    },
  });
  return readRegistration(transaction);
}
