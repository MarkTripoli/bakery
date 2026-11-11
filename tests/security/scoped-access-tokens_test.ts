import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";
import {
  adminJson,
  bearerCall,
  createServiceAccount,
  type Json,
  mintToken,
} from "../helpers/access-tokens.ts";

const applicationBody = {
  slug: "tok-app",
  name: "Token app",
  description: "d",
};

async function problem(response: Response) {
  return await response.json() as Json & {
    code: string;
    requiredScopes?: string[];
  };
}

Deno.test("scope miss and permission miss are distinct, and the challenge names the minimal bundle", async () => {
  const f = await openInstallationFixture();
  try {
    const adminAccount = await createServiceAccount(f, "Admin bot", "admin");
    const developerAccount = await createServiceAccount(
      f,
      "Dev bot",
      "developer",
    );
    const readOnly = await mintToken(f, adminAccount.id, ["bakery:read"]);
    const adminScoped = await mintToken(f, developerAccount.id, [
      "bakery:admin",
    ]);

    // Scope miss: the principal may create applications; the token is read-only.
    const scopeMiss = await bearerCall(
      f,
      "POST",
      "/v1/applications",
      readOnly.secret,
      { body: applicationBody },
    );
    assertEquals(scopeMiss.status, 403, await scopeMiss.clone().text());
    const scopeBody = await problem(scopeMiss);
    assertEquals(scopeBody.code, "INSUFFICIENT_SCOPE");
    assertEquals(scopeBody.requiredScopes, ["bakery:admin"]);
    const challenge = scopeMiss.headers.get("www-authenticate") ?? "";
    assert(challenge.includes('error="insufficient_scope"'), challenge);
    assert(challenge.includes('scope="bakery:admin"'), challenge);

    // Permission miss: the token is admin-scoped; the developer principal lacks the permission.
    const permissionMiss = await bearerCall(
      f,
      "POST",
      "/v1/applications",
      adminScoped.secret,
      { body: applicationBody },
    );
    assertEquals(
      permissionMiss.status,
      403,
      await permissionMiss.clone().text(),
    );
    const permissionBody = await problem(permissionMiss);
    assertEquals(permissionBody.code, "AUTH_FORBIDDEN");
    assertEquals(permissionBody.requiredScopes, undefined);
    assertEquals(permissionMiss.headers.get("www-authenticate"), null);

    // A read inside both limits succeeds.
    const allowed = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      readOnly.secret,
    );
    assertEquals(allowed.status, 200, await allowed.clone().text());
  } finally {
    await f.finish();
  }
});

Deno.test("a role removed from the principal takes the token's power on the next call", async () => {
  const f = await openInstallationFixture();
  try {
    const account = await createServiceAccount(f, "Role bot", "developer");
    const token = await mintToken(f, account.id, ["bakery:read"]);
    const before = await bearerCall(f, "GET", "/v1/applications", token.secret);
    assertEquals(before.status, 200, await before.clone().text());

    const memberships = await adminJson(
      f,
      "GET",
      `/v1/organizations/${f.organizationId}/memberships`,
    );
    const items = (await memberships.json()).items as {
      id: string;
      principalId: string;
      version: number;
    }[];
    const membership = items.find((item) => item.principalId === account.id)!;
    const stripped = await adminJson(
      f,
      "PATCH",
      `/v1/organizations/${f.organizationId}/memberships/${membership.id}`,
      { role: null },
    );
    assertEquals(stripped.status, 200, await stripped.clone().text());

    const after = await bearerCall(f, "GET", "/v1/applications", token.secret);
    assertEquals(after.status, 404, await after.clone().text());
  } finally {
    await f.finish();
  }
});

Deno.test("a token used in another organization answers exactly like a foreign organization", async () => {
  const f = await openInstallationFixture();
  try {
    const account = await createServiceAccount(f, "Org bot", "developer");
    const token = await mintToken(f, account.id, ["bakery:read"]);
    const foreign = crypto.randomUUID();

    const tokenForeign = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      token.secret,
      {
        organizationId: foreign,
      },
    );
    const memberForeign = await call(
      f,
      "GET",
      "/v1/applications",
      f.adminCookie,
      {
        headers: orgHeader(foreign),
      },
    );
    assertEquals(tokenForeign.status, 404);
    assertEquals(tokenForeign.status, memberForeign.status);
    const a = await problem(tokenForeign);
    const b = await problem(memberForeign);
    assertEquals(a.code, b.code);
    assertEquals(a.type, b.type);
    assertEquals(a.title, b.title);
    assertEquals(a.detail, b.detail);

    // The token is not usable without an organization context either.
    const noOrg = await bearerCall(f, "GET", "/v1/applications", token.secret, {
      organizationId: null,
    });
    assertNotEquals(noOrg.status, 200);
  } finally {
    await f.finish();
  }
});

