import {
  getArtifactStorage,
  updateArtifactPin,
} from "./retention/operations.ts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  type CatalogActionName,
  type CatalogPermissionKey,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  createApiRouter,
  parseIdempotencyKey,
  parseStrongIfMatch,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import {
  ArtifactImplementedAction,
  artifactImplementedActions,
  assertImplementedActionRegistry,
} from "@bakery/contracts/implemented-actions";
import type { AuthorizedActionContext } from "../auth/application/authority.ts";
import { authorize } from "../auth/application/authorize.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  type ArtifactVersionImportHeaders,
  type ArtifactVersionImportInput,
  type ArtifactVersionImportPreparation,
  type ArtifactVersionImportProof,
  createTrustedRepositoryResolver,
  importArtifactVersion,
  prepareArtifactVersionImport,
  proveArtifactVersionImport,
} from "./import.ts";
import { artifactContentActionDefinition } from "./content-action.ts";
import { createArtifactReadHandlers } from "./reads.ts";
import { registerCommentActions } from "./comments/routes.ts";
import { extractArtifactVersion } from "./extraction.ts";
import {
  createPreviewGrant,
  previewAvailability,
  revokePreview,
} from "./previews/actions.ts";

export type ArtifactResourceRouteOptions = {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secret: string;
  /** Validated `BAKERY_ARTIFACT_PREVIEW_ORIGIN`; absent fails previews closed. */
  artifactPreviewOrigin?: string;
  /** A registry already built for MCP; omitted, the routes build their own. */
  artifactActions?: ArtifactActions;
};

const readPolicy = {
  type: ActionKind.Query,
  access: ActionAccess.Developer,
  organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
} as const;

