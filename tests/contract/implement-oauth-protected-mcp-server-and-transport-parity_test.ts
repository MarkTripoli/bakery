import { assert, assertEquals } from "@std/assert";
import type { ActionRegistry } from "../../packages/contracts/src/action-registry.ts";
import {
  catalogActions,
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  guardMcpRequest,
  type McpGrantStore,
  type McpTokenClaims,
} from "../../apps/server/src/platform/mcp/guard.ts";
import {
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
} from "../../apps/server/src/platform/mcp/metadata.ts";
import { createMcpRoutes } from "../../apps/server/src/platform/mcp/server.ts";
import {
  decideMcpToolAccess,
  effectiveMcpScopes,
  MCP_TOOL_SCOPE,
  mcpResourceUrl,
  McpTool,
  oauthIssuerUrl,
} from "../../apps/server/src/platform/mcp/scopes.ts";
import { createMcpToolRunner } from "../../apps/server/src/platform/mcp/tools.ts";

type JsonSchema = {
  properties: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
};

const ORIGIN = "https://bakery.example";
const USER = "6f1c8d5e-3b8a-4c53-9a0e-111111111111";
const ORGANIZATION = "6f1c8d5e-3b8a-4c53-9a0e-222222222222";
const PRINCIPAL = "6f1c8d5e-3b8a-4c53-9a0e-333333333333";

function schemaOf(name: string): JsonSchema {
  const schemas = generateContracts().schemas as Record<string, never>;
  return toJsonSchema(schemas[name]) as JsonSchema;
}

function assertDescribed(schema: JsonSchema, path: string): void {
  assert(schema.description?.trim(), `${path} needs a description`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    assertDescribed(child, `${path}.${key}`);
  }
  if (schema.items) assertDescribed(schema.items, `${path}[]`);
}

