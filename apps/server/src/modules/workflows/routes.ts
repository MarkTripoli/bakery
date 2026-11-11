import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createWorkflowActionRuntime } from "./action-runtime.ts";
import { createWorkflowsActionRegistry } from "./actions.ts";
import { createWorkflowsHandlers } from "./postgres.ts";

export function createWorkflowsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  // Startup proof that the workflow action runtime matches the registry.
  createWorkflowActionRuntime();
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/workflows", options.browserSession);
  app.use("/v1/workflows/*", options.browserSession);
  app.use("/v1/workflow-validations", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createWorkflowsActionRegistry(
        options.database,
        createWorkflowsHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
