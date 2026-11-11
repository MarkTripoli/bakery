import { assert, assertEquals } from "@std/assert";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

type BrowserSession = { id: string; current: boolean };

function get(path: string, cookie: string): Request {
  return new Request(`${authTestOrigin}${path}`, { headers: { cookie } });
}

function del(path: string, cookie: string): Request {
  return new Request(`${authTestOrigin}${path}`, {
    method: "DELETE",
    headers: { cookie, origin: authTestOrigin },
  });
}

async function listSessions(
  app: { fetch(request: Request): Response | Promise<Response> },
  cookie: string,
): Promise<BrowserSession[]> {
  const response = await app.fetch(get("/v1/me/sessions", cookie));
  assertEquals(response.status, 200);
  const body = await response.json() as { items: BrowserSession[] };
  return body.items;
}

Deno.test("installation bootstraps, browser sessions list live devices, and revocation takes effect immediately", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `session-flow-${suffix}@example.test`;
  const password = `SessionFlow-${suffix}`;
  try {
    const beforeBootstrap = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/status`),
    );
    assertEquals(await beforeBootstrap.json(), { bootstrapped: false });

    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Session Flow Admin", password });

    const afterBootstrap = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/status`),
    );
    assertEquals(await afterBootstrap.json(), { bootstrapped: true });

    const signInA = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signInA.status, 200);
    const cookieA = sessionCookie(signInA);

    const signInB = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signInB.status, 200);
    const cookieB = sessionCookie(signInB);

    const sessionsFromA = await listSessions(fixture.app, cookieA);
    assertEquals(sessionsFromA.length, 2);
    const currentOnes = sessionsFromA.filter((session) => session.current);
    assertEquals(currentOnes.length, 1);
    const otherSession = sessionsFromA.find((session) => !session.current);
    assert(otherSession, "the other sign-in's session must be listed");

    const revokeOther = await fixture.app.fetch(
      del(`/v1/me/sessions/${otherSession!.id}`, cookieA),
    );
    assertEquals(revokeOther.status, 200);
    assertEquals(await revokeOther.json(), { revoked: true, current: false });

    const bMeAfterRevoke = await fixture.app.fetch(get("/v1/me", cookieB));
    assertEquals(bMeAfterRevoke.status, 401);
    assertEquals(
      (await bMeAfterRevoke.json()).code,
      AuthProblemCode.Invalid,
    );

    const aMeStillValid = await fixture.app.fetch(get("/v1/me", cookieA));
    assertEquals(aMeStillValid.status, 200);

    const sessionsAfterOtherRevoked = await listSessions(fixture.app, cookieA);
    assertEquals(sessionsAfterOtherRevoked.length, 1);
    assertEquals(sessionsAfterOtherRevoked[0].current, true);
    const selfId = sessionsAfterOtherRevoked[0].id;

    const revokeSelf = await fixture.app.fetch(
      del(`/v1/me/sessions/${selfId}`, cookieA),
    );
    assertEquals(revokeSelf.status, 200);
    assertEquals(await revokeSelf.json(), { revoked: true, current: true });

    const aMeAfterSelfRevoke = await fixture.app.fetch(get("/v1/me", cookieA));
    assertEquals(aMeAfterSelfRevoke.status, 401);
    assertEquals(
      (await aMeAfterSelfRevoke.json()).code,
      AuthProblemCode.Invalid,
    );

    // Fresh triple sign-in to exercise revokeOthers' count and scope.
    const signIn1 = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie1 = sessionCookie(signIn1);
    const signIn2 = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie2 = sessionCookie(signIn2);
    const signIn3 = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie3 = sessionCookie(signIn3);

    assertEquals((await listSessions(fixture.app, cookie1)).length, 3);

    const revokeOthers = await fixture.app.fetch(
      authRequest("/v1/me/sessions/revoke-others", {}, { cookie: cookie1 }),
    );
    assertEquals(revokeOthers.status, 200);
    assertEquals(await revokeOthers.json(), { revokedCount: 2 });

    const oneMeAfterRevokeOthers = await fixture.app.fetch(
      get("/v1/me", cookie1),
    );
    assertEquals(oneMeAfterRevokeOthers.status, 200);
    const twoMeAfterRevokeOthers = await fixture.app.fetch(
      get("/v1/me", cookie2),
    );
    assertEquals(twoMeAfterRevokeOthers.status, 401);
    const threeMeAfterRevokeOthers = await fixture.app.fetch(
      get("/v1/me", cookie3),
    );
    assertEquals(threeMeAfterRevokeOthers.status, 401);

    const sessionsAfterRevokeOthers = await listSessions(
      fixture.app,
      cookie1,
    );
    assertEquals(sessionsAfterRevokeOthers.length, 1);
    assertEquals(sessionsAfterRevokeOthers[0].current, true);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("browser sessions list, revoke, and revoke-others ignore expired rows", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `session-expired-${suffix}@example.test`;
  const password = `SessionExpired-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Session Expired Admin", password });

    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const expiredId = crypto.randomUUID();
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        expiredId,
        `expired-session-token-${suffix}`,
        userId,
        new Date(now.getTime() - 60_000),
        now,
      ],
    );

    const sessions = await listSessions(fixture.app, cookie);
    assertEquals(sessions.length, 1);
    assert(
      sessions.every((session) => session.id !== expiredId),
      "an expired row must never be listed as a live session",
    );

    const revokeExpired = await fixture.app.fetch(
      del(`/v1/me/sessions/${expiredId}`, cookie),
    );
    assertEquals(revokeExpired.status, 404);
    assertEquals((await revokeExpired.json()).code, "RESOURCE_NOT_FOUND");

    const revokeOthers = await fixture.app.fetch(
      authRequest("/v1/me/sessions/revoke-others", {}, { cookie }),
    );
    assertEquals(revokeOthers.status, 200);
    assertEquals(await revokeOthers.json(), { revokedCount: 0 });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("browser session ops never observe or affect another principal's sessions", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const emailA = `session-owner-a-${suffix}@example.test`;
  const emailB = `session-owner-b-${suffix}@example.test`;
  const password = `SessionOwner-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email: emailA, displayName: "Session Owner A", password });

    const organization = await fixture.pgDatabase.query<{ id: string }>(
      `select organization.id
       from bakery.organizations as organization
       join bakery.organization_memberships as membership
         on membership.organization_id = organization.id
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [emailA],
    );
    const organizationId = organization.rows[0].id;

    const signInA = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email: emailA, password }),
    );
    assertEquals(signInA.status, 200);
    const cookieA = sessionCookie(signInA);

    // Sign-up is invite-only (`decideRegistration`): B must hold a live
    // invitation before `/api/auth/sign-up/email` accepts the account.
    const invitation = await fixture.app.fetch(authRequest(
      `/v1/organizations/${organizationId}/invitations`,
      { email: emailB, role: OrganizationRole.Developer },
      {
        cookie: cookieA,
        headers: { "Bakery-Organization-Id": organizationId },
      },
    ));
    assertEquals(invitation.status, 201, await invitation.clone().text());

    const signUpB = await fixture.app.fetch(
      authRequest("/api/auth/sign-up/email", {
        email: emailB,
        password,
        name: "Session Owner B",
      }),
    );
    assertEquals(signUpB.status, 200, await signUpB.clone().text());
    const signInB = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email: emailB, password }),
    );
    assertEquals(signInB.status, 200);
    const cookieB = sessionCookie(signInB);

    const sessionsB = await listSessions(fixture.app, cookieB);
    assertEquals(sessionsB.length, 1);
    const [{ id: bSessionId }] = sessionsB;

    const sessionsA = await listSessions(fixture.app, cookieA);
    assert(
      sessionsA.every((session) => session.id !== bSessionId),
      "A's session list must never contain B's session id",
    );

    const foreignRevoke = await fixture.app.fetch(
      del(`/v1/me/sessions/${bSessionId}`, cookieA),
    );
    assertEquals(foreignRevoke.status, 404);
    assertEquals((await foreignRevoke.json()).code, "RESOURCE_NOT_FOUND");

    const bStillValid = await fixture.app.fetch(get("/v1/me", cookieB));
    assertEquals(bStillValid.status, 200);

    const revokeOthers = await fixture.app.fetch(
      authRequest("/v1/me/sessions/revoke-others", {}, { cookie: cookieA }),
    );
    assertEquals(revokeOthers.status, 200);
    assertEquals(await revokeOthers.json(), { revokedCount: 0 });

    const bStillValidAfterRevokeOthers = await fixture.app.fetch(
      get("/v1/me", cookieB),
    );
    assertEquals(bStillValidAfterRevokeOthers.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [emailA, emailB]);
    await fixture.close();
  }
});
