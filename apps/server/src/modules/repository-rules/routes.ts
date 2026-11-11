import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createRepositoryRulesActionRegistry } from "./actions.ts";
import { createRepositoryRulesHandlers } from "./handlers.ts";

export function createRepositoryRulesRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/organizations/:id/repository-rules", options.browserSession);
  app.use(
    "/v1/organizations/:id/repository-rule-versions",
    options.browserSession,
  );
  app.use(
    "/v1/organizations/:id/repository-rule-previews",
    options.browserSession,
  );
  app.route(
    "/",
    createApiRouter({
      registry: createRepositoryRulesActionRegistry(
        options.database,
        createRepositoryRulesHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
