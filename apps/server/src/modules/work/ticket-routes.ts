import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createTicketActionRegistry } from "./ticket-actions.ts";
import type { TicketOperationDependencies } from "./ticket-operation-runner.ts";

/** Longest a ticket request may run: a preview reads up to 25 issues. */
export const TICKET_DEADLINE_MS = 30_000;

/**
 * Ticket source and external ticket routes. They sit behind the
 * token-accepting session middleware because every action runs through the
 * authority runner, which enforces a token's organization and scopes.
 */
export function createTicketRoutes(
  options: TicketOperationDependencies & {
    database: PgDatabase;
    session: MiddlewareHandler<{ Variables: AuthVariables }>;
    publicBaseUrl: string;
    cursorSecret: string;
  },
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (const path of ["/v1/ticket-sources", "/v1/external-tickets"]) {
    app.use(path, options.session);
    app.use(`${path}/*`, options.session);
  }
  app.route(
    "/",
    createApiRouter({
      registry: createTicketActionRegistry(options.database, options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
      deadlineMs: TICKET_DEADLINE_MS,
    }),
  );
  return app;
}
