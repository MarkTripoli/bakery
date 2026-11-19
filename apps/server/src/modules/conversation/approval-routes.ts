import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import { createApprovalActionRegistry } from "../../approval-actions.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  createApprovalsListHandler,
  decideApproval,
  getApproval,
  revokeApproval,
} from "./approvals.ts";
import {
  createPlanRevisionsListHandler,
  getPlanRevision,
} from "./plan-revisions.ts";

/**
 * Plan revision and approval routes. They sit behind the token-accepting
 * session middleware so that a service account or worker token reaches the
 * handlers and is refused there with `approval_requires_human`, rather than
 * being unauthenticated.
 */
/**
 * The approvals and plan-revision registry, built once so the routes and the
 * session tool gateway (#414) run the same handlers under the same authority
 * guard rather than two registrations that could drift.
 */
export function createApprovalRegistry(options: {
  database: PgDatabase;
  cursorSecret: string;
}) {
  return createApprovalActionRegistry(
    {
      planRevisionsList: createPlanRevisionsListHandler(options.cursorSecret),
      planRevisionsGet: getPlanRevision,
      approvalsList: createApprovalsListHandler(options.cursorSecret),
      approvalsGet: getApproval,
      approvalsDecide: decideApproval,
      approvalsRevoke: revokeApproval,
    },
    {
      authorityRunner: new PostgresAuthorityRunner(options.database),
      commandRunner: createPostgresCommandRunner(),
    },
  );
}

export function createApprovalRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  registry?: ReturnType<typeof createApprovalRegistry>;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (const path of ["/v1/plan-revisions", "/v1/approvals"]) {
    app.use(path, options.session);
    app.use(`${path}/*`, options.session);
  }
  app.route(
    "/",
    createApiRouter({
      registry: options.registry ?? createApprovalRegistry(options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
