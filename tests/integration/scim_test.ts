import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import { call, orgHeader } from "../helpers/account-settings.ts";
import {
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { bearerCall, mintToken } from "../helpers/access-tokens.ts";
import { reconcileScimOrganization } from "../../apps/server/src/modules/auth/scim/mod.ts";

const SCIM_JSON = "application/scim+json";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function open() {
  return openInstallationFixture(false);
}

let openFixtureApp: InstallationFixture["app"] | undefined;

function scim(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  return fetchScim(openFixtureApp!, token, method, path, body);
}

function fetchScim(
  app: InstallationFixture["app"],
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers = new Headers({ accept: SCIM_JSON });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", SCIM_JSON);
  return app.fetch(
    new Request(`${authTestOrigin}/api/auth/scim/v2${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

type Created = {
  connection: {
    id: string;
    status: string;
    baseUrl: string;
    credentials: unknown[];
  };
  token: string;
};

async function createConnection(f: InstallationFixture, days = 30) {
  const response = await call(f, "POST", "/v1/scim-connection", f.adminCookie, {
    body: { expiresInDays: days },
    headers: orgHeader(f.organizationId),
  });
  return response;
}

async function created(f: InstallationFixture, days = 30): Promise<Created> {
  const response = await createConnection(f, days);
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json();
}

function userBody(userName: string, extra: Record<string, unknown> = {}) {
  return {
    schemas: [USER_SCHEMA],
    userName,
    externalId: `ext-${userName}`,
    displayName: `User ${userName}`,
    emails: [{ value: userName, primary: true, type: "work" }],
    active: true,
    ...extra,
  };
}

async function membership(f: InstallationFixture, email: string) {
  const result = await f.pgDatabase.query<
    { id: string; role: string; status: string }
  >(
    `select membership.id, membership.role, membership.status
     from bakery.organization_memberships as membership
     join bakery.principals as principal on principal.id = membership.principal_id
     join public."user" as provider on provider.id = principal.provider_user_id
     where membership.organization_id = $1 and provider.email = $2`,
    [f.organizationId, email],
  );
  return result.rows[0] ?? null;
}

async function auditOperations(f: InstallationFixture) {
  const rows = await f.pgDatabase.query<
    { operation: string; details: Record<string, unknown> }
  >(
    `select operation, details from bakery.audit_events
     where organization_id = $1 and operation like 'scim%'
     order by created_at, id`,
    [f.organizationId],
  );
  return rows.rows;
}

function email(label: string) {
  return `scim-${label}-${crypto.randomUUID()}@example.test`;
}

async function withFixture(
  run: (f: InstallationFixture, emails: string[]) => Promise<void>,
) {
  const f = await open();
  openFixtureApp = f.app;
  const emails: string[] = [];
  try {
    await run(f, emails);
  } finally {
    try {
      await f.pgDatabase.query(
        "delete from bakery.scim_connections where organization_id = $1",
        [f.organizationId],
      );
      await cleanupAuthFixture(f.pgDatabase, emails);
    } finally {
      await f.finish();
    }
  }
}

Deno.test("foreign organization answers 404", async () => {
  await withFixture(async (f) => {
    const response = await call(
      f,
      "POST",
      "/v1/scim-connection",
      f.adminCookie,
      {
        body: { expiresInDays: 30 },
        headers: orgHeader(crypto.randomUUID()),
      },
    );
    assertEquals(response.status, 404, await response.clone().text());
  });
});

Deno.test("a developer cannot manage the connection", async () => {
  const f = await openInstallationFixture(true);
  openFixtureApp = f.app;
  try {
    const response = await call(
      f,
      "POST",
      "/v1/scim-connection",
      f.developerCookie!,
      {
        body: { expiresInDays: 30 },
        headers: orgHeader(f.organizationId),
      },
    );
    assertEquals(response.status, 403, await response.clone().text());
  } finally {
    await f.finish();
  }
});

Deno.test("SCIM create, patch, group role, deactivate, reactivate and delete round trip", async () => {
  await withFixture(async (f, emails) => {
    const { token, connection } = await created(f);
    assert(token.startsWith("bsc_"));
    assertEquals(connection.status, "active");
    assertEquals(
      connection.baseUrl,
      `${authTestOrigin}/api/auth/scim/v2`,
    );

    const duplicate = await createConnection(f);
    assertEquals(duplicate.status, 409);

    // Unauthenticated and wrong-token requests never reach provisioning.
    assertEquals((await scim(null, "GET", "/Users")).status, 401);
    assertEquals((await scim("bsc_wrong", "GET", "/Users")).status, 401);

    const address = email("round");
    emails.push(address);
    const createdUser = await scim(token, "POST", "/Users", userBody(address));
    assertEquals(createdUser.status, 201, await createdUser.clone().text());
    const resource = await createdUser.json();
    assertEquals(resource.userName, address);
    const viewer = await membership(f, address);
    assertEquals(viewer?.role, "viewer");
    assertEquals(viewer?.status, "active");

    // Profile patch does not change the membership.
    const renamed = await scim(token, "PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", path: "displayName", value: "Renamed" }],
    });
    assertEquals(renamed.status, 200, await renamed.clone().text());
    assertEquals((await membership(f, address))?.role, "viewer");

    // A mapped group elevates the role.
    const group = await scim(token, "POST", "/Groups", {
      schemas: [GROUP_SCHEMA],
      displayName: "bakery-developer",
      members: [{ value: resource.id }],
    });
    assertEquals(group.status, 201, await group.clone().text());
    assertEquals((await membership(f, address))?.role, "developer");
    // A look-alike group never grants a role.
    const lookalike = await scim(token, "POST", "/Groups", {
      schemas: [GROUP_SCHEMA],
      displayName: "admin",
      members: [{ value: resource.id }],
    });
    assertEquals(lookalike.status, 201);
    assertEquals((await membership(f, address))?.role, "developer");

    const deactivated = await scim(token, "PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    assertEquals(deactivated.status, 200, await deactivated.clone().text());
    assertEquals((await membership(f, address))?.status, "inactive");

    const reactivated = await scim(token, "PATCH", `/Users/${resource.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    assertEquals(reactivated.status, 200, await reactivated.clone().text());
    assertEquals((await membership(f, address))?.status, "active");

    const removed = await scim(token, "DELETE", `/Users/${resource.id}`);
    assertEquals(removed.status, 204, await removed.clone().text());
    assertEquals(await membership(f, address), null);

    const operations = (await auditOperations(f)).map((row) => row.operation);
    assertEquals(operations, [
      "scimConnection.create",
      "scimProvisioning.create",
      "scimProvisioning.update",
      "scimProvisioning.deactivate",
      "scimProvisioning.update",
      "scimProvisioning.delete",
    ]);
  });
});

Deno.test("SCIM never touches memberships it did not create and keeps the last admin", async () => {
  await withFixture(async (f, emails) => {
    const { token } = await created(f);
    const address = email("admin");
    emails.push(address);
    const user = await (await scim(token, "POST", "/Users", userBody(address)))
      .json();
    const group = await (await scim(token, "POST", "/Groups", {
      schemas: [GROUP_SCHEMA],
      displayName: "bakery-admin",
      members: [{ value: user.id }],
    })).json();
    assertEquals((await membership(f, address))?.role, "admin");

    // The seeded administrator is demoted by hand, leaving the SCIM user as the only admin.
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'developer'
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.adminId],
    );
    const off = await scim(token, "PATCH", `/Users/${user.id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    assertEquals(off.status, 200);
    assertEquals((await membership(f, address))?.status, "active");
    assertEquals((await membership(f, address))?.role, "admin");
    void group;

    // The manually created membership is not SCIM's to change.
    const hand = await f.pgDatabase.query(
      `select 1 from bakery.scim_memberships where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.adminId],
    );
    assertEquals(hand.rows.length, 0);
  });
});

