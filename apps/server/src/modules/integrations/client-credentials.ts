import { Hono, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  IntegrationClientCredentialsImplementedAction as Action,
  integrationClientCredentialsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { encryptInstallationSecret, loadSecretKey } from "../secrets/crypto.ts";
import { installationActor } from "./postgres.ts";
import { PROVIDERS } from "./registry.ts";

/**
 * Installation-level OAuth client credentials for any integration provider whose
 * manifest asks for them (#410): one get and one put, not one pair per provider.
 *
 * ## Why one pair
 *
 * A provider declares what it needs in its manifest (`appRegistration: {kind:
 * "client-credentials", fields}`), and this reads that declaration instead of
 * naming a provider. Adding a provider with the same two fields adds no operation,
 * no route and no column. The shape this store holds is the OAuth pair, a client ID
 * and a client secret; a manifest that asks for anything else is not served here
 * (it is absent, not an error a caller could learn from), because storing a field
 * nobody reads back would be a second, silent schema.
 *
 * ## The secret
 *
 * It is sealed under the installation key as revision 1 of one installation secret,
 * and a replacement is the next revision of the same secret: earlier revisions are
 * kept, the active pointer moves, and the secret's generation advances so anything
 * that cached the old one invalidates. The row is the shared registration table the
 * GitHub App uses; the columns that describe a GitHub App are simply left empty. The
 * client ID is not a secret and is shown back. The secret never leaves: no
 * operation, no audit row and no log carries it, only its revision and the time it
 * was saved.
 *
 * ## Concurrency
 *
 * The first save has nothing to compare, so a concurrent first save loses on the
 * table's one-row-per-provider key and answers a failed precondition. A replacement
 * must send the version it read as `If-Match`, is checked under the row lock, and
 * writes the next version, so two administrators replacing at once cannot both win.
 */

type Credentials = z.output<
  typeof contractSchemas.IntegrationClientCredentials
>;
type CredentialsPut = z.output<
  typeof contractSchemas.IntegrationClientCredentialsPut
>;

type Dependencies = {
  secretsKey: SecretsKeyConfig | undefined;
  publicBaseUrl: string;
};

type Stored = {
  id: string;
  clientId: string;
  version: number;
  secretId: string;
  secretRevision: number;
  savedAt: Date | string;
};

const CLIENT_ID_MAX = 200;
const CLIENT_SECRET_MAX = 4096;
const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Printable characters only: a control character in a pasted credential is a paste error. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The provider this installation can hold credentials for, or an absent resource.
 *
 * Unknown slugs and providers that ask for something other than the OAuth pair
 * answer the same way, so the response never says which providers exist.
 */
function credentialProvider(slug: string | undefined): string {
  const provider = slug === undefined ? undefined : PROVIDERS.get(slug);
  const registration = provider?.manifest.appRegistration ?? null;
  if (provider === undefined || registration === null) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (registration.kind !== "client-credentials") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const byId = new Map(registration.fields.map((field) => [field.id, field]));
  const clientId = byId.get("client_id");
  const clientSecret = byId.get("client_secret");
  if (
    byId.size !== 2 || clientId === undefined || clientSecret === undefined ||
    clientId.secret || !clientSecret.secret
  ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return provider.manifest.slug;
}

export function providerCallbackUrl(
  slug: string,
  publicBaseUrl: string,
): string {
  return new URL(`/v1/integration-auth/${slug}/callback`, publicBaseUrl).href;
}

function projection(
  slug: string,
  stored: Stored | null,
  publicBaseUrl: string,
): Credentials {
  return {
    provider: slug,
    configured: stored !== null,
    clientId: stored?.clientId ?? null,
    clientSecretSavedAt: stored === null
      ? null
      : new Date(stored.savedAt).toISOString(),
    callbackUrl: providerCallbackUrl(slug, publicBaseUrl),
    version: stored?.version ?? 0,
  };
}

export async function readStoredClientCredentials(
  transaction: { query: ActionContextTransaction["query"] },
  slug: string,
  options: { lock?: boolean } = {},
): Promise<Stored | null> {
  const result = await transaction.query<{
    id: string;
    client_id: string;
    version: number;
    secret_id: string;
    revision: number;
    saved_at: Date | string;
  }>(
    `select registration.id, registration.client_id, registration.version,
            secret.id as secret_id, secret.active_version_revision as revision,
            secret_version.created_at as saved_at
       from bakery.integration_app_registrations as registration
       join bakery.secrets as secret
         on secret.id = registration.client_secret_id
        and secret.organization_id is null and secret.application_id is null
       join bakery.secret_versions as secret_version
         on secret_version.id = secret.active_version_id
        and secret_version.secret_id = secret.id
      where registration.provider = $1${
      options.lock ? "\n        for update of registration" : ""
    }`,
    [slug],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    version: row.version,
    secretId: row.secret_id,
    secretRevision: row.revision,
    savedAt: row.saved_at,
  };
}

type ActionContextTransaction = ReturnType<typeof installationActor>["context"][
  "transaction"
];

/** integrationClientCredentials.get */
export async function getClientCredentials(
  context: ActionContext,
  dependencies: Dependencies,
): Promise<Credentials> {
  const { context: value } = installationActor(context);
  const slug = credentialProvider(context.params.provider);
  return projection(
    slug,
    await readStoredClientCredentials(value.transaction, slug),
    dependencies.publicBaseUrl,
  );
}

/**
 * integrationClientCredentials.put: validate, check `If-Match` under the row lock,
 * seal the secret as the next revision, and save the client ID at the next version,
 * all in one transaction with its audit row.
 */
export async function putClientCredentials(
  context: ActionContext,
  input: CredentialsPut,
  dependencies: Dependencies,
): Promise<Credentials> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const slug = credentialProvider(context.params.provider);

  const clientId = input.clientId;
  if (
    clientId.length === 0 || clientId.length > CLIENT_ID_MAX ||
    clientId !== clientId.trim() || hasControlCharacter(clientId)
  ) throw unprocessable(["clientId"], "invalid_client_id");
  const clientSecret = input.clientSecret;
  if (
    clientSecret.length === 0 || clientSecret.length > CLIENT_SECRET_MAX ||
    clientSecret !== clientSecret.trim() || hasControlCharacter(clientSecret)
  ) throw unprocessable(["clientSecret"], "invalid_client_secret");

  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readStoredClientCredentials(transaction, slug, {
    lock: true,
  });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expectedVersion !== undefined) {
    // Nothing is registered, so there is no version to hold the caller to.
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }

  const key = await loadSecretKey(dependencies.secretsKey);
  const keyId = dependencies.secretsKey!.keyId;
  const secretId = stored?.secretId ?? crypto.randomUUID();
  const revision = stored === null ? 1 : stored.secretRevision + 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId },
    clientSecret,
  );
  const versionId = crypto.randomUUID();

  if (stored === null) {
    await transaction.query(
      `insert into bakery.secrets (id, organization_id, application_id, name,
         provider, allowed_principals, allowed_actions)
       values ($1, null, null, $2, $3, '[]'::jsonb, '[]'::jsonb)`,
      [secretId, `${slug} client secret`, slug],
    );
  }
  await transaction.query(
    `insert into bakery.secret_versions (id, organization_id, application_id,
       secret_id, revision, ciphertext, nonce, key_id, created_by)
     values ($1, null, null, $2, $3, $4, $5, $6, $7)`,
    [
      versionId,
      secretId,
      revision,
      cipher.ciphertext,
      cipher.nonce,
      keyId,
      principalId,
    ],
  );
  await transaction.query(
    stored === null
      ? `update bakery.secrets set active_version_id = $2
          where id = $1 and organization_id is null and application_id is null`
      : `update bakery.secrets set active_version_id = $2,
           active_version_revision = $3, generation = generation + 1,
           invalidation_generation = invalidation_generation + 1,
           version = version + 1, updated_at = now()
          where id = $1 and organization_id is null and application_id is null`,
    stored === null ? [secretId, versionId] : [secretId, versionId, revision],
  );

  let registrationId: string;
  if (stored === null) {
    registrationId = crypto.randomUUID();
    try {
      await transaction.query(
        `insert into bakery.integration_app_registrations (
           id, provider, name, client_id, client_secret_id, status, registered_by
         ) values ($1, $2, $3, $4, $5, 'registered', $6)`,
        [registrationId, slug, slug, clientId, secretId, principalId],
      );
    } catch (error) {
      // A concurrent first save won the one-row-per-provider key.
      if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      throw error;
    }
  } else {
    registrationId = stored.id;
    const updated = await transaction.query(
      `update bakery.integration_app_registrations
          set client_id = $3, updated_at = now(), version = version + 1
        where provider = $1 and version = $2`,
      [slug, stored.version, clientId],
    );
    if (updated.rowCount !== 1) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  }

  const saved = await readStoredClientCredentials(transaction, slug);
  // The provider, the replaced flag and revision numbers only: never the client
  // secret, its ciphertext, the key id or the secret record id.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.IntegrationClientCredentialsPut,
    resourceType: "integration_client_credentials",
    resourceId: registrationId,
    details: {
      provider: slug,
      replaced: stored !== null,
      secretRevision: saved?.secretRevision ?? null,
      version: saved?.version ?? null,
    },
  });
  return projection(slug, saved, dependencies.publicBaseUrl);
}

export function createClientCredentialsActionRegistry(
  database: PgDatabase,
  dependencies: Dependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.IntegrationClientCredentialsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-client-credentials/:provider",
    input: contractSchemas.IntegrationProviderPath,
    output: contractSchemas.IntegrationClientCredentials,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context) => getClientCredentials(context, dependencies),
  }).register({
    name: Action.IntegrationClientCredentialsPut,
    method: HttpMethod.Put,
    path: "/v1/integration-client-credentials/:provider",
    input: contractSchemas.IntegrationClientCredentialsPut,
    output: contractSchemas.IntegrationClientCredentials,
    // Idempotency-Key is required; If-Match is parsed when sent and the handler
    // requires it once credentials exist.
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      putClientCredentials(context, input, dependencies),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    integrationClientCredentialsImplementedActions,
  );
  return registry;
}

export function createClientCredentialsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secretsKey: SecretsKeyConfig | undefined;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/integration-client-credentials/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createClientCredentialsActionRegistry(options.database, {
        secretsKey: options.secretsKey,
        publicBaseUrl: options.publicBaseUrl,
      }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
