import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createRunRequestActionRegistry } from "./run-request-actions.ts";

/** A request read or write is small; the ceiling still bounds a slow one. */
export const RUN_REQUEST_DEADLINE_MS = 15_000;

/** Run request routes, behind the session middleware. */
export function createRunRequestRoutes(
  options: {
    database: PgDatabase;
    session: MiddlewareHandler<{ Variables: AuthVariables }>;
    cursorSecret: string;
  },
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/runs/:id/requests", options.session);
  app.use("/v1/runs/:id/requests/*", options.session);
  app.use("/v1/run-requests/*", options.session);
  app.use("/v1/runs/:id/access", options.session);
  app.use("/v1/runs/:id/access/*", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createRunRequestActionRegistry(
        options.database,
        options.cursorSecret,
      ),
      createContext: createActionContext,
      deadlineMs: RUN_REQUEST_DEADLINE_MS,
    }),
  );
  return app;
}
