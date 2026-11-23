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
  BlobUploadImplementedAction,
  blobUploadImplementedActions,
  ContextPackImplementedAction,
  contextPackImplementedActions,
  PreviewImplementedAction,
  previewImplementedActions,
  StorageImplementedAction,
  storageImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  copyStorageEntry,
  createStorageFolder,
  createTrashLister,
  getStorageSettings,
  moveStorageEntry,
  purgeStorageEntry,
  putStorageFile,
  putStorageSettings,
  restoreStorageEntry,
  trashStorageEntry,
} from "./storage-working-areas.ts";
import {
  createFileContentReader,
  createFileProbeReader,
  createFileUseLister,
  createFileVersionLister,
  createFolderLister,
  createSessionFileContentReader,
  listStorageRoots,
  parseRevision,
  readStorageFileByVersion,
  type StorageReader,
} from "./storage-reads.ts";
import { pinStorageFile } from "./storage-pin.ts";
import {
  createAgentFileGrant,
  revokeAgentFileGrant,
} from "./agent-file-grants.ts";
import type { AuthorizedActionContext } from "../auth/application/authority.ts";
import {
  createFileFactsHandler,
  createFileSearchHandler,
  createLibraryFolderHandler,
} from "./file-search.ts";
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
import {
  createBlobUploadHandlers,
  type PartInput,
  type StartInput,
} from "./blob-upload-handlers.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";
import { registerCommentActions } from "./comments/routes.ts";
import { registerArtifactAccessActions } from "./artifact-access.ts";
import { extractArtifactVersion } from "./extraction.ts";
import { buildContextPack } from "./context-packs.ts";
import {
  createPreviewGrant,
  previewAvailability,
  revokePreview,
} from "./previews/actions.ts";
import {
  createConnectionExportAction,
  createConnectionPathLister,
  createConnectionSyncAction,
  createConnectionSyncLister,
  defaultStorageConnections,
  mountConnectionAction,
  pauseConnectionSyncAction,
  readConnectionPathAction,
  resumeConnectionSyncAction,
  statConnectionPathAction,
  type StorageConnectionDeps,
} from "./storage-connections.ts";
import {
  createRunningPreviewAccess,
  listRunningPreviews,
  revokeRunningPreviewAccess,
  runningPreviewAvailability,
  stopRunningPreview,
} from "./previews/running.ts";

