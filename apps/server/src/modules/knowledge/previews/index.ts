import { ActionRegistry } from "@bakery/contracts/action-registry";
import type { MiddlewareHandler } from "hono";
import { PostgresAuthorityRunner } from "../../auth/adapters/authority-postgres.ts";
import type { PgDatabase } from "../../../platform/database.ts";
import { artifactContentActionDefinition } from "../content-action.ts";
import { createArtifactReadHandlers } from "../reads.ts";
import { createPreviewHostHandler } from "./host.ts";
import { createRunningPreviewHandler } from "./running-host.ts";
import {
  createRunningPreviewReauthorizer,
  runningPreviewAccessActionDefinition,
} from "./running-authority.ts";
import {
  isPreviewRequestHost,
  PREVIEW_EXCHANGE_PATH,
  PREVIEW_VIEW_PREFIX,
  previewHostname,
  runningPreviewLabel,
} from "./shared.ts";

export type ArtifactPreviewHostOptions = {
  database: PgDatabase;
  /** Validated `BAKERY_ARTIFACT_PREVIEW_ORIGIN`. */
  previewOrigin: string;
  publicBaseUrl: string;
  secret: string;
  /** Host the registered ports of running-app previews are reached on. */
  upstreamHost?: string;
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
  ).register(runningPreviewAccessActionDefinition);
  const handlers = createArtifactReadHandlers(options.secret);
  const artifacts = createPreviewHostHandler({
    database: options.database,
    previewOrigin: options.previewOrigin,
    publicBaseUrl: options.publicBaseUrl,
    authority,
    contentAction: registry.get("artifactVersions.content"),
    readContent: (context) => handlers.readArtifactContent(context),
  });
  const running = createRunningPreviewHandler({
    database: options.database,
    previewOrigin: options.previewOrigin,
    publicBaseUrl: options.publicBaseUrl,
    upstreamHost: options.upstreamHost,
    reauthorize: createRunningPreviewReauthorizer(
      options.database,
      authority,
      registry.get(runningPreviewAccessActionDefinition.name),
    ),
  });
  const previewHost = previewHostname(options.previewOrigin);
  // The preview host itself shows stored artifacts; every name below it is one
  // running app's own origin (a name that is not a registered route key gets
  // the same refusal page as an ended preview).
  return (request) => {
    const hostname = previewHostname(request.url);
    if (hostname === previewHost) return artifacts(request);
    const label = runningPreviewLabel(request.url, previewHost);
    return running(request, label ?? "");
  };
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