Deno.test("connected-client actions are implemented, cataloged and not exposed as MCP tools", () => {
  const byAction = new Map(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  for (
    const action of [
      "connectedClients.list",
      "connectedClients.revoke",
    ] as const
  ) {
    assert((implementedActions as readonly string[]).includes(action), action);
    const entry = byAction.get(action)!;
    assertEquals(entry.access, "Authenticated");
    assertEquals(entry.organizationContext, "authenticated_principal_scope");
    assertEquals(entry.mcp, null);
  }
  assertEquals(byAction.get("connectedClients.list")?.method, "GET");
  assertEquals(
    byAction.get("connectedClients.list")?.path,
    "/v1/me/connected-clients",
  );
  assertEquals(byAction.get("connectedClients.revoke")?.method, "DELETE");
  assertEquals(
    byAction.get("connectedClients.revoke")?.path,
    "/v1/me/connected-clients/{id}",
  );
  assert(
    byAction.get("connectedClients.revoke")?.errors.includes(
      "RESOURCE_NOT_FOUND",
    ),
  );
});

Deno.test("connected-client schemas are fully described and shaped as designed", () => {
  for (
    const name of [
      "ConnectedClient",
      "ConnectedClientList",
      "ConnectedClientRevocation",
    ]
  ) {
    assertDescribed(schemaOf(name), name);
  }
  const client = schemaOf("ConnectedClient");
  assertEquals(Object.keys(client.properties).sort(), [
    "authorizedAt",
    "clientId",
    "clientName",
    "id",
    "lastUsedAt",
    "organizationId",
    "organizationName",
    "scopes",
  ]);
  assert(client.required?.includes("id"));
  assertEquals(
    Object.keys(schemaOf("ConnectedClientRevocation").properties).sort(),
    ["clientId", "clientName", "organizationId", "revoked"],
  );
  // The profile and availability delta that ships with this change.
  assert("emailVerified" in schemaOf("UserProfile").properties);
  assert(schemaOf("UserProfile").required?.includes("emailVerified"));
  // E16 removed the feature-flag service, so no availability schema exists.
  assertEquals(
    (generateContracts().schemas as Record<string, unknown>)
      .FeatureAvailability,
    undefined,
  );
});

Deno.test("the scope decision is the intersection of token and live consent scopes", () => {
  for (const tool of Object.values(McpTool)) {
    assertEquals(MCP_TOOL_SCOPE[tool], ["bakery:read"]);
  }
  const decide = (tokenScopes: string[], consentScopes: string[]) =>
    decideMcpToolAccess({ tool: McpTool.Whoami, tokenScopes, consentScopes });
  assertEquals(decide(["bakery:read"], ["bakery:read"]), { allowed: true });
  assertEquals(decide(["bakery:read", "bakery:operate"], ["bakery:read"]), {
    allowed: true,
  });
  // A broader bundle on either side still covers a read tool.
  assertEquals(decide(["bakery:operate"], ["bakery:read"]), { allowed: true });
  assertEquals(decide(["bakery:read"], ["bakery:operate"]), { allowed: true });
  assertEquals(decide(["bakery:admin"], ["bakery:admin"]), { allowed: true });
  for (
    const [token, consent] of [
      [["bakery:read"], []],
      [[], ["bakery:read"]],
      [["openid"], ["openid"]],
    ] as const
  ) {
    assertEquals(decide([...token], [...consent]), {
      allowed: false,
      missingScopes: ["bakery:read"],
    });
  }
  assertEquals(
    effectiveMcpScopes(
      ["bakery:operate", "bakery:read", "openid"],
      ["bakery:read", "bakery:operate", "profile"],
    ),
    ["bakery:read", "bakery:operate"],
  );
  assertEquals(effectiveMcpScopes(["bakery:read"], ["bakery:operate"]), [
    "bakery:read",
  ]);
  assertEquals(effectiveMcpScopes(["bakery:admin"], ["bakery:admin"]), [
    "bakery:read",
    "bakery:operate",
    "bakery:admin",
  ]);
  assertEquals(effectiveMcpScopes(["openid"], ["bakery:admin"]), []);
});

Deno.test("resource and issuer identifiers and the protected-resource document are derived from the public origin", () => {
  assertEquals(mcpResourceUrl(`${ORIGIN}/`), `${ORIGIN}/mcp`);
  assertEquals(oauthIssuerUrl(`${ORIGIN}/`), `${ORIGIN}/api/auth`);
  assertEquals(
    PROTECTED_RESOURCE_METADATA_PATH,
    "/.well-known/oauth-protected-resource/mcp",
  );
  assertEquals(protectedResourceMetadata(ORIGIN), {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [`${ORIGIN}/api/auth`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["bakery:read", "bakery:operate", "bakery:admin"],
    resource_name: "Bakery",
  });
});

type Calls = string[];

function fakeStore(
  calls: Calls,
  overrides: Partial<McpGrantStore> = {},
): McpGrantStore {
  return {
    findLiveConsent: (input) => {
      calls.push("consent");
      assertEquals(input, {
        providerUserId: USER,
        clientId: "client-1",
        organizationId: ORGANIZATION,
      });
      return Promise.resolve({ scopes: ["bakery:read", "bakery:operate"] });
    },
    revocationEpochSeconds: () => {
      calls.push("epoch");
      return Promise.resolve(undefined);
    },
    findActivePrincipal: () => {
      calls.push("principal");
      return Promise.resolve({ principalId: PRINCIPAL });
    },
    hasLiveMembership: () => {
      calls.push("membership");
      return Promise.resolve(true);
    },
    touchActivity: () => {
      calls.push("touch");
      return Promise.resolve();
    },
    ...overrides,
  };
}

const goodClaims: McpTokenClaims = {
  sub: USER,
  azp: "client-1",
  organization_id: ORGANIZATION,
  iat: 1_000,
  scope: "bakery:read bakery:operate",
};

function bearer(token = "abc.def.ghi"): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function guarded(
  request: Request,
  calls: Calls,
  options: {
    claims?: McpTokenClaims | Error;
    store?: Partial<McpGrantStore>;
  } = {},
) {
  return await guardMcpRequest(request, {
    publicOrigin: ORIGIN,
    verifyToken: (token) => {
      calls.push("verify");
      assertEquals(token, "abc.def.ghi");
      const claims = options.claims ?? goodClaims;
      return claims instanceof Error
        ? Promise.reject(claims)
        : Promise.resolve(claims);
    },
    store: fakeStore(calls, options.store),
  });
}

Deno.test("the guard checks in the planned order and stops at the first failure", async () => {
  // Bearer only: nothing is verified or read without a credential.
  for (
    const request of [
      new Request(`${ORIGIN}/mcp`, { method: "POST" }),
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { cookie: "better-auth.session_token=x.y" },
      }),
    ]
  ) {
    const calls: Calls = [];
    const response = await guarded(request, calls);
    assert(response instanceof Response);
    assertEquals(response.status, 401);
    assertEquals(
      response.headers.get("www-authenticate"),
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    assertEquals(calls, []);
  }
  const scheme = await guarded(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: "DPoP abc.def.ghi" },
    }),
    [],
  );
  assert(scheme instanceof Response && scheme.status === 401);

  // Signature, issuer, audience and expiry come before any claim or store read.
  let calls: Calls = [];
  let result = await guarded(bearer(), calls, { claims: new Error("bad") });
  assert(result instanceof Response && result.status === 401);
  assertEquals(calls, ["verify"]);

  // Required claims, including `azp`, come before the live consent.
  for (
    const claims of [
      { ...goodClaims, azp: undefined },
      { ...goodClaims, sub: "x" },
      { ...goodClaims, organization_id: undefined },
      { ...goodClaims, iat: undefined },
      { ...goodClaims, cnf: { jkt: "x" } },
    ]
  ) {
    calls = [];
    result = await guarded(bearer(), calls, { claims });
    assert(result instanceof Response && result.status === 401);
    assertEquals(calls, ["verify"]);
  }

  // Consent before epoch.
  calls = [];
  result = await guarded(bearer(), calls, {
    store: {
      findLiveConsent: () => {
        calls.push("consent");
        return Promise.resolve(undefined);
      },
    },
  });
  assert(result instanceof Response && result.status === 401);
  assertEquals(calls, ["verify", "consent"]);

  // Epoch before scopes: a token at or before the revoke second is refused.
  for (const [epoch, status] of [[1_000, 401], [1_001, 401], [999, 200]]) {
    calls = [];
    result = await guarded(bearer(), calls, {
      store: {
        revocationEpochSeconds: () => {
          calls.push("epoch");
          return Promise.resolve(epoch);
        },
      },
    });
    if (status === 401) {
      assert(result instanceof Response && result.status === 401, `${epoch}`);
      assertEquals(calls, ["verify", "consent", "epoch"]);
    } else {
      assert(!(result instanceof Response), `${epoch}`);
    }
  }

  // Scopes before principal and membership.
  calls = [];
  result = await guarded(bearer(), calls, {
    claims: { ...goodClaims, scope: "openid" },
  });
  assert(result instanceof Response && result.status === 403);
  assertEquals(calls, ["verify", "consent", "epoch"]);
  assert(
    (result.headers.get("www-authenticate") ?? "").includes(
      'error="insufficient_scope"',
    ),
  );

  // Principal before membership; both before the activity write.
  calls = [];
  result = await guarded(bearer(), calls, {
    store: {
      findActivePrincipal: () => {
        calls.push("principal");
        return Promise.resolve(undefined);
      },
    },
  });
  assert(result instanceof Response && result.status === 401);
  assertEquals(calls, ["verify", "consent", "epoch", "principal"]);
  calls = [];
  result = await guarded(bearer(), calls, {
    store: {
      hasLiveMembership: () => {
        calls.push("membership");
        return Promise.resolve(false);
      },
    },
  });
  assert(result instanceof Response && result.status === 401);
  assertEquals(calls, [
    "verify",
    "consent",
    "epoch",
    "principal",
    "membership",
  ]);

  // All pass: dispatch may proceed and the grant carries both scope sets.
  calls = [];
  result = await guarded(bearer(), calls);
  assertEquals(calls, [
    "verify",
    "consent",
    "epoch",
    "principal",
    "membership",
    "touch",
  ]);
  assert(!(result instanceof Response));
  assertEquals(result.principalId, PRINCIPAL);
  assertEquals(result.tokenScopes, ["bakery:read", "bakery:operate"]);
  assertEquals(result.consentScopes, ["bakery:read", "bakery:operate"]);
  assertEquals(result.scopes, ["bakery:read", "bakery:operate"]);
});

