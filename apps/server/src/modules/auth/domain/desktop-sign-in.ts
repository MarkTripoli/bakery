import { hasControlOrLineSeparator } from "../../../platform/control-characters.ts";

/**
 * Pure rules of the desktop app's browser sign-in (issue #77, FS25).
 *
 * The app opens a request with a PKCE S256 challenge, the person confirms it
 * in the browser, the browser hands a one-time code to the app's redirect
 * address, and the app exchanges code plus verifier for a credential. The
 * credential is a Bakery sign-in session whose token carries the
 * `bkd_` prefix; the server accepts it as `Authorization: Bearer` wherever
 * a browser session is accepted.
 */

/** The one first-party client every server knows; no operator registers it. */
export const DESKTOP_CLIENT_ID = "bakery-desktop";
/** Visible prefix of every desktop credential, distinct from access tokens' `bky_`. */
export const DESKTOP_CREDENTIAL_PREFIX = "bkd_";
/** How long a request can be confirmed and exchanged. */
export const DESKTOP_SIGN_IN_TTL_MS = 10 * 60_000;
/**
 * Lifetime of the issued sign-in, equal to the auth provider's default
 * `session.expiresIn`; use renews it exactly as it renews a browser sign-in.
 */
export const DESKTOP_SESSION_TTL_MS = 7 * 86_400_000;
/** The app link the desktop app registers with the operating system. */
export const DESKTOP_APP_LINK_REDIRECT = "bakery://auth/callback";
/** Longest computer name kept. */
export const COMPUTER_NAME_MAX_LENGTH = 64;

/** Why an exchange or a confirmation page refuses; the app shows its own copy per reason. */
export const DesktopSignInRefusal = Object.freeze(
  {
    Expired: "desktop_sign_in_expired",
    Used: "desktop_sign_in_used",
    Cancelled: "desktop_sign_in_cancelled",
    Pending: "desktop_sign_in_pending",
    Mismatch: "desktop_sign_in_mismatch",
  } as const,
);
export type DesktopSignInRefusal =
  typeof DesktopSignInRefusal[keyof typeof DesktopSignInRefusal];

export const DesktopSignInDecision = Object.freeze(
  { Approved: "approved", Cancelled: "cancelled" } as const,
);
export type DesktopSignInDecision =
  typeof DesktopSignInDecision[keyof typeof DesktopSignInDecision];

/** The state of one stored request that the rules below read. */
export type DesktopSignInRequestState = {
  clientId: string;
  expiresAt: Date;
  decision: DesktopSignInDecision | null;
  consumedAt: Date | null;
};

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CREDENTIAL = new RegExp(
  `^Bearer[ \\t]+(${DESKTOP_CREDENTIAL_PREFIX}[A-Za-z0-9_-]{43})$`,
);
const LOOKS_LIKE_DESKTOP = new RegExp(
  `^Bearer[ \\t]+${DESKTOP_CREDENTIAL_PREFIX}`,
);
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/** 32 random bytes, base64url: the one-time code and the credential body. */
export function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A new desktop credential; it is also the session token stored for it. */
export function generateDesktopCredential(): string {
  return `${DESKTOP_CREDENTIAL_PREFIX}${randomSecret()}`;
}

/**
 * A desktop web view cannot set headers on a WebSocket, only subprotocols, so
 * a live-update socket may carry the credential as the subprotocol pair
 * `bakery.desktop, bakery.credential.<credential>`. The server answers with
 * `bakery.desktop` alone, so the credential is never echoed back.
 */
export const DESKTOP_SOCKET_PROTOCOL = "bakery.desktop";
const SOCKET_CREDENTIAL_PREFIX = "bakery.credential.";
/** The live-update sockets a web view opens; the only routes that read the carrier. */
export const DESKTOP_SOCKET_PATHS: ReadonlySet<string> = new Set([
  "/v1/events",
  "/v1/collaboration",
]);

function socketProtocols(headers: Headers): string[] {
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") return [];
  return (headers.get("sec-websocket-protocol") ?? "").split(",")
    .map((value) => value.trim()).filter((value) => value !== "");
}

/**
 * True when a WebSocket upgrade offers the desktop subprotocol; the upgrade
 * must then select it, or the web view drops the connection.
 */
export function offersDesktopSocketProtocol(headers: Headers): boolean {
  return socketProtocols(headers).includes(DESKTOP_SOCKET_PROTOCOL);
}

/**
 * The Authorization value a request authenticates with: the header itself,
 * or, on a WebSocket upgrade of one of the socket routes that offers the
 * desktop subprotocol and carries exactly one credential entry, that
 * credential as a bearer value. The carrier yields only a desktop credential,
 * never an access token, and never applies to any other route.
 */
