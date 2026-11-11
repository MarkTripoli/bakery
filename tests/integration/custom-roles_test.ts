import { assert, assertEquals } from "@std/assert";
import { orgHeader } from "../helpers/account-settings.ts";
import { adminJson, bearerCall, mintToken } from "../helpers/access-tokens.ts";
import {
  call,
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { rolePermissions } from "../../apps/server/src/modules/auth/application/permissions.ts";
type Role = {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  memberCount: number;
  memberIds: string[];
  version: number;
};

async function open() {
  return await openInstallationFixture(true);
}

async function finish(f: InstallationFixture) {
  await f.pgDatabase.query(
    "update bakery.organization_memberships set custom_role_id = null where organization_id = $1",
    [f.organizationId],
  );
  await f.pgDatabase.query(
    "delete from bakery.organization_roles where organization_id = $1",
    [f.organizationId],
  );
  await f.pgDatabase.query(
    "delete from bakery.audit_events where operation like 'organizationRoles.%'",
  );
  await f.finish();
}

function asDeveloper(
  f: InstallationFixture,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return call(f, method, path, f.developerCookie, {
    body,
    headers: {
      ...orgHeader(f.organizationId),
      "Idempotency-Key": crypto.randomUUID(),
      ...headers,
    },
  });
}

async function createRole(
  f: InstallationFixture,
  key: string,
  permissions: string[],
): Promise<Role> {
  const response = await adminJson(f, "POST", "/v1/organization-roles", {
    key,
    name: `Role ${key}`,
    permissions,
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json();
}

async function assign(
  f: InstallationFixture,
  role: Role,
  principalId: string | undefined,
) {
  return await adminJson(
    f,
    "POST",
    `/v1/organization-roles/${role.id}/members`,
    {
      principalId,
    },
  );
}

async function code(response: Response): Promise<string> {
  return (await response.json()).code as string;
}

/** Every permission key the catalog assigns: what a full admin holds. */
function allPermissions(): string[] {
  return [...rolePermissions.admin];
}

Deno.test("create validates the handle and permissions and rejects duplicates", async () => {
  const f = await open();
  try {
    const role = await createRole(f, "auditors", ["principal:read"]);
    assertEquals(role.memberCount, 0);
    assertEquals(role.permissions, ["principal:read"]);
    const body = (permissions: string[], key = "other") => ({
      key,
      name: "Other",
      permissions,
    });
    for (
      const rejected of [
        body(["principal:read"], "admin"),
        body(["principal:read"], "Bad Key"),
        body(["not:a-permission"]),
      ]
    ) {
      const response = await adminJson(
        f,
        "POST",
        "/v1/organization-roles",
        rejected,
      );
      assertEquals(response.status, 422, JSON.stringify(rejected));
    }
    const duplicate = await adminJson(
      f,
      "POST",
      "/v1/organization-roles",
      body(["principal:read"], "auditors"),
    );
    assertEquals(duplicate.status, 409);
    const renamed = await adminJson(
      f,
      "PATCH",
      `/v1/organization-roles/${role.id}`,
      { name: "Renamed", permissions: ["principal:read", "accessToken:read"] },
      { "If-Match": `"v${role.version}"` },
    );
    assertEquals(renamed.status, 200, await renamed.clone().text());
    const updated: Role = await renamed.json();
    assertEquals(updated.name, "Renamed");
    assertEquals(updated.version, role.version + 1);
    const stale = await adminJson(
      f,
      "PATCH",
      `/v1/organization-roles/${role.id}`,
      { name: "Stale" },
      { "If-Match": `"v${role.version}"` },
    );
    assertEquals(stale.status, 409);
  } finally {
    await finish(f);
  }
});

Deno.test("an assigned role takes effect on the next request and replaces the system role", async () => {
  const f = await open();
  try {
    // A denied read answers 404, like a resource the caller cannot see.
    const before = await asDeveloper(f, "GET", "/v1/principals");
    assertEquals(before.status, 404);
    const role = await createRole(f, "directory", ["principal:read"]);
    const assigned = await assign(f, role, f.developerId);
    assertEquals(assigned.status, 201, await assigned.clone().text());
    const held: Role = await assigned.json();
    assertEquals(held.memberCount, 1);
    assertEquals(held.memberIds, [f.developerId]);
    const granted = await asDeveloper(f, "GET", "/v1/principals");
    assertEquals(granted.status, 200, await granted.clone().text());
    // The developer role is gone: only the custom permissions remain.
    const lost = await asDeveloper(f, "GET", "/v1/applications");
    assert(lost.status === 403 || lost.status === 404, `${lost.status}`);
    // Deleting a role that still has holders is refused.
    const blocked = await adminJson(
      f,
      "DELETE",
      `/v1/organization-roles/${role.id}`,
      undefined,
      { "If-Match": `"v${role.version}"` },
    );
    assertEquals(blocked.status, 409);
    const unassigned = await adminJson(
      f,
      "DELETE",
      `/v1/organization-roles/${role.id}/members/${f.developerId}`,
    );
    assertEquals(unassigned.status, 204, await unassigned.clone().text());
    const revoked = await asDeveloper(f, "GET", "/v1/principals");
    assertEquals(revoked.status, 404);
    const removed = await adminJson(
      f,
      "DELETE",
      `/v1/organization-roles/${role.id}`,
      undefined,
      { "If-Match": `"v${role.version}"` },
    );
    assertEquals(removed.status, 204, await removed.clone().text());
  } finally {
    await finish(f);
  }
});

Deno.test("a creator cannot exceed their own permissions", async () => {
  const f = await open();
  try {
    const manager = await createRole(f, "role-manager", [
      "organizationRole:manage",
      "organizationRole:read",
    ]);
    assertEquals((await assign(f, manager, f.developerId)).status, 201);
    const beyond = await asDeveloper(f, "POST", "/v1/organization-roles", {
      key: "too-much",
      name: "Too much",
      permissions: ["principal:read"],
    });
    assertEquals(beyond.status, 403);
    assertEquals(await code(beyond), "AUTH_FORBIDDEN");
    const within = await asDeveloper(f, "POST", "/v1/organization-roles", {
      key: "within",
      name: "Within",
      permissions: ["organizationRole:read"],
    });
    assertEquals(within.status, 201, await within.clone().text());
    // Editing the manager's own role upward is refused for the same reason.
    const raise = await asDeveloper(
      f,
      "PATCH",
      `/v1/organization-roles/${manager.id}`,
      { permissions: ["organizationRole:manage", "principal:read"] },
      { "If-Match": `"v${manager.version}"` },
    );
    assertEquals(raise.status, 403);
    // An assigner may not hand out what it does not hold.
    const strong = await createRole(f, "strong", ["principal:read"]);
    const handOut = await asDeveloper(
      f,
      "POST",
      `/v1/organization-roles/${strong.id}/members`,
      { principalId: f.developerId },
    );
    assertEquals(handOut.status, 403);
  } finally {
    await finish(f);
  }
});

Deno.test("a custom role never counts as an admin and cannot demote the last one", async () => {
  const f = await open();
  try {
    // A role holding every permission the admin has, so only the last-admin
    // rule can stop the holder.
    const everything = allPermissions();
    assert(everything.includes("organizationRole:manage"));
    const mighty = await createRole(f, "mighty", everything);
    assertEquals((await assign(f, mighty, f.developerId)).status, 201);
    const demote = await asDeveloper(
      f,
      "POST",
      `/v1/organization-roles/${mighty.id}/members`,
      { principalId: f.adminId },
    );
    assertEquals(demote.status, 409, await demote.clone().text());
    const selfDemote = await assign(f, mighty, f.adminId);
    assertEquals(selfDemote.status, 409);
    const stillAdmin = await f.pgDatabase.query<{ role: string }>(
      `select role from bakery.organization_memberships
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.adminId],
    );
    assertEquals(stillAdmin.rows[0].role, "admin");
    // The holder carries the role but is stored as the lowest system role.
    const holder = await f.pgDatabase.query<{ role: string }>(
      `select role from bakery.organization_memberships
       where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    assertEquals(holder.rows[0].role, "guest");
  } finally {
    await finish(f);
  }
});

Deno.test("role writes refuse bearer tokens and a foreign role id answers not found", async () => {
  const f = await open();
  try {
    const token = await mintToken(f, undefined, ["bakery:admin"]);
    const viaToken = await bearerCall(
      f,
      "POST",
      "/v1/organization-roles",
      token.secret,
      {
        body: {
          key: "via-token",
          name: "Via token",
          permissions: ["principal:read"],
        },
      },
    );
    assertEquals(viaToken.status, 403);
    assertEquals(await code(viaToken), "SESSION_REQUIRED");
    const missing = await adminJson(
      f,
      "PATCH",
      `/v1/organization-roles/${crypto.randomUUID()}`,
      { name: "Nope" },
      { "If-Match": '"v1"' },
    );
    assertEquals(missing.status, 404);
  } finally {
    await finish(f);
  }
});

Deno.test("role mutations are audited with identifiers only", async () => {
  const f = await open();
  try {
    const role = await createRole(f, "audited", ["principal:read"]);
    assertEquals((await assign(f, role, f.developerId)).status, 201);
    const rows = await f.pgDatabase.query<
      { operation: string; details: Record<string, unknown> }
    >(
      `select operation, details from bakery.audit_events
       where organization_id = $1 and operation like 'organizationRoles.%'
       order by created_at, id`,
      [f.organizationId],
    );
    assertEquals(rows.rows.map((row) => row.operation), [
      "organizationRoles.create",
      "organizationRoles.assign",
    ]);
    assertEquals(rows.rows[1].details.principalId, f.developerId);
    assertEquals(rows.rows[0].details.key, "audited");
  } finally {
    await finish(f);
  }
});

async function membershipOf(
  f: InstallationFixture,
  principalId: string | undefined,
) {
  const row = await f.pgDatabase.query<
    { id: string; version: number; role: string; custom: string | null }
  >(
    `select id, version, role, custom_role_id as custom
     from bakery.organization_memberships
     where organization_id = $1 and principal_id = $2`,
    [f.organizationId, principalId],
  );
  return row.rows[0];
}

Deno.test("a custom-role holder cannot remove or demote the last system admin through member paths (#322 AC3)", async () => {
  const f = await open();
  try {
    const mighty = await createRole(f, "mighty", allPermissions());
    assertEquals((await assign(f, mighty, f.developerId)).status, 201);
    const admin = await membershipOf(f, f.adminId);
    const base =
      `/v1/organizations/${f.organizationId}/memberships/${admin.id}`;
    const demote = await asDeveloper(
      f,
      "PATCH",
      base,
      { role: "developer" },
      { "If-Match": `"v${admin.version}"` },
    );
    // Member paths need the system admin role, which a holder never has; the
    // last-admin guard behind them is exercised by the assign test above.
    assertEquals(demote.status, 403, await demote.clone().text());
    const deactivate = await asDeveloper(
      f,
      "PATCH",
      base,
      { status: "inactive" },
      { "If-Match": `"v${admin.version}"` },
    );
    assertEquals(deactivate.status, 403);
    const remove = await asDeveloper(f, "DELETE", base, undefined, {
      "If-Match": `"v${admin.version}"`,
    });
    assertEquals(remove.status, 403);
    assertEquals((await membershipOf(f, f.adminId)).role, "admin");
  } finally {
    await finish(f);
  }
});

Deno.test("setting a system role on a holder drops the custom role; removing a holder leaves the role intact", async () => {
  const f = await open();
  try {
    const role = await createRole(f, "directory", ["principal:read"]);
    assertEquals((await assign(f, role, f.developerId)).status, 201);
    const held = await membershipOf(f, f.developerId);
    assertEquals(held.custom, role.id);
    const promote = await adminJson(
      f,
      "PATCH",
      `/v1/organizations/${f.organizationId}/memberships/${held.id}`,
      { role: "viewer" },
      { "If-Match": `"v${held.version}"` },
    );
    assertEquals(promote.status, 200, await promote.clone().text());
    const after = await membershipOf(f, f.developerId);
    assertEquals([after.role, after.custom], ["viewer", null]);
    // A second holder removed from the organization frees the role to delete.
    assertEquals((await assign(f, role, f.developerId)).status, 201);
    const again = await membershipOf(f, f.developerId);
    const removed = await adminJson(
      f,
      "DELETE",
      `/v1/organizations/${f.organizationId}/memberships/${again.id}`,
      undefined,
      { "If-Match": `"v${again.version}"` },
    );
    assert(removed.status < 300, await removed.clone().text());
    const roles = await adminJson(f, "GET", "/v1/organization-roles");
    assertEquals((await roles.json()).items[0].memberCount, 0);
  } finally {
    await finish(f);
  }
});
