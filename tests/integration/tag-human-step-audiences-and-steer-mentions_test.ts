import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  addMember as addSeedMember,
  type Fixture,
  request,
  type Seed,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import { addMember, type Member, seedRun } from "../helpers/run-requests.ts";

type RequestRow = {
  recipient_id: string;
  asked_by: string;
  asked_by_kind: string;
  intent: string;
  step_key: string | null;
  target_id: string | null;
  fallback_for_name: string | null;
  audience_group_id: string | null;
  audience_role_key: string | null;
};

async function requestsOn(
  db: SocketFixture["pgDatabase"],
  organizationId: string,
  runId: string,
): Promise<RequestRow[]> {
  return (await db.query<RequestRow>(
    `select recipient_id, asked_by, asked_by_kind, intent, step_key, target_id,
            fallback_for_name, audience_group_id, audience_role_key
       from bakery.person_requests
      where organization_id = $1 and run_id = $2
      order by recipient_id`,
    [organizationId, runId],
  )).rows;
}

async function withApprovalFixture(
  work: (
    context: {
      fixture: SocketFixture;
      guest: Member;
      viewer: Member;
      runId: string;
      taskId: string;
      ask: (
        audience: readonly string[] | undefined,
        owner: string | null,
        stepIteration?: number,
      ) => Promise<
        { approvalId: string; approverPrincipalIds: readonly string[] }
      >;
    },
  ) => Promise<void>,
): Promise<void> {
  const fixture = await openSocketFixture();
  const guest = await addMember(fixture, "Guest", "guest");
  const viewer = await addMember(fixture, "Viewer", "viewer");
  try {
    const run = await seedRun(fixture);
    await work({
      fixture,
      guest,
      viewer,
      runId: run.runId,
      taskId: run.taskId,
      ask: (audience, owner, stepIteration) =>
        withPgTransaction(
          fixture.pgDatabase,
          (transaction) =>
            requestHumanApproval(transaction, {
              organizationId: fixture.organizationId,
              runId: run.runId,
              taskId: run.taskId,
              conversationId: fixture.conversationId,
              stepKey: "sign-off",
              prompt: "Ship it?",
              ...(audience === undefined ? {} : { audience }),
              ownerPrincipalId: owner,
              traceId: crypto.randomUUID(),
              applicationId: fixture.applicationId,
              repositoryId: null,
              ...(stepIteration === undefined ? {} : { stepIteration }),
            }),
        ),
    });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      fixture.email,
      guest.email,
      viewer.email,
    ]);
    await fixture.close();
  }
}

async function seedGroup(
  fixture: SocketFixture,
  mentionName: string,
  members: readonly string[],
): Promise<string> {
  const groupId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.organization_groups
       (id, organization_id, name, mention_name)
     values ($1, $2, $3, $3)`,
    [groupId, fixture.organizationId, mentionName],
  );
  for (const principalId of members) {
    await fixture.pgDatabase.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id)
       values ($1, $2, $3)`,
      [fixture.organizationId, groupId, principalId],
    );
  }
  return groupId;
}

Deno.test("a human step whose audience is a group asks each member with an approve request", () =>
  withApprovalFixture(async ({ fixture, guest, viewer, runId, ask }) => {
    const handle = `reviewers-${crypto.randomUUID().slice(0, 8)}`;
    const groupId = await seedGroup(fixture, handle, [
      guest.principalId,
      viewer.principalId,
    ]);
    const asked = await ask([`@${handle}`], fixture.principalId);
    assertEquals(
      [...asked.approverPrincipalIds].sort(),
      [guest.principalId, viewer.principalId].sort(),
    );
    const rows = await requestsOn(
      fixture.pgDatabase,
      fixture.organizationId,
      runId,
    );
    assertEquals(
      rows.map((row) => row.recipient_id),
      [guest.principalId, viewer.principalId].sort(),
    );
    for (const row of rows) {
      assertEquals(row.intent, "approve");
      assertEquals(row.asked_by_kind, "workflow");
      assertEquals(row.asked_by, fixture.principalId);
      assertEquals(row.step_key, "sign-off");
      assertEquals(row.target_id, asked.approvalId);
      assertEquals(row.fallback_for_name, null);
      assertEquals(row.audience_group_id, groupId);
    }
    const grants = await fixture.pgDatabase.query<{ principal_id: string }>(
      `select principal_id from bakery.run_power_grants
        where organization_id = $1 and question_id = $2 and power = 'approve'
          and revoked_at is null
        order by principal_id`,
      [fixture.organizationId, asked.approvalId],
    );
    assertEquals(
      grants.rows.map((row) => row.principal_id),
      [guest.principalId, viewer.principalId].sort(),
    );
  }));