Deno.test("a token of a disabled principal, a revoked token and an expired token are refused", async () => {
  const f = await openInstallationFixture();
  try {
    const account = await createServiceAccount(f, "Disabled bot", "developer");
    const token = await mintToken(f, account.id, ["bakery:read"]);
    const ok = await bearerCall(f, "GET", "/v1/applications", token.secret);
    assertEquals(ok.status, 200, await ok.clone().text());

    const disabled = await adminJson(
      f,
      "PATCH",
      `/v1/principals/${account.id}`,
      { disabledAt: new Date().toISOString() },
      { "If-Match": `"v${account.version}"` },
    );
    assertEquals(disabled.status, 200, await disabled.clone().text());
    const refused = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      token.secret,
    );
    assertEquals(refused.status, 401, await refused.clone().text());

    const second = await createServiceAccount(f, "Revoked bot", "developer");
    const revokable = await mintToken(f, second.id, ["bakery:read"]);
    const revoke = await adminJson(
      f,
      "DELETE",
      `/v1/access-tokens/${revokable.id}`,
      undefined,
      { "If-Match": `"v${revokable.version}"` },
    );
    assertEquals(revoke.status, 204, await revoke.clone().text());
    const revoked = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      revokable.secret,
    );
    assertEquals(revoked.status, 401, await revoked.clone().text());

    const third = await createServiceAccount(f, "Expired bot", "developer");
    const expiring = await mintToken(f, third.id, ["bakery:read"]);
    await f.pgDatabase.query(
      "update bakery.access_tokens set expires_at = current_timestamp - interval '1 second' where id = $1",
      [expiring.id],
    );
    const expired = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      expiring.secret,
    );
    assertEquals(expired.status, 401, await expired.clone().text());

    const garbage = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      "bky_" + "x".repeat(43),
    );
    assertEquals(garbage.status, 401);
  } finally {
    await f.finish();
  }
});

