import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ActionRegistry,
  ActionRegistryError,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  type CatalogActionName,
  contractSchemas,
  OrganizationContextPolicy,
  OrganizationRole,
  principalId as asPrincipalId,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { PostgresOrganizationStore } from "../../apps/server/src/modules/auth/adapters/organization-postgres.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import type {
  AuthorizedActionContext,
  InstallationActor,
  OrganizationActor,
} from "../../apps/server/src/modules/auth/application/authority.ts";
import type { AuthenticatedSubject } from "../../apps/server/src/modules/auth/application/identity.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { encodeCursor } from "../../apps/server/src/platform/cursor.ts";
import { signSessionCookie } from "../helpers/auth.ts";

const organizationA = "00000000-0000-4000-8000-00000000000a";
const organizationB = "00000000-0000-4000-8000-00000000000b";
const principalId = asPrincipalId("00000000-0000-4000-8000-000000000001");
const otherPrincipalId = asPrincipalId(
  "00000000-0000-4000-8000-000000000002",
);

type FakeState = {
  principal: AuthenticatedSubject | null;
  memberships?: Record<
    string,
    {
      principalId?: string;
      role: "admin" | "developer" | "viewer" | "guest" | null;
      status: "active" | "inactive";
    }
  >;
  grants?: Array<{
    organizationId: string;
    capability: string;
    role?: "admin" | "developer" | "viewer" | "guest";
    expiresAt?: number;
    revoked?: boolean;
  }>;
  installationAdministrator?: boolean;
};

function fakeDatabase(state: FakeState) {
  const statements: string[] = [];
  let releases = 0;
  const client = {
    query(text: string, values: unknown[] = []) {
      const sql = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("from bakery.principals")) {
        rows = state.principal && state.principal.principalId === values[0]
          ? [state.principal]
          : [];
      } else if (sql.includes("from bakery.organization_memberships")) {
        const membership = state.memberships?.[String(values[1])];
        rows = membership &&
            (!membership.principalId || membership.principalId === values[0])
          ? [{
            role: membership.role,
            status: membership.status,
            customRoleId: null,
            customRoleKey: null,
            customRolePermissions: null,
          }]
          : [];
      } else if (sql.includes("from public.member")) {
        const membership = state.memberships?.[String(values[1])];
        rows = membership?.status === "active" &&
            (!membership.principalId || membership.principalId === values[0])
          ? [{ role: membership.role }]
          : [];
      } else if (sql.includes("from bakery.permission_grants")) {
        const now = Date.now();
        rows = (state.grants ?? []).filter((grant) =>
          grant.organizationId === values[0] && !grant.revoked &&
          (!grant.expiresAt || grant.expiresAt > now)
        ).map(({ capability, role }) => ({ capability, role: role ?? null }));
      } else if (sql.includes("from bakery.installation_administrators")) {
        rows = state.installationAdministrator ? [{ exists: 1 }] : [];
      }
      return { rows, rowCount: rows.length };
    },
    release() {
      releases++;
    },
  };
  return {
    database: {
      connect: () => Promise.resolve(client),
    } as unknown as PgDatabase,
    statements,
    releases: () => releases,
  };
}

function authorityApp(
  database: PgDatabase,
  options: {
    name: CatalogActionName;
    path: string;
    access: "Authenticated" | "Admin" | "Developer" | "Organization member";
    organizationContext:
      | "authenticated_principal_scope"
      | "required_authenticated_context"
      | "installation_administrator_scope";
    organizationIdParam?: string;
    principal: AuthenticatedSubject;
    handler: (context: AuthorizedActionContext) => void;
  },
) {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
  )
    .register({
      name: options.name,
      method: HttpMethod.Get,
      path: options.path,
      input: contractSchemas.Empty,
      output: contractSchemas.NoContent,
      policy: {
        type: "query",
        access: options.access,
        organizationContext: options.organizationContext,
        organizationIdParam: options.organizationIdParam,
      },
      handler: (context) => {
        options.handler(context as AuthorizedActionContext);
        return null;
      },
    });
  return createApiRouter({
    registry,
    createContext: () => ({ principal: options.principal }),
  });
}

async function problemCode(response: Response): Promise<string> {
  return (await response.json()).code as string;
}

type BrowserAuthorityState = {
  session: boolean;
  principal: AuthenticatedSubject | null;
};

const browserAuthoritySecret = "phase-6-browser-authority-secret";
const browserAuthoritySessionToken = "browser-authority-verified-session";

function browserAuthorityCookie(): Promise<string> {
  return signSessionCookie(
    browserAuthoritySessionToken,
    browserAuthoritySecret,
  );
}