Deno.test("a human step whose audience is a role asks the role's members", () =>
  withApprovalFixture(async ({ fixture, runId, ask }) => {
    const asked = await ask(["@admins"], null);
    assert(asked.approverPrincipalIds.includes(fixture.principalId));
    const rows = await requestsOn(
      fixture.pgDatabase,
      fixture.organizationId,
      runId,
    );
    assertEquals(rows.length, asked.approverPrincipalIds.length);
    assert(rows.every((row) => row.audience_role_key === "admin"));
  }));

Deno.test("an audience that resolves to nobody falls back to the workflow owner with the name", () =>
  withApprovalFixture(async ({ fixture, guest, runId, ask }) => {
    const handle = `empty-${crypto.randomUUID().slice(0, 8)}`;
    await seedGroup(fixture, handle, []);
    const asked = await ask(
      [`@${handle}`, "@nobody-by-that-name"],
      guest.principalId,
    );
    assertEquals(asked.approverPrincipalIds, [guest.principalId]);
    const rows = await requestsOn(
      fixture.pgDatabase,
      fixture.organizationId,
      runId,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.recipient_id, guest.principalId);
    assertEquals(rows[0]!.intent, "approve");
    assertEquals(rows[0]!.target_id, asked.approvalId);
    assertEquals(
      rows[0]!.fallback_for_name,
      `${handle}, @nobody-by-that-name`,
    );
    const question = await fixture.pgDatabase.query<{
      audience: { principalIds: string[] };
    }>(
      `select audience from bakery.questions where id = $1`,
      [asked.approvalId],
    );
    assertEquals(question.rows[0]!.audience.principalIds, [guest.principalId]);
  }));

Deno.test("a human step with no audience asks the owner and makes no request", () =>
  withApprovalFixture(async ({ fixture, guest, runId, ask }) => {
    const asked = await ask(undefined, guest.principalId);
    assertEquals(asked.approverPrincipalIds, [guest.principalId]);
    assertEquals(
      (await requestsOn(fixture.pgDatabase, fixture.organizationId, runId))
        .length,
      0,
    );
  }));

async function withSteerFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

