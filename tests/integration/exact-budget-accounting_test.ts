import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  bindProviderCallIntent,
  budgetContentDigest,
  findProviderUsageReceiptCandidates,
  parseMicroUsd,
  readPersistedUsageFact,
  readRunBudgetSummary,
  reconcileExpiredBudgetReservations,
  reconcileProviderUsageReceipt,
  recordProviderUsageReceipt,
  releaseWorkflowAction,
  reserveWorkflowAction,
  settleWorkflowAction,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import { readUsageSummary } from "../../apps/server/src/modules/work/usage.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  expireAndSupersedeAttempt,
  openWorkerFixture,
  problemCode,
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import {
  admitFundedModelRun as admit,
  admitWithoutBudget,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import type { AdmittedJob as Admission } from "../helpers/funded-model-job.ts";
import {
  claimAssignment,
  postWorkerResult,
  type RegisteredWorker,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

import { claimEffect } from "../../apps/server/src/modules/effects/claim.ts";
import { prepareEffect } from "../../apps/server/src/modules/effects/index.ts";
import {
  claimDepsFor,
  effectRegistry,
  forceEffectStatus,
  seededEffectRig,
} from "../helpers/external-effects.ts";
import { reconcileBudgetLedger } from "../../apps/server/src/modules/work/budget-recovery.ts";

const policy = {
  installationMonthlyLimitUsd: "1.000000",
  reservationTtlSeconds: 3_600,
  maxRunDurationSeconds: 86_400,
} as const;
const fixedFault = (retryable = false) => ({
  type: "about:blank",
  title: "Worker execution failed",
  status: 500,
  detail: "budget accounting test",
  code: "BUDGET_TEST_FAILURE",
  requestId: crypto.randomUUID(),
  retryable,
});

async function accountRows(
  database: PgDatabase,
  organizationId: string,
  runId: string,
) {
  return (await database.query<{
    scope: string;
    runId: string | null;
    periodStart: string;
    limitUsd: string;
    reservedUsd: string;
    settledUsd: string;
  }>(
    `select scope, run_id as "runId", period_start::text as "periodStart",
            limit_usd::text as "limitUsd", reserved_usd::text as "reservedUsd",
            settled_usd::text as "settledUsd"
       from bakery.budget_accounts
      where (organization_id = $1 and run_id = $2)
         or (organization_id is null and scope = 'installation'
             and period_start = date_trunc('month', clock_timestamp() at time zone 'UTC')
                              at time zone 'UTC')
      order by scope`,
    [organizationId, runId],
  )).rows;
}

async function intentRows(
  database: PgDatabase,
  organizationId: string,
  runId: string,
) {
  return (await database.query<{
    id: string;
    status: string;
    reservedUsd: string;
    installationReservationId: string | null;
    runReservationId: string | null;
  }>(
    `select id, status, reserved_usd::text as "reservedUsd",
            installation_reservation_id as "installationReservationId",
            run_reservation_id as "runReservationId"
       from bakery.budget_action_intents
      where organization_id = $1 and run_id = $2`,
    [organizationId, runId],
  )).rows;
}
// Synthetic consumer fixture only; this is not a production evidence producer.
async function insertSyntheticReleaseEvidence(
  database: PgDatabase,
  run: Admission,
): Promise<string> {
  return await withPgTransaction(database, async (transaction) => {
    const job = (await transaction.query<{ jobVersion: number }>(
      `update bakery.jobs
          set status = 'failed', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'queued'
        returning version as "jobVersion"`,
      [run.organizationId, run.jobId],
    )).rows[0];
    assertExists(job);
    const sourceEvent = (await transaction.query<{ id: string }>(
      `insert into bakery.audit_events (
         organization_id, principal_id, operation, resource_type, resource_id,
         outcome, request_id, trace_id, details
       ) values (
         $1, $2, 'workers.claim.assignment_payload_rejected', 'job', $3,
         'denied', $4, $5, $6::jsonb
       )
       returning id`,
      [
        run.organizationId,
        run.principalId,
        run.jobId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({
          code: "INVALID_ASSIGNMENT_PAYLOAD",
          version: job.jobVersion,
        }),
      ],
    )).rows[0];
    assertExists(sourceEvent);
    const effectId =
      `budget-assignment-rejection:${run.jobId}:${job.jobVersion}`;
    const digest = await sha256Hex(canonicalJson([
      "budget-assignment-rejection-v1",
      "INVALID_ASSIGNMENT_PAYLOAD",
      run.organizationId,
      run.jobId,
      job.jobVersion,
      null,
      run.installationReservationId,
      effectId,
      sourceEvent.id,
    ]));
    const evidence = (await transaction.query<{ id: string }>(
      `insert into bakery.budget_release_evidence (
         organization_id, installation_reservation_id, job_id, job_version,
         attempt_id, effect_id, source_event_id, kind, digest, observed_at
       ) values ($1, $2, $3, $4, null, $5, $6, 'pre-dispatch-rejection',
                 $7, clock_timestamp())
       returning id`,
      [
        run.organizationId,
        run.installationReservationId,
        run.jobId,
        job.jobVersion,
        effectId,
        sourceEvent.id,
        digest,
      ],
    )).rows[0];
    assertExists(evidence);
    return evidence.id;
  });
}

async function claimRequestForRun(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  run: Admission,
): Promise<Response> {
  const claimKey = crypto.randomUUID();
  return await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
      supportedActions: [run.action],
    },
    { idempotencyKey: claimKey },
  );
}

async function claimMalformedAssignment(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  run: Admission,
): Promise<Response> {
  await fixture.pgDatabase.query(
    `update bakery.jobs
        set current_checkpoints = $3::jsonb
      where organization_id = $1 and id = $2`,
    [run.organizationId, run.jobId, JSON.stringify({ malformed: true })],
  );
  return await claimRequestForRun(fixture, worker, run);
}

async function budgetEvidenceState(
  database: PgDatabase,
  run: Admission,
): Promise<{
  jobStatus: string;
  attemptCount: string;
  intentStatus: string;
  reservationStatus: string;
  evidenceCount: string;
}> {
  const row = (await database.query<{
    jobStatus: string;
    attemptCount: string;
    intentStatus: string;
    reservationStatus: string;
    evidenceCount: string;
  }>(
    `select job.status as "jobStatus",
            count(distinct attempt.id)::text as "attemptCount",
            intent.status as "intentStatus",
            reservation.status as "reservationStatus",
            count(distinct evidence.id)::text as "evidenceCount"
       from bakery.jobs job
       join bakery.budget_action_intents intent
         on intent.organization_id = job.organization_id
        and intent.installation_reservation_id = job.installation_reservation_id
       join bakery.budget_reservations reservation
         on reservation.organization_id = job.organization_id
        and reservation.id = job.installation_reservation_id
       left join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
       left join bakery.budget_release_evidence evidence
         on evidence.organization_id = job.organization_id
        and evidence.installation_reservation_id =
          job.installation_reservation_id
      where job.organization_id = $1 and job.id = $2
      group by job.status, intent.status, reservation.status`,
    [run.organizationId, run.jobId],
  )).rows[0];
  assertExists(row);
  return row;
}

