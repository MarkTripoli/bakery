import { Hono } from "hono";
import type { PgDatabase } from "../../../../platform/database.ts";
import { redeemDesktopHandoff } from "../../adapters/desktop-handoff-postgres.ts";
import {
  DESKTOP_HANDOFF_PATH,
  handoffNavigationAllowed,
} from "../../domain/desktop-handoff.ts";
import { SESSION_COOKIE_NAMES, signSessionToken } from "../../middleware.ts";

/** Where a refused handoff lands: the web app's own sign-in, so the window is never a dead end. */
const SIGN_IN_PATH = "/sign-in";

/** Headers every handoff answer carries: never cached, never referred, never framed. */
function baseHeaders(location: string): Headers {
  return new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

/** The browser session cookie, the provider's own name and signed format. */
async function sessionCookie(
  token: string,
  expiresAt: Date,
  options: { publicBaseUrl: string; secret: string },
): Promise<string> {
  const secure = new URL(options.publicBaseUrl).protocol === "https:";
  const name = secure ? SESSION_COOKIE_NAMES[1] : SESSION_COOKIE_NAMES[0];
  return [
    `${name}=${await signSessionToken(token, options.secret)}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    // The session may end before the default lifetime (it never outlives its
    // desktop sign-in), so the cookie ends with it.
    `Max-Age=${
      Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
    }`,
  ].join("; ");
}

/**
 * The page the desktop window opens with a handoff code (issue #77). A good
 * code sets an ordinary browser session for the person and sends the window
 * to the page the app asked for; anything else sends it to sign-in with no
 * session set. The code is spent on the first try either way, and the 303
 * keeps it out of the window's history.
 */
export function createDesktopHandoffPage(options: {
  database: PgDatabase;
  publicBaseUrl: string;
  secret: string;
}) {
  const app = new Hono();
  app.get(DESKTOP_HANDOFF_PATH, async (context) => {
    const headers = context.req.raw.headers;
    if (!handoffNavigationAllowed(headers)) {
      return new Response(null, {
        status: 303,
        headers: baseHeaders(SIGN_IN_PATH),
      });
    }
    const requestId = headers.get("x-request-id") || crypto.randomUUID();
    const outcome = await redeemDesktopHandoff(
      options.database,
      context.req.query("code"),
      {
        correlation: { requestId, traceId: requestId },
        clientAddress:
          (context.env as { remoteAddr?: Deno.NetAddr } | undefined)
            ?.remoteAddr?.hostname ?? null,
      },
    );
    if (outcome.kind === "refused") {
      return new Response(null, {
        status: 303,
        headers: baseHeaders(SIGN_IN_PATH),
      });
    }
    const answer = baseHeaders(outcome.returnTo);
    answer.append(
      "Set-Cookie",
      await sessionCookie(outcome.token, outcome.expiresAt, options),
    );
    return new Response(null, { status: 303, headers: answer });
  });
  return app;
}
