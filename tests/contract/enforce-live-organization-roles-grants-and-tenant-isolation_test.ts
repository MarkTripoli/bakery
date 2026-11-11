import { assert, assertEquals, assertRejects } from "@std/assert";
import { catalogVersion } from "../../packages/i18n/src/index.ts";
import {
  type ActionAuthorityRunner,
  ActionAuthorizationError,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  type CatalogActionName,
  contractSchemas,
  generateContracts,
  OrganizationContextPolicy,
  PrincipalType,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { rolePermissions } from "../../apps/server/src/modules/auth/application/permissions.ts";
import { signSessionCookie } from "../helpers/auth.ts";

type JsonSchema = {
  properties: Record<string, JsonSchema>;
  items?: JsonSchema;
  format?: string;
  description?: string;
};

function fields(schema: JsonSchema): string[] {
  return Object.keys(schema.properties).sort();
}

Deno.test("live authority projections keep identity and organization access separate", () => {
  const schemas = generateContracts().schemas;
  const json = (name: string) => toJsonSchema(schemas[name]) as JsonSchema;

  assertEquals(fields(json("PrincipalIdentity")), [
    "backupCodesRemaining",
    "catalogVersion",
    "direction",
    "displayName",
    "email",
    "locale",
    "principalId",
    "principalType",
    "timeZone",
    "twoFactorEnabled",
  ]);
  assertEquals(fields(json("Principal")), [
    "createdAt",
    "disabledAt",
    "displayName",
    "id",
    "principalType",
    "updatedAt",
    "version",
  ]);
  assertEquals(fields(json("OrganizationAccess")), [
    "createdAt",
    "defaultLocale",
    "id",
    "logo",
    "metadata",
    "name",
    "role",
    "slug",
    "updatedAt",
    "version",
  ]);
  assertEquals(
    fields(json("Page<OrganizationAccess>").properties.items.items!),
    fields(json("OrganizationAccess")),
  );
  assertEquals(fields(json("EffectiveAccess")), [
    "capabilities",
    "organizationId",
    "role",
  ]);
  assertEquals(
    schemas.OrganizationMembership.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      principalId: "00000000-0000-4000-8000-000000000003",
      role: null,
      status: "active",
      joinedAt: "2026-09-11T00:00:00.000Z",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      version: 1,
    }).success,
    true,
  );
  const access = schemas.EffectiveAccess;
  const effective = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    role: null,
  };
  assert(
    access.safeParse({ ...effective, capabilities: ["task:read"] }).success,
  );
  const grantOnlyAccess = toJsonSchema(
    schemas.OrganizationAccess,
  ) as JsonSchema;
  assertEquals(
    schemas.OrganizationAccess.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Grant-only organization",
      slug: "grant-only",
      logo: null,
      metadata: {},
      defaultLocale: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      version: 1,
      role: null,
    }).success,
    true,
  );
  assertEquals("role" in grantOnlyAccess.properties, true);
  assertEquals(
    access.safeParse({ ...effective, capabilities: ["tasks.*"] }).success,
    false,
  );
});

