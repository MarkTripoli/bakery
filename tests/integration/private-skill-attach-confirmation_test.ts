import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { sessionCookie } from "../helpers/auth.ts";

type Version = { id: string; version: number };

function versionId(): string {
  return `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`;
}

Deno.test("attaching a personal skill to a shared workflow needs its owner's confirmation", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const ownerEmail = `attach-owner-${suffix}@example.test`;
  const adminEmail = `attach-admin-${suffix}@example.test`;
  const password = `AttachSkill-${suffix}`;
  try {
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
    const { organizationId, principalId } = scope.rows[0];
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: ownerEmail, password },
    ));
    assertEquals(signIn.status, 200);
    const ownerCookie = sessionCookie(signIn);

    // A second Admin of the organization: allowed to edit workflows, not the owner.
    const adminUserId = crypto.randomUUID();
    const adminPrincipalId = crypto.randomUUID();
    const adminToken = `attach-admin-${crypto.randomUUID()}`;
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

    const post = (
      cookie: string,
      path: string,
      payload: Record<string, unknown>,
      key: string,
    ) =>
      fixture.app.fetch(authRequest(path, payload, {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": key,
        },
      }));
    const patch = (
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
            cookie,
            "Bakery-Organization-Id": organizationId,
            "content-type": "application/json",
            "Idempotency-Key": key,
            "If-Match": `"${expectedVersion}"`,
            origin: authTestOrigin,
          },
          body: JSON.stringify(payload),
        }),
      );

    // A personal skill and an organization skill, each with one published version.
    const personalSkill = await (await post(
      ownerCookie,
      "/v1/skills",
      { slug: "my-notes", name: "My notes", scope: "personal" },
      "attach-personal-skill",
    )).json() as { id: string };
    const sharedSkill = await (await post(
      ownerCookie,
      "/v1/skills",
      { slug: "team-notes", name: "Team notes" },
      "attach-shared-skill",
    )).json() as { id: string };
    const personalVersion = versionId();
    const sharedVersion = versionId();
    for (
      const [skillId, id] of [
        [personalSkill.id, personalVersion],
        [sharedSkill.id, sharedVersion],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `insert into bakery.skill_versions (
           id, organization_id, skill_id, revision, source_revision, digest,
           entry_path, manifest, status, created_by
         ) values ($1, $2, $3, 1, 'rev-1', $4, 'SKILL.md', '{}'::jsonb,
                   'published', $5)`,
        [id, organizationId, skillId, `sha256:${"b".repeat(64)}`, principalId],
      );
    }
    const workflow = await (await post(
      ownerCookie,
      "/v1/workflows",
      { slug: "attach-flow", name: "Attach flow", description: "Attach flow" },
      "attach-workflow",
    )).json() as { id: string };
    const definition = (skills: string[]) => ({
      steps: [{ id: "write", action: "agent.run", skills }],
    });
    const versionsPath = `/v1/workflows/${workflow.id}/versions`;

    // Without the owner's confirmation the save is refused and names the step.
    const refused = await post(
      ownerCookie,
      versionsPath,
      { definition: definition([personalVersion]) },
      "attach-unconfirmed",
    );
    assertEquals(refused.status, 422);
    const refusedBody = await refused.text();
    assertEquals(
      refusedBody.includes("personal_skill_confirmation_required"),
      true,
      refusedBody,
    );
    assertEquals(refusedBody.includes('"steps"'), true, refusedBody);
    const noGrant = await fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.skill_use_grants
        where organization_id = $1`,
      [organizationId],
    );
    assertEquals(noGrant.rows[0].n, 0);

    // The check cannot be sidestepped by how the version is written or by how
    // much the definition carries: an upper-case id still needs the owner, and
    // a definition too large to check is refused whole.
    const upperCase = await post(
      ownerCookie,
      versionsPath,
      { definition: definition([personalVersion.toUpperCase()]) },
      "attach-upper-case",
    );
    assertEquals(upperCase.status, 422);
    assertEquals(
      (await upperCase.text()).includes("personal_skill_confirmation_required"),
      true,
    );
    const overCap = await post(
      ownerCookie,
      versionsPath,
      {
        definition: definition([
          ...Array.from({ length: 256 }, () => crypto.randomUUID()),
          personalVersion,
        ]),
      },
      "attach-over-cap",
    );
    assertEquals(overCap.status, 422);
    assertEquals(
      (await overCap.text()).includes("too_many_skill_references"),
      true,
    );
    const stillNoGrant = await fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.skill_use_grants
        where organization_id = $1`,
      [organizationId],
    );
    assertEquals(stillNoGrant.rows[0].n, 0);

    // An organization skill needs no confirmation at all.
    const organizationDraft = await post(
      ownerCookie,
      versionsPath,
      { definition: definition([sharedVersion]) },
      "attach-organization-skill",
    );
    assertEquals(
      organizationDraft.status,
      201,
      await organizationDraft.clone().text(),
    );
    const draft = await organizationDraft.json() as Version;

    // The owner confirms the exact version: the save works and records a grant.
    const confirmed = await patch(
      ownerCookie,
      `${versionsPath}/${draft.id}`,
      {
        definition: definition([personalVersion, sharedVersion].sort()),
        confirmPersonalSkillUse: [personalVersion],
      },
      "attach-confirmed",
      draft.version,
    );
    assertEquals(confirmed.status, 200, await confirmed.clone().text());
    const afterConfirm = await confirmed.json() as Version;
    const grants = await fixture.pgDatabase.query<{
      step_path: string;
      granted_by: string;
      skill_id: string;
    }>(
      `select step_path, granted_by, skill_id from bakery.skill_use_grants
        where organization_id = $1 and workflow_id = $2`,
      [organizationId, workflow.id],
    );
    assertEquals(grants.rows.length, 1);
    assertEquals(grants.rows[0].granted_by, principalId);
    assertEquals(grants.rows[0].skill_id, personalSkill.id);

    // Another Admin keeps editing: the live grant covers the same step and version.
    const adminEdit = await patch(
      adminCookie,
      `${versionsPath}/${draft.id}`,
      {
        definition: {
          ...definition([personalVersion, sharedVersion].sort()),
          note: "edited by another admin",
        },
      },
      "attach-admin-edit",
      afterConfirm.version,
    );
    assertEquals(adminEdit.status, 200, await adminEdit.clone().text());
    const afterAdmin = await adminEdit.json() as Version;

    // But that Admin cannot put the owner's skill on a second step.
    const second = await patch(
      adminCookie,
      `${versionsPath}/${draft.id}`,
      {
        definition: {
          steps: [
            { id: "write", action: "agent.run", skills: [personalVersion] },
            { id: "review", action: "agent.run", skills: [personalVersion] },
          ],
        },
      },
      "attach-admin-second-step",
      afterAdmin.version,
    );
    assertEquals(second.status, 422);
    const secondBody = await second.text();
    assertEquals(secondBody.includes("skill_unavailable"), true, secondBody);
    // The refusal does not say who owns the skill.
    assertEquals(secondBody.includes(principalId), false);

    // The owner sees where the skill is used; nobody else can even ask.
    const grantsPath = `/v1/skills/${personalSkill.id}/use-grants`;
    const read = (cookie: string, path: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: { cookie, "Bakery-Organization-Id": organizationId },
        }),
      );
    const ownerGrants = await read(ownerCookie, grantsPath);
    assertEquals(ownerGrants.status, 200);
    const grantPage = await ownerGrants.json() as {
      items: {
        id: string;
        workflowName: string;
        stepPath: string;
        skillVersionId: string;
        version: number;
      }[];
      nextCursor: string | null;
    };
    assertEquals(grantPage.items.length, 1);
    assertEquals(grantPage.items[0].workflowName, "Attach flow");
    assertEquals(grantPage.items[0].stepPath, "/steps/0");
    assertEquals(grantPage.items[0].skillVersionId, personalVersion);
    assertEquals((await read(adminCookie, grantsPath)).status, 404);

    // Stopping is the owner's act, needs the grant's version, and deletes it.
    const stop = (
      cookie: string,
      key: string,
      ifMatch?: string,
    ) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${grantsPath}/${grantPage.items[0].id}`, {
          method: "DELETE",
          headers: {
            cookie,
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": key,
            origin: authTestOrigin,
            ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
          },
        }),
      );
    assertEquals((await stop(adminCookie, "stop-by-admin", '"1"')).status, 404);
    assertEquals((await stop(ownerCookie, "stop-no-version")).status, 428);
    assertEquals((await stop(ownerCookie, "stop-stale", '"9"')).status, 412);
    assertEquals((await stop(ownerCookie, "stop-ok", '"1"')).status, 204);
    const emptyGrants = await (await read(ownerCookie, grantsPath)).json() as {
      items: unknown[];
    };
    assertEquals(emptyGrants.items.length, 0);

    // After the stop the step is no longer covered: another Admin is refused,
    // and the owner has to confirm again.
    const afterStop = await read(
      ownerCookie,
      `${versionsPath}/${draft.id}`,
    );
    const stopped = await afterStop.json() as Version;
    const adminAfterStop = await patch(
      adminCookie,
      `${versionsPath}/${draft.id}`,
      { definition: definition([personalVersion, sharedVersion].sort()) },
      "attach-admin-after-stop",
      stopped.version,
    );
    assertEquals(adminAfterStop.status, 422);
    assertEquals(
      (await adminAfterStop.text()).includes("skill_unavailable"),
      true,
    );
    const ownerUnconfirmed = await patch(
      ownerCookie,
      `${versionsPath}/${draft.id}`,
      { definition: definition([personalVersion, sharedVersion].sort()) },
      "attach-owner-after-stop",
      stopped.version,
    );
    assertEquals(ownerUnconfirmed.status, 422);
    assertEquals(
      (await ownerUnconfirmed.text()).includes(
        "personal_skill_confirmation_required",
      ),
      true,
    );
    const ownerReconfirmed = await patch(
      ownerCookie,
      `${versionsPath}/${draft.id}`,
      {
        definition: definition([personalVersion, sharedVersion].sort()),
        confirmPersonalSkillUse: [personalVersion],
      },
      "attach-owner-reconfirm",
      stopped.version,
    );
    assertEquals(ownerReconfirmed.status, 200);
    const regranted = await fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.skill_use_grants
        where organization_id = $1 and workflow_id = $2`,
      [organizationId, workflow.id],
    );
    assertEquals(regranted.rows[0].n, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [ownerEmail, adminEmail]);
    await fixture.close();
  }
});
