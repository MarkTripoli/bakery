import { assert, assertEquals, assertRejects } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  cleanupSeededOrganizations,
  type Fixture,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import {
  billing as baseBilling,
  cleanupCoordinatorScopes,
  fund,
  type Scope,
  seedAgentAndTurn,
} from "../helpers/coordinator-turn-jobs.ts";
import {
  rawClaim,
  withCoordinatorWorker,
} from "../helpers/coordinator-turn-jobs-worker.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  admitCoordinatorTurnJob,
  enqueueCoordinatorTurnJob,
  releaseCoordinatorJobReservation,
} from "../../packages/persistence/src/coordinator-jobs.ts";
import { seedConversation } from "../helpers/coordinator-turn-jobs.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  problemCode,
  registeredWorker,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  eventBody,
  postWorkerEvent,
  postWorkerResult,
  resultBody,
} from "../helpers/worker-execution/scenarios.ts";
import { openOutputBinding } from "../../packages/persistence/src/session-output.ts";
import type { WorkerFx } from "../helpers/coordinator-turn-jobs-worker.ts";

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  const organizations: string[] = [];
  const seed = async (label: string) => {
    const created = await seedOrganization(fixture, label, { agent: false });
    organizations.push(created.organizationId);
    return created;
  };
  try {
    await work(Object.assign(fixture, { seed }) as Fixture);
  } finally {
    try {
      for (const id of organizations) {
        await cleanupCoordinatorScopes(fixture.pgDatabase, id);
      }
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

type Seeded = Fixture & {
  seed(label: string): ReturnType<typeof seedOrganization>;
};

/** Small ceiling so many funded jobs fit under the shared installation cap. */
const billing = {
  ...baseBilling,
  maxUsdReservation: 0.02,
  pricingMetadataSnapshot: "coordinator-turn-jobs-price-security",
};

async function funded(fixture: Fixture, label: string) {
  const seed = await (fixture as Seeded).seed(label);
  const scope = await seedAgentAndTurn(fixture.pgDatabase, seed, billing);
  const { job, reservation } = await fund(fixture.runtimePgDatabase, scope);
  return { scope, jobId: job.jobId, reservationId: reservation.reservationId };
}

async function admit(
  fixture: Fixture,
  organizationId: string,
  jobId: string,
): Promise<string> {
  try {
    const result = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) => admitCoordinatorTurnJob(tx, organizationId, jobId),
    );
    return `admitted:${result.capabilities.join(",")}`;
  } catch (error) {
    return String(
      (error as { params?: { reason?: string } }).params?.reason ?? error,
    );
  }
}

