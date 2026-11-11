import { Hono, type MiddlewareHandler } from "hono";
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
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  SkillStorageImplementedAction as Action,
  skillStorageImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  createNormalizedCommandMetadata,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  createPostgresCommandRunner,
  readCompletedCommandReplay,
} from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { installationActor } from "../integrations/postgres.ts";
import {
  ACCOUNT_ID_PATTERN,
  BUCKET_NAME_PATTERN,
  isCredentialText,
  type R2Credentials,
  resolveR2Connection,
  SKILL_STORAGE_CONFIG_INVALID,
  SkillStorageBackend,
} from "./skill-storage-config.ts";
import {
  readSkillStorageSettings,
  sealSkillStorageCredentials,
  SKILL_STORAGE_SETTINGS_ID,
  type StoredSkillStorageSettings,
  upsertSkillStorageSettings,
  writeSkillStorageSecretVersion,
} from "./skill-storage-settings.ts";
import {
  probeSkillStorage,
  resolveSkillStorage,
  type SkillStorageResolverOptions,
  SkillStorageVerificationOutcome,
} from "./storage-backend.ts";
import { SkillFileStoreError } from "./storage-port.ts";

type Settings = z.output<typeof contractSchemas.SkillStorageSettings>;
type SettingsPut = z.output<typeof contractSchemas.SkillStorageSettingsPut>;
type Verification = z.output<typeof contractSchemas.SkillStorageVerification>;

export type SkillStorageRegistryDependencies = SkillStorageResolverOptions & {
  /** Probe runner; tests inject one so no suite reaches a real provider. */
  readonly probe?: typeof probeSkillStorage;
};

const unconfigured: Settings = {
  backend: SkillStorageBackend.Filesystem,
  configured: false,
  accountId: null,
  bucket: null,
  credentialUpdatedAt: null,
  credentialRevision: null,
  updatedAt: null,
  version: 0,
};

/** Explicit projection of stored settings; no secret, id or ciphertext. */
export function skillStorageProjection(
  stored: StoredSkillStorageSettings | null,
): Settings {
  if (stored === null) return unconfigured;
  return contractSchemas.SkillStorageSettings.parse({
    backend: stored.backend,
    configured: stored.secretId !== null && stored.credentialRevision !== null,
    accountId: stored.accountId,
    bucket: stored.bucket,
    credentialUpdatedAt: stored.credentialUpdatedAt,
    credentialRevision: stored.credentialRevision,
    updatedAt: stored.updatedAt,
    version: stored.version,
  });
}

function malformed(path: string, message: string): StandardError {
  return new StandardError({
    code: "MALFORMED_REQUEST",
    params: { issues: [{ path: [path], code: "invalid", message }] },
  });
}

/** The credential pair when both halves were supplied; refuses a lone half. */
function suppliedCredentials(input: SettingsPut): R2Credentials | null {
  const { accessKeyId, secretAccessKey } = input;
  if (accessKeyId === undefined && secretAccessKey === undefined) return null;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw malformed(
      accessKeyId === undefined ? "accessKeyId" : "secretAccessKey",
      "The access key id and secret access key are supplied together.",
    );
  }
  if (!isCredentialText(accessKeyId)) {
    throw malformed("accessKeyId", "The access key id has invalid characters.");
  }
  if (!isCredentialText(secretAccessKey)) {
    throw malformed(
      "secretAccessKey",
      "The secret access key has invalid characters.",
    );
  }
  return { accessKeyId, secretAccessKey };
}

/** skillStorageSettings.get */
export function getSkillStorageSettings(
  context: ActionContext,
): Promise<Settings> {
  const { context: value } = installationActor(context);
  return readSkillStorageSettings(value.transaction).then(
    skillStorageProjection,
  );
}

/**
 * skillStorageSettings.put: validates, checks If-Match under the row lock,
 * seals the credential pair as the next revision of one installation secret,
 * and saves the non-secret fields at the next version, all in one
 * transaction with its audit row. The active backend never changes here.
 */
