import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  advanceDeployment,
  createDeployment,
  listDeployments,
  rollbackDeployment,
} from "../../apps/server/src/modules/delivery/deployments.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

// #63. The release page reads one run's releases and the commit each one
// replaced. Both come from the deployments store; this runs them on a real
// database without onboarding a repository.

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SECRET = "deployments-cursor-secret-for-tests";
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const DIGEST = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

Deno.test("deployments.list narrows to one run, names the commit each release replaced and flags a failed rollback (#63)", () =>
  withWorkerFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const organizationId = fixture.organizationId;
    const principal = fixture.principalId;
    const job = await seedFundedModelJob(database, organizationId, principal);
    const repositoryId = (await database.query<{ id: string }>(
      `select repository_id as id from bakery.workflow_runs where id = $1`,
      [job.runId],
    )).rows[0].id;
    const run = <T>(
      fn: (transaction: Parameters<typeof createDeployment>[0]) => Promise<T>,
    ) => withPgTransaction(database, fn);
    let number = 300;
    const merge = async (commit: number) => {
      await database.query(
        `insert into bakery.pull_requests (
           id,organization_id,task_id,repository_id,provider_number,url,head_sha,
           base_sha,status,merged_sha,run_id,version
         ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
        [
          organizationId,
          job.taskId,
          repositoryId,
          ++number,
          `https://github.com/acme/widgets/pull/${number}`,
          SHA(commit + 1000),
          SHA(1),
          SHA(commit),
          job.runId,
        ],
      );
      return SHA(commit);
    };
    const release = (commitSha: string) =>
      run((transaction) =>
        createDeployment(transaction, organizationId, principal, {
          requestId: `request-${crypto.randomUUID()}`,
          traceId: TRACE,
          create: {
            repositoryId,
            runId: job.runId,
            environment: "staging",
            commitSha,
            artifactDigest: DIGEST(Number.parseInt(commitSha.slice(-8), 16)),
          },
        })
      );
    const settle = async (id: string) => {
      let current = await run((transaction) =>
        advanceDeployment(transaction, organizationId, id, {
          from: "queued",
          to: "deploying",
          expectedVersion: 1,
        })
      );
      current = await run((transaction) =>
        advanceDeployment(transaction, organizationId, id, {
          from: "deploying",
          to: "verifying",
          expectedVersion: current.version,
        })
      );
      return await run((transaction) =>
        advanceDeployment(transaction, organizationId, id, {
          from: "verifying",
          to: "healthy",
          expectedVersion: current.version,
        })
      );
    };
    const list = (query: Parameters<typeof listDeployments>[4]) =>
      run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, query)
      );

    const one = await release(await merge(1));
    assertEquals(one.previousCommitSha, null, "it replaced nothing");
    await settle(one.id);
    const two = await release(await merge(2));
    assertEquals(two.previousDeploymentId, one.id);
    assertEquals(
      two.previousCommitSha,
      one.commitSha,
      "the release before it is named by its commit",
    );

    const ofRun = await list({ runId: job.runId });
    assertEquals(ofRun.items.map((item) => item.id), [two.id, one.id]);
    assertEquals(ofRun.items[0]?.previousCommitSha, one.commitSha);
    assertEquals(
      (await list({ runId: crypto.randomUUID() })).items,
      [],
      "another run has no releases here",
    );

    const paged = await list({ runId: job.runId, limit: 1 });
    assert(paged.nextCursor !== null);
    assertEquals(
      (await list({ runId: job.runId, limit: 1, cursor: paged.nextCursor }))
        .items.map((item) => item.id),
      [one.id],
    );
    await assertRejects(
      () =>
        list({
          runId: crypto.randomUUID(),
          limit: 1,
          cursor: paged.nextCursor ?? undefined,
        }),
      StandardError,
      undefined,
      "a cursor from one run's list is refused for another's",
    );

    // A rollback that ends in failed is told apart from a deploy that failed.
    assertEquals(two.rollbackFailed, false);
    await settle(two.id);
    const rolling = await run((transaction) =>
      rollbackDeployment(transaction, organizationId, principal, two.id, {
        requestId: `request-${crypto.randomUUID()}`,
        traceId: TRACE,
        reason: "the release is unhealthy",
      })
    );
    assertEquals(rolling.status, "rolling_back");
    assertEquals(rolling.rollbackFailed, false, "not failed yet");
    const failed = await run((transaction) =>
      advanceDeployment(transaction, organizationId, two.id, {
        from: "rolling_back",
        to: "failed",
        expectedVersion: rolling.version,
      })
    );
    assertEquals(failed.status, "failed");
    assertEquals(failed.rollbackFailed, true);
    const after = await list({ runId: job.runId });
    assertEquals(
      after.items.map((item) => [item.id, item.rollbackFailed]),
      [[two.id, true], [one.id, false]],
    );

    await database.query(
      `delete from bakery.deployments where organization_id = $1`,
      [organizationId],
    );
    await database.query(
      `delete from bakery.pull_requests where organization_id = $1 and run_id = $2`,
      [organizationId, job.runId],
    );
  }));
