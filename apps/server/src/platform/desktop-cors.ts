import type { MiddlewareHandler } from "hono";

/**
 * Cross-origin access for the desktop app's web view (#77).
 *
 * The desktop client loads the shared web pages from its own origin (`tauri://localhost` on
 * macOS and Linux, `http(s)://tauri.localhost` on Windows) and calls the server with a bearer
 * credential. A browser engine refuses that call unless the server answers the preflight and
 * names the origin in the response, which was the one thing the spike's web view could not do
 * against this server.
 *
 * Narrow by construction:
 * - only the configured desktop origins are answered; any other origin sees no CORS header;
 * - the origin is echoed, never `*`, and `Vary: Origin` says so;
 * - credentials are never allowed: a cookie from a desktop origin is not sent cross-origin and
 *   the cookie origin guard still refuses it, so this opens the bearer path and nothing else;
 * - a WebSocket upgrade is left alone: CORS does not apply to it and its response cannot be
 *   rewritten.
 */
export const DESKTOP_CORS_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** Request headers the shared web client and the API's own contracts use. */
export const DESKTOP_CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "bakery-organization-id",
  "range",
  "accept-language",
  "x-request-id",
  "traceparent",
] as const;

/** Response headers a page needs to read: concurrency tags, links, retry hints, trace ids. */
export const DESKTOP_CORS_EXPOSED_HEADERS = [
  "etag",
  "location",
  "retry-after",
  "x-request-id",
  "x-trace-id",
  "idempotent-replayed",
  "content-range",
  "link",
] as const;

const PREFLIGHT_MAX_AGE_SECONDS = "600";

function withHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  try {
    for (const [name, value] of Object.entries(headers)) {
      if (name === "vary") response.headers.append(name, value);
      else response.headers.set(name, value);
    }
    return response;
  } catch {
    // A response with immutable headers is copied, not skipped: the page must still be able to
    // read an error.
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) {
      if (name === "vary") copy.headers.append(name, value);
      else copy.headers.set(name, value);
    }
    return copy;
  }
}

export function createDesktopCors(
  options: { origins: readonly string[] | undefined },
): MiddlewareHandler {
  const allowed = new Set(options.origins ?? []);
  return async (context, next) => {
    const origin = context.req.header("origin");
    if (allowed.size === 0 || origin === undefined) return await next();
    if (!allowed.has(origin)) {
      // The answer depends on the origin, so a shared cache must not reuse it for another.
      await next();
      context.res = withHeaders(context.res, { vary: "Origin" });
      return;
    }
    const upgrade =
      (context.req.header("upgrade") ?? "").toLowerCase() === "websocket";
    if (
      context.req.method === "OPTIONS" &&
      context.req.header("access-control-request-method") !== undefined
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": DESKTOP_CORS_ALLOWED_METHODS.join(
            ", ",
          ),
          "access-control-allow-headers": DESKTOP_CORS_ALLOWED_HEADERS.join(
            ", ",
          ),
          "access-control-max-age": PREFLIGHT_MAX_AGE_SECONDS,
          vary: "Origin",
        },
      });
    }
    await next();
    if (upgrade) return;
    context.res = withHeaders(context.res, {
      "access-control-allow-origin": origin,
      "access-control-expose-headers": DESKTOP_CORS_EXPOSED_HEADERS.join(", "),
      vary: "Origin",
    });
  };
}
