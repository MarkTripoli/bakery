import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  ActionAuthorityRunner,
  ActionContext,
  CommandRunner,
} from "@bakery/contracts/action-registry";
import type { ActionRegistry } from "@bakery/contracts/action-registry";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createActionContext } from "../auth/middleware.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  assertMayPublishDefinition,
  DefinitionKind,
} from "../auth/application/definition-publish-grants.ts";
import {
  createCatalogActionRegistry,
  createSkillCopyActionRegistry,
  createSkillDraftPublishActionRegistry,
  createSkillSourceUpdateActionRegistry,
  createSkillVersionActionRegistry,
} from "./actions.ts";
import { createCatalogHandlers } from "./persistence.ts";
import {
  finalizeLocalSkillVersionPublication,
  type LocalSkillVersionPublicationPreparation,
  type LocalSkillVersionPublicationProof,
  prepareLocalSkillVersionPublication,
  storeLocalSkillVersionPublication,
} from "./publication.ts";
import { SkillFileStore, type SkillFileStoreOperations } from "./storage.ts";
import type {
  normalizeSkillSourceLocator,
  SkillSourceAdapter,
} from "./source-adapters.ts";
import type { LocalSkillVersionInput } from "./validation.ts";
import {
  commitSkillCopy,
  prepareSkillCopy,
  type SkillCopyPreparation,
} from "./skill-copy.ts";
import {
  commitSkillSourceUpdate,
  prepareSkillSourceUpdate,
  readSkillSourceUpdate,
  type SkillSourceUpdatePreparation,
  type SkillSourceUpdateReading,
} from "./skill-source-update.ts";
import {
  commitSkillDraftPublish,
  prepareSkillDraftPublish,
  type SkillDraftPublishPreparation,
} from "./skill-drafts.ts";
import { CatalogImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  createGlobalSkillAuthority,
  withGlobalSkillInstall,
} from "./global-skills.ts";

const publicationExecutionStage = Symbol("publicationExecutionStage");

type PublicationExecutionStage = {
  preparation?: LocalSkillVersionPublicationPreparation;
  /** Set for a skill copy: the new skill whose version-1 `preparation` this is. */
  copy?: SkillCopyPreparation;
  /** Set for a draft publish: the draft whose next-revision `preparation` this is. */
  draft?: SkillDraftPublishPreparation;
  proof?: LocalSkillVersionPublicationProof;
};

type StagedActionContext = ActionContext & {
  [publicationExecutionStage]?: PublicationExecutionStage;
};

/**
 * skillDrafts.publish: publishing a draft is publishing a version, so an agent
 * needs the same grant (O52, #421) before anything is finalized. A person is
 * never asked for one. Exported so a test can drive an agent's context: the
 * routes mounted here take a session, not an access token.
 */
export async function publishSkillDraft(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  await assertMayPublishDefinition(transaction, context, {
    organizationId,
    principalId,
    kind: DefinitionKind.Skill,
    definitionId: context.params.id ?? null,
  });
  const stage = (context as StagedActionContext)[publicationExecutionStage];
  if (!stage?.draft || !stage.proof) {
    throw new Error("SKILL_DRAFT_PUBLISH_PROOF_MISSING");
  }
  return await commitSkillDraftPublish({
    context,
    preparation: stage.draft,
    proof: stage.proof,
  });
}

const sourceUpdateStage = Symbol("sourceUpdateStage");

/** skills.sourceUpdate in stages: what was read, then what the source answered. */
type SourceUpdateStage = {
  preparation?: SkillSourceUpdatePreparation;
  reading?: SkillSourceUpdateReading;
};

type SourceUpdateContext = ActionContext & {
  [sourceUpdateStage]?: SourceUpdateStage;
};

class SourceUpdatePreflightRollbackError extends Error {
  constructor() {
    super("SKILL_SOURCE_UPDATE_PREFLIGHT_ROLLBACK");
    this.name = "SourceUpdatePreflightRollbackError";
  }
}

class PublicationPreflightRollbackError extends Error {
  constructor() {
    super("SKILL_VERSION_PUBLICATION_PREFLIGHT_ROLLBACK");
    this.name = "PublicationPreflightRollbackError";
  }
}

