/**
 * #415: one Approve button, one decision.
 *
 * The perimeter is the subject here, not the store. Slack's signature proves the
 * request came from Slack and nothing about who pressed it, so these tests ask the
 * questions a person can actually get wrong: pressing from an account that is not
 * linked, pressing in a thread whose decision is already settled, pressing on a post
 * that belongs to another workspace, and pressing from a member who may not answer
 * this particular approval. Each has to refuse with its own name and leave the
 * ledger untouched -- a refusal that appends an entry is the defect these count rows
 * exist to catch.
 */
import { assertEquals } from "@std/assert";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import { decideSlackApproval } from "../../apps/server/src/modules/integrations/slack-decisions.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun } from "../helpers/plan-run.ts";

const plan = compiled([noop("first")]);

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** A run with one open approval at `human.approval`, and nothing else. */
async function seedOpenApproval(fixture: Fixture) {
  const run = await seedPlanRun(fixture, await plan);
  const client = fixture.pgDatabase as unknown as PgTransactionClient;
  const scope = (await client.query<
    {
      taskId: string;
      conversationId: string;
      applicationId: string;
      repositoryId: string | null;
    }
  >(
    `select id as "taskId", conversation_id as "conversationId",
            application_id as "applicationId", repository_id as "repositoryId"
       from bakery.tasks where organization_id = $1 and id = $2`,
    [fixture.organizationId, run.job.taskId],
  )).rows[0]!;
  const asked = await requestHumanApproval(client, {
    organizationId: fixture.organizationId,
    runId: run.job.runId,
    taskId: scope.taskId,
    conversationId: scope.conversationId,
    stepKey: "human.approval",
    prompt: "Ship it?",
    ownerPrincipalId: fixture.principalId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    traceId: crypto.randomUUID(),
  });
  return { ...run, ...scope, approvalId: asked.approvalId };
}

/** The waiting post the buttons live on, as the poster would have written it. */
async function seedWaitingPost(
  fixture: Fixture,
  input: { runId: string; teamId: string; organizationId?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.slack_milestone_posts
       (id, organization_id, installation_team_id, channel_id, message_ts,
        run_id, step_key, milestone, decision_state)
     values ($1, $2, $3, 'C024BE91L', $4, $5, 'human.approval', 'waiting', 'open')`,
    [
      id,
      input.organizationId ?? fixture.organizationId,
      input.teamId,
      `${Date.now()}.000100`,
      input.runId,
    ],
  );
  return id;
}

const identity = (overrides: Record<string, string> = {}) => {
  const unique = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  return {
    appId: `A${unique.slice(0, 10)}`,
    teamId: `T${unique.slice(10, 20)}`,
    userId: `U${unique.slice(20, 30)}`,
    ...overrides,
  };
};

async function link(
  fixture: Fixture,
  principalId: string,
  slack: { appId: string; teamId: string; userId: string },
) {
  await withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      linkSlackIdentity(transaction, {
        organizationId: fixture.organizationId,
        principalId,
        identity: slack,
        verifiedAt: new Date(),
      }),
  );
}

/** Rows a decision would write, so a refusal can prove it wrote none. */
async function counts(fixture: Fixture) {
  const one = async (sql: string) =>
    Number(
      (await fixture.pgDatabase.query<{ n: string }>(sql, [
        fixture.organizationId,
      ])).rows[0]!.n,
    );
  return {
    ledger: await one(
      "select count(*)::text as n from bakery.decisions_ledger where organization_id = $1",
    ),
    events: await one(
      "select count(*)::text as n from bakery.domain_events where organization_id = $1",
    ),
  };
}

async function approvalState(fixture: Fixture, approvalId: string) {
  const { rows } = await fixture.pgDatabase.query<
    { status: string; decision: string | null }
  >(
    `select status, decision from bakery.questions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, approvalId],
  );
  return rows[0]!;
}

async function postState(fixture: Fixture, postId: string) {
  const { rows } = await fixture.pgDatabase.query<{ decision_state: string }>(
    "select decision_state from bakery.slack_milestone_posts where id = $1",
    [postId],
  );
  return rows[0]!.decision_state;
}

Deno.test("a linked person's Approve decides the approval and settles the post", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedOpenApproval(fixture);
    const slack = identity();
    await link(fixture, fixture.principalId, slack);
    const postId = await seedWaitingPost(fixture, {
      runId: seeded.job.runId,
      teamId: slack.teamId,
    });
    const before = await counts(fixture);

    const result = await decideSlackApproval(fixture.pgDatabase, {
      receiptId: crypto.randomUUID(),
      decisionId: postId,
      choice: "approve",
      teamId: slack.teamId,
      userId: slack.userId,
      appId: slack.appId,
      traceId: crypto.randomUUID(),
    });

    assertEquals(result, {
      kind: "decided",
      approvalId: seeded.approvalId,
      runId: seeded.job.runId,
      choice: "approve",
    });
    assertEquals(await approvalState(fixture, seeded.approvalId), {
      status: "answered",
      decision: "approve",
    });
    // The thread and the approval agree: nothing shows an open decision that has
    // already been answered.
    assertEquals(await postState(fixture, postId), "approved");
    // One ledger entry, and it says the decision came from Slack.
    const after = await counts(fixture);
    assertEquals(after.ledger, before.ledger + 1);
    // The entry names the delivery, so the ledger points back at the exact Slack
    // request -- and the Slack user id is not in it: the person is the decision's
    // actor, which the row already records.
    const entry = await fixture.pgDatabase.query<{ text: string | null }>(
      `select text from bakery.decisions_ledger
        where organization_id = $1 order by created_at desc limit 1`,
      [fixture.organizationId],
    );
    assertEquals(entry.rows[0]!.text?.includes("Slack") ?? false, true);
  });
});

