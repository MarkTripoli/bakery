import {
  type ActionAuthorityRunner,
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type EncodedSuccessResponse,
  HttpMethod,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  IntegrationsImplementedAction,
  integrationsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  createNormalizedCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import {
  createPostgresCommandRunner,
  readCompletedCommandReplay,
} from "../../platform/command-replay.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { encryptInstallationSecret, loadSecretKey } from "../secrets/crypto.ts";
import {
  type GitHubAppClient,
  type GitHubAppConversion,
  GitHubAppPath,
  isGitHubManifestCode,
} from "./github-app.ts";
import {
  importGitHubAppPrivateKey,
  signGitHubAppJwt,
} from "./github-app-key.ts";
import {
  authorizeAuthAttemptRead,
  createAuthAttempt,
  getAuthAttempt,
} from "./auth-attempts.ts";
import {
  bindConnection,
  bindingPreparation,
  createGitHubCallbackRunner,
} from "./callbacks.ts";
import { checkConnection, createConnectionCheckRunner } from "./checks.ts";
import { createDiscovery } from "./discoveries.ts";
import {
  DeliveryIdentitySchema,
  type PreparedDelivery,
  recordDelivery,
} from "./intake-receipts.ts";
import {
  createInstallationListHandler,
  getInstallation,
} from "./installations.ts";
import {
  authorizeEffectRead,
  createConnection,
  createIntegrationListHandlers,
  getConnection,
  getIntegrationEffect,
} from "./connections.ts";
import {
  createResourceUpdateRunner,
  updateConnection,
  updateResource,
} from "./updates.ts";
import {
  assertPutPreconditions,
  type AttemptClaim,
  beginRegistration,
  claimAttempt,
  getRegistration,
  installationActor,
  type IntegrationsDependencies,
  outcomeRedirect,
  putRegistration,
  readStoredRegistration,
  recordAttemptOutcome,
  RegistrationOutcome,
  type RegistrationPreparation,
  RegistrationPreparationSchema,
  type RegistrationPutPreparation,
  RegistrationPutPreparationSchema,
  type SecretVersionTarget,
  secretVersionTargets,
  storeRegistration,
} from "./postgres.ts";
import {
  createInstallationTokenBroker,
  type InstallationTokenBroker,
} from "./token-broker.ts";

export type IntegrationsRegistryDependencies = IntegrationsDependencies & {
  github: GitHubAppClient;
  /** Signs and verifies the list actions' keyset cursors. */
  cursorSecret: string;
  /**
   * The process's installation token broker, shared with background
   * reconciliation; a registry without one creates its own.
   */
  broker?: InstallationTokenBroker;
};

const preparationSlot = Symbol("private GitHub App registration preparation");
const putPreparationSlot = Symbol("private GitHub App credentials preparation");
type PreparedContext = ActionContext & {
  [preparationSlot]?: RegistrationPreparation;
  [putPreparationSlot]?: RegistrationPutPreparation;
};

const intakeSlot = Symbol("verified GitHub webhook delivery");
type IntakeContext = ActionContext & { [intakeSlot]?: PreparedDelivery };

/**
 * Hands a signature-verified delivery to the registered `intake.github`
 * action. The receiving route calls this only after the HMAC over the exact
 * body bytes checked out; the slot is a private symbol, so no request body,
 * header or query can set it.
 */
export function withVerifiedDelivery(
  context: ActionContext,
  prepared: PreparedDelivery,
): ActionContext {
  const { event, ...identity } = prepared;
  return Object.assign({}, context, {
    [intakeSlot]: { ...DeliveryIdentitySchema.parse(identity), event },
  }) as IntakeContext;
}

function verifiedDelivery(context: ActionContext): PreparedDelivery {
  const prepared = (context as IntakeContext)[intakeSlot];
  if (!prepared) throw new StandardError({ code: "AUTH_INVALID" });
  return prepared;
}

/**
 * The action has no organization context and no session, so its only
 * authorization is the receiving route's proof that the signature verified.
 * A request that reaches the registry another way carries no slot and is
 * refused before the handler runs.
 */
function requireVerifiedDelivery(context: ActionContext): void {
  verifiedDelivery(context);
}

/**
 * One structured line per swallowed failure: the stage, the outcome and the
 * error class or problem code only. Never the code, state, provider body or
 * error message, which may carry provider or database detail.
 */
function logFailure(
  context: ActionContext,
  stage: "convert" | "store" | "record_outcome",
  outcome: RegistrationOutcome,
  error: unknown,
) {
  console.warn(JSON.stringify({
    component: "integrations",
    event: "github_app_registration_failed",
    stage,
    outcome,
    errorClass: error instanceof Error ? error.name : typeof error,
    code: error instanceof StandardError ? error.code : null,
    requestId: context.requestId,
    traceId: context.traceId,
  }));
}

const UNIQUE_VIOLATION = "23505";
const PROVIDER_UNIQUE = "integration_app_registrations_provider_unique";

function isProviderRace(error: unknown): boolean {
  const value = error as { code?: unknown; constraint?: unknown } | null;
  return value?.code === UNIQUE_VIOLATION &&
    value.constraint === PROVIDER_UNIQUE;
}

async function prepare(
  attemptId: string,
  conversion: GitHubAppConversion,
  dependencies: IntegrationsRegistryDependencies,
): Promise<RegistrationPreparation> {
  const key = await loadSecretKey(dependencies.secretsKey);
  const keyId = dependencies.secretsKey!.keyId;
  const seal = async (value: string) => {
    const secretId = crypto.randomUUID();
    return {
      secretId,
      versionId: crypto.randomUUID(),
      cipher: await encryptInstallationSecret(
        key,
        { secretId, revision: 1, keyId },
        value,
      ),
    };
  };
  const {
    client_secret: clientSecret,
    webhook_secret: webhookSecret,
    pem,
    ...app
  } = conversion;
  return RegistrationPreparationSchema.parse({
    attemptId,
    keyId,
    app,
    secrets: {
      clientSecret: await seal(clientSecret),
      privateKey: await seal(pem),
      webhookSecret: webhookSecret === null ? null : await seal(webhookSecret),
    },
  });
}

/** GitHub did not confirm the submitted App with the submitted key. */
function appNotConfirmed(): StandardError {
  return unprocessable(["appId"], "app_not_confirmed");
}

/**
 * integrationAppRegistrations.put, following the secrets/preflight.ts rotate
 * precedent so GitHub is called between committed transactions:
 * 1. under the live installation-administrator check, return a completed
 *    Idempotency-Key replay, else parse the key (400 when malformed), check
 *    If-Match and the App id against the stored registration and plan each
 *    secret's next revision;
 * 2. sign an App JWT and call GET /app outside any transaction; GitHub must
 *    report the submitted App id and client id;
 * 3. encrypt, then store through `next`, which rechecks under the row lock.
 */
async function runPut(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: IntegrationsRegistryDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.IntegrationAppRegistrationPut.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const probe = await authority.run(
    action,
    context,
    parsed,
    async (authorized) => {
      const { context: value } = installationActor(authorized);
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) {
        return { replay: validateEncodedSuccessResponse(action, replay) };
      }
      // A malformed key is refused before any precondition or GitHub call.
      const signingKey = await importGitHubAppPrivateKey(parsed.privateKey);
      // Refuse before GitHub is called when the credentials cannot be stored.
      await loadSecretKey(dependencies.secretsKey);
      const stored = await readStoredRegistration(value.transaction);
      assertPutPreconditions(
        stored,
        {
          appId: parsed.appId,
          clientSecretSupplied: parsed.clientSecret !== undefined,
        },
        metadata.expectedVersion,
      );
      return { signingKey, targets: secretVersionTargets(stored, parsed) };
    },
  ) as
    | { replay: EncodedSuccessResponse }
    | {
      signingKey: CryptoKey;
      targets: ReturnType<typeof secretVersionTargets>;
    };
  if ("replay" in probe) return probe.replay;
  context.signal.throwIfAborted();
  const lookup = await dependencies.github.getApp(
    await signGitHubAppJwt(probe.signingKey, parsed.appId),
    context.signal,
  );
  if (
    lookup.kind === "rejected" || lookup.app.id !== parsed.appId ||
    lookup.app.client_id !== parsed.clientId
  ) throw appNotConfirmed();
  const key = await loadSecretKey(dependencies.secretsKey);
  const keyId = dependencies.secretsKey!.keyId;
  const seal = async (
    target: SecretVersionTarget | null,
    value: string | undefined,
  ) =>
    target === null || value === undefined ? null : {
      secretId: target.secretId,
      versionId: crypto.randomUUID(),
      revision: target.revision,
      created: target.created,
      cipher: await encryptInstallationSecret(
        key,
        { secretId: target.secretId, revision: target.revision, keyId },
        value,
      ),
    };
  const prepared = RegistrationPutPreparationSchema.parse({
    keyId,
    expectedVersion: metadata.expectedVersion ?? null,
    app: lookup.app,
    secrets: {
      clientSecret: await seal(
        probe.targets.clientSecret,
        parsed.clientSecret,
      ),
      privateKey: await seal(probe.targets.privateKey, parsed.privateKey),
      webhookSecret: await seal(
        probe.targets.webhookSecret,
        parsed.webhookSecret,
      ),
    },
  });
  try {
    return await authority.run(
      action,
      context,
      parsed,
      (authorized) =>
        next(
          Object.assign(authorized, {
            [putPreparationSlot]: prepared,
          }) as PreparedContext,
        ),
    );
  } catch (error) {
    // A concurrent put created the registration between the probe and the store.
    if (isProviderRace(error)) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "provider_registered" },
      });
    }
    throw error;
  }
}

