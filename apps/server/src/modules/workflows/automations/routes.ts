import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../../platform/database.ts";
import {
  type AuthVariables,
  createActionContext,
} from "../../auth/middleware.ts";
import {
  createAutomationsActionRegistry,
  createAutomationsHandlers,
} from "./actions.ts";

export function createAutomationsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/automations", options.browserSession);
  app.use("/v1/automations/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createAutomationsActionRegistry(
        options.database,
        createAutomationsHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