export async function putSkillStorageSettings(
  context: ActionContext,
  input: SettingsPut,
  dependencies: SkillStorageRegistryDependencies,
): Promise<Settings> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const credentials = suppliedCredentials(input);
  if (!ACCOUNT_ID_PATTERN.test(input.accountId)) {
    throw unprocessable(["accountId"], "invalid_account_id");
  }
  if (!BUCKET_NAME_PATTERN.test(input.bucket)) {
    throw unprocessable(["bucket"], "invalid_bucket");
  }
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readSkillStorageSettings(transaction, { lock: true });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    // A live r2 backend holds objects in the saved bucket: moving it would
    // orphan them. Only the paused procedure may change where objects live.
    if (
      stored.backend === SkillStorageBackend.R2 &&
      (stored.accountId !== input.accountId || stored.bucket !== input.bucket)
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "backend_active" },
      });
    }
  } else {
    if (expectedVersion !== undefined) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    if (credentials === null) {
      throw malformed(
        "accessKeyId",
        "The first save needs the access key id and secret access key.",
      );
    }
  }
  const sealed = credentials === null
    ? null
    : await sealSkillStorageCredentials(
      dependencies.secretsKey,
      stored,
      credentials,
    );
  if (sealed) {
    await writeSkillStorageSecretVersion(
      transaction,
      sealed,
      stored,
      principalId,
    );
  }
  const saved = await upsertSkillStorageSettings(transaction, stored, {
    accountId: input.accountId,
    bucket: input.bucket,
    secretId: sealed?.secretId ?? null,
    credentialsReplaced: sealed !== null,
    principalId,
  });
  if (!saved) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const result = await readSkillStorageSettings(transaction);
  // Identifiers, flags and revision numbers only: no credential, ciphertext,
  // key id or secret record id.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.SkillStorageSettingsPut,
    resourceType: "skill_storage_settings",
    resourceId: SKILL_STORAGE_SETTINGS_ID,
    details: {
      backend: result?.backend ?? SkillStorageBackend.Filesystem,
      bucket: input.bucket,
      replaced: stored !== null,
      credentialsRotated: sealed !== null,
      credentialRevision: result?.credentialRevision ?? null,
      version: result?.version ?? null,
    },
  });
  return skillStorageProjection(result);
}

const verificationSlot = Symbol("private skill storage probe outcome");
type VerifiedContext = ActionContext & { [verificationSlot]?: Verification };

/** What the probe stage decided before any provider call. */
type ProbeStage =
  | { readonly replay: EncodedSuccessResponse }
  | { readonly outcome: SkillStorageVerificationOutcome }
  | {
    readonly connection: Parameters<typeof probeSkillStorage>[0];
    readonly credentials: R2Credentials;
  };

/**
 * skillStorageSettings.verify, following the secrets/preflight.ts precedent so
 * the provider is called between committed transactions:
 * 1. under the live installation-administrator check, return a completed
 *    Idempotency-Key replay, else decrypt the stored credentials in memory;
 * 2. run the bounded sentinel probe outside any transaction;
 * 3. record the fixed outcome through `next` and its audit row.
 */
async function runVerify(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: SkillStorageRegistryDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.Empty.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const stage = await authority.run(
    action,
    context,
    parsed,
    async (authorized): Promise<ProbeStage> => {
      const { context: value } = installationActor(authorized);
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) {
        return { replay: validateEncodedSuccessResponse(action, replay) };
      }
      const settings = await readSkillStorageSettings(value.transaction);
      if (
        settings === null || settings.secretId === null ||
        settings.accountId === null || settings.bucket === null
      ) {
        return { outcome: SkillStorageVerificationOutcome.NotConfigured };
      }
      try {
        const resolved = await resolveSkillStorage(
          value.transaction,
          settings,
          dependencies,
          SkillStorageBackend.R2,
        );
        if (resolved.backend !== SkillStorageBackend.R2) {
          throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
        }
        return {
          connection: resolved.connection,
          credentials: resolved.credentials,
        };
      } catch (error) {
        if (
          error instanceof SkillFileStoreError &&
          error.code === SKILL_STORAGE_CONFIG_INVALID
        ) {
          return { outcome: SkillStorageVerificationOutcome.ProviderError };
        }
        // No usable secrets key, or one that cannot open the stored version.
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
    },
  ) as ProbeStage;
  if ("replay" in stage) return stage.replay;
  context.signal.throwIfAborted();
  const outcome = "outcome" in stage
    ? stage.outcome
    : await (dependencies.probe ?? probeSkillStorage)(
      stage.connection,
      stage.credentials,
      context.signal,
    );
  const result: Verification = {
    outcome,
    checkedAt: new Date().toISOString(),
  };
  return await authority.run(
    action,
    context,
    parsed,
    (authorized) =>
      next(
        Object.assign(authorized, {
          [verificationSlot]: result,
        }) as VerifiedContext,
      ),
  );
}

/** What the rotation pre-check decided before the save transaction. */
type RotationStage =
  | { readonly skip: true }
  | {
    readonly connection: Parameters<typeof probeSkillStorage>[0];
    readonly credentials: R2Credentials;
  };

/**
 * skillStorageSettings.put while r2 is the active backend: new credentials go
 * live for every running store the moment they commit, so they must pass the
 * verify probe first. The probe runs between transactions, as in verify. A
 * failed probe rejects with the probe's fixed outcome code and stores nothing,
 * so the old credentials keep serving. Other saves go straight through.
 */
