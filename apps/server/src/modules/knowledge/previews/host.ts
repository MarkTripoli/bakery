import type {
  ActionAuthorityRunner,
  ActionContext,
  ActionDefinition,
} from "@bakery/contracts/action-registry";
import { StandardError, toProblem } from "@bakery/contracts/http";
import type { PgDatabase } from "../../../platform/database.ts";
import { sha256Hex } from "../../../platform/canonical-json.ts";
import {
  appRevisionPath,
  isPreviewableMediaType,
  isPreviewSessionId,
  PREVIEW_EXCHANGE_BODY_LIMIT_BYTES,
  PREVIEW_EXCHANGE_PATH,
  PREVIEW_SECRET_PATTERN,
  PREVIEW_VIEW_PREFIX,
  previewBaseHeaders,
  previewSessionCookie,
  previewViewPath,
  readPreviewCookie,
  timingSafeEqualHex,
} from "./shared.ts";
import { exchangePreviewGrant, readPreviewSession } from "./store.ts";

export type PreviewHostDependencies = {
  readonly database: PgDatabase;
  /** Validated preview origin: scheme, host and port of this isolated host. */
  readonly previewOrigin: string;
  /** Application origin that owns the canonical revision link. */
  readonly publicBaseUrl: string;
  /** The same live authority runner every Bakery read goes through. */
  readonly authority: ActionAuthorityRunner;
  /** The registered `artifactVersions.content` action definition. */
  readonly contentAction: ActionDefinition;
  /** Reads verified stored bytes inside an authorized transaction. */
  readonly readContent: (context: ActionContext) => Promise<Response>;
};

export type PreviewNotice =
  | "unavailable"
  | "closed"
  | "expired"
  | "forbidden"
  | "refused"
  | "tombstone"
  | "unsupported"
  | "failed";

const NOTICES: Readonly<
  Record<PreviewNotice, { status: number; title: string; body: string }>