function receipt(
  run: Admission,
  suffix: string,
  options: Readonly<{
    costUsd: string | null;
    measurement: UsageReceipt["measurement"];
    occurredAt?: string;
    provider?: string;
  }>,
): UsageReceipt {
  return {
    usageFactId: `${run.runId}-${suffix}`,
    providerCallId: `${run.runId}-provider-call-${suffix}`,
    provider: options.provider ?? "openai",
    billingAccountId: String(run.billing?.billingAccountId),
    model: String(run.billing?.model),
    billingRoute: "api",
    pricingMetadataSnapshot: "budget-test-price-v1",
    inputTokens: "1",
    outputTokens: "2",
    costUsd: options.costUsd,
    measurement: options.measurement,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
  };
}

async function publishProviderReceipt(
  database: PgDatabase,
  run: Admission,
  providerReceipt: UsageReceipt,
): Promise<void> {
  await withPgTransaction(database, async (transaction) => {
    await bindProviderCallIntent(transaction, {
      organizationId: run.organizationId,
      installationReservationId: run.installationReservationId,
      providerCallId: providerReceipt.providerCallId,
    });
    const callIntent = (await transaction.query<{ id: string }>(
      `select provider_call_intent_id as id
         from bakery.budget_action_intents
        where organization_id = $1 and installation_reservation_id = $2`,
      [run.organizationId, run.installationReservationId],
    )).rows[0];
    assertExists(callIntent);
    await recordProviderUsageReceipt(transaction, {
      organizationId: run.organizationId,
      providerCallIntentId: callIntent.id,
      receipt: providerReceipt,
    });
  });
}

function failedResult(
  assignment: WorkerAssignment,
  usage: UsageReceipt,
  localSeq = "1",
  retryable = false,
) {
  return {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq,
    status: "failed" as const,
    fault: fixedFault(retryable),
    usage,
  };
}

function canceledResult(
  assignment: WorkerAssignment,
  usage: UsageReceipt,
) {
  return {
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    localSeq: "1",
    status: "canceled" as const,
    cancellation: {
      processExited: true,
      exitedAt: new Date().toISOString(),
      cleanupStatus: "complete" as const,
    },
    usage,
  };
}

async function submitFailure(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  run: Admission,
  usage: UsageReceipt,
  retryable = false,
): Promise<Response> {
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, run.jobId);
  await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    if (usage.measurement === "unknown") {
      await bindProviderCallIntent(transaction, {
        organizationId: run.organizationId,
        installationReservationId: run.installationReservationId,
        providerCallId: usage.providerCallId,
      });
    }
  });
  if (usage.measurement !== "unknown") {
    await publishProviderReceipt(fixture.pgDatabase, run, usage);
  }
  const body = failedResult(assignment, usage, "1", retryable);
  const response = await postWorkerResult(
    fixture,
    worker,
    assignment,
    body,
    crypto.randomUUID(),
  );
  if (response.status !== 200) {
    throw new Error(
      `WORKER_RESULT_${response.status}:${await response.text()}`,
    );
  }
  return response;
}

async function runGet(
  fixture: WorkerFixture,
  path: string,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(`http://127.0.0.1:8788${path}`, {
      headers: {
        cookie: fixture.adminCookie,
        origin: "http://127.0.0.1:8788",
        "Bakery-Organization-Id": fixture.organizationId,
      },
    }),
  );
}

async function runControl(
  fixture: WorkerFixture,
  runId: string,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(`http://127.0.0.1:8788/v1/runs/${runId}/controls`, {
      method: "POST",
      headers: {
        cookie: fixture.adminCookie,
        origin: "http://127.0.0.1:8788",
        "Bakery-Organization-Id": fixture.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "cancel" }),
    }),
  );
}

