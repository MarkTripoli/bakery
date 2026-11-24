import { assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { createDeliveryHandlers } from "../../apps/server/src/modules/delivery/handlers.ts";
import { createDeployment } from "../../apps/server/src/modules/delivery/deployments.ts";
import { seedFundedModelJob } from "../helpers/funded-model-job.ts";
import { mergeDispatchStub } from "../helpers/merge-dispatch-stub.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

// W3 S6b: the Deployment projection carries the environment's address, so the
// release card can offer "Open it" without a second read. The address is the
// install's configuration for the environment a release went to, and null when
// no address is configured.

const SECRET = "deployment-address-cursor-secret";
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const DIGEST = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const STAGING = "https://staging.example.test";

function contextFor(
  organizationId: string,
  principalId: string,
  transaction: unknown,
): ActionContext {
  return {
    transaction,
    authority: {
      organizationId,
      subject: {
        principalId,
        principalType: "human",
        displayName: "Address regression",
      },
      role: "developer",
      capabilities: [],
    },
    params: {},
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  } as unknown as ActionContext;
}

Deno.test("the deployment read names the environment's address, or null when none is configured", () =>
  withWorkerFixture(async (fixture) => {
    const database = fixture.pgDatabase;
    const organizationId = fixture.organizationId;
    const principal = fixture.principalId;
    const job = await seedFundedModelJob(database, organizationId, principal);
    const repositoryId = (await database.query<{ id: string }>(
      `select repository_id as id from bakery.workflow_runs where id = $1`,
      [job.runId],
    )).rows[0].id;
    await database.query(
      `insert into bakery.pull_requests (
         id,organization_id,task_id,repository_id,provider_number,url,head_sha,
         base_sha,status,merged_sha,run_id,version
       ) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'merged',$8,$9,1)`,
      [
        organizationId,
        job.taskId,
        repositoryId,
        1,
        "https://github.com/acme/widgets/pull/1",
        SHA(1001),
        SHA(1),
        SHA(1000),
        job.runId,
      ],
    );
    const created = await withPgTransaction(
      database,
      (transaction) =>
        createDeployment(transaction, organizationId, principal, {
          requestId: `request-${crypto.randomUUID()}`,
          traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          create: {
            repositoryId,
            runId: job.runId,
            environment: "staging",
            commitSha: SHA(1000),
            artifactDigest: DIGEST(1000),
          },
        }),
    );

    const page = async (
      environmentAddress: (environment: string) => string | null,
    ) => {
      const handlers = createDeliveryHandlers(
        SECRET,
        mergeDispatchStub("deployment address test"),
        environmentAddress,
      );
      return await withPgTransaction(
        database,
        (transaction) =>
          handlers.deploymentsList(
            contextFor(organizationId, principal, transaction),
            { runId: job.runId },
          ),
      );
    };

    const configured = await page((environment) =>
      environment === "staging" ? STAGING : null
    );
    assertEquals(configured.items.map((item) => item.id), [created.id]);
    assertEquals(configured.items[0]?.address, STAGING);

    const unconfigured = await page(() => null);
    assertEquals(unconfigured.items[0]?.address, null);
  }));
