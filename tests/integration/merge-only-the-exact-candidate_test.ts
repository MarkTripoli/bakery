import { assert, assertEquals } from "@std/assert";
import {
  lockMergeTarget,
  recordMergeAttempt,
  settleMergeAttempt,
  unknownMergeAttempts,
} from "../../apps/server/src/modules/delivery/merge-attempts.ts";
import { withPgTransaction } from "@bakery/persistence/postgres";
import type { PgTransactionClient } from "@bakery/persistence";
import { openAuthFixture } from "../helpers/auth.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "2222222222222222222222222222222222222222";
const MERGED = "3333333333333333333333333333333333333333";
const BRANCH = "main";

type MergeFixture = Awaited<ReturnType<typeof openMergeFixture>>;

/**
 * A repository and one pull request to merge, with a principal to attribute
 * the attempt to. Everything else the merge store needs already exists.
 */
async function openMergeFixture() {
  const fixture = await openAuthFixture();
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const pullRequestId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  try {
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,null,'Merge Developer','service')`,
      [principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (id,name,slug,metadata,created_at,updated_at)
       values ($1,'Merge Org',$2,'{}'::jsonb,$3,$3)`,
      [organizationId, `merge-${organizationId}`, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id,organization_id,principal_id,role,status,joined_at,created_at,
         updated_at,version
       ) values ($1,$2,$3,'developer','active',$4,$4,$4,1)`,
      [crypto.randomUUID(), organizationId, principalId, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id,organization_id,slug,name)
       values ($1,$2,'merge-app','Merge Application')`,
      [applicationId, organizationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch, version
       ) values ($1,$2,$3,$4,'77','acme','widgets','main',1)`,
      [repositoryId, organizationId, applicationId, crypto.randomUUID()],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversations (
         id,organization_id,application_id,title,created_by
       ) values ($1,$2,$3,'Merge Conversation',$4)`,
      [conversationId, organizationId, applicationId, principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.tasks (
         id,organization_id,application_id,conversation_id,title,task_type,
         status,priority,created_by
       ) values ($1,$2,$3,$4,'Merge Task','feature','active',50,$5)`,
      [
        taskId,
        organizationId,
        applicationId,
        conversationId,
        principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.pull_requests (
         id,organization_id,task_id,repository_id,provider_number,url,head_sha,
         base_sha,status,version
       ) values ($1,$2,$3,$4,12,'https://github.com/acme/widgets/pull/12',
         $5,$6,'open',1)`,
      [pullRequestId, organizationId, taskId, repositoryId, HEAD, BASE],
    );
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return { fixture, organizationId, principalId, repositoryId, pullRequestId };
}

function targetOf(scope: {
  organizationId: string;
  principalId: string;
  repositoryId: string;
  pullRequestId: string;
}) {
  return {
    organizationId: scope.organizationId,
    pullRequestId: scope.pullRequestId,
    repositoryId: scope.repositoryId,
    providerNumber: 12,
    baseBranch: BRANCH,
    expectedHeadSha: HEAD,
    expectedBaseSha: BASE,
    mergeMethod: "squash" as const,
    requestedById: scope.principalId,
    requestId: `request-${crypto.randomUUID()}`,
    traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  };
}

async function cleanup(merge: MergeFixture): Promise<void> {
  const { fixture, organizationId, principalId } = merge;
  try {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id=$1",
      [organizationId],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.principals where id=$1",
      [principalId],
    );
  } finally {
    await fixture.close();
  }
}

/** Runs one transaction against the fixture's database. */
async function inTransaction<T>(
  fixture: MergeFixture["fixture"],
  work: (client: PgTransactionClient) => Promise<T>,
): Promise<T> {
  return await withPgTransaction(fixture.pgDatabase, work);
}