function browserAuthorityApp(
  state: BrowserAuthorityState,
  database: PgDatabase,
) {
  return createAuthV1Routes({
    auth: {
      api: {
        getSession: () =>
          Promise.resolve(
            state.session
              ? {
                session: { expiresAt: new Date(Date.now() + 60_000) },
                user: {
                  id: "provider-user",
                  name: "Provider User",
                  email: "person@example.test",
                },
              }
              : null,
          ),
      },
    },
    database,
    store: {
      findSessionState: () =>
        Promise.resolve(
          state.session
            ? {
              id: browserAuthoritySessionToken,
              expiresAt: new Date(Date.now() + 60_000),
              twoFactorEnabled: false,
              factorVerifiedAt: null,
            }
            : null,
        ),
      loadEnabledPrincipal: () => Promise.resolve(state.principal),
    },
    publicBaseUrl: "http://test",
    secret: browserAuthoritySecret,
  });
}

Deno.test("REST organization scope rejects absent, malformed, duplicate, and conflicting headers", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const fixture = fakeDatabase({
    principal,
    memberships: {
      [organizationA]: {
        principalId,
        role: OrganizationRole.Developer,
        status: "active",
      },
    },
  });
  let calls = 0;
  let resolvedOrganization: string | undefined;
  const app = authorityApp(fixture.database, {
    name: "tasks.list",
    path: "/v1/organizations/:id/scope-check",
    access: "Developer",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    organizationIdParam: "id",
    principal,
    handler: (context) => {
      calls++;
      resolvedOrganization = (context.authority as OrganizationActor)
        .organizationId;
    },
  });
  const request = (headers?: HeadersInit) =>
    app.fetch(
      new Request(
        `http://test/v1/organizations/${organizationA}/scope-check`,
        { headers },
      ),
    );

  const missing = await request();
  assertEquals(missing.status, 403);
  assertEquals(await problemCode(missing), "SCOPE_REQUIRED");

  const malformed = await request({ "Bakery-Organization-Id": "not-a-uuid" });
  assertEquals(malformed.status, 400);
  assertEquals(await problemCode(malformed), "MALFORMED_REQUEST");

  const duplicateHeaders = new Headers();
  duplicateHeaders.append("Bakery-Organization-Id", organizationA);
  duplicateHeaders.append("Bakery-Organization-Id", organizationB);
  const duplicate = await request(duplicateHeaders);
  assertEquals(duplicate.status, 400);
  assertEquals(await problemCode(duplicate), "MALFORMED_REQUEST");

  const conflict = await request({ "Bakery-Organization-Id": organizationB });
  assertEquals(conflict.status, 404);
  assertEquals(await problemCode(conflict), "RESOURCE_NOT_FOUND");
  assertEquals(calls, 0);
  assertEquals(fixture.statements, []);

  const selected = await request({
    "Bakery-Organization-Id": organizationA,
    cookie: `activeOrganizationId=${organizationB}`,
  });
  assertEquals(selected.status, 204);
  assertEquals(calls, 1);
  assertEquals(resolvedOrganization, organizationA);
  assertEquals(
    fixture.statements.some((sql) => sql.includes("set_config")),
    false,
  );
  assertEquals(fixture.releases(), 1);

  const caseInsensitive = await app.fetch(
    new Request(
      `http://test/v1/organizations/${organizationA.toUpperCase()}/scope-check`,
      { headers: { "Bakery-Organization-Id": organizationA.toUpperCase() } },
    ),
  );
  assertEquals(caseInsensitive.status, 204);
  assertEquals(resolvedOrganization, organizationA);
});

