import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createDeliveryActionRegistry } from "./actions.ts";
import { createDeliveryHandlers } from "./handlers.ts";

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
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/runs/:id/checks", options.session);
  app.use("/v1/runs/:id/reviews", options.session);
  app.use("/v1/runs/:id/delivery-decisions", options.session);
  app.use("/v1/reviews/:id/findings", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createDeliveryActionRegistry(
        options.database,
        createDeliveryHandlers(options.cursorSecret),
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
