import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import { recordAttemptRouteEvidence } from "../../apps/server/src/modules/execution/attempt-route-evidence.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  type RegisteredWorker,
  resultBody,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

/**
 * #70 slice 2 through the real worker result route, against a real database:
 * what a terminal attempt proves about the provider route its job is pinned to.
 *
 * What only a database can show: that the result route's transaction joins the
 * job's pin and billing account to the right route, that an exhausted quota or an
 * invalid credential opens an incident there (and nowhere else), that a completed
 * attempt closes it, that a fault saying nothing about the provider writes
 * nothing, and that evidence written in a transaction that rolls back is gone.
 */

const PIN = {
  provider: "anthropic",
  model: "claude-x",
  harness: "pi",
  billingRoute: "api",
  billingAccountId: "acct-attempt-evidence",
};

type Seeded = {
  jobId: string;
  sessionId: string;
  assignment: WorkerAssignment;
  worker: RegisteredWorker;
};

/** A claimed attempt whose job carries a model pin and a billing account. */
async function seedAttempt(fixture: WorkerFixture): Promise<Seeded> {
  const worker = await registeredWorker(fixture, {
    name: `route-evidence-${crypto.randomUUID().slice(0, 8)}`,
  });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  // A nonmodel fixture keeps the claim independent of live billing admission;
  // the pin the route evidence matches on is written after the claim.
  await fixture.pgDatabase.query(
    `update bakery.jobs
        set action = 'harness.implement', agent_config = $3::jsonb,
            billing = $4::jsonb
      where organization_id = $1 and id = $2`,
    [
      fixture.organizationId,
      assignment.jobId,
      JSON.stringify({ harness: PIN.harness }),
      JSON.stringify({
        provider: PIN.provider,
        model: PIN.model,
        billingRoute: PIN.billingRoute,
        billingAccountId: PIN.billingAccountId,
      }),
    ],
  );
  return { jobId: job.jobId, sessionId: job.sessionId, assignment, worker };
}

async function seedAccount(
  fixture: WorkerFixture,
  billingIdentity = PIN.billingAccountId,
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.model_provider_accounts (
       id, organization_id, provider, billing_identity, identity_hash,
       billing_route, display_identity
     ) values ($1, $2, $3, $4, $5, 'api', 'evidence')`,
    [id, fixture.organizationId, PIN.provider, billingIdentity, `h-${id}`],
  );
  return id;
}

async function seedRoute(
  fixture: WorkerFixture,
  accountId: string,
  values: { model?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.provider_routes (
       id, organization_id, provider, endpoint, model, harness, billing_route,
       credential_location, status, health, provider_account_id
     ) values ($1, $2, $3, 'https://api.provider.example/v1', $4, $5,
       'api_metered', 'harness_host', 'active', 'healthy', $6)`,
    [
      id,
      fixture.organizationId,
      PIN.provider,
      values.model ?? PIN.model,
      PIN.harness,
      accountId,
    ],
  );
  return id;
}

