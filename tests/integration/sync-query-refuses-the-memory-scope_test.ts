import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

// #72: the sync snapshot route refuses the memory scope for everyone,
// including a viewer, with MALFORMED_REQUEST, and still answers other scopes.
Deno.test("the sync snapshot route refuses the memory scope for an admin and a viewer", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = "memory-sync-" + suffix + "@example.test";
  const password = "MemorySync-" + suffix;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Memory sync", password });
    const principal = await fixture.pgDatabase.query<
      { principalId: string; organizationId: string }
    >(
      `select principal.id as "principalId", membership.organization_id as "organizationId"
         from bakery.principals as principal
         join public."user" as provider_user on provider_user.id = principal.provider_user_id
         join bakery.organization_memberships as membership on membership.principal_id = principal.id
        where provider_user.email = $1`,
      [email],
    );
    const { principalId, organizationId } = principal.rows[0];
    const signIn = await fixture.auth.handler(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const get = (path: string) =>
      fixture.app.fetch(
        new Request(authTestOrigin + path, {
          headers: { cookie, "Bakery-Organization-Id": organizationId },
        }),
      );
    const memoryPath = "/v1/sync?scopeType=memory&scopeId=" + organizationId;

    const control = await get(
      "/v1/sync?scopeType=repository&scopeId=" + crypto.randomUUID(),
    );
    assertEquals(
      control.status,
      404,
      "control: the route is live and scopes resolve",
    );
    assertEquals((await control.json()).code, "RESOURCE_NOT_FOUND");

    const asAdmin = await get(memoryPath);
    const adminBody = await asAdmin.json();
    assertEquals(
      adminBody.code,
      "MALFORMED_REQUEST",
      JSON.stringify(adminBody),
    );
    assert(
      asAdmin.status >= 400 && asAdmin.status < 500,
      String(asAdmin.status),
    );

    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set role = 'viewer' where organization_id = $1 and principal_id = $2",
      [organizationId, principalId],
    );
    const asViewer = await get(memoryPath);
    const viewerBody = await asViewer.json();
    assert(
      asViewer.status !== 200,
      "a viewer must not get a snapshot: " + JSON.stringify(viewerBody),
    );
    assert(
      viewerBody.code === "MALFORMED_REQUEST" ||
        viewerBody.code === "SCOPE_REQUIRED" ||
        viewerBody.code === "RESOURCE_NOT_FOUND",
      JSON.stringify(viewerBody),
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close?.();
  }
});