Deno.test("every scoped REST action rejects hostile organization headers before its handler", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const fixture = fakeDatabase({ principal, memberships: {} });
  const app = browserAuthorityApp(
    { session: true, principal },
    fixture.database,
  );
  const membershipId = "00000000-0000-4000-8000-000000000010";
  const invitationId = "00000000-0000-4000-8000-000000000011";
  const routes: readonly {
    method: string;
    path: string;
    body?: unknown;
  }[] = [
    { method: "GET", path: `/v1/organizations/${organizationA}` },
    {
      method: "PATCH",
      path: `/v1/organizations/${organizationA}`,
      body: { name: "Updated" },
    },
    {
      method: "GET",
      path: `/v1/organizations/${organizationA}/effective-access`,
    },
    {
      method: "GET",
      path: `/v1/organizations/${organizationA}/memberships`,
    },
    {
      method: "POST",
      path: `/v1/organizations/${organizationA}/memberships`,
      body: { principalId: otherPrincipalId, role: "developer" },
    },
    {
      method: "PATCH",
      path: `/v1/organizations/${organizationA}/memberships/${membershipId}`,
      body: { role: "developer" },
    },
    {
      method: "DELETE",
      path: `/v1/organizations/${organizationA}/memberships/${membershipId}`,
    },
    {
      method: "GET",
      path: `/v1/organizations/${organizationA}/invitations`,
    },
    {
      method: "POST",
      path: `/v1/organizations/${organizationA}/invitations`,
      body: { email: "phase6@example.test", role: "developer" },
    },
    {
      method: "DELETE",
      path: `/v1/organizations/${organizationA}/invitations/${invitationId}`,
    },
  ];
  const cases: readonly {
    name: string;
    header?: string;
    expectedStatus: number;
    expectedCode: string;
    entersTransaction?: boolean;
  }[] = [
    { name: "missing", expectedStatus: 403, expectedCode: "SCOPE_REQUIRED" },
    {
      name: "malformed",
      header: "not-a-uuid",
      expectedStatus: 400,
      expectedCode: "MALFORMED_REQUEST",
    },
    {
      name: "duplicate",
      header: `${organizationA}, ${organizationB}`,
      expectedStatus: 400,
      expectedCode: "MALFORMED_REQUEST",
    },
    {
      name: "conflicting",
      header: organizationB,
      expectedStatus: 404,
      expectedCode: "RESOURCE_NOT_FOUND",
    },
    {
      name: "unauthorized",
      header: organizationA,
      expectedStatus: 404,
      expectedCode: "RESOURCE_NOT_FOUND",
      entersTransaction: true,
    },
  ];

  for (const route of routes) {
    for (const hostile of cases) {
      const headers = new Headers({
        "x-request-id": `phase6-${hostile.name}`,
        origin: "http://test",
        cookie: await browserAuthorityCookie(),
      });
      if (route.body) headers.set("content-type", "application/json");
      if (hostile.header) {
        headers.set("Bakery-Organization-Id", hostile.header);
      }
      const before = fixture.statements.length;
      const response = await app.fetch(
        new Request(`http://test${route.path}`, {
          method: route.method,
          headers,
          body: route.body === undefined
            ? undefined
            : JSON.stringify(route.body),
        }),
      );
      assertEquals(response.status, hostile.expectedStatus, route.path);
      const body = await response.text();
      assert(body.includes(`"code":"${hostile.expectedCode}"`), body);
      for (
        const secret of [
          "postgres://",
          "public.member",
          "bakery.principals",
          "permission_grants",
          "rowCount",
        ]
      ) assertEquals(body.includes(secret), false, `${route.path}: ${secret}`);
      const statements = fixture.statements.slice(before);
      if (hostile.entersTransaction) {
        assert(statements.includes("rollback"), route.path);
        assertEquals(statements.includes("commit"), false, route.path);
        assertEquals(
          statements.some((sql) =>
            sql.includes("from public.organization as organization") ||
            sql.includes("left join bakery.principals as principal") ||
            sql.includes("from public.invitation as invitation")
          ),
          false,
          route.path,
        );
      } else {
        assertEquals(statements, [], `${route.path}: ${hostile.name}`);
      }
    }
  }
});

Deno.test("cookie-authenticated mutations reject missing and foreign origins", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const fixture = fakeDatabase({ principal });
  const app = browserAuthorityApp(
    { session: true, principal },
    fixture.database,
  );
  for (const origin of [undefined, "https://attacker.example.test"]) {
    const headers = new Headers({ cookie: "better-auth.session_token=opaque" });
    if (origin) headers.set("origin", origin);
    const response = await app.fetch(
      new Request("http://test/v1/organizations", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Organization", slug: "organization" }),
      }),
    );
    assertEquals(response.status, 403);
    assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
  }
  assertEquals(fixture.statements, []);
});

