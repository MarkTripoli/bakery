import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createArtifactKindsActionRegistry } from "./actions.ts";
import { createArtifactKindsHandlers } from "./handlers.ts";

/**
 * Mounts the kind routes for two path shapes.
 *
 * The router needs the route stem twice - once for `:id` and once for `:key` -
 * so registering the files twice with the same handler would be two chances for
 * one to drift. The single `app.use` on both stems keeps the middleware list
 * identical to the routes registered below it.
 */
export function createArtifactKindsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/organizations/:id/artifact-kinds", options.browserSession);
  app.use("/v1/organizations/:id/artifact-kinds/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createArtifactKindsActionRegistry(
        options.database,
        createArtifactKindsHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
