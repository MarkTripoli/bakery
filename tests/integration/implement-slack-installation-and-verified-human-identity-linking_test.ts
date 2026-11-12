import { assert, assertEquals, assertRejects } from "@std/assert";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  findSlackIdentityLink,
  linkSlackIdentity,
  reconcileSlackIdentityLinks,
  revokeSlackIdentityLink,
  type SlackLinkIdentity,
  slackLinkLookup,
} from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import {
  resolveSlackActor,
  type SlackSubject,
} from "../../apps/server/src/modules/integrations/slack-scope.ts";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "../../packages/persistence/src/postgres.ts";

// Slice 2 of #12: the persistence behind "a Slack user is a Bakery member only
// through a verified link". The module's own calls, and the reads that check
// them, go through `runtimePgDatabase`: the application role, whose privileges
// are the ones production has. The fixture's `pgDatabase` is the table owner,
// which can update any column, so it only sets members up and changes them the
// way another part of the product would.

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    assert(f.developerId !== undefined, "the fixture needs a second member");
    await run(f);
  } finally {
    await f.finish();
  }
}

const suffix = () => crypto.randomUUID().replaceAll("-", "").toUpperCase();

/** A Slack identity no other test run has used. */
function slackIdentity(overrides: Partial<SlackLinkIdentity> = {}) {
  const id = suffix();
  return {
    appId: `A${id.slice(0, 10)}`,
    teamId: `T${id.slice(10, 20)}`,
    userId: `U${id.slice(20, 30)}`,
    ...overrides,
  };
}

const now = () => new Date();

function inTransaction<T>(
  f: Fixture,
  work: (transaction: PgTransactionClient) => Promise<T>,
) {
  return withPgTransaction(f.runtimePgDatabase, work);
}

/** Who acts when this Slack user sends something, as the application would ask. */
function actorFor(f: Fixture, subject: SlackSubject) {
  return inTransaction(
    f,
    (tx) => resolveSlackActor(subject, slackLinkLookup(tx, f.organizationId)),
  );
}

async function link(
  f: Fixture,
  organizationId: string,
  principalId: string,
  identity: SlackLinkIdentity,
) {
  return await inTransaction(f, (tx) =>
    linkSlackIdentity(tx, {
      organizationId,
      principalId,
      identity,
      verifiedAt: now(),
    }));
}

async function lookup(
  f: Fixture,
  organizationId: string,
  identity: SlackLinkIdentity,
) {
  return await inTransaction(
    f,
    (tx) => findSlackIdentityLink(tx, { organizationId, ...identity }),
  );
}

async function rowCount(
  f: Fixture,
  organizationId: string,
  identity: SlackLinkIdentity,
) {
  const result = await f.runtimePgDatabase.query<{ n: string }>(
    `select count(*)::text as n from bakery.external_identity_links
      where organization_id = $1 and external_app_id = $2
        and identity_scope = $3 and external_user_id = $4`,
    [organizationId, identity.appId, identity.teamId, identity.userId],
  );
  return Number(result.rows[0]!.n);
}

async function setMembership(
  f: Fixture,
  principalId: string,
  status: "active" | "inactive",
) {
  const result = await f.pgDatabase.query(
    `update bakery.organization_memberships set status = $3,
            updated_at = now(), version = version + 1
      where organization_id = $1 and principal_id = $2`,
    [f.organizationId, principalId, status],
  );
  assertEquals(result.rowCount, 1, "the fixture member exists");
}

Deno.test("a verified link makes a Slack user a Bakery member, and only that link does", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    // Installed, not linked: the bot has no idea who this is.
    assertEquals(await lookup(f, f.organizationId, identity), undefined);
    assertEquals(
      await actorFor(f, identity),
      { kind: "service", verifiedHuman: false, reason: "unlinked" },
    );

    const linked = await link(f, f.organizationId, f.adminId, identity);
    assert(linked.ok);
    assertEquals(linked.outcome, "linked");
    assertEquals(linked.link.principalId, f.adminId);
    assertEquals(linked.link.state, "active");
    assertEquals(linked.link.version, 1);

    assertEquals(await lookup(f, f.organizationId, identity), {
      principalId: f.adminId,
      state: "active",
      memberCurrent: true,
    });
    assertEquals(
      await actorFor(f, identity),
      { kind: "human", principalId: f.adminId },
    );
  });
});

