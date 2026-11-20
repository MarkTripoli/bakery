import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "./auth.ts";

/**
 * Two Admins of one organization: the first owns the personal skills a test
 * creates, the second edits workflows and is never their owner. Every call
 * goes through the real app.
 */
export async function openPersonalSkillFixture(
  options: Parameters<typeof openAuthFixture>[0] = {},
) {
  const fixture = await openAuthFixture(options);
  const suffix = crypto.randomUUID();
  const ownerEmail = `skill-owner-${suffix}@example.test`;
  const adminEmail = `skill-admin-${suffix}@example.test`;
  const password = `PersonalSkill-${suffix}`;
  await createSuperuser({
    pgDatabase: fixture.pgDatabase,
    config: fixture.config.auth!,
  }, { email: ownerEmail, displayName: "Skill Owner", password });
  const scope = await fixture.pgDatabase.query<{
    organizationId: string;
    principalId: string;
  }>(
    `select membership.organization_id as "organizationId",
            membership.principal_id as "principalId"
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
      where provider_user.email = $1`,
    [ownerEmail],
  );
  const { organizationId, principalId: ownerPrincipalId } = scope.rows[0];
  const signIn = await fixture.auth.handler(authRequest(
    "/api/auth/sign-in/email",
    { email: ownerEmail, password },
  ));
  const ownerCookie = sessionCookie(signIn);

  const adminUserId = crypto.randomUUID();
  const adminPrincipalId = crypto.randomUUID();
  const adminToken = `skill-admin-${crypto.randomUUID()}`;
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Other Admin', $2, true, $3, $3)`,
    [adminUserId, adminEmail, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Other Admin', 'human')`,
    [adminPrincipalId, adminUserId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), organizationId, adminPrincipalId, now],
  );
  await fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      adminToken,
      adminUserId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  const adminCookie = await signSessionCookie(
    adminToken,
    fixture.config.auth!.secret,
  );

  const headers = (cookie: string, key?: string) => ({
    cookie,
    "Bakery-Organization-Id": organizationId,
    ...(key === undefined ? {} : { "Idempotency-Key": key }),
  });
  return {
    fixture,
    organizationId,
    ownerPrincipalId,
    adminPrincipalId,
    ownerCookie,
    adminCookie,
    post: (
      cookie: string,
      path: string,
      payload: Record<string, unknown>,
      key: string,
    ) =>
      fixture.app.fetch(
        authRequest(path, payload, { cookie, headers: headers(cookie, key) }),
      ),
    patch: (
      cookie: string,
      path: string,
      payload: Record<string, unknown>,
      key: string,
      expectedVersion: number,
    ) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method: "PATCH",
          headers: {
            ...headers(cookie, key),
            "content-type": "application/json",
            "If-Match": `"${expectedVersion}"`,
            origin: authTestOrigin,
          },
          body: JSON.stringify(payload),
        }),
      ),
    del: (cookie: string, path: string, key: string, expectedVersion: number) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method: "DELETE",
          headers: {
            ...headers(cookie, key),
            "If-Match": `"${expectedVersion}"`,
            origin: authTestOrigin,
          },
        }),
      ),
    read: (cookie: string, path: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, { headers: headers(cookie) }),
      ),
    /** An immutable published skill version row, so a step can name it. */
    async insertSkillVersion(skillId: string): Promise<string> {
      const id = `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`;
      await fixture.pgDatabase.query(
        `insert into bakery.skill_versions (
           id, organization_id, skill_id, revision, source_revision, digest,
           entry_path, manifest, status, created_by
         ) values ($1, $2, $3, 1, 'rev-1', $4, 'SKILL.md', '{}'::jsonb,
                   'published', $5)`,
        [
          id,
          organizationId,
          skillId,
          `sha256:${"c".repeat(64)}`,
          ownerPrincipalId,
        ],
      );
      return id;
    },
    async close() {
      await cleanupAuthFixture(fixture.pgDatabase, [ownerEmail, adminEmail]);
      await fixture.close();
    },
  };
}