/** Opens an incident on a route the way an earlier probe failure would. */
async function openIncident(
  fixture: WorkerFixture,
  routeId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.provider_incidents (
       id, organization_id, route_id, generation, status, severity, reason,
       first_failure_at, last_failure_at
     ) values ($1, $2, $3, 1, 'open', 'outage', 'timeout', now(), now())`,
    [id, fixture.organizationId, routeId],
  );
  await fixture.pgDatabase.query(
    `update bakery.provider_routes
        set incident_id = $2, incident_generation = 1, health = 'open'
      where id = $1`,
    [routeId, id],
  );
  return id;
}

async function routeState(fixture: WorkerFixture, routeId: string) {
  return (await fixture.pgDatabase.query<{
    health: string;
    incident_id: string | null;
    incident_generation: number;
    inference_verified_at: Date | null;
  }>(
    `select health, incident_id, incident_generation, inference_verified_at
       from bakery.provider_routes where id = $1`,
    [routeId],
  )).rows[0]!;
}

async function incidents(fixture: WorkerFixture, routeId: string) {
  return (await fixture.pgDatabase.query<{
    id: string;
    status: string;
    reason: string;
    severity: string;
  }>(
    `select id, status, reason, severity from bakery.provider_incidents
      where route_id = $1 order by generation`,
    [routeId],
  )).rows;
}

const fault = (code: string) => ({
  type: "about:blank",
  title: "Harness failed",
  status: 502,
  detail: "The provider refused the request.",
  code,
  requestId: crypto.randomUUID(),
  retryable: false,
});

async function postResult(
  fixture: WorkerFixture,
  seeded: Seeded,
  outcome: { status: "completed" } | { status: "failed"; code: string },
): Promise<void> {
  const { assignment, worker } = seeded;
  const body = resultBody(assignment, {
    status: outcome.status,
    ...(outcome.status === "completed"
      ? {
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId: seeded.sessionId,
          artifacts: [],
          claudeCodeVersion: "2.0.0",
          model: PIN.model,
          capabilities: ["git", "shell", "web", "model"],
          events: [],
          telemetry: { providerUsage: null, costUsd: null },
        },
      }
      : { fault: fault(outcome.code) }),
  });
  const response = await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/result`,
    body,
    { idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(response.status, 200, await response.text());
}

for (
  const [code, reason] of [
    ["quota_exceeded", "quota_exhausted"],
    ["quota_exhausted", "quota_exhausted"],
    ["credential_invalid", "credential_invalid"],
    ["CODEX_HARNESS_AUTH_FILE_INVALID", "credential_invalid"],
  ] as const
) {
  Deno.test(`attempt route evidence: a failed result with ${code} opens a ${reason} incident on the pinned route only`, () =>
    withWorkerFixture(async (fixture) => {
      const seeded = await seedAttempt(fixture);
      const account = await seedAccount(fixture);
      const otherAccount = await seedAccount(fixture, "acct-someone-else");
      const pinned = await seedRoute(fixture, account);
      // Same pin, another account: its quota and credential are its own.
      const foreign = await seedRoute(fixture, otherAccount);
      // Same account, another model: not the route the job ran on.
      const otherModel = await seedRoute(fixture, account, {
        model: "claude-y",
      });

      await postResult(fixture, seeded, { status: "failed", code });

      const state = await routeState(fixture, pinned);
      assertEquals(state.health, "open");
      assertEquals(state.incident_generation, 1);
      const opened = await incidents(fixture, pinned);
      assertEquals(opened.length, 1);
      assertEquals(opened[0]!.id, state.incident_id);
      assertEquals(opened[0]!.status, "open");
      assertEquals(opened[0]!.reason, reason);
      assertEquals(opened[0]!.severity, "outage");
      for (const untouched of [foreign, otherModel]) {
        assertEquals((await routeState(fixture, untouched)).health, "healthy");
        assertEquals(await incidents(fixture, untouched), []);
      }
    }));
}

Deno.test("attempt route evidence: a completed result closes the pinned route's open incident and proves inference", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedAttempt(fixture);
    const account = await seedAccount(fixture);
    const pinned = await seedRoute(fixture, account);
    const incident = await openIncident(fixture, pinned);

    await postResult(fixture, seeded, { status: "completed" });

    const state = await routeState(fixture, pinned);
    assertEquals(state.health, "healthy");
    assertEquals(state.incident_id, null);
    assert(state.inference_verified_at !== null);
    const closed = await incidents(fixture, pinned);
    assertEquals(closed.length, 1);
    assertEquals(closed[0]!.id, incident);
    assertEquals(closed[0]!.status, "recovered");
    const health = (await fixture.pgDatabase.query<{
      evidence_watermark: string;
    }>(
      `select evidence_watermark from bakery.provider_route_health
        where route_id = $1`,
      [pinned],
    )).rows[0]!;
    assertEquals(
      health.evidence_watermark,
      `attempt:${seeded.assignment.attemptId}`,
    );
  }));

Deno.test("attempt route evidence: a fault that says nothing about the provider records nothing", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedAttempt(fixture);
    const account = await seedAccount(fixture);
    const pinned = await seedRoute(fixture, account);

    await postResult(fixture, seeded, {
      status: "failed",
      code: "CLAUDE_HARNESS_TIMEOUT",
    });

    assertEquals((await routeState(fixture, pinned)).health, "healthy");
    assertEquals(await incidents(fixture, pinned), []);
    const health = await fixture.pgDatabase.query(
      "select 1 from bakery.provider_route_health where route_id = $1",
      [pinned],
    );
    assertEquals(health.rows.length, 0);
  }));

Deno.test("attempt route evidence: evidence written in a transaction that rolls back leaves no incident", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedAttempt(fixture);
    const account = await seedAccount(fixture);
    const pinned = await seedRoute(fixture, account);

    await assertRejects(
      () =>
        withPgTransaction(fixture.pgDatabase, async (transaction) => {
          const results = await recordAttemptRouteEvidence(transaction, {
            organizationId: fixture.organizationId,
            jobId: seeded.assignment.jobId,
            attemptId: seeded.assignment.attemptId,
            status: "failed",
            fault: fault("quota_exceeded"),
            observedAt: new Date(),
          });
          // Inside the transaction the incident is there.
          assertEquals(results.map((result) => result.kind), ["opened"]);
          throw new Error("result rolled back");
        }),
      Error,
      "result rolled back",
    );

    assertEquals((await routeState(fixture, pinned)).health, "healthy");
    assertEquals((await routeState(fixture, pinned)).incident_id, null);
    assertEquals(await incidents(fixture, pinned), []);
  }));
