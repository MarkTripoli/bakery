import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import type { ScopedOrganizationBlobStore } from "./blob-store.ts";
import { createPluginPackageActionRegistry } from "./plugin-actions.ts";
import { createPluginPackageHandlers } from "./plugin-handlers.ts";

/**
 * Mounts the five package/version routes (#15, B14.01, slice 1).
 *
 * The paths carry no organization segment: the catalog declares them with
 * `required_authenticated_context`, so the organization comes from the caller's
 * session and never from the URL. A package id therefore numbers only among
 * rows the caller's organization published.
 */
export function createPluginPackageRoutes(options: {
  database: PgDatabase;
  bundles?: Pick<ScopedOrganizationBlobStore, "stat" | "read">;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  /**
   * Signs list cursors. A cursor that only repeated a row id could be replayed
   * against another package or another filter and re-anchor the page, so the
   * cursor is opaque and bound to the action, the caller, the organization and
   * the ordering it was issued under.
   */
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/plugin-packages", options.browserSession);
  app.use("/v1/plugin-packages/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createPluginPackageActionRegistry(
        options.database,
        createPluginPackageHandlers({
          bundles: options.bundles,
          cursorSecret: options.cursorSecret,
        }),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
