import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createDeliveryActionRegistry } from "./actions.ts";
import { createDeliveryHandlers } from "./handlers.ts";
import type { MergeDispatchDependencies } from "./merge-dispatch.ts";
import type { ReconcileDependencies } from "../integrations/reconcile.ts";

/**
 * Delivery evidence routes. They sit behind the token-accepting session
 * middleware because every action runs through `PostgresAuthorityRunner`,
 * which enforces a token's organization and scopes.
 */
export function createDeliveryRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  merge: MergeDispatchDependencies;
  registration: Omit<ReconcileDependencies, "database">;
  environmentAddress?: (environment: string) => string | null;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/runs/:id/checks", options.session);
  app.use("/v1/runs/:id/reviews", options.session);
  app.use("/v1/runs/:id/delivery-decisions", options.session);
  app.use("/v1/reviews/:id/findings", options.session);
  app.use("/v1/pull-requests", options.session);
  app.use("/v1/tasks/:id/pull-requests", options.session);
  app.use("/v1/merge-entries", options.session);
  app.use("/v1/pull-requests/:id/merge", options.session);
  app.use("/v1/merge-attempts/reconcile", options.session);
  app.use("/v1/deployments", options.session);
  app.use("/v1/deployments/:id/rollbacks", options.session);
  app.use("/v1/metrics", options.session);
  app.use("/v1/metrics/sources", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createDeliveryActionRegistry(
        options.database,
        createDeliveryHandlers(
          options.cursorSecret,
          options.merge,
          options.environmentAddress,
        ),
        { database: options.database, ...options.registration },
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