Deno.test("runner reloads per-organization roles and exact service grants", async () => {
  const human: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const state: FakeState = {
    principal: human,
    memberships: {
      [organizationA]: {
        principalId,
        role: OrganizationRole.Admin,
        status: "active",
      },
      [organizationB]: {
        principalId,
        role: OrganizationRole.Developer,
        status: "active",
      },
      ["00000000-0000-4000-8000-00000000000c"]: {
        principalId,
        role: OrganizationRole.Viewer,
        status: "active",
      },
      ["00000000-0000-4000-8000-00000000000d"]: {
        principalId,
        role: OrganizationRole.Guest,
        status: "active",
      },
    },
  };
  const fixture = fakeDatabase(state);
  let calls = 0;
  const app = authorityApp(fixture.database, {
    name: "organizationMemberships.create",
    path: "/v1/organizations/:id/members",
    access: "Admin",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    principal: human,
    handler: () => {
      calls++;
    },
  });
  const invoke = (organizationId: string) =>
    app.fetch(
      new Request(`http://test/v1/organizations/${organizationId}/members`, {
        headers: { "Bakery-Organization-Id": organizationId },
      }),
    );

  assertEquals((await invoke(organizationA)).status, 204);
  const developer = await invoke(organizationB);
  assertEquals(developer.status, 403);
  assertEquals(await problemCode(developer), "AUTH_FORBIDDEN");
  assertEquals(calls, 1);

  const organizationC = "00000000-0000-4000-8000-00000000000c";
  const organizationD = "00000000-0000-4000-8000-00000000000d";
  const viewerMutation = await invoke(organizationC);
  assertEquals(viewerMutation.status, 403);
  assertEquals(await problemCode(viewerMutation), "AUTH_FORBIDDEN");
  const readApp = authorityApp(fixture.database, {
    name: "organizations.effectiveAccess",
    path: "/v1/organizations/:id/effective-access",
    access: "Organization member",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    principal: human,
    handler: () => undefined,
  });
  const read = (organizationId: string) =>
    readApp.fetch(
      new Request(
        `http://test/v1/organizations/${organizationId}/effective-access`,
        { headers: { "Bakery-Organization-Id": organizationId } },
      ),
    );
  assertEquals((await read(organizationC)).status, 204);
  const guestRead = await read(organizationD);
  assertEquals(guestRead.status, 404);
  assertEquals(await problemCode(guestRead), "RESOURCE_NOT_FOUND");

  const guestMutation = await invoke(organizationD);
  assertEquals(guestMutation.status, 404);
  assertEquals(await problemCode(guestMutation), "RESOURCE_NOT_FOUND");
  assertEquals(calls, 1);

  state.memberships![organizationB].status = "inactive";
  const inactive = await invoke(organizationB);
  assertEquals(inactive.status, 404);
  assertEquals(await problemCode(inactive), "RESOURCE_NOT_FOUND");

  state.principal = null;
  const disabled = await invoke(organizationA);
  assertEquals(disabled.status, 403);
  assertEquals(await problemCode(disabled), "AUTH_FORBIDDEN");

  state.principal = {
    ...human,
    principalId: otherPrincipalId,
  };
  const rebound = await invoke(organizationA);
  assertEquals(rebound.status, 403);
  assertEquals(await problemCode(rebound), "AUTH_FORBIDDEN");
  assert(
    fixture.statements.some((sql) =>
      sql.includes("from bakery.organization_memberships")
    ),
  );
  assertEquals(
    fixture.statements.some((sql) => sql.includes("from public.member")),
    false,
  );

  const service: AuthenticatedSubject = {
    ...human,
    principalId: asPrincipalId("00000000-0000-4000-8000-000000000003"),
    principalType: PrincipalType.Service,
  };
  state.principal = service;
  state.grants = [{
    organizationId: organizationA,
    capability: "permissionGrants.list",
  }];
  const serviceFixture = fakeDatabase(state);
  let serviceCalls = 0;
  const serviceApp = authorityApp(serviceFixture.database, {
    name: "permissionGrants.list",
    path: "/v1/organizations/:id/tasks",
    access: "Developer",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    principal: service,
    handler: () => {
      serviceCalls++;
    },
  });
  const serviceRequest = () =>
    serviceApp.fetch(
      new Request(
        `http://test/v1/organizations/${organizationA}/tasks`,
        { headers: { "Bakery-Organization-Id": organizationA } },
      ),
    );
  assertEquals((await serviceRequest()).status, 204);

  state.grants = [{ organizationId: organizationA, capability: "tasks.*" }];
  const wrong = await serviceRequest();
  assertEquals(wrong.status, 404);
  assertEquals(await problemCode(wrong), "RESOURCE_NOT_FOUND");

  state.grants = [{
    organizationId: organizationA,
    capability: "permissionGrants.list",
    expiresAt: Date.now() - 1,
  }];
  const expired = await serviceRequest();
  assertEquals(expired.status, 404);
  assertEquals(await problemCode(expired), "RESOURCE_NOT_FOUND");

  state.grants = [{
    organizationId: organizationA,
    capability: "permissionGrants.list",
    revoked: true,
  }];
  const revoked = await serviceRequest();
  assertEquals(revoked.status, 404);
  assertEquals(await problemCode(revoked), "RESOURCE_NOT_FOUND");
  assertEquals(serviceCalls, 1);
  assert(
    serviceFixture.statements.some((sql) =>
      sql.includes("from bakery.organization_memberships")
    ),
  );
  assertEquals(
    serviceFixture.statements.some((sql) => sql.includes("from public.member")),
    false,
  );
  assert(
    serviceFixture.statements.some((sql) =>
      sql.includes("expires_at > current_timestamp") &&
      sql.includes("revoked_at is null")
    ),
  );
});

