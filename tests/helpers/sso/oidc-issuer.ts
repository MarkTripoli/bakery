/** Unpadded base64url, as JWS segments use. */
function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

const enc = new TextEncoder();

export type OidcFaults = {
  aud?: string;
  iss?: string;
  nonce?: string;
  /** Seconds relative to now; negative = already expired. */
  expiresIn?: number;
  /** Flip a payload byte after signing so the signature no longer matches. */
  tamper?: boolean;
};

export type OidcIssuer = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Subject and email the next authorization will assert. */
  assert: { sub: string; email: string; name: string };
  /** Faults the next ID tokens carry; clear with `{}`. */
  faults: OidcFaults;
  /** Token requests received, so tests can prove the client secret was used. */
  tokenRequests: string[];
  close(): Promise<void>;
};

/**
 * A real, local OpenID Provider: discovery document, JWKS, authorization
 * endpoint (auto-approves and redirects with a code), token endpoint that
 * answers with an RS256-signed ID token, and userinfo. Nothing is mocked on
 * the Bakery side: the provider verifies the signature against this JWKS.
 */
export async function startOidcIssuer(
  port: number,
  clientId = "bakery-test-client",
  clientSecret = "oidc-client-secret-must-never-be-audited",
): Promise<OidcIssuer> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "issuer-key-1";
  const issuer = `http://127.0.0.1:${port}`;
  const codes = new Map<
    string,
    { nonce: string | null; redirectUri: string }
  >();
  const state = {
    issuer,
    clientId,
    clientSecret,
    assert: {
      sub: "idp-subject-1",
      email: "sso-user@example.test",
      name: "SSO User",
    },
    tokenRequests: [] as string[],
    faults: {} as OidcFaults,
  };

  const sign = async (claims: Record<string, unknown>) => {
    const header = encodeBase64Url(
      enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })),
    );
    const payload = encodeBase64Url(enc.encode(JSON.stringify(claims)));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        enc.encode(`${header}.${payload}`),
      ),
    );
    return `${header}.${payload}.${encodeBase64Url(signature)}`;
  };

  const forgedOrSame = (idToken: string) => {
    if (!state.faults.tamper) return idToken;
    const parts = idToken.split(".");
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    payload.email = "attacker@example.test";
    parts[1] = encodeBase64Url(enc.encode(JSON.stringify(payload)));
    return parts.join(".");
  };

  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
        });
      }
      if (url.pathname === "/jwks") {
        return json({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
      }
      if (url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri")!;
        const code = crypto.randomUUID();
        codes.set(code, {
          nonce: url.searchParams.get("nonce"),
          redirectUri,
        });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(target.href, 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        state.tokenRequests.push(
          `${request.headers.get("authorization") ?? ""}&${form.toString()}`,
        );
        const code = codes.get(form.get("code") ?? "");
        if (!code) return json({ error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const idToken = await sign({
          iss: state.faults.iss ?? issuer,
          aud: state.faults.aud ?? clientId,
          sub: state.assert.sub,
          iat: now,
          exp: now + (state.faults.expiresIn ?? 300),
          email: state.assert.email,
          email_verified: true,
          name: state.assert.name,
          ...(state.faults.nonce
            ? { nonce: state.faults.nonce }
            : code.nonce
            ? { nonce: code.nonce }
            : {}),
        });
        return json({
          access_token: "access-token-for-test",
          token_type: "Bearer",
          expires_in: 300,
          id_token: forgedOrSame(idToken),
        });
      }
      if (url.pathname === "/userinfo") {
        return json({
          sub: state.assert.sub,
          email: state.assert.email,
          email_verified: true,
          name: state.assert.name,
        });
      }
      return new Response("not found", { status: 404 });
    },
  );

  return {
    ...state,
    get faults() {
      return state.faults;
    },
    set faults(value) {
      state.faults = value;
    },
    get assert() {
      return state.assert;
    },
    set assert(value) {
      state.assert = value;
    },
    close: async () => {
      await server.shutdown();
    },
  } as OidcIssuer;
}

/** Reserves an ephemeral localhost port by binding and releasing it. */
export function reservePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
