import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createGroupActionRegistry } from "./group-actions.ts";

/** A group read or write is small; the ceiling still bounds a slow one. */
export const GROUP_DEADLINE_MS = 15_000;

/** Organization group routes, behind the session middleware. */
export function createGroupRoutes(
  options: {
    database: PgDatabase;
    session: MiddlewareHandler<{ Variables: AuthVariables }>;
  },
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/groups", options.session);
  app.use("/v1/groups/*", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createGroupActionRegistry(options.database),
      createContext: createActionContext,
      deadlineMs: GROUP_DEADLINE_MS,
    }),
  );
  return app;
}
