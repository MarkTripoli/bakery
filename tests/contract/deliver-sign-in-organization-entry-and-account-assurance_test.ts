import { assert, assertEquals } from "@std/assert";
import { generateContracts } from "../../packages/contracts/src/contracts.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

type BrowserSession = {
  id: string;
  current: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
};

function get(cookie: string | undefined, path: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${authTestOrigin}${path}`, { headers });
}

function del(cookie: string, path: string, origin: string | null): Request {
  const headers = new Headers({ cookie });
  if (origin !== null) headers.set("origin", origin);
  return new Request(`${authTestOrigin}${path}`, {
    method: "DELETE",
    headers,
  });
}

Deno.test("installation status, browser session list, revoke, and revoke-others hold their documented shape", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `contract-session-${suffix}@example.test`;
  const password = `Contract-${suffix}`;
  try {
    const beforeBootstrap = await fixture.app.fetch(
      get(undefined, "/v1/installation/status"),
    );
    assertEquals(beforeBootstrap.status, 200);
    assertEquals(await beforeBootstrap.json(), { bootstrapped: false });

    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Contract Session Admin", password });

    const afterBootstrap = await fixture.app.fetch(
      get(undefined, "/v1/installation/status"),
    );
    assertEquals(afterBootstrap.status, 200);
    assertEquals(await afterBootstrap.json(), { bootstrapped: true });

    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200, await signIn.clone().text());
    const cookie = sessionCookie(signIn);

    const list = await fixture.app.fetch(get(cookie, "/v1/me/sessions"));
    assertEquals(list.status, 200);
    const listBody = await list.json() as { items: BrowserSession[] };
    assertEquals(listBody.items.length, 1);
    const [session] = listBody.items;
    assertEquals(session.current, true);
    assert(typeof session.id === "string" && session.id.length > 0);
    for (const field of ["createdAt", "updatedAt", "expiresAt"] as const) {
      assert(
        !Number.isNaN(Date.parse(session[field])),
        `${field} must be an ISO datetime`,
      );
    }
    assert(session.ipAddress === null || typeof session.ipAddress === "string");
    assert(session.userAgent === null || typeof session.userAgent === "string");

    const foreignRevoke = await fixture.app.fetch(
      del(
        cookie,
        `/v1/me/sessions/00000000-0000-4000-8000-000000000099`,
        authTestOrigin,
      ),
    );
    assertEquals(foreignRevoke.status, 404);
    assertEquals((await foreignRevoke.json()).code, "RESOURCE_NOT_FOUND");

    const revokeOthers = await fixture.app.fetch(
      authRequest("/v1/me/sessions/revoke-others", {}, { cookie }),
    );
    assertEquals(revokeOthers.status, 200);
    assertEquals(await revokeOthers.json(), { revokedCount: 0 });

    const revokeSelf = await fixture.app.fetch(
      del(cookie, `/v1/me/sessions/${session.id}`, authTestOrigin),
    );
    assertEquals(revokeSelf.status, 200);
    assertEquals(await revokeSelf.json(), { revoked: true, current: true });

    const afterRevoke = await fixture.app.fetch(get(cookie, "/v1/me"));
    assertEquals(afterRevoke.status, 401);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("browserSessions.revoke OpenAPI path declares id as a path parameter", () => {
  const generated = generateContracts();
  const openapi = generated.openapi as {
    paths: Record<string, unknown>;
  };
  const path = openapi.paths["/v1/me/sessions/{id}"] as {
    delete?: {
      parameters?: Array<{ name: string; in: string }>;
    };
  } | undefined;
  const parameters = path?.delete?.parameters ?? [];
  const idParameter = parameters.find((parameter) => parameter.name === "id");
  assert(idParameter, "id must be a declared request parameter");
  assertEquals(idParameter?.in, "path");
});

Deno.test("GET /v1/installation/status returns its boolean body even with an unparseable session cookie", async () => {
  const fixture = await openAuthFixture();
  try {
    const response = await fixture.app.fetch(
      get("better-auth.session_token=garbage", "/v1/installation/status"),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { bootstrapped: false });
  } finally {
    await fixture.close();
  }
});

Deno.test("GET /v1/invitations/{invitationId} previews only a pending, unexpired invitation and hides every other state as one not-found", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `contract-preview-${suffix}@example.test`;
  const password = `Preview-${suffix}`;
  const inviteeEmail = `contract-invitee-${suffix}@example.test`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Contract Preview Admin", password });
    const inviter = await fixture.pgDatabase.query<{
      principalId: string;
      membershipId: string;
      organizationId: string;
      organizationName: string;
    }>(
      `select principal.id as "principalId",
        membership.id as "membershipId",
        organization.id as "organizationId",
        organization.name as "organizationName"
      from bakery.principals as principal
      join public."user" as provider_user
        on provider_user.id = principal.provider_user_id
      join bakery.organization_memberships as membership
        on membership.principal_id = principal.id
      join bakery.organizations as organization
        on organization.id = membership.organization_id
      where provider_user.email = $1`,
      [email],
    );
    assertEquals(inviter.rows.length, 1);
    const [admin] = inviter.rows;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3_600_000);
    const seeded = {
      pending: crypto.randomUUID(),
      // A live invitation whose inviter never had a Bakery principal (the
      // canonical lifecycle migration writes NULL for provider-only
      // inviters) must still preview; only the inviter name is absent.
      orphaned: crypto.randomUUID(),
      expired: crypto.randomUUID(),
      canceled: crypto.randomUUID(),
      accepted: crypto.randomUUID(),
      rejected: crypto.randomUUID(),
    };
    for (
      const [id, status, until] of [
        [seeded.pending, "pending", expiresAt],
        [seeded.orphaned, "pending", expiresAt],
        [seeded.expired, "pending", new Date(now.getTime() - 1_000)],
        [seeded.canceled, "canceled", expiresAt],
        [seeded.accepted, "accepted", expiresAt],
        [seeded.rejected, "rejected", expiresAt],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `insert into bakery.organization_invitations (
          id, organization_id, email, role, status, expires_at,
          inviter_principal_id, inviter_membership_id,
          created_at, updated_at, version
        ) values ($1, $2, $3, 'developer', $4, $5, $6, $7, $8, $8, 1)`,
        [
          id,
          admin.organizationId,
          // One pending row per address and organization is unique.
          id === seeded.pending ? inviteeEmail : `${id}@example.test`,
          status,
          until,
          id === seeded.orphaned ? null : admin.principalId,
          id === seeded.orphaned ? null : admin.membershipId,
          now,
        ],
      );
    }

    const preview = await fixture.app.fetch(
      get(undefined, `/v1/invitations/${seeded.pending}`),
    );
    assertEquals(preview.status, 200);
    assertEquals(preview.headers.get("cache-control"), "no-store");
    assertEquals(await preview.json(), {
      invitationId: seeded.pending,
      organizationName: admin.organizationName,
      inviterDisplayName: "Contract Preview Admin",
      role: "developer",
      email: inviteeEmail,
      expiresAt: expiresAt.toISOString(),
    });
    const orphaned = await fixture.app.fetch(
      get(undefined, `/v1/invitations/${seeded.orphaned}`),
    );
    assertEquals(orphaned.status, 200);
    assertEquals((await orphaned.json()).inviterDisplayName, null);

    // Anti-enumeration: with the request id pinned (the trace id is minted
    // per request at ingress), every non-live case is the same problem,
    // field for field, as an identifier that never existed.
    const probe = async (invitationId: string) => {
      const response = await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/invitations/${invitationId}`, {
          headers: { "x-request-id": `preview-probe-${suffix}` },
        }),
      );
      const { traceId: _traceId, ...problem } = await response.json();
      return { status: response.status, problem };
    };
    const unknown = await probe(crypto.randomUUID());
    assertEquals(unknown.status, 404);
    assertEquals(unknown.problem.code, "RESOURCE_NOT_FOUND");
    for (
      const invitationId of [
        seeded.expired,
        seeded.canceled,
        seeded.accepted,
        seeded.rejected,
      ]
    ) {
      assertEquals(await probe(invitationId), unknown);
    }

    const malformed = await fixture.app.fetch(
      get(undefined, "/v1/invitations/not-a-uuid"),
    );
    assertEquals(malformed.status, 400);
    assertEquals((await malformed.json()).code, "MALFORMED_REQUEST");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
