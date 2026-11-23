import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createWorkflowActionRuntime } from "./action-runtime.ts";
import { createWorkflowsActionRegistry } from "./actions.ts";
import { createWorkflowsHandlers } from "./postgres.ts";
import type { SkillFileStoreOperations } from "../catalog/storage.ts";

export function createWorkflowsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  /**
   * Browser session or access token. Agents author workflow drafts through it
   * (chapter 25 section 11); publishing and "Use this version" need a grant,
   * and deciding a proposal needs a person.
   */
  tokenSession?: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  /** Where skill files live; needed to carry skills in a package. */
  skillFileStore?: SkillFileStoreOperations;
}) {
  // Startup proof that the workflow action runtime matches the registry.
  createWorkflowActionRuntime();
  const app = new Hono<{ Variables: AuthVariables }>();
  const authoring = options.tokenSession ?? options.browserSession;
  app.use("/v1/workflows", authoring);
  app.use("/v1/workflows/*", authoring);
  app.use("/v1/workflow-validations", authoring);
  app.use("/v1/library-packages/*", authoring);
  app.use("/v1/definition-publish-grants", options.browserSession);
  app.use("/v1/definition-publish-grants/*", options.browserSession);
  app.use("/v1/agent-power-grants", options.browserSession);
  app.use("/v1/agent-power-grants/*", options.browserSession);
  app.use(
    "/v1/workflow-definition-proposals/*",
    options.tokenSession ?? options.browserSession,
  );
  app.route(
    "/",
    createApiRouter({
      registry: createWorkflowsActionRegistry(
        options.database,
        createWorkflowsHandlers(options.cursorSecret, {
          skillFileStore: options.skillFileStore,
        }),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
