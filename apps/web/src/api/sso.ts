/**
 * Single sign-on management over Better Auth's cookie-authenticated routes
 * (`/api/auth/sso/*` and Bakery's `/api/auth/bakery-sso/*`). These are not
 * catalog actions; the server decides tenant and permission, and
 * answers a Bakery problem body whose `code` the page maps to a notice.
 */

export type SsoProtocol = "oidc" | "saml";

export type SsoProvider = {
  readonly providerId: string;
  readonly issuer: string;
  readonly domain: string;
  readonly domainVerified: boolean;
  readonly protocol: SsoProtocol;
};

export type SsoOverview = {
  readonly enforce: boolean;
  readonly providers: readonly SsoProvider[];
};

export type SsoResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly code: string };

async function send<T>(
  path: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<SsoResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {
        code?: string;
      };
      return {
        ok: false,
        status: response.status,
        code: body.code ?? "INTERNAL",
      };
    }
    return { ok: true, data: await read(response) };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});

export const ssoApi = {
  overview: (organizationId: string, signal?: AbortSignal) =>
    send(
      `/api/auth/bakery-sso/providers?organizationId=${
        encodeURIComponent(organizationId)
      }`,
      { signal },
      (response) => response.json() as Promise<SsoOverview>,
    ),
  registerOidc: (
    organizationId: string,
    input: {
      providerId: string;
      domain: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
    },
  ) =>
    send(
      "/api/auth/sso/register",
      post({
        providerId: input.providerId,
        issuer: input.issuer,
        domain: input.domain,
        organizationId,
        oidcConfig: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          discoveryEndpoint: `${
            input.issuer.replace(/\/$/, "")
          }/.well-known/openid-configuration`,
          scopes: ["openid", "email", "profile"],
          pkce: true,
        },
      }),
      (response) => response.json() as Promise<{ providerId: string }>,
    ),
  registerSaml: (
    organizationId: string,
    input: { providerId: string; domain: string; metadata: string },
  ) =>
    send(
      "/api/auth/sso/register",
      post({
        providerId: input.providerId,
        issuer: `${globalThis.location.origin}/saml/${input.providerId}`,
        domain: input.domain,
        organizationId,
        samlConfig: {
          callbackUrl: `${globalThis.location.origin}/`,
          audience: `${globalThis.location.origin}/saml/${input.providerId}`,
          wantAssertionsSigned: true,
          idpMetadata: { metadata: input.metadata },
        },
      }),
      (response) =>
        response.json() as Promise<
          { providerId: string; domainVerificationToken?: string }
        >,
    ),
  updateProvider: (
    providerId: string,
    changes: {
      domain?: string;
      issuer?: string;
      oidcConfig?: { clientId?: string; clientSecret?: string };
      samlConfig?: { idpMetadata: { metadata: string } };
    },
  ) =>
    send(
      "/api/auth/sso/update-provider",
      post({ providerId, ...changes }),
      () => Promise.resolve(undefined),
    ),
  remove: (providerId: string) =>
    send(
      "/api/auth/sso/delete-provider",
      post({ providerId }),
      () => Promise.resolve(undefined),
    ),
  requestVerification: (providerId: string) =>
    send(
      "/api/auth/sso/request-domain-verification",
      post({ providerId }),
      (response) =>
        response.json() as Promise<{ domainVerificationToken: string }>,
    ),
  verifyDomain: (providerId: string) =>
    send(
      "/api/auth/sso/verify-domain",
      post({ providerId }),
      () => Promise.resolve(undefined),
    ),
  setEnforcement: (organizationId: string, enforce: boolean) =>
    send(
      "/api/auth/bakery-sso/enforcement",
      post({ organizationId, enforce }),
      (response) => response.json() as Promise<{ enforce: boolean }>,
    ),
};