Deno.test("real model admission and worker receipts preserve exact paired accounting", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  await seedProviderPricingSnapshot(database);
  const worker = await registeredWorker(fixture, { slots: 8 });
  const installationAdmin = fixture.principalId;
  let secondOrganization: string | undefined;
  let secondScope: WorkerScope | undefined;
  try {
    const installationGrant = async () =>
      (await database.query(
        `select principal_id, granted_by_principal_id, created_at,
                revoked_at, version, updated_at
         from bakery.installation_administrators where principal_id = $1`,
        [installationAdmin],
      )).rows;
    const bootstrapGrant = await installationGrant();
    assertEquals(bootstrapGrant.length, 1);
    assertEquals(bootstrapGrant[0].granted_by_principal_id, installationAdmin);
    assertEquals(bootstrapGrant[0].revoked_at, null);
    // Same-run readmission returns the already admitted job and does not add holds.
    const replayRun = await seedRun(
      database,
      fixture.organizationId,
      fixture.principalId,
      {
        reservationUsd: "0.1",
        stepKey: "same-run-replay",
      },
    );
    const firstReplay = await admit(database, replayRun);
    const secondReplay = await admit(database, replayRun);
    assertEquals(secondReplay.jobId, firstReplay.jobId);
    assertEquals(
      (await intentRows(database, fixture.organizationId, replayRun.runId))
        .length,
      1,
    );
    const replayResult = await withPgTransaction(
      database,
      async (transaction) =>
        await reserveWorkflowAction(transaction, {
          organizationId: replayRun.organizationId,
          runId: replayRun.runId,
          runStepId: replayRun.runStepId,
          action: replayRun.action,
          actionVersion: replayRun.workflowVersionId,
          contentDigest: replayRun.contentDigest,
          agentVersionId: String(replayRun.agent?.agentVersionId),
          billing: replayRun.billing,
          policy,
        }),
    );
    assertEquals(
      replayResult?.installationReservationId,
      firstReplay.installationReservationId,
    );
    await assertRejects(
      () =>
        withPgTransaction(
          database,
          async (transaction) =>
            await reserveWorkflowAction(transaction, {
              organizationId: replayRun.organizationId,
              runId: replayRun.runId,
              runStepId: replayRun.runStepId,
              action: replayRun.action,
              actionVersion: replayRun.workflowVersionId,
              contentDigest: "f".repeat(64),
              agentVersionId: String(replayRun.agent?.agentVersionId),
              billing: replayRun.billing,
              policy,
            }),
        ),
      StandardError,
      "STATE_CONFLICT",
    );
    const replayEvidenceId = await insertSyntheticReleaseEvidence(
      database,
      firstReplay,
    );
    await withPgTransaction(
      database,
      async (transaction) =>
        await releaseWorkflowAction(transaction, {
          organizationId: replayRun.organizationId,
          installationReservationId: firstReplay.installationReservationId,
          evidenceId: replayEvidenceId,
        }),
    );
    const releasedReplay =
      (await intentRows(database, fixture.organizationId, replayRun.runId))[0];
    assertEquals(releasedReplay?.status, "released");
    await database.query(
      `update bakery.jobs
            set status = 'canceled', updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2 and status = 'queued'`,
      [firstReplay.organizationId, firstReplay.jobId],
    );

    const deferredRelease = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "deferred-release",
      }),
    );
    const deferredEvidenceId = await insertSyntheticReleaseEvidence(
      database,
      deferredRelease,
    );
    await withPgTransaction(database, async (transaction) => {
      await transaction.query(
        `update bakery.budget_reservations
            set expires_at = clock_timestamp() - interval '1 second'
          where organization_id = $1 and id in ($2, $3)`,
        [
          deferredRelease.organizationId,
          deferredRelease.installationReservationId,
          deferredRelease.runReservationId,
        ],
      );
      const candidates = await reconcileExpiredBudgetReservations(transaction);
      assertEquals(candidates, 1);
      await releaseWorkflowAction(transaction, {
        organizationId: deferredRelease.organizationId,
        installationReservationId: deferredRelease.installationReservationId,
        evidenceId: deferredEvidenceId,
      });
    });
    assertEquals(
      (await intentRows(
        database,
        deferredRelease.organizationId,
        deferredRelease.runId,
      ))[0]?.status,
      "released",
    );
    await database.query(
      `update bakery.jobs
          set status = 'canceled', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'queued'`,
      [deferredRelease.organizationId, deferredRelease.jobId],
    );

    // Two real admissions race for one global 1.0 cap. Only one transaction owns paired holds.
    secondScope = await createWorkerScope(
      fixture,
      "budget-second-tenant",
      fixture,
    );
    secondOrganization = secondScope.organizationId;
    const capRunA = await seedRun(
      database,
      fixture.organizationId,
      fixture.principalId,
      {
        reservationUsd: "0.6",
        stepKey: "cap-a",
      },
    );
    const capRunB = await seedRun(
      database,
      secondOrganization,
      fixture.principalId,
      {
        reservationUsd: "0.6",
        stepKey: "cap-b",
      },
    );
    const raced = await Promise.allSettled([
      admit(database, capRunA),
      admit(database, capRunB),
    ]);
    assertEquals(
      raced.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals(
      raced.filter((result) => result.status === "rejected").length,
      1,
    );
    const capWinner = raced.find((result) => result.status === "fulfilled");
    assert(capWinner?.status === "fulfilled");
    const capWinnerRows = await intentRows(
      database,
      capWinner.value.organizationId,
      capWinner.value.runId,
    );
    assertEquals(capWinnerRows.length, 1);
    assertEquals(capWinnerRows[0]?.status, "held");
    const allCapRows = (await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.budget_reservations
          where status = 'held' and reserved_usd = 0.6`,
    )).rows[0];
    assertEquals(allCapRows?.count, "2");
    const capRowsA = await intentRows(
      database,
      capRunA.organizationId,
      capRunA.runId,
    );
    const capRowsB = await intentRows(
      database,
      capRunB.organizationId,
      capRunB.runId,
    );
    assertEquals([capRowsA.length, capRowsB.length].sort(), [0, 1]);
    const capEvidenceId = await insertSyntheticReleaseEvidence(
      database,
      capWinner.value,
    );
    await withPgTransaction(
      database,
      async (transaction) =>
        await releaseWorkflowAction(transaction, {
          organizationId: capWinner.value.organizationId,
          installationReservationId: capWinner.value.installationReservationId,
          evidenceId: capEvidenceId,
        }),
    );
    await database.query(
      `update bakery.jobs
          set status = 'canceled', updated_at = now(), version = version + 1
        where run_step_id = any($1::uuid[]) and status = 'queued'`,
      [[capRunA.runStepId, capRunB.runStepId]],
    );

    // Two independent real jobs settle through the authenticated worker result route: .1 + .2 = .3.
    const decimalA = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "decimal-a",
      }),
    );
    const decimalB = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.2",
        stepKey: "decimal-b",
      }),
    );
    const decimalAReceipt = receipt(decimalA, "decimal-a", {
      costUsd: "0.1",
      measurement: "reported",
    });
    const decimalBReceipt = receipt(decimalB, "decimal-b", {
      costUsd: "0.2",
      measurement: "reported",
    });
    assertEquals(
      (await submitFailure(fixture, worker, decimalA, decimalAReceipt)).status,
      200,
    );
    assertEquals(
      (await submitFailure(fixture, worker, decimalB, decimalBReceipt)).status,
      200,
    );
    const decimalAccounts = await accountRows(
      database,
      fixture.organizationId,
      decimalA.runId,
    );
    const decimalInstallation = decimalAccounts.find((row) =>
      row.scope === "installation"
    );
    assertEquals(decimalInstallation?.settledUsd, "0.300000");
    assertEquals(decimalInstallation?.reservedUsd, "0.000000");
    const secondTenantScope = secondScope;
    assertExists(secondTenantScope);
    const secondWorker = await registeredWorker(fixture, {
      name: "budget-second-tenant",
      scope: secondTenantScope,
    });
    const secondSettled = await admit(
      database,
      await seedRun(database, secondOrganization!, fixture.principalId, {
        reservationUsd: "0.07",
        stepKey: "second-tenant-settled",
      }),
    );
    const secondSettledReceipt = receipt(secondSettled, "second-tenant", {
      costUsd: "0.07",
      measurement: "reported",
    });
    assertEquals(
      (await submitFailure(
        fixture,
        secondWorker,
        secondSettled,
        secondSettledReceipt,
      )).status,
      200,
    );
    const sharedBeforeSecondCleanup = (await accountRows(
      database,
      fixture.organizationId,
      decimalA.runId,
    )).find((row) => row.scope === "installation");
    assertEquals(sharedBeforeSecondCleanup?.settledUsd, "0.370000");
    assertEquals(sharedBeforeSecondCleanup?.reservedUsd, "0.000000");
    const omittedRun = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "omitted-receipt-fields",
      }),
    );
    const omittedReceipt = receipt(omittedRun, "omitted", {
      costUsd: null,
      measurement: "unknown",
    });
    const omittedAssignment = await claimAssignment(fixture, worker);
    assertEquals(omittedAssignment.jobId, omittedRun.jobId);
    await withPgTransaction(database, async (transaction) => {
      await bindProviderCallIntent(transaction, {
        organizationId: omittedRun.organizationId,
        installationReservationId: omittedRun.installationReservationId,
        providerCallId: omittedReceipt.providerCallId,
      });
    });
    const omittedBody = failedResult(omittedAssignment, omittedReceipt);
    const {
      inputTokens: _omittedInputTokens,
      outputTokens: _omittedOutputTokens,
      costUsd: _omittedCostUsd,
      ...omittedUsage
    } = omittedBody.usage;
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        omittedAssignment,
        { ...omittedBody, usage: omittedUsage },
        crypto.randomUUID(),
      )).status,
      200,
    );
    const omittedStored = (await database.query<{
      inputTokens: string | null;
      outputTokens: string | null;
      costUsd: string | null;
    }>(
      `select input_tokens as "inputTokens",
              output_tokens as "outputTokens",
              cost_usd::text as "costUsd"
         from bakery.usage_records
        where organization_id = $1 and usage_fact_id = $2`,
      [omittedRun.organizationId, omittedReceipt.usageFactId],
    )).rows[0];
    assertEquals(omittedStored, {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    const duplicateRun = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "duplicate-result",
      }),
    );
    const duplicateAssignment = await claimAssignment(fixture, worker);
    assertEquals(duplicateAssignment.jobId, duplicateRun.jobId);
    const duplicateReceipt = receipt(duplicateRun, "duplicate", {
      costUsd: "0.05",
      measurement: "reported",
    });
    await publishProviderReceipt(database, duplicateRun, duplicateReceipt);
    const duplicateBody = failedResult(duplicateAssignment, duplicateReceipt);
    const duplicateKey = crypto.randomUUID();
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        duplicateAssignment,
        duplicateBody,
        duplicateKey,
      )).status,
      200,
    );
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        duplicateAssignment,
        duplicateBody,
        duplicateKey,
      )).status,
      200,
    );
    const duplicateBeforeChange = await accountRows(
      database,
      fixture.organizationId,
      duplicateRun.runId,
    );
    const changedDuplicateResponse = await postWorkerResult(
      fixture,
      worker,
      duplicateAssignment,
      {
        ...duplicateBody,
        usage: { ...duplicateReceipt, costUsd: "0.06" },
      },
      duplicateKey,
    );
    assertEquals(changedDuplicateResponse.status, 422);
    assertEquals(
      await accountRows(database, fixture.organizationId, duplicateRun.runId),
      duplicateBeforeChange,
    );

    const overrunRun = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "truthful-overrun",
      }),
    );
    const overrunReceipt = receipt(overrunRun, "overrun", {
      costUsd: "0.15",
      measurement: "reported",
    });
    assertEquals(
      (await submitFailure(fixture, worker, overrunRun, overrunReceipt)).status,
      200,
    );
    const overrunRow = (await database.query<{ cost: string; overrun: string }>(
      `select cost_usd::text as cost, overrun_usd::text as overrun
           from bakery.usage_records
          where organization_id = $1 and usage_fact_id = $2`,
      [overrunRun.organizationId, overrunReceipt.usageFactId],
    )).rows[0];
    assertEquals(overrunRow, { cost: "0.150000", overrun: "0.100000" });

    // An unknown failure remains held with null cost, then a late attributable fact settles the original hold.
    const late = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "late-reconciliation",
      }),
    );
    const lateUnknown = receipt(late, "late", {
      costUsd: null,
      measurement: "unknown",
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    assertEquals(
      (await submitFailure(fixture, worker, late, lateUnknown)).status,
      200,
    );
    const lateBefore =
      (await database.query<{ cost: string | null; status: string }>(
        `select cost_usd::text as cost, measurement as status from bakery.usage_records
          where organization_id = $1 and usage_fact_id = $2`,
        [late.organizationId, lateUnknown.usageFactId],
      )).rows[0];
    assertEquals(lateBefore, { cost: null, status: "unknown" });
    const lateOriginalResultEventId =
      (await database.query<{ resultEventId: string }>(
        `select result_event_id as "resultEventId"
           from bakery.usage_records
          where organization_id = $1 and usage_fact_id = $2`,
        [late.organizationId, lateUnknown.usageFactId],
      )).rows[0]?.resultEventId;
    assertExists(lateOriginalResultEventId);
    const priorPeriodAccountId = crypto.randomUUID();
    const lateReservation = (await database.query<{
      budgetAccountId: string;
      reservedUsd: string;
    }>(
      `select budget_account_id as "budgetAccountId",
              reserved_usd::text as "reservedUsd"
         from bakery.budget_reservations
        where organization_id = $1 and id = $2`,
      [late.organizationId, late.installationReservationId],
    )).rows[0];
    assertExists(lateReservation);
    await withPgTransaction(database, async (transaction) => {
      await transaction.query(
        `insert into bakery.budget_accounts (
           id, scope, period_start, period_end, limit_usd,
           reserved_usd, settled_usd, version
         ) values (
           $1, 'installation', '2026-09-01T00:00:00.000Z',
           '2026-10-01T00:00:00.000Z', $2, 0, 0, 1
         )`,
        [priorPeriodAccountId, policy.installationMonthlyLimitUsd],
      );
      await transaction.query(
        `update bakery.budget_accounts
            set reserved_usd = reserved_usd - $2::numeric,
                updated_at = now(), version = version + 1
          where id = $1`,
        [lateReservation.budgetAccountId, lateReservation.reservedUsd],
      );
      await transaction.query(
        `update bakery.budget_accounts
            set reserved_usd = $2::numeric,
                updated_at = now(), version = version + 1
          where id = $1`,
        [priorPeriodAccountId, lateReservation.reservedUsd],
      );
      await transaction.query(
        `update bakery.budget_reservations
            set budget_account_id = $2, updated_at = now(), version = version + 1
          where organization_id = $1 and id = $3`,
        [
          late.organizationId,
          priorPeriodAccountId,
          late.installationReservationId,
        ],
      );
    });
    const lateKnown = {
      ...lateUnknown,
      costUsd: "0.1",
      measurement: "reported" as const,
      occurredAt: "2026-09-30T00:00:00.000Z",
    };
    const lateParsed = {
      ...lateKnown,
      inputTokens: lateKnown.inputTokens ?? undefined,
      outputTokens: lateKnown.outputTokens ?? undefined,
      costUsd: lateKnown.costUsd ?? undefined,
    };
    const attempt = (await database.query<{
      id: string;
      workerHostId: string;
      workerSessionId: string;
      workerSessionGeneration: string;
      fence: string;
    }>(
      `select id, worker_host_id as "workerHostId", worker_session_id as "workerSessionId",
                worker_session_generation::text as "workerSessionGeneration", fence::text as fence
           from bakery.job_attempts where job_id = $1`,
      [late.jobId],
    )).rows[0];
    assertExists(attempt);
    const lateOriginalDigest = await budgetContentDigest({
      usageFactId: lateUnknown.usageFactId,
      providerCallId: lateUnknown.providerCallId,
      provider: lateUnknown.provider,
      billingAccountId: lateUnknown.billingAccountId,
      model: lateUnknown.model,
      billingRoute: lateUnknown.billingRoute,
      pricingMetadataSnapshot: lateUnknown.pricingMetadataSnapshot,
      inputTokens: lateUnknown.inputTokens,
      outputTokens: lateUnknown.outputTokens,
      costUsd: lateUnknown.costUsd,
      measurement: lateUnknown.measurement,
      occurredAt: lateUnknown.occurredAt,
      organizationId: late.organizationId,
      runId: late.runId,
      runStepId: late.runStepId,
      attemptId: attempt.id,
      workerHostId: attempt.workerHostId,
      workerSessionId: attempt.workerSessionId,
      workerSessionGeneration: attempt.workerSessionGeneration,
      fence: attempt.fence,
      installationReservationId: late.installationReservationId,
      resultEventId: lateOriginalResultEventId,
    });
    await publishProviderReceipt(database, late, lateKnown);
    const reconciledLate = await withPgTransaction(
      database,
      async (transaction) =>
        await reconcileProviderUsageReceipt(transaction, {
          organizationId: late.organizationId,
          installationReservationId: late.installationReservationId,
        }),
    );
    assertExists(reconciledLate);
    const rolloverSummary = await withPgTransaction(
      database,
      async (transaction) =>
        await readUsageSummary(transaction, {
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-10-01T00:00:00.000Z",
          provider: "openai",
        }),
    );
    assertEquals(rolloverSummary.knownCostUsd, "0.1");
    assertEquals(rolloverSummary.unverifiedCostUsd, "0");
    assertEquals(rolloverSummary.unknownCount, 0);
    assertEquals(rolloverSummary.unverifiedCount, 0);
    assertEquals(rolloverSummary.byProvider, [{
      provider: "openai",
      billingType: "api",
      model: "gpt-5.6-luna",
      knownCostUsd: "0.1",
      unverifiedCostUsd: "0",
      unknownCount: 0,
      unverifiedCount: 0,
      inputTokens: "1",
      outputTokens: "2",
    }]);
    assertEquals(rolloverSummary.budgetAccounts, [{
      scope: "installation",
      runId: null,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      limitUsd: "1",
      reservedUsd: "0",
      settledUsd: "0.1",
      availableUsd: "0.9",
      unknownCount: 0,
    }]);
    const usageResponse = await runGet(
      fixture,
      "/v1/usage?from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z&provider=openai",
    );
    assertEquals(usageResponse.status, 200, await usageResponse.clone().text());
    const usageBody = await usageResponse.json() as {
      knownCostUsd: string;
      unverifiedCostUsd: string;
      unknownCount: number;
      unverifiedCount: number;
    };
    assertEquals(usageBody.knownCostUsd, "0.1");
    assertEquals(usageBody.unknownCount, 0);
    assertEquals(usageBody.unverifiedCostUsd, "0");
    assertEquals(usageBody.unverifiedCount, 0);
    // An immutable receipt alone cannot override explicitly unverified provenance.
    await database.query(
      `update bakery.usage_records
          set provenance = 'worker-unverified'
        where organization_id = $1 and usage_fact_id = $2`,
      [late.organizationId, lateUnknown.usageFactId],
    );
    const legacyMeasuredSummary = await withPgTransaction(
      database,
      async (transaction) =>
        await readUsageSummary(transaction, {
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-10-01T00:00:00.000Z",
          provider: "openai",
        }),
    );
    assertEquals(legacyMeasuredSummary.knownCostUsd, "0");
    assertEquals(legacyMeasuredSummary.unverifiedCostUsd, "0.1");
    assertEquals(legacyMeasuredSummary.unknownCount, 0);
    assertEquals(legacyMeasuredSummary.unverifiedCount, 1);
    assertEquals(legacyMeasuredSummary.completeness, "unknown");
    assertEquals(legacyMeasuredSummary.byProvider, [{
      provider: "openai",
      billingType: "api",
      model: "gpt-5.6-luna",
      knownCostUsd: "0",
      unverifiedCostUsd: "0.1",
      unknownCount: 0,
      unverifiedCount: 1,
      inputTokens: "1",
      outputTokens: "2",
    }]);

    const historicalReadback = await withPgTransaction(
      database,
      async (transaction) =>
        await readPersistedUsageFact(transaction, {
          organizationId: late.organizationId,
          usageFactId: lateUnknown.usageFactId,
          canonicalDigest: lateOriginalDigest,
        }),
    );
    assertExists(historicalReadback);
    assertEquals(
      {
        canonicalDigest: historicalReadback.canonicalDigest,
        originalCanonicalDigest: historicalReadback.originalCanonicalDigest,
        resultEventId: historicalReadback.resultEventId,
        inputTokens: historicalReadback.inputTokens,
        outputTokens: historicalReadback.outputTokens,
        costUsd: historicalReadback.costUsd,
        measurement: historicalReadback.measurement,
        provenance: historicalReadback.provenance,
        occurredAt: historicalReadback.occurredAt,
        overrunUsd: historicalReadback.overrunUsd,
      },
      {
        canonicalDigest: lateOriginalDigest,
        originalCanonicalDigest: lateOriginalDigest,
        resultEventId: lateOriginalResultEventId,
        inputTokens: lateUnknown.inputTokens,
        outputTokens: lateUnknown.outputTokens,
        costUsd: null,
        measurement: "unknown",
        provenance: "worker-unverified",
        occurredAt: lateUnknown.occurredAt,
        overrunUsd: "0",
      },
    );
    const lateAfter =
      (await database.query<{ cost: string | null; status: string }>(
        `select cost_usd::text as cost, measurement as status from bakery.usage_records
          where organization_id = $1 and usage_fact_id = $2`,
        [late.organizationId, lateUnknown.usageFactId],
      )).rows[0];
    assertEquals(lateAfter, { cost: "0.100000", status: "reported" });
    const lateDigest = await budgetContentDigest({
      usageFactId: lateKnown.usageFactId,
      providerCallId: lateKnown.providerCallId,
      provider: lateKnown.provider,
      billingAccountId: lateKnown.billingAccountId,
      model: lateKnown.model,
      billingRoute: lateKnown.billingRoute,
      pricingMetadataSnapshot: lateKnown.pricingMetadataSnapshot,
      inputTokens: lateKnown.inputTokens,
      outputTokens: lateKnown.outputTokens,
      costUsd: lateKnown.costUsd,
      measurement: lateKnown.measurement,
      occurredAt: lateKnown.occurredAt,
      organizationId: late.organizationId,
      runId: late.runId,
      runStepId: late.runStepId,
      attemptId: attempt.id,
      workerHostId: attempt.workerHostId,
      workerSessionId: attempt.workerSessionId,
      workerSessionGeneration: attempt.workerSessionGeneration,
      fence: attempt.fence,
      installationReservationId: late.installationReservationId,
      resultEventId: lateOriginalResultEventId,
    });
    const readback = await withPgTransaction(
      database,
      async (transaction) =>
        await readPersistedUsageFact(transaction, {
          organizationId: late.organizationId,
          usageFactId: lateKnown.usageFactId,
          canonicalDigest: lateDigest,
        }),
    );
    assertEquals(readback?.costUsd, "0.1");
    assertExists(readback);
    assertEquals(readback.resultEventId, lateOriginalResultEventId);
    const readbackDigest = await budgetContentDigest({
      usageFactId: readback.usageFactId,
      providerCallId: readback.providerCallId,
      provider: readback.provider,
      billingAccountId: readback.billingAccountId,
      model: readback.model,
      billingRoute: readback.billingRoute,
      pricingMetadataSnapshot: readback.pricingMetadataSnapshot,
      inputTokens: readback.inputTokens,
      outputTokens: readback.outputTokens,
      costUsd: readback.costUsd,
      measurement: readback.measurement,
      occurredAt: readback.occurredAt,
      organizationId: readback.organizationId,
      runId: readback.runId,
      runStepId: readback.runStepId,
      attemptId: readback.attemptId,
      workerHostId: readback.workerHostId,
      workerSessionId: readback.workerSessionId,
      workerSessionGeneration: readback.workerSessionGeneration,
      fence: readback.fence,
      installationReservationId: readback.budgetReservationId,
      resultEventId: readback.resultEventId,
    });
    assertEquals(readbackDigest, readback.canonicalDigest);

    // Failure, cancellation, and lease expiry retain holds; no paid call is made.
    const unknownFailure = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "unknown-failure",
      }),
    );
    const unknownFailureReceipt = receipt(unknownFailure, "unknown-failure", {
      costUsd: null,
      measurement: "unknown",
    });
    assertEquals(
      (await submitFailure(
        fixture,
        worker,
        unknownFailure,
        unknownFailureReceipt,
      )).status,
      200,
    );
    const unknownCancel = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "unknown-cancel",
      }),
    );
    const unknownCancelReceipt = receipt(unknownCancel, "unknown-cancel", {
      costUsd: null,
      measurement: "unknown",
    });
    const cancelAssignment = await claimAssignment(fixture, worker);
    await withPgTransaction(database, async (transaction) => {
      await bindProviderCallIntent(transaction, {
        organizationId: unknownCancel.organizationId,
        installationReservationId: unknownCancel.installationReservationId,
        providerCallId: unknownCancelReceipt.providerCallId,
      });
    });
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        cancelAssignment,
        canceledResult(
          cancelAssignment,
          unknownCancelReceipt,
        ),
        crypto.randomUUID(),
      )).status,
      200,
    );
    const unknownRows = (await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.usage_records
          where organization_id = $1 and measurement = 'unknown' and cost_usd is null`,
      [fixture.organizationId],
    )).rows[0];
    assertEquals(unknownRows?.count, "3");
    const heldAccount = (await accountRows(
      database,
      fixture.organizationId,
      unknownFailure.runId,
    ))
      .find((row) => row.scope === "installation");
    assertEquals(heldAccount?.reservedUsd, "0.150000");

    // Wrong tenant, fence, and frozen billing identity fail before account mutation.
    const denied = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "denial-checks",
      }),
    );
    const deniedBefore = await accountRows(
      database,
      fixture.organizationId,
      denied.runId,
    );
    const deniedAssignment = await claimAssignment(fixture, worker);
    assertEquals(deniedAssignment.jobId, denied.jobId);
    const wrongBilling = receipt(denied, "wrong-billing", {
      costUsd: "0.1",
      measurement: "reported",
      provider: "untrusted-provider",
    });
    const wrongBillingResponse = await postWorkerResult(
      fixture,
      worker,
      deniedAssignment,
      failedResult(deniedAssignment, wrongBilling),
      crypto.randomUUID(),
    );
    assertEquals(wrongBillingResponse.status, 409);
    assertEquals(await problemCode(wrongBillingResponse), "STATE_CONFLICT");
    const deniedAfterBilling = await accountRows(
      database,
      fixture.organizationId,
      denied.runId,
    );
    assertEquals(deniedAfterBilling, deniedBefore);
    const tenantRead = await withPgTransaction(
      database,
      async (transaction) =>
        await readPersistedUsageFact(transaction, {
          organizationId: secondOrganization!,
          usageFactId: lateKnown.usageFactId,
          canonicalDigest: lateDigest,
        }),
    );
    assertEquals(tenantRead, null);
    const tenantDenied = await withPgTransaction(
      database,
      async (transaction) =>
        await assertRejects(
          () =>
            settleWorkflowAction(transaction, {
              organizationId: secondOrganization!,
              runId: late.runId,
              runStepId: late.runStepId,
              installationReservationId: late.installationReservationId,
              attemptId: attempt.id,
              workerHostId: attempt.workerHostId,
              workerSessionId: attempt.workerSessionId,
              workerSessionGeneration: attempt.workerSessionGeneration,
              fence: attempt.fence,
              resultEventId: `${late.runId}-late-result`,
              receipt: lateParsed,
            }),
          StandardError,
          "RESOURCE_NOT_FOUND",
        ),
    );
    assert(tenantDenied instanceof StandardError);
    const sharedAtSecondCleanup = (await accountRows(
      database,
      fixture.organizationId,
      decimalA.runId,
    )).find((row) => row.scope === "installation");
    assertExists(sharedAtSecondCleanup);
    if (secondScope !== undefined) {
      await closeWorkerScope(fixture, secondScope);
      secondScope = undefined;
      secondOrganization = undefined;
    }
    const sharedAfterSecondCleanup = (await accountRows(
      database,
      fixture.organizationId,
      decimalA.runId,
    )).find((row) => row.scope === "installation");
    assertExists(sharedAfterSecondCleanup);
    // Later scenarios also settled costs; remove only the other tenant's seven cents.
    assertEquals(
      parseMicroUsd(sharedAtSecondCleanup.settledUsd) -
        parseMicroUsd(sharedAfterSecondCleanup.settledUsd),
      70_000n,
    );
    assertEquals(
      sharedAfterSecondCleanup.reservedUsd,
      sharedAtSecondCleanup.reservedUsd,
    );
    const wrongFence = await seedRun(
      database,
      fixture.organizationId,
      fixture.principalId,
      {
        reservationUsd: "0.05",
        stepKey: "wrong-fence",
      },
    ).then((run) => admit(database, run));
    const wrongFenceAssignment = await claimAssignment(fixture, worker);
    assertEquals(wrongFenceAssignment.jobId, wrongFence.jobId);
    const wrongFenceResponse = await postWorkerResult(
      fixture,
      worker,
      wrongFenceAssignment,
      {
        ...failedResult(
          wrongFenceAssignment,
          receipt(wrongFence, "wrong-fence", {
            costUsd: "0.1",
            measurement: "reported",
          }),
        ),
        fence: (BigInt(wrongFenceAssignment.fence) + 1n).toString(),
      },
      crypto.randomUUID(),
    );
    assertEquals(wrongFenceResponse.status, 409);
    assertEquals(await problemCode(wrongFenceResponse), "LEASE_FENCED");

    // Authorized list/get/control projections read the same ledger snapshot.
    const projected = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "projection",
      }),
    );
    const listResponse = await runGet(
      fixture,
      `/v1/tasks/${projected.taskId}/runs?limit=25`,
    );
    assertEquals(listResponse.status, 200, await listResponse.clone().text());
    const listBody = await listResponse.json() as {
      items: Array<Record<string, unknown>>;
    };
    const listed = listBody.items.find((item) => item.id === projected.runId);
    assertExists(listed);
    const getResponse = await runGet(fixture, `/v1/runs/${projected.runId}`);
    assertEquals(getResponse.status, 200, await getResponse.clone().text());
    const got = await getResponse.json() as Record<string, unknown>;
    const controlAssignment = await claimAssignment(fixture, worker);
    assertEquals(controlAssignment.jobId, projected.jobId);
    const controlResponse = await runControl(fixture, projected.runId);
    assertEquals(
      controlResponse.status,
      201,
      await controlResponse.clone().text(),
    );
    const controlled = await controlResponse.json() as Record<string, unknown>;
    assertEquals(
      (listed.budgetSummary as Record<string, unknown>).installation,
      null,
    );
    assertEquals(
      (got.budgetSummary as Record<string, unknown>).installation,
      null,
    );
    assertEquals(
      (controlled.budgetSummary as Record<string, unknown>).installation,
      null,
    );
    assertEquals(
      (listed.budgetSummary as Record<string, unknown>).run,
      (got.budgetSummary as Record<string, unknown>).run,
    );
    assertEquals(
      (got.budgetSummary as Record<string, unknown>).run,
      (controlled.budgetSummary as Record<string, unknown>).run,
    );
    assertEquals(
      ((controlled.budgetSummary as Record<string, unknown>).run as Record<
        string,
        unknown
      >).reservedUsd,
      "0.05",
    );

    // A legacy/non-model admission has no ledger account and remains explicitly unknown.
    const legacy = await seedRun(
      database,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        stepKey: "legacy-unaccounted",
      },
    );
    const legacyJobId = (await admitWithoutBudget(database, legacy)).jobId;
    await database.query(
      `update bakery.jobs set status = 'canceled' where id = $1`,
      [legacyJobId],
    );
    const legacyIntentCount = (await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.budget_action_intents
          where organization_id = $1 and run_id = $2`,
      [legacy.organizationId, legacy.runId],
    )).rows[0];
    assertEquals(legacyIntentCount?.count, "0");
    const legacySummary = await withPgTransaction(
      database,
      async (transaction) =>
        await readRunBudgetSummary(transaction, {
          organizationId: legacy.organizationId,
          runId: legacy.runId,
          limitUsd: "1",
        }),
    );
    assertEquals(legacySummary.installation, null);
    assertEquals(legacySummary.run.unknownCount, 1);
    const unknownLease = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "unknown-lease",
      }),
    );
    const leaseAssignment = await claimAssignment(fixture, worker);
    assertEquals(leaseAssignment.jobId, unknownLease.jobId);
    await expireAndSupersedeAttempt(database, unknownLease.jobId);
    assertEquals(await installationGrant(), bootstrapGrant);
  } finally {
    if (secondScope !== undefined) {
      await closeWorkerScope(fixture, secondScope);
    }
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
    fixture.releaseFixture();
  }
});

Deno.test("authenticated claims release only their own never-dispatched model holds", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  try {
    await seedProviderPricingSnapshot(database);
    const worker = await registeredWorker(fixture, { slots: 8 });
    // Authenticated malformed assignment regressions cover production claim wiring.
    const malformedPositive = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "malformed-checkpoints-positive",
      }),
    );
    const positiveResponse = await claimMalformedAssignment(
      fixture,
      worker,
      malformedPositive,
    );
    assertEquals(positiveResponse.status, 204);
    assertEquals(await budgetEvidenceState(database, malformedPositive), {
      jobStatus: "failed",
      attemptCount: "0",
      intentStatus: "held",
      reservationStatus: "held",
      evidenceCount: "1",
    });
    const evidence = (await database.query<{ id: string }>(
      `select id from bakery.budget_release_evidence
        where organization_id = $1 and installation_reservation_id = $2`,
      [
        malformedPositive.organizationId,
        malformedPositive.installationReservationId,
      ],
    )).rows[0];
    assertExists(evidence);
    const heldAccounts = await accountRows(
      database,
      malformedPositive.organizationId,
      malformedPositive.runId,
    );
    const release = () =>
      withPgTransaction(
        database,
        (transaction) =>
          releaseWorkflowAction(transaction, {
            organizationId: malformedPositive.organizationId,
            installationReservationId:
              malformedPositive.installationReservationId,
            evidenceId: evidence.id,
          }),
      );
    await release();
    await release();
    assertEquals(await budgetEvidenceState(database, malformedPositive), {
      jobStatus: "failed",
      attemptCount: "0",
      intentStatus: "released",
      reservationStatus: "released",
      evidenceCount: "1",
    });
    const releasedAccounts = await accountRows(
      database,
      malformedPositive.organizationId,
      malformedPositive.runId,
    );
    assertEquals(
      releasedAccounts.map((row) => BigInt(row.reservedUsd.replace(".", ""))),
      heldAccounts.map((row) =>
        BigInt(row.reservedUsd.replace(".", "")) - 50_000n
      ),
    );
    await assertRejects(
      () =>
        withPgTransaction(
          database,
          (transaction) =>
            bindProviderCallIntent(transaction, {
              organizationId: malformedPositive.organizationId,
              installationReservationId:
                malformedPositive.installationReservationId,
              providerCallId: `${malformedPositive.runId}-too-late`,
            }),
        ),
      StandardError,
      "STATE_CONFLICT",
    );

    const malformedPriorAttempt = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "malformed-checkpoints-prior-attempt",
      }),
    );
    const priorAssignment = await claimAssignment(fixture, worker);
    assertEquals(priorAssignment.jobId, malformedPriorAttempt.jobId);
    await database.query(
      `update bakery.job_attempts
          set status = 'lost'
        where organization_id = $1 and id = $2`,
      [malformedPriorAttempt.organizationId, priorAssignment.attemptId],
    );
    await database.query(
      `update bakery.jobs
          set status = 'queued', current_fence = current_fence + 1,
              max_attempts = 2, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [malformedPriorAttempt.organizationId, malformedPriorAttempt.jobId],
    );
    const priorAttemptResponse = await claimMalformedAssignment(
      fixture,
      worker,
      malformedPriorAttempt,
    );
    assertEquals(priorAttemptResponse.status, 204);
    const priorAttemptState = await budgetEvidenceState(
      database,
      malformedPriorAttempt,
    );
    assertEquals(priorAttemptState.intentStatus, "held");
    assertEquals(priorAttemptState.reservationStatus, "held");
    assertEquals(priorAttemptState.evidenceCount, "0");
    assertEquals(priorAttemptState.attemptCount, "1");
    assertEquals(priorAttemptState.jobStatus, "failed");

    const malformedBoundProvider = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "malformed-checkpoints-bound-provider",
      }),
    );
    await withPgTransaction(database, async (transaction) => {
      await bindProviderCallIntent(transaction, {
        organizationId: malformedBoundProvider.organizationId,
        installationReservationId:
          malformedBoundProvider.installationReservationId,
        providerCallId: `${malformedBoundProvider.runId}-ambiguous`,
      });
    });
    const boundProviderResponse = await claimMalformedAssignment(
      fixture,
      worker,
      malformedBoundProvider,
    );
    assertEquals(boundProviderResponse.status, 204);
    assertEquals(await budgetEvidenceState(database, malformedBoundProvider), {
      jobStatus: "failed",
      attemptCount: "0",
      intentStatus: "held",
      reservationStatus: "held",
      evidenceCount: "0",
    });
    // Shape-correct assignment with a held reservation from another run/step
    // must fail before leasing and must not release either held pair.
    const foreignReservationRun = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "foreign-reservation-source",
      }),
    );
    await database.query(
      `update bakery.jobs set available_at = clock_timestamp() + interval '1 day'
        where organization_id = $1 and id = $2`,
      [foreignReservationRun.organizationId, foreignReservationRun.jobId],
    );
    const mismatchedReservationRun = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.05",
        stepKey: "foreign-reservation-target",
      }),
    );
    await database.query(
      `update bakery.jobs
          set installation_reservation_id = $3, updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2`,
      [
        mismatchedReservationRun.organizationId,
        mismatchedReservationRun.jobId,
        foreignReservationRun.installationReservationId,
      ],
    );
    const foreignReservationResponse = await claimRequestForRun(
      fixture,
      worker,
      mismatchedReservationRun,
    );
    assertEquals(foreignReservationResponse.status, 204);
    const mismatchedAttemptCount = (await database.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.job_attempts
        where organization_id = $1 and job_id = $2`,
      [mismatchedReservationRun.organizationId, mismatchedReservationRun.jobId],
    )).rows[0];
    assertEquals(mismatchedAttemptCount?.count, "0");
    const foreignIntent = (await intentRows(
      database,
      foreignReservationRun.organizationId,
      foreignReservationRun.runId,
    ))[0];
    const mismatchedIntent = (await intentRows(
      database,
      mismatchedReservationRun.organizationId,
      mismatchedReservationRun.runId,
    ))[0];
    assertExists(foreignIntent);
    assertExists(mismatchedIntent);
    assertEquals(foreignIntent.status, "held");
    assertEquals(mismatchedIntent.status, "held");
    const heldPairStatuses = (await database.query<{
      id: string;
      status: string;
    }>(
      `select id, status
         from bakery.budget_reservations
        where organization_id = $1 and id = any($2::uuid[])`,
      [
        fixture.organizationId,
        [
          foreignReservationRun.installationReservationId,
          mismatchedReservationRun.installationReservationId,
        ],
      ],
    )).rows;
    assertEquals(
      heldPairStatuses.map((row) => row.status).sort(),
      ["held", "held"],
    );
    const foreignEvidenceCount = (await database.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.budget_release_evidence
        where organization_id = $1
          and installation_reservation_id = $2`,
      [
        foreignReservationRun.organizationId,
        foreignReservationRun.installationReservationId,
      ],
    )).rows[0];
    assertEquals(foreignEvidenceCount?.count, "0");
  } finally {
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
    fixture.releaseFixture();
  }
});