async function addVersion(
  fixture: Fixture,
  scope: Scope,
  config: Record<string, unknown>,
): Promise<string> {
  const definition = await fixture.pgDatabase.query<{ id: string }>(
    `select agent_id as id from bakery.agent_versions where id = $1`,
    [scope.agentVersionId],
  );
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, 2, $4::jsonb, $5, $6)`,
    [
      id,
      scope.seed.organizationId,
      definition.rows[0].id,
      JSON.stringify(config),
      `digest-${id}`,
      scope.seed.principalId,
    ],
  );
  return id;
}

/** Rewrites version config and the job's frozen copy together (consistent drift). */
async function setConfig(
  fixture: Fixture,
  scope: Scope,
  jobId: string,
  config: Record<string, unknown> | null,
  jobBilling?: Record<string, unknown>,
) {
  if (config !== null) {
    await fixture.pgDatabase.query(
      `update bakery.agent_versions set config = $2::jsonb where id = $1`,
      [scope.agentVersionId, JSON.stringify(config)],
    );
  }
  await fixture.pgDatabase.query(
    `update bakery.jobs set agent_config = $2::jsonb,
            billing = coalesce($3::jsonb, billing) where id = $1`,
    [
      jobId,
      JSON.stringify(config ?? {}),
      jobBilling === undefined ? null : JSON.stringify(jobBilling),
    ],
  );
}

Deno.test("admission accepts the funded, pinned, subscription job", () =>
  withFixture(async (fixture) => {
    const { scope, jobId } = await funded(fixture, "cjs-ok");
    assertEquals(
      await admit(fixture, scope.seed.organizationId, jobId),
      "admitted:model",
    );
  }));

Deno.test("agent pin rules: version differs, not active, definition disabled, config drift", () =>
  withFixture(async (fixture) => {
    const differs = await funded(fixture, "cjs-pin-differs");
    const other = await addVersion(
      fixture,
      differs.scope,
      differs.scope.agentConfig,
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set agent_version_id = $2 where id = $1`,
      [differs.jobId, other],
    );
    assertEquals(
      await admit(fixture, differs.scope.seed.organizationId, differs.jobId),
      "coordinator_agent_pin_mismatch",
    );

    const stale = await funded(fixture, "cjs-pin-stale");
    const newer = await addVersion(
      fixture,
      stale.scope,
      stale.scope.agentConfig,
    );
    await fixture.pgDatabase.query(
      `update bakery.agent_definitions set active_version_id = $2
        where organization_id = $1 and slug = 'coordinator'`,
      [stale.scope.seed.organizationId, newer],
    );
    assertEquals(
      await admit(fixture, stale.scope.seed.organizationId, stale.jobId),
      "coordinator_agent_pin_mismatch",
    );

    const disabled = await funded(fixture, "cjs-pin-disabled");
    await fixture.pgDatabase.query(
      `update bakery.agent_definitions set enabled = false
        where organization_id = $1 and slug = 'coordinator'`,
      [disabled.scope.seed.organizationId],
    );
    assertEquals(
      await admit(fixture, disabled.scope.seed.organizationId, disabled.jobId),
      "coordinator_agent_pin_mismatch",
    );

    const drift = await funded(fixture, "cjs-config-drift");
    await fixture.pgDatabase.query(
      `update bakery.jobs set agent_config = agent_config ||
              '{"allowedCapabilities":["model","git"]}'::jsonb where id = $1`,
      [drift.jobId],
    );
    assertEquals(
      await admit(fixture, drift.scope.seed.organizationId, drift.jobId),
      "coordinator_agent_config_mismatch",
    );

    const noAgent = await funded(fixture, "cjs-no-agent");
    await fixture.pgDatabase.query(
      `update bakery.jobs set agent_version_id = null where id = $1`,
      [noAgent.jobId],
    );
    assertEquals(
      await admit(fixture, noAgent.scope.seed.organizationId, noAgent.jobId),
      "model_agent_required",
    );
  }));

Deno.test("policy rules: no billing, no model capability, wrong harness", () =>
  withFixture(async (fixture) => {
    const noBilling = await funded(fixture, "cjs-no-billing");
    await setConfig(fixture, noBilling.scope, noBilling.jobId, {
      harness: "claude_code",
      allowedCapabilities: ["model"],
    });
    assertEquals(
      await admit(
        fixture,
        noBilling.scope.seed.organizationId,
        noBilling.jobId,
      ),
      "model_billing_required",
    );

    const noModel = await funded(fixture, "cjs-no-model");
    await setConfig(fixture, noModel.scope, noModel.jobId, {
      harness: "claude_code",
      billing,
      allowedCapabilities: ["git"],
    });
    assertEquals(
      await admit(fixture, noModel.scope.seed.organizationId, noModel.jobId),
      "agent_action_capability_denied",
    );

    const codex = await funded(fixture, "cjs-harness");
    await setConfig(fixture, codex.scope, codex.jobId, {
      harness: "codex",
      billing,
      allowedCapabilities: ["model"],
    });
    assertEquals(
      await admit(fixture, codex.scope.seed.organizationId, codex.jobId),
      "coordinator_harness_unsupported",
    );
  }));

Deno.test("billing rules: job billing drift and non-subscription route", () =>
  withFixture(async (fixture) => {
    const drift = await funded(fixture, "cjs-billing-drift");
    await fixture.pgDatabase.query(
      `update bakery.jobs set billing = billing || '{"maxTokens":1}'::jsonb
        where id = $1`,
      [drift.jobId],
    );
    assertEquals(
      await admit(fixture, drift.scope.seed.organizationId, drift.jobId),
      "coordinator_billing_mismatch",
    );

    const api = await funded(fixture, "cjs-billing-api");
    const apiBilling = { ...billing, billingRoute: "api" };
    await setConfig(
      fixture,
      api.scope,
      api.jobId,
      {
        harness: "claude_code",
        billing: apiBilling,
        allowedCapabilities: ["model"],
      },
      apiBilling,
    );
    assertEquals(
      await admit(fixture, api.scope.seed.organizationId, api.jobId),
      "coordinator_billing_unsupported",
    );
  }));