export function createCatalogRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  skillFileRoot?: string;
  skillFileStore?: SkillFileStoreOperations;
  sourceAdapter?: SkillSourceAdapter;
  normalizeSourceLocator?: typeof normalizeSkillSourceLocator;
  /**
   * A registry built by the caller, so the same catalog operations can be
   * composed into another surface (the worker tool gateway) without a second
   * registration whose handler and authority could drift from these.
   */
  registry?: ActionRegistry;
}) {
  const store = options.skillFileStore ??
    (options.skillFileRoot
      ? new SkillFileStore(options.skillFileRoot)
      : undefined);
  const handlers = withGlobalSkillInstall(
    createCatalogHandlers(options.cursorSecret, {
      normalizeSourceLocator: options.normalizeSourceLocator,
      skillFileStore: store,
    }),
  );
  const postgresAuthority = new PostgresAuthorityRunner(options.database);
  const catalogAuthority = createGlobalSkillAuthority(postgresAuthority, store);
  const postgresCommandRunner = createPostgresCommandRunner();
  const publicationCommandRunner: CommandRunner = {
    async run(request) {
      const stage = (request.context as StagedActionContext)[
        publicationExecutionStage
      ];
      if (!stage || stage.proof) {
        return await postgresCommandRunner.run(request);
      }
      return await postgresCommandRunner.run({
        ...request,
        invokeAndEncode: async () => {
          const { transaction, organizationId, principalId } =
            requireWorkTransaction(request.context);
          if (request.action.name === CatalogImplementedAction.SkillsCopy) {
            stage.copy = await prepareSkillCopy({
              transaction,
              context: request.context,
              organizationId,
              principalId,
              sourceSkillId: request.context.params.id ?? "",
              input: request.input as Parameters<
                typeof prepareSkillCopy
              >[0]["input"],
              store,
            });
            stage.preparation = stage.copy.publication;
          } else if (
            request.action.name === CatalogImplementedAction.SkillDraftsPublish
          ) {
            // The prepare phase runs before the handler, so the context does not
            // carry the command metadata yet: hand it the one the runner has, so
            // the draft's If-Match is read and checked before anything is stored.
            stage.draft = await prepareSkillDraftPublish(
              Object.assign({}, request.context, {
                commandMetadata: request.metadata,
              }),
            );
            stage.preparation = stage.draft.publication;
          } else {
            stage.preparation = await prepareLocalSkillVersionPublication({
              transaction,
              input: request.input as LocalSkillVersionInput,
              organizationId,
              principalId,
            });
          }
          // Match artifact import: rollback preflight and release authority,
          // command-replay lock, and connection before immutable object I/O.
          throw new PublicationPreflightRollbackError();
        },
      });
    },
  };
  const publicationAuthority: ActionAuthorityRunner = {
    async run(action, context, input, next) {
      const stage: PublicationExecutionStage = {};
      try {
        return await postgresAuthority.run(
          action,
          Object.assign({}, context, { [publicationExecutionStage]: stage }),
          input,
          next,
        );
      } catch (error) {
        if (!(error instanceof PublicationPreflightRollbackError)) throw error;
      }
      if (!stage.preparation) {
        throw new Error("SKILL_VERSION_PUBLICATION_PREPARATION_MISSING");
      }
      if (!store) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      stage.proof = await storeLocalSkillVersionPublication(
        stage.preparation,
        store,
      );
      // Re-enter the normal authority and command runners. This reloads the
      // principal, membership, tenant actor, capability, and completed replay.
      return await postgresAuthority.run(
        action,
        Object.assign({}, context, { [publicationExecutionStage]: stage }),
        input,
        next,
      );
    },
  };
  // The source is read over the network, so no transaction may be open while it
  // is: the first pass reads the skill and gives its connection up, the fetch
  // runs with none, and a second, short pass checks the caller again and writes.
  const sourceUpdateCommandRunner: CommandRunner = {
    async run(request) {
      const stage = (request.context as SourceUpdateContext)[
        sourceUpdateStage
      ];
      if (!stage || stage.reading) {
        return await postgresCommandRunner.run(request);
      }
      return await postgresCommandRunner.run({
        ...request,
        invokeAndEncode: async () => {
          stage.preparation = await prepareSkillSourceUpdate(request.context);
          throw new SourceUpdatePreflightRollbackError();
        },
      });
    },
  };
  const sourceUpdateAuthority: ActionAuthorityRunner = {
    async run(action, context, input, next) {
      const stage: SourceUpdateStage = {};
      try {
        return await postgresAuthority.run(
          action,
          Object.assign({}, context, { [sourceUpdateStage]: stage }),
          input,
          next,
        );
      } catch (error) {
        if (!(error instanceof SourceUpdatePreflightRollbackError)) throw error;
      }
      if (!stage.preparation) {
        throw new Error("SKILL_SOURCE_UPDATE_PREPARATION_MISSING");
      }
      stage.reading = await readSkillSourceUpdate(stage.preparation, {
        adapter: options.sourceAdapter,
        store,
      });
      return await postgresAuthority.run(
        action,
        Object.assign({}, context, { [sourceUpdateStage]: stage }),
        input,
        next,
      );
    },
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/skill-sources", options.browserSession);
  app.use("/v1/skill-sources/*", options.browserSession);
  app.use("/v1/skill-imports", options.browserSession);
  app.use("/v1/skills", options.browserSession);
  app.use("/v1/skills/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: options.registry ??
        createCatalogActionRegistry(handlers, {
          authorityRunner: catalogAuthority,
          commandRunner: postgresCommandRunner,
          includeSkillVersionPublication: false,
        }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route(
    "/",
    createApiRouter({
      registry: createSkillVersionActionRegistry({
        createSkillVersion: async (context) => {
          const { transaction, organizationId, principalId } =
            requireWorkTransaction(context);
          // A skill version is published on create: an agent needs a grant
          // (O52, #421) before anything is finalized.
          await assertMayPublishDefinition(transaction, context, {
            organizationId,
            principalId,
            kind: DefinitionKind.Skill,
            definitionId: context.params.id ?? null,
          });
          const stage = (context as StagedActionContext)[
            publicationExecutionStage
          ];
          if (!stage?.preparation || !stage.proof) {
            throw new Error("SKILL_VERSION_PUBLICATION_PROOF_MISSING");
          }
          return await finalizeLocalSkillVersionPublication({
            transaction,
            context,
            preparation: stage.preparation,
            proof: stage.proof,
          });
        },
      }, {
        authorityRunner: publicationAuthority,
        commandRunner: publicationCommandRunner,
      }),
      publicBaseUrl: options.publicBaseUrl,
      maxBodyBytes: 15 * 1024 * 1024,
      createContext: createActionContext,
    }),
  );
  app.route(
    "/",
    createApiRouter({
      registry: createSkillCopyActionRegistry({
        copySkill: async (context) => {
          const { transaction, organizationId, principalId } =
            requireWorkTransaction(context);
          const stage = (context as StagedActionContext)[
            publicationExecutionStage
          ];
          if (!stage?.copy || !stage.proof) {
            throw new Error("SKILL_COPY_PROOF_MISSING");
          }
          return await commitSkillCopy({
            transaction,
            context,
            organizationId,
            principalId,
            preparation: stage.copy,
            proof: stage.proof,
          });
        },
      }, {
        authorityRunner: publicationAuthority,
        commandRunner: publicationCommandRunner,
      }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route(
    "/",
    createApiRouter({
      registry: createSkillDraftPublishActionRegistry({
        publishSkillDraft,
      }, {
        authorityRunner: publicationAuthority,
        commandRunner: publicationCommandRunner,
      }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route(
    "/",
    createApiRouter({
      registry: createSkillSourceUpdateActionRegistry({
        checkSkillSourceUpdate: async (context) => {
          const stage = (context as SourceUpdateContext)[sourceUpdateStage];
          if (!stage?.preparation || !stage.reading) {
            throw new Error("SKILL_SOURCE_UPDATE_PROOF_MISSING");
          }
          return await commitSkillSourceUpdate(
            context,
            stage.preparation,
            stage.reading,
          );
        },
      }, {
        authorityRunner: sourceUpdateAuthority,
        commandRunner: sourceUpdateCommandRunner,
      }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
