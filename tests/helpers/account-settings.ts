import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import {
  authRequest,
  authTestOrigin,
  openAuthFixture,
  sessionCookie,
} from "./auth.ts";

export type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;
export type Json = Record<string, unknown>;

export async function call(
  fixture: Fixture,
  method: string,
  path: string,
  cookie: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("cookie", cookie);
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

export async function signIn(
  fixture: Fixture,
  email: string,
  password: string,
): Promise<string> {
  const response = await fixture.app.fetch(
    authRequest("/api/auth/sign-in/email", { email, password }),
  );
  assertEquals(response.status, 200);
  return sessionCookie(response);
}

/** Bootstraps an Admin and, optionally, an invited Developer in one org. */
export async function seed(
  fixture: Fixture,
  suffix: string,
  withDeveloper: boolean,
) {
  const adminEmail = `settings-admin-${suffix}@example.test`;
  const developerEmail = `settings-dev-${suffix}@example.test`;
  const password = `Settings-${suffix}`;
  await createSuperuser({
    pgDatabase: fixture.pgDatabase,
    config: fixture.config.auth!,
  }, { email: adminEmail, displayName: "Settings Admin", password });
  const organization = await fixture.pgDatabase.query<{ id: string }>(
    `select membership.organization_id as id
     from bakery.organization_memberships as membership
     join bakery.principals as principal on principal.id = membership.principal_id
     join public."user" as provider_user on provider_user.id = principal.provider_user_id
     where provider_user.email = $1`,
    [adminEmail],
  );
  const organizationId = organization.rows[0].id;
  const adminCookie = await signIn(fixture, adminEmail, password);
  let developerCookie = "";
  if (withDeveloper) {
    const invitation = await fixture.app.fetch(authRequest(
      `/v1/organizations/${organizationId}/invitations`,
      { email: developerEmail, role: OrganizationRole.Developer },
      {
        cookie: adminCookie,
        headers: { "Bakery-Organization-Id": organizationId },
      },
    ));
    assertEquals(invitation.status, 201, await invitation.clone().text());
    const signUp = await fixture.app.fetch(
      authRequest("/api/auth/sign-up/email", {
        email: developerEmail,
        password,
        name: "Settings Developer",
      }),
    );
    assertEquals(signUp.status, 200, await signUp.clone().text());
    developerCookie = await signIn(fixture, developerEmail, password);
    const pending = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.organization_invitations
       where organization_id = $1 and email = $2 and status = 'pending'`,
      [organizationId, developerEmail],
    );
    const accepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: pending.rows[0].id },
      { cookie: developerCookie },
    ));
    assertEquals(accepted.status, 200, await accepted.clone().text());
  }
  return {
    adminEmail,
    developerEmail,
    organizationId,
    adminCookie,
    developerCookie,
    emails: [adminEmail, developerEmail],
  };
}

export function orgHeader(organizationId: string): Record<string, string> {
  return { "Bakery-Organization-Id": organizationId };
}
