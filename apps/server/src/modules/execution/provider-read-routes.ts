import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createProviderReadActionRegistry } from "./provider-read-actions.ts";
import { createProviderReadHandlers } from "./provider-reads.ts";
import { createProviderRoute, updateProviderRoute } from "./provider-writes.ts";

/**
 * The provider route and incident reads (#26 slice 2).
 *
 * Mounted under its own routes rather than folded into the execution routes so
 * the two surfaces cannot inherit each other's middleware by accident: these are
 * reads a browser session may make, and the execution routes carry their own
 * admission rules.
 */
export function createProviderReadRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/provider-routes", options.browserSession);
  app.use("/v1/provider-routes/*", options.browserSession);
  app.use("/v1/provider-incidents", options.browserSession);
  app.use("/v1/provider-incidents/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createProviderReadActionRegistry(
        options.database,
        createProviderReadHandlers(options.cursorSecret),
        { createRoute: createProviderRoute, updateRoute: updateProviderRoute },
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