Deno.test("rotation overlaps then retires; revoke ends access; secrets never reach audit or reads", async () => {
  await withFixture(async (f, emails) => {
    const first = await created(f);
    const probe = email("probe");
    emails.push(probe);
    assertEquals(
      (await scim(first.token, "POST", "/Users", userBody(probe))).status,
      201,
    );

    const rotated = await call(
      f,
      "POST",
      "/v1/scim-connection/rotate",
      f.adminCookie,
      {
        body: { expiresInDays: 60, previousCredentialsExpireInMinutes: 30 },
        headers: orgHeader(f.organizationId),
      },
    );
    assertEquals(rotated.status, 201, await rotated.clone().text());
    const second = await rotated.json() as Created;
    assertNotEquals(second.token, first.token);
    assertEquals(second.connection.credentials.length, 2);
    // Both work during the overlap.
    assertEquals((await scim(first.token, "GET", "/Users")).status, 200);
    assertEquals((await scim(second.token, "GET", "/Users")).status, 200);

    const hard = await call(
      f,
      "POST",
      "/v1/scim-connection/rotate",
      f.adminCookie,
      {
        body: { expiresInDays: 60 },
        headers: orgHeader(f.organizationId),
      },
    );
    const third = await hard.json() as Created;
    assertEquals((await scim(first.token, "GET", "/Users")).status, 401);
    assertEquals((await scim(second.token, "GET", "/Users")).status, 401);
    assertEquals((await scim(third.token, "GET", "/Users")).status, 200);

    const read = await call(f, "GET", "/v1/scim-connection", f.adminCookie, {
      headers: orgHeader(f.organizationId),
    });
    const readText = await read.text();
    for (const token of [first.token, second.token, third.token]) {
      assertFalse(readText.includes(token), "read must not echo a secret");
    }

    const revoked = await call(
      f,
      "POST",
      "/v1/scim-connection/revoke",
      f.adminCookie,
      {
        body: {},
        headers: orgHeader(f.organizationId),
      },
    );
    assertEquals(revoked.status, 201);
    assertEquals((await scim(third.token, "GET", "/Users")).status, 401);

    // Digests and secrets are absent from every SCIM audit row.
    const digests = await f.pgDatabase.query<{ secret: string }>(
      `select secret_sha256 as secret from bakery.scim_credentials
       where organization_id = $1`,
      [f.organizationId],
    );
    const trail = JSON.stringify(await auditOperations(f));
    for (
      const secret of [
        first.token,
        second.token,
        third.token,
        ...digests.rows.map((row) => row.secret),
      ]
    ) assertFalse(trail.includes(secret), "audit must not carry a secret");
    const operations = (await auditOperations(f)).map((row) => row.operation);
    assertEquals(
      operations.filter((name) => name === "scimConnection.rotate").length,
      2,
    );
    assertEquals(
      operations.filter((name) => name === "scimConnection.revoke").length,
      1,
    );

    // A revoked connection can be created again with a fresh credential.
    const again = await created(f);
    assertEquals((await scim(again.token, "GET", "/Users")).status, 200);
    assertEquals((await scim(third.token, "GET", "/Users")).status, 401);
  });
});

