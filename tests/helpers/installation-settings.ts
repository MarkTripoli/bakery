import { assertEquals } from "@std/assert";
import { authRequest, cleanupAuthFixture, openAuthFixture } from "./auth.ts";
import { call, seed, signIn } from "./account-settings.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";

export { authRequest, call, createSuperuser, signIn };
export const policy = {
  registrationMode: "invitation",
  organizationCreationPolicy: "installation_admins",
} as const;

export async function openInstallationFixture(
  withDeveloper = true,
  options: Parameters<typeof openAuthFixture>[0] = {},
) {
  const fixture = await openAuthFixture(options);
  const prior = (await fixture.pgDatabase.query<
    {
      registration: string;
      organizations: string;
      version: number;
      updater: string | null;
      updatedAt: Date;
    }
  >(
    `select registration_mode as registration, organization_creation_policy as organizations,
      version, updated_by_principal_id as updater, updated_at as "updatedAt"
     from bakery.installation_settings where id = true`,
  )).rows[0]!;
  const suffix = crypto.randomUUID();
  try {
    await fixture.pgDatabase.query(
      "update bakery.installation_settings set registration_mode = 'invitation', organization_creation_policy = 'installation_admins' where id = true",
    );
    const seeded = await seed(fixture, suffix, withDeveloper);
    const principals =
      (await fixture.pgDatabase.query<{ id: string; email: string }>(
        `select principal.id, provider.email from bakery.principals as principal
       join public."user" as provider on provider.id = principal.provider_user_id
       where provider.email = any($1::text[])`,
        [seeded.emails],
      )).rows;
    const adminId = principals.find((row) =>
      row.email === seeded.adminEmail
    )!.id;
    const developerId = principals.find((row) =>
      row.email === seeded.developerEmail
    )?.id;
    return {
      ...fixture,
      ...seeded,
      adminId,
      developerId,
      password: `Settings-${suffix}`,
      finish: async () => {
        try {
          await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
          await fixture.pgDatabase.query(
            `update bakery.installation_settings set registration_mode = $1,
             organization_creation_policy = $2, version = $3, updated_by_principal_id = $4, updated_at = $5 where id = true`,
            [
              prior.registration,
              prior.organizations,
              prior.version,
              prior.updater,
              prior.updatedAt,
            ],
          );
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    await cleanupAuthFixture(fixture.pgDatabase, [
      `settings-admin-${suffix}@example.test`,
      `settings-dev-${suffix}@example.test`,
    ]);
    await fixture.close();
    throw error;
  }
}

/**
 * The bootstrap Admin's sign-in a browser lane shares. `BAKERY_REAL_EMAIL`
 * and `BAKERY_REAL_PASSWORD` win; the fixture defaults apply only when
 * `BAKERY_ENV` is "test", as in the shared-admin specs.
 */
function sharedAdminCredentials(): { email: string; password: string } {
  const email = Deno.env.get("BAKERY_REAL_EMAIL")?.trim().toLowerCase() ||
    (Deno.env.get("BAKERY_ENV") === "test" ? "browser-admin@example.test" : "");
  const password = Deno.env.get("BAKERY_REAL_PASSWORD") ||
    (Deno.env.get("BAKERY_ENV") === "test" ? "Browser-Admin-Passw0rd-1" : "");
  if (!email || !password) {
    throw new Error(
      "the installation is already bootstrapped: set BAKERY_REAL_EMAIL and BAKERY_REAL_PASSWORD (or BAKERY_ENV=test) to sign in as its Admin",
    );
  }
  return { email, password };
}

/**
 * An Admin session on an installation that may already be bootstrapped. A
 * lane that ran the auth-bootstrap project first holds the one superuser
 * `createSuperuser` allows, so a second would fail AUTH_BOOTSTRAP_CONFLICT;
 * this signs in as that Admin and uses their first organization (the
 * personal one bootstrap created). An un-bootstrapped database gets the
 * seeded fixture of `openInstallationFixture(false)`. Teardown never deletes
 * the shared Admin; it restores the installation policy as the seeded path
 * does.
 */
export async function openSharedAdminFixture(
  options: Parameters<typeof openAuthFixture>[0] = {},
) {
  const probe = await openAuthFixture(options);
  let bootstrapped: boolean;
  try {
    bootstrapped = (await probe.pgDatabase.query(
      "select 1 from bakery.installation_settings where id = true and bootstrap_principal_id is not null",
    )).rows.length > 0;
  } finally {
    await probe.close();
  }
  if (!bootstrapped) return await openInstallationFixture(false, options);

  const { email, password } = sharedAdminCredentials();
  const fixture = await openAuthFixture(options);
  try {
    const prior = (await fixture.pgDatabase.query<{
      registration: string;
      organizations: string;
      version: number;
      updater: string | null;
      updatedAt: Date;
    }>(
      `select registration_mode as registration, organization_creation_policy as organizations,
        version, updated_by_principal_id as updater, updated_at as "updatedAt"
       from bakery.installation_settings where id = true`,
    )).rows[0]!;
    await fixture.pgDatabase.query(
      "update bakery.installation_settings set registration_mode = 'invitation', organization_creation_policy = 'installation_admins' where id = true",
    );
    const organization = await fixture.pgDatabase.query<{ id: string }>(
      `select membership.organization_id as id
       from bakery.organization_memberships as membership
       join bakery.principals as principal on principal.id = membership.principal_id
       join public."user" as provider_user on provider_user.id = principal.provider_user_id
       where provider_user.email = $1
       order by membership.created_at, membership.id limit 1`,
      [email],
    );
    if (organization.rows.length === 0) {
      throw new Error(`the bootstrap Admin ${email} has no organization`);
    }
    return {
      ...fixture,
      organizationId: organization.rows[0].id,
      adminCookie: await signIn(fixture, email, password),
      finish: async () => {
        try {
          await fixture.pgDatabase.query(
            `update bakery.installation_settings set registration_mode = $1,
             organization_creation_policy = $2, version = $3, updated_by_principal_id = $4, updated_at = $5 where id = true`,
            [
              prior.registration,
              prior.organizations,
              prior.version,
              prior.updater,
              prior.updatedAt,
            ],
          );
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export type InstallationFixture = Awaited<
  ReturnType<typeof openInstallationFixture>
>;

export async function readSettings(fixture: InstallationFixture) {
  const response = await call(
    fixture,
    "GET",
    "/v1/installation/settings",
    fixture.adminCookie,
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    registrationMode: string;
    organizationCreationPolicy: string;
    version: number;
    updatedByPrincipalId: string | null;
    updatedAt: string;
  };
}

export function updateSettings(
  fixture: InstallationFixture,
  version: number,
  body: unknown = policy,
  cookie = fixture.adminCookie,
  key = crypto.randomUUID(),
) {
  return call(fixture, "PATCH", "/v1/installation/settings", cookie, {
    body,
    headers: { "If-Match": `"v${version}"`, "Idempotency-Key": key },
  });
}

export function grant(
  fixture: InstallationFixture,
  target = fixture.developerId!,
  cookie = fixture.adminCookie,
  key = crypto.randomUUID(),
) {
  return call(fixture, "POST", "/v1/installation/administrators", cookie, {
    body: { principalId: target },
    headers: { "Idempotency-Key": key },
  });
}

export function revoke(
  fixture: InstallationFixture,
  target: string,
  version: number,
  cookie = fixture.adminCookie,
  key = crypto.randomUUID(),
) {
  return call(
    fixture,
    "DELETE",
    `/v1/installation/administrators/${target}`,
    cookie,
    { headers: { "If-Match": `"v${version}"`, "Idempotency-Key": key } },
  );
}
