import { StandardError, toProblem } from "@bakery/contracts/http";
import type { PgDatabase } from "../../../platform/database.ts";
import {
  PREVIEW_EXCHANGE_BODY_LIMIT_BYTES,
  PREVIEW_SECRET_PATTERN,
  previewBaseHeaders,
  readRunningPreviewCookie,
  RUNNING_PREVIEW_EXCHANGE_PATH,
  RUNNING_PREVIEW_RESERVED_PREFIX,
  runningPreviewCookie,
  runningPreviewCookieName,
} from "./shared.ts";
import {
  exchangeRunningGrant,
  readExchangeableGrantOwner,
  readRunningSession,
  ROUTE_KEY_PATTERN,
  type RunningSession,
} from "./running-store.ts";
import type { RunningPreviewReauthorizer } from "./running-authority.ts";
import {
  type PreviewSocketUpgrade,
  proxyPreviewSocket,
} from "./running-socket.ts";

export type RunningPreviewHostDependencies = {
  readonly database: PgDatabase;
  /** Validated preview origin: the parent of every preview's own origin. */
  readonly previewOrigin: string;
  /** Application origin: the only origin that may post a grant. */
  readonly publicBaseUrl: string;
  /**
   * Host the registered ports are reached on. Same-machine workers only: the
   * server has no route to another machine yet. Never taken from a request.
   */
  readonly upstreamHost?: string;
  /**
   * Asks the live organization authority whether the grantor may still open
   * previews. Asked before a grant is spent and on every proxied request, so
   * a demoted, removed or disabled grantor ends a preview without a revoke.
   */
  readonly reauthorize: RunningPreviewReauthorizer;
  /** Longest a proxied request may take before the app is reported as silent. */
  readonly upstreamTimeoutMs?: number;
  /** How often an open socket asks again whether it may stay open. */
  readonly socketRecheckMs?: number;
  /** Most sockets one preview may hold open at once, counted in this server process. */
  readonly maxSocketsPerPreview?: number;
  /** Test seam replacing `Deno.upgradeWebSocket`. */
  readonly upgradeWebSocket?: PreviewSocketUpgrade;
};

const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_SOCKET_RECHECK_MS = 5_000;
const DEFAULT_MAX_SOCKETS_PER_PREVIEW = 32;

/** A paragraph: plain words, with the name of a button set in bold. */
type Paragraph = string | readonly (string | { readonly strong: string })[];

