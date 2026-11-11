import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ActionAuthorityRunner,
  ActionAuthorizationError,
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  ActionRegistryError,
  assertRegisteredActions,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  type ActionAccess,
  type CatalogActionName,
  contractSchemas,
  isActionAccess,
  isCatalogActionName,
  isMembershipStatus,
  isOrganizationContextPolicy,
  isOrganizationRole,
  isPrincipalType,
  MembershipStatus,
  OrganizationContextPolicy,
  organizationId as asOrganizationId,
  OrganizationRole,
  type OrganizationRole as OrganizationRoleValue,
  principalId as asPrincipalId,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  hasAnyRole,
  type OrganizationActor,
  requireActorRole,
  roleSatisfies,
} from "../../apps/server/src/modules/auth/application/authority.ts";
import {
  authorize,
  authorizeOrganizationAction,
  organizationPermissions,
} from "../../apps/server/src/modules/auth/application/authorize.ts";
import { rolePermissions } from "../../apps/server/src/modules/auth/application/permissions.ts";
import {
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { PostgresOrganizationStore } from "../../apps/server/src/modules/auth/adapters/organization-postgres.ts";
import {
  prepareInvitationCreate,
  prepareMembershipCreate,
  prepareMembershipUpdate,
  prepareOrganizationCreate,
  prepareOrganizationUpdate,
} from "../../apps/server/src/modules/auth/application/organizations.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import {
  createAuthRoutes,
  isInvitationNotFound,
} from "../../apps/server/src/modules/auth/transport/http/routes.ts";
import type { AuthenticatedSubject } from "../../apps/server/src/modules/auth/application/identity.ts";
import { signSessionCookie } from "../helpers/auth.ts";
import {
  CATALOG_LITERALS_PATH,
  renderCatalogLiterals,
} from "../../scripts/generate-catalog-literals.ts";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};

const organizationA = "00000000-0000-4000-8000-00000000000a";
const principalId = asPrincipalId("00000000-0000-4000-8000-000000000001");

const context = (): ActionContext => ({
  request: new Request("http://test"),
  params: {},
  requestId: "request-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
});

Deno.test("shared live-authority vocabulary accepts only declared values", () => {
  assertEquals(isPrincipalType(PrincipalType.Human), true);
  assertEquals(isPrincipalType("person"), false);
  assertEquals(isActionAccess("Organization member"), true);
  assertEquals(isActionAccess("not-a-catalog-policy"), false);
  assertEquals(isOrganizationRole(OrganizationRole.Admin), true);
  assertEquals(isOrganizationRole("owner"), false);
  assertEquals(isMembershipStatus(MembershipStatus.Active), true);
  assertEquals(isMembershipStatus("removed"), false);
  assertEquals(
    isOrganizationContextPolicy(
      OrganizationContextPolicy.RequiredAuthenticatedContext,
    ),
    true,
  );
  assertEquals(isOrganizationContextPolicy("header_optional"), false);
  assertEquals(isCatalogActionName("organizations.effectiveAccess"), true);
  assertEquals(isCatalogActionName("future.notRegistered"), false);
});

Deno.test("unknown persisted service grants fail closed in effective access", () => {
  const actor: OrganizationActor = {
    subject: {
      principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
      principalType: PrincipalType.Service,
      displayName: "Bakery Service",
    },
    organizationId: asOrganizationId("00000000-0000-4000-8000-000000000002"),
    capabilities: [
      "organizations.effectiveAccess",
      "future.notRegistered",
    ],
  };
  assertEquals(organizationPermissions(actor), ["organization:read"]);
});

Deno.test("organization mutation inputs normalize without weakening validation", () => {
  assertEquals(
    prepareOrganizationCreate({ name: "  Bakery Team  ", slug: " bakery " }),
    { name: "Bakery Team", slug: "bakery" },
  );
  assertEquals(
    prepareOrganizationUpdate({ metadata: { tier: "team" } }),
    { metadata: '{"tier":"team"}' },
  );
  assertEquals(
    prepareInvitationCreate(
      { email: "  USER@EXAMPLE.TEST ", role: OrganizationRole.Developer },
      new Date("2026-09-10T12:00:00Z"),
    ),
    {
      email: "user@example.test",
      role: OrganizationRole.Developer,
      expiresAt: new Date("2026-09-12T12:00:00Z"),
    },
  );
  assertEquals(
    prepareMembershipCreate({
      principalId: "00000000-0000-4000-8000-000000000003",
      role: null,
    }),
    {
      principalId: "00000000-0000-4000-8000-000000000003",
      role: null,
    },
  );
  assertEquals(prepareMembershipUpdate({ role: null }), { role: null });
  assertThrows(
    () => prepareMembershipUpdate({}),
    StandardError,
    "UNPROCESSABLE",
  );
  assertThrows(
    () => prepareOrganizationCreate({ name: " ", slug: "bakery" }),
    StandardError,
    "UNPROCESSABLE",
  );
});

