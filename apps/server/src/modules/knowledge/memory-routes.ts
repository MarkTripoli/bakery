import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createMemoryActionRegistry } from "./memory-actions.ts";
import { createMemoryHandlers } from "./memory-handlers.ts";

/**
 * Mounts the six memory routes (#22).
 *
 * Memory paths carry no organization segment: the catalog declares them with
 * `organizationContext: "none"`, so the organization comes from the caller's
 * authenticated context and never from the URL. That is why a memory id numbers
 * only among rows the caller's organization owns.
 */
export function createMemoryRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/memories", options.browserSession);
  app.use("/v1/memories/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createMemoryActionRegistry(
        options.database,
        createMemoryHandlers(),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