Deno.test("browser identity resolves an enabled principal without membership selection", async () => {
  const principalId = "00000000-0000-4000-8000-000000000001";
  const secret = "a".repeat(32);
  const sessionToken = "browser-identity-verified-session";
  let providerUserId: string | undefined;
  const app = createAuthV1Routes({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { expiresAt: new Date(Date.now() + 60_000) },
            user: {
              id: "provider-user",
              name: "Ignored provider name",
              email: "person@example.test",
            },
          }),
      },
    },
    database: {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as never,
    store: {
      findSessionState: () =>
        Promise.resolve({
          id: sessionToken,
          expiresAt: new Date(Date.now() + 60_000),
          twoFactorEnabled: false,
          factorVerifiedAt: null,
        }),
      loadEnabledPrincipal: (value) => {
        providerUserId = value;
        return Promise.resolve({
          principalId,
          principalType: PrincipalType.Human,
          displayName: "Bakery User",
        });
      },
    },
    publicBaseUrl: "http://test",
    secret,
  });

  const response = await app.fetch(
    new Request("http://test/v1/me", {
      headers: { cookie: await signSessionCookie(sessionToken, secret) },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(providerUserId, "provider-user");
  assertEquals(await response.json(), {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
    locale: "en",
    direction: "ltr",
    catalogVersion,
    twoFactorEnabled: false,
    email: "person@example.test",
    backupCodesRemaining: null,
    timeZone: null,
  });
});

Deno.test("principal and organization reads share the registered authority boundary", async () => {
  const principal = {
    principalId: "00000000-0000-4000-8000-000000000001",
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const organizationId = "00000000-0000-4000-8000-00000000000a";
  const secret = "a".repeat(32);
  const sessionToken = "authority-boundary-verified-session";
  const client = {
    query(statement: string) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      const rows = sql.includes("join public.organization")
        ? []
        : sql.includes("from bakery.principals")
        ? [principal]
        : sql.includes("from bakery.organization_memberships")
        ? [{ role: "admin", status: "active" }]
        : sql.includes("from public.member")
        ? [{ role: "admin" }]
        : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release() {},
  };
  const app = createAuthV1Routes({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { expiresAt: new Date(Date.now() + 60_000) },
            user: {
              id: "provider-user",
              name: "Provider name",
              email: "person@example.test",
            },
          }),
      },
    },
    database: {
      connect: () => Promise.resolve(client),
    } as unknown as PgDatabase,
    store: {
      findSessionState: () =>
        Promise.resolve({
          id: sessionToken,
          expiresAt: new Date(Date.now() + 60_000),
          twoFactorEnabled: false,
          factorVerifiedAt: null,
        }),
      loadEnabledPrincipal: () => Promise.resolve(principal),
    },
    publicBaseUrl: "http://test",
    secret,
  });

  const cookie = await signSessionCookie(sessionToken, secret);
  const organizations = await app.fetch(
    new Request("http://test/v1/organizations", { headers: { cookie } }),
  );
  assertEquals(organizations.status, 200);
  assertEquals(await organizations.json(), { items: [], nextCursor: null });

  for (
    const suffix of [
      "",
      "/effective-access",
      "/memberships",
      "/invitations",
    ]
  ) {
    const response = await app.fetch(
      new Request(`http://test/v1/organizations/${organizationId}${suffix}`, {
        headers: { cookie },
      }),
    );
    assertEquals(response.status, 403, suffix);
    assertEquals((await response.json()).code, "SCOPE_REQUIRED", suffix);
  }

  const access = await app.fetch(
    new Request(
      `http://test/v1/organizations/${organizationId}/effective-access`,
      { headers: { "Bakery-Organization-Id": organizationId, cookie } },
    ),
  );
  assertEquals(access.status, 200);
  const effectiveAccess = await access.json();
  assertEquals(effectiveAccess.organizationId, organizationId);
  assertEquals(effectiveAccess.role, "admin");
  assertEquals(
    effectiveAccess.capabilities,
    [...rolePermissions.admin].sort(),
  );
});

Deno.test("invitation and exact grant projections expose only bounded authority fields", () => {
  const schemas = generateContracts().schemas;
  const permissionGrant = toJsonSchema(schemas.PermissionGrant) as JsonSchema;
  assertEquals(fields(permissionGrant), [
    "capability",
    "createdAt",
    "expiresAt",
    "id",
    "organizationId",
    "policyRevision",
    "principalId",
    "revokedAt",
    "updatedAt",
    "version",
  ]);
  assertEquals("scope" in permissionGrant.properties, false);
  assertEquals("repositoryId" in permissionGrant.properties, false);
  assertEquals("role" in permissionGrant.properties, false);

  const permissionGrantCreate = toJsonSchema(
    schemas.PermissionGrantCreate,
  ) as JsonSchema;
  assertEquals(fields(permissionGrantCreate), [
    "capability",
    "expiresAt",
    "principalId",
  ]);
  assertEquals("scope" in permissionGrantCreate.properties, false);
  assertEquals("repositoryId" in permissionGrantCreate.properties, false);
  assertEquals("role" in permissionGrantCreate.properties, false);

  const invitation = toJsonSchema(
    schemas.OrganizationInvitation,
  ) as JsonSchema;
  assertEquals(fields(invitation), [
    "createdAt",
    "email",
    "expiresAt",
    "id",
    "inviterPrincipalId",
    "organizationId",
    "role",
    "status",
  ]);
  assertEquals(
    fields(
      (toJsonSchema(schemas["Page<OrganizationInvitation>"]) as JsonSchema)
        .properties.items.items!,
    ),
    fields(invitation),
  );
  const recipient = toJsonSchema(
    schemas.OrganizationInvitationRecipient,
  ) as JsonSchema;
  assertEquals(fields(recipient), [
    "email",
    "expiresAt",
    "id",
    "inviterEmail",
    "inviterId",
    "organizationId",
    "organizationName",
    "organizationSlug",
    "role",
    "status",
  ]);
  assertEquals(
    schemas.OrganizationInvitationRecipientGet.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
    }).success,
    false,
  );
  assertEquals(
    schemas.OrganizationInvitationRecipientAction.safeParse({
      invitationId: "00000000-0000-4000-8000-000000000001",
      email: "attacker@example.test",
    }).success,
    false,
  );
  assertEquals(
    schemas.OrganizationInvitationRecipientResult.safeParse({
      invitation: {
        id: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        email: "recipient@example.test",
        role: "developer",
        status: "rejected",
        expiresAt: "2026-09-12T00:00:00.000Z",
        inviterId: null,
        createdAt: "2026-09-11T00:00:00.000Z",
      },
      member: null,
    }).success,
    true,
  );
});