function requireArtifactPermission(
  context: ActionContext,
  permission: CatalogPermissionKey,
  action: CatalogActionName,
): void {
  const authority = (context as Partial<AuthorizedActionContext>).authority;
  if (
    !authority ||
    !("organizationId" in authority)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  authorize(authority, permission, { action });
}

const extractionPolicy = {
  ...readPolicy,
  authorize: (context: ActionContext) => {
    requireArtifactPermission(
      context,
      "artifactVersion:read",
      ArtifactImplementedAction.ArtifactVersionsExtract,
    );
  },
} as const;

function importHeaders(request: Request): ArtifactVersionImportHeaders {
  const idempotencyKey = parseIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  const ifMatch = request.headers.get("if-match");
  if (ifMatch === null) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  parseStrongIfMatch(ifMatch);
  return { idempotencyKey, ifMatch };
}

const importPolicy = {
  type: ActionKind.Command,
  access: ActionAccess.Developer,
  organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  authorize: (context: ActionContext) => {
    requireArtifactPermission(
      context,
      "artifactVersion:write",
      ArtifactImplementedAction.ArtifactVersionsImport,
    );
    importHeaders(context.request);
  },
} as const;

type ImportExecutionStage = {
  preparation?: ArtifactVersionImportPreparation;
  proof?: ArtifactVersionImportProof;
};

class ImportPreflightRollbackError extends Error {
  constructor() {
    super("ARTIFACT_VERSION_IMPORT_PREPARATION_COMPLETE");
    this.name = "ImportPreflightRollbackError";
  }
}

const importExecutionStage: unique symbol = Symbol("artifact-import-stage");

type StagedActionContext = ActionContext & {
  [importExecutionStage]?: ImportExecutionStage;
};

function actionContext(
  context: Context<{ Variables: AuthVariables }>,
): ActionContext {
  return {
    request: context.req.raw,
    params: context.req.param(),
    requestId: context.req.header("x-request-id") ?? crypto.randomUUID(),
    traceId: context.req.header("x-trace-id") ?? crypto.randomUUID(),
    signal: context.req.raw.signal,
    ...createActionContext(context),
  };
}

/** The artifact action registry with the authority and handlers its routes share. */
export type ArtifactActions = {
  readonly registry: ActionRegistry;
  readonly authority: ActionAuthorityRunner;
  readonly handlers: ReturnType<typeof createArtifactReadHandlers>;
};

/**
 * Builds the artifact action registry once, so the REST router and the MCP
 * catalog tools run the same instance.
 */
export function createArtifactActions(
  options: Omit<
    ArtifactResourceRouteOptions,
    "browserSession" | "artifactActions"
  >,
): ArtifactActions {
  const handlers = createArtifactReadHandlers(options.secret);
  const trustedRepositoryResolver = createTrustedRepositoryResolver();
  const postgresAuthority = new PostgresAuthorityRunner(options.database);
  const postgresCommandRunner = createPostgresCommandRunner();
  const commandRunner: CommandRunner = {
    async run(request) {
      if (
        request.action.name !== ArtifactImplementedAction.ArtifactVersionsImport
      ) {
        return await postgresCommandRunner.run(request);
      }
      const stage = (request.context as StagedActionContext)[
        importExecutionStage
      ];
      if (!stage || stage.proof) {
        return await postgresCommandRunner.run(request);
      }
      return await postgresCommandRunner.run({
        ...request,
        invokeAndEncode: async () => {
          const {
            transaction,
            organizationId,
            principalId,
          } = requireWorkTransaction(request.context);
          const artifactId = request.context.params.id;
          if (!artifactId) {
            throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
          }
          stage.preparation = await prepareArtifactVersionImport(
            transaction,
            {
              organizationId,
              principalId,
              artifactId,
              requestId: request.context.requestId,
              traceId: request.context.traceId,
              signal: request.context.signal,
            },
            importHeaders(request.context.request),
            trustedRepositoryResolver,
            request.input as ArtifactVersionImportInput,
          );
          // Roll back the read-only preflight before external Git so the DB
          // connection is released.
          throw new ImportPreflightRollbackError();
        },
      });
    },
  };
  const authority: ActionAuthorityRunner = {
    async run(action, context, input, next) {
      if (
        action.name !== ArtifactImplementedAction.ArtifactVersionsImport
      ) {
        return await postgresAuthority.run(action, context, input, next);
      }
      const stage: ImportExecutionStage = {};
      try {
        return await postgresAuthority.run(
          action,
          Object.assign({}, context, {
            [importExecutionStage]: stage,
          }),
          input,
          next,
        );
      } catch (error) {
        if (!(error instanceof ImportPreflightRollbackError)) throw error;
      }
      const preparation = stage.preparation;
      if (!preparation) {
        throw new Error("ARTIFACT_VERSION_IMPORT_PREPARATION_MISSING");
      }
      stage.proof = await proveArtifactVersionImport(preparation);
      return await postgresAuthority.run(
        action,
        Object.assign({}, context, {
          [importExecutionStage]: stage,
        }),
        input,
        next,
      );
    },
  };
  const registry = new ActionRegistry(authority, commandRunner);
  registry
    .register({
      name: ArtifactImplementedAction.ArtifactsUpdate,
      method: HttpMethod.Patch,
      path: "/v1/artifacts/:id",
      input: contractSchemas.ArtifactUpdate,
      output: contractSchemas.ArtifactPinResult,
      policy: {
        ...readPolicy,
        type: ActionKind.Command,
        access: ActionAccess.Admin,
      },
      handler: async (context, input) =>
        contractSchemas.ArtifactPinResult.parse(
          await updateArtifactPin(context, input),
        ),
    })
    .register({
      name: ArtifactImplementedAction.ArtifactStorageGet,
      method: HttpMethod.Get,
      path: "/v1/artifact-storage",
      input: contractSchemas.Empty,
      output: contractSchemas.ArtifactStorage,
      policy: { ...readPolicy, access: ActionAccess.Admin },
      handler: async (context) =>
        contractSchemas.ArtifactStorage.parse(
          await getArtifactStorage(context),
        ),
    })
    .register({
      name: "artifacts.list",
      method: HttpMethod.Get,
      path: "/v1/artifacts",
      input: contractSchemas.ArtifactQuery,
      output: contractSchemas["Page<Artifact>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<Artifact>"].parse(
          await handlers.listArtifacts(context, input),
        ),
    })
    .register({
      name: "artifacts.get",
      method: HttpMethod.Get,
      path: "/v1/artifacts/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.Artifact,
      policy: readPolicy,
      handler: async (context) =>
        contractSchemas.Artifact.parse(await handlers.getArtifact(context)),
    })
    .register({
      name: "artifactVersions.list",
      method: HttpMethod.Get,
      path: "/v1/artifacts/:id/versions",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<ArtifactVersionMetadata>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<ArtifactVersionMetadata>"].parse(
          await handlers.listArtifactVersions(context, input),
        ),
    })
    .register({
      name: ArtifactImplementedAction.ArtifactVersionsImport,
      method: HttpMethod.Post,
      path: "/v1/artifacts/:id/versions/import",
      input: contractSchemas.ArtifactVersionImport,
      output: contractSchemas.ArtifactVersionMetadata,
      policy: importPolicy,
      handler: async (context, input) => {
        const {
          transaction,
          organizationId,
          principalId,
        } = requireWorkTransaction(context);
        const artifactId = context.params.id;
        if (!artifactId) {
          throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        }
        const proof = (context as StagedActionContext)[
          importExecutionStage
        ]?.proof;
        if (!proof) {
          throw new Error("ARTIFACT_VERSION_IMPORT_PROOF_MISSING");
        }
        return contractSchemas.ArtifactVersionMetadata.parse(
          await importArtifactVersion(
            transaction,
            {
              organizationId,
              principalId,
              artifactId,
              requestId: context.requestId,
              traceId: context.traceId,
              signal: context.signal,
            },
            importHeaders(context.request),
            trustedRepositoryResolver,
            input,
            proof,
          ),
        );
      },
    })
    .register({
      name: ArtifactImplementedAction.ArtifactVersionsExtract,
      method: HttpMethod.Get,
      path: "/v1/artifact-versions/:id/extract",
      input: contractSchemas.ArtifactExtractQuery,
      output: contractSchemas.ArtifactExtraction,
      policy: extractionPolicy,
      handler: async (context, input) =>
        contractSchemas.ArtifactExtraction.parse(
          await extractArtifactVersion(context, input),
        ),
    })
    .register({
      name: ArtifactImplementedAction.ArtifactPreviewsAvailability,
      method: HttpMethod.Get,
      path: "/v1/artifact-preview-availability",
      input: contractSchemas.Empty,
      output: contractSchemas.ArtifactPreviewAvailability,
      policy: readPolicy,
      handler: () =>
        contractSchemas.ArtifactPreviewAvailability.parse(
          previewAvailability({
            previewOrigin: options.artifactPreviewOrigin,
          }),
        ),
    })
    .register({
      // A query-kind POST on purpose: the response carries the one-use grant,
      // which must never be stored as a replayable idempotency body.
      name: ArtifactImplementedAction.ArtifactPreviewsCreate,
      method: HttpMethod.Post,
      path: "/v1/artifact-versions/:id/preview-grants",
      input: contractSchemas.IdPath,
      output: contractSchemas.ArtifactPreviewGrant,
      policy: { ...readPolicy, sessionOnly: true },
      handler: async (context) =>
        contractSchemas.ArtifactPreviewGrant.parse(
          await createPreviewGrant(context, {
            previewOrigin: options.artifactPreviewOrigin,
          }),
        ),
    })
    .register({
      name: ArtifactImplementedAction.ArtifactPreviewsRevoke,
      method: HttpMethod.Delete,
      path: "/v1/artifact-preview-grants/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.NoContent,
      explicitIdempotency: "key",
      policy: { ...readPolicy, type: ActionKind.Command, sessionOnly: true },
      handler: (context) => revokePreview(context),
    })
    .register(artifactContentActionDefinition);
  registerCommentActions(registry, options.secret);
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, artifactImplementedActions);
  return { registry, authority, handlers };
}

