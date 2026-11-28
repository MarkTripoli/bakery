import { hasControlOrLineSeparator } from "../../../platform/control-characters.ts";

/**
 * Pure rules of the desktop handoff (issue #77, FS25 slice 5).
 *
 * The desktop window shows the server's own web pages, which authenticate with
 * the browser cookie and never accept a bearer value on a page load. The app
 * trades its `bkd_` credential for a one-use code, opens
 * `DESKTOP_HANDOFF_PATH?code=...` in its window, and the server answers with
 * an ordinary browser session for the same person and a redirect to the page
 * the app asked for. The same shape as the previews one-use grant.
 */

/** Page the desktop window opens with the code; served by the API server under `/api`. */
export const DESKTOP_HANDOFF_PATH = "/api/desktop/handoff";
/** How long a code can be spent: the app opens the page at once. */
export const DESKTOP_HANDOFF_TTL_MS = 30_000;
/** Longest return path kept. */
export const RETURN_TO_MAX_LENGTH = 2048;

/** Why the handoff page refuses; each is a page the window shows. */
export const DesktopHandoffRefusal = Object.freeze(
  {
    Missing: "desktop_handoff_missing",
    Expired: "desktop_handoff_expired",
    Used: "desktop_handoff_used",
    SignedOut: "desktop_handoff_signed_out",
  } as const,
);
export type DesktopHandoffRefusal =
  typeof DesktopHandoffRefusal[keyof typeof DesktopHandoffRefusal];

/** C0 and C1 controls, DEL and the two Unicode line separators. */
/**
 * The return path when it is a same-origin path the browser may be sent to,
 * else null: it starts with one "/", is not protocol-relative ("//" or
 * "/\\"), holds no control characters or backslashes, and resolves on the
 * server's own origin. The handoff page itself is refused, so a code can never
 * send the browser into another handoff.
 */
export function safeReturnPath(value: string): string | null {
  if (value.length === 0 || value.length > RETURN_TO_MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || hasControlOrLineSeparator(value)) return null;
  const base = "https://bakery.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  if (url.pathname === DESKTOP_HANDOFF_PATH) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can collapse "/.//host" into "//host", which a browser reads
  // as another origin; the resolved path is checked again, not only the input.
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  return path;
}

/**
 * True when a page load may spend a code. `Sec-Fetch-Site` is "none" when the
 * app navigates its own window (or the header is absent on an engine that does
 * not send it); a link or form on another site says "cross-site" or
 * "same-site" and is refused, so no page can sign a browser in as someone
 * else (login CSRF).
 */
export function handoffNavigationAllowed(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site === null || site === "none" || site === "same-origin";
}
