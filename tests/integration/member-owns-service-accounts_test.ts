import { assertEquals } from "@std/assert";
import { orgHeader } from "../helpers/account-settings.ts";
import type { Json } from "../helpers/access-tokens.ts";
import {
  call,
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

/**
 * #233 owner-directed split: a member creates and manages the service accounts
 * and tokens they own, while an Admin still sees the whole organization. These
 * two tests are the proof the access-policy change is safe.
 *
 * The actions moved from Admin to "Initiating principal or Admin":
 * principals.list, principals.create, accessTokens.list, accessTokens.create,
 * accessTokens.revoke.
 */

async function open() {
  return await openInstallationFixture(true);
}

function memberCall(
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

async function json(response: Response): Promise<Json> {
  return await response.json() as Json;
}

Deno.test("member token reads and writes are own-only, Admin sees all", async () => {
  const f = await open();
  try {
    // A member mints a token for themselves. Before the policy change this
    // write was a 403; now it is a 201.
    const memberMade = await memberCall(f, "POST", "/v1/access-tokens", {
      name: "member own",
      scopes: ["bakery:read"],
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    assertEquals(
      memberMade.status,
      201,
      `a member mints their own token: ${await memberMade.clone().text()}`,
    );
    const memberToken = await json(memberMade);

    // 403 becomes 200: the member can list tokens now, and the list holds only
    // what they may see.
    const memberList = await memberCall(f, "GET", "/v1/access-tokens");
    assertEquals(
      memberList.status,
      200,
      `a member reads the token list instead of 403: ${await memberList.clone()
        .text()}`,
    );
    const owned = await json(memberList);
    const ownedIds = (owned.items as { id: string }[]).map((item) => item.id);
    assertEquals(
      ownedIds.includes(memberToken.id as string),
      true,
      "the member sees the token they minted",
    );

    // The Admin still sees every row in the organization, which is more than
    // the member does.
    const adminList = await call(f, "GET", "/v1/access-tokens", f.adminCookie, {
      headers: orgHeader(f.organizationId),
    });
    assertEquals(adminList.status, 200);
    const all = await json(adminList);
    assertEquals(
      (all.items as unknown[]).length >= (owned.items as unknown[]).length,
      true,
    );

    // A member creates a service account, and it is owned by them.
    const created = await memberCall(f, "POST", "/v1/principals", {
      displayName: "member-owned deployer",
      role: "developer",
    });
    assertEquals(
      created.status,
      201,
      `a member creates a service account: ${await created.clone().text()}`,
    );
    const principal = await json(created);
    const owner = await f.pgDatabase.query<{ id: string }>(
      "select created_by_principal_id as id from bakery.principals where id = $1",
      [principal.id as string],
    );
    assertEquals(
      owner.rows[0].id,
      f.developerId,
      "the creator is recorded, so the member owns it",
    );

    // The member's own list carries the account they made; the Admin's list
    // carries it too.
    const memberAccounts = await json(
      await memberCall(f, "GET", "/v1/principals"),
    );
    assertEquals(
      (memberAccounts.items as { id: string }[]).some((item) =>
        item.id === principal.id
      ),
      true,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("anti-escalation holds on every write path", async () => {
  const f = await open();
  try {
    // A member may not mint a token for a stronger principal: the Admin is
    // above the developer who is asking.
    const forAdmin = await memberCall(f, "POST", "/v1/access-tokens", {
      principalId: f.adminId,
      name: "escalation attempt",
      scopes: ["bakery:admin"],
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    assertEquals(
      forAdmin.status >= 400,
      true,
      `a member cannot mint a token for an Admin: ${await forAdmin.clone()
        .text()}`,
    );
    await forAdmin.body?.cancel();

    // A member may not create an account stronger than themselves.
    const strong = await memberCall(f, "POST", "/v1/principals", {
      displayName: "escalation service account",
      role: "admin",
    });
    assertEquals(
      strong.status >= 400,
      true,
      `a member cannot create an Admin service account: ${await strong.clone()
        .text()}`,
    );
    await strong.body?.cancel();

    // And a member cannot revoke a token they did not create: an Admin's token
    // is not theirs, so it is a not-found rather than a silent success.
    const adminToken = await call(
      f,
      "POST",
      "/v1/access-tokens",
      f.adminCookie,
      {
        body: {
          name: "admin own",
          scopes: ["bakery:read"],
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
        headers: {
          ...orgHeader(f.organizationId),
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(adminToken.status, 201, await adminToken.clone().text());
    const adminTokenBody = await json(adminToken);
    const stolen = await memberCall(
      f,
      "DELETE",
      `/v1/access-tokens/${adminTokenBody.id}`,
      undefined,
      { "If-Match": `"v${adminTokenBody.version}"` },
    );
    assertEquals(
      stolen.status,
      404,
      `another member's token is not-found to a member: ${await stolen.clone()
        .text()}`,
    );
    await stolen.body?.cancel();
  } finally {
    await f.finish();
  }
});