Deno.test("catalog generation preserves organization policy and REST shapes", () => {
  const generated = generateContracts();
  const actions = new Map(
    generated.actions.map((action) => [action.action, action]),
  );
  assertEquals(actions.get("identity.get")?.output, "PrincipalIdentity");
  assertEquals(
    actions.get("organizations.list")?.output,
    "Page<OrganizationAccess>",
  );
  assertEquals(
    actions.get("organizations.effectiveAccess")?.organizationContext,
    OrganizationContextPolicy.RequiredAuthenticatedContext,
  );
  assertEquals(
    [
      "organizationInvitations.list",
      "organizationInvitations.create",
      "organizationInvitations.cancel",
    ].map((name) => actions.get(name)?.organizationContext),
    Array(3).fill(OrganizationContextPolicy.RequiredAuthenticatedContext),
  );
  assertEquals(
    [
      "organizationInvitations.recipientGet",
      "organizationInvitations.recipientAccept",
      "organizationInvitations.recipientReject",
    ].map((name) => actions.get(name)?.organizationContext),
    Array(3).fill(OrganizationContextPolicy.AuthenticatedPrincipalScope),
  );
  assertEquals(
    actions.get("organizationInvitations.recipientGet")?.input,
    "OrganizationInvitationRecipientGet",
  );
  assertEquals(
    actions.get("organizationInvitations.recipientAccept")?.input,
    "OrganizationInvitationRecipientAction",
  );
  assertEquals(
    actions.get("organizationInvitations.recipientReject")?.output,
    "OrganizationInvitationRecipientResult",
  );
  for (
    const name of [
      "organizationInvitations.recipientGet",
      "organizationInvitations.recipientAccept",
      "organizationInvitations.recipientReject",
    ]
  ) {
    const action = actions.get(name)!;
    assertEquals(action.errors.includes("SCOPE_REQUIRED"), false, name);
    assertEquals(action.path.startsWith("/api/auth/organization/"), true, name);
  }
  assertEquals(
    [
      "permissionGrants.list",
      "permissionGrants.create",
      "permissionGrants.delete",
    ].map((name) => actions.get(name)?.organizationContext),
    Array(3).fill(OrganizationContextPolicy.RequiredAuthenticatedContext),
  );
  for (
    const action of generated.actions.filter((action) =>
      action.organizationContext ===
        OrganizationContextPolicy.RequiredAuthenticatedContext
    )
  ) {
    for (const error of ["SCOPE_REQUIRED", "MALFORMED_REQUEST"]) {
      assert(
        action.errors.includes(error),
        `${action.action} missing ${error}`,
      );
    }
  }
  assert(
    generated.actions.every((action) =>
      typeof action.organizationContext === "string"
    ),
  );
  assert(
    generated.actions.every((action) =>
      action.organizationContext ===
        OrganizationContextPolicy.RequiredAuthenticatedContext ||
      !action.errors.includes("SCOPE_REQUIRED")
    ),
    "SCOPE_REQUIRED is reserved for required organization context",
  );
});