Deno.test("restricted installation policy stops a non-administrator before organization persistence", async () => {
  const statements: string[] = [];
  const client = {
    query(statement: string) {
      statements.push(statement);
      if (statement.includes("from bakery.installation_settings")) {
        return Promise.resolve({
          rows: [{
            id: true,
            registrationMode: "invitation",
            organizationCreationPolicy: "installation_admins",
            version: 1,
            updatedByPrincipalId: null,
            updatedAt: new Date(),
          }],
          rowCount: 1,
        });
      }
      if (statement.includes("from bakery.principals")) {
        return Promise.resolve({
          rows: [{
            principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
            principalType: PrincipalType.Human,
            displayName: "Bakery User",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const secret = "a".repeat(32);
  const token = "disabled-organization-creation-session";
  const expiresAt = new Date(Date.now() + 60_000);
  const app = createAuthV1Routes({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { expiresAt },
            user: {
              id: "provider-user",
              name: "Bakery User",
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
          id: token,
          expiresAt,
          twoFactorEnabled: false,
          factorVerifiedAt: null,
        }),
      loadEnabledPrincipal: () =>
        Promise.resolve({
          principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
          principalType: PrincipalType.Human,
          displayName: "Bakery User",
        }),
    },
    publicBaseUrl: "http://test",
    secret,
    installationSettings: {
      current: () =>
        Promise.resolve({
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
          version: 1,
          updatedByPrincipalId: null,
          updatedAt: new Date().toISOString(),
        }),
    },
  });
  const response = await app.fetch(
    new Request("http://test/v1/organizations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://test",
        cookie: await signSessionCookie(token, secret),
      },
      body: JSON.stringify({ name: "Bakery", slug: "bakery" }),
    }),
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
  assertEquals(
    statements.some((statement) =>
      statement.toLowerCase().includes("insert into public.organization")
    ),
    false,
  );
});

Deno.test("authenticated cursors bind the complete keyset authority context", async () => {
  const secret = "phase-4-cursor-secret";
  const binding = {
    action: "organizations.list",
    principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
    ordering: "createdAt:asc,id:asc",
    filters: "{}",
    schemaVersion: 1,
  };
  const position = {
    createdAt: "2026-09-10T12:34:56.123456Z",
    id: "00000000-0000-4000-8000-000000000002",
  };
  const cursor = await encodeCursor(secret, binding, position);

  assertEquals(await decodeCursor(secret, cursor, binding), position);
  const separator = cursor.lastIndexOf(".");
  const encodedSignature = cursor.slice(separator + 1);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalSignatureIndex = alphabet.indexOf(encodedSignature.at(-1)!);
  assertEquals(finalSignatureIndex % 4, 0);
  const nonCanonical = `${cursor.slice(0, separator + 1)}${
    encodedSignature.slice(0, -1)
  }${alphabet[finalSignatureIndex + 1]}`;
  const nonCanonicalError = await assertRejects(
    () => decodeCursor(secret, nonCanonical, binding),
    StandardError,
  );
  assertEquals(nonCanonicalError.code, "INVALID_CURSOR");
  for (
    const mismatched of [
      { ...binding, action: "organizationMemberships.list" },
      {
        ...binding,
        principalId: "00000000-0000-4000-8000-000000000003",
      },
      {
        ...binding,
        organizationId: asOrganizationId(
          "00000000-0000-4000-8000-000000000004",
        ),
      },
      { ...binding, ordering: "createdAt:desc,id:desc" },
      { ...binding, filters: '{"status":"active"}' },
      { ...binding, schemaVersion: 2 },
    ]
  ) {
    const error = await assertRejects(
      () => decodeCursor(secret, cursor, mismatched),
      StandardError,
    );
    assertEquals(error.code, "INVALID_CURSOR");
  }
  for (
    const invalid of [
      `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
      "not-a-cursor",
      "a".repeat(513),
    ]
  ) {
    const error = await assertRejects(
      () => decodeCursor(secret, invalid, binding),
      StandardError,
    );
    assertEquals(error.code, "INVALID_CURSOR");
  }
});

Deno.test("registered action parity includes organization context policy", () => {
  const registry = createTaskActionRegistry({
    list: () => null as never,
    get: () => null as never,
    create: () => null as never,
    update: () => null as never,
    createDependency: () => null as never,
    deleteDependency: () => null as never,
    runsCreate: () => null as never,
    runsList: () => null as never,
    runsGet: () => null as never,
    runStepsList: () => null as never,
    workflowPresetsList: () => null as never,
    usageList: () => null as never,
    sync: () => null as never,
  });
  registry.get("tasks.list").policy.organizationContext =
    OrganizationContextPolicy.AuthenticatedPrincipalScope;
  assertThrows(
    () => assertRegisteredActions(registry),
    ActionRegistryError,
    "tasks.list organization context mismatch",
  );
});

Deno.test("failed rollback releases the Postgres client as unusable", async () => {
  const releaseErrors: (Error | undefined)[] = [];
  const database = {
    connect: () =>
      Promise.resolve({
        query(statement: string) {
          if (statement === "rollback") throw new Error("ROLLBACK_FAILED");
          return { rows: [], rowCount: 0 };
        },
        release(error?: Error) {
          releaseErrors.push(error);
        },
      }),
  } as unknown as PgDatabase;

  await assertRejects(
    () =>
      withPgTransaction(
        database,
        () => Promise.reject(new Error("WORK_FAILED")),
      ),
    Error,
    "WORK_FAILED",
  );
  assertEquals(releaseErrors.length, 1);
  assertEquals(releaseErrors[0]?.message, "ROLLBACK_FAILED");
});

Deno.test("catalog descriptive access policies remain executable metadata", () => {
  const registry = new ActionRegistry().register({
    name: "organizations.get",
    method: HttpMethod.Get,
    path: "/v1/organizations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Organization,
    policy: {
      type: ActionKind.Query,
      access: "Organization member",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
    handler: () => null as never,
  });
  assertRegisteredActions(registry);

  const principalRegistry = new ActionRegistry().register({
    name: "organizations.list",
    method: HttpMethod.Get,
    path: "/v1/organizations",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationAccess>"],
    policy: {
      type: ActionKind.Query,
      access: "Authenticated principal",
      organizationContext:
        OrganizationContextPolicy.AuthenticatedPrincipalScope,
    },
    handler: () => null,
  });
  assertRegisteredActions(principalRegistry);
});

Deno.test("scoped protected action without a runner fails before callbacks", async () => {
  const calls: string[] = [];
  const registry = new ActionRegistry().register({
    name: "organization.scoped" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/scoped",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      type: "query",
      access: "Authenticated",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      authorize: () => {
        calls.push("authorize");
      },
    },
    handler: () => {
      calls.push("handler");
      return null;
    },
  });

  await assertRejects(
    () => registry.execute("organization.scoped", context(), {}),
    ActionAuthorizationError,
    "no authority runner",
  );
  assertEquals(calls, []);
});

Deno.test("authority runner encloses scoped authorization and handler", async () => {
  const calls: string[] = [];
  const runner: ActionAuthorityRunner = {
    async run(action, original, input, next) {
      calls.push(`runner:${action.name}`);
      assertEquals(input, {});
      return await next({ ...original, principal: "authorized" });
    },
  };
  const registry = new ActionRegistry(runner).register({
    name: "organization.scoped" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/scoped",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      type: "query",
      access: "Authenticated",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      authorize: (authorized) => {
        calls.push(`authorize:${authorized.principal}`);
      },
    },
    handler: (authorized) => {
      calls.push(`handler:${authorized.principal}`);
      return null;
    },
  });

  assertEquals(
    await registry.execute("organization.scoped", context(), {}),
    null,
  );
  assertEquals(calls, [
    "runner:organization.scoped",
    "authorize:authorized",
    "handler:authorized",
  ]);
});

Deno.test("authority runner does not replace an unscoped authorization guard", async () => {
  let runnerCalled = false;
  const runner: ActionAuthorityRunner = {
    run: (_action, _context, _input, next) => {
      runnerCalled = true;
      return next(_context);
    },
  };
  const registry = new ActionRegistry(runner).register({
    name: "identity.unscoped" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/unscoped",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: { type: "query", access: "Authenticated" },
    handler: () => null,
  });

  await assertRejects(
    () => registry.execute("identity.unscoped", context(), {}),
    ActionAuthorizationError,
    "no authorization guard",
  );
  assertEquals(runnerCalled, false);
});

Deno.test("central authorization uses live roles, permissions, and exact grants", () => {
  const subject = {
    principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const action = (
    name: string,
    access: string,
    guarded = false,
  ): ActionDefinition => ({
    name: name as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/scoped",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      type: "query" as const,
      access: access as ActionAccess,
      ...(guarded ? { authorize: () => undefined } : {}),
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: () => null,
  });
  const actor = (
    organizationId: string,
    role: OrganizationRoleValue,
  ): OrganizationActor => ({
    subject,
    organizationId: asOrganizationId(organizationId),
    role,
    capabilities: [],
  });
  const organizationA = actor(
    "00000000-0000-4000-8000-00000000000a",
    OrganizationRole.Admin,
  );
  const organizationB = actor(
    "00000000-0000-4000-8000-00000000000b",
    OrganizationRole.Developer,
  );

  authorize(organizationA, "organizationMembership:manage");
  authorize(organizationB, "organizationMembership:read");
  assertThrows(
    () => authorize(organizationB, "organizationMembership:manage"),
    StandardError,
  );
  const viewer = actor(
    "00000000-0000-4000-8000-00000000000c",
    OrganizationRole.Viewer,
  );
  const guest = actor(
    "00000000-0000-4000-8000-00000000000d",
    OrganizationRole.Guest,
  );
  authorize(viewer, "organization:read");
  assertThrows(
    () => authorize(viewer, "organization:manage"),
    StandardError,
  );
  assertThrows(
    () => authorize(guest, "organization:read"),
    StandardError,
  );
  assertEquals(
    organizationPermissions(viewer).includes("organization:read"),
    true,
  );
  assertEquals(organizationPermissions(viewer).includes("secret:read"), false);
  assertEquals(organizationPermissions(guest), []);

  authorizeOrganizationAction(
    action(
      "skillVersions.get",
      "Developer or Worker (pinned version + current lease)",
      true,
    ),
    organizationB,
  );
  assertThrows(
    () =>
      authorizeOrganizationAction(
        action(
          "skillVersions.get",
          "Developer or Worker (pinned version + current lease)",
        ),
        organizationB,
      ),
    ActionAuthorizationError,
  );

  const service = {
    ...organizationB,
    subject: { ...subject, principalType: PrincipalType.Service },
    role: undefined,
    capabilities: ["tasks.list"],
  };
  for (const principalType of [PrincipalType.Service, PrincipalType.Worker]) {
    authorize(
      {
        ...service,
        subject: { ...service.subject, principalType },
      },
      "task:read",
      { action: "tasks.list" },
    );
  }
  assertThrows(
    () => authorize(service, "task:write", { action: "tasks.create" }),
    StandardError,
  );
  assertThrows(
    () =>
      authorize({ ...service, capabilities: ["tasks.*"] }, "task:read", {
        action: "tasks.list",
      }),
    StandardError,
  );
  const humanWithoutMembership = {
    ...service,
    subject: { ...service.subject, principalType: PrincipalType.Human },
  };
  assertThrows(
    () =>
      authorize(humanWithoutMembership, "task:read", {
        action: "tasks.list",
      }),
    StandardError,
  );
  assertEquals(organizationPermissions(humanWithoutMembership), []);

  const roleBearingService = {
    ...service,
    role: OrganizationRole.Developer,
    capabilities: [],
  };
  authorize(roleBearingService, "task:read");
  assertThrows(
    () => authorize(roleBearingService, "organizationMembership:manage"),
    StandardError,
  );
  assertEquals(
    organizationPermissions(roleBearingService).includes("task:read"),
    true,
  );
});

Deno.test("effective access lists every role permission without truncation", () => {
  const subject: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const roleActor = (role: OrganizationRoleValue): OrganizationActor => ({
    subject,
    organizationId: asOrganizationId(organizationA),
    role,
    capabilities: [],
  });

  const roles = [
    OrganizationRole.Admin,
    OrganizationRole.Developer,
    OrganizationRole.Viewer,
    OrganizationRole.Guest,
  ] as const;
  for (const role of roles) {
    assertEquals(
      organizationPermissions(roleActor(role)).length,
      rolePermissions[role].length,
    );
  }

  // Role lattice: admin is a superset of developer, developer a superset of
  // viewer, and guest carries nothing.
  for (const key of rolePermissions.developer) {
    assert(rolePermissions.admin.includes(key));
  }
  for (const key of rolePermissions.viewer) {
    assert(rolePermissions.developer.includes(key));
  }
  assertEquals(rolePermissions.guest, []);

  const bound = (transport.outputs as Record<
    string,
    { fieldBounds?: { capabilities?: { maxItems?: number } } | null }
  >).EffectiveAccess.fieldBounds?.capabilities?.maxItems;
  assert(typeof bound === "number");
  assert(
    bound >= Math.max(...roles.map((role) => rolePermissions[role].length)),
  );
});

Deno.test("generated catalog literal types match the catalog", async () => {
  assertEquals(
    await Deno.readTextFile(CATALOG_LITERALS_PATH),
    renderCatalogLiterals(),
  );
});

Deno.test("role precedence helpers fail closed", () => {
  assertEquals(
    roleSatisfies(OrganizationRole.Admin, OrganizationRole.Developer),
    true,
  );
  assertEquals(
    roleSatisfies(OrganizationRole.Admin, OrganizationRole.Admin),
    true,
  );
  assertEquals(
    roleSatisfies(OrganizationRole.Developer, OrganizationRole.Admin),
    false,
  );
  const actor: OrganizationActor = {
    subject: {
      principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
      principalType: PrincipalType.Human,
      displayName: "Bakery User",
    },
    organizationId: asOrganizationId("00000000-0000-4000-8000-00000000000a"),
    role: OrganizationRole.Developer,
    capabilities: [],
  };
  assertEquals(hasAnyRole(actor, OrganizationRole.Developer), true);
  assertEquals(hasAnyRole(actor, OrganizationRole.Admin), false);
  assertEquals(
    hasAnyRole({ ...actor, role: undefined }, OrganizationRole.Developer),
    false,
  );
  assertEquals(requireActorRole(actor), OrganizationRole.Developer);
  assertThrows(
    () => requireActorRole({ ...actor, role: undefined }),
    StandardError,
  );
});

Deno.test("organizationIdParam must name a route parameter of a scoped action", () => {
  const base = {
    name: "organizations.get" as const,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Organization,
    handler: () => null as never,
  };
  new ActionRegistry().register({
    ...base,
    policy: {
      type: ActionKind.Query,
      access: "Organization member",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
      organizationIdParam: "id",
    },
  });
  assertThrows(
    () =>
      new ActionRegistry().register({
        ...base,
        policy: {
          type: ActionKind.Query,
          access: "Organization member",
          organizationContext:
            OrganizationContextPolicy.RequiredAuthenticatedContext,
          organizationIdParam: "organizationId",
        },
      }),
    ActionRegistryError,
    "organizationIdParam",
  );
  assertThrows(
    () =>
      new ActionRegistry().register({
        ...base,
        policy: {
          type: ActionKind.Query,
          access: "Authenticated principal",
          organizationContext:
            OrganizationContextPolicy.AuthenticatedPrincipalScope,
          organizationIdParam: "id",
        },
      }),
    ActionRegistryError,
    "organizationIdParam",
  );
});

Deno.test("invitation lookups collapse provider 400/403 hints to not found", () => {
  const path = "/api/auth/organization/get-invitation";
  assertEquals(
    isInvitationNotFound(path, 400, { code: "INVITATION_NOT_FOUND" }),
    true,
  );
  assertEquals(
    isInvitationNotFound(path, 403, {
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    }),
    true,
  );
  assertEquals(
    isInvitationNotFound(path, 400, { message: "Invitation not found!" }),
    true,
  );
  assertEquals(isInvitationNotFound(path, 400, { code: "OTHER" }), false);
  assertEquals(
    isInvitationNotFound(path, 500, { code: "INVITATION_NOT_FOUND" }),
    false,
  );
  assertEquals(isInvitationNotFound(path, 400, undefined), false);
  assertEquals(
    isInvitationNotFound("/api/auth/sign-in", 400, {
      code: "INVITATION_NOT_FOUND",
    }),
    false,
  );
});

Deno.test("organization read projections use canonical rows and preserve null roles", async () => {
  const statements: string[] = [];
  const serviceId = "00000000-0000-4000-8000-000000000003";
  const invitationId = "00000000-0000-4000-8000-000000000004";
  const createdAt = new Date("2026-09-10T12:00:00Z");
  const client = {
    query(statement: string) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      statements.push(sql);
      if (
        sql.includes("from bakery.organizations as organization") &&
        sql.includes("left join bakery.organization_memberships")
      ) {
        return {
          rows: [{
            id: organizationA,
            name: "Canonical Organization",
            slug: "canonical",
            logo: null,
            metadata: { source: "canonical" },
            createdAt,
            updatedAt: createdAt,
            version: 1,
            role: null,
            cursorCreatedAt: createdAt,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from bakery.organizations as organization")) {
        return {
          rows: [{
            id: organizationA,
            name: "Canonical Organization",
            slug: "canonical",
            logo: null,
            metadata: { source: "canonical" },
            createdAt,
            updatedAt: createdAt,
            version: 1,
            cursorCreatedAt: createdAt,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from bakery.organization_memberships as membership")) {
        return {
          rows: [{
            id: serviceId,
            organizationId: organizationA,
            principalId: serviceId,
            role: null,
            status: "active",
            joinedAt: createdAt,
            createdAt,
            updatedAt: createdAt,
            version: 1,
            cursorCreatedAt: createdAt,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from bakery.organization_invitations as invitation")) {
        return {
          rows: sql.includes("recipient_user")
            ? [{
              id: invitationId,
              email: "recipient@example.test",
              role: "developer",
              organizationId: organizationA,
              inviterId: serviceId,
              status: "pending",
              expiresAt: new Date("2026-09-12T12:00:00Z"),
              organizationName: "Canonical Organization",
              organizationSlug: "canonical",
              inviterEmail: null,
            }]
            : [{
              id: invitationId,
              organizationId: organizationA,
              email: "recipient@example.test",
              role: "developer",
              status: "pending",
              expiresAt: new Date("2026-09-12T12:00:00Z"),
              inviterPrincipalId: serviceId,
              createdAt,
              cursorCreatedAt: createdAt,
            }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected read: ${sql}`);
    },
  };
  const store = new PostgresOrganizationStore("phase-4-read-secret");
  const service: AuthenticatedSubject = {
    principalId: asPrincipalId(serviceId),
    principalType: PrincipalType.Service,
    displayName: "Canonical Service",
  };
  const human: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Recipient",
  };
  const actor = {
    subject: service,
    organizationId: organizationA,
    role: undefined,
    capabilities: [],
  } as unknown as OrganizationActor;

  const organizations = await store.listOrganizations(
    client as never,
    service,
    {},
  );
  const organization = await store.getOrganization(
    client as never,
    actor,
    organizationA,
  );
  const memberships = await store.listMemberships(
    client as never,
    actor,
    organizationA,
    {},
  );
  const invitations = await store.listInvitations(
    client as never,
    actor,
    organizationA,
    {},
  );
  const recipient = await store.getRecipientInvitation(
    client as never,
    human,
    { id: invitationId },
  );

  assertEquals(organizations.items[0].role, null);
  assertEquals(organizations.items[0].metadata, { source: "canonical" });
  assertEquals(organization.metadata, { source: "canonical" });
  assertEquals(memberships.items[0].role, null);
  assertEquals(invitations.items[0].inviterPrincipalId, serviceId);
  assertEquals(recipient.inviterId, serviceId);
  assertEquals(recipient.inviterEmail, null);
  assertEquals(
    statements.every((statement) =>
      !/(from|join) public\.(organization|member|invitation)\b/.test(statement)
    ),
    true,
  );
});

Deno.test("recipient get compatibility route executes the canonical read action", async () => {
  const recipientId = asPrincipalId("00000000-0000-4000-8000-000000000005");
  const invitationId = "00000000-0000-4000-8000-000000000006";
  const client = {
    query(statement: string, values: unknown[] = []) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      if (sql.includes("from bakery.principals") && values[0] === recipientId) {
        return {
          rows: [{
            principalId: recipientId,
            principalType: PrincipalType.Human,
            displayName: "Recipient",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from bakery.organization_invitations as invitation")) {
        return {
          rows: [{
            id: invitationId,
            email: "recipient@example.test",
            role: "developer",
            organizationId: organizationA,
            inviterId: null,
            status: "pending",
            expiresAt: new Date("2026-09-12T12:00:00Z"),
            organizationName: "Canonical Organization",
            organizationSlug: "canonical",
            inviterEmail: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const principal: AuthenticatedSubject = {
    principalId: recipientId,
    principalType: PrincipalType.Human,
    displayName: "Recipient",
  };
  const secret = "phase-4-recipient-route-secret";
  const token = "recipient-compatibility-route-session";
  const expiresAt = new Date(Date.now() + 60_000);
  const app = createAuthRoutes({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { expiresAt },
            user: {
              id: "provider-user",
              name: "Recipient",
              email: "recipient@example.test",
            },
          }),
      },
      handler: () =>
        Promise.resolve(new Response("provider fallback", { status: 418 })),
    },
    database: {
      connect: () => Promise.resolve(client),
    } as unknown as PgDatabase,
    store: {
      findSessionState: () =>
        Promise.resolve({
          id: token,
          expiresAt,
          twoFactorEnabled: false,
          factorVerifiedAt: null,
        }),
      loadEnabledPrincipal: () => Promise.resolve(principal),
    },
    publicBaseUrl: "http://test",
    trustedOrigins: ["http://test"],
    secret,
  });
  const response = await app.fetch(
    new Request(
      `http://test/api/auth/organization/get-invitation?id=${invitationId}`,
      { headers: { cookie: await signSessionCookie(token, secret) } },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).organizationId, organizationA);
});

Deno.test("recipient acceptance locks canonical state and returns one member", async () => {
  const recipientId = asPrincipalId("00000000-0000-4000-8000-000000000007");
  const invitationId = "00000000-0000-4000-8000-000000000008";
  const memberId = "00000000-0000-4000-8000-000000000009";
  const createdAt = new Date("2026-09-10T12:00:00Z");
  const statements: string[] = [];
  const client = {
    query(statement: string, values: unknown[] = []) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      statements.push(sql);
      if (sql.includes('select organization_id as "organizationid"')) {
        return { rows: [{ organizationId: organizationA }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('join public."user" as provider_user')) {
        return {
          rows: [{
            id: recipientId,
            providerUserId: "00000000-0000-4000-8000-00000000000c",
            principalType: PrincipalType.Human,
            disabledAt: null,
            email: "recipient@example.test",
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("select set_config")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from bakery.organization_invitations as invitation")) {
        return {
          rows: [{
            id: invitationId,
            organizationId: organizationA,
            email: "recipient@example.test",
            role: "developer",
            status: "pending",
            expiresAt: new Date("2026-09-12T12:00:00Z"),
            inviterId: null,
            createdAt,
            cursorCreatedAt: createdAt,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from bakery.organization_memberships")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("insert into bakery.organization_memberships")) {
        return { rows: [{ id: memberId }], rowCount: 1 };
      }
      if (sql.startsWith("update bakery.organization_invitations")) {
        return {
          rows: [{
            id: invitationId,
            organizationId: organizationA,
            email: "recipient@example.test",
            role: "developer",
            status: values[2],
            expiresAt: new Date("2026-09-12T12:00:00Z"),
            inviterId: null,
            createdAt,
            cursorCreatedAt: createdAt,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected mutation: ${sql}`);
    },
  };
  const result = await new PostgresOrganizationStore(
    "phase-5-transition-secret",
  ).acceptRecipientInvitation(
    client as never,
    {
      principalId: recipientId,
      principalType: PrincipalType.Human,
      displayName: "Recipient",
    },
    { invitationId },
  );

  assertEquals(result.invitation.status, "accepted");
  assertEquals(result.member?.id, memberId);
  assertEquals(result.member?.organizationId, organizationA);
  assertEquals(result.member?.userId, "00000000-0000-4000-8000-00000000000c");
  assertEquals(result.member?.role, "developer");
  assertEquals(
    statements.findIndex((statement) =>
      statement.includes("pg_advisory_xact_lock")
    ) <
      statements.findIndex((statement) =>
        statement.startsWith("insert into bakery.organization_memberships")
      ),
    true,
  );
  assertEquals(
    statements.every((statement) =>
      !/(insert into|update|delete from) public\.(organization|member|invitation)\b/
        .test(statement)
    ),
    true,
  );
});