Deno.test("the same verified link again changes nothing", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const first = await link(f, f.organizationId, f.adminId, identity);
    assert(first.ok);
    const again = await link(f, f.organizationId, f.adminId, identity);
    assert(again.ok);
    assertEquals(again.outcome, "unchanged");
    assertEquals(again.link.id, first.link.id);
    assertEquals(again.link.version, 1, "no version bump for a no-op");
    assertEquals(await rowCount(f, f.organizationId, identity), 1);
  });
});

Deno.test("a Slack identity linked to one member cannot be taken by another, and the first link stands", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.adminId, identity)).ok);
    const taken = await link(f, f.organizationId, f.developerId!, identity);
    assertEquals(taken, { ok: false, reason: "linked_to_another_member" });
    assertEquals(
      (await lookup(f, f.organizationId, identity))?.principalId,
      f.adminId,
    );
    assertEquals(await rowCount(f, f.organizationId, identity), 1);
  });
});

Deno.test("only a current member can be linked: a stranger, an inactive member and a removed one are refused and nothing is written", async () => {
  await withFixture(async (f) => {
    const stranger = slackIdentity();
    assertEquals(
      await link(f, f.organizationId, crypto.randomUUID(), stranger),
      { ok: false, reason: "not_a_member" },
    );
    assertEquals(await rowCount(f, f.organizationId, stranger), 0);

    await setMembership(f, f.developerId!, "inactive");
    const inactive = slackIdentity();
    assertEquals(
      await link(f, f.organizationId, f.developerId!, inactive),
      { ok: false, reason: "not_a_member" },
    );
    assertEquals(await rowCount(f, f.organizationId, inactive), 0);

    await setMembership(f, f.developerId!, "active");
    assert(
      (await link(f, f.organizationId, f.developerId!, slackIdentity())).ok,
    );
  });
});

Deno.test("the same person in another workspace, or through another app, is a separate identity", async () => {
  await withFixture(async (f) => {
    const first = slackIdentity();
    const otherWorkspace = { ...first, teamId: slackIdentity().teamId };
    const otherApp = { ...first, appId: slackIdentity().appId };
    assert((await link(f, f.organizationId, f.adminId, first)).ok);
    // The same Slack user id under another workspace or app is not the same
    // person, so another member may hold it.
    assert(
      (await link(f, f.organizationId, f.developerId!, otherWorkspace)).ok,
    );
    assert((await link(f, f.organizationId, f.developerId!, otherApp)).ok);
    assertEquals(
      (await lookup(f, f.organizationId, first))?.principalId,
      f.adminId,
    );
    assertEquals(
      (await lookup(f, f.organizationId, otherWorkspace))?.principalId,
      f.developerId!,
    );
    assertEquals(
      (await lookup(f, f.organizationId, otherApp))?.principalId,
      f.developerId!,
    );
  });
});

Deno.test("a lookup is scoped to its organization: another organization's id finds nothing", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.adminId, identity)).ok);
    assertEquals(await lookup(f, crypto.randomUUID(), identity), undefined);
  });
});

Deno.test("malformed ids are refused before the database is touched", async () => {
  await withFixture(async (f) => {
    const good = slackIdentity();
    const bad: Array<[string, Partial<SlackLinkIdentity>]> = [
      ["a handle for a user", { userId: "alice" }],
      ["an email for a user", { userId: "alice@example.com" }],
      ["a lower-case workspace", { teamId: "t0abc123" }],
      ["a channel for a user", { userId: "C0CHANNEL1" }],
      ["an empty app", { appId: "" }],
      ["a trailing newline", { userId: `${good.userId}\n` }],
    ];
    for (const [name, change] of bad) {
      const identity = { ...good, ...change };
      assertEquals(
        await link(f, f.organizationId, f.adminId, identity),
        { ok: false, reason: "malformed" },
        name,
      );
      assertEquals(
        await lookup(f, f.organizationId, identity),
        undefined,
        name,
      );
    }
    assertEquals(
      await link(f, "not-a-uuid", f.adminId, good),
      { ok: false, reason: "malformed" },
    );
    assertEquals(
      await link(f, f.organizationId, "not-a-uuid", good),
      { ok: false, reason: "malformed" },
    );
    assertEquals(await rowCount(f, f.organizationId, good), 0);
  });
});