export function desktopAuthorization(
  headers: Headers,
  path?: string,
): string | null {
  const header = headers.get("authorization");
  if (header !== null) return header;
  // The carrier is read only on the two socket routes; anywhere else a
  // request authenticates with the header or the cookie, never the carrier.
  if (path === undefined || !DESKTOP_SOCKET_PATHS.has(path)) return null;
  const protocols = socketProtocols(headers);
  if (!protocols.includes(DESKTOP_SOCKET_PROTOCOL)) return null;
  const carried = protocols.filter((value) =>
    value.startsWith(SOCKET_CREDENTIAL_PREFIX)
  );
  if (carried.length !== 1) return null;
  const credential = carried[0].slice(SOCKET_CREDENTIAL_PREFIX.length);
  return credential.startsWith(DESKTOP_CREDENTIAL_PREFIX)
    ? `Bearer ${credential}`
    : null;
}

/** The upgrade option that selects the desktop subprotocol when it was offered. */
export function desktopSocketUpgrade(
  headers: Headers,
): { protocol?: string } {
  return offersDesktopSocketProtocol(headers)
    ? { protocol: DESKTOP_SOCKET_PROTOCOL }
    : {};
}

/** True when an Authorization header claims to carry a desktop credential, well formed or not. */
export function claimsDesktopCredential(header: string | null): boolean {
  return header !== null && LOOKS_LIKE_DESKTOP.test(header);
}

/** The desktop credential in an Authorization header, or null when there is none or it is malformed. */
export function desktopCredentialFromAuthorization(
  header: string | null,
): string | null {
  if (header === null) return null;
  const match = CREDENTIAL.exec(header);
  return match ? match[1] : null;
}

export function isCodeChallenge(value: string): boolean {
  return BASE64URL_43.test(value);
}

export function isOneTimeCode(value: string): boolean {
  return BASE64URL_43.test(value);
}

export function isCodeVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

/** Length-independent comparison so a mismatch position leaks nothing. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** RFC 7636 S256: base64url(SHA-256(verifier)) equals the challenge. */
export async function pkceMatches(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  return constantTimeEqual(await sha256Base64Url(verifier), challenge);
}

/**
 * The redirect address in canonical form, or null when it is not one the
 * desktop app may use: plain http on an IP loopback literal with an explicit
 * port (RFC 8252 section 7.3), or the app link. No credentials, query or
 * fragment, so the code can only arrive on this computer.
 */
export function canonicalDesktopRedirect(value: string): string | null {
  if (value === DESKTOP_APP_LINK_REDIRECT) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return null;
  if (url.port === "" || url.username || url.password) return null;
  if (url.search !== "" || url.hash !== "" || value.includes("#")) return null;
  if (value.includes("?")) return null;
  return url.href;
}

/** The computer name trimmed, or null when it is empty, too long or holds control characters. */
export function normalizeComputerName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > COMPUTER_NAME_MAX_LENGTH) return null;
  return hasControlOrLineSeparator(name) ? null : name;
}

/** The Active sessions label of a desktop sign-in. */
export function desktopSessionLabel(computerName: string): string {
  return `Bakery app · ${computerName}`;
}

/** What the browser page shows for a request, in the design's refusal order. */
export type DesktopSignInPageState =
  | "confirm"
  | "missing"
  | "expired"
  | "used"
  | "cancelled";

export function pageStateFor(
  request: DesktopSignInRequestState | null,
  now: Date,
): DesktopSignInPageState {
  if (request === null || request.clientId !== DESKTOP_CLIENT_ID) {
    return "missing";
  }
  // A cancelled request signed nothing in, so it never reads as "used".
  if (
    request.decision === DesktopSignInDecision.Cancelled &&
    request.consumedAt === null
  ) return "cancelled";
  if (request.decision !== null || request.consumedAt !== null) return "used";
  if (request.expiresAt.getTime() <= now.getTime()) return "expired";
  return "confirm";
}

/**
 * The refusal an exchange gets before any secret is compared, or null when
 * the request is confirmed, unexpired and unspent. `burn` says the attempt
 * spends the request; `revokeIssued` says a replay must end the sign-in the
 * first exchange issued (RFC 6749 section 4.1.2).
 */
export function exchangeRefusalFor(
  request: DesktopSignInRequestState,
  clientId: string,
  now: Date,
):
  | { reason: DesktopSignInRefusal; burn: boolean; revokeIssued: boolean }
  | null {
  if (request.consumedAt !== null) {
    return {
      reason: DesktopSignInRefusal.Used,
      burn: false,
      revokeIssued: true,
    };
  }
  if (clientId !== DESKTOP_CLIENT_ID || request.clientId !== clientId) {
    return {
      reason: DesktopSignInRefusal.Mismatch,
      burn: true,
      revokeIssued: false,
    };
  }
  if (request.decision === DesktopSignInDecision.Cancelled) {
    return {
      reason: DesktopSignInRefusal.Cancelled,
      burn: false,
      revokeIssued: false,
    };
  }
  if (request.expiresAt.getTime() <= now.getTime()) {
    return {
      reason: DesktopSignInRefusal.Expired,
      burn: false,
      revokeIssued: false,
    };
  }
  if (request.decision === null) {
    return {
      reason: DesktopSignInRefusal.Pending,
      burn: false,
      revokeIssued: false,
    };
  }
  return null;
}
