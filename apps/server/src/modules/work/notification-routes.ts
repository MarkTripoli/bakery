import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createNotificationActionRegistry } from "./notification-actions.ts";

/** A notification read is small; a generous ceiling still bounds a slow one. */
export const NOTIFICATION_DEADLINE_MS = 15_000;

/**
 * The notification inbox routes. They sit behind the session middleware so
 * every action runs through the authority runner, which resolves the acting
 * principal and organization; the registry itself only ever addresses the
 * caller's own inbox.
 */
export function createNotificationRoutes(
  options: {
    database: PgDatabase;
    session: MiddlewareHandler<{ Variables: AuthVariables }>;
    cursorSecret: string;
  },
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/notifications", options.session);
  app.use("/v1/notifications/*", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createNotificationActionRegistry(
        options.database,
        options.cursorSecret,
      ),
      createContext: createActionContext,
      deadlineMs: NOTIFICATION_DEADLINE_MS,
    }),
  );
  return app;
}
