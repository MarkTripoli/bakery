import { Hono } from "hono";
import type { ActionRegistry } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { createTranslator } from "@bakery/i18n";
import type { PgDatabase } from "../../../../platform/database.ts";
import { requestLocale } from "../../../../platform/locale.ts";
import type { IdentityStore } from "../../application/identity.ts";
import type { SessionStore } from "../../adapters/postgres.ts";
import { REMOTE_ADDRESS_HEADER } from "../../adapters/better-auth.ts";
import {
  type BrowserSessionAuth,
  createBrowserSessionMiddleware,
} from "../../middleware.ts";
import type { InstallationSettingsReader } from "../../application/installation-settings.ts";
import { createAuthV1Routes } from "./v1/routes.ts";

export type AuthHttpProvider = BrowserSessionAuth & {
  handler(request: Request): Promise<Response>;
};

const invitationLookupPaths = new Set([
  "/api/auth/organization/get-invitation",
  "/api/auth/organization/accept-invitation",
  "/api/auth/organization/reject-invitation",
]);

const invitationNotFoundCodes = new Set([
  "INVITATION_NOT_FOUND",
  "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
]);

/**
 * The identity provider distinguishes "no such invitation" from "not yours"
 * with 400/403 bodies. Collapsing both to 404 stops callers from probing which
 * invitations exist. Pure so it can be unit tested without a provider.
 */
export function isInvitationNotFound(
  pathname: string,
  status: number,
  body: unknown,
): boolean {
  if (!invitationLookupPaths.has(pathname)) return false;
  if (status !== 400 && status !== 403) return false;
  if (!body || typeof body !== "object") return false;
  const { code, message } = body as { code?: unknown; message?: unknown };
  return (typeof code === "string" && invitationNotFoundCodes.has(code)) ||
    (typeof message === "string" &&
      message.toLowerCase().startsWith("invitation not found"));
}

/**
 * Provider endpoints Bakery never serves. The `jwt()` plugin's session-to-JWT
 * exchange would mint a signed token from a browser cookie; the MCP guard
 * rejects such a token (wrong audience, no `azp`), but the endpoint is closed
 * anyway so a cookie can never be turned into a bearer credential. Consent
 * mutation is closed for the reason noted on the entries below.
 */
const deniedProviderPaths = new Set([
  "/api/auth/token",
  // Consent mutation belongs to `connectedClients.revoke` alone: the provider's
  // own endpoints delete or rewrite a consent but keep issued tokens and write
  // no revocation epoch, so a re-consent would revive an old token.
  "/api/auth/oauth2/delete-consent",
  "/api/auth/oauth2/update-consent",
]);

const passkeyRegistrationPath = "/api/auth/passkey/verify-registration";
const passkeyAuthenticationPath = "/api/auth/passkey/verify-authentication";

/**
 * Two envelope adjustments on the passkey ceremonies. The plugin's
 * `verify-registration` catch-all reports every non-`APIError` thrown between
 * SimpleWebAuthn verification and the `passkey` insert as 500
 * `FAILED_TO_VERIFY_REGISTRATION`; the common cause is a client mistake
 * (wrong origin, RP ID or signature), which the generic INTERNAL collapse
 * would page on-call for. A storage fault on the insert is downgraded with it;
 * the provider's `onAPIError` log stays the operator signal. Passkey sign-in
 * bypasses the two-factor plugin's sign-in hook, so the TOTP redirect flag is
 * added here for TOTP users. Pure so it can be unit tested without a provider.
 */