Deno.test("turn and input rules: inactive turn, turn id mismatch, malformed input", () =>
  withFixture(async (fixture) => {
    const inactive = await funded(fixture, "cjs-turn-inactive");
    await fixture.pgDatabase.query(
      `update bakery.conversation_turns set status = 'cancel_requested'
        where id = $1`,
      [inactive.scope.turnId],
    );
    assertEquals(
      await admit(fixture, inactive.scope.seed.organizationId, inactive.jobId),
      "coordinator_turn_not_active",
    );

    const wrongTurn = await funded(fixture, "cjs-input-turn");
    await fixture.pgDatabase.query(
      `update bakery.jobs set input = jsonb_set(input, '{turnId}', to_jsonb($2::text))
        where id = $1`,
      [wrongTurn.jobId, crypto.randomUUID()],
    );
    assertEquals(
      await admit(
        fixture,
        wrongTurn.scope.seed.organizationId,
        wrongTurn.jobId,
      ),
      "coordinator_job_input_invalid",
    );

    const malformed = await funded(fixture, "cjs-input-bad");
    await fixture.pgDatabase.query(
      `update bakery.jobs set input = '{"turnId":"x"}'::jsonb where id = $1`,
      [malformed.jobId],
    );
    assertEquals(
      await admit(
        fixture,
        malformed.scope.seed.organizationId,
        malformed.jobId,
      ),
      "coordinator_job_input_invalid",
    );
  }));

Deno.test("funding rules: missing, released, wrong dedupe key, wrong amount, other org", () =>
  withFixture(async (fixture) => {
    const missing = await funded(fixture, "cjs-fund-missing");
    await fixture.pgDatabase.query(
      `update bakery.jobs set installation_reservation_id = null where id = $1`,
      [missing.jobId],
    );
    assertEquals(
      await admit(fixture, missing.scope.seed.organizationId, missing.jobId),
      "coordinator_funding_unavailable",
    );

    const released = await funded(fixture, "cjs-fund-released");
    await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        releaseCoordinatorJobReservation(tx, {
          organizationId: released.scope.seed.organizationId,
          jobId: released.jobId,
        }),
    );
    assertEquals(
      await admit(fixture, released.scope.seed.organizationId, released.jobId),
      "coordinator_funding_unavailable",
    );

    const dedupe = await funded(fixture, "cjs-fund-dedupe");
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set dedupe_key = 'coordinator-turn:other'
        where id = $1`,
      [dedupe.reservationId],
    );
    assertEquals(
      await admit(fixture, dedupe.scope.seed.organizationId, dedupe.jobId),
      "coordinator_funding_unavailable",
    );
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set dedupe_key = $2 where id = $1`,
      [dedupe.reservationId, `coordinator-turn:${dedupe.scope.turnId}`],
    );

    const amount = await funded(fixture, "cjs-fund-amount");
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set reserved_usd = reserved_usd + 0.01
        where id = $1`,
      [amount.reservationId],
    );
    assertEquals(
      await admit(fixture, amount.scope.seed.organizationId, amount.jobId),
      "coordinator_funding_unavailable",
    );
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set reserved_usd = reserved_usd - 0.01
        where id = $1`,
      [amount.reservationId],
    );

    const mine = await funded(fixture, "cjs-fund-mine");
    const theirs = await funded(fixture, "cjs-fund-theirs");
    await fixture.pgDatabase.query(
      `update bakery.jobs set installation_reservation_id = $2 where id = $1`,
      [mine.jobId, theirs.reservationId],
    );
    assertEquals(
      await admit(fixture, mine.scope.seed.organizationId, mine.jobId),
      "coordinator_funding_unavailable",
    );
  }));

