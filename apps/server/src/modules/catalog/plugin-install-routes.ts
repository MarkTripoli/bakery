import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPluginInstallActionRegistry } from "./plugin-install-actions.ts";
import { createPluginInstallHandlers } from "./plugin-install-handlers.ts";

/**
 * Mounts the six install and state routes (#15, B14.01, slice 2).
 *
 * The paths carry no organization segment: the catalog declares them with
 * `required_authenticated_context`, so the organization comes from the caller's
 * session and never from the URL. An install id therefore numbers only among
 * rows the caller's organization owns.
 */
export function createPluginInstallRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/plugin-installs", options.browserSession);
  app.use("/v1/plugin-installs/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createPluginInstallActionRegistry(
        options.database,
        createPluginInstallHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