/** One wording for every refusal, so the page tells a stranger nothing. */
const ENDED_PAGE: { title: string; paragraphs: readonly Paragraph[] } = {
  title: "This preview has ended",
  paragraphs: [
    "It was stopped, reached its time limit, or you are not signed in to it on this browser. Nothing from the app is shown.",
    [
      "Go back to the task in Bakery and choose ",
      { strong: "Open preview" },
      " to start again. This page cannot do that for you: it is kept separate from your Bakery account on purpose.",
    ],
  ],
};
const SILENT_PAGE: { title: string; paragraphs: readonly Paragraph[] } = {
  title: "The app is not answering",
  paragraphs: [
    "The preview is running, but the app did not answer. It may still be starting. Reload in a moment, or check the task in Bakery.",
  ],
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function paragraphHtml(paragraph: Paragraph): string {
  if (typeof paragraph === "string") return escapeHtml(paragraph);
  return paragraph.map((part) =>
    typeof part === "string"
      ? escapeHtml(part)
      : `<strong>${escapeHtml(part.strong)}</strong>`
  ).join("");
}

/**
 * The page's one stylesheet: a card on a grey page in light and dark, from
 * nothing but this string (no font, image or file from anywhere).
 */
const PAGE_STYLE = [
  ":root{color-scheme:light dark}",
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;min-height:100vh;box-sizing:border-box;display:grid;place-items:center;background:#f4f5f7;color:#14171f}",
  "main{background:#fff;border:1px solid #dfe2e8;border-radius:8px;padding:32px;max-width:30rem;width:100%;box-sizing:border-box}",
  "h1{font-size:24px;line-height:1.25;margin:0 0 24px}",
  "p{margin:0 0 16px}",
  "footer{margin-top:24px;color:#5b6472;font-size:12px}",
  "@media (prefers-color-scheme:dark){body{background:#12161f;color:#f2f4f7}main{background:#1b212c;border-color:#2c3442}footer{color:#a3acba}}",
].join("");

/** Plain HTML: no script, no stylesheet or link from anywhere, no way back. */
function page(
  content: { title: string; paragraphs: readonly Paragraph[] },
  status: number,
): Response {
  const headers = previewBaseHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${
        escapeHtml(content.title)
      }</title><style>${PAGE_STYLE}</style></head><body><main><h1>${
        escapeHtml(content.title)
      }</h1>${
        content.paragraphs.map((text) => `<p>${paragraphHtml(text)}</p>`)
          .join("")
      }<footer>Bakery preview · this address is not Bakery itself</footer></main></body></html>`,
    { status, headers },
  );
}

/** The status is always 404 for a refusal; only the words are shared. */
function ended(): Response {
  return page(ENDED_PAGE, 404);
}

function silent(): Response {
  return page(SILENT_PAGE, 502);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers a client must never be able to steer the upstream request with. */
const NEVER_FORWARDED = new Set([
  "host",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "accept-encoding",
]);

function exchangeComesFromApp(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === appOrigin;
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "same-site";
}

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

/** Drops the preview's own cookie from what the app sees; keeps the app's. */
function withoutPreviewCookie(header: string | null, name: string) {
  if (!header) return null;
  const kept = header.split(";").map((part) => part.trim()).filter((part) =>
    part !== "" && part.slice(0, Math.max(part.indexOf("="), 0)) !== name
  );
  return kept.length === 0 ? null : kept.join("; ");
}

/** `RequestInit` plus the `duplex` option a streamed body needs. */
type StreamingRequestInit = RequestInit & { readonly duplex: "half" };

/**
 * The name of one cookie attribute as a browser reads it: what comes before the
 * first `=`, with the space and tabs around it removed (RFC 6265 section 5.2),
 * lower-cased. `Domain =x`, ` domain= x`, `DOMAIN\t=x` and a bare `Domain` all
 * name the same attribute, so none of them may be matched by its spelling.
 */
export function cookieAttributeName(attribute: string): string {
  const equals = attribute.indexOf("=");
  return (equals < 0 ? attribute : attribute.slice(0, equals)).trim()
    .toLowerCase();
}

/**
 * An app's cookie is kept to its own origin: a `Domain` attribute would reach
 * the sibling previews and could overwrite the session cookie of another
 * preview, so a cookie that names one is dropped, however it is spelled. Every
 * other attribute passes through untouched: `Path`, `Secure`, `HttpOnly`,
 * `SameSite` and the lifetimes only narrow a cookie that is already host-only.
 */
export function safeSetCookies(upstream: Headers): string[] {
  const all = typeof upstream.getSetCookie === "function"
    ? upstream.getSetCookie()
    : [];
  return all.filter((cookie) =>
    !cookie.split(";").slice(1).some((attribute) =>
      cookieAttributeName(attribute) === "domain"
    )
  );
}

/**
 * Handler for one preview's own origin. Exactly two things exist here: the
 * exchange POST under a reserved path, and the proxy to the registered port.
 * The upstream host is configuration and the port comes from the registered
 * record the session belongs to; nothing in the request names either. A
 * redirect is never followed by the server and may only point back at this
 * origin.
 */
export function createRunningPreviewHandler(
  dependencies: RunningPreviewHostDependencies,
): (request: Request, routeKey: string) => Promise<Response> {
  const appOrigin = new URL(dependencies.publicBaseUrl).origin;
  const upstreamHost = dependencies.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const timeoutMs = dependencies.upstreamTimeoutMs ??
    DEFAULT_UPSTREAM_TIMEOUT_MS;
  const recheckMs = dependencies.socketRecheckMs ?? DEFAULT_SOCKET_RECHECK_MS;
  const maxSockets = dependencies.maxSocketsPerPreview ??
    DEFAULT_MAX_SOCKETS_PER_PREVIEW;
  const upgradeWebSocket = dependencies.upgradeWebSocket ??
    ((request, options) => Deno.upgradeWebSocket(request, options));
  const openSockets = new Map<string, number>();
  const previewScheme = new URL(dependencies.previewOrigin).protocol;

  /** What the app is sent: the request's own headers, minus the ones the proxy owns. */
  const forwardedHeaders = (request: Request): Headers => {
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || NEVER_FORWARDED.has(lower)) continue;
      if (lower === "cookie") continue;
      headers.set(name, value);
    }
    const appCookies = withoutPreviewCookie(
      request.headers.get("cookie"),
      runningPreviewCookieName(dependencies.previewOrigin),
    );
    if (appCookies) headers.set("cookie", appCookies);
    return headers;
  };

  const exchange = async (request: Request, routeKey: string) => {
    if (!exchangeComesFromApp(request, appOrigin)) return ended();
    if (new URL(request.url).search !== "") return ended();
    const contentType = request.headers.get("content-type")?.toLowerCase()
      .split(";", 1)[0].trim();
    if (contentType !== "application/x-www-form-urlencoded") return ended();
    const body = await readBoundedBody(
      request,
      PREVIEW_EXCHANGE_BODY_LIMIT_BYTES,
    );
    const grant = body === null ? null : new URLSearchParams(body).get("grant");
    if (grant === null || !PREVIEW_SECRET_PATTERN.test(grant)) return ended();
    // The grantor is re-authorized before the grant is spent: a grantor who
    // has lost the right to open previews gets the same refusal as a stranger.
    const owner = await readExchangeableGrantOwner(
      dependencies.database,
      routeKey,
      grant,
    );
    if (
      owner === null ||
      !await dependencies.reauthorize(
        owner.organizationId,
        owner.principalId,
        request.signal,
      )
    ) return ended();
    const session = await exchangeRunningGrant(
      dependencies.database,
      routeKey,
      grant,
    );
    if (session === null) return ended();
    const headers = previewBaseHeaders();
    headers.set("Location", "/");
    headers.append(
      "Set-Cookie",
      runningPreviewCookie(
        dependencies.previewOrigin,
        session.secret,
        session.sessionSeconds,
      ),
    );
    return new Response(null, { status: 303, headers });
  };

  /**
   * A WebSocket on the preview's own origin. Only a page of this same origin
   * may open one (a socket is not covered by the browser's cross-origin rules,
   * so the Origin header is the check), and only up to a fixed number per
   * preview, in this server process. It is re-checked while open: see `proxyPreviewSocket`.
   */
  const socket = async (
    request: Request,
    routeKey: string,
    cookie: string,
    session: RunningSession,
  ): Promise<Response> => {
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.method !== "GET" ||
      request.headers.get("origin") !==
        `${previewScheme}//${new URL(request.url).host}`
    ) return ended();
    const open = openSockets.get(session.previewId) ?? 0;
    if (open >= maxSockets) return ended();
    openSockets.set(session.previewId, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (openSockets.get(session.previewId) ?? 1) - 1;
      if (left <= 0) openSockets.delete(session.previewId);
      else openSockets.set(session.previewId, left);
    };
    const url = new URL(request.url);
    const target = new URL(`ws://${upstreamHost}:${session.upstreamPort}`);
    target.pathname = url.pathname;
    target.search = url.search;
    try {
      return await proxyPreviewSocket({
        request,
        target,
        headers: forwardedHeaders(request),
        timeoutMs,
        recheckMs,
        upgradeWebSocket,
        unreachable: silent,
        onEnd: release,
        stillAllowed: async () => {
          const again = await readRunningSession(
            dependencies.database,
            routeKey,
            cookie,
          );
          return again !== null && await dependencies.reauthorize(
            again.organizationId,
            again.principalId,
            AbortSignal.timeout(timeoutMs),
          );
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  };

  const proxy = async (request: Request, routeKey: string) => {
    const url = new URL(request.url);
    const cookie = readRunningPreviewCookie(
      dependencies.previewOrigin,
      request.headers.get("cookie"),
    );
    if (cookie === null) return ended();
    const session = await readRunningSession(
      dependencies.database,
      routeKey,
      cookie,
    );
    if (session === null) return ended();
    if (
      !await dependencies.reauthorize(
        session.organizationId,
        session.principalId,
        request.signal,
      )
    ) return ended();
    if (request.headers.get("upgrade") !== null) {
      return await socket(request, routeKey, cookie, session);
    }

    const base = new URL(`http://${upstreamHost}:${session.upstreamPort}`);
    const target = new URL(base);
    target.pathname = url.pathname;
    target.search = url.search;
    // The host and port are fixed by configuration and the registered record.
    if (target.origin !== base.origin) return ended();

    const headers = forwardedHeaders(request);
    headers.set("accept-encoding", "identity");

    let upstream: Response;
    try {
      const init: StreamingRequestInit = {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
        // Never followed: a redirect is the app's answer, not the server's job.
        redirect: "manual",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
        // A streamed request body must say so; the DOM type does not list it yet.
        duplex: "half",
      };
      upstream = await fetch(target, init);
    } catch (_error) {
      return silent();
    }

    const out = new Headers();
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "set-cookie") continue;
      if (
        lower === "strict-transport-security" || lower === "alt-svc" ||
        lower === "public-key-pins"
      ) continue;
      out.set(name, value);
    }
    for (const setCookie of safeSetCookies(upstream.headers)) {
      out.append("set-cookie", setCookie);
    }
    out.set("referrer-policy", "no-referrer");
    out.set("x-content-type-options", "nosniff");
    out.append("vary", "Cookie");

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location !== null) {
        let resolved: URL;
        try {
          resolved = new URL(location, target);
        } catch (_error) {
          await upstream.body?.cancel();
          return silent();
        }
        // Only back into the same app, and only as a path on this origin.
        if (resolved.origin !== base.origin) {
          await upstream.body?.cancel();
          return silent();
        }
        out.set(
          "location",
          `${resolved.pathname}${resolved.search}${resolved.hash}`,
        );
      }
    }
    return new Response(
      upstream.status === 204 || upstream.status === 304 ? null : upstream.body,
      { status: upstream.status, headers: out },
    );
  };

  return async (request, routeKey) => {
    try {
      if (!ROUTE_KEY_PATTERN.test(routeKey)) return ended();
      const url = new URL(request.url);
      if (url.pathname === RUNNING_PREVIEW_EXCHANGE_PATH) {
        return request.method === "POST"
          ? await exchange(request, routeKey)
          : ended();
      }
      // The reserved prefix belongs to Bakery and is never proxied.
      if (url.pathname.startsWith(RUNNING_PREVIEW_RESERVED_PREFIX)) {
        return ended();
      }
      return await proxy(request, routeKey);
    } catch (error) {
      toProblem(new StandardError({ code: "INTERNAL", cause: error }), {
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        publicBaseUrl: dependencies.publicBaseUrl,
      });
      return ended();
    }
  };
}