Deno.test("cross-org admission finds nothing and bakery_app cannot move a job to another turn", () =>
  withFixture(async (fixture) => {
    const mine = await funded(fixture, "cjs-xorg-mine");
    const theirs = await funded(fixture, "cjs-xorg-theirs");
    assertEquals(
      await admit(fixture, theirs.scope.seed.organizationId, mine.jobId),
      "coordinator_turn_unavailable",
    );
    let code: string | undefined;
    try {
      await fixture.runtimePgDatabase.query(
        `update bakery.jobs set conversation_turn_id = $2 where id = $1`,
        [mine.jobId, theirs.scope.turnId],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assertEquals(code, "42501");
  }));

Deno.test("enqueue rejects a run or repository pin in TypeScript", () =>
  withFixture(async (fixture) => {
    const seed = await (fixture as Seeded).seed("cjs-pin");
    const scope = await seedAgentAndTurn(fixture.pgDatabase, seed, billing);
    const { reservation } = await fund(fixture.runtimePgDatabase, scope);
    for (const pin of ["runStepId", "repositoryId", "baseSha"]) {
      let reason = "";
      try {
        await withPgTransaction(
          fixture.runtimePgDatabase,
          (tx) =>
            enqueueCoordinatorTurnJob(tx, {
              organizationId: scope.seed.organizationId,
              turnId: scope.turnId,
              agentVersionId: scope.agentVersionId,
              agentConfig: scope.agentConfig,
              billing: billing as unknown as Record<string, unknown>,
              installationReservationId: reservation.reservationId,
              input: {},
              [pin]: "x",
            } as never),
        );
      } catch (error) {
        reason = String(
          (error as { params?: { reason?: string } }).params?.reason,
        );
      }
      assertEquals(reason, "coordinator_job_pin_forbidden", pin);
    }
  }));

Deno.test("claim leaves a drifted job queued with no attempt, and another org's host never sees it", () =>
  withCoordinatorWorker(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "cjs-claim" });
    const mineSeed = await seedConversation(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      "cjs-claim",
    );
    const mine = await seedAgentAndTurn(fixture.pgDatabase, mineSeed, billing);
    const { job } = await fund(fixture.runtimePgDatabase, mine);
    await fixture.pgDatabase.query(
      `update bakery.jobs set billing = billing || '{"maxTokens":1}'::jsonb
        where id = $1`,
      [job.jobId],
    );
    const drifted = await rawClaim(fixture, worker, {
      capabilities: ["model"],
      supportedActions: ["coordinator.turn"],
    });
    assertEquals(drifted.status, 204);
    await drifted.body?.cancel();

    // Another organization's valid job is invisible to this host.
    const other = await seedOrganization(fixture, "cjs-claim-other", {
      agent: false,
    });
    try {
      const theirs = await seedAgentAndTurn(fixture.pgDatabase, other, billing);
      await fund(fixture.runtimePgDatabase, theirs);
      const response = await rawClaim(fixture, worker, {
        capabilities: ["model"],
        supportedActions: ["coordinator.turn"],
      });
      assertEquals(response.status, 204);
      await response.body?.cancel();
      const attempts = await fixture.pgDatabase.query(
        `select 1 from bakery.job_attempts
          where job_id in (select id from bakery.jobs where conversation_turn_id is not null)`,
      );
      assertEquals(attempts.rows.length, 0);
    } finally {
      await cleanupCoordinatorScopes(fixture.pgDatabase, other.organizationId);
      await cleanupSeededOrganizations(fixture);
    }
  }));

// ---- Phase 3b: lifecycle and result negatives -----------------------------

async function claimedCoordinator(fixture: WorkerFx, label: string) {
  const worker = await registeredWorker(fixture, { name: `${label}-worker` });
  const seed = await seedConversation(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    label,
  );
  const scope = await seedAgentAndTurn(fixture.pgDatabase, seed, billing);
  await fund(fixture.runtimePgDatabase, scope);
  const assignment = await claimAssignment(fixture, worker, {
    supportedActions: ["coordinator.turn"],
  });
  return { worker, scope, assignment };
}

async function untouched(
  fixture: WorkerFx,
  scope: Scope,
  jobId: string,
): Promise<void> {
  const job = await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.jobs where id = $1`,
    [jobId],
  );
  assertEquals(job.rows[0].status, "leased");
  const reservation = await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.budget_reservations
      where organization_id = $1 and dedupe_key = $2`,
    [fixture.organizationId, `coordinator-turn:${scope.turnId}`],
  );
  assertEquals(reservation.rows[0].status, "held");
}

