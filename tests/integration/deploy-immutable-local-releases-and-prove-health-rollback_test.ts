import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  advanceDeployment,
  createDeployment,
  type DeploymentCreateInput,
  listDeployments,
  readDeployment,
  rollbackDeployment,
} from "../../apps/server/src/modules/delivery/deployments.ts";
import { createDeploymentDriver } from "../../apps/server/src/modules/delivery/deployment-driver.ts";
import { createLocalReleaseTarget } from "../../apps/server/src/modules/delivery/local-release-target.ts";
import { createPostgresDeploymentLedger } from "../../apps/server/src/modules/delivery/postgres-deployment-ledger.ts";
import type { ReleaseAdapter } from "../../apps/server/src/modules/delivery/release-adapter.ts";
import { withReviewedRun } from "../helpers/review-repair/loop-world.ts";

/**
 * Deployment records over real rows (#43, B10.06): only a merged revision is
 * deployed, an environment has one deployment in flight, an unknown outcome
 * blocks further writes, and a rollback restores the release that was replaced.
 */

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SECRET = "deployments-cursor-secret-for-tests";
const DIGEST = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const SHA = (n: number) => n.toString(16).padStart(40, "0");

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (caught) => caught);
  assert(error instanceof StandardError, "expected a StandardError");
  return (error.params as { reason?: string } | undefined)?.reason;
}

