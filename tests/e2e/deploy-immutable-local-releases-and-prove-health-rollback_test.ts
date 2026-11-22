import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { readDeliveryTargetConfig } from "../../packages/config/src/env.ts";
import {
  createDeliveryStepRunner,
  type DeliveryStepRequest,
} from "../../apps/server/src/modules/delivery/delivery-steps.ts";
import { createLocalDeliveryTargets } from "../../apps/server/src/modules/delivery/local-delivery-targets.ts";
import { withReviewedRun } from "../helpers/review-repair/loop-world.ts";

/**
 * #43 end to end, over the real composition and no stand-in for the target:
 * the install's `BAKERY_DELIVERY_*` settings are read as the server reads them,
 * the artifact is a file the build left, the release is switched on disk, and
 * health is an HTTP read of a running app that serves whatever the pointer names.
 * The database is real. A healthy release serves the exact revision; a release
 * that does not take over is rolled back; a missing artifact deploys nothing.
 */

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SHA = (n: number) => n.toString(16).padStart(40, "0");

Deno.test("a release serves the exact revision, an unhealthy one is rolled back, and a missing artifact deploys nothing (#43)", async () => {
  await withReviewedRun(async (world) => {
    const database = world.fixture.pgDatabase;
    const organizationId = world.repository.organizationId;
    const repositoryId = world.repository.repositoryId;
    const root = await Deno.makeTempDir({ prefix: "bakery-e2e-delivery-" });
    const releaseRoot = join(root, "releases");
    const artifactsDir = join(root, "artifacts");
    await Deno.mkdir(artifactsDir);
    const pointerPath = join(releaseRoot, "current.json");
    // The running app: it serves the revision the pointer names, unless told it is stuck.
    let stuckOn: string | null = null;
    const app = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      async () => {
        let version = stuckOn;
        if (version === null) {
          try {
            version =
              JSON.parse(await Deno.readTextFile(pointerPath)).commitSha;
          } catch {
            return new Response("{}", { status: 503 });
          }
        }
        return Response.json({ version, state: "ok" });
      },
    );
    const healthUrl = `http://127.0.0.1:${app.addr.port}/health/ready`;
    const served = async (): Promise<string> =>
      (await (await fetch(healthUrl)).json()).version;
    try {
      const principal = (await database.query<{ id: string }>(
        `select principal_id as id from bakery.organization_memberships
          where organization_id = $1 and status = 'active'
          order by created_at limit 1`,
        [organizationId],
      )).rows[0].id;
      const config = readDeliveryTargetConfig({
        BAKERY_DELIVERY_RELEASE_ROOT: releaseRoot,
        BAKERY_DELIVERY_ARTIFACTS_DIR: artifactsDir,
        BAKERY_DELIVERY_HEALTH_URL: healthUrl,
        BAKERY_DELIVERY_ENVIRONMENT: "staging",
      });
      assert(config !== undefined);
      const runner = createDeliveryStepRunner({
        database,
        targets: createLocalDeliveryTargets(config),
      });
      const base = {
        organizationId,
        runId: world.runId,
        taskId: world.taskId,
        repositoryId,
        requestedBy: principal,
        traceId: TRACE,
        iteration: 0,
      };
      const request = (
        stepKey: string,
        action: DeliveryStepRequest["action"],
        input: unknown,
      ): DeliveryStepRequest => ({ ...base, stepKey, action, input });
      const recordCompleted = async (
        stepKey: string,
        action: string,
        input: unknown,
        output: unknown,
      ) => {
        await database.query(
          `insert into bakery.run_steps (
             organization_id, run_id, step_key, position, iteration, status,
             input, output, dispatch, finished_at
           ) select $1, $2, $3, coalesce(max(position), 0) + 1, 0, 'completed',
                    $4::jsonb, $5::jsonb, $6::jsonb, now()
               from bakery.run_steps where organization_id = $1 and run_id = $2`,
          [
            organizationId,
            world.runId,
            stepKey,
            JSON.stringify(input),
            JSON.stringify(output),
            JSON.stringify({ kind: "action", key: stepKey, action, input }),
          ],
        );
      };
      let pullNumber = 500;
      const merge = async (commit: string) => {
        await database.query(
          `insert into bakery.pull_requests (
             id,organization_id,task_id,repository_id,provider_number,url,head_sha,
             base_sha,status,merged_sha,run_id,version
           ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
          [
            organizationId,
            world.taskId,
            repositoryId,
            ++pullNumber,
            `https://github.com/acme/widgets/pull/${pullNumber}`,
            SHA(pullNumber),
            SHA(1),
            commit,
            world.runId,
          ],
        );
      };
      const done = (
        result: { kind: string; output?: unknown; code?: string },
      ) => {
        assertEquals(result.kind, "completed", JSON.stringify(result));
        return result.output as Record<string, unknown>;
      };
      /** One release through the three steps; `name` keeps the step keys apart. */
      const release = async (name: string, commit: string) => {
        await merge(commit);
        await Deno.writeTextFile(
          join(artifactsDir, `${commit}.artifact`),
          `build of ${commit}`,
        );
        const prepareInput = {
          repositoryId,
          headSha: commit,
          profileRevision: 1,
        };
        const prepared = done(
          await runner.run(
            request(`${name}_prepare`, "delivery.prepare", prepareInput),
          ),
        );
        await recordCompleted(
          `${name}_prepare`,
          "delivery.prepare",
          prepareInput,
          prepared,
        );
        const deployInput = {
          releaseId: prepared.releaseId,
          environment: "staging",
          effectKey: `deploy:${name}`,
        };
        const deployed = done(
          await runner.run(
            request(`${name}_deploy`, "delivery.deploy", deployInput),
          ),
        );
        await recordCompleted(
          `${name}_deploy`,
          "delivery.deploy",
          deployInput,
          deployed,
        );
        return { prepared, deployed };
      };

      // 1. A healthy release: the running app reports the exact revision.
      const A = SHA(0xa1);
      const first = await release("one", A);
      assertEquals(first.prepared.environment, "staging");
      const healthA = done(
        await runner.run(
          request("one_health", "delivery.health", {
            deploymentId: first.deployed.deploymentId,
          }),
        ),
      );
      assertEquals(healthA.status, "healthy");
      assertEquals(await served(), A);
      assert(
        (healthA.evidenceArtifact as { versionId?: string }).versionId !==
          undefined,
      );

      // 2. The next release never takes over (the app stays on A): it is not
      // healthy, and the previous release is what serves afterwards.
      const B = SHA(0xb2);
      stuckOn = A;
      const second = await release("two", B);
      const healthB = done(
        await runner.run(
          request("two_health", "delivery.health", {
            deploymentId: second.deployed.deploymentId,
          }),
        ),
      );
      assertEquals(healthB.status, "failed");
      stuckOn = null;
      assertEquals(await served(), A, "the previous release serves again");
      const states = (await database.query<{ id: string; status: string }>(
        `select id, status from bakery.deployments
          where organization_id = $1 order by created_at`,
        [organizationId],
      )).rows.map((row) => row.status);
      assertEquals(states, ["healthy", "rolled_back"]);

      // 3. A commit with no built artifact deploys nothing and changes nothing.
      const C = SHA(0xc3);
      await merge(C);
      const missing = await runner.run(
        request("three_prepare", "delivery.prepare", {
          repositoryId,
          headSha: C,
          profileRevision: 1,
        }),
      );
      assertEquals(missing, {
        kind: "failed",
        code: "DELIVERY_PREPARE_ARTIFACT_MISSING",
        message: "The target could not prepare the release.",
      });
      assertEquals(await served(), A);
    } finally {
      await app.shutdown();
      await Deno.remove(root, { recursive: true });
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