const output = {
  effects: [{ type: "reply", body: "ok" }],
  model: "claude-opus-5-5",
  claudeCodeVersion: "2.1.296",
};

Deno.test("a usage receipt on a coordinator result is refused and nothing settles", () =>
  withCoordinatorWorker(async (fixture) => {
    const { worker, scope, assignment } = await claimedCoordinator(
      fixture,
      "cjs-usage",
    );
    const response = await postWorkerResult(
      fixture,
      worker,
      assignment,
      {
        ...resultBody(assignment, { result: output }),
        usage: {
          usageFactId: "cjs-usage-fact",
          providerCallId: "cjs-usage-call",
          provider: "anthropic",
          billingAccountId: billing.billingAccountId,
          model: billing.model,
          billingRoute: "subscription",
          pricingMetadataSnapshot: billing.pricingMetadataSnapshot,
          inputTokens: "11",
          outputTokens: "7",
          costUsd: "0.000100",
          measurement: "reported",
          occurredAt: new Date().toISOString(),
        },
      },
      crypto.randomUUID(),
    );
    assertEquals(response.status, 409);
    assertEquals(await problemCode(response), "STATE_CONFLICT");
    await untouched(fixture, scope, assignment.jobId);
    const usage = await fixture.pgDatabase.query(
      `select 1 from bakery.usage_records where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(usage.rows.length, 0);
  }));

Deno.test("an output binding for a coordinator attempt is refused", () =>
  withCoordinatorWorker(async (fixture) => {
    const { assignment } = await claimedCoordinator(fixture, "cjs-binding");
    const attempt = await fixture.pgDatabase.query<{
      hostId: string;
      sessionId: string;
      generation: string;
    }>(
      `select worker_host_id as "hostId", worker_session_id as "sessionId",
              worker_session_generation::text as generation
         from bakery.job_attempts where id = $1`,
      [assignment.attemptId],
    );
    const row = attempt.rows[0];
    await assertRejects(
      () =>
        withPgTransaction(
          fixture.pgDatabase,
          (tx) =>
            openOutputBinding(tx, {
              organizationId: fixture.organizationId,
              attemptId: assignment.attemptId,
              jobId: assignment.jobId,
              workerHostId: row.hostId,
              workerSessionId: row.sessionId,
              workerSessionGeneration: row.generation,
              fence: assignment.fence,
            }),
        ),
      Error,
    );
    const streams = await fixture.pgDatabase.query(
      `select 1 from bakery.session_output_streams where job_id = $1`,
      [assignment.jobId],
    );
    assertEquals(streams.rows.length, 0);
  }));

Deno.test("a coordinator event naming an effect, artifact or session is refused", () =>
  withCoordinatorWorker(async (fixture) => {
    const { worker, scope, assignment } = await claimedCoordinator(
      fixture,
      "cjs-refs",
    );
    const eventId = crypto.randomUUID();
    const response = await postWorkerEvent(
      fixture,
      worker,
      assignment,
      eventBody(assignment, eventId, "1", undefined, {
        eventType: "job.effect_pending",
        payload: { externalEffectId: crypto.randomUUID() },
      }),
      eventId,
    );
    assertEquals(response.status, 404);
    assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND");
    await untouched(fixture, scope, assignment.jobId);
    const events = await fixture.pgDatabase.query(
      `select 1 from bakery.attempt_events where attempt_id = $1`,
      [assignment.attemptId],
    );
    assertEquals(events.rows.length, 0);
  }));

Deno.test("another organization's host cannot submit a coordinator result", () =>
  withCoordinatorWorker(async (fixture) => {
    const { scope, assignment } = await claimedCoordinator(
      fixture,
      "cjs-xorg-result",
    );
    const foreignScope = await createWorkerScope(
      fixture,
      "cjs-foreign",
      fixture,
    );
    try {
      const foreign = await registeredWorker(fixture, {
        scope: foreignScope,
      });
      const response = await postWorkerResult(
        fixture,
        foreign,
        assignment,
        resultBody(assignment, { result: output }),
        crypto.randomUUID(),
      );
      assert(response.status >= 400);
      await response.body?.cancel();
      await untouched(fixture, scope, assignment.jobId);
    } finally {
      await closeWorkerScope(fixture, foreignScope);
    }
  }));
