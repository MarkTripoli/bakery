import { storedMediaSafety } from "../media.ts";

/** A grant is exchangeable for 30 seconds, once (README: one-use grant). */
export const PREVIEW_GRANT_TTL_SECONDS = 30;
/** A preview session lasts at most five minutes. */
export const PREVIEW_SESSION_TTL_SECONDS = 300;
export const PREVIEW_EXCHANGE_PATH = "/artifact-preview/exchange";
export const PREVIEW_VIEW_PREFIX = "/artifact-preview/view/";
/** Reason a create answers 409 STATE_CONFLICT when no preview origin is set. */
export const PREVIEW_ORIGIN_NOT_CONFIGURED = "preview_origin_not_configured";

const COOKIE_BASE_NAME = "bakery_artifact_preview";
/** Largest exchange body: the field name plus a 43 character grant. */
export const PREVIEW_EXCHANGE_BODY_LIMIT_BYTES = 1_024;
export const PREVIEW_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPreviewSessionId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Response headers every preview-host response carries. */
export const PREVIEW_CONTENT_SECURITY_POLICY =
  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export function previewBaseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": PREVIEW_CONTENT_SECURITY_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Cookie name on the preview origin. A `__Host-` cookie would force Path=/ and
 * let one preview overwrite another, so https uses `__Secure-` (still host
 * only because no Domain attribute is sent) and scopes each cookie to its own
 * view path. Loopback http cannot carry a Secure cookie.
 */
export function previewCookieName(origin: string): string {
  return new URL(origin).protocol === "https:"
    ? `__Secure-${COOKIE_BASE_NAME}`
    : COOKIE_BASE_NAME;
}

/** Lower-cased hostname, no port, no trailing dot; the one preview-host key. */
export function previewHostname(urlOrOrigin: string | URL): string {
  const hostname = new URL(urlOrOrigin).hostname.toLowerCase();
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * True when the request targets the preview hostname. The port is ignored on
 * purpose: a proxy may present a non-default port on the listener's scheme, and
 * the hostname alone names the isolated origin.
 */
export function isPreviewRequestHost(
  requestUrl: string | URL,
  previewHost: string | undefined,
): boolean {
  if (previewHost === undefined) return false;
  const hostname = previewHostname(requestUrl);
  return hostname === previewHost || hostname.endsWith(`.${previewHost}`);
}

export function previewViewPath(sessionId: string): string {
  return `${PREVIEW_VIEW_PREFIX}${sessionId}`;
}

/** The `Set-Cookie` value of one session: HttpOnly, host only, view scoped. */
export function previewSessionCookie(
  origin: string,
  sessionId: string,
  secret: string,
): string {
  const secure = new URL(origin).protocol === "https:";
  return [
    `${previewCookieName(origin)}=${secret}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    `Path=${previewViewPath(sessionId)}`,
    `Max-Age=${PREVIEW_SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** Reads only the preview cookie; every other cookie is ignored. */
export function readPreviewCookie(
  origin: string,
  header: string | null,
): string | null {
  if (!header) return null;
  const name = previewCookieName(origin);
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found !== null && PREVIEW_SECRET_PATTERN.test(found) ? found : null;
}

export function randomPreviewSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

const PREVIEW_ACTIVE_TYPES: Readonly<Record<string, true>> = {
  "text/html": true,
  "image/svg+xml": true,
};

/**
 * HTML, SVG, images and text render on the preview origin. Scripts, WebAssembly
 * and other executables never do: the bytes stay downloadable only.
 */
export function isPreviewableMediaType(mediaType: string): boolean {
  const base = mediaType.split(";", 1)[0].trim().toLowerCase();
  return Object.hasOwn(PREVIEW_ACTIVE_TYPES, base) ||
    storedMediaSafety(base) === "safe";
}

export function appRevisionPath(
  taskId: string,
  artifactId: string,
  versionId: string,
): string {
  return `/tasks/${taskId}/artifacts/${artifactId}?version=${versionId}`;
}

/**
 * Running-app previews (#19). Each preview is served on its own origin,
 * `<routeKey>.<preview host>`, so one preview's scripts can never read
 * another's cookies or storage. The exchange lives under a reserved path no
 * app can claim.
 */
export const RUNNING_PREVIEW_RESERVED_PREFIX = "/_bakery/preview/";
export const RUNNING_PREVIEW_EXCHANGE_PATH =
  `${RUNNING_PREVIEW_RESERVED_PREFIX}exchange`;
const RUNNING_COOKIE_BASE_NAME = "bakery_running_preview";

/** The origin of one preview: its route key as a subdomain of the preview host. */
export function runningPreviewOrigin(origin: string, routeKey: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${routeKey}.${url.hostname}${
    url.port === "" ? "" : `:${url.port}`
  }`;
}

/**
 * The single DNS label in front of the preview host, or null when the request
 * is for the preview host itself or for a deeper name. A `__Host-` cookie is
 * host only and path `/`, so a sibling preview cannot plant one under the same
 * name with a `Domain` attribute; loopback http cannot carry it.
 */
export function runningPreviewLabel(
  requestUrl: string | URL,
  previewHost: string | undefined,
): string | null {
  if (previewHost === undefined) return null;
  const hostname = previewHostname(requestUrl);
  const suffix = `.${previewHost}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return label === "" || label.includes(".") ? null : label;
}

export function runningPreviewCookieName(origin: string): string {
  return new URL(origin).protocol === "https:"
    ? `__Host-${RUNNING_COOKIE_BASE_NAME}`
    : RUNNING_COOKIE_BASE_NAME;
}

export function runningPreviewCookie(
  origin: string,
  secret: string,
  maxAgeSeconds: number,
): string {
  const secure = new URL(origin).protocol === "https:";
  return [
    `${runningPreviewCookieName(origin)}=${secret}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** Reads only the running-preview cookie; every other cookie is ignored. */
export function readRunningPreviewCookie(
  origin: string,
  header: string | null,
): string | null {
  if (!header) return null;
  const name = runningPreviewCookieName(origin);
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found !== null && PREVIEW_SECRET_PATTERN.test(found) ? found : null;
}
