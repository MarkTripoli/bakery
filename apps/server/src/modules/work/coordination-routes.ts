import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import { createCoordinationActionRegistry } from "../../coordination-actions.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  cancelCoordinationPlanCommand,
  createCoordinationPlanCommand,
  createCoordinationPlanFromWorkflowCommand,
  materializeCoordinationPlanCommand,
  setApplicationRepositoryRoleCommand,
  setTaskRepositoryCommand,
} from "./coordination-command.ts";
import { createCoordinationQueryHandlers } from "./coordination-query.ts";

/**
 * Coordination routes. `/v1/tasks/*` and `/v1/applications/*` already sit
 * behind the session middleware registered by the task and project routers;
 * only the plan collection needs its own.
 */
export function createCoordinationRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const queries = createCoordinationQueryHandlers(options.cursorSecret);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/coordination-plans", options.session);
  app.use("/v1/coordination-plans/*", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createCoordinationActionRegistry(
        {
          plansCreate: createCoordinationPlanCommand,
          plansCreateFromWorkflow: createCoordinationPlanFromWorkflowCommand,
          plansList: queries.plansList,
          plansGet: queries.plansGet,
          plansMaterialize: materializeCoordinationPlanCommand,
          plansCancel: cancelCoordinationPlanCommand,
          taskRepositoriesList: queries.taskRepositoriesList,
          taskRepositoriesSet: setTaskRepositoryCommand,
          rolesList: queries.rolesList,
          rolesSet: setApplicationRepositoryRoleCommand,
        },
        {
          authorityRunner: new PostgresAuthorityRunner(options.database),
          commandRunner: createPostgresCommandRunner(),
        },
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