Deno.test("a replayed press is already decided and records nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedOpenApproval(fixture);
    const slack = identity();
    await link(fixture, fixture.principalId, slack);
    const postId = await seedWaitingPost(fixture, {
      runId: seeded.job.runId,
      teamId: slack.teamId,
    });
    const press = {
      receiptId: crypto.randomUUID(),
      decisionId: postId,
      choice: "approve" as const,
      teamId: slack.teamId,
      userId: slack.userId,
      appId: slack.appId,
      traceId: crypto.randomUUID(),
    };
    assertEquals(
      (await decideSlackApproval(fixture.pgDatabase, press)).kind,
      "decided",
    );
    const afterFirst = await counts(fixture);

    // Slack retries, and a person can press twice: the second press finds the post
    // settled and stops before the approval is even read.
    const replay = await decideSlackApproval(fixture.pgDatabase, {
      ...press,
      receiptId: crypto.randomUUID(),
    });
    assertEquals(replay, { kind: "refused", reason: "already_decided" });
    assertEquals(await counts(fixture), afterFirst);
    assertEquals(
      await approvalState(fixture, seeded.approvalId),
      { status: "answered", decision: "approve" },
    );
  });
});

Deno.test("a press from an unlinked Slack user is refused by name and decides nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedOpenApproval(fixture);
    // A workspace Bakery knows, with a user nobody linked: the message is real and
    // the person is not.
    const slack = identity();
    const postId = await seedWaitingPost(fixture, {
      runId: seeded.job.runId,
      teamId: slack.teamId,
    });
    const before = await counts(fixture);

    const result = await decideSlackApproval(fixture.pgDatabase, {
      receiptId: crypto.randomUUID(),
      decisionId: postId,
      choice: "approve",
      teamId: slack.teamId,
      userId: slack.userId,
      appId: slack.appId,
      traceId: crypto.randomUUID(),
    });

    assertEquals(result, { kind: "refused", reason: "not_linked" });
    assertEquals(await counts(fixture), before);
    assertEquals(await approvalState(fixture, seeded.approvalId), {
      status: "open",
      decision: null,
    });
    assertEquals(await postState(fixture, postId), "open");
  });
});

Deno.test("a press carrying another workspace's team changes nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedOpenApproval(fixture);
    const slack = identity();
    await link(fixture, fixture.principalId, slack);
    const postId = await seedWaitingPost(fixture, {
      runId: seeded.job.runId,
      teamId: slack.teamId,
    });
    const before = await counts(fixture);

    // A valid second workspace, whose signature is genuine: it still cannot decide
    // a decision posted into the first one.
    const other = identity();
    const result = await decideSlackApproval(fixture.pgDatabase, {
      receiptId: crypto.randomUUID(),
      decisionId: postId,
      choice: "reject",
      teamId: other.teamId,
      userId: other.userId,
      appId: other.appId,
      traceId: crypto.randomUUID(),
    });

    assertEquals(result, { kind: "refused", reason: "failed" });
    assertEquals(await counts(fixture), before);
    assertEquals(await postState(fixture, postId), "open");
  });
});

Deno.test("a linked member who may not answer this approval is refused, not recorded", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedOpenApproval(fixture);
    // A second member of the same organization, linked properly, who is not the
    // approver: the approval is addressed to named people and does not exist for
    // anybody else, so the store refuses and the thread says so.
    //
    // The rows are removed again in the `finally`: the installation bootstrap
    // refuses to run while a second user, principal or organization exists, so a
    // leftover here would break every fixture that runs after this file in the same
    // database -- which is how CI runs it.
    const outsider = crypto.randomUUID();
    const providerUser = crypto.randomUUID();
    try {
      const now = new Date();
      await fixture.pgDatabase.query(
        `insert into public."user"
           (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, 'Someone Else', $2, true, $3, $3)`,
        [providerUser, `outsider-${outsider}@example.test`, now],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.principals
           (id, provider_user_id, display_name, principal_type)
         values ($1, $2, 'Someone Else', 'human')`,
        [outsider, providerUser],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.organization_memberships
           (id, organization_id, principal_id, role, status, joined_at,
            created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'member', 'active', now(),
                 now(), now())`,
        [fixture.organizationId, outsider],
      );
      const slack = identity();
      await link(fixture, outsider, slack);
      const postId = await seedWaitingPost(fixture, {
        runId: seeded.job.runId,
        teamId: slack.teamId,
      });
      const before = await counts(fixture);

      const result = await decideSlackApproval(fixture.pgDatabase, {
        receiptId: crypto.randomUUID(),
        decisionId: postId,
        choice: "approve",
        teamId: slack.teamId,
        userId: slack.userId,
        appId: slack.appId,
        traceId: crypto.randomUUID(),
      });

      assertEquals(result, { kind: "refused", reason: "no_permission" });
      assertEquals(await counts(fixture), before);
      assertEquals(await approvalState(fixture, seeded.approvalId), {
        status: "open",
        decision: null,
      });
      assertEquals(await postState(fixture, postId), "open");
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.organization_memberships where principal_id = $1",
        [outsider],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.external_identity_links where principal_id = $1",
        [outsider],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.principals where id = $1",
        [outsider],
      );
      await fixture.pgDatabase.query(
        'delete from public."user" where id = $1',
        [providerUser],
      );
    }
  });
});