Deno.test("revoking a link makes the Slack user the service identity again, and says why", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const linked = await link(f, f.organizationId, f.developerId!, identity);
    assert(linked.ok);
    const revoked = await inTransaction(f, (tx) =>
      revokeSlackIdentityLink(tx, {
        organizationId: f.organizationId,
        linkId: linked.link.id,
        revokedBy: f.adminId,
        reason: "revoked_by_admin",
        at: now(),
      }));
    assert(revoked.ok);
    assertEquals(revoked.link.state, "revoked");
    assertEquals(revoked.link.revokedBy, f.adminId);
    assertEquals(revoked.link.revokeReason, "revoked_by_admin");
    assert(revoked.link.revokedAt !== null);
    assertEquals(revoked.link.version, 2);

    assertEquals(
      (await lookup(f, f.organizationId, identity))?.state,
      "revoked",
    );
    assertEquals(
      await actorFor(f, identity),
      { kind: "service", verifiedHuman: false, reason: "revoked" },
    );
  });
});

Deno.test("a revocation that finds nothing, finds it already done, or finds another organization's link says so and changes nothing", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const linked = await link(f, f.organizationId, f.adminId, identity);
    assert(linked.ok);
    const revoke = (organizationId: string, linkId: string) =>
      inTransaction(f, (tx) =>
        revokeSlackIdentityLink(tx, {
          organizationId,
          linkId,
          revokedBy: f.adminId,
          reason: "unlinked_by_member",
          at: now(),
        }));
    // Another organization's id must not reveal that this link exists.
    assertEquals(
      await revoke(crypto.randomUUID(), linked.link.id),
      { ok: false, reason: "not_found" },
    );
    assertEquals(
      await revoke(f.organizationId, crypto.randomUUID()),
      { ok: false, reason: "not_found" },
    );
    assertEquals(
      (await lookup(f, f.organizationId, identity))?.state,
      "active",
    );

    assert((await revoke(f.organizationId, linked.link.id)).ok);
    assertEquals(
      await revoke(f.organizationId, linked.link.id),
      { ok: false, reason: "already_revoked" },
    );
    assertEquals(
      await revoke(f.organizationId, "not-a-uuid"),
      { ok: false, reason: "malformed" },
    );
  });
});

Deno.test("a revoked identity can be linked again, by anyone who is a member, and the old holder gets nothing back", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const first = await link(f, f.organizationId, f.adminId, identity);
    assert(first.ok);
    assert(
      (await inTransaction(f, (tx) =>
        revokeSlackIdentityLink(tx, {
          organizationId: f.organizationId,
          linkId: first.link.id,
          revokedBy: f.adminId,
          reason: "unlinked_by_member",
          at: now(),
        }))).ok,
    );

    const again = await link(f, f.organizationId, f.developerId!, identity);
    assert(again.ok);
    assertEquals(again.outcome, "relinked");
    assertEquals(again.link.id, first.link.id, "the same row is reused");
    assertEquals(again.link.principalId, f.developerId!);
    assertEquals(again.link.state, "active");
    assertEquals(again.link.revokedAt, null);
    assertEquals(again.link.revokedBy, null);
    assertEquals(again.link.revokeReason, null);
    assertEquals(again.link.version, 3);
    assertEquals(await rowCount(f, f.organizationId, identity), 1);
    assertEquals(
      await actorFor(f, identity),
      { kind: "human", principalId: f.developerId! },
    );
  });
});

