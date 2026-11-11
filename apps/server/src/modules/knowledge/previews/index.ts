import { ActionRegistry } from "@bakery/contracts/action-registry";
import type { MiddlewareHandler } from "hono";
import { PostgresAuthorityRunner } from "../../auth/adapters/authority-postgres.ts";
import type { PgDatabase } from "../../../platform/database.ts";
import { artifactContentActionDefinition } from "../content-action.ts";
import { createArtifactReadHandlers } from "../reads.ts";
import { createPreviewHostHandler } from "./host.ts";
import {
  isPreviewRequestHost,
  PREVIEW_EXCHANGE_PATH,
  PREVIEW_VIEW_PREFIX,
  previewHostname,
} from "./shared.ts";

export type ArtifactPreviewHostOptions = {
  database: PgDatabase;
  /** Validated `BAKERY_ARTIFACT_PREVIEW_ORIGIN`. */
  previewOrigin: string;
  publicBaseUrl: string;
  secret: string;
};

/**
 * Builds the handler for requests whose `Host` is the preview origin. It reads
 * through the same `artifactVersions.content` authority as the application, but
 * as the grantor, so a removed membership or a purged version ends the preview.
 */
export function createArtifactPreviewHost(
  options: ArtifactPreviewHostOptions,
): (request: Request) => Promise<Response> {
  const authority = new PostgresAuthorityRunner(options.database);
  const registry = new ActionRegistry(authority).register(
    artifactContentActionDefinition,
  );
  const handlers = createArtifactReadHandlers(options.secret);
  return createPreviewHostHandler({
    database: options.database,
    previewOrigin: options.previewOrigin,
    publicBaseUrl: options.publicBaseUrl,
    authority,
    contentAction: registry.get("artifactVersions.content"),
    readContent: (context) => handlers.readArtifactContent(context),
  });
}

/** True for a path owned by the preview host; the app host must not serve it. */
export function isArtifactPreviewPath(pathname: string): boolean {
  return pathname === PREVIEW_EXCHANGE_PATH ||
    pathname === "/artifact-preview" ||
    pathname.startsWith("/artifact-preview/") ||
    pathname.startsWith(PREVIEW_VIEW_PREFIX);
}

/**
 * First middleware of the application. A request whose `Host` is the preview
 * host goes to the preview handler alone, before any Bakery middleware, cookie
 * or header handling. On every other host the preview paths do not exist.
 */
export function createPreviewHostDispatch(
  previewOrigin: string | undefined,
  handler: ((request: Request) => Promise<Response>) | undefined,
): MiddlewareHandler {
  const previewHost = previewOrigin
    ? previewHostname(previewOrigin)
    : undefined;
  return async (context, next) => {
    const url = new URL(context.req.url);
    if (handler && isPreviewRequestHost(url, previewHost)) {
      return await handler(context.req.raw);
    }
    if (isArtifactPreviewPath(url.pathname)) return context.notFound();
    await next();
  };
}