> = {
  unavailable: {
    status: 404,
    title: "Preview not available",
    body:
      "This preview link is not valid, or it has expired. Open the artifact in Bakery and prepare a new preview.",
  },
  closed: {
    status: 410,
    title: "Preview closed",
    body:
      "This preview was closed. Open the artifact in Bakery to start again.",
  },
  expired: {
    status: 410,
    title: "Preview expired",
    body:
      "This preview session ended. Open the artifact in Bakery and prepare a new preview.",
  },
  forbidden: {
    status: 403,
    title: "Access ended",
    body: "The person who opened this preview can no longer read the artifact.",
  },
  refused: {
    status: 403,
    title: "Preview not opened",
    body:
      "This preview must be opened from Bakery. Open the artifact there and prepare a new preview.",
  },
  tombstone: {
    status: 410,
    title: "Content expired",
    body:
      "Retention removed these bytes. The revision record remains in Bakery.",
  },
  unsupported: {
    status: 415,
    title: "Not previewable",
    body: "This media type is not previewed. Download it from Bakery instead.",
  },
  failed: {
    status: 500,
    title: "Preview failed",
    body: "The preview could not be rendered. Try again from Bakery.",
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function noticeResponse(notice: PreviewNotice, canonical?: string): Response {
  const { status, title, body } = NOTICES[notice];
  const headers = previewBaseHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (canonical) headers.set("Link", `<${canonical}>; rel="canonical"`);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${
        escapeHtml(title)
      }</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem}</style>` +
      `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>` +
      `</body></html>`,
    { status, headers },
  );
}

/**
 * The exchange is a form POST that only the Bakery app page should send. A
 * present `Origin` must equal the app origin (so `null` and any other site are
 * refused); without one, only `Sec-Fetch-Site: same-origin` or `same-site`
 * passes. This stops an attacker planting their own grant in a victim browser.
 */
function exchangeComesFromApp(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === appOrigin;
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "same-site";
}

/** Reads at most `limit` bytes of a request body, or null when it is longer. */
async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function withCharset(contentType: string): string {
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  const textual = base.startsWith("text/") || base === "application/json" ||
    base === "application/xml" || base === "image/svg+xml";
  return textual && !/;\s*charset=/i.test(contentType)
    ? `${contentType}; charset=utf-8`
    : contentType;
}

/**
 * Handler for the isolated preview host. Only the exchange POST and the view
 * GET exist; every other request is a bare 404. Nothing here reads a Bakery
 * cookie or authorization header, and nothing logs a body or a cookie.
 */
export function createPreviewHostHandler(
  dependencies: PreviewHostDependencies,
): (request: Request) => Promise<Response> {
  const appOrigin = new URL(dependencies.publicBaseUrl).origin;
  const exchange = async (request: Request): Promise<Response> => {
    if (!exchangeComesFromApp(request, appOrigin)) {
      return noticeResponse("refused");
    }
    // A grant never travels in a URL: any query string is refused unread.
    if (new URL(request.url).search !== "") {
      return noticeResponse("unavailable");
    }
    const contentType = request.headers.get("content-type")?.toLowerCase()
      .split(";", 1)[0].trim();
    if (contentType !== "application/x-www-form-urlencoded") {
      return noticeResponse("unsupported");
    }
    const body = await readBoundedBody(
      request,
      PREVIEW_EXCHANGE_BODY_LIMIT_BYTES,
    );
    const grant = body === null ? null : new URLSearchParams(body).get("grant");
    if (grant === null || !PREVIEW_SECRET_PATTERN.test(grant)) {
      return noticeResponse("unavailable");
    }
    const session = await exchangePreviewGrant(dependencies.database, grant);
    if (session === null) return noticeResponse("unavailable");
    const headers = previewBaseHeaders();
    headers.set("Location", previewViewPath(session.sessionId));
    headers.append(
      "Set-Cookie",
      previewSessionCookie(
        dependencies.previewOrigin,
        session.sessionId,
        session.secret,
      ),
    );
    return new Response(null, { status: 303, headers });
  };

  const view = async (request: Request, sessionId: string) => {
    const record = await readPreviewSession(dependencies.database, sessionId);
    const cookie = readPreviewCookie(
      dependencies.previewOrigin,
      request.headers.get("cookie"),
    );
    // Without the matching cookie the session's state is not disclosed.
    if (
      record === null || cookie === null ||
      !timingSafeEqualHex(await sha256Hex(cookie), record.sessionHash)
    ) return noticeResponse("unavailable");
    const canonical = new URL(
      appRevisionPath(record.taskId, record.artifactId, record.versionId),
      dependencies.publicBaseUrl,
    ).href;
    if (record.revoked) return noticeResponse("closed", canonical);
    if (record.expired) return noticeResponse("expired", canonical);
    const subject = await dependencies.database.query<{
      id: string;
      principal_type: string;
      display_name: string;
    }>(
      `select id, principal_type, display_name from bakery.principals
        where id = $1 and disabled_at is null`,
      [record.principalId],
    );
    const principal = subject.rows[0];
    if (!principal) return noticeResponse("forbidden", canonical);
    const synthetic: ActionContext = {
      // Only the grantor's organization is named; no cookie or credential of
      // the viewer is read, so the live authority is the grantor's.
      request: new Request("http://artifact-preview.invalid/", {
        headers: { "Bakery-Organization-Id": record.organizationId },
      }),
      params: { id: record.versionId },
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      signal: request.signal,
      principal: {
        principalId: principal.id,
        principalType: principal.principal_type,
        displayName: principal.display_name,
      },
    };
    let upstream: Response;
    try {
      upstream = await dependencies.authority.run(
        dependencies.contentAction,
        synthetic,
        {},
        (authorized) => dependencies.readContent(authorized),
      ) as Response;
    } catch (error) {
      if (error instanceof StandardError) {
        if (error.code === "ARTIFACT_CONTENT_EXPIRED") {
          return noticeResponse("tombstone", canonical);
        }
        if (
          error.code === "AUTH_FORBIDDEN" ||
          error.code === "RESOURCE_NOT_FOUND" ||
          error.code === "SCOPE_REQUIRED" ||
          error.code === "INSUFFICIENT_SCOPE"
        ) return noticeResponse("forbidden", canonical);
      }
      throw error;
    }
    const mediaType = upstream.headers.get("content-type") ??
      "application/octet-stream";
    if (!isPreviewableMediaType(mediaType)) {
      await upstream.body?.cancel();
      return noticeResponse("unsupported", canonical);
    }
    const headers = previewBaseHeaders();
    headers.set("Content-Type", withCharset(mediaType));
    headers.set("Link", `<${canonical}>; rel="canonical"`);
    headers.set("Vary", "Cookie");
    return new Response(upstream.body, { status: 200, headers });
  };

  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === PREVIEW_EXCHANGE_PATH) {
        return await exchange(request);
      }
      if (
        request.method === "GET" && url.pathname.startsWith(PREVIEW_VIEW_PREFIX)
      ) {
        const sessionId = url.pathname.slice(PREVIEW_VIEW_PREFIX.length);
        if (isPreviewSessionId(sessionId)) {
          return await view(request, sessionId);
        }
      }
      return noticeResponse("unavailable");
    } catch (error) {
      // The shared problem path reports a 5xx to monitoring, which keeps only
      // a sanitized stack: no request, cookie or body ever reaches it.
      toProblem(new StandardError({ code: "INTERNAL", cause: error }), {
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        publicBaseUrl: dependencies.publicBaseUrl,
      });
      return noticeResponse("failed");
    }
  };
}