export function rewritePasskeyResponse(
  pathname: string,
  status: number,
  body: unknown,
): { status: number; body: unknown } | undefined {
  if (!body || typeof body !== "object") return undefined;
  if (pathname === passkeyRegistrationPath && status === 500) {
    const failedVerification = "code" in body &&
      body.code === "FAILED_TO_VERIFY_REGISTRATION";
    return failedVerification ? { status: 400, body } : undefined;
  }
  if (pathname === passkeyAuthenticationPath && status === 200) {
    const user = "user" in body ? body.user : undefined;
    const twoFactorEnabled = !!user && typeof user === "object" &&
      "twoFactorEnabled" in user && user.twoFactorEnabled === true;
    if (twoFactorEnabled) {
      return { status: 200, body: { ...body, twoFactorRedirect: true } };
    }
  }
  return undefined;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

function withHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Adds Accept-Language to Vary without duplicating an existing entry. */
function varyOnAcceptLanguage(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing === null) {
    headers.set("Vary", "Accept-Language");
    return;
  }
  const present = existing.split(",").some(
    (value) => value.trim().toLowerCase() === "accept-language",
  );
  if (!present) headers.set("Vary", `${existing}, Accept-Language`);
}

async function secureAuthResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  // Session-derived JWTs are never handed to browsers (`jwt()` would add this
  // header to `/get-session`; it is also disabled in the plugin options).
  headers.delete("set-auth-jwt");

  const pathname = new URL(request.url).pathname;
  const body = await readJsonBody(response);

  const rewrite = rewritePasskeyResponse(pathname, response.status, body);
  if (rewrite) {
    headers.delete("Content-Length");
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(rewrite.body), {
      status: rewrite.status,
      headers,
    });
  }

  if (response.status >= 500) {
    throw new StandardError({
      code: "INTERNAL",
      status: response.status,
      cause: new Error(`identity provider returned ${response.status}`),
    });
  }

  if (
    response.status === 403 && body && typeof body === "object" &&
    "code" in body && body.code === "SESSION_REQUIRED"
  ) {
    // An SSO plugin refused the call: surface the Bakery error, not the
    // provider's generic 403 body.
    throw new StandardError({ code: "SESSION_REQUIRED" });
  }

  if (isInvitationNotFound(pathname, response.status, body)) {
    const locale = requestLocale(request);
    headers.delete("Content-Length");
    headers.set("Content-Type", "application/json");
    headers.set("Content-Language", locale);
    varyOnAcceptLanguage(headers);
    return new Response(
      JSON.stringify({
        message: createTranslator({ locale, surface: "auth" })(
          "auth.invitations.notFound",
        ),
      }),
      { status: 404, headers },
    );
  }
  return withHeaders(response, headers);
}

export function createAuthRoutes(options: {
  auth: AuthHttpProvider;
  database: PgDatabase;
  store: IdentityStore & SessionStore;
  publicBaseUrl: string;
  trustedOrigins: readonly string[];
  secret: string;
  installationSettings?: InstallationSettingsReader;
  availableLocales?: readonly string[];
  /** Operation registry shared with the MCP resource; built by the v1 routes when absent. */
  registry?: ActionRegistry;
}) {
  const app = new Hono();
  app.use(
    "/api/auth/*",
    createBrowserSessionMiddleware({
      auth: options.auth,
      store: options.store,
      publicBaseUrl: options.publicBaseUrl,
      trustedOrigins: options.trustedOrigins,
      secret: options.secret,
      allowAnonymous: true,
      checkOrigin: false,
      assurance: "skip",
    }),
  );
  app.route("/", createAuthV1Routes(options));
  app.all("/api/auth/*", async (context) => {
    if (
      deniedProviderPaths.has(
        new URL(context.req.url).pathname.replace(/\/+$/, ""),
      )
    ) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const headers = new Headers(context.req.raw.headers);
    headers.delete(REMOTE_ADDRESS_HEADER);
    const addr = (context.env as { remoteAddr?: Deno.NetAddr } | undefined)
      ?.remoteAddr;
    if (addr?.transport === "tcp") {
      headers.set(REMOTE_ADDRESS_HEADER, addr.hostname);
    }
    return await secureAuthResponse(
      context.req.raw,
      await options.auth.handler(
        new Request(context.req.raw, { headers }),
      ),
    );
  });
  return app;
}