Deno.test("installation administration stays separate from organization authority", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Installation Admin",
  };
  const fixture = fakeDatabase({
    principal,
    installationAdministrator: true,
  });
  let installationActor: InstallationActor | undefined;
  const installationApp = authorityApp(fixture.database, {
    name: "installations.list" as CatalogActionName,
    path: "/v1/installations",
    access: "Authenticated",
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
    principal,
    handler: (context) => {
      installationActor = context.authority as InstallationActor;
    },
  });
  assertEquals(
    (await installationApp.fetch(new Request("http://test/v1/installations")))
      .status,
    204,
  );
  assertEquals(installationActor?.installationAdministrator, true);

  let organizationCalls = 0;
  const organizationApp = authorityApp(fixture.database, {
    name: "tasks.list",
    path: "/v1/organizations/:id",
    access: "Developer",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    principal,
    handler: () => {
      organizationCalls++;
    },
  });
  const denied = await organizationApp.fetch(
    new Request(
      `http://test/v1/organizations/${organizationA}`,
      { headers: { "Bakery-Organization-Id": organizationA } },
    ),
  );
  assertEquals(denied.status, 404);
  assertEquals(await problemCode(denied), "RESOURCE_NOT_FOUND");
  assertEquals(organizationCalls, 0);
});

Deno.test("authenticated principal scope reloads the subject without inventing an organization", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const state: FakeState = { principal };
  const fixture = fakeDatabase(state);
  let calls = 0;
  const app = authorityApp(fixture.database, {
    name: "organizations.list",
    path: "/v1/organizations",
    access: "Authenticated",
    organizationContext: OrganizationContextPolicy.AuthenticatedPrincipalScope,
    principal,
    handler: (context) => {
      calls++;
      assertEquals(context.authority, principal);
      assert(context.transaction);
    },
  });
  const request = () =>
    app.fetch(
      new Request("http://test/v1/organizations", {
        headers: {
          "Bakery-Organization-Id": organizationB,
          cookie: `activeOrganizationId=${organizationA}`,
        },
      }),
    );

  assertEquals((await request()).status, 204);
  assertEquals(calls, 1);
  assertEquals(
    fixture.statements.some((sql) => sql.includes("set_config")),
    false,
  );
  state.principal = null;
  const disabled = await request();
  assertEquals(disabled.status, 403);
  assertEquals(await problemCode(disabled), "AUTH_FORBIDDEN");
  assertEquals(calls, 1);
});

Deno.test("REST reloads session, membership, and principal revocation before the next handler", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const browserState: BrowserAuthorityState = {
    session: true,
    principal,
  };
  const authorityState: FakeState = {
    principal,
    memberships: {
      [organizationA]: {
        principalId,
        role: OrganizationRole.Admin,
        status: "active",
      },
    },
  };
  const fixture = fakeDatabase(authorityState);
  const app = browserAuthorityApp(browserState, fixture.database);
  const cookie = await browserAuthorityCookie();
  const request = () =>
    app.fetch(
      new Request(
        `http://test/v1/organizations/${organizationA}/effective-access`,
        { headers: { "Bakery-Organization-Id": organizationA, cookie } },
      ),
    );

  assertEquals((await request()).status, 200);
  authorityState.memberships![organizationA].status = "inactive";
  const removed = await request();
  assertEquals(removed.status, 404);
  assertEquals(await problemCode(removed), "RESOURCE_NOT_FOUND");

  authorityState.memberships![organizationA].status = "active";
  browserState.session = false;
  const beforeSessionRevocation = fixture.statements.length;
  const revokedSession = await request();
  assertEquals(revokedSession.status, 401);
  // A signed cookie is present but the provider reports no session (revoked):
  // the same shape a real revoked/expired session produces, distinct from no
  // cookie at all (AUTH_REQUIRED).
  assertEquals(await problemCode(revokedSession), "AUTH_INVALID");
  assertEquals(fixture.statements.length, beforeSessionRevocation);

  browserState.session = true;
  browserState.principal = null;
  const beforePrincipalDisablement = fixture.statements.length;
  const disabledBeforeRunner = await request();
  assertEquals(disabledBeforeRunner.status, 403);
  assertEquals(await problemCode(disabledBeforeRunner), "AUTH_FORBIDDEN");
  assertEquals(fixture.statements.length, beforePrincipalDisablement);

  browserState.principal = principal;
  authorityState.principal = null;
  const disabledInsideRunner = await request();
  assertEquals(disabledInsideRunner.status, 403);
  assertEquals(await problemCode(disabledInsideRunner), "AUTH_FORBIDDEN");
  assert(fixture.statements.includes("rollback"));
});