Deno.test("OpenAPI emits one required organization header only for required context", () => {
  const generated = generateContracts();
  const paths = generated.openapi.paths as Record<
    string,
    Record<
      string,
      { parameters: Array<Record<string, unknown>> }
    >
  >;
  for (const action of generated.actions) {
    const operation = paths[action.path][action.method.toLowerCase()];
    const headers = operation.parameters.filter((parameter) =>
      parameter.name === "Bakery-Organization-Id" && parameter.in === "header"
    );
    const expected = action.organizationContext ===
        OrganizationContextPolicy.RequiredAuthenticatedContext
      ? 1
      : 0;
    assertEquals(headers.length, expected, action.action);
    if (headers.length) {
      // Upgrade requests cannot carry headers, so events.connect declares the
      // query alternative and the header becomes optional.
      assertEquals(
        headers[0].required,
        action.organizationHeaderOptional !== true,
        action.action,
      );
      const schema = headers[0].schema as JsonSchema;
      assertEquals(schema.format, "uuid");
      assert(schema.description?.includes("grants no access"));
    }
  }
});

Deno.test("HTTP validates every path ID without polluting CursorQuery or Empty", async () => {
  const calls: Array<{ params: Record<string, string>; input: unknown }> = [];
  const runner: ActionAuthorityRunner = {
    run: (_action, context, _input, next) => next(context),
  };
  const scopedPolicy = {
    type: "query",
    access: "Authenticated",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const registry = new ActionRegistry(runner).register({
    name: "organizationMemberships.path-query" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/memberships",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: scopedPolicy,
    handler: (context, input) => {
      calls.push({ params: { ...context.params }, input });
      return null;
    },
  }).register({
    name: "organizationInvitations.path-empty" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/organizations/:id/invitations/:invitationId",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: { ...scopedPolicy, type: "command" },
    handler: (context, input) => {
      calls.push({ params: { ...context.params }, input });
      return null;
    },
  });
  const app = createApiRouter({ registry });
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const invitationId = "00000000-0000-4000-8000-000000000002";

  const malformed = await app.fetch(
    new Request("http://test/v1/organizations/not-a-uuid/memberships"),
  );
  assertEquals(malformed.status, 400);
  assertEquals(calls, []);

  const page = await app.fetch(
    new Request(
      `http://test/v1/organizations/${organizationId}/memberships?limit=7`,
    ),
  );
  assertEquals(page.status, 204);
  assertEquals(page.headers.get("cache-control"), "no-store");
  assertEquals(calls[0], {
    params: { id: organizationId },
    input: { limit: 7 },
  });

  const deleted = await app.fetch(
    new Request(
      `http://test/v1/organizations/${organizationId}/invitations/${invitationId}`,
      { method: "DELETE" },
    ),
  );
  assertEquals(deleted.status, 204);
  assertEquals(deleted.headers.get("cache-control"), "no-store");
  assertEquals(calls[1], {
    params: { id: organizationId, invitationId },
    input: {},
  });
});

Deno.test("every scoped action requires a runner before callbacks", async () => {
  let called = false;
  const registry = new ActionRegistry().register({
    name: "organization.public-scoped" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/public-scoped",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      type: "query",
      access: "Public",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: () => {
      called = true;
      return null;
    },
  });

  await assertRejects(
    () =>
      registry.execute("organization.public-scoped", {
        request: new Request("http://test"),
        params: {},
        requestId: "request-1",
        traceId: "trace-1",
        signal: new AbortController().signal,
      }, {}),
    ActionAuthorizationError,
    "no authority runner",
  );
  assertEquals(called, false);
});

Deno.test("future adapters fail closed without a trusted authority runner", async () => {
  for (
    const [name, organizationContext] of [
      [
        "background.execute",
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      ],
      ["replay.read", OrganizationContextPolicy.RequiredAuthenticatedContext],
      [
        "socket.connect",
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      ],
      ["download.read", OrganizationContextPolicy.RequiredAuthenticatedContext],
      [
        "webhook.receive",
        OrganizationContextPolicy.DerivedBoundAuthAttempt,
      ],
    ] as const
  ) {
    let called = false;
    const registry = new ActionRegistry().register({
      name: name as CatalogActionName,
      method: HttpMethod.Get,
      path: `/v1/${name}`,
      input: contractSchemas.Empty,
      output: contractSchemas.NoContent,
      policy: {
        type: "query",
        access: "Authenticated",
        organizationContext,
        authorize: () => {
          called = true;
        },
      },
      handler: () => {
        called = true;
        return null;
      },
    });
    await assertRejects(
      () =>
        registry.execute(name, {
          request: new Request("http://test"),
          params: {},
          requestId: "request-1",
          traceId: "trace-1",
          signal: new AbortController().signal,
        }, {}),
      ActionAuthorizationError,
    );
    assertEquals(called, false);
  }
});