async function customRoleMember(
  fixture: Fixture,
  seed: Seed,
  label: string,
  permissions: readonly string[],
) {
  const member = await addSeedMember(fixture, seed, label, "guest");
  const roleId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.organization_roles
       (id, organization_id, key, name, permissions, created_by_principal_id)
     values ($1, $2, $3, $3, $4, $5)`,
    [roleId, seed.organizationId, label, permissions, seed.principalId],
  );
  await fixture.pgDatabase.query(
    `update bakery.organization_memberships set custom_role_id = $3
      where organization_id = $1 and principal_id = $2`,
    [seed.organizationId, member.principalId, roleId],
  );
  return { ...member, organizationId: seed.organizationId };
}

const STEER_ONLY = [
  "session:read",
  "session:control",
  "run:read",
  "task:read",
];

Deno.test("a steer that mentions a person asks them with an FYI request on the step", () =>
  withSteerFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-mention");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const tagged = await addSeedMember(fixture, seed, "Tagged", "guest");
    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      {
        method: "POST",
        body: {
          body: "Have a look at this.",
          mode: "steer",
          mentions: [tagged.principalId, seed.principalId],
        },
      },
    );
    assertEquals(response.status, 201);
    const rows = await requestsOn(
      fixture.pgDatabase,
      seed.organizationId,
      ids.runId,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.recipient_id, tagged.principalId);
    assertEquals(rows[0]!.intent, "fyi");
    assertEquals(rows[0]!.asked_by, seed.principalId);
    assertEquals(rows[0]!.asked_by_kind, "person");
    assertEquals(rows[0]!.step_key, "implement");
    const grant = await fixture.pgDatabase.query(
      `select 1 from bakery.run_access_grants
        where organization_id = $1 and run_id = $2 and principal_id = $3`,
      [seed.organizationId, ids.runId, tagged.principalId],
    );
    assertEquals(grant.rows.length, 1);
  }));

Deno.test("security: a steerer without request permission cannot bring anyone in by a mention", () =>
  withSteerFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-mention-deny");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const tagged = await addSeedMember(fixture, seed, "Outsider", "guest");
    const steerOnly = await customRoleMember(
      fixture,
      seed,
      `steer-only-${crypto.randomUUID().slice(0, 8)}`,
      STEER_ONLY,
    );
    const path = `/v1/sessions/${ids.agentSessionId}/messages`;
    const refused = await request(fixture, steerOnly, path, {
      method: "POST",
      body: {
        body: "Bring them in.",
        mode: "steer",
        mentions: [tagged.principalId],
      },
    });
    assertEquals(refused.status, 403);
    const written = await fixture.pgDatabase.query(
      `select 1 from bakery.messages
        where organization_id = $1 and author_id = $2`,
      [seed.organizationId, steerOnly.principalId],
    );
    assertEquals(written.rows.length, 0);
    assertEquals(
      (await requestsOn(fixture.pgDatabase, seed.organizationId, ids.runId))
        .length,
      0,
    );
    const grant = await fixture.pgDatabase.query(
      `select 1 from bakery.run_access_grants
        where organization_id = $1 and principal_id = $2`,
      [seed.organizationId, tagged.principalId],
    );
    assertEquals(grant.rows.length, 0);

    const plain = await request(fixture, steerOnly, path, {
      method: "POST",
      body: { body: "Just steering.", mode: "steer" },
    });
    assertEquals(plain.status, 201);

    const asker = await customRoleMember(
      fixture,
      seed,
      `steer-ask-${crypto.randomUUID().slice(0, 8)}`,
      [...STEER_ONLY, "runRequest:write"],
    );
    const allowed = await request(fixture, asker, path, {
      method: "POST",
      body: {
        body: "Now bring them in.",
        mode: "steer",
        mentions: [tagged.principalId],
      },
    });
    assertEquals(allowed.status, 201);
    const rows = await requestsOn(
      fixture.pgDatabase,
      seed.organizationId,
      ids.runId,
    );
    assertEquals(rows.map((row) => row.asked_by), [asker.principalId]);
  }));

Deno.test("an approval whose starter is gone still asks each approver, on behalf of a live admin", () =>
  withApprovalFixture(async ({ fixture, guest, runId, ask }) => {
    const gone = await addMember(fixture, "Gone starter", "developer");
    try {
      await fixture.pgDatabase.query(
        `update bakery.principals set disabled_at = now() where id = $1`,
        [gone.principalId],
      );
      await fixture.pgDatabase.query(
        `update bakery.workflow_runs set requested_by = $2
          where organization_id = $1 and id = $3`,
        [fixture.organizationId, gone.principalId, runId],
      );
      const handle = `late-${crypto.randomUUID().slice(0, 8)}`;
      await seedGroup(fixture, handle, [guest.principalId]);
      const asked = await ask([`@${handle}`], null);
      assertEquals(asked.approverPrincipalIds, [guest.principalId]);
      const rows = await requestsOn(
        fixture.pgDatabase,
        fixture.organizationId,
        runId,
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0]!.recipient_id, guest.principalId);
      assertEquals(rows[0]!.intent, "approve");
      assertEquals(rows[0]!.asked_by_kind, "workflow");
      assertEquals(rows[0]!.asked_by, fixture.principalId);
      assertEquals(rows[0]!.target_id, asked.approvalId);
    } finally {
      await cleanupAuthFixture(fixture.pgDatabase, [gone.email]);
    }
  }));

Deno.test("an approval whose starter, owner and admins are all gone is refused by name and writes nothing", () =>
  withApprovalFixture(async ({ fixture, guest, runId, ask }) => {
    const gone = await addMember(fixture, "Gone starter", "developer");
    try {
      await fixture.pgDatabase.query(
        `update bakery.principals set disabled_at = now() where id = $1`,
        [gone.principalId],
      );
      await fixture.pgDatabase.query(
        `update bakery.workflow_runs set requested_by = $2
          where organization_id = $1 and id = $3`,
        [fixture.organizationId, gone.principalId, runId],
      );
      await fixture.pgDatabase.query(
        `update bakery.principals set disabled_at = now() where id = $1`,
        [fixture.principalId],
      );
      const handle = `late-${crypto.randomUUID().slice(0, 8)}`;
      await seedGroup(fixture, handle, [guest.principalId]);
      const error = await assertRejects(() =>
        ask([`@${handle}`], null)
      ) as StandardError;
      assertEquals(error.params?.reason, "approval-asker-unavailable");
      const questions = await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.questions
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, runId],
      );
      const requests = await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.person_requests
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, runId],
      );
      const waits = await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.run_waits
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, runId],
      );
      assertEquals(questions.rows.length, 0);
      assertEquals(requests.rows.length, 0);
      assertEquals(waits.rows.length, 0);
    } finally {
      await cleanupAuthFixture(fixture.pgDatabase, [gone.email]);
    }
  }));

Deno.test("an approval request carries the step's loop iteration", () =>
  withApprovalFixture(async ({ fixture, guest, runId, ask }) => {
    const handle = `loop-${crypto.randomUUID().slice(0, 8)}`;
    await seedGroup(fixture, handle, [guest.principalId]);
    await ask([`@${handle}`], fixture.principalId, 3);
    const rows = await fixture.pgDatabase.query<{ step_iteration: number }>(
      `select step_iteration from bakery.person_requests
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, runId],
    );
    assertEquals(rows.rows.map((row) => row.step_iteration), [3]);
  }));