export function createArtifactResourceRoutes(
  options: ArtifactResourceRouteOptions,
) {
  const { registry, authority, handlers } = options.artifactActions ??
    createArtifactActions(options);
  const app = new Hono<{ Variables: AuthVariables }>();
  const session = options.browserSession;
  app.use("/v1/artifact-comments/*", session);
  app.use("/v1/artifact-storage", session);
  app.use("/v1/artifacts", session);
  app.use("/v1/artifacts/*", session);
  app.use("/v1/artifact-versions", session);
  app.use("/v1/artifact-preview-availability", session);
  app.use("/v1/artifact-preview-grants/*", session);
  app.use("/v1/artifact-versions/*", session);
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );

  app.get("/v1/artifact-versions/:id/content", async (context) => {
    const { id } = contractSchemas.IdPath.parse(context.req.param());
    const range = context.req.header("Range");
    const input = contractSchemas.ContentRangeQuery.parse({
      range: range ?? undefined,
    });
    const result = await authority.run(
      registry.get("artifactVersions.content"),
      {
        ...actionContext(context),
        params: { id },
      },
      input,
      (authorizedContext) => handlers.readArtifactContent(authorizedContext),
    );
    return result as Response;
  });
  app.route(
    "/",
    createApiRouter({
      registry,
      createContext: createActionContext,
      publicBaseUrl: options.publicBaseUrl,
    }),
  );
  return app;
}
