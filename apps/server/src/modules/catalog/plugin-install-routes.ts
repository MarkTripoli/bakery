import { Hono, type MiddlewareHandler } from "hono";
import { createApiRouter, problemResponse } from "@bakery/contracts/http";
import { coerceQueryInput } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  createPluginInstallActionRegistry,
  pluginPageDocumentActionDefinition,
} from "./plugin-install-actions.ts";
import { createPluginInstallHandlers } from "./plugin-install-handlers.ts";
import {
  type PluginPageDependencies,
  readPluginPageDocument,
} from "./plugin-pages.ts";

/**
 * Mounts the install, state and page routes (#15, B14.01, slice 2; #76).
 *
 * The paths carry no organization segment: the catalog declares them with
 * `required_authenticated_context`, so the organization comes from the caller's
 * session and never from the URL. An install id therefore numbers only among
 * rows the caller's organization owns.
 *
 * A page's document is raw HTML rather than JSON, so it has its own route,
 * mounted ahead of the JSON router, that runs the same action's authority and
 * returns the response the page read builds.
 */
export function createPluginInstallRoutes(
  options: {
    database: PgDatabase;
    browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
    publicBaseUrl: string;
    cursorSecret: string;
  } & PluginPageDependencies,
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/plugin-installs", options.browserSession);
  app.use("/v1/plugin-installs/*", options.browserSession);
  app.use("/v1/plugin-pages", options.browserSession);
  const registry = createPluginInstallActionRegistry(
    options.database,
    createPluginInstallHandlers(options.cursorSecret),
  );
  const authority = new PostgresAuthorityRunner(options.database);
  const documentAction = registry.get(pluginPageDocumentActionDefinition.name);
  app.get(
    "/v1/plugin-installs/:id/pages/:pageId/document",
    async (context) => {
      try {
        const params = context.req.param();
        const input = contractSchemas.PluginPageDocumentQuery.parse({
          ...coerceQueryInput(
            contractSchemas.PluginPageDocumentQuery,
            Object.fromEntries(
              new URL(context.req.url).searchParams.entries(),
            ),
          ),
          id: params.id,
          pageId: params.pageId,
        });
        const result = await authority.run(
          documentAction,
          {
            request: context.req.raw,
            params,
            requestId: context.req.header("x-request-id") ??
              crypto.randomUUID(),
            traceId: context.req.header("x-trace-id") ?? crypto.randomUUID(),
            signal: context.req.raw.signal,
            ...createActionContext(context),
          },
          input,
          (authorizedContext) =>
            readPluginPageDocument(authorizedContext, input, {
              bundles: options.bundles,
            }),
        );
        return result as Response;
      } catch (error) {
        return problemResponse(context, error, {
          publicBaseUrl: options.publicBaseUrl,
        });
      }
    },
  );
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