async function steerGroup(
  fixture: Fixture,
  organizationId: string,
  mentionName: string,
  members: readonly string[],
): Promise<string> {
  const groupId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.organization_groups
       (id, organization_id, name, mention_name)
     values ($1, $2, $3, $3)`,
    [groupId, organizationId, mentionName],
  );
  for (const principalId of members) {
    await fixture.pgDatabase.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id)
       values ($1, $2, $3)`,
      [organizationId, groupId, principalId],
    );
  }
  return groupId;
}

Deno.test("a steer that mentions a group asks each member with an FYI request", () =>
  withSteerFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-group");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const first = await addSeedMember(fixture, seed, "First", "guest");
    const second = await addSeedMember(fixture, seed, "Second", "guest");
    const handle = `reviewers-${crypto.randomUUID().slice(0, 8)}`;
    const groupId = await steerGroup(fixture, seed.organizationId, handle, [
      first.principalId,
      second.principalId,
    ]);
    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      {
        method: "POST",
        body: {
          body: "Reviewers, have a look.",
          mode: "steer",
          mentionHandles: [`@${handle}`],
        },
      },
    );
    assertEquals(response.status, 201);
    const rows = await requestsOn(
      fixture.pgDatabase,
      seed.organizationId,
      ids.runId,
    );
    assertEquals(
      rows.map((row) => row.recipient_id),
      [first.principalId, second.principalId].sort(),
    );
    for (const row of rows) {
      assertEquals(row.intent, "fyi");
      assertEquals(row.audience_group_id, groupId);
      assertEquals(row.step_key, "implement");
    }
  }));

Deno.test("a steer mention of someone who cannot be found asks the workflow owner with the name", () =>
  withSteerFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-fallback");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const owner = await addSeedMember(fixture, seed, "Owner", "developer");
    const gone = await addSeedMember(fixture, seed, "Gone", "guest");
    await fixture.pgDatabase.query(
      `update bakery.principals set disabled_at = now() where id = $1`,
      [gone.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set owner_principal_id = $2
        where organization_id = $1 and id = $3`,
      [seed.organizationId, owner.principalId, ids.workflowId],
    );
    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      {
        method: "POST",
        body: {
          body: "Gone, have a look.",
          mode: "steer",
          mentions: [gone.principalId],
        },
      },
    );
    assertEquals(response.status, 201);
    const rows = await requestsOn(
      fixture.pgDatabase,
      seed.organizationId,
      ids.runId,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.recipient_id, owner.principalId);
    assertEquals(rows[0]!.fallback_for_name, "Gone");
    assertEquals(rows[0]!.intent, "fyi");
  }));

Deno.test("a steerer without request permission can still mention someone who already sees the run", () =>
  withSteerFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-mention-reader");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const reader = await addSeedMember(fixture, seed, "Reader", "developer");
    const steerOnly = await customRoleMember(
      fixture,
      seed,
      `steer-only-${crypto.randomUUID().slice(0, 8)}`,
      STEER_ONLY,
    );
    const response = await request(
      fixture,
      steerOnly,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      {
        method: "POST",
        body: {
          body: "Reader, see this.",
          mode: "steer",
          mentions: [reader.principalId],
        },
      },
    );
    assertEquals(response.status, 201);
    const rows = await requestsOn(
      fixture.pgDatabase,
      seed.organizationId,
      ids.runId,
    );
    assertEquals(rows.map((row) => row.recipient_id), [reader.principalId]);
    assertEquals(rows[0]!.asked_by, steerOnly.principalId);
    assertEquals(rows[0]!.intent, "fyi");
  }));