Deno.test("non-admins and tokens cannot mint stronger service accounts, grants or tokens", async () => {
  const f = await openInstallationFixture();
  try {
    // A developer human holds neither principal:manage nor accessToken:manage.
    const asDeveloper = (path: string, body: unknown) =>
      call(f, "POST", path, f.developerCookie, {
        body,
        headers: {
          ...orgHeader(f.organizationId),
          "Idempotency-Key": crypto.randomUUID(),
        },
      });
    const devPrincipal = await asDeveloper("/v1/principals", {
      displayName: "Escalated",
      role: "admin",
    });
    assertEquals(devPrincipal.status, 403, await devPrincipal.clone().text());
    const devToken = await asDeveloper("/v1/access-tokens", {
      name: "x",
      scopes: ["bakery:admin"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assertEquals(devToken.status, 403, await devToken.clone().text());

    // A token, even an admin-scoped one of an admin-role service account,
    // cannot change access: those mutations need a browser session.
    const admin = await createServiceAccount(f, "Token admin", "admin");
    const adminToken = await mintToken(f, admin.id, ["bakery:admin"]);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const attempts: [string, string, unknown][] = [
      ["POST", "/v1/principals", {
        displayName: "Via token",
        role: "developer",
      }],
      ["POST", "/v1/access-tokens", {
        name: "copy",
        scopes: ["bakery:read"],
        expiresAt,
      }],
      [
        "POST",
        "/v1/permission-grants",
        { principalId: admin.id, capability: "applications.list" },
      ],
      ["PATCH", `/v1/principals/${admin.id}`, { displayName: "Renamed" }],
      ["POST", "/v1/organization-roles", {
        key: "via-token",
        name: "Via token",
        permissions: ["principal:read"],
      }],
      [
        "PATCH",
        `/v1/organization-roles/${crypto.randomUUID()}`,
        { name: "Renamed" },
      ],
      ["DELETE", `/v1/organization-roles/${crypto.randomUUID()}`, undefined],
      [
        "POST",
        `/v1/organization-roles/${crypto.randomUUID()}/members`,
        { principalId: admin.id },
      ],
      [
        "DELETE",
        `/v1/organization-roles/${crypto.randomUUID()}/members/${admin.id}`,
        undefined,
      ],
      ["DELETE", `/v1/access-tokens/${adminToken.id}`, undefined],
      ["DELETE", `/v1/permission-grants/${crypto.randomUUID()}`, undefined],
      [
        "POST",
        `/v1/organizations/${f.organizationId}/memberships`,
        { principalId: admin.id, role: "admin" },
      ],
      [
        "PATCH",
        `/v1/organizations/${f.organizationId}/memberships/${crypto.randomUUID()}`,
        { role: "admin" },
      ],
      [
        "DELETE",
        `/v1/organizations/${f.organizationId}/memberships/${crypto.randomUUID()}`,
        undefined,
      ],
      [
        "POST",
        `/v1/organizations/${f.organizationId}/invitations`,
        { email: "bearer-invite@example.test", role: "admin" },
      ],
      [
        "DELETE",
        `/v1/organizations/${f.organizationId}/invitations/${crypto.randomUUID()}`,
        undefined,
      ],
    ];
    for (const [method, path, body] of attempts) {
      const response = await bearerCall(f, method, path, adminToken.secret, {
        body,
        headers: method === "GET" ? {} : { "If-Match": '"v1"' },
      });
      assertEquals(response.status, 403, `${method} ${path}`);
      assertEquals((await problem(response)).code, "SESSION_REQUIRED", path);
    }
    // Reads stay available to the scoped token.
    const listed = await bearerCall(
      f,
      "GET",
      "/v1/access-tokens",
      adminToken.secret,
    );
    assertEquals(listed.status, 200, await listed.clone().text());
    // The same administrator through a session can do all of it.
    const viaSession = await adminJson(f, "POST", "/v1/access-tokens", {
      principalId: admin.id,
      name: "from session",
      scopes: ["bakery:read"],
      expiresAt,
    });
    assertEquals(viaSession.status, 201, await viaSession.clone().text());
    const inviteViaSession = await adminJson(
      f,
      "POST",
      `/v1/organizations/${f.organizationId}/invitations`,
      {
        email: `session-invite-${crypto.randomUUID()}@example.test`,
        role: "developer",
      },
    );
    assertEquals(
      inviteViaSession.status,
      201,
      await inviteViaSession.clone().text(),
    );
  } finally {
    await f.finish();
  }
});

Deno.test("grants always record their grantor and the token secret is stored only as a digest", async () => {
  const f = await openInstallationFixture();
  try {
    const account = await createServiceAccount(f, "Grantee", null);
    const granted = await adminJson(f, "POST", "/v1/permission-grants", {
      principalId: account.id,
      capability: "applications.list",
    });
    assertEquals(granted.status, 201, await granted.clone().text());
    const grant = await granted.json() as Json & {
      id: string;
      version: number;
    };
    const row = await f.pgDatabase.query<{ by: string | null }>(
      "select granted_by_principal_id as by from bakery.permission_grants where id = $1",
      [grant.id],
    );
    assertEquals(row.rows[0].by, f.adminId);

    const token = await mintToken(f, account.id, ["bakery:read"]);
    const stored = await f.pgDatabase.query<{ digest: string; prefix: string }>(
      "select secret_sha256 as digest, prefix from bakery.access_tokens where id = $1",
      [token.id],
    );
    assertNotEquals(stored.rows[0].digest, token.secret);
    assert(!stored.rows[0].digest.includes(token.secret));
    assert(token.secret.startsWith(stored.rows[0].prefix));

    const listed = await adminJson(f, "GET", "/v1/access-tokens");
    const text = await listed.text();
    assert(!text.includes(token.secret));
    assert(!text.includes("secret_sha256"));

    // The grant gives the grant-only account exactly its one capability.
    const allowed = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      token.secret,
    );
    assertEquals(allowed.status, 200, await allowed.clone().text());

    const revoked = await adminJson(
      f,
      "DELETE",
      `/v1/permission-grants/${grant.id}`,
      undefined,
      { "If-Match": `"v${grant.version}"` },
    );
    assertEquals(revoked.status, 204, await revoked.clone().text());
    const afterRevoke = await bearerCall(
      f,
      "GET",
      "/v1/applications",
      token.secret,
    );
    assertEquals(afterRevoke.status, 404, await afterRevoke.clone().text());
  } finally {
    await f.finish();
  }
});

Deno.test("a member's token never reaches another organization they also belong to", async () => {
  const f = await openInstallationFixture();
  try {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await adminJson(f, "POST", "/v1/organizations", {
      name: "Second",
      slug: `second-${suffix}`,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const second = (await created.json()).id as string;

    // The admin administers both organizations; a token minted in the first
    // acts in the first only, whatever the person may do in the second.
    const token = await mintToken(f, undefined, ["bakery:admin"]);
    const inFirst = await bearerCall(
      f,
      "GET",
      "/v1/audit-events",
      token.secret,
    );
    assertEquals(inFirst.status, 200, await inFirst.clone().text());

    const viaToken = await bearerCall(
      f,
      "GET",
      "/v1/audit-events",
      token.secret,
      {
        organizationId: second,
      },
    );
    const viaSession = await call(f, "GET", "/v1/audit-events", f.adminCookie, {
      headers: orgHeader(crypto.randomUUID()),
    });
    assertEquals(viaToken.status, 404, await viaToken.clone().text());
    assertEquals(viaToken.status, viaSession.status);
    assertEquals(
      (await problem(viaToken)).code,
      (await problem(viaSession)).code,
    );
    // The same person's cookie session does reach the second organization.
    const sessionInSecond = await call(
      f,
      "GET",
      "/v1/audit-events",
      f.adminCookie,
      {
        headers: orgHeader(second),
      },
    );
    assertEquals(
      sessionInSecond.status,
      200,
      await sessionInSecond.clone().text(),
    );
  } finally {
    await f.finish();
  }
});
