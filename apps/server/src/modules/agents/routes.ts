import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createAgentsActionRegistry } from "./actions.ts";
import { createAgentsHandlers } from "./postgres.ts";

export function createAgentsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/agents", options.browserSession);
  app.use("/v1/agents/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createAgentsActionRegistry(
        options.database,
        createAgentsHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