Deno.test("absent and foreign REST resources return identical bounded problems", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const callerMembershipId = "00000000-0000-4000-8000-000000000012";
  const client = {
    query(statement: string, values: unknown[] = []) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      let rows: unknown[] = [];
      if (sql.includes("from bakery.principals")) {
        rows = [principal];
      } else if (
        sql.startsWith("select membership.role from public.member")
      ) {
        rows = values[1] === organizationA ? [{ role: "admin" }] : [];
      } else if (
        sql.startsWith("select id from public.organization")
      ) {
        rows = values[0] === organizationA ? [{ id: organizationA }] : [];
      } else if (
        sql.startsWith("select membership.id from public.member") &&
        sql.includes("join bakery.principals") &&
        !sql.includes("left join bakery.principals")
      ) {
        rows = [{ id: callerMembershipId }];
      } else if (sql.startsWith("select id from public.member")) {
        rows = [{ id: callerMembershipId }];
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release() {},
  };
  const app = browserAuthorityApp(
    { session: true, principal },
    { connect: () => Promise.resolve(client) } as unknown as PgDatabase,
  );
  const cookie = await browserAuthorityCookie();
  const request = (
    method: string,
    path: string,
    selectedOrganization: string,
    body?: unknown,
  ) => {
    const headers = new Headers({
      "Bakery-Organization-Id": selectedOrganization,
      "x-request-id": "phase6-resource-problem",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      origin: "http://test",
      cookie,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    return app.fetch(
      new Request(`http://test${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };
  const snapshot = async (response: Response) => ({
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  });
  const absentMembership = "00000000-0000-4000-8000-000000000013";
  const foreignMembership = "00000000-0000-4000-8000-000000000014";
  const absentInvitation = "00000000-0000-4000-8000-000000000015";
  const foreignInvitation = "00000000-0000-4000-8000-000000000016";
  const comparisons = [
    [
      () => request("GET", `/v1/organizations/${organizationA}`, organizationA),
      () => request("GET", `/v1/organizations/${organizationB}`, organizationB),
    ],
    [
      () =>
        request(
          "PATCH",
          `/v1/organizations/${organizationA}/memberships/${absentMembership}`,
          organizationA,
          { role: "developer" },
        ),
      () =>
        request(
          "PATCH",
          `/v1/organizations/${organizationA}/memberships/${foreignMembership}`,
          organizationA,
          { role: "developer" },
        ),
    ],
    [
      () =>
        request(
          "DELETE",
          `/v1/organizations/${organizationA}/invitations/${absentInvitation}`,
          organizationA,
        ),
      () =>
        request(
          "DELETE",
          `/v1/organizations/${organizationA}/invitations/${foreignInvitation}`,
          organizationA,
        ),
    ],
  ];

  for (const [absentRequest, foreignRequest] of comparisons) {
    const absent = await snapshot(await absentRequest());
    const foreign = await snapshot(await foreignRequest());
    assertEquals(absent, foreign);
    assertEquals(absent.status, 404);
    assert(absent.body.includes('"code":"RESOURCE_NOT_FOUND"'));
    for (
      const secret of [
        organizationB,
        foreignMembership,
        foreignInvitation,
        "rowCount",
        "count",
        "public.",
        "bakery.",
        "postgres://",
      ]
    ) assertEquals(absent.body.includes(secret), false, secret);
  }
});

Deno.test("read routes reject cursor confusion and redact corrupt or foreign rows", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const secret = "phase-4-security-secret-value";
  const sessionToken = "read-routes-verified-session";
  const client = {
    query(statement: string, values: unknown[] = []) {
      const sql = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
      let rows: unknown[] = [];
      if (sql.includes("join public.organization")) {
        rows = [];
      } else if (sql.includes("from bakery.organizations as organization")) {
        rows = values[0] === organizationA && values[1] === organizationA
          ? [{
            id: organizationA,
            name: "Foreign Secret Organization",
            slug: "foreign-secret",
            logo: null,
            metadata: '{"credential":"do-not-disclose"',
            providerToken: "provider-token-must-stay-private",
            databaseUrl: "postgres://user:password@database/bakery",
            createdAt: new Date("2026-09-10T12:00:00Z"),
            updatedAt: new Date("2026-09-10T12:00:00Z"),
            version: 1,
            cursorCreatedAt: new Date("2026-09-10T12:00:00Z"),
          }]
          : [];
      } else if (
        sql.includes("from public.organization as organization")
      ) {
        rows = values[0] === organizationA && values[1] === organizationA
          ? [{
            id: organizationA,
            name: "Foreign Secret Organization",
            slug: "foreign-secret",
            logo: null,
            metadata: '{"credential":"do-not-disclose"',
            providerToken: "provider-token-must-stay-private",
            databaseUrl: "postgres://user:password@database/bakery",
            createdAt: new Date("2026-09-10T12:00:00Z"),
            updatedAt: new Date("2026-09-10T12:00:00Z"),
            version: 1,
            cursorCreatedAt: new Date("2026-09-10T12:00:00Z"),
          }]
          : [];
      } else if (sql.includes("left join bakery.principals as principal")) {
        rows = [{
          id: "00000000-0000-4000-8000-000000000003",
          organizationId: organizationB,
          principalId: otherPrincipalId,
          role: "developer",
          status: "inactive",
          inactiveForeignRow: "inactive-foreign-row",
          joinedAt: new Date("2026-09-10T12:00:00Z"),
          createdAt: new Date("2026-09-10T12:00:00Z"),
          updatedAt: new Date("2026-09-10T12:00:00Z"),
          version: 1,
          cursorCreatedAt: new Date("2026-09-10T12:00:00Z"),
        }];
      } else if (sql.includes("from public.invitation as invitation")) {
        rows = [{
          id: "00000000-0000-4000-8000-000000000004",
          organizationId: organizationB,
          email: "foreign@example.test",
          role: "developer",
          status: "pending",
          expiresAt: new Date("2026-09-11T12:00:00Z"),
          inviterPrincipalId: otherPrincipalId,
          invitationToken: "invitation-token-must-stay-private",
          createdAt: new Date("2026-09-10T12:00:00Z"),
          cursorCreatedAt: new Date("2026-09-10T12:00:00Z"),
        }];
      } else if (sql.includes("from bakery.principals")) {
        rows = [principal];
      } else if (sql.includes("from bakery.organization_memberships")) {
        rows = [{ role: "admin", status: "active" }];
      } else if (sql.includes("from public.member")) {
        rows = values[1] === organizationA ? [{ role: "admin" }] : [];
      }
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
  const position = {
    createdAt: "2026-09-10T12:00:00.000000Z",
    id: "00000000-0000-4000-8000-000000000009",
  };
  const wrongCursors = [
    await encodeCursor(secret, {
      action: "organizationMemberships.list",
      principalId,
      organizationId: organizationA,
      ordering: "createdAt:asc,id:asc",
      filters: "{}",
      schemaVersion: 1,
    }, position),
    await encodeCursor(secret, {
      action: "organizations.list",
      principalId: otherPrincipalId,
      ordering: "createdAt:asc,id:asc",
      filters: "{}",
      schemaVersion: 1,
    }, position),
    "not-a-cursor",
    "a".repeat(513),
  ];
  for (const cursor of wrongCursors) {
    const response = await app.fetch(
      new Request(
        `http://test/v1/organizations?cursor=${encodeURIComponent(cursor)}`,
        { headers: { cookie } },
      ),
    );
    assertEquals(response.status, 400);
    const body = await response.text();
    assert(body.includes('"code":"INVALID_CURSOR"'));
    for (
      const secretValue of [
        "Foreign Secret Organization",
        "do-not-disclose",
        "public.organization",
        "provider-token-must-stay-private",
        "postgres://user:password@database/bakery",
        "select ",
        "rowCount",
      ]
    ) assertEquals(body.includes(secretValue), false, secretValue);
  }

  const corrupt = await app.fetch(
    new Request(`http://test/v1/organizations/${organizationA}`, {
      headers: { "Bakery-Organization-Id": organizationA, cookie },
    }),
  );
  assertEquals(corrupt.status, 500);
  const corruptBody = await corrupt.text();
  assert(corruptBody.includes('"code":"INTERNAL"'));
  for (
    const secretValue of [
      "Foreign Secret Organization",
      "foreign-secret",
      "do-not-disclose",
      "AUTH_READ_METADATA_INVALID",
      "public.organization",
      "provider-token-must-stay-private",
      "postgres://user:password@database/bakery",
    ]
  ) assertEquals(corruptBody.includes(secretValue), false, secretValue);

  const foreign = await app.fetch(
    new Request(`http://test/v1/organizations/${organizationB}`, {
      headers: { "Bakery-Organization-Id": organizationB, cookie },
    }),
  );
  assertEquals(foreign.status, 404);
  const foreignBody = await foreign.text();
  assert(foreignBody.includes('"code":"RESOURCE_NOT_FOUND"'));
  assertEquals(foreignBody.includes("Foreign Secret Organization"), false);
  assertEquals(foreignBody.includes("do-not-disclose"), false);

  for (const suffix of ["/memberships", "/invitations"]) {
    const response = await app.fetch(
      new Request(`http://test/v1/organizations/${organizationA}${suffix}`, {
        headers: { "Bakery-Organization-Id": organizationA, cookie },
      }),
    );
    assertEquals(response.status, 200, suffix);
    const body = await response.text();
    assert(body.includes('"items":[]'), suffix);
    for (
      const secretValue of [
        otherPrincipalId,
        "foreign@example.test",
        "inactive-foreign-row",
        "invitation-token-must-stay-private",
        "provider-token-must-stay-private",
        "postgres://user:password@database/bakery",
      ]
    ) {
      assertEquals(
        body.includes(secretValue),
        false,
        `${suffix}: ${secretValue}`,
      );
    }
  }
});

Deno.test("effective access reflects exact service grant revocation on the next action", async () => {
  const service: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Service,
    displayName: "Bakery Service",
  };
  const state: FakeState = {
    principal: service,
    grants: [
      {
        organizationId: organizationA,
        capability: "organizations.effectiveAccess",
      },
      { organizationId: organizationA, capability: "tasks.list" },
    ],
  };
  const fixture = fakeDatabase(state);
  const store = new PostgresOrganizationStore("phase-4-service-secret");
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(fixture.database),
  );
  registry.register({
    name: "organizations.effectiveAccess",
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/effective-access",
    input: contractSchemas.Empty,
    output: contractSchemas.EffectiveAccess,
    policy: {
      type: "query",
      access: "Organization member",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => {
      const authorized = context as AuthorizedActionContext;
      return store.effectiveAccess(
        authorized.authority as OrganizationActor,
        context.params.id,
      );
    },
  });
  const app = createApiRouter({
    registry,
    createContext: () => ({ principal: service }),
  });
  const request = () =>
    app.fetch(
      new Request(
        `http://test/v1/organizations/${organizationA}/effective-access`,
        { headers: { "Bakery-Organization-Id": organizationA } },
      ),
    );

  const active = await request();
  assertEquals(active.status, 200);
  assertEquals(await active.json(), {
    organizationId: organizationA,
    role: null,
    capabilities: ["organization:read", "task:read"],
  });

  state.grants = [
    {
      organizationId: organizationA,
      capability: "organizations.effectiveAccess",
      revoked: true,
    },
    { organizationId: organizationA, capability: "tasks.list" },
  ];
  const revoked = await request();
  assertEquals(revoked.status, 404);
  assertEquals(await problemCode(revoked), "RESOURCE_NOT_FOUND");

  state.principal = null;
  const disabled = await request();
  assertEquals(disabled.status, 403);
  assertEquals(await problemCode(disabled), "AUTH_FORBIDDEN");
});

Deno.test("runner rolls back before commit on output failure and abort", async () => {
  const principal: AuthenticatedSubject = {
    principalId,
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const state: FakeState = {
    principal,
    memberships: {
      [organizationA]: {
        principalId,
        role: OrganizationRole.Developer,
        status: "active",
      },
    },
  };
  const context = (signal: AbortSignal): AuthorizedActionContext => ({
    request: new Request(
      `http://test/v1/organizations/${organizationA}`,
      { headers: { "Bakery-Organization-Id": organizationA } },
    ),
    params: { id: organizationA },
    requestId: "request-1",
    traceId: "trace-1",
    signal,
    principal,
    authority: principal,
    transaction: undefined as never,
  });

  const invalidFixture = fakeDatabase(state);
  const invalidRegistry = new ActionRegistry(
    new PostgresAuthorityRunner(invalidFixture.database),
  ).register({
    name: "tasks.list",
    method: HttpMethod.Get,
    path: "/v1/organizations/:id",
    input: contractSchemas.Empty,
    output: contractSchemas.PrincipalIdentity,
    policy: {
      type: "query",
      access: "Developer",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: () => null as never,
  });
  await assertRejects(
    () =>
      invalidRegistry.execute(
        "tasks.list",
        context(new AbortController().signal),
        {},
      ),
    ActionRegistryError,
    "returned an invalid output",
  );
  assert(invalidFixture.statements.includes("rollback"));
  assertEquals(invalidFixture.statements.includes("commit"), false);

  const abortFixture = fakeDatabase(state);
  const controller = new AbortController();
  const abortRegistry = new ActionRegistry(
    new PostgresAuthorityRunner(abortFixture.database),
  ).register({
    name: "tasks.list",
    method: HttpMethod.Get,
    path: "/v1/organizations/:id",
    input: contractSchemas.Empty,
    output: contractSchemas.NoContent,
    policy: {
      type: "query",
      access: "Developer",
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: () => {
      controller.abort();
      return null;
    },
  });
  await assertRejects(
    () =>
      abortRegistry.execute(
        "tasks.list",
        context(controller.signal),
        {},
      ),
    DOMException,
    "Action aborted",
  );
  assert(abortFixture.statements.includes("rollback"));
  assertEquals(abortFixture.statements.includes("commit"), false);
});
