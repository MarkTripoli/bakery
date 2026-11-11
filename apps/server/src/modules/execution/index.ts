import { Hono } from "hono";
import type { AuthVariables } from "../auth/middleware.ts";
import { artifact } from "../knowledge/routes.ts";
import { createArtifactResourceRoutes } from "../knowledge/resource-routes.ts";
import {
  createExecutionRoutes as createBaseExecutionRoutes,
  type ExecutionRoutesOptions,
} from "./routes.ts";

export function createExecutionRoutes(
  options: ExecutionRoutesOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = createBaseExecutionRoutes(options);
  app.route("/", createArtifactResourceRoutes(options));
  app.post(
    "/v1/worker/attempts/:id/artifacts",
    (context) => artifact(context, options),
  );
  return app;
}

export { reclaimExpiredAttempts } from "@bakery/persistence/attempts";