Deno.test("scheduled reconciliation settles a bound receipt without worker usage", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  await seedProviderPricingSnapshot(database);
  const worker = await registeredWorker(fixture, { slots: 8 });
  try {
    const run = await seedRun(
      database,
      fixture.organizationId,
      fixture.principalId,
      { reservationUsd: "0.1", stepKey: "receipt-without-usage" },
    );
    const admitted = await admit(database, run);
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, admitted.jobId);
    // The trusted provider adapter binds the call and persists its
    // authoritative receipt through the production writer, then the worker
    // loses its terminal usage publication entirely: the terminal failure
    // carries no usage fact, so nothing settles from the result alone.
    const lostUsageReceipt = receipt(admitted, "lost-usage", {
      costUsd: "0.04",
      measurement: "reported",
    });
    await withPgTransaction(database, async (transaction) => {
      await bindProviderCallIntent(transaction, {
        organizationId: run.organizationId,
        installationReservationId: admitted.installationReservationId,
        providerCallId: lostUsageReceipt.providerCallId,
      });
      const callIntent = (await transaction.query<{ id: string }>(
        `select provider_call_intent_id as id
           from bakery.budget_action_intents
          where organization_id = $1 and installation_reservation_id = $2`,
        [run.organizationId, admitted.installationReservationId],
      )).rows[0];
      assertExists(callIntent);
      await recordProviderUsageReceipt(transaction, {
        organizationId: run.organizationId,
        providerCallIntentId: callIntent.id,
        receipt: lostUsageReceipt,
      });
    });
    const lostUsageBody = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      status: "failed" as const,
      fault: fixedFault(),
    };
    const lostUsageResponse = await postWorkerResult(
      fixture,
      worker,
      assignment,
      lostUsageBody,
      crypto.randomUUID(),
    );
    assertEquals(lostUsageResponse.status, 200);
    await lostUsageResponse.body?.cancel();

    const reconciled = await reconcileBudgetLedger(database);
    assertEquals(reconciled, { providerReceipts: 1, releases: 0 });
    const accounts = await accountRows(
      database,
      fixture.organizationId,
      run.runId,
    );
    const installation = accounts.find((row) => row.scope === "installation");
    const runAccount = accounts.find((row) => row.scope === "run");
    assertEquals(installation?.settledUsd, "0.040000");
    assertEquals(installation?.reservedUsd, "0.000000");
    assertEquals(runAccount?.settledUsd, "0.040000");
    assertEquals(runAccount?.reservedUsd, "0.000000");

    // Reconciliation is idempotent: a second pass settles nothing more.
    const again = await reconcileBudgetLedger(database);
    assertEquals(again, { providerReceipts: 0, releases: 0 });
  } finally {
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
    fixture.releaseFixture();
  }
});