Deno.test("a member who is made inactive stops being a human at once, and reconciling revokes the link for good", async () => {
  await withFixture(async (f) => {
    const mine = slackIdentity();
    const theirs = slackIdentity();
    assert((await link(f, f.organizationId, f.developerId!, mine)).ok);
    assert((await link(f, f.organizationId, f.adminId, theirs)).ok);

    await setMembership(f, f.developerId!, "inactive");
    // Live, with no reconcile having run: the link exists but its member is not current.
    assertEquals(
      (await lookup(f, f.organizationId, mine))?.memberCurrent,
      false,
    );
    assertEquals(
      await actorFor(f, mine),
      { kind: "service", verifiedHuman: false, reason: "not_a_member" },
    );

    const swept = await inTransaction(
      f,
      (tx) =>
        reconcileSlackIdentityLinks(tx, {
          organizationId: f.organizationId,
          at: now(),
        }),
    );
    assertEquals(swept, { revoked: 1 });
    const after = await lookup(f, f.organizationId, mine);
    assertEquals(after?.state, "revoked");
    // The other member's link is untouched.
    assertEquals((await lookup(f, f.organizationId, theirs))?.state, "active");

    // Reinstating the member does not bring the Slack link back.
    await setMembership(f, f.developerId!, "active");
    assertEquals(
      await actorFor(f, mine),
      { kind: "service", verifiedHuman: false, reason: "revoked" },
    );
    // Reconciling again finds nothing, and the reason was recorded.
    assertEquals(
      await inTransaction(
        f,
        (tx) =>
          reconcileSlackIdentityLinks(tx, {
            organizationId: f.organizationId,
            at: now(),
          }),
      ),
      { revoked: 0 },
    );
    const reason = await f.runtimePgDatabase.query<
      { reason: string; by: string | null }
    >(
      `select revoke_reason as reason, revoked_by as by
         from bakery.external_identity_links
        where organization_id = $1 and external_user_id = $2`,
      [f.organizationId, mine.userId],
    );
    assertEquals(reason.rows[0], { reason: "membership_inactive", by: null });
  });
});

Deno.test("reconciling is bounded by its limit and by its organization", async () => {
  await withFixture(async (f) => {
    const ids = [slackIdentity(), slackIdentity(), slackIdentity()];
    for (const identity of ids) {
      assert((await link(f, f.organizationId, f.developerId!, identity)).ok);
    }
    await setMembership(f, f.developerId!, "inactive");
    const other = await inTransaction(
      f,
      (tx) =>
        reconcileSlackIdentityLinks(tx, {
          organizationId: crypto.randomUUID(),
          at: now(),
        }),
    );
    assertEquals(
      other,
      { revoked: 0 },
      "another organization's id sweeps nothing here",
    );
    const first = await inTransaction(
      f,
      (tx) =>
        reconcileSlackIdentityLinks(tx, {
          organizationId: f.organizationId,
          at: now(),
          limit: 2,
        }),
    );
    assertEquals(first, { revoked: 2 });
    const second = await inTransaction(
      f,
      (tx) =>
        reconcileSlackIdentityLinks(tx, {
          organizationId: f.organizationId,
          at: now(),
          limit: 2,
        }),
    );
    assertEquals(second, { revoked: 1 });
    await setMembership(f, f.developerId!, "active");
  });
});

Deno.test("removing a member removes their Slack links with them, so re-adding them restores nothing", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.developerId!, identity)).ok);
    assertEquals(await rowCount(f, f.organizationId, identity), 1);
    const removed = await f.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId!],
    );
    assertEquals(removed.rowCount, 1);
    assertEquals(await rowCount(f, f.organizationId, identity), 0);
    assertEquals(
      await actorFor(f, identity),
      { kind: "service", verifiedHuman: false, reason: "unlinked" },
    );
  });
});

