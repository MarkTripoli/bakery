import { assert, assertEquals } from "@std/assert";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  findActiveSlackLinkForPrincipal,
  linkSlackIdentity,
  revokeSlackIdentityLink,
  type SlackLinkIdentity,
} from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

const suffix = () => crypto.randomUUID().replaceAll("-", "").toUpperCase();

function slackIdentity(): SlackLinkIdentity {
  const id = suffix();
  return {
    appId: `A${id.slice(0, 10)}`,
    teamId: `T${id.slice(10, 20)}`,
    userId: `U${id.slice(20, 30)}`,
  };
}

function link(
  f: Fixture,
  organizationId: string,
  principalId: string,
  identity: SlackLinkIdentity,
) {
  return withPgTransaction(f.runtimePgDatabase, (tx) =>
    linkSlackIdentity(tx, {
      organizationId,
      principalId,
      identity,
      verifiedAt: new Date(),
    }));
}

function lookup(
  f: Fixture,
  input: { organizationId: string; principalId: string; teamId?: string },
) {
  return withPgTransaction(
    f.runtimePgDatabase,
    (tx) => findActiveSlackLinkForPrincipal(tx, input),
  );
}

async function otherOrganization(f: Fixture, principalId: string) {
  const organizationId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.organizations (id, name, slug, metadata, created_at,
       updated_at, version)
     values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
    [organizationId, `other-${organizationId}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at, created_at,
       updated_at, version
     ) values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1)`,
    [crypto.randomUUID(), organizationId, principalId],
  );
  return organizationId;
}

Deno.test("a principal's Slack link is found only while it and the membership are active, and only in its organization", async () => {
  const f = await openInstallationFixture();
  let other: string | undefined;
  try {
    assert(f.developerId !== undefined, "the fixture needs a second member");
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.developerId, identity)).ok);
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.developerId,
      }),
      identity,
    );
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.developerId,
        teamId: identity.teamId,
      }),
      identity,
    );
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.developerId,
        teamId: slackIdentity().teamId,
      }),
      undefined,
    );
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.adminId,
      }),
      undefined,
    );

    other = await otherOrganization(f, f.adminId);
    const elsewhere = slackIdentity();
    assert((await link(f, other, f.adminId, elsewhere)).ok);
    assertEquals(
      await lookup(f, { organizationId: other, principalId: f.adminId }),
      elsewhere,
    );
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.adminId,
      }),
      undefined,
    );

    await f.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive'
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.developerId,
      }),
      undefined,
    );
    await f.pgDatabase.query(
      `update bakery.organization_memberships set status = 'active'
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const stored = await f.pgDatabase.query<{ id: string }>(
      `select id from bakery.external_identity_links
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const revoked = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) =>
        revokeSlackIdentityLink(tx, {
          organizationId: f.organizationId,
          linkId: stored.rows[0]!.id,
          revokedBy: f.adminId,
          reason: "revoked_by_admin",
          at: new Date(),
        }),
    );
    assert(revoked.ok);
    assertEquals(
      await lookup(f, {
        organizationId: f.organizationId,
        principalId: f.developerId,
      }),
      undefined,
    );
    assertEquals(
      await lookup(f, { organizationId: "not-a-uuid", principalId: f.adminId }),
      undefined,
    );
  } finally {
    await f.pgDatabase.query(
      "delete from bakery.external_identity_links where organization_id = $1",
      [f.organizationId],
    );
    if (other !== undefined) {
      await f.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [other],
      );
    }
    await f.finish();
  }
});
