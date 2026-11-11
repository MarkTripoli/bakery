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

export async function readSessionToken(
  headers: Headers,
  secret: string,
): Promise<string | null> {
  const cookie = getSessionCookie(headers);
  return cookie ? await readSignedSessionToken(cookie, secret) : null;
}

export function createOriginGuard(options: {
  publicBaseUrl: string;
  trustedOrigins: readonly string[];
}): MiddlewareHandler {
  return async (context, next) => {
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
    if (
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
    const cookie = getSessionCookie(context.req.raw.headers);
    if (!cookie && options.allowAnonymous) {
      await next();
      return;
    }
    const token = await readSessionToken(
      context.req.raw.headers,
      options.secret,
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
        headers: context.req.raw.headers,
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
  return {
    principal,
    locale: requestLocale(context.req.raw, principal),
    sessionId: context.get("sessionId"),
    accessToken: context.get("accessToken"),
  };
}
