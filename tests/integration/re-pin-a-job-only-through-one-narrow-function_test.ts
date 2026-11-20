import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  closeWorkerFixture,
  openWorkerFixture,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

/**
 * The application role cannot write a job's billing; it re-points a job's pin through
 * `bakery.repin_job_billing` (0280) and nothing else. The role is the one the worker
 * routes and the admission both run as, so a column grant on `jobs.billing` would let
 * any code on the worker path rewrite what a job is billed to.
 *
 * Every statement here runs as `bakery_app` itself, not as the owner.
 */

const PIN = {
  provider: "anthropic",
  billingAccountId: "target-account",
  model: "claude-x",
  billingRoute: "api",
  pricingMetadataSnapshot: "target-price-v1",
};

Deno.test("the application role cannot rewrite a job's billing, only re-point its pin through the function", async () => {
  const fixture = await openWorkerFixture();
  try {
    const owner = fixture.pgDatabase;
    const app = fixture.runtimePgDatabase!;
    assertEquals(
      (await app.query("select current_user as name")).rows[0].name,
      "bakery_app",
    );
    const run = await seedAdmissibleRun(
      owner,
      fixture.organizationId,
      fixture.principalId,
      { stepKey: `repin-${crypto.randomUUID().slice(0, 8)}` },
    );
    await seedProviderPricingSnapshot(owner, { billing: run.billing! });
    const job = await admitFundedModelRun(owner, run, { maxAttempts: 3 });

    const read = async () =>
      (await owner.query(
        `select billing, agent_config, version from bakery.jobs where id = $1`,
        [job.jobId],
      )).rows[0];
    const repin = async (
      organizationId: string,
      jobId: string,
      billing: unknown,
    ) =>
      (await app.query(
        `select bakery.repin_job_billing($1, $2, $3::jsonb) as ok`,
        [organizationId, jobId, JSON.stringify(billing)],
      )).rows[0].ok as boolean;

    const before = await read();
    assert(before.billing && typeof before.billing === "object");

    // 1. No direct write to either column, by the role that serves the worker routes.
    for (const column of ["billing", "agent_config"]) {
      await assertRejects(
        () =>
          app.query(
            `update bakery.jobs set ${column} = ${column} where id = $1`,
            [job.jobId],
          ),
        Error,
        "permission denied",
      );
    }

    // 2. The function refuses anything that is not a re-point of the pin, and writes
    //    nothing when it refuses.
    for (
      const refused of [
        { ...before.billing, maxUsdReservation: 99 },
        { ...before.billing, maxTokens: 1 },
        { ...before.billing, extra: true },
        { ...before.billing, ...PIN, maxUsdReservation: 99 },
        [],
        null,
      ]
    ) {
      assertEquals(
        await repin(fixture.organizationId, job.jobId, refused),
        false,
        JSON.stringify(refused),
      );
    }
    const unchanged = await read();
    assertEquals(unchanged.billing, before.billing);
    assertEquals(unchanged.agent_config, before.agent_config);
    assertEquals(unchanged.version, before.version);

    // 3. It cannot be pointed at another organization's job or at a job that is not
    //    there.
    assertEquals(
      await repin(crypto.randomUUID(), job.jobId, {
        ...before.billing,
        ...PIN,
      }),
      false,
    );
    assertEquals(
      await repin(fixture.organizationId, crypto.randomUUID(), {
        ...before.billing,
        ...PIN,
      }),
      false,
    );
    assertEquals((await read()).billing, before.billing);

    // 4. A change of the five pin fields alone is written, to the job and to the
    //    billing inside its agent configuration, and nothing else moves.
    const next = { ...before.billing, ...PIN };
    assertEquals(await repin(fixture.organizationId, job.jobId, next), true);
    const after = await read();
    assertEquals(after.billing, next);
    assertEquals(after.agent_config.billing, next);
    const { billing: _a, ...restAfter } = after.agent_config;
    const { billing: _b, ...restBefore } = before.agent_config;
    assertEquals(restAfter, restBefore);
    assertEquals(after.version, before.version + 1);
  } finally {
    await closeWorkerFixture(fixture);
  }
});