Deno.test("tools run through the operation registry for the grant's organization", async () => {
  const executed: {
    name: string;
    headers: string | null;
    params: unknown;
    input: unknown;
  }[] = [];
  const registry = {
    execute: (
      name: string,
      context: { request: Request; params: unknown },
      input: unknown,
    ) => {
      executed.push({
        name,
        headers: context.request.headers.get("Bakery-Organization-Id"),
        params: context.params,
        input,
      });
      return Promise.resolve({ ok: name });
    },
  } as unknown as ActionRegistry;
  const runner = createMcpToolRunner({
    publicOrigin: ORIGIN,
    registry,
    loadSubject: (providerUserId) => Promise.resolve({ providerUserId }),
  });
  const grant = {
    providerUserId: USER,
    clientId: "client-1",
    organizationId: ORGANIZATION,
    principalId: PRINCIPAL,
    tokenScopes: ["bakery:read"],
    consentScopes: ["bakery:read"],
    scopes: ["bakery:read" as const],
  };
  assertEquals(await runner.run(McpTool.Whoami, grant), { ok: "identity.get" });
  assertEquals(await runner.run(McpTool.OrganizationGet, grant), {
    ok: "organizations.get",
  });
  assertEquals(executed, [
    { name: "identity.get", headers: ORGANIZATION, params: {}, input: {} },
    {
      name: "organizations.get",
      headers: ORGANIZATION,
      params: { id: ORGANIZATION },
      input: { id: ORGANIZATION },
    },
  ]);
});

