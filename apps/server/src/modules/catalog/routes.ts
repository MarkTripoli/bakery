import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  ActionAuthorityRunner,
  ActionContext,
  CommandRunner,
} from "@bakery/contracts/action-registry";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createActionContext } from "../auth/middleware.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  createCatalogActionRegistry,
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
import type { normalizeSkillSourceLocator } from "./source-adapters.ts";
import type { LocalSkillVersionInput } from "./validation.ts";

const publicationExecutionStage = Symbol("publicationExecutionStage");

type PublicationExecutionStage = {
  preparation?: LocalSkillVersionPublicationPreparation;
  proof?: LocalSkillVersionPublicationProof;
};

type StagedActionContext = ActionContext & {
  [publicationExecutionStage]?: PublicationExecutionStage;
};

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
  normalizeSourceLocator?: typeof normalizeSkillSourceLocator;
}) {
  const store = options.skillFileStore ??
    (options.skillFileRoot
      ? new SkillFileStore(options.skillFileRoot)
      : undefined);
  const handlers = createCatalogHandlers(options.cursorSecret, {
    normalizeSourceLocator: options.normalizeSourceLocator,
  });
  const postgresAuthority = new PostgresAuthorityRunner(options.database);
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
          stage.preparation = await prepareLocalSkillVersionPublication({
            transaction,
            input: request.input as LocalSkillVersionInput,
            organizationId,
            principalId,
          });
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
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/skill-sources", options.browserSession);
  app.use("/v1/skill-sources/*", options.browserSession);
  app.use("/v1/skill-imports", options.browserSession);
  app.use("/v1/skills", options.browserSession);
  app.use("/v1/skills/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createCatalogActionRegistry(handlers, {
        authorityRunner: postgresAuthority,
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
          const { transaction } = requireWorkTransaction(context);
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
  return app;
}