/**
 * Wraps the authority runner for the manifest callback so GitHub is called
 * between committed transactions (secrets/preflight.ts precedent):
 * 1. claim the attempt in its own transaction, under the live
 *    installation-administrator check; a refused state makes no GitHub call;
 * 2. convert the one-time code and encrypt the credentials outside any
 *    transaction;
 * 3. store everything in the action's transaction through `next`.
 * Other actions pass straight through.
 */
export function createIntegrationsAuthorityRunner(
  authority: ActionAuthorityRunner,
  database: PgDatabase,
  dependencies: IntegrationsRegistryDependencies,
  broker: InstallationTokenBroker = dependencies.broker ??
    createInstallationTokenBroker(dependencies),
): ActionAuthorityRunner {
  /** Records the outcome; a failure here is logged, never masks the redirect. */
  const settle = async (
    context: ActionContext,
    attemptId: string,
    outcome: RegistrationOutcome,
    app?: { id: number; slug: string },
  ) => {
    try {
      await withPgTransaction(
        database,
        (transaction) =>
          recordAttemptOutcome(transaction, attemptId, outcome, app),
      );
    } catch (error) {
      logFailure(context, "record_outcome", outcome, error);
    }
  };
  const callbacks = createGitHubCallbackRunner(database, dependencies);
  const resourceUpdate = createResourceUpdateRunner(authority, dependencies);
  const check = createConnectionCheckRunner(authority, dependencies, broker);
  /**
   * A connection or resource edit can change the selection, the status or
   * both. Once the caller is authorized and the edit's transaction starts,
   * and until it settled (committed or rolled back), the broker neither
   * mints nor reuses a token for the connection's earlier state.
   */
  const invalidating = async (
    context: ActionContext,
    next: (context: ActionContext) => Promise<unknown>,
    run: (
      next: (context: ActionContext) => Promise<unknown>,
    ) => Promise<unknown>,
  ) => {
    const id = contractSchemas.IdPath.safeParse({ id: context.params.id });
    if (!id.success) return await run(next);
    let end: (() => void) | undefined;
    try {
      return await run((authorized) => {
        end ??= broker.beginEdit(id.data.id);
        return next(authorized);
      });
    } finally {
      end?.();
    }
  };
  return {
    async run(action, context, input, next) {
      if (
        action.name ===
          IntegrationsImplementedAction.IntegrationConnectionsCheck
      ) {
        return await check(action, context, input, next);
      }
      if (
        action.name === IntegrationsImplementedAction.IntegrationResourcesUpdate
      ) {
        return await invalidating(
          context,
          next,
          (edit) => resourceUpdate(action, context, input, edit),
        );
      }
      if (
        action.name ===
          IntegrationsImplementedAction.IntegrationConnectionsUpdate
      ) {
        return await invalidating(
          context,
          next,
          (edit) => authority.run(action, context, input, edit),
        );
      }
      // Bound-attempt callbacks derive their organization from the attempt,
      // which the shared runner refuses; the callback runner owns them.
      if (action.name === IntegrationsImplementedAction.GitHubSetup) {
        return await callbacks.setup(action, context, input, next);
      }
      if (action.name === IntegrationsImplementedAction.GitHubCallback) {
        return await callbacks.callback(action, context, input, next);
      }
      if (
        action.name ===
          IntegrationsImplementedAction.IntegrationAppRegistrationsPut
      ) {
        return await runPut(
          authority,
          action,
          context,
          input,
          next,
          dependencies,
        );
      }
      if (
        action.name !== IntegrationsImplementedAction.GitHubManifestCallback
      ) {
        return await authority.run(action, context, input, next);
      }
      const parsed = contractSchemas.GitHubManifestCallback.parse(input);
      if (!isGitHubManifestCode(parsed.code)) {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      const claim = await authority.run(
        action,
        context,
        parsed,
        (authorized) => claimAttempt(authorized, parsed.state),
      ) as AttemptClaim;
      if (claim.kind === "rejected") {
        return outcomeRedirect(RegistrationOutcome.StateRejected);
      }
      // Once the state is consumed the one-time code is the only way to learn
      // which App GitHub created, so a browser disconnect must not cancel the
      // exchange or the store; the client keeps its own timeout.
      const detached: ActionContext = {
        ...context,
        signal: new AbortController().signal,
      };
      let conversion: GitHubAppConversion;
      try {
        conversion = await dependencies.github.convertManifest(
          parsed.code,
          detached.signal,
        );
      } catch (error) {
        logFailure(
          context,
          "convert",
          RegistrationOutcome.ConversionFailed,
          error,
        );
        await settle(
          context,
          claim.attemptId,
          RegistrationOutcome.ConversionFailed,
        );
        return outcomeRedirect(RegistrationOutcome.ConversionFailed);
      }
      const app = { id: conversion.id, slug: conversion.slug };
      if (claim.kind === "registered") {
        // Another App is already stored: record this one for cleanup and
        // discard its credentials unread.
        await settle(
          context,
          claim.attemptId,
          RegistrationOutcome.AlreadyRegistered,
          app,
        );
        return outcomeRedirect(RegistrationOutcome.AlreadyRegistered);
      }
      try {
        const prepared = await prepare(
          claim.attemptId,
          conversion,
          dependencies,
        );
        return await authority.run(
          action,
          detached,
          parsed,
          (authorized) =>
            next(
              Object.assign(authorized, {
                [preparationSlot]: prepared,
              }) as PreparedContext,
            ),
        );
      } catch (error) {
        // GitHub has created the App: keep its id and slug on the attempt so
        // an administrator can find and remove it.
        const race = isProviderRace(error);
        const outcome = race
          ? RegistrationOutcome.AlreadyRegistered
          : RegistrationOutcome.StorageFailed;
        logFailure(context, "store", outcome, error);
        await settle(context, claim.attemptId, outcome, app);
        if (race) return outcomeRedirect(RegistrationOutcome.AlreadyRegistered);
        if (
          error instanceof StandardError &&
          (error.code.startsWith("AUTH_") || error.code === "SESSION_REQUIRED")
        ) throw error;
        return outcomeRedirect(RegistrationOutcome.StorageFailed);
      }
    },
  };
}

function preparation(context: ActionContext): RegistrationPreparation {
  const prepared = (context as PreparedContext)[preparationSlot];
  if (!prepared) throw new StandardError({ code: "INTERNAL" });
  return prepared;
}

function putPreparation(context: ActionContext): RegistrationPutPreparation {
  const prepared = (context as PreparedContext)[putPreparationSlot];
  if (!prepared) throw new StandardError({ code: "INTERNAL" });
  return prepared;
}

export function createIntegrationsActionRegistry(
  database: PgDatabase,
  dependencies: IntegrationsRegistryDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    createIntegrationsAuthorityRunner(
      new PostgresAuthorityRunner(database),
      database,
      dependencies,
    ),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: IntegrationsImplementedAction.IntegrationAppRegistrationsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-app-registrations/github",
    input: contractSchemas.Empty,
    output: contractSchemas.IntegrationAppRegistration,
    policy: { ...policy, type: ActionKind.Query },
    handler: getRegistration,
  }).register({
    name: IntegrationsImplementedAction.IntegrationAppRegistrationsBegin,
    method: HttpMethod.Post,
    path: "/v1/integration-app-registrations/github/manifest",
    input: contractSchemas.IntegrationAppRegistrationBegin,
    output: contractSchemas.IntegrationAppManifestStart,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      beginRegistration(context, input, dependencies),
  }).register({
    name: IntegrationsImplementedAction.IntegrationAppRegistrationsPut,
    method: HttpMethod.Put,
    path: "/v1/integration-app-registrations/github",
    input: contractSchemas.IntegrationAppRegistrationPut,
    output: contractSchemas.IntegrationAppRegistration,
    // Idempotency-Key is required; If-Match is parsed when sent and the
    // handler requires it once a registration exists.
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => putRegistration(context, putPreparation(context)),
  }).register({
    name: IntegrationsImplementedAction.GitHubManifestCallback,
    method: HttpMethod.Get,
    path: "/v1/integration-auth/github/manifest-callback",
    input: contractSchemas.GitHubManifestCallback,
    output: contractSchemas.AuthRedirect,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => storeRegistration(context, preparation(context)),
  }).register({
    name: IntegrationsImplementedAction.IntegrationAuthAttemptsCreate,
    method: HttpMethod.Post,
    path: "/v1/integration-auth-attempts",
    input: contractSchemas.IntegrationAuthAttemptCreate,
    output: contractSchemas.IntegrationAuthAttemptCreated,
    // Idempotency-Key is handled by the handler: a replay rotates the state
    // instead of storing the authorization URL in idempotency_records.
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      sessionOnly: true,
    },
    handler: (context, input) =>
      createAuthAttempt(context, input, dependencies),
  }).register({
    name: IntegrationsImplementedAction.IntegrationAuthAttemptsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-auth-attempts/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.IntegrationAuthAttempt,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.InitiatingPrincipalOrAdmin,
      authorize: authorizeAuthAttemptRead,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: getAuthAttempt,
  });
  const boundAttempt = {
    type: ActionKind.Command,
    access: ActionAccess.BoundBrowserAuthAttempt,
    organizationContext: OrganizationContextPolicy.DerivedBoundAuthAttempt,
    sessionOnly: true,
  } as const;
  registry.register({
    name: IntegrationsImplementedAction.GitHubSetup,
    method: HttpMethod.Get,
    path: "/v1/integration-auth/github/setup",
    input: contractSchemas.GitHubSetupCallback,
    output: contractSchemas.AuthRedirect,
    policy: boundAttempt,
    handler: (context) =>
      bindConnection(
        context,
        IntegrationsImplementedAction.GitHubSetup,
        bindingPreparation(context),
      ),
  }).register({
    name: IntegrationsImplementedAction.GitHubCallback,
    method: HttpMethod.Get,
    path: "/v1/integration-auth/github/callback",
    input: contractSchemas.OAuthCallback,
    output: contractSchemas.AuthRedirect,
    policy: boundAttempt,
    handler: (context) =>
      bindConnection(
        context,
        IntegrationsImplementedAction.GitHubCallback,
        bindingPreparation(context),
      ),
  }).register({
    name: IntegrationsImplementedAction.IntegrationConnectionsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-connections/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.IntegrationConnection,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: getConnection,
  }).register({
    name: IntegrationsImplementedAction.IntegrationConnectionsCreate,
    method: HttpMethod.Post,
    path: "/v1/integration-connections",
    input: contractSchemas.IntegrationConnectionCreate,
    output: contractSchemas.IntegrationConnection,
    explicitIdempotency: "key",
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: createConnection,
  });
  const lists = createIntegrationListHandlers(dependencies.cursorSecret);
  const memberQuery = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  // #68: reading a connection's effects is a Developer query that also needs
  // read access to the connection's resources (catalog "Developer+resource read").
  const effectQuery = {
    ...memberQuery,
    access: ActionAccess.DeveloperAndResourceRead,
    authorize: authorizeEffectRead,
  } as const;
  registry.register({
    name: IntegrationsImplementedAction.IntegrationConnectionsList,
    method: HttpMethod.Get,
    path: "/v1/integration-connections",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<IntegrationConnection>"],
    policy: memberQuery,
    handler: lists.listConnections,
  }).register({
    name: IntegrationsImplementedAction.IntegrationResourcesList,
    method: HttpMethod.Get,
    path: "/v1/integration-connections/:id/resources",
    input: contractSchemas.IntegrationResourceQuery,
    output: contractSchemas["Page<IntegrationResource>"],
    policy: memberQuery,
    handler: lists.listResources,
  }).register({
    // #68 "Recent activity": the connection's effects and their outcomes.
    name: IntegrationsImplementedAction.IntegrationEffectsList,
    method: HttpMethod.Get,
    path: "/v1/integration-connections/:id/effects",
    input: contractSchemas.IntegrationEffectQuery,
    output: contractSchemas["Page<ExternalEffect>"],
    policy: effectQuery,
    handler: lists.listEffects,
  }).register({
    name: IntegrationsImplementedAction.IntegrationEffectsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-connections/:id/effects/:effectId",
    input: contractSchemas.IdPath,
    output: contractSchemas.ExternalEffect,
    policy: effectQuery,
    handler: getIntegrationEffect,
  });
  // Admin edits: Idempotency-Key and a strong If-Match naming the
  // connection version are both required; the check needs the key only.
  const adminEdit = {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  registry.register({
    name: IntegrationsImplementedAction.IntegrationConnectionsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/integration-connections/:id",
    input: contractSchemas.IntegrationConnectionUpdate,
    output: contractSchemas.IntegrationConnection,
    policy: adminEdit,
    explicitIdempotency: "key-and-if-match",
    handler: updateConnection,
  }).register({
    name: IntegrationsImplementedAction.IntegrationResourcesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/integration-connections/:id/resources/:resourceId",
    input: contractSchemas.IntegrationResourceUpdate,
    output: contractSchemas.IntegrationResource,
    policy: adminEdit,
    explicitIdempotency: "key-and-if-match",
    handler: updateResource,
  }).register({
    name: IntegrationsImplementedAction.IntegrationConnectionsCheck,
    method: HttpMethod.Post,
    path: "/v1/integration-connections/:id/checks",
    input: contractSchemas.Empty,
    output: contractSchemas.ConnectionCheck,
    policy: adminEdit,
    // Idempotency-Key only: a check changes no Admin-editable field. The
    // completed probe result is 200, not a created resource.
    explicitIdempotency: "key",
    successStatus: 200,
    handler: checkConnection,
  }).register({
    name: IntegrationsImplementedAction.IntegrationDiscoveriesCreate,
    method: HttpMethod.Post,
    path: "/v1/integration-connections/:id/discoveries",
    input: contractSchemas.IntegrationDiscoveryCreate,
    output: contractSchemas.IntegrationDiscoveryReceipt,
    policy: adminEdit,
    // Idempotency-Key only; the scan runs later, so the receipt is 202.
    explicitIdempotency: "key",
    successStatus: 202,
    handler: createDiscovery,
  });
  // Host-owned installations: the installation administrators' policy the
  // App registration routes use, never an organization role.
  registry.register({
    name: IntegrationsImplementedAction.IntegrationInstallationsList,
    method: HttpMethod.Get,
    path: "/v1/integration-installations",
    input: contractSchemas.IntegrationInstallationQuery,
    output: contractSchemas["Page<IntegrationInstallation>"],
    policy: { ...policy, type: ActionKind.Query },
    handler: createInstallationListHandler(dependencies.cursorSecret),
  }).register({
    name: IntegrationsImplementedAction.IntegrationInstallationsGet,
    method: HttpMethod.Get,
    path: "/v1/integration-installations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.IntegrationInstallation,
    policy: { ...policy, type: ActionKind.Query },
    handler: getInstallation,
  });

  // GitHub's signed webhook: no session and no organization; the raw-body
  // route verifies the signature and hands the delivery through the slot.
  registry.register({
    name: IntegrationsImplementedAction.IntakeGithub,
    method: HttpMethod.Post,
    path: GitHubAppPath.Webhook,
    input: contractSchemas.GitHubWebhook,
    output: contractSchemas.WebhookReceipt,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess
        .VerifiedGitHubAppRawBodySignatureInstallationResourceRoutesToExistingOrganizationConnection,
      authorize: requireVerifiedDelivery,
    },
    // The receipt acknowledges queued work, like the discovery receipt.
    successStatus: 202,
    handler: (context, input) => {
      const prepared = verifiedDelivery(context);
      if (
        input.deliveryId !== prepared.deliveryId ||
        input.eventType !== prepared.eventName
      ) throw new StandardError({ code: "INTERNAL" });
      return recordDelivery(database, prepared, context);
    },
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, integrationsImplementedActions);
  return registry;
}