Deno.test("the endpoint lists only permitted tools, challenges before dispatch and never runs a refused tool", async () => {
  const ran: string[] = [];
  const build = (consentScopes: string[]) =>
    createMcpRoutes({
      allowedOrigins: [ORIGIN],
      guard: {
        publicOrigin: ORIGIN,
        verifyToken: () => Promise.resolve({ ...goodClaims }),
        store: fakeStore([], {
          findLiveConsent: () => Promise.resolve({ scopes: consentScopes }),
        }),
      },
      tools: {
        run: (tool) => {
          ran.push(tool);
          return Promise.resolve({ tool });
        },
      },
    });
  const post = (app: ReturnType<typeof build>, method: string, params = {}) =>
    app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer abc.def.ghi",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "tools/call"
            ? { "mcp-name": (params as { name?: string }).name ?? "" }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );

  const full = build(["bakery:read", "bakery:operate"]);
  const listed = await post(full, "tools/list");
  assertEquals(listed.status, 200);
  assertEquals(
    ((await listed.json()) as { result: { tools: { name: string }[] } }).result
      .tools.map(({ name }) => name).sort(),
    ["organization_get", "whoami"],
  );
  const called = await post(full, "tools/call", {
    name: "whoami",
    arguments: {},
  });
  assertEquals(called.status, 200);
  assertEquals(ran, ["whoami"]);

  // A broader bundle covers the read tools: operate-only consent lists them.
  const operateOnly = build(["bakery:operate"]);
  const broader = await post(operateOnly, "tools/list");
  assertEquals(
    ((await broader.json()) as { result: { tools: { name: string }[] } })
      .result.tools.map(({ name }) => name).sort(),
    ["organization_get", "whoami"],
  );
  // Consent that carries no Bakery scope is refused before any dispatch, and
  // the challenge names the minimal bundle that would allow the tool.
  const noBakeryScope = build(["openid"]);
  const refused = await post(noBakeryScope, "tools/call", {
    name: "whoami",
    arguments: {},
  });
  assertEquals(refused.status, 403);
  const challenge = refused.headers.get("www-authenticate") ?? "";
  assert(challenge.includes('error="insufficient_scope"'), challenge);
  assert(challenge.includes('scope="bakery:read"'), challenge);
  assertEquals(ran, ["whoami"], "the refused tool never ran");
});
