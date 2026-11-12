import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { loadSecretKey } from "../../apps/server/src/modules/secrets/crypto.ts";
import {
  claimSlackIdentityAttempt,
  completeSlackIdentityAttempt,
  createSlackIdentityAttempt,
  failSlackIdentityAttempt,
  SLACK_IDENTITY_ATTEMPT_TTL_MINUTES,
} from "../../apps/server/src/modules/integrations/slack-identity-attempts.ts";
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

Deno.test("reconciling honours its limit whatever the planner statistics say, takes the oldest first, and sweeps only its own organization", async () => {
  await withFixture(async (f) => {
    // The first form of the sweep revoked 3 where the limit was 2 when the table
    // had been analyzed while empty (the planner then re-ran its subquery per
    // row), and which regime a run met depended on autovacuum. Both are forced.
    for (
      const regime of [
        "statistics of an empty table",
        "statistics of a populated table",
      ] as const
    ) {
      await f.pgDatabase.query(
        `delete from bakery.external_identity_links where organization_id = $1`,
        [f.organizationId],
      );
      if (regime === "statistics of an empty table") {
        await f.pgDatabase.query(`analyze bakery.external_identity_links`);
      }
      const ids = [slackIdentity(), slackIdentity(), slackIdentity()];
      for (const identity of ids) {
        assert(
          (await link(f, f.organizationId, f.developerId!, identity)).ok,
          regime,
        );
        // Distinct creation times, so "oldest first" has an answer.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (regime === "statistics of a populated table") {
        await f.pgDatabase.query(`analyze bakery.external_identity_links`);
      }
      await setMembership(f, f.developerId!, "inactive");
      const states = async () =>
        await Promise.all(
          ids.map(async (identity) =>
            (await lookup(f, f.organizationId, identity))?.state
          ),
        );
      const sweep = (organizationId: string, limit: number) =>
        inTransaction(
          f,
          (tx) =>
            reconcileSlackIdentityLinks(tx, {
              organizationId,
              at: now(),
              limit,
            }),
        );

      assertEquals(
        await sweep(crypto.randomUUID(), 2),
        { revoked: 0 },
        `${regime}: another organization's id sweeps nothing here`,
      );
      assertEquals(
        await sweep(f.organizationId, 2),
        { revoked: 2 },
        `${regime}: exactly the limit`,
      );
      assertEquals(
        await states(),
        ["revoked", "revoked", "active"],
        `${regime}: the two oldest went`,
      );
      assertEquals(await sweep(f.organizationId, 2), { revoked: 1 }, regime);
      assertEquals(await states(), ["revoked", "revoked", "revoked"], regime);
      assertEquals(await sweep(f.organizationId, 2), { revoked: 0 }, regime);
      await setMembership(f, f.developerId!, "active");
    }
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

/** Links at a given proof time. */
async function linkAt(
  f: Fixture,
  organizationId: string,
  principalId: string,
  identity: SlackLinkIdentity,
  verifiedAt: Date,
) {
  return await inTransaction(
    f,
    (tx) =>
      linkSlackIdentity(tx, {
        organizationId,
        principalId,
        identity,
        verifiedAt,
      }),
  );
}

function revoke(
  f: Fixture,
  linkId: string,
  overrides: Partial<Parameters<typeof revokeSlackIdentityLink>[1]> = {},
) {
  return inTransaction(f, (tx) =>
    revokeSlackIdentityLink(tx, {
      organizationId: f.organizationId,
      linkId,
      revokedBy: f.adminId,
      reason: "unlinked_by_member",
      at: now(),
      ...overrides,
    }));
}

Deno.test("membership is judged in the organization asked about: a member inactive here and active elsewhere is neither linked nor current here", async () => {
  await withFixture(async (f) => {
    const developer = f.developerId!;
    const otherOrganization = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1, 'org B', $2, now(), now())`,
      [otherOrganization, `b-${suffix().toLowerCase()}`],
    );
    await f.pgDatabase.query(
      `insert into bakery.organization_memberships
         (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at)
       values ($1, $2, $3, 'developer', 'active', now(), now(), now())`,
      [crypto.randomUUID(), otherOrganization, developer],
    );
    try {
      // Linked while active here; then inactive here, still active in the other.
      const identity = slackIdentity();
      const taken = slackIdentity();
      assert((await link(f, f.organizationId, developer, identity)).ok);
      assert((await link(f, f.organizationId, developer, taken)).ok);
      await setMembership(f, developer, "inactive");
      assertEquals(
        (await lookup(f, f.organizationId, identity))?.memberCurrent,
        false,
        "current in the organization asked about, not in some other",
      );
      // A holder who is a member only elsewhere does not keep the link here.
      const takeover = await link(f, f.organizationId, f.adminId, taken);
      assert(takeover.ok, "the holder is not a current member of this one");
      assertEquals(takeover.outcome, "relinked");
      assertEquals(
        await inTransaction(
          f,
          (tx) =>
            reconcileSlackIdentityLinks(tx, {
              organizationId: f.organizationId,
              at: now(),
            }),
        ),
        { revoked: 1 },
        "the sweep reads the same organization's membership",
      );
      // And a new link is refused here although the member is active elsewhere.
      assertEquals(
        await link(f, f.organizationId, developer, slackIdentity()),
        { ok: false, reason: "not_a_member" },
      );
      // Removed from here altogether: a result, not a foreign-key exception.
      await f.pgDatabase.query(
        `delete from bakery.organization_memberships where organization_id = $1 and principal_id = $2`,
        [f.organizationId, developer],
      );
      assertEquals(
        await link(f, f.organizationId, developer, slackIdentity()),
        { ok: false, reason: "not_a_member" },
      );
    } finally {
      await f.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [otherOrganization],
      );
    }
  });
});

Deno.test("two different current members racing for a revoked identity: exactly one takes it and the other is told so", async () => {
  await withFixture(async (f) => {
    for (let round = 0; round < 8; round += 1) {
      const identity = slackIdentity();
      const first = await link(f, f.organizationId, f.developerId!, identity);
      assert(first.ok);
      assert((await revoke(f, first.link.id)).ok);
      const [a, b] = await Promise.all([
        link(f, f.organizationId, f.adminId, identity),
        link(f, f.organizationId, f.developerId!, identity),
      ]);
      const winners = [a, b].filter((result) => result.ok);
      const losers = [a, b].filter((result) => !result.ok);
      assertEquals(winners.length, 1, `round ${round}: one winner`);
      assertEquals(losers, [{ ok: false, reason: "linked_to_another_member" }]);
      const winner = winners[0]!;
      assert(winner.ok);
      assertEquals(winner.outcome, "relinked");
      // linked (1), revoked (2), relinked (3): a second takeover would be 4.
      assertEquals(winner.link.version, 3, `round ${round}`);
      assertEquals(await rowCount(f, f.organizationId, identity), 1);
    }
  });
});

Deno.test("a takeover records the new proof's time, not the old one", async () => {
  await withFixture(async (f) => {
    const identity = slackIdentity();
    const earlier = new Date("2026-01-02T03:04:05.000Z");
    const later = new Date("2026-06-07T08:09:10.000Z");
    const first = await linkAt(
      f,
      f.organizationId,
      f.developerId!,
      identity,
      earlier,
    );
    assert(first.ok);
    assertEquals(first.link.verifiedAt, earlier.toISOString());
    assert((await revoke(f, first.link.id)).ok);
    const again = await linkAt(f, f.organizationId, f.adminId, identity, later);
    assert(again.ok);
    assertEquals(again.outcome, "relinked");
    assertEquals(again.link.verifiedAt, later.toISOString());
  });
});

Deno.test("a revocation names one of three reasons and nothing else", async () => {
  await withFixture(async (f) => {
    for (
      const reason of [
        "revoked_by_admin",
        "unlinked_by_member",
        "membership_inactive",
      ] as const
    ) {
      const linked = await link(
        f,
        f.organizationId,
        f.adminId,
        slackIdentity(),
      );
      assert(linked.ok);
      const revoked = await revoke(f, linked.link.id, { reason });
      assert(revoked.ok, reason);
      assertEquals(revoked.link.revokeReason, reason);
    }
    const linked = await link(f, f.organizationId, f.adminId, slackIdentity());
    assert(linked.ok);
    for (
      const reason of [
        "because",
        "",
        "REVOKED_BY_ADMIN",
        "revoked_by_admin ",
        null,
        undefined,
        5,
        {},
      ]
    ) {
      assertEquals(
        await revoke(f, linked.link.id, { reason: reason as never }),
        { ok: false, reason: "malformed" },
        JSON.stringify(reason),
      );
    }
    const stillActive = await f.runtimePgDatabase.query<
      { state: string; reason: string | null }
    >(
      `select state, revoke_reason as reason from bakery.external_identity_links where id = $1`,
      [linked.link.id],
    );
    assertEquals(stillActive.rows[0], { state: "active", reason: null });
  });
});

Deno.test("a time that is not a usable time is refused as malformed instead of aborting the caller's transaction", async () => {
  await withFixture(async (f) => {
    const unusable = [
      new Date(Number.NaN),
      new Date(-8.64e15),
      new Date(8.64e15),
      new Date(Date.UTC(1969, 11, 31, 23, 59, 59, 999)),
      new Date(Date.UTC(10000, 0, 1)),
    ];
    for (const verifiedAt of unusable) {
      const identity = slackIdentity();
      assertEquals(
        await linkAt(f, f.organizationId, f.adminId, identity, verifiedAt),
        { ok: false, reason: "malformed" },
        String(verifiedAt.getTime()),
      );
      assertEquals(await rowCount(f, f.organizationId, identity), 0);
    }
    for (
      const verifiedAt of [
        new Date(Date.UTC(1970, 0, 1)),
        new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999)),
      ]
    ) {
      assert(
        (await linkAt(
          f,
          f.organizationId,
          f.adminId,
          slackIdentity(),
          verifiedAt,
        )).ok,
      );
    }
    // The same for a revocation and for a sweep: refused, and nothing changes.
    const linked = await link(
      f,
      f.organizationId,
      f.developerId!,
      slackIdentity(),
    );
    assert(linked.ok);
    for (const at of unusable) {
      assertEquals(await revoke(f, linked.link.id, { at }), {
        ok: false,
        reason: "malformed",
      });
    }
    await setMembership(f, f.developerId!, "inactive");
    for (const at of unusable) {
      assertEquals(
        await inTransaction(
          f,
          (tx) =>
            reconcileSlackIdentityLinks(tx, {
              organizationId: f.organizationId,
              at,
            }),
        ),
        { revoked: 0 },
      );
    }
    const state = await lookup(f, f.organizationId, {
      ...(await f.runtimePgDatabase.query<
        { appId: string; teamId: string; userId: string }
      >(
        `select external_app_id as "appId", identity_scope as "teamId", external_user_id as "userId"
           from bakery.external_identity_links where id = $1`,
        [linked.link.id],
      )).rows[0]!,
    });
    assertEquals(
      state?.state,
      "active",
      "nothing was revoked by a refused call",
    );
    await setMembership(f, f.developerId!, "active");
  });
});

Deno.test("a revoker who is not a principal is a refusal in the module and a foreign-key error in the database", async () => {
  await withFixture(async (f) => {
    const linked = await link(f, f.organizationId, f.adminId, slackIdentity());
    assert(linked.ok);
    assertEquals(
      await revoke(f, linked.link.id, { revokedBy: crypto.randomUUID() }),
      { ok: false, reason: "unknown_revoker" },
    );
    const untouched = await f.runtimePgDatabase.query<{ state: string }>(
      `select state from bakery.external_identity_links where id = $1`,
      [linked.link.id],
    );
    assertEquals(untouched.rows[0]?.state, "active");
    // The table itself holds the rule, for any writer: the owner can write any
    // column, so this is the foreign key and nothing else.
    await assertRejects(
      () =>
        f.pgDatabase.query(
          `update bakery.external_identity_links set revoked_by = $2 where id = $1`,
          [linked.link.id, crypto.randomUUID()],
        ),
      Error,
      "violates foreign key constraint",
    );
    // A system revocation has no revoker at all.
    const system = await revoke(f, linked.link.id, {
      revokedBy: null,
      reason: "membership_inactive",
    });
    assert(system.ok);
    assertEquals(system.link.revokedBy, null);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 of #12: the attempt that binds a Sign in with Slack round trip to the
// Bakery member and browser session that began it. The state is the secret the
// callback must present; the nonce is checked against the identity token. Both
// are returned once and stored as a hash and as ciphertext.

const ATTEMPT_KEY_ID = "slack-attempt-v1";

async function attemptKey(): Promise<{ key: CryptoKey; keyId: string }> {
  const directory = await Deno.makeTempDir();
  try {
    const file = `${directory}/key`;
    await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
    return {
      key: await loadSecretKey({ file, keyId: ATTEMPT_KEY_ID }),
      keyId: ATTEMPT_KEY_ID,
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

type AttemptKey = Awaited<ReturnType<typeof attemptKey>>;

function attemptBinding() {
  const id = suffix();
  return {
    appId: `A${id.slice(0, 10)}`,
    clientId: `${Math.floor(Math.random() * 9e9 + 1e9)}.${
      Math.floor(Math.random() * 9e12 + 1e12)
    }`,
    teamId: `T${id.slice(10, 20)}`,
  };
}

async function startAttempt(
  f: Fixture,
  k: AttemptKey,
  overrides: Record<string, unknown> = {},
) {
  const sessionId = `session-${suffix()}`;
  const input = {
    organizationId: f.organizationId,
    principalId: f.adminId,
    sessionId,
    binding: attemptBinding(),
    secretsKey: k.key,
    keyId: k.keyId,
    ...overrides,
  };
  const result = await inTransaction(
    f,
    (tx) => createSlackIdentityAttempt(tx, input as never),
  );
  return { result, input, sessionId: input.sessionId as string };
}

function claimAttempt(
  f: Fixture,
  k: AttemptKey,
  state: string,
  overrides: Record<string, unknown> = {},
) {
  return inTransaction(f, (tx) =>
    claimSlackIdentityAttempt(tx, {
      state,
      sessionId: "",
      principalId: f.adminId,
      secretsKey: k.key,
      keyId: k.keyId,
      ...overrides,
    } as never));
}

async function attemptRow(f: Fixture, attemptId: string) {
  const row = await f.pgDatabase.query<Record<string, unknown>>(
    `select * from bakery.slack_identity_attempts where id = $1`,
    [attemptId],
  );
  assertEquals(row.rows.length, 1, "the attempt row exists");
  return row.rows[0]!;
}

Deno.test("an attempt hands the state and nonce back once and stores a hash and ciphertext, never the values", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result, input } = await startAttempt(f, k);
    assert(result.ok);
    assert(result.state.length >= 43 && result.nonce.length >= 43);
    assertNotEquals(result.state, result.nonce);
    const row = await attemptRow(f, result.attemptId);
    assertEquals(row.state_hash, await sha256Hex(result.state));
    assertEquals(row.status, "pending");
    assertEquals(row.app_id, (input.binding as { appId: string }).appId);
    assertEquals(row.team_id, (input.binding as { teamId: string }).teamId);
    assertEquals(row.enterprise_id, null);
    const stored = JSON.stringify(
      row,
      (_k, v) => v instanceof Uint8Array ? Array.from(v) : v,
    );
    assert(!stored.includes(result.state), "the state is stored in the clear");
    assert(!stored.includes(result.nonce), "the nonce is stored in the clear");
    const ttl = await f.pgDatabase.query<{ minutes: string }>(
      `select (extract(epoch from (expires_at - created_at)) / 60)::text as minutes
         from bakery.slack_identity_attempts where id = $1`,
      [result.attemptId],
    );
    assertEquals(
      Math.round(Number(ttl.rows[0]!.minutes)),
      SLACK_IDENTITY_ATTEMPT_TTL_MINUTES,
    );
  });
});

Deno.test("a claim is single use: the first wins, returns what was bound, and a replay is refused", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const enterprise = `E${suffix().slice(0, 9)}`;
    const { result, input, sessionId } = await startAttempt(f, k, {
      binding: { ...attemptBinding(), enterpriseId: enterprise },
    });
    assert(result.ok);
    const first = await claimAttempt(f, k, result.state, { sessionId });
    assert(first.ok, "the first claim wins");
    const bound = input.binding as {
      appId: string;
      clientId: string;
      teamId: string;
    };
    assertEquals(first.attempt.nonce, result.nonce);
    assertEquals(first.attempt.attemptId, result.attemptId);
    assertEquals(first.attempt.organizationId, f.organizationId);
    assertEquals(first.attempt.principalId, f.adminId);
    assertEquals(first.attempt.appId, bound.appId);
    assertEquals(first.attempt.clientId, bound.clientId);
    assertEquals(first.attempt.teamId, bound.teamId);
    assertEquals(first.attempt.enterpriseId, enterprise);
    assertEquals(await claimAttempt(f, k, result.state, { sessionId }), {
      ok: false,
      reason: "refused",
    });
    const row = await attemptRow(f, result.attemptId);
    assertEquals(row.status, "exchanging");
    assert(row.consumed_at !== null, "the claim is recorded");
  });
});

Deno.test("a claim from another session, another member or with another state is refused and does not use the attempt up", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result, sessionId } = await startAttempt(f, k);
    assert(result.ok);
    const refused = { ok: false, reason: "refused" } as const;
    assertEquals(
      await claimAttempt(f, k, result.state, {
        sessionId: `${sessionId}-other`,
      }),
      refused,
    );
    assertEquals(
      await claimAttempt(f, k, result.state, {
        sessionId,
        principalId: f.developerId!,
      }),
      refused,
    );
    assertEquals(
      await claimAttempt(f, k, `${result.state}x`, { sessionId }),
      refused,
    );
    assertEquals(await claimAttempt(f, k, "", { sessionId }), refused);
    assertEquals(
      await claimAttempt(f, k, result.state, {
        sessionId,
        principalId: "not-a-uuid",
      }),
      refused,
    );
    assertEquals(
      (await attemptRow(f, result.attemptId)).status,
      "pending",
      "still claimable",
    );
    assert(
      (await claimAttempt(f, k, result.state, { sessionId })).ok,
      "the owner still can",
    );
  });
});

Deno.test("an expired attempt cannot be claimed, and the refusal does not consume it", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result, sessionId } = await startAttempt(f, k);
    assert(result.ok);
    await f.pgDatabase.query(
      `update bakery.slack_identity_attempts set expires_at = now() - interval '1 second' where id = $1`,
      [result.attemptId],
    );
    assertEquals(await claimAttempt(f, k, result.state, { sessionId }), {
      ok: false,
      reason: "refused",
    });
    assertEquals((await attemptRow(f, result.attemptId)).status, "pending");
  });
});

Deno.test("two claims racing for one attempt: exactly one wins", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    for (let round = 0; round < 8; round += 1) {
      const { result, sessionId } = await startAttempt(f, k);
      assert(result.ok);
      const claims = await Promise.all([
        claimAttempt(f, k, result.state, { sessionId }),
        claimAttempt(f, k, result.state, { sessionId }),
        claimAttempt(f, k, result.state, { sessionId }),
      ]);
      assertEquals(
        claims.filter((claim) => claim.ok).length,
        1,
        `round ${round}`,
      );
    }
  });
});

Deno.test("an attempt needs a current member, malformed input never reaches the database, and a newer attempt supersedes the member's older one", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const rows = async () =>
      Number(
        (await f.pgDatabase.query<{ n: string }>(
          `select count(*)::text as n from bakery.slack_identity_attempts where organization_id = $1`,
          [f.organizationId],
        )).rows[0]!.n,
      );

    await setMembership(f, f.developerId!, "inactive");
    assertEquals(
      (await startAttempt(f, k, { principalId: f.developerId! })).result,
      { ok: false, reason: "not_a_member" },
    );
    await setMembership(f, f.developerId!, "active");
    assertEquals(
      (await startAttempt(f, k, { principalId: crypto.randomUUID() })).result,
      { ok: false, reason: "not_a_member" },
    );

    const before = await rows();
    const good = attemptBinding();
    for (
      const bad of [
        { organizationId: "not-a-uuid" },
        { principalId: "" },
        { sessionId: "" },
        { sessionId: "s".repeat(300) },
        { binding: { ...good, appId: "B123" } },
        { binding: { ...good, teamId: "t123" } },
        { binding: { ...good, enterpriseId: "X123" } },
        { binding: { ...good, clientId: "" } },
        { binding: { ...good, clientId: "c".repeat(200) } },
        { binding: null },
        { secretsKey: undefined },
      ]
    ) {
      assertEquals(
        (await startAttempt(f, k, bad)).result,
        { ok: false, reason: "malformed" },
        JSON.stringify(bad),
      );
    }
    assertEquals(await rows(), before, "nothing was written for any of them");

    // The same member starting again for the same workspace replaces the earlier attempt.
    const binding = attemptBinding();
    const older = await startAttempt(f, k, { binding });
    const other = await startAttempt(f, k, {
      principalId: f.developerId!,
      binding,
    });
    const newer = await startAttempt(f, k, { binding });
    assert(older.result.ok && other.result.ok && newer.result.ok);
    assertEquals(
      await claimAttempt(f, k, older.result.state, {
        sessionId: older.sessionId,
      }),
      { ok: false, reason: "refused" },
    );
    const superseded = await attemptRow(f, older.result.attemptId);
    assertEquals([superseded.status, superseded.failure_code], [
      "failed",
      "superseded",
    ]);
    assertEquals(
      (await attemptRow(f, other.result.attemptId)).status,
      "pending",
      "another member's attempt is untouched",
    );
    // And to the workspace: the same member linking a different one keeps both live.
    const elsewhere = await startAttempt(f, k, { binding: attemptBinding() });
    assert(elsewhere.result.ok);
    const again = await startAttempt(f, k, { binding });
    assert(again.result.ok);
    assertEquals(
      (await attemptRow(f, elsewhere.result.attemptId)).status,
      "pending",
      "another workspace's attempt is untouched",
    );
    assertEquals(
      (await attemptRow(f, newer.result.attemptId)).failure_code,
      "superseded",
    );
    assert(
      (await claimAttempt(f, k, again.result.state, {
        sessionId: again.sessionId,
      })).ok,
    );
  });
});

Deno.test("complete and fail act only on a claimed attempt, and a failure code is one of a fixed few", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const finish = (id: string) =>
      inTransaction(
        f,
        (tx) => completeSlackIdentityAttempt(tx, { attemptId: id }),
      );
    const fail = (id: string, code: unknown) =>
      inTransaction(
        f,
        (tx) => failSlackIdentityAttempt(tx, { attemptId: id, code } as never),
      );

    const { result, sessionId } = await startAttempt(f, k);
    assert(result.ok);
    assertEquals(
      await finish(result.attemptId),
      false,
      "a pending attempt cannot complete",
    );
    assertEquals(
      await fail(result.attemptId, "token_invalid"),
      false,
      "nor fail",
    );
    assert((await claimAttempt(f, k, result.state, { sessionId })).ok);
    assertEquals(
      await fail(result.attemptId, "not a code"),
      false,
      "an unknown code is refused",
    );
    assertEquals(await fail(result.attemptId, undefined), false);
    assertEquals((await attemptRow(f, result.attemptId)).status, "exchanging");
    assertEquals(await finish(result.attemptId), true);
    assertEquals(await finish(result.attemptId), false, "only once");
    assertEquals(
      await fail(result.attemptId, "token_invalid"),
      false,
      "a completed attempt cannot fail afterwards",
    );
    assertEquals((await attemptRow(f, result.attemptId)).status, "completed");

    const second = await startAttempt(f, k);
    assert(second.result.ok);
    assert(
      (await claimAttempt(f, k, second.result.state, {
        sessionId: second.sessionId,
      })).ok,
    );
    assertEquals(await fail(second.result.attemptId, "token_invalid"), true);
    const row = await attemptRow(f, second.result.attemptId);
    assertEquals([row.status, row.failure_code], ["failed", "token_invalid"]);
  });
});

Deno.test("a nonce that cannot be read back fails the attempt closed", async () => {
  await withFixture(async (f) => {
    const writer = await attemptKey();
    const reader = await attemptKey(); // other key material under the same key id
    const { result, sessionId } = await startAttempt(f, writer);
    assert(result.ok);
    assertEquals(await claimAttempt(f, reader, result.state, { sessionId }), {
      ok: false,
      reason: "refused",
    });
    const row = await attemptRow(f, result.attemptId);
    assertEquals([row.status, row.failure_code], [
      "failed",
      "nonce_unreadable",
    ]);

    // The same key material under another key identity is not the key it was sealed under.
    const sealed = await startAttempt(f, writer);
    assert(sealed.result.ok);
    assertEquals(
      await claimAttempt(f, writer, sealed.result.state, {
        sessionId: sealed.sessionId,
        keyId: "slack-attempt-v2",
      }),
      { ok: false, reason: "refused" },
    );
    const other = await attemptRow(f, sealed.result.attemptId);
    assertEquals([other.status, other.failure_code], [
      "failed",
      "nonce_unreadable",
    ]);
  });
});

Deno.test("two attempts cannot share a state, whatever wrote them", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result } = await startAttempt(f, k);
    assert(result.ok);
    const first = await attemptRow(f, result.attemptId);
    await assertRejects(
      () =>
        f.pgDatabase.query(
          `insert into bakery.slack_identity_attempts
             (id, organization_id, initiating_principal_id, session_id, state_hash,
              nonce_ciphertext, nonce_iv, nonce_key_id, app_id, client_id, team_id,
              expires_at, status)
           values ($1, $2, $3, 's', $4, $5, $6, 'k', 'A12', 'c', 'T12', now(), 'pending')`,
          [
            crypto.randomUUID(),
            f.organizationId,
            f.adminId,
            first.state_hash,
            first.nonce_ciphertext,
            first.nonce_iv,
          ],
        ),
      Error,
      "slack_identity_attempts_state_hash_unique",
    );
  });
});

Deno.test("the application role may move an attempt through its lifecycle and may change nothing it was bound to", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result } = await startAttempt(f, k);
    assert(result.ok);
    const app = f.runtimePgDatabase;
    for (
      const column of [
        "organization_id",
        "initiating_principal_id",
        "session_id",
        "state_hash",
        "nonce_ciphertext",
        "nonce_iv",
        "nonce_key_id",
        "app_id",
        "client_id",
        "team_id",
        "enterprise_id",
        "expires_at",
        "created_at",
      ]
    ) {
      await assertRejects(
        () =>
          app.query(
            `update bakery.slack_identity_attempts set ${column} = ${column} where id = $1`,
            [result.attemptId],
          ),
        Error,
        "permission denied",
        column,
      );
    }
    await app.query(
      `update bakery.slack_identity_attempts set status = status, failure_code = failure_code,
              consumed_at = consumed_at, updated_at = now(), version = version where id = $1`,
      [result.attemptId],
    );
    await assertRejects(
      () =>
        app.query(`delete from bakery.slack_identity_attempts where id = $1`, [
          result.attemptId,
        ]),
      Error,
      "permission denied",
    );
    await assertRejects(
      () => app.query(`truncate bakery.slack_identity_attempts`),
      Error,
      "permission denied",
    );
  });
});

Deno.test("removing a member removes the attempts they started", async () => {
  await withFixture(async (f) => {
    const k = await attemptKey();
    const { result } = await startAttempt(f, k, {
      principalId: f.developerId!,
    });
    assert(result.ok);
    await f.pgDatabase.query(
      `delete from bakery.organization_memberships where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId!],
    );
    const left = await f.pgDatabase.query(
      `select 1 from bakery.slack_identity_attempts where id = $1`,
      [result.attemptId],
    );
    assertEquals(left.rows.length, 0);
  });
});
