import { assert, assertEquals } from "@std/assert";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import { createClaimsRepository } from "../../../packages/persistence/src/claims.ts";
import type { WorkerIdentity } from "../../../packages/persistence/src/types.ts";
import { workerActionCapabilities } from "../../../packages/contracts/src/contracts.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import { claimAssignment } from "../worker-execution/scenarios.ts";
import { withReviewedRun } from "./loop-world.ts";

/**
 * Issue #94, plan finding F19: a `review.independent` job requires the
 * `model` and `reviewer` capabilities, and the claim query leases it only to a
 * worker host whose enrolled capabilities include both. The proof runs the real
 * `findClaimableJob` (packages/persistence/src/claims.ts) against real
 * Postgres with the application role, on a job the production engine admitted
 * for a real reviewed-preset run, for hosts that lack one or both capabilities
 * and for one that has both. Every host asks for every capability: only what
 * the host is enrolled with counts, so a worker cannot claim a reviewer job by
 * requesting a capability it does not hold.
 */

const NEEDED = ["model", "reviewer"] as const;

/** Every capability a claim below requests, whatever the host is enrolled with. */
const REQUESTED = [...new Set([...workerFixtureCapabilities, ...NEEDED])];

const withoutModel = workerFixtureCapabilities.filter((capability) =>
  capability !== "model"
);
const withoutReviewer = workerFixtureCapabilities.filter((capability) =>
  capability !== "reviewer"
);

type Host = { readonly name: string; readonly enrolled: readonly string[] };

/** Hosts that must never lease a review job. */
const LACKING: readonly Host[] = [
  { name: "model but no reviewer", enrolled: withoutReviewer },
  { name: "reviewer but no model", enrolled: [...withoutModel, "reviewer"] },
  { name: "only reviewer", enrolled: ["reviewer"] },
  { name: "only model", enrolled: ["model"] },
  { name: "neither", enrolled: ["git", "shell", "browser"] },
  { name: "no capability at all", enrolled: [] },
  // The job also needs `git` (repository admission), so the two review
  // capabilities alone do not lease it either.
  { name: "model and reviewer but no git", enrolled: [...NEEDED] },
];

/**
 * Registers a host through the real enrolment and registration routes, so it
 * owns a worker principal the fixture cleanup removes, and returns the identity
 * the claim route would authenticate it as, read back from the stored row.
 */
async function insertHost(
  fixture: WorkerFixture,
  host: Host,
): Promise<WorkerIdentity> {
  const worker = await registeredWorker(fixture, {
    name: `reviewer-claim-${host.name.replaceAll(" ", "-")}-${
      crypto.randomUUID().slice(0, 6)
    }`,
    capabilities: [...host.enrolled],
  });
  const stored = await fixture.pgDatabase.query<{
    id: string;
    principal_id: string;
    principal_type: string;
    name: string;
    os: string;
    architecture: string;
    capabilities: unknown;
    slots: number;
    status: string;
    desired_mode: string;
    credential_hash: string;
    credential_generation: number;
    protocol_version: number;
    inventory_revision: number;
    readiness_revision: number;
    worker_session_id: string | null;
    worker_session_generation: string;
    last_heartbeat_at: Date | null;
  }>(
    `select id, principal_id, principal_type, name, os, architecture,
            capabilities, slots, status, desired_mode, credential_hash,
            credential_generation, protocol_version, inventory_revision,
            readiness_revision, worker_session_id,
            worker_session_generation::text, last_heartbeat_at
       from bakery.worker_hosts
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, worker.registration.workerHostId],
  );
  const row = stored.rows[0];
  assertEquals(
    [...(row.capabilities as string[])].sort(),
    [...host.enrolled].sort(),
    `${host.name} is enrolled with exactly what the test says`,
  );
  return {
    tokenHash: row.credential_hash,
    host: {
      id: row.id,
      organizationId: fixture.organizationId,
      principalId: row.principal_id,
      principalType: row.principal_type,
      name: row.name,
      os: row.os,
      architecture: row.architecture,
      capabilities: row.capabilities,
      slots: row.slots,
      status: row.status,
      desiredMode: row.desired_mode,
      credentialHash: row.credential_hash,
      credentialGeneration: row.credential_generation,
      protocolVersion: row.protocol_version,
      inventoryRevision: row.inventory_revision,
      readinessRevision: row.readiness_revision,
      workerSessionId: row.worker_session_id,
      workerSessionGeneration: row.worker_session_generation,
      lastHeartbeatAt: row.last_heartbeat_at,
    },
  };
}

const ROLLED_BACK = Symbol("rolled back");

/**
 * Runs the real `findClaimableJob` for `identity` as the application role and
 * returns the job id it picked, or null. The transaction is rolled back, so the
 * lookup leases nothing and the next host sees the same queue.
 */
async function pickedJob(
  database: PgDatabase,
  identity: WorkerIdentity,
  supportedActions: readonly string[] | undefined,
): Promise<string | null> {
  let picked: string | null = null;
  try {
    await withPgTransaction(database, async (transaction) => {
      const claims = createClaimsRepository(transaction, identity);
      const job = await claims.findClaimableJob({
        organizationId: identity.host.organizationId,
        requestedCapabilities: REQUESTED,
        supportedActions,
        metadata: {
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        },
        principalId: identity.host.principalId,
      });
      picked = job?.id ?? null;
      throw ROLLED_BACK;
    });
  } catch (error) {
    if (error !== ROLLED_BACK) throw error;
  }
  return picked;
}

async function attemptCount(
  fixture: WorkerFixture,
  jobId: string,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from bakery.job_attempts
      where organization_id = $1 and job_id = $2`,
    [fixture.organizationId, jobId],
  );
  return Number(result.rows[0].count);
}