Deno.test("a retryable fault that reports usage stays terminal and settles the budget", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  await seedProviderPricingSnapshot(database);
  const worker = await registeredWorker(fixture, { slots: 8 });
  try {
    const run = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "retryable-with-usage",
      }),
    );
    const usage = receipt(run, "retryable-with-usage", {
      costUsd: "0.04",
      measurement: "reported",
    });
    assertEquals(
      (await submitFailure(fixture, worker, run, usage, true)).status,
      200,
    );
    // The settled intent cannot fund a re-claim, so the job must not requeue.
    const job = (await database.query<{ status: string }>(
      `select status from bakery.jobs where organization_id = $1 and id = $2`,
      [run.organizationId, run.jobId],
    )).rows[0];
    assertEquals(job?.status, "failed");
    const intents = await intentRows(
      database,
      fixture.organizationId,
      run.runId,
    );
    assertEquals(intents.map((intent) => intent.status), ["settled"]);
  } finally {
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
    fixture.releaseFixture();
  }
});

Deno.test("a live external effect keeps a bound receipt unsettled until the effect fails", async () => {
  const fixture = await openWorkerFixture();
  const database = fixture.pgDatabase;
  await seedProviderPricingSnapshot(database);
  const worker = await registeredWorker(fixture, { slots: 8 });
  try {
    const admitted = await admit(
      database,
      await seedRun(database, fixture.organizationId, fixture.principalId, {
        reservationUsd: "0.1",
        stepKey: "receipt-live-effect",
      }),
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, admitted.jobId);
    const lost = receipt(admitted, "live-effect", {
      costUsd: "0.04",
      measurement: "reported",
    });
    await withPgTransaction(database, async (transaction) => {
      await bindProviderCallIntent(transaction, {
        organizationId: admitted.organizationId,
        installationReservationId: admitted.installationReservationId,
        providerCallId: lost.providerCallId,
      });
      const callIntent = (await transaction.query<{ id: string }>(
        `select provider_call_intent_id as id
           from bakery.budget_action_intents
          where organization_id = $1 and installation_reservation_id = $2`,
        [admitted.organizationId, admitted.installationReservationId],
      )).rows[0];
      assertExists(callIntent);
      await recordProviderUsageReceipt(transaction, {
        organizationId: admitted.organizationId,
        providerCallIntentId: callIntent.id,
        receipt: lost,
      });
    });

    // An effect on the run reservation goes live while the job still runs.
    const rig = await seededEffectRig(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const prepared = await prepareEffect({
      database,
      registry: effectRegistry,
      snapshots: rig.port,
    }, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: "receipt-live-effect",
      runStepId: admitted.runStepId,
      budgetReservationId: admitted.runReservationId,
    });
    const claim = await claimEffect(claimDepsFor(database, rig), {
      organizationId: fixture.organizationId,
      effectId: prepared.effectId,
      requestId: "request-1",
      traceId: "trace-1",
    });
    assertEquals(claim.outcome, "claimed");

    const response = await postWorkerResult(fixture, worker, assignment, {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "1",
      status: "failed",
      fault: fixedFault(),
    }, crypto.randomUUID());
    assertEquals(response.status, 200);
    await response.body?.cancel();

    const candidates = () =>
      withPgTransaction(
        database,
        (transaction) => findProviderUsageReceiptCandidates(transaction),
      );
    assertEquals(
      (await candidates()).filter((row) =>
        row.organizationId === fixture.organizationId
      ),
      [],
    );
    assertEquals(
      (await reconcileBudgetLedger(database)).providerReceipts,
      0,
    );

    await forceEffectStatus(
      database,
      fixture.organizationId,
      prepared.effectId,
      "failed",
    );
    assertEquals(
      (await candidates()).filter((row) =>
        row.organizationId === fixture.organizationId
      ).length,
      1,
    );
    const settled = await reconcileBudgetLedger(database);
    assertEquals(settled.providerReceipts, 1);
    const accounts = await accountRows(
      database,
      fixture.organizationId,
      admitted.runId,
    );
    assertEquals(
      accounts.find((row) => row.scope === "installation")?.settledUsd,
      "0.040000",
    );
  } finally {
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
    fixture.releaseFixture();
  }
});