Deno.test("two members racing for one Slack identity: exactly one wins and the other is told so", async () => {
  await withFixture(async (f) => {
    for (let round = 0; round < 8; round += 1) {
      const identity = slackIdentity();
      const [a, b] = await Promise.all([
        link(f, f.organizationId, f.adminId, identity),
        link(f, f.organizationId, f.developerId!, identity),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      assertEquals(winners.length, 1, `round ${round}: one winner`);
      assertEquals(losers.length, 1, `round ${round}: one loser`);
      assertEquals(losers[0], {
        ok: false,
        reason: "linked_to_another_member",
      });
      assertEquals(await rowCount(f, f.organizationId, identity), 1);
      const holder = (await lookup(f, f.organizationId, identity))?.principalId;
      assertEquals(
        holder,
        winners[0]!.ok ? winners[0]!.link.principalId : undefined,
      );
    }
  });
});

Deno.test("the application role cannot change which identity a link is, move it to another organization or delete it", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const linked = await link(f, f.organizationId, f.adminId, identity);
    assert(linked.ok);
    for (
      const column of [
        "organization_id",
        "provider",
        "external_app_id",
        "identity_scope",
        "external_user_id",
        "created_at",
        "id",
      ]
    ) {
      const value = column === "organization_id" || column === "id"
        ? crypto.randomUUID()
        : column === "created_at"
        ? new Date().toISOString()
        : "X";
      await assertRejects(
        () =>
          f.runtimePgDatabase.query(
            `update bakery.external_identity_links set ${column} = $2 where id = $1`,
            [linked.link.id, value],
          ),
        Error,
        "permission denied",
        `the application role must not be able to change ${column}`,
      );
    }
    await assertRejects(
      () =>
        f.runtimePgDatabase.query(
          "delete from bakery.external_identity_links where id = $1",
          [linked.link.id],
        ),
      Error,
      "permission denied",
    );
    // The row is intact.
    assertEquals(
      (await lookup(f, f.organizationId, identity))?.principalId,
      f.adminId,
    );
  });
});

Deno.test("the table holds identifiers and times, never a token, secret or proof", async () => {
  await withFixture(async (f) => {
    const columns = await f.runtimePgDatabase.query<
      { name: string; type: string }
    >(
      `select column_name as name, data_type as type
         from information_schema.columns
        where table_schema = 'bakery' and table_name = 'external_identity_links'
        order by column_name`,
    );
    assertEquals(columns.rows.map((c) => c.name), [
      "created_at",
      "external_app_id",
      "external_user_id",
      "id",
      "identity_scope",
      "organization_id",
      "principal_id",
      "provider",
      "revoke_reason",
      "revoked_at",
      "revoked_by",
      "state",
      "updated_at",
      "verification_method",
      "verified_at",
      "version",
    ]);
    assert(
      columns.rows.every((c) => c.type !== "bytea"),
      "no binary column that could hold a token",
    );
  });
});

Deno.test("a link held by a member who is no longer current does not block the member who has just proven the identity", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.developerId!, identity)).ok);
    await setMembership(f, f.developerId!, "inactive");
    // No reconcile has run. The old holder is not a human, and the admin, who
    // proves the identity through Sign in with Slack, takes the link.
    const taken = await link(f, f.organizationId, f.adminId, identity);
    assert(taken.ok);
    assertEquals(taken.outcome, "relinked");
    assertEquals(taken.link.principalId, f.adminId);
    assertEquals(taken.link.state, "active");
    assertEquals(await rowCount(f, f.organizationId, identity), 1);
    await setMembership(f, f.developerId!, "active");
    // Reinstating the old holder gives them nothing back.
    assertEquals(
      await actorFor(f, identity),
      { kind: "human", principalId: f.adminId },
    );
  });
});

Deno.test("a subject that does not name its Slack app finds no link, and a link is not shared between apps", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    assert((await link(f, f.organizationId, f.adminId, identity)).ok);
    const { appId: _app, ...withoutApp } = identity;
    assertEquals(
      await actorFor(f, withoutApp),
      { kind: "service", verifiedHuman: false, reason: "unlinked" },
    );
    assertEquals(
      await actorFor(f, { ...identity, appId: slackIdentity().appId }),
      { kind: "service", verifiedHuman: false, reason: "unlinked" },
    );
    assertEquals(
      await actorFor(f, { ...identity, appId: "not-an-app" }),
      { kind: "service", verifiedHuman: false, reason: "malformed" },
    );
    assertEquals(await actorFor(f, identity), {
      kind: "human",
      principalId: f.adminId,
    });
  });
});