export function registerReviewerClaimCases(): void {
  Deno.test("the review action requires the model and reviewer capabilities", () => {
    assertEquals(
      [...workerActionCapabilities("review.independent")].sort(),
      [...NEEDED].sort(),
    );
    // The fixture enrols model for the implement action; reviewer is what a
    // host adds on purpose, so the negative hosts below are not trivially empty.
    assert(workerFixtureCapabilities.includes("model"));
    assert(!workerFixtureCapabilities.includes("reviewer"));
  });

  Deno.test("a review job is leased only to a host enrolled with both model and reviewer", async () => {
    await withReviewedRun(async (world) => {
      const { fixture } = world;
      const review = await world.admit("review", 0);
      assertEquals(review.job.action, "review.independent");
      const stored = await fixture.pgDatabase.query<
        { status: string; requirements: unknown }
      >(
        `select status, requirements from bakery.jobs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, review.job.id],
      );
      assertEquals(stored.rows[0].status, "queued");
      const required = Array.isArray(stored.rows[0].requirements)
        ? stored.rows[0].requirements
        : (stored.rows[0].requirements as { capabilities?: unknown })
          .capabilities;
      // Repository admission adds `git`; the review action itself adds model
      // and reviewer. All three are enrolment requirements of the job.
      assertEquals(
        [...(required as string[])].sort(),
        ["git", ...NEEDED].sort(),
        "the admitted job requires git, model and reviewer",
      );

      // 1. Hosts lacking either capability: the real claim query finds nothing,
      // asking for the review action by name or for any action.
      for (const lacking of LACKING) {
        const identity = await insertHost(fixture, lacking);
        for (const actions of [["review.independent"], undefined]) {
          assertEquals(
            await pickedJob(fixture.runtimePgDatabase, identity, actions),
            null,
            `${lacking.name} (${actions?.join(",") ?? "any action"})`,
          );
        }
      }
      assertEquals(await attemptCount(fixture, review.job.id), 0);

      // 2. A host enrolled with both is offered exactly this job.
      const capable = await insertHost(fixture, {
        name: "model and reviewer",
        enrolled: [...withoutReviewer, "reviewer"],
      });
      assertEquals(
        await pickedJob(fixture.runtimePgDatabase, capable, [
          "review.independent",
        ]),
        review.job.id,
      );
      const minimal = await insertHost(fixture, {
        name: "exactly git, model and reviewer",
        enrolled: ["git", ...NEEDED],
      });
      assertEquals(
        await pickedJob(fixture.runtimePgDatabase, minimal, undefined),
        review.job.id,
      );
      // The lookups leased nothing.
      assertEquals(await attemptCount(fixture, review.job.id), 0);

      // 3. Through the real HTTP claim route. A registered host that holds
      // model but not reviewer cannot ask for reviewer (403), and asking only
      // for what it holds finds no review job (204): the job stays queued.
      const notReviewer = await registeredWorker(fixture, {
        name: `claim-no-reviewer-${crypto.randomUUID().slice(0, 6)}`,
        capabilities: withoutReviewer,
      });
      const claimWith = async (capabilities: readonly string[]) => {
        const claimKey = crypto.randomUUID();
        return await workerRequest(
          fixture,
          notReviewer.credential,
          "/v1/worker/claims",
          {
            claimKey,
            workerHostId: notReviewer.registration.workerHostId,
            capabilities,
            supportedActions: ["review.independent"],
          },
          { idempotencyKey: claimKey },
        );
      };
      const overAsked = await claimWith(REQUESTED);
      assertEquals(overAsked.status, 403, await overAsked.clone().text());
      await overAsked.body?.cancel();
      const refused = await claimWith(withoutReviewer);
      assertEquals(refused.status, 204, await refused.clone().text());
      await refused.body?.cancel();
      assertEquals(await attemptCount(fixture, review.job.id), 0);

      // 4. A registered host with both capabilities leases it.
      const reviewer = await registeredWorker(fixture, {
        name: `claim-reviewer-${crypto.randomUUID().slice(0, 6)}`,
        capabilities: [...withoutReviewer, "reviewer"],
      });
      const assignment = await claimAssignment(fixture, reviewer, {
        capabilities: REQUESTED,
        supportedActions: ["review.independent"],
      });
      assertEquals(assignment.jobId, review.job.id);
      assertEquals(assignment.action, "review.independent");
      assertEquals(assignment.workerHostId, reviewer.registration.workerHostId);
      const leased = await fixture.pgDatabase.query<
        { status: string; worker_host_id: string }
      >(
        `select attempt.status, attempt.worker_host_id
           from bakery.job_attempts attempt
          where attempt.organization_id = $1 and attempt.job_id = $2`,
        [fixture.organizationId, review.job.id],
      );
      assertEquals(leased.rows.length, 1);
      assertEquals(
        leased.rows[0].worker_host_id,
        reviewer.registration.workerHostId,
      );
    });
  });
}
