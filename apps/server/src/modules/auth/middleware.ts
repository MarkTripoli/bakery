import { getSessionCookie } from "better-auth/cookies";
import type { Context, MiddlewareHandler } from "hono";
import { requestLocale } from "../../platform/locale.ts";
import {
  type ActionContextSeed,
  AuthProblemCode,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import {
  type AuthenticatedSubject,
  IdentityResolutionError,
  type IdentityStore,
  resolvePrincipal,
} from "./application/identity.ts";
import type {
  AccessTokenAuthStore,
  SessionState,
  SessionStore,
} from "./adapters/postgres.ts";
import {
  bearerAccessTokenSecret,
  sha256Hex,
} from "./application/access-tokens.ts";
import { isPrincipalType, principalId } from "@bakery/contracts/contracts";
import {
  resolveSessionAssurance,
  SessionAssurance,
} from "./domain/assurance.ts";
import {
  claimsDesktopCredential,
  desktopAuthorization,
  desktopCredentialFromAuthorization,
} from "./domain/desktop-sign-in.ts";

export type AuthVariables = {
  principal: AuthenticatedSubject;
  sessionId?: string;
  /** Set only when an organization-bound access token authenticated the request. */
  accessToken?: { id: string; organizationId: string; scopes: string[] };
};

export type BrowserSessionAuth = {
  api: {
    getSession(options: {
      headers: Headers;
      query: { disableCookieCache: true };
    }): Promise<
      {
        session: { expiresAt: Date };
        user: { id: string; name: string; email: string };
      } | null
    >;
  };
};

async function readSignedSessionToken(
  cookie: string,
  secret: string,
): Promise<string | null> {
  const separator = cookie.lastIndexOf(".");
  if (separator < 1) return null;
  const token = cookie.slice(0, separator);
  const encodedSignature = cookie.slice(separator + 1);
  if (encodedSignature.length !== 44 || !encodedSignature.endsWith("=")) {
    return null;
  }
  try {
    const signatureText = atob(encodedSignature);
    const signature = Uint8Array.from(
      signatureText,
      (character) => character.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        new TextEncoder().encode(token),
      )
      ? token
      : null;
  } catch {
    return null;
  }
}

/**
 * The session token a request authenticates with: the desktop app's bearer
 * credential when present (it is the token of its own session row), else the
 * signed browser cookie. Live-update sockets read it here, so a revoked or
 * expired desktop sign-in is refused exactly as a browser one is.
 */
export async function readSessionToken(
  headers: Headers,
  secret: string,
  path?: string,
): Promise<string | null> {
  const desktop = desktopCredentialFromAuthorization(
    desktopAuthorization(headers, path),
  );
  if (desktop !== null) return desktop;
  const cookie = getSessionCookie(headers);
  return cookie ? await readSignedSessionToken(cookie, secret) : null;
}

/** The provider's session cookie names; the secure one is read on HTTPS origins. */
export const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

/** HMAC-SHA256 signed cookie value, the provider's own format. */
export async function signSessionToken(token: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${token}.${btoa(binary)}`;
}

/**
 * Request headers that carry a desktop credential as its session cookie and
 * nothing else: any cookie the request sent is dropped, and so is the
 * Authorization header, so the provider sees exactly one session.
 */
export async function desktopSessionHeaders(
  source: Headers,
  credential: string,
  secret: string,
): Promise<Headers> {
  const headers = new Headers(source);
  headers.delete("authorization");
  // A socket's carried credential is consumed here; the provider sees only
  // the cookie.
  headers.delete("sec-websocket-protocol");
  const signed = await signSessionToken(credential, secret);
  headers.set(
    "cookie",
    SESSION_COOKIE_NAMES.map((name) => `${name}=${signed}`).join("; "),
  );
  return headers;
}

export function createOriginGuard(options: {
  publicBaseUrl: string;
  trustedOrigins: readonly string[];
}): MiddlewareHandler {
  return async (context, next) => {
    // A desktop credential is a bearer value, never ambient, so a page on
    // another origin cannot make the browser send it: no origin applies. The
    // session middleware after this guard validates it.
    if (
      desktopCredentialFromAuthorization(
        desktopAuthorization(context.req.raw.headers, context.req.path),
      ) !== null
    ) {
      return await next();
    }
    const origin = context.req.raw.headers.get("origin");
    if (
      origin === null ||
      !options.trustedOrigins.some((trustedOrigin) => trustedOrigin === origin)
    ) {
      return problemResponse(
        context,
        new StandardError({ code: AuthProblemCode.Forbidden }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }
    return await next();
  };
}

export function createBrowserSessionMiddleware(options: {
  auth: BrowserSessionAuth;
  store: IdentityStore & SessionStore & Partial<AccessTokenAuthStore>;
  publicBaseUrl: string;
  trustedOrigins: readonly string[];
  secret: string;
  now?: () => Date;
  allowAnonymous?: boolean;
  checkOrigin?: boolean;
  assurance?: "required" | "skip";
  /**
   * Accept Bakery access tokens. Only for mounts whose every request is
   * authorized through `PostgresAuthorityRunner`, which enforces the token's
   * organization and scopes; any other mount refuses a token as invalid.
   */
  acceptAccessTokens?: boolean;
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const now = options.now ?? (() => new Date());
  return async (context, next) => {
    // A Bakery access token is a bearer credential: it is never ambient, so no
    // origin check applies, and it never falls through to the cookie session.
    const authorization = context.req.raw.headers.get("authorization");
    if (authorization !== null && /^Bearer[ \t]+bky_/.test(authorization)) {
      const secret = bearerAccessTokenSecret(authorization);
      let live: Awaited<
        ReturnType<NonNullable<typeof options.store.findLiveAccessToken>>
      > = null;
      try {
        live = secret === null || !options.acceptAccessTokens ||
            !options.store.findLiveAccessToken
          ? null
          : await options.store.findLiveAccessToken(await sha256Hex(secret));
      } catch (cause) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.Internal, cause }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
      if (
        !live || !isPrincipalType(live.principal.principalType) ||
        live.principal.displayName.trim() === ""
      ) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.Invalid }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
      context.set("principal", {
        principalId: principalId(live.principal.principalId),
        principalType: live.principal.principalType,
        displayName: live.principal.displayName,
        ...(live.principal.preferredLocale
          ? { preferredLocale: live.principal.preferredLocale }
          : {}),
      });
      context.set("accessToken", {
        id: live.tokenId,
        organizationId: live.organizationId,
        scopes: live.scopes,
      });
      await next();
      return;
    }
    // The desktop app's credential is the token of a real sign-in session.
    // It is re-presented to the provider as that session's signed cookie, so
    // expiry, renewal, assurance, revocation and principal resolution are the
    // browser path below, unchanged. Bearer, so no origin check applies.
    let headers = context.req.raw.headers;
    let desktop = false;
    const desktopClaim = desktopAuthorization(
      context.req.raw.headers,
      context.req.path,
    );
    if (claimsDesktopCredential(desktopClaim)) {
      const credential = desktopCredentialFromAuthorization(desktopClaim);
      if (credential === null) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.Invalid }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
      headers = await desktopSessionHeaders(
        headers,
        credential,
        options.secret,
      );
      desktop = true;
    }
    if (
      !desktop &&
      options.checkOrigin !== false &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method) &&
      !options.trustedOrigins.includes(
        context.req.raw.headers.get("origin") ?? "",
      )
    ) {
      return problemResponse(
        context,
        new StandardError({ code: AuthProblemCode.Forbidden }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }
    const cookie = getSessionCookie(headers);
    if (!cookie && options.allowAnonymous) {
      await next();
      return;
    }
    const token = await readSessionToken(
      headers,
      options.secret,
      context.req.path,
    );
    let state: SessionState | null = null;
    if (token) {
      try {
        state = await options.store.findSessionState(token);
        if (state && state.expiresAt.getTime() <= now().getTime()) {
          return problemResponse(
            context,
            new StandardError({ code: AuthProblemCode.Expired }),
            { publicBaseUrl: options.publicBaseUrl },
          );
        }
      } catch (cause) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.Internal, cause }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
    }
    let session: Awaited<ReturnType<typeof options.auth.api.getSession>>;
    try {
      session = await options.auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
    } catch (cause) {
      return problemResponse(
        context,
        new StandardError({ code: AuthProblemCode.Invalid, cause }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }

    if (!session) {
      if (options.allowAnonymous) {
        await next();
        return;
      }
      return problemResponse(
        context,
        new StandardError({
          code: cookie ? AuthProblemCode.Invalid : AuthProblemCode.Required,
        }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }
    const expiresAt = new Date(session.session.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) {
      return problemResponse(
        context,
        new StandardError({ code: AuthProblemCode.Invalid }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }
    if (expiresAt <= now().getTime()) {
      return problemResponse(
        context,
        new StandardError({ code: AuthProblemCode.Expired }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }

    if (options.assurance !== "skip") {
      if (!state) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.Invalid }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
      if (resolveSessionAssurance(state) === SessionAssurance.Pending) {
        return problemResponse(
          context,
          new StandardError({ code: AuthProblemCode.FactorRequired }),
          { publicBaseUrl: options.publicBaseUrl },
        );
      }
    }

    try {
      const principal = await resolvePrincipal(options.store, session.user.id);
      context.set("principal", {
        ...principal,
        twoFactorEnabled: state?.twoFactorEnabled ?? false,
        email: session.user.email,
        providerUserId: session.user.id,
      });
      context.set("sessionId", state?.id);
    } catch (error) {
      return problemResponse(
        context,
        error instanceof IdentityResolutionError
          ? new StandardError({ code: AuthProblemCode.Forbidden, cause: error })
          : new StandardError({ code: AuthProblemCode.Internal, cause: error }),
        { publicBaseUrl: options.publicBaseUrl },
      );
    }
    await next();
  };
}

/**
 * Action context for `createApiRouter`: the resolved principal plus the
 * effective locale for this request (person preference, then Accept-Language).
 */
export function createActionContext(
  context: Context<{ Variables: AuthVariables }>,
): ActionContextSeed {
  const principal = context.get("principal");
  const peer = (context.env as { remoteAddr?: Deno.Addr } | undefined)
    ?.remoteAddr;
  return {
    principal,
    locale: requestLocale(context.req.raw, principal),
    sessionId: context.get("sessionId"),
    accessToken: context.get("accessToken"),
    clientAddress: peer?.transport === "tcp" ? peer.hostname : undefined,
  };
}