Deno.test("an unknown merge attempt is recorded and settled by a read", async () => {
  const merge = await openMergeFixture();
  try {
    const { fixture, organizationId } = merge;
    const recorded = await inTransaction(
      fixture,
      (client) =>
        recordMergeAttempt(client, targetOf(merge), { kind: "unknown" }),
    );
    assertEquals(recorded.state, "unknown");
    assertEquals(recorded.mergedSha, null);
    assertEquals(recorded.settledAt, null);
    assertEquals(recorded.expectedHeadSha, HEAD);

    // The reconciliation resolves it from a live provider read.
    const settled = await inTransaction(
      fixture,
      (client) =>
        settleMergeAttempt(client, {
          organizationId,
          attemptId: recorded.id,
          outcome: { kind: "merged", mergedSha: MERGED },
        }),
    );
    assertEquals(settled.state, "merged");
    assertEquals(settled.mergedSha, MERGED);
    assert(settled.settledAt !== null);

    // Settling again changes nothing and answers with the row as it is.
    const again = await inTransaction(
      fixture,
      (client) =>
        settleMergeAttempt(client, {
          organizationId,
          attemptId: recorded.id,
          outcome: { kind: "refused", status: 409 },
        }),
    );
    assertEquals(again.state, "merged");
    assertEquals(again.mergedSha, MERGED);
    assertEquals(again.providerStatus, null);
    assertEquals(
      (await inTransaction(
        fixture,
        (client) =>
          unknownMergeAttempts(client, organizationId, merge.pullRequestId),
      )).length,
      0,
    );
  } finally {
    await cleanup(merge);
  }
});

Deno.test("a refused attempt records GitHub's status and settles immediately", async () => {
  const merge = await openMergeFixture();
  try {
    const { fixture } = merge;
    const recorded = await inTransaction(
      fixture,
      (client) =>
        recordMergeAttempt(client, targetOf(merge), {
          kind: "refused",
          status: 409,
        }),
    );
    assertEquals(recorded.state, "refused");
    assertEquals(recorded.providerStatus, 409);
    assertEquals(recorded.mergedSha, null);
    // A refusal is an answer, so it needs no reconciliation.
    assert(recorded.settledAt !== null);
    assertEquals(
      (await inTransaction(
        fixture,
        (client) =>
          unknownMergeAttempts(
            client,
            merge.organizationId,
            merge.pullRequestId,
          ),
      )).length,
      0,
    );
  } finally {
    await cleanup(merge);
  }
});

Deno.test("two merges of one repository and branch serialize on the lock", async () => {
  const merge = await openMergeFixture();
  const second = await merge.fixture.pgDatabase.connect();
  let open = false;
  try {
    const { fixture, organizationId, repositoryId } = merge;
    const order: string[] = [];
    // The first holds the target lock for the length of its transaction.
    const first = await fixture.pgDatabase.connect();
    try {
      await first.query("begin");
      await lockMergeTarget(
        first as unknown as PgTransactionClient,
        { organizationId, repositoryId, baseBranch: BRANCH },
      );
      order.push("first-locked");

      await second.query("begin");
      open = true;
      const secondLock = lockMergeTarget(
        second as unknown as PgTransactionClient,
        { organizationId, repositoryId, baseBranch: BRANCH },
      ).then(() => order.push("second-locked"));
      // The second must still be waiting while the first holds the lock.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assertEquals(order, ["first-locked"]);

      await first.query("commit");
      await secondLock;
      order.push("first-committed");
      assertEquals(order, ["first-locked", "second-locked", "first-committed"]);
      await second.query("commit");
      open = false;

      // A different branch is a different target and never waits.
      await first.query("begin");
      await lockMergeTarget(
        first as unknown as PgTransactionClient,
        { organizationId, repositoryId, baseBranch: BRANCH },
      );
      await second.query("begin");
      open = true;
      await lockMergeTarget(
        second as unknown as PgTransactionClient,
        { organizationId, repositoryId, baseBranch: "release" },
      );
      await second.query("commit");
      open = false;
      await first.query("commit");
    } finally {
      first.release();
    }
  } finally {
    if (open) await second.query("rollback");
    second.release();
    await cleanup(merge);
  }
});