export type ArtifactResourceRouteOptions = {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  /**
   * The same session middleware, also accepting access tokens. Used only for
   * GET reads of the storage tree and file search (the command line and
   * agents read files with a token); every other method and path stays on
   * `browserSession`, which refuses a token. A token acts through the
   * authority runner, so its scope and organization are enforced as for any
   * action; absent, reads take the browser session only.
   */
  tokenSession?: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secret: string;
  /** Validated `BAKERY_ARTIFACT_PREVIEW_ORIGIN`; absent fails previews closed. */
  artifactPreviewOrigin?: string;
  storageConnections?: StorageConnectionDeps;
  storageLocalRoot?: string;
  /** A registry already built for MCP; omitted, the routes build their own. */
  artifactActions?: ArtifactActions;
  /** Where completed uploads put their bytes; absent fails completion closed. */
  blobStore?: OrganizationBlobStore;
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

/**
 * Uploading bytes is a write open to any organization member, which is what the
 * catalog declares for these three actions. Separate from `readPolicy` because
 * the registry asserts the runtime access matches the catalog's, so reusing the
 * read policy here is a startup failure rather than a subtle drift.
 */
const blobWritePolicy = {
  type: ActionKind.Command,
  access: ActionAccess.Developer,
  organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  authorize: (context: ActionContext) => {
    requireArtifactPermission(
      context,
      "artifact:create",
      BlobUploadImplementedAction.BlobUploadStart,
    );
  },
} as const;

/**
 * Writing files and folders into working areas is the same write a blob upload
 * is, open to any member who may create artifacts. The folder policy, not the
 * role, decides where (storage-areas.ts).
 */
function storageWritePolicy(action: CatalogActionName) {
  return {
    type: ActionKind.Command,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    authorize: (context: ActionContext) => {
      requireArtifactPermission(context, "artifact:create", action);
    },
  } as const;
}

/**
 * The files browser's reads need one fact about the caller beyond membership:
 * whether they are an organization Admin, who alone sees /system. Asked of the
 * same permission the Admin storage actions require, so the two cannot drift.
 */
function storageReader(
  context: ActionContext,
  action: CatalogActionName,
): StorageReader {
  try {
    requireArtifactPermission(context, "artifact:manage", action);
    return { isAdmin: true };
  } catch (error) {
    if (error instanceof StandardError) return { isAdmin: false };
    throw error;
  }
}

/** Storage limits and the purge are an organization Admin's. */
function storageAdminPolicy(action: CatalogActionName) {
  return {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    authorize: (context: ActionContext) => {
      requireArtifactPermission(context, "artifact:manage", action);
    },
  } as const;
}
const contextPackPolicy = {
  ...readPolicy,
  authorize: (context: ActionContext) => {
    // A pack is built from artifact versions the caller may read, so it needs
    // exactly that permission and no more: building a pack grants nothing.
    requireArtifactPermission(
      context,
      "artifactVersion:read",
      ContextPackImplementedAction.ContextPacksBuild,
    );
  },
} as const;

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
    "browserSession" | "tokenSession" | "artifactActions"
  >,
): ArtifactActions {
  const handlers = createArtifactReadHandlers(
    options.secret,
    options.blobStore,
  );
  // Library items need `library:read` on top of the route's file permission, so
  // searching files never reveals the library to someone who may not read it.
  const searchFiles = createFileSearchHandler(
    options.secret,
    (context) => {
      const actor = (context as Partial<AuthorizedActionContext>).authority;
      if (actor === undefined) return false;
      try {
        authorize(
          actor as Parameters<typeof authorize>[0],
          "library:read",
          {
            action: ArtifactImplementedAction.FilesSearch,
          },
        );
        return true;
      } catch {
        return false;
      }
    },
    (context) =>
      storageReader(context, ArtifactImplementedAction.FilesSearch).isAdmin,
  );
  const listFileFacts = createFileFactsHandler((context) =>
    storageReader(context, ArtifactImplementedAction.FilesFacts).isAdmin
  );
  const listLibrary = createLibraryFolderHandler(options.secret);
  const blobUploads = createBlobUploadHandlers(options.blobStore);
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
      name: ArtifactImplementedAction.FilesSearch,
      method: HttpMethod.Get,
      path: "/v1/files/search",
      input: contractSchemas.FileSearchQuery,
      output: contractSchemas["Page<FileSearchHit>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<FileSearchHit>"].parse(
          await searchFiles(context, input),
        ),
    })
    .register({
      name: ArtifactImplementedAction.FilesFacts,
      method: HttpMethod.Get,
      path: "/v1/files/facts",
      input: contractSchemas.FileFactQuery,
      output: contractSchemas["Page<FileFact>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<FileFact>"].parse(
          await listFileFacts(context, input),
        ),
    })
    .register({
      name: ArtifactImplementedAction.FilesLibrary,
      method: HttpMethod.Get,
      path: "/v1/files/library",
      input: contractSchemas.LibraryFolderQuery,
      output: contractSchemas["Page<LibraryEntry>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<LibraryEntry>"].parse(
          await listLibrary(context, input),
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
      name: ContextPackImplementedAction.ContextPacksBuild,
      method: HttpMethod.Post,
      path: "/v1/context-packs",
      input: contractSchemas.ContextPackBuild,
      output: contractSchemas.ContextPack,
      // A pack is computed and returned, never created: nothing is stored, so
      // 201 would say something was.
      successStatus: 200,
      policy: contextPackPolicy,
      handler: async (context, input) =>
        contractSchemas.ContextPack.parse(
          await buildContextPack(context, input),
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
    .register({
      name: PreviewImplementedAction.PreviewsList,
      method: HttpMethod.Get,
      path: "/v1/previews",
      input: contractSchemas.PreviewQuery,
      output: contractSchemas["Page<Preview>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<Preview>"].parse(
          await listRunningPreviews(
            context,
            input as Parameters<typeof listRunningPreviews>[1],
            {
              previewOrigin: options.artifactPreviewOrigin,
              secret: options.secret,
            },
          ),
        ),
    })
    .register({
      // A query-kind POST on purpose, like artifactPreviews.create: the
      // response carries the one-use grant.
      name: PreviewImplementedAction.PreviewsAccess,
      method: HttpMethod.Post,
      path: "/v1/previews/:id/access",
      input: contractSchemas.PreviewAccess,
      output: contractSchemas.PreviewAccessResult,
      policy: { ...readPolicy, sessionOnly: true },
      handler: async (context, input) =>
        contractSchemas.PreviewAccessResult.parse(
          await createRunningPreviewAccess(
            context,
            input as { sessionSeconds?: number },
            {
              previewOrigin: options.artifactPreviewOrigin,
              secret: options.secret,
            },
          ),
        ),
    })
    .register({
      name: PreviewImplementedAction.PreviewsStop,
      method: HttpMethod.Post,
      path: "/v1/previews/:id/stop",
      input: contractSchemas.IdPath,
      output: contractSchemas.Preview,
      explicitIdempotency: "key",
      policy: { ...readPolicy, type: ActionKind.Command, sessionOnly: true },
      handler: async (context) =>
        contractSchemas.Preview.parse(await stopRunningPreview(context)),
    })
    .register({
      name: PreviewImplementedAction.PreviewsRevokeAccess,
      method: HttpMethod.Delete,
      path: "/v1/preview-grants/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.NoContent,
      explicitIdempotency: "key",
      policy: { ...readPolicy, type: ActionKind.Command, sessionOnly: true },
      handler: (context) => revokeRunningPreviewAccess(context),
    })
    .register({
      name: PreviewImplementedAction.PreviewsAvailability,
      method: HttpMethod.Get,
      path: "/v1/preview-availability",
      input: contractSchemas.Empty,
      output: contractSchemas.PreviewAvailability,
      policy: readPolicy,
      handler: () =>
        contractSchemas.PreviewAvailability.parse(
          runningPreviewAvailability({
            previewOrigin: options.artifactPreviewOrigin,
            secret: options.secret,
          }),
        ),
    })
    .register(artifactContentActionDefinition)
    .register({
      // A separate read from the content: the probe answer is about the blob's
      // bytes, so it belongs to every version that shares them, and a client
      // wants it before deciding whether to fetch anything at all.
      name: "artifactVersions.probe",
      method: HttpMethod.Get,
      path: "/v1/artifact-versions/:id/probe",
      input: contractSchemas.IdPath,
      output: contractSchemas.ArtifactProbeAnswer,
      policy: readPolicy,
      handler: async (context) =>
        contractSchemas.ArtifactProbeAnswer.parse(
          await handlers.readArtifactProbe(context),
        ),
    })
    // Blob uploads: the session names what it promises, parts are keyed by
    // ordinal, and completion verifies before recording. The client supplies
    // bytes and the digest it claims for them; the server checks the claim.
    .register({
      name: BlobUploadImplementedAction.BlobUploadStart,
      method: HttpMethod.Post,
      path: "/v1/blobs/uploads",
      input: contractSchemas.BlobUploadStart,
      output: contractSchemas.BlobUploadSession,
      policy: blobWritePolicy,
      handler: (context, input) =>
        blobUploads.startUpload(context, input as StartInput),
    })
    .register({
      name: BlobUploadImplementedAction.BlobUploadPart,
      method: HttpMethod.Put,
      path: "/v1/blobs/uploads/:id/parts/:partNumber",
      input: contractSchemas.BlobUploadPart,
      output: contractSchemas.BlobUploadSession,
      policy: blobWritePolicy,
      handler: (context, input) =>
        blobUploads.putPart(context, {
          ...(input as PartInput),
          id: context.params.id,
          partNumber: context.params.partNumber,
        }),
    })
    .register({
      name: BlobUploadImplementedAction.BlobUploadComplete,
      method: HttpMethod.Post,
      path: "/v1/blobs/uploads/:id/complete",
      input: contractSchemas.BlobUploadComplete,
      output: contractSchemas.Blob,
      policy: blobWritePolicy,
      handler: (context) =>
        blobUploads.completeUpload(context, { id: context.params.id }),
    });
  registerStorageActions(registry, options.secret, options.blobStore);
  registerStorageConnectionActions(
    registry,
    options.secret,
    options.storageConnections ??
      defaultStorageConnections({
        blobStore: options.blobStore,
        storageLocalRoot: options.storageLocalRoot,
      }),
  );
  registerCommentActions(registry, options.secret, options.blobStore);
  registerArtifactAccessActions(registry, options.secret);
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    ...artifactImplementedActions,
    ...previewImplementedActions,
    ...blobUploadImplementedActions,
    ...storageImplementedActions,
    ...contextPackImplementedActions,
  ]);
  return { registry, authority, handlers };
}

function registerStorageConnectionActions(
  registry: ActionRegistry,
  secret: string,
  deps: StorageConnectionDeps,
) {
  const A = StorageImplementedAction;
  const listPaths = createConnectionPathLister(secret, deps);
  const listSyncs = createConnectionSyncLister(secret);
  const command = {
    type: ActionKind.Command,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  registry
    .register({
      name: A.StorageConnectionsMount,
      method: HttpMethod.Post,
      path: "/v1/storage/connections/:id/mount",
      input: contractSchemas.IdPath,
      output: contractSchemas.StorageConnectionMount,
      explicitIdempotency: "key",
      policy: { ...command, access: ActionAccess.Admin },
      handler: async (context) =>
        contractSchemas.StorageConnectionMount.parse(
          await mountConnectionAction(context, deps),
        ),
    })
    .register({
      name: A.StorageConnectionPathsList,
      method: HttpMethod.Get,
      path: "/v1/storage/connection-paths",
      input: contractSchemas.StorageConnectionPathQuery,
      output: contractSchemas["Page<StorageConnectionItem>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageConnectionItem>"].parse(
          await listPaths(
            context,
            storageReader(context, A.StorageConnectionPathsList),
            input as { path: string; cursor?: string; limit?: number },
          ),
        ),
    })
    .register({
      name: A.StorageConnectionPathsStat,
      method: HttpMethod.Get,
      path: "/v1/storage/connection-paths/stat",
      input: contractSchemas.StorageConnectionStatQuery,
      output: contractSchemas.StorageConnectionItem,
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas.StorageConnectionItem.parse(
          await statConnectionPathAction(
            context,
            storageReader(context, A.StorageConnectionPathsStat),
            deps,
            input as { path: string },
          ),
        ),
    })
    .register({
      name: A.StorageConnectionPathsRead,
      method: HttpMethod.Get,
      path: "/v1/storage/connection-paths/content",
      input: contractSchemas.StorageConnectionReadQuery,
      output: contractSchemas.StorageConnectionRange,
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas.StorageConnectionRange.parse(
          await readConnectionPathAction(
            context,
            storageReader(context, A.StorageConnectionPathsRead),
            deps,
            input as { path: string; offset: number; length: number },
          ),
        ),
    })
    .register({
      name: A.StorageConnectionSyncsCreate,
      method: HttpMethod.Post,
      path: "/v1/storage/connection-syncs",
      input: contractSchemas.StorageConnectionSyncCreate,
      output: contractSchemas.StorageConnectionSync,
      explicitIdempotency: "key",
      policy: command,
      handler: async (context, input) =>
        contractSchemas.StorageConnectionSync.parse(
          await createConnectionSyncAction(
            context,
            storageReader(context, A.StorageConnectionSyncsCreate),
            deps,
            input as { path: string; taskId: string },
          ),
        ),
    })
    .register({
      name: A.StorageConnectionSyncsList,
      method: HttpMethod.Get,
      path: "/v1/storage/connection-syncs",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<StorageConnectionSync>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageConnectionSync>"].parse(
          await listSyncs(
            context,
            input as { cursor?: string; limit?: number },
          ),
        ),
    })
    .register({
      name: A.StorageConnectionSyncsPause,
      method: HttpMethod.Post,
      path: "/v1/storage/connection-syncs/:id/pause",
      input: contractSchemas.IdPath,
      output: contractSchemas.StorageConnectionSync,
      explicitIdempotency: "key",
      policy: command,
      handler: async (context) =>
        contractSchemas.StorageConnectionSync.parse(
          await pauseConnectionSyncAction(
            context,
            storageReader(context, A.StorageConnectionSyncsPause),
          ),
        ),
    })
    .register({
      name: A.StorageConnectionSyncsResume,
      method: HttpMethod.Post,
      path: "/v1/storage/connection-syncs/:id/resume",
      input: contractSchemas.IdPath,
      output: contractSchemas.StorageConnectionSync,
      explicitIdempotency: "key",
      policy: command,
      handler: async (context) =>
        contractSchemas.StorageConnectionSync.parse(
          await resumeConnectionSyncAction(
            context,
            storageReader(context, A.StorageConnectionSyncsResume),
          ),
        ),
    })
    .register({
      name: A.StorageConnectionExportsCreate,
      method: HttpMethod.Post,
      path: "/v1/storage/connection-exports",
      input: contractSchemas.StorageConnectionExportCreate,
      output: contractSchemas.StorageConnectionExport,
      explicitIdempotency: "key",
      policy: command,
      handler: async (context, input) =>
        contractSchemas.StorageConnectionExport.parse(
          await createConnectionExportAction(
            context,
            storageReader(context, A.StorageConnectionExportsCreate),
            deps,
            input as {
              path: string;
              artifactVersionId: string;
              ifMatch?: string;
            },
          ),
        ),
    });
}

/** The working-area actions over the storage tree (#447). */
function registerStorageActions(
  registry: ActionRegistry,
  secret: string,
  blobStore: OrganizationBlobStore | undefined,
) {
  const readSessionContent = createSessionFileContentReader(blobStore);
  const listTrash = createTrashLister(secret);
  const listFolder = createFolderLister(secret);
  const listVersions = createFileVersionLister(secret);
  const listUses = createFileUseLister(secret);
  const readProbe = createFileProbeReader();
  const A = StorageImplementedAction;
  registry
    .register({
      name: A.StorageRootsList,
      method: HttpMethod.Get,
      path: "/v1/storage/roots",
      input: contractSchemas.Empty,
      output: contractSchemas["Page<StorageFolderItem>"],
      policy: readPolicy,
      handler: async (context) =>
        contractSchemas["Page<StorageFolderItem>"].parse(
          await listStorageRoots(
            context,
            storageReader(context, A.StorageRootsList),
          ),
        ),
    })
    .register({
      name: A.StorageFolderEntriesList,
      method: HttpMethod.Get,
      path: "/v1/storage/folders/:id/entries",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<StorageFolderItem>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageFolderItem>"].parse(
          await listFolder(
            context,
            storageReader(context, A.StorageFolderEntriesList),
            input,
          ),
        ),
    })
    .register({
      name: A.StorageFileVersionsList,
      method: HttpMethod.Get,
      path: "/v1/storage/files/:id/versions",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<StorageFileVersion>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageFileVersion>"].parse(
          await listVersions(
            context,
            storageReader(context, A.StorageFileVersionsList),
            input,
          ),
        ),
    })
    .register({
      name: A.StorageFileUsesList,
      method: HttpMethod.Get,
      path: "/v1/storage/files/:id/uses",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<StorageFileUse>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageFileUse>"].parse(
          await listUses(
            context,
            storageReader(context, A.StorageFileUsesList),
            input,
          ),
        ),
    })
    .register({
      name: A.StorageFilesByVersion,
      method: HttpMethod.Get,
      path: "/v1/storage/file-versions/:id",
      input: contractSchemas.Empty,
      output: contractSchemas.StorageFileAtVersion,
      policy: readPolicy,
      handler: async (context) =>
        contractSchemas.StorageFileAtVersion.parse(
          await readStorageFileByVersion(
            context,
            storageReader(context, A.StorageFilesByVersion),
          ),
        ),
    })
    // A person's bytes are a raw Response served by the route below, under
    // this action's authority. The registered handler is reached only by an
    // agent's session call (files.read), which answers JSON: the same reader
    // and guard, with the bytes as base64.
    .register({
      name: A.StorageFilesContent,
      method: HttpMethod.Get,
      path: "/v1/storage/files/:id/content",
      input: contractSchemas.StorageFileContentQuery,
      output: contractSchemas.BinaryArtifact,
      // A <video> or <audio> src cannot send the organization header.
      policy: { ...readPolicy, organizationIdQuery: "organizationId" },
      handler: async (context, input) => {
        if (context.agentSession === undefined) {
          throw new StandardError({ code: "INTERNAL" });
        }
        return await readSessionContent(
          context,
          storageReader(context, A.StorageFilesContent),
          input as { range?: string; revision?: number },
        );
      },
    })
    .register({
      // The probe answer is about the blob's bytes, so it belongs to every
      // version that shares them, and a client wants it before deciding whether
      // to fetch anything at all. The route below serves it, under this action's
      // authority, the same way the content read is served.
      name: A.StorageFilesProbe,
      method: HttpMethod.Get,
      path: "/v1/storage/files/:id/probe",
      input: contractSchemas.StorageFileProbeQuery,
      output: contractSchemas.ArtifactProbeAnswer,
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas.ArtifactProbeAnswer.parse(
          await readProbe(
            context,
            storageReader(context, A.StorageFilesProbe),
            { revision: (input as { revision?: number }).revision ?? null },
          ),
        ),
    })
    .register({
      name: A.StorageFilesPut,
      method: HttpMethod.Put,
      path: "/v1/storage/files",
      input: contractSchemas.StorageFilePut,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key",
      policy: storageWritePolicy(A.StorageFilesPut),
      handler: async (context, input) =>
        contractSchemas.StorageEntry.parse(
          await putStorageFile(context, input),
        ),
    })
    .register({
      name: A.StorageFoldersCreate,
      method: HttpMethod.Post,
      path: "/v1/storage/folders",
      input: contractSchemas.StorageFolderCreate,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key",
      policy: storageWritePolicy(A.StorageFoldersCreate),
      handler: async (context, input) =>
        contractSchemas.StorageEntry.parse(
          await createStorageFolder(context, input),
        ),
    })
    .register({
      name: A.StorageEntriesCopy,
      method: HttpMethod.Post,
      path: "/v1/storage/entries/:id/copy",
      input: contractSchemas.StorageEntryDestination,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key",
      policy: storageWritePolicy(A.StorageEntriesCopy),
      handler: async (context, input) =>
        contractSchemas.StorageEntry.parse(
          await copyStorageEntry(context, input),
        ),
    })
    .register({
      name: A.StorageEntriesMove,
      method: HttpMethod.Post,
      path: "/v1/storage/entries/:id/move",
      input: contractSchemas.StorageEntryDestination,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key-and-if-match",
      successStatus: 200,
      policy: storageWritePolicy(A.StorageEntriesMove),
      handler: async (context, input) =>
        contractSchemas.StorageEntry.parse(
          await moveStorageEntry(context, input),
        ),
    })
    .register({
      // An administrator pin, by the file's own id, so the command line can set
      // it with a token: the same permission and the same pin as the artifact
      // PATCH, without an artifact id or its version.
      name: A.StorageFilesPin,
      method: HttpMethod.Put,
      path: "/v1/storage/files/:id/pin",
      input: contractSchemas.StorageFilePin,
      output: contractSchemas.ArtifactPinResult,
      explicitIdempotency: "key",
      policy: storageAdminPolicy(A.StorageFilesPin),
      handler: async (context, input) =>
        contractSchemas.ArtifactPinResult.parse(
          await pinStorageFile(
            context,
            storageReader(context, A.StorageFilesPin),
            input as { pinned: boolean },
          ),
        ),
    })
    .register({
      name: A.StorageEntriesTrash,
      method: HttpMethod.Delete,
      path: "/v1/storage/entries/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key-and-if-match",
      policy: storageWritePolicy(A.StorageEntriesTrash),
      handler: async (context) =>
        contractSchemas.StorageEntry.parse(await trashStorageEntry(context)),
    })
    .register({
      name: A.StorageEntriesRestore,
      method: HttpMethod.Post,
      path: "/v1/storage/entries/:id/restore",
      input: contractSchemas.IdPath,
      output: contractSchemas.StorageEntry,
      explicitIdempotency: "key-and-if-match",
      successStatus: 200,
      policy: storageWritePolicy(A.StorageEntriesRestore),
      handler: async (context) =>
        contractSchemas.StorageEntry.parse(await restoreStorageEntry(context)),
    })
    .register({
      name: A.StorageTrashList,
      method: HttpMethod.Get,
      path: "/v1/storage/trash",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<StorageEntry>"],
      policy: readPolicy,
      handler: async (context, input) =>
        contractSchemas["Page<StorageEntry>"].parse(
          await listTrash(context, input),
        ),
    })
    .register({
      name: A.StorageSettingsGet,
      method: HttpMethod.Get,
      path: "/v1/storage/settings",
      input: contractSchemas.Empty,
      output: contractSchemas.StorageSettings,
      policy: readPolicy,
      handler: async (context) =>
        contractSchemas.StorageSettings.parse(
          await getStorageSettings(context),
        ),
    })
    .register({
      name: A.StorageSettingsPut,
      method: HttpMethod.Put,
      path: "/v1/storage/settings",
      input: contractSchemas.StorageSettingsPut,
      output: contractSchemas.StorageSettings,
      explicitIdempotency: "key",
      policy: storageAdminPolicy(A.StorageSettingsPut),
      handler: async (context, input) =>
        contractSchemas.StorageSettings.parse(
          await putStorageSettings(context, input),
        ),
    })
    .register({
      name: A.StorageEntriesPurge,
      method: HttpMethod.Post,
      path: "/v1/storage/entries/:id/purge",
      input: contractSchemas.IdPath,
      output: contractSchemas.StoragePurgeResult,
      explicitIdempotency: "key",
      successStatus: 200,
      policy: storageAdminPolicy(A.StorageEntriesPurge),
      handler: async (context) =>
        contractSchemas.StoragePurgeResult.parse(
          await purgeStorageEntry(context),
        ),
    })
    .register({
      name: A.AgentFileGrantsCreate,
      method: HttpMethod.Post,
      path: "/v1/storage/agent-file-grants",
      input: contractSchemas.AgentFileGrantCreate,
      output: contractSchemas.AgentFileGrant,
      explicitIdempotency: "key",
      successStatus: 201,
      policy: storageAdminPolicy(A.AgentFileGrantsCreate),
      handler: async (context, input) =>
        contractSchemas.AgentFileGrant.parse(
          await createAgentFileGrant(context, input),
        ),
    })
    .register({
      name: A.AgentFileGrantsRevoke,
      method: HttpMethod.Post,
      path: "/v1/storage/agent-file-grants/:id/revoke",
      input: contractSchemas.IdPath,
      output: contractSchemas.AgentFileGrant,
      explicitIdempotency: "key-and-if-match",
      successStatus: 200,
      policy: storageAdminPolicy(A.AgentFileGrantsRevoke),
      handler: async (context) =>
        contractSchemas.AgentFileGrant.parse(
          await revokeAgentFileGrant(context),
        ),
    });
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
  // An access token reads exactly the file routes the command line calls, and
  // nothing else on this router: not storage settings, the trash, grants or
  // the library. A write on the same paths does not accept one either. A path
  // not listed here, or with a trailing slash, falls to the browser session.
  const tokenReadablePaths = [
    /^\/v1\/files\/search$/,
    /^\/v1\/storage\/roots$/,
    /^\/v1\/storage\/folders\/[^/]+\/entries$/,
    /^\/v1\/storage\/files\/[^/]+\/(?:versions|uses|content)$/,
    /^\/v1\/storage\/file-versions\/[^/]+$/,
  ];
  // The one write a token may make here: a file's pin (PUT .../pin), which the
  // action itself keeps to the permission the artifact PATCH checks.
  const tokenPinPath = /^\/v1\/storage\/files\/[^/]+\/pin$/;
  const readsAcceptTokens: MiddlewareHandler<{ Variables: AuthVariables }> = (
    context,
    next,
  ) =>
    options.tokenSession !== undefined &&
      ((context.req.method === "GET" &&
        tokenReadablePaths.some((path) => path.test(context.req.path))) ||
        (context.req.method === "PUT" && tokenPinPath.test(context.req.path)))
      ? options.tokenSession(context, next)
      : session(context, next);
  app.use("/v1/files/search", readsAcceptTokens);
  app.use("/v1/files/facts", readsAcceptTokens);
  app.use("/v1/files/library", session);
  app.use("/v1/artifacts/*", session);
  app.use("/v1/artifact-versions", session);
  app.use("/v1/artifact-preview-availability", session);
  app.use("/v1/artifact-preview-grants/*", session);
  // Running-app previews (#19): the same signed-in session, never a worker's.
  app.use("/v1/previews", session);
  app.use("/v1/previews/*", session);
  app.use("/v1/preview-grants/*", session);
  app.use("/v1/preview-availability", session);
  app.use("/v1/artifact-versions/*", session);
  // Without this a pack is built with no resolved principal and refused as an
  // anonymous call even for a signed-in Developer.
  app.use("/v1/context-packs", session);
  // Without this the blob routes run with no resolved principal, and every call
  // is refused as an anonymous one - a 403 that looks like a permission problem
  // and is really a missing middleware.
  app.use("/v1/blobs/*", session);
  app.use("/v1/storage/*", readsAcceptTokens);
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );

  const readStorageContent = createFileContentReader(options.blobStore);
  app.get("/v1/storage/files/:id/content", async (context) => {
    const { id } = contractSchemas.IdPath.parse(context.req.param());
    const range = context.req.header("Range");
    const revisionText = context.req.query("revision");
    const input = contractSchemas.StorageFileContentQuery.parse({
      range: range ?? undefined,
      revision: revisionText === undefined ? undefined : Number(revisionText),
    });
    const revision = parseRevision(revisionText);
    const action = StorageImplementedAction.StorageFilesContent;
    const result = await authority.run(
      registry.get(action),
      { ...actionContext(context), params: { id } },
      input,
      (authorizedContext) =>
        readStorageContent(
          authorizedContext,
          storageReader(authorizedContext, action),
          { revision },
        ),
    );
    return result as Response;
  });
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