Deno.test("a deployment is queued only for a merged revision, once per environment, and an unknown outcome blocks the next (#43)", async () => {
  await withReviewedRun(async (world) => {
    const database = world.fixture.pgDatabase;
    const organizationId = world.repository.organizationId;
    const repositoryId = world.repository.repositoryId;
    try {
      const principal = (await database.query<{ id: string }>(
        `select principal_id as id from bakery.organization_memberships
        where organization_id = $1 and status = 'active'
        order by created_at limit 1`,
        [organizationId],
      )).rows[0].id;
      let number = 200;
      const merge = async (commit: number) => {
        await database.query(
          `insert into bakery.pull_requests (
           id,organization_id,task_id,repository_id,provider_number,url,head_sha,
           base_sha,status,merged_sha,run_id,version
         ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
          [
            organizationId,
            world.taskId,
            repositoryId,
            ++number,
            `https://github.com/acme/widgets/pull/${number}`,
            SHA(commit + 1000),
            SHA(1),
            SHA(commit),
            world.runId,
          ],
        );
        return SHA(commit);
      };
      const request = (
        commitSha: string,
        overrides: Partial<DeploymentCreateInput> = {},
      ): DeploymentCreateInput => ({
        repositoryId,
        runId: world.runId,
        environment: "staging",
        commitSha,
        artifactDigest: DIGEST(Number.parseInt(commitSha.slice(-8), 16)),
        ...overrides,
      });
      const run = <T>(
        fn: (transaction: Parameters<typeof createDeployment>[0]) => Promise<T>,
      ) => withPgTransaction(database, fn);
      const create = (input: DeploymentCreateInput) =>
        run((transaction) =>
          createDeployment(transaction, organizationId, principal, {
            requestId: `request-${crypto.randomUUID()}`,
            traceId: TRACE,
            create: input,
          })
        );
      const rollback = (id: string, why = "the release is unhealthy") =>
        run((transaction) =>
          rollbackDeployment(transaction, organizationId, principal, id, {
            requestId: `request-${crypto.randomUUID()}`,
            traceId: TRACE,
            reason: why,
          })
        );
      const advance = (
        id: string,
        from: Parameters<typeof advanceDeployment>[3]["from"],
        to: Parameters<typeof advanceDeployment>[3]["to"],
        expectedVersion: number,
      ) =>
        run((transaction) =>
          advanceDeployment(transaction, organizationId, id, {
            from,
            to,
            expectedVersion,
          })
        );
      /** Drives a queued deployment to a settled status through the allowed moves. */
      const settle = async (
        id: string,
        last: "healthy" | "degraded" | "failed",
      ) => {
        let current = await advance(id, "queued", "deploying", 1);
        current = await advance(id, "deploying", "verifying", current.version);
        return await advance(id, "verifying", last, current.version);
      };

      // Only a merged revision of this run is deployed.
      const first = await merge(1);
      assertEquals(
        await reason(create(request(SHA(99)))),
        "revision_not_merged",
        "a commit no pull request merged is refused",
      );
      assertEquals(
        await reason(create(request(first, { runId: crypto.randomUUID() }))),
        "revision_not_merged",
        "a merge by another run is not this run's",
      );
      await assertRejects(
        () => create(request(first, { repositoryId: crypto.randomUUID() })),
        StandardError,
      );
      const one = await create(request(first));
      assertEquals(one.status, "queued");
      assertEquals(one.previousDeploymentId, null);
      assertEquals(one.externalEffectId, null);
      assertEquals(one.healthEvidenceId, null);
      assertEquals(one.version, 1);
      const queued = await database.query<{ count: string }>(
        `select count(*)::text as count from bakery.domain_events
        where organization_id = $1 and aggregate_id = $2
          and event_type = 'deployment.queued'`,
        [organizationId, one.id],
      );
      assertEquals(queued.rows[0]?.count, "1");

      // One in flight per environment: the same request answers with it, any
      // other is a conflict, and another environment is independent.
      assertEquals((await create(request(first))).id, one.id);
      const second = await merge(2);
      assertEquals(
        await reason(create(request(second))),
        "deployment_in_progress",
      );
      const preview = await create(request(first, { environment: "preview" }));
      assertNotEqualId(preview.id, one.id);
      // The database refuses a parallel one even if the code were bypassed.
      await assertRejects(() =>
        database.query(
          `insert into bakery.deployments (
           organization_id,repository_id,run_id,environment,commit_sha,
           artifact_digest,status,requested_by_id,request_id,trace_id
         ) values ($1,$2,$3,'staging',$4,$5,'verifying',$6,'r','t')`,
          [
            organizationId,
            repositoryId,
            world.runId,
            second,
            DIGEST(2),
            principal,
          ],
        )
      );

      // The lifecycle moves one allowed step at a time, on the current version.
      await assertRejects(
        () => advance(one.id, "queued", "healthy", 1),
        StandardError,
      );
      await assertRejects(
        () => advance(one.id, "queued", "deploying", 7),
        StandardError,
      );
      const healthy = await settle(one.id, "healthy");
      assertEquals(healthy.status, "healthy");
      assertEquals(healthy.version, 4);

      // The next release names the one it replaces; an unknown outcome blocks.
      const next = await create(request(second));
      assertEquals(next.previousDeploymentId, one.id);
      let moving = await advance(next.id, "queued", "deploying", 1);
      moving = await advance(next.id, "deploying", "unknown", moving.version);
      assertEquals(moving.status, "unknown");
      assertEquals(
        (await create(request(second))).id,
        next.id,
        "the same request is answered, not refused",
      );
      const third = await merge(3);
      assertEquals(await reason(create(request(third))), "outcome_unknown");
      assertEquals(await reason(rollback(next.id)), "outcome_unknown");
      // Reading the outcome back settles it; only then is the environment free.
      moving = await advance(next.id, "unknown", "verifying", moving.version);
      moving = await advance(next.id, "verifying", "degraded", moving.version);
      assertEquals(moving.status, "degraded");

      // Rollback: only the newest release, with a previous one, nothing in flight.
      assertEquals(
        await reason(rollback(one.id)),
        "not_current_release",
        "an older release under a newer one is history",
      );
      assertEquals(await reason(rollback(crypto.randomUUID())), undefined);
      const rolling = await rollback(next.id, "p95 latency doubled");
      assertEquals(rolling.status, "rolling_back");
      assertEquals(rolling.previousDeploymentId, one.id);
      assertEquals(
        (await rollback(next.id)).id,
        rolling.id,
        "the same request answers with it",
      );
      const requested = await database.query<{ count: string }>(
        `select count(*)::text as count from bakery.domain_events
        where organization_id = $1 and aggregate_id = $2
          and event_type = 'deployment.rollback_requested'`,
        [organizationId, next.id],
      );
      assertEquals(requested.rows[0]?.count, "1");
      const audit = await database.query<
        { details: { reason: string; restores: string } }
      >(
        `select details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'deployments.rollback'`,
        [organizationId, next.id],
      );
      assertEquals(audit.rows[0]?.details.reason, "p95 latency doubled");
      assertEquals(audit.rows[0]?.details.restores, one.id);
      assertEquals(
        await reason(create(request(third))),
        "deployment_in_progress",
      );
      const restored = await advance(
        next.id,
        "rolling_back",
        "rolled_back",
        rolling.version,
      );
      assertEquals(restored.status, "rolled_back");
      assertEquals(await reason(rollback(next.id)), "already_rolled_back");

      // The release it replaced serves again: the next one names it, not the
      // rolled-back one, and nothing is left to roll back for the first release.
      const after = await create(request(third));
      assertEquals(after.previousDeploymentId, one.id);
      await settle(after.id, "failed");
      assertEquals(await reason(rollback(one.id)), "no_previous_release");

      // Reads: newest first, filtered, and paged by a cursor bound to the filters.
      const all = await run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, {
          repositoryId,
          environment: "staging",
        })
      );
      assertEquals(all.items.map((item) => item.id), [
        after.id,
        next.id,
        one.id,
      ]);
      const pageOne = await run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, {
          repositoryId,
          environment: "staging",
          limit: 2,
        })
      );
      assertEquals(pageOne.items.length, 2);
      assert(pageOne.nextCursor !== null);
      const pageTwo = await run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, {
          repositoryId,
          environment: "staging",
          limit: 2,
          cursor: pageOne.nextCursor ?? undefined,
        })
      );
      assertEquals(pageTwo.items.map((item) => item.id), [one.id]);
      assertEquals(pageTwo.nextCursor, null);
      await assertRejects(
        () =>
          run((transaction) =>
            listDeployments(transaction, organizationId, principal, SECRET, {
              repositoryId,
              environment: "production",
              limit: 2,
              cursor: pageOne.nextCursor ?? undefined,
            })
          ),
        StandardError,
      );
      const onlyPreview = await run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, {
          environment: "preview",
        })
      );
      assertEquals(onlyPreview.items.map((item) => item.id), [preview.id]);

      // A status this code does not know reads as unknown, never as a success.
      await database.query(
        `update bakery.deployments set status = 'deployed-ok' where id = $1`,
        [preview.id],
      );
      const odd = await run((transaction) =>
        listDeployments(transaction, organizationId, principal, SECRET, {
          environment: "preview",
        })
      );
      assertEquals(odd.items[0]?.status, "unknown");
    } finally {
      // The fixture deletes runs and principals; rows that point at them go first.
      await database.query(
        `delete from bakery.deployments where organization_id = $1`,
        [organizationId],
      );
      await database.query(
        `delete from bakery.pull_requests
          where organization_id = $1 and run_id = $2`,
        [organizationId, world.runId],
      );
    }
  });
});