Deno.test("a registration policy that blocks sign-up does not block SCIM provisioning", async () => {
  await withFixture(async (f, emails) => {
    const { token } = await created(f);
    const mode = await f.pgDatabase.query<{ mode: string }>(
      "select registration_mode as mode from bakery.installation_settings where id = true",
    );
    assertEquals(mode.rows[0].mode, "invitation");
    const address = email("policy");
    emails.push(address);
    const response = await scim(token, "POST", "/Users", userBody(address));
    assertEquals(response.status, 201, await response.clone().text());
    // Self-registration is still governed by the policy: no invitation, no user.
    const self = email("self");
    emails.push(self);
    await f.app.fetch(
      new Request(`${authTestOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: authTestOrigin },
        body: JSON.stringify({
          email: self,
          password: "Self-pass-123456",
          name: "Self",
        }),
      }),
    );
    const registered = await f.pgDatabase.query(
      'select 1 from public."user" where email = $1',
      [self],
    );
    assertEquals(registered.rows.length, 0);
  });
});

/** Puts an existing member under SCIM management, as the projection would have. */
async function manage(
  f: InstallationFixture,
  principalId: string,
  active = true,
) {
  const user = await f.pgDatabase.query<{ id: string; email: string }>(
    `select provider.id, provider.email from public."user" as provider
     join bakery.principals as principal on principal.provider_user_id = provider.id
     where principal.id = $1`,
    [principalId],
  );
  const { id, email } = user.rows[0];
  const key = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.scim_memberships (organization_id, principal_id)
     values ($1, $2) on conflict do nothing`,
    [f.organizationId, principalId],
  );
  await f.pgDatabase.query(
    `insert into public."scimUser" (
       "connectionId", "provisioningDomainId", "userId", "connectionUserKey",
       "userName", "userNameKey", "primaryEmail", "workEmailValueIndex",
       "emailValueIndex", "displayName", "formattedName", "serializedEmails",
       active, "orderKey", "createdAt", "updatedAt"
     ) values ('c', $1, $2, $3, $4, $3, $4, $4, $4, 'x', 'x', '[]', $5, $3,
       now(), now())`,
    [f.organizationId, id, key, email, active],
  );
  return id;
}

const setScimActive = (
  f: InstallationFixture,
  userId: string,
  active: boolean,
) =>
  f.pgDatabase.query(
    `update public."scimUser" set active = $2 where "userId" = $1`,
    [userId, active],
  );

const memberships = (f: InstallationFixture, cookie: string) =>
  call(f, "GET", `/v1/organizations/${f.organizationId}/memberships`, cookie, {
    headers: orgHeader(f.organizationId),
  });

Deno.test("a deactivated SCIM person is denied on the next call even if no reconcile ran", async () => {
  const f = await openInstallationFixture(true);
  openFixtureApp = f.app;
  try {
    const developerUser = await manage(f, f.developerId!);
    assertEquals((await memberships(f, f.developerCookie!)).status, 200);
    // The plugin has committed the deactivation; the projection never ran.
    await setScimActive(f, developerUser, false);
    const denied = await memberships(f, f.developerCookie!);
    assertEquals(denied.status, 404, await denied.clone().text());
    assertEquals((await denied.json()).code, "RESOURCE_NOT_FOUND");
    // The administrator, not SCIM-managed, is unaffected.
    assertEquals((await memberships(f, f.adminCookie)).status, 200);
    // A SCIM row that is gone altogether denies as well.
    await setScimActive(f, developerUser, true);
    assertEquals((await memberships(f, f.developerCookie!)).status, 200);
    await f.pgDatabase.query(
      `delete from public."scimUser" where "userId" = $1`,
      [developerUser],
    );
    assertEquals((await memberships(f, f.developerCookie!)).status, 404);
  } finally {
    await f.finish();
  }
});

Deno.test("the sole active administrator cannot be deprovisioned away", async () => {
  const f = await openInstallationFixture(true);
  openFixtureApp = f.app;
  try {
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'developer'
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.adminId],
    );
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const user = await manage(f, f.developerId!, false);
    assertEquals((await memberships(f, f.developerCookie!)).status, 200);
    const result = await reconcileScimOrganization({
      database: f.runtimePgDatabase,
    }, f.organizationId);
    assertEquals(result.skipped, 1);
    assertEquals(result.deactivated, 0);
    void user;
    assertEquals((await memberships(f, f.developerCookie!)).status, 200);
  } finally {
    await f.finish();
  }
});

Deno.test("a fired person's bearer token stops working and is revoked", async () => {
  const f = await openInstallationFixture(true);
  openFixtureApp = f.app;
  try {
    // Two administrators, so the managed one is not the exempt sole admin.
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const user = await manage(f, f.adminId);
    const minted = await mintToken(f, undefined, ["bakery:admin"]);
    const bearer = () =>
      bearerCall(
        f,
        "GET",
        `/v1/organizations/${f.organizationId}/memberships`,
        minted.secret,
      );
    assertEquals((await bearer()).status, 200);
    await setScimActive(f, user, false);
    const denied = await bearer();
    assertEquals(denied.status, 404, await denied.clone().text());
    // The projection then revokes the token and deactivates the membership.
    const result = await reconcileScimOrganization({
      database: f.runtimePgDatabase,
    }, f.organizationId);
    assertEquals(result.deactivated, 1);
    const token = await f.pgDatabase.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from bakery.access_tokens where id = $1`,
      [minted.id],
    );
    assertEquals(token.rows[0].revoked, true);
  } finally {
    await f.pgDatabase.query(
      "delete from bakery.access_tokens where organization_id = $1",
      [f.organizationId],
    );
    await f.finish();
  }
});

Deno.test("a failed projection is repaired by the next SCIM request", async () => {
  await withFixture(async (f, emails) => {
    const { token } = await created(f);
    const address = email("repair");
    emails.push(address);
    const user = await (await scim(token, "POST", "/Users", userBody(address)))
      .json();
    assertEquals((await membership(f, address))?.status, "active");

    // Break the projection (its deactivation path revokes tokens), then deactivate.
    await f.pgDatabase.query(
      "alter table bakery.access_tokens rename to access_tokens_off",
    );
    try {
      const off = await scim(token, "PATCH", `/Users/${user.id}`, {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: "replace", path: "active", value: false }],
      });
      assertEquals(off.status, 200);
      // The projection failed: the membership row is still active ...
      assertEquals((await membership(f, address))?.status, "active");
    } finally {
      await f.pgDatabase.query(
        "alter table bakery.access_tokens_off rename to access_tokens",
      );
    }
    // ... and the next SCIM request, even a read, repairs it.
    assertEquals((await scim(token, "GET", "/Users")).status, 200);
    assertEquals((await membership(f, address))?.status, "inactive");
  });
});