async function runPut(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: SkillStorageRegistryDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.SkillStorageSettingsPut.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const stage = await authority.run(
    action,
    context,
    parsed,
    async (authorized): Promise<RotationStage> => {
      const { context: value } = installationActor(authorized);
      const credentials = suppliedCredentials(parsed);
      if (credentials === null) return { skip: true };
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) return { skip: true };
      const stored = await readSkillStorageSettings(value.transaction);
      // A moved account or bucket is refused by the save itself.
      if (
        stored === null || stored.backend !== SkillStorageBackend.R2 ||
        stored.accountId !== parsed.accountId || stored.bucket !== parsed.bucket
      ) return { skip: true };
      try {
        return {
          connection: resolveR2Connection(
            {
              accountId: stored.accountId,
              bucket: stored.bucket,
              endpointOverride: stored.endpointOverride,
            },
            { allowLoopbackEndpoint: dependencies.allowLoopbackEndpoint },
          ),
          credentials,
        };
      } catch (error) {
        if (
          error instanceof SkillFileStoreError &&
          error.code === SKILL_STORAGE_CONFIG_INVALID
        ) {
          throw unprocessable(
            ["accountId"],
            SkillStorageVerificationOutcome.ProviderError,
          );
        }
        throw error;
      }
    },
  ) as RotationStage;
  if (!("skip" in stage)) {
    context.signal.throwIfAborted();
    const outcome = await (dependencies.probe ?? probeSkillStorage)(
      stage.connection,
      stage.credentials,
      context.signal,
    );
    if (outcome !== SkillStorageVerificationOutcome.Verified) {
      throw unprocessable(["secretAccessKey"], outcome);
    }
  }
  return await authority.run(action, context, parsed, next);
}

/** skillStorageSettings.verify, after the probe: audits and returns the outcome. */
async function recordVerification(
  context: ActionContext,
): Promise<Verification> {
  const { context: value, actor } = installationActor(context);
  const result = (context as VerifiedContext)[verificationSlot];
  if (!result) throw new StandardError({ code: "INTERNAL" });
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.SkillStorageSettingsVerify,
    resourceType: "skill_storage_settings",
    resourceId: SKILL_STORAGE_SETTINGS_ID,
    details: { outcome: result.outcome },
  });
  return contractSchemas.SkillStorageVerification.parse(result);
}

export function createSkillStorageAuthorityRunner(
  authority: ActionAuthorityRunner,
  dependencies: SkillStorageRegistryDependencies,
): ActionAuthorityRunner {
  return {
    run(action, context, input, next) {
      if (action.name === Action.SkillStorageSettingsPut) {
        return runPut(
          authority,
          action,
          context,
          input,
          next,
          dependencies,
        );
      }
      if (action.name === Action.SkillStorageSettingsVerify) {
        return runVerify(
          authority,
          action,
          context,
          input,
          next,
          dependencies,
        );
      }
      return authority.run(action, context, input, next);
    },
  };
}

export function createSkillStorageActionRegistry(
  database: PgDatabase,
  dependencies: SkillStorageRegistryDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    createSkillStorageAuthorityRunner(
      new PostgresAuthorityRunner(database),
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
    name: Action.SkillStorageSettingsGet,
    method: HttpMethod.Get,
    path: "/v1/installation/skill-storage",
    input: contractSchemas.Empty,
    output: contractSchemas.SkillStorageSettings,
    policy: { ...policy, type: ActionKind.Query },
    handler: getSkillStorageSettings,
  }).register({
    name: Action.SkillStorageSettingsPut,
    method: HttpMethod.Put,
    path: "/v1/installation/skill-storage",
    input: contractSchemas.SkillStorageSettingsPut,
    output: contractSchemas.SkillStorageSettings,
    // Idempotency-Key is required; If-Match is parsed when sent and the
    // handler requires it once settings exist.
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      putSkillStorageSettings(context, input, dependencies),
  }).register({
    name: Action.SkillStorageSettingsVerify,
    method: HttpMethod.Post,
    path: "/v1/installation/skill-storage/verification",
    input: contractSchemas.Empty,
    output: contractSchemas.SkillStorageVerification,
    // Idempotency-Key only: a probe changes no setting. The completed probe
    // result is 200, not a created resource.
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: recordVerification,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, skillStorageImplementedActions);
  return registry;
}

export function createSkillStorageRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  dependencies: SkillStorageRegistryDependencies;
}) {
  const registry = createSkillStorageActionRegistry(
    options.database,
    options.dependencies,
  );
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/installation/skill-storage", options.browserSession);
  app.use("/v1/installation/skill-storage/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
