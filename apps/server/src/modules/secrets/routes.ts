import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter } from "@bakery/contracts/http";
import type { SecretsKeyConfig } from "@bakery/config";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { createSecretsActionRegistry } from "./actions.ts";
import { createSecretsAuthorityRunner } from "./preflight.ts";

export function createSecretsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  key?: SecretsKeyConfig;
  fetcher?: typeof fetch;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/secrets", options.browserSession);
  app.use("/v1/secrets/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createSecretsActionRegistry(
        createSecretsAuthorityRunner(
          new PostgresAuthorityRunner(options.database),
          options.key,
          options.fetcher,
        ),
        options.cursorSecret,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