function assertNotEqualId(left: string, right: string) {
  assert(left !== right, "another environment gets its own deployment");
}

Deno.test("the driver moves real deployment rows by what a local target reports, restores the previous release, and reads an unknown outcome back (#43)", async () => {
  await withReviewedRun(async (world) => {
    const database = world.fixture.pgDatabase;
    const organizationId = world.repository.organizationId;
    const repositoryId = world.repository.repositoryId;
    const root = await Deno.makeTempDir({ prefix: "bakery-release-it-" });
    try {
      const principal = (await database.query<{ id: string }>(
        `select principal_id as id from bakery.organization_memberships
          where organization_id = $1 and status = 'active'
          order by created_at limit 1`,
        [organizationId],
      )).rows[0].id;
      const encoder = new TextEncoder();
      const buildBytes = (sha: string) => encoder.encode(`build of ${sha}`);
      const digestOf = async (bytes: Uint8Array) =>
        `sha256:${
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes as BufferSource),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("")
        }`;
      let number = 300;
      const merge = async (commit: number) => {
        await database.query(
          `insert into bakery.pull_requests (
             id,organization_id,task_id,repository_id,provider_number,url,head_sha,
             base_sha,status,merged_sha,run_id,version
           ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
          [
            organizationId,
            world.taskId,
            repositoryId,
            ++number,
            `https://github.com/acme/widgets/pull/${number}`,
            SHA(commit + 1000),
            SHA(1),
            SHA(commit),
            world.runId,
          ],
        );
        return SHA(commit);
      };
      const queue = async (commitSha: string) =>
        await withPgTransaction(
          database,
          async (transaction) =>
            createDeployment(transaction, organizationId, principal, {
              requestId: `request-${crypto.randomUUID()}`,
              traceId: TRACE,
              create: {
                repositoryId,
                runId: world.runId,
                environment: "staging",
                commitSha,
                artifactDigest: await digestOf(buildBytes(commitSha)),
              },
            }),
        );

      // The running app reports the release the pointer names, unless a case
      // says the new release never took over.
      let stale: string | null = null;
      const served = async (): Promise<string> =>
        JSON.parse(await Deno.readTextFile(`${root}/current.json`)).commitSha;
      // Health evidence is a real artifact version: the column is a foreign key.
      const saveEvidence = async (evidence: unknown): Promise<string> => {
        const artifactId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const bytes = encoder.encode(JSON.stringify(evidence));
        await database.query(
          `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name)
           values ($1,$2,$3,'document',$4)`,
          [
            artifactId,
            organizationId,
            world.taskId,
            `deploy-health-${artifactId}`,
          ],
        );
        await database.query(
          `insert into bakery.artifact_versions (
             id,organization_id,artifact_id,task_id,author_id,revision,content,
             sha256,size_bytes,media_type,retention_class
           ) values ($1,$2,$3,$4,$5,1,$6,$7,$8,'application/json','evidence')`,
          [
            versionId,
            organizationId,
            artifactId,
            world.taskId,
            principal,
            bytes,
            (await digestOf(bytes)).slice(7),
            bytes.length,
          ],
        );
        return versionId;
      };
      const target = createLocalReleaseTarget({
        root,
        environment: "staging",
        artifacts: async (input) => {
          const bytes = buildBytes(input.headSha);
          return { bytes, digest: await digestOf(bytes) };
        },
        probe: async () => ({ version: stale ?? await served(), state: "ok" }),
        saveEvidence,
      });
      const ledger = createPostgresDeploymentLedger({
        database,
        organizationId,
        principalId: principal,
        requestId: `request-${crypto.randomUUID()}`,
        traceId: TRACE,
      });
      const read = (id: string) =>
        withPgTransaction(
          database,
          (transaction) => readDeployment(transaction, organizationId, id),
        );
      const driver = createDeploymentDriver({ ledger, adapter: target });

      // 1. A healthy release: the row closes healthy with real evidence.
      const first = await queue(await merge(1));
      const healthy = await driver.deploy(first.id, { profileRevision: 1 });
      assertEquals(healthy.deployment.status, "healthy");
      assert(healthy.deployment.healthEvidenceId !== null);
      assertEquals((await read(first.id)).status, "healthy");
      assertEquals(await served(), SHA(1));

      // 2. The next release never takes over: it ends failed, the previous
      // release is restored, and the environment is free for the next.
      stale = SHA(1);
      const second = await queue(await merge(2));
      assertEquals(second.previousDeploymentId, first.id);
      const restored = await driver.deploy(second.id, { profileRevision: 1 });
      assertEquals(restored.deployment.status, "rolled_back");
      assertEquals((await read(second.id)).status, "rolled_back");
      assertEquals(await served(), SHA(1));
      stale = null;

      // 3. A lost answer to deploy: unknown in the table, which blocks the next
      // deployment, and the same effect key settles it without a second deploy.
      let deployCalls = 0;
      const lossy: ReleaseAdapter = {
        ...target,
        deploy: async (input) => {
          deployCalls += 1;
          await target.deploy(input);
          throw new Error("connection reset");
        },
      };
      const third = await queue(await merge(3));
      const lost = await createDeploymentDriver({ ledger, adapter: lossy })
        .deploy(third.id, { profileRevision: 1 });
      assertEquals(lost.deployment.status, "unknown");
      assertEquals(
        await reason(queue(await merge(4))),
        "outcome_unknown",
        "an unknown outcome blocks the next deployment",
      );
      const settled = await driver.settle(third.id, lost.effectKey!);
      assertEquals(settled.deployment.status, "healthy");
      assertEquals(deployCalls, 1);
      assertEquals(await served(), SHA(3));
    } finally {
      await Deno.remove(root, { recursive: true });
      // The fixture deletes runs and artifact versions; rows that point at them go first.
      await database.query(
        `delete from bakery.deployments where organization_id = $1`,
        [organizationId],
      );
      await database.query(
        `delete from bakery.pull_requests
          where organization_id = $1 and run_id = $2`,
        [organizationId, world.runId],
      );
    }
  });
});
