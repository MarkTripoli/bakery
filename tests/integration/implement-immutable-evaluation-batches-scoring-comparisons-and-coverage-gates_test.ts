/**
 * #44 slice 1 against Postgres and the real routes. Admission writes every
 * required result as missing; a duplicate delivery adds no attempt (AC1);
 * an error or unscored result keeps the gate from passing (AC2); an
 * incompatible pair is refused (AC3); a complete suite passes only when every
 * required result is measured (AC4). Cancel takes If-Match; another
 * organization cannot read a batch.
 */

import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import {
  closeWorkerOrganization,
  createWorkerScope,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  postWorkerResult,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import { recordAttempt } from "../../apps/server/src/modules/evaluations/store.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  assertNoDeadlock,
  holdRow,
  raceInOrder,
} from "../helpers/lock-race.ts";
import { workerActionCapabilities } from "../../packages/contracts/src/contracts.ts";
import {
  bindProviderCallIntent,
  recordProviderUsageReceipt,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import {
  admitFundedModelRun,
  type AdmittedJob,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function call(
  fixture: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: number; organizationId?: string } = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        Cookie: fixture.adminCookie,
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
        ...(options.ifMatch === undefined
          ? {}
          : { "If-Match": '"' + options.ifMatch + '"' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  ));
}

async function ok(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

/** A repository, an input artifact version, two cases, a dataset, two scorers. */
async function world(fixture: Fixture) {
  const db = fixture.pgDatabase;
  const job = await seedEligibleJob(
    db,
    fixture.organizationId,
    fixture.principalId,
  );
  const repositoryId = crypto.randomUUID();
  await db.query(
    `insert into bakery.repositories (id, organization_id, application_id,
       integration_connection_id, provider_repo_id, owner, name, default_branch)
     values ($1, $2, $3, $4, 'eval-44', 'acme', 'evals', 'main')`,
    [
      repositoryId,
      fixture.organizationId,
      job.applicationId,
      crypto.randomUUID(),
    ],
  );
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db.query(
    "insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name) values ($1,$2,$3,'document','input')",
    [artifactId, fixture.organizationId, job.taskId],
  );
  await db.query(
    `insert into bakery.artifact_versions (id,organization_id,artifact_id,task_id,
       author_id,revision,content,sha256,size_bytes,media_type,retention_class)
     values ($1,$2,$3,$4,$5,1,$6,$7,2,'text/plain','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      job.taskId,
      fixture.principalId,
      new TextEncoder().encode("hi"),
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    ],
  );
  const cases = [];
  for (const name of ["first", "second"]) {
    cases.push(
      await ok(
        await call(fixture, "POST", "/v1/evaluation-cases", {
          body: {
            repositoryId,
            name,
            inputArtifactVersionId: versionId,
            expected: { ok: true },
          },
        }),
        201,
      ),
    );
  }
  const scorer = async (
    slug: string,
    revision = 1,
    evaluatorType = "deterministic",
  ) =>
    await ok(
      await call(fixture, "POST", "/v1/evaluation-definitions", {
        body: { slug, revision, evaluatorType, config: { check: slug } },
      }),
      201,
    );
  const schema = await scorer("schema");
  const rubric = await scorer("rubric", 1, "model");
  const dataset = await ok(
    await call(fixture, "POST", "/v1/evaluation-datasets", {
      body: { name: "smoke", caseIds: cases.map((c) => c.id) },
    }),
    201,
  );
  return { cases, schema, rubric, dataset, scorer, versionId };
}

async function admit(
  fixture: Fixture,
  w: Awaited<ReturnType<typeof world>>,
  scorers: Json[],
) {
  return await ok(
    await call(fixture, "POST", "/v1/evaluation-batches", {
      body: {
        datasetId: w.dataset.id,
        candidate: {
          kind: "agentVersion",
          id: crypto.randomUUID(),
          version: 2,
        },
        scorerIds: scorers.map((s) => s.id),
      },
    }),
    201,
  );
}

async function results(fixture: Fixture, batchId: unknown, state?: string) {
  const page = await ok(
    await call(
      fixture,
      "GET",
      "/v1/evaluation-batches/" + batchId + "/results" +
        (state ? "?state=" + state : ""),
    ),
  );
  return page.items as Json[];
}

function record(
  fixture: Fixture,
  resultId: unknown,
  state: string,
  score: number | null,
  deliveryKey = crypto.randomUUID(),
) {
  return withPgTransaction(
    fixture.pgDatabase,
    (tx) =>
      recordAttempt(tx, fixture.organizationId, String(resultId), {
        deliveryKey,
        state: state as "passed",
        reason: score === null ? "The checker failed: " + state : null,
        score,
        startedAt: new Date(),
        endedAt: new Date(),
      }),
  );
}

Deno.test("admission lists every required result; duplicates add nothing; the gate needs every measurement", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const batch = await admit(fixture, w, [w.rubric, w.schema]);
    // Deterministic first, whatever order was asked.
    assertEquals(
      (batch.scorers as Json[]).map((s) => s.evaluatorType),
      ["deterministic", "model"],
    );
    assertEquals([batch.state, batch.requiredCount, batch.measuredCount], [
      "queued",
      4,
      0,
    ]);
    assertEquals((batch.counts as Json).missing, 4);
    assertEquals((batch.gate as Json).decision, "cannot_be_judged");
    const rows = await results(fixture, batch.id);
    assertEquals(rows.length, 4);
    assert(
      rows.every((r) => r.state === "missing" && r.reason === "Not run yet."),
    );

    // AC1: one delivery recorded twice is one attempt.
    const key = crypto.randomUUID();
    assertEquals(
      await record(fixture, rows[0].id, "passed", 1, key),
      "recorded",
    );
    assertEquals(
      await record(fixture, rows[0].id, "passed", 1, key),
      "duplicate",
    );
    const attempts = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + rows[0].id + "/attempts",
      ),
    );
    assertEquals((attempts.items as Json[]).length, 1);
    // A retry with a new delivery appends, and the result shows the latest.
    assertEquals(await record(fixture, rows[1].id, "error", null), "recorded");
    assertEquals(await record(fixture, rows[1].id, "passed", 0.9), "recorded");
    const second = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + rows[1].id + "/attempts",
      ),
    );
    assertEquals((second.items as Json[]).map((a) => a.state), [
      "error",
      "passed",
    ]);

    // AC2: an unscored result keeps the gate from passing.
    await record(fixture, rows[2].id, "passed", 1);
    await record(fixture, rows[3].id, "unscored", null);
    let read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    assertEquals(read.state, "completed_with_errors");
    assertEquals((read.gate as Json).decision, "cannot_be_judged");
    assertEquals(
      ((read.gate as Json).blockers as Json[]).map((b) => b.state),
      ["unscored"],
    );
    assertEquals((await results(fixture, batch.id, "unscored")).length, 1);

    // AC4: once measured, it is judged.
    await record(fixture, rows[3].id, "passed", 1);
    read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    assertEquals([read.state, (read.gate as Json).decision], [
      "completed",
      "met",
    ]);
    assertEquals(read.measuredCount, 4);
  }));

Deno.test("a batch and its results carry the names a list shows, and a cancel names who stopped it", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const agentId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      "insert into bakery.agent_definitions (id, organization_id, slug, name) values ($1, $2, 'eval-agent', 'Review agent')",
      [agentId, fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      "insert into bakery.workflow_definitions (id, organization_id, slug, name) values ($1, $2, 'eval-flow', 'Release flow')",
      [workflowId, fixture.organizationId],
    );
    const unresolved = crypto.randomUUID();
    const batch = await ok(
      await call(fixture, "POST", "/v1/evaluation-batches", {
        body: {
          datasetId: w.dataset.id,
          candidate: { kind: "agentVersion", id: agentId, version: 2 },
          baseline: { kind: "workflowVersion", id: workflowId, version: 1 },
          scorerIds: [w.schema.id],
        },
      }),
      201,
    );
    assertEquals(batch.datasetName, "smoke");
    assertEquals(batch.candidateDefinition, {
      definitionId: agentId,
      name: "Review agent",
    });
    assertEquals(batch.baselineDefinition, {
      definitionId: workflowId,
      name: "Release flow",
    });
    assertEquals(batch.canceledBy, null, "not canceled yet");
    // The opaque pin is untouched.
    assertEquals(batch.candidate, {
      kind: "agentVersion",
      id: agentId,
      version: 2,
    });

    // A pin that names nothing this organization has shows no name, not an error.
    const orphan = await ok(
      await call(fixture, "POST", "/v1/evaluation-batches", {
        body: {
          datasetId: w.dataset.id,
          candidate: { kind: "agentVersion", id: unresolved, version: 1 },
          scorerIds: [w.schema.id],
        },
      }),
      201,
    );
    assertEquals(orphan.candidateDefinition, {
      definitionId: unresolved,
      name: null,
    });
    assertEquals(orphan.baselineDefinition, null, "no baseline pinned");

    // The list answers the same names, so a page needs no second read.
    const page = await ok(await call(fixture, "GET", "/v1/evaluation-batches"));
    const listed = (page.items as Json[]).find((item) => item.id === batch.id)!;
    assertEquals(listed.datasetName, "smoke");
    assertEquals(
      (listed.candidateDefinition as Json).name,
      "Review agent",
    );

    // Results name their case, in case order.
    const rows = await results(fixture, batch.id);
    const nameOf = new Map(w.cases.map((c) => [c.id, c.name]));
    assert(rows.length > 0);
    for (const row of rows) {
      assertEquals(
        row.caseName,
        nameOf.get(row.caseId),
        "the case it measured",
      );
    }
    assertEquals(
      new Set(rows.map((row) => row.caseName)),
      new Set(["first", "second"]),
    );

    // A cancel records the person who stopped it.
    const canceled = await ok(
      await call(
        fixture,
        "POST",
        "/v1/evaluation-batches/" + batch.id + "/cancel",
        { body: {}, ifMatch: Number(batch.version) },
      ),
    );
    assertEquals(canceled.canceledBy, fixture.principalId);
    assert(canceled.canceledAt !== null);
  }));

Deno.test("a pin naming another organization's definition shows no name", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const foreign = await createWorkerScope(
      fixture,
      "eval-75-foreign",
      fixture,
    );
    const foreignAgent = crypto.randomUUID();
    try {
      await fixture.pgDatabase.query(
        "insert into bakery.agent_definitions (id, organization_id, slug, name) values ($1, $2, 'foreign-agent', 'Foreign secret agent')",
        [foreignAgent, foreign.organizationId],
      );
      const batch = await ok(
        await call(fixture, "POST", "/v1/evaluation-batches", {
          body: {
            datasetId: w.dataset.id,
            candidate: { kind: "agentVersion", id: foreignAgent, version: 1 },
            scorerIds: [w.schema.id],
          },
        }),
        201,
      );
      // The name lookup is scoped to the caller's organization, so another
      // organization's definition resolves to no name and leaks nothing.
      assertEquals(batch.candidateDefinition, {
        definitionId: foreignAgent,
        name: null,
      });
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.agent_definitions where id = $1",
        [foreignAgent],
      );
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));

Deno.test("cancel takes If-Match and keeps completed results; compare refuses incompatible pairs; another organization cannot read", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const left = await admit(fixture, w, [w.schema]);
    const rows = await results(fixture, left.id);
    await record(fixture, rows[0].id, "passed", 1);

    const stale = await call(
      fixture,
      "POST",
      "/v1/evaluation-batches/" + left.id + "/cancel",
      {
        body: {},
        ifMatch: Number(left.version) + 5,
      },
    );
    assertEquals(stale.status, 412, await stale.text());
    const current = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + left.id),
    );
    const canceled = await ok(
      await call(
        fixture,
        "POST",
        "/v1/evaluation-batches/" + left.id + "/cancel",
        {
          body: {},
          ifMatch: Number(current.version),
        },
      ),
    );
    assertEquals(canceled.state, "canceled");
    assertEquals((canceled.counts as Json).passed, 1);
    assertEquals((canceled.counts as Json).canceled, 1);
    assertEquals((canceled.gate as Json).decision, "cannot_be_judged");

    // Compatible: same dataset and scorer revisions.
    const right = await admit(fixture, w, [w.schema]);
    const rr = await results(fixture, right.id);
    await record(fixture, rr[0].id, "failed", 0);
    await record(fixture, rr[1].id, "passed", 1);
    const same = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-batches/" + left.id + "/compare?other=" + right.id,
      ),
    );
    assertEquals(same.compatible, true);
    const measure = (same.measures as Json[])[0];
    assertEquals(measure.left, { passRate: 1, cases: 1 });
    assertEquals(measure.right, { passRate: 0.5, cases: 2 });
    assertEquals(measure.change, -0.5);

    // Incompatible: another scorer revision.
    const v2 = await w.scorer("schema", 2);
    const other = await admit(fixture, w, [v2]);
    const refused = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-batches/" + left.id + "/compare?other=" + other.id,
      ),
    );
    assertEquals([refused.compatible, refused.reason], [
      false,
      "different_scorer_version",
    ]);
    assertEquals(refused.measures, []);

    const foreign = await createWorkerScope(fixture, "eval-44", fixture);
    try {
      const hidden = await call(
        fixture,
        "GET",
        "/v1/evaluation-batches/" + left.id,
        {
          organizationId: foreign.organizationId,
        },
      );
      assertEquals(hidden.status, 404, await hidden.text());
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));

// The judge's receipt as it travels: bounded-judge.ts omits the figures it
// does not have, so a timeout carries no costUsd and no token counts.
type WireReceipt =
  & Omit<UsageReceipt, "inputTokens" | "outputTokens" | "costUsd">
  & Partial<Pick<UsageReceipt, "inputTokens" | "outputTokens" | "costUsd">>;

// The judge's receipt, shaped as apps/worker/src/bounded-judge.ts builds it.
function judgeReceipt(
  run: AdmittedJob,
  assignment: WorkerAssignment,
  options: Readonly<{
    providerCallId: string;
    costUsd: string | null;
  }>,
): WireReceipt {
  return {
    usageFactId: "evaluation.score:" + assignment.attemptId,
    providerCallId: options.providerCallId,
    provider: String(run.billing?.provider),
    billingAccountId: String(run.billing?.billingAccountId),
    model: String(run.billing?.model),
    billingRoute: "api",
    pricingMetadataSnapshot: String(run.billing?.pricingMetadataSnapshot),
    ...(options.costUsd === null ? { measurement: "unknown" as const } : {
      inputTokens: "10",
      outputTokens: "4",
      costUsd: options.costUsd,
      measurement: "reported" as const,
    }),
    occurredAt: new Date().toISOString(),
  };
}

// Cancel locks the batch then its missing results; a worker attempt must
// take the same order. A third transaction holds the result row, the attempt
// queues first, the cancel second. Under the old order (result row first,
// batch later) the two waited on each other and Postgres raised 40P01.
Deno.test("a cancel racing a worker attempt never deadlocks", () =>
  withWorkerFixture(async (fixture) => {
    const side = openPgDatabase(readTestDatabaseConfig().databaseUrl, 4);
    try {
      const w = await world(fixture);
      const batch = await admit(fixture, w, [w.schema]);
      const rows = await results(fixture, batch.id);
      const hold = await holdRow(
        side,
        "select id from bakery.evaluation_results where id = $1 for update",
        [rows[0].id],
      );
      const [attempt, cancel] = await raceInOrder(
        side,
        hold,
        () => record(fixture, rows[0].id, "passed", 1),
        () =>
          call(
            fixture,
            "POST",
            "/v1/evaluation-batches/" + batch.id + "/cancel",
            { body: {}, ifMatch: Number(batch.version) },
          ),
      );
      assertNoDeadlock(attempt);
      assertNoDeadlock(cancel);
      assert(attempt.status === "fulfilled");
      assertEquals(attempt.value, "recorded");
      assert(cancel.status === "fulfilled");
      // The attempt moved the batch to running, so the cancel's If-Match
      // is stale: one typed outcome, never a server error.
      const text = await cancel.value.text();
      assert([200, 412].includes(cancel.value.status), text);
      const read = await ok(
        await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
      );
      assertEquals((read.counts as Json).passed, 1);
    } finally {
      await closePgDatabase(side);
    }
  }));

Deno.test("an evaluation.score result settles its judge receipt against the reservation", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const w = await world(fixture);
    const batch = await admit(fixture, w, [w.rubric]);
    const rows = await results(fixture, batch.id);
    assertEquals(rows.length, 2);
    await seedProviderPricingSnapshot(db);
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("evaluation.score"),
      ]),
    ];
    const worker = await registeredWorker(fixture, { capabilities, slots: 4 });
    const outputSchema = {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string" } },
    };

    const runFor = async (resultId: unknown, stepKey: string) =>
      await admitFundedModelRun(
        db,
        await seedAdmissibleRun(
          db,
          fixture.organizationId,
          fixture.principalId,
          {
            action: "evaluation.score",
            reservationUsd: "0.05",
            stepKey,
            input: {
              evaluationResultId: String(resultId),
              outputArtifactVersionId: w.versionId,
              rubric: "Is the output polite?",
              outputSchema,
            },
          },
        ),
      );
    const claim = async (run: AdmittedJob) => {
      const assignment = await claimAssignment(fixture, worker, {
        capabilities,
        supportedActions: ["evaluation.score"],
      });
      assertEquals(assignment.jobId, run.jobId);
      return assignment;
    };
    const post = async (
      assignment: WorkerAssignment,
      result: Json,
      usage: WireReceipt,
    ) => {
      const response = await postWorkerResult(fixture, worker, assignment, {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        status: "completed",
        result,
        usage,
      }, crypto.randomUUID());
      assertEquals(response.status, 200, await response.text());
    };
    const usageRow = async (usageFactId: string) =>
      (await db.query<{
        measurement: string;
        costUsd: string | null;
        providerCallId: string;
      }>(
        `select measurement, cost_usd::text as "costUsd",
                provider_call_id as "providerCallId"
           from bakery.usage_records
          where organization_id = $1 and usage_fact_id = $2`,
        [fixture.organizationId, usageFactId],
      )).rows;
    const runAccount = async (runId: string) =>
      (await db.query<{ reservedUsd: string; settledUsd: string }>(
        `select reserved_usd::text as "reservedUsd",
                settled_usd::text as "settledUsd"
           from bakery.budget_accounts
          where organization_id = $1 and run_id = $2 and scope = 'run'`,
        [fixture.organizationId, runId],
      )).rows;
    const stored = async (resultId: unknown) =>
      (await results(fixture, batch.id)).find((r) => r.id === resultId);

    // (a) An answered call: a reported cost settles the hold and the
    // measurement counts.
    const answered = await runFor(rows[0].id, "judge-answered");
    assertEquals(await runAccount(answered.runId), [
      { reservedUsd: "0.050000", settledUsd: "0.000000" },
    ]);
    const answeredAssignment = await claim(answered);
    const reported = judgeReceipt(answered, answeredAssignment, {
      providerCallId: "judge-session-" + answeredAssignment.attemptId,
      costUsd: "0.030000",
    });
    await withPgTransaction(db, async (tx) => {
      await bindProviderCallIntent(tx, {
        organizationId: answered.organizationId,
        installationReservationId: answered.installationReservationId,
        providerCallId: reported.providerCallId,
      });
      const intent = (await tx.query<{ id: string }>(
        `select provider_call_intent_id as id
           from bakery.budget_action_intents
          where organization_id = $1 and installation_reservation_id = $2`,
        [answered.organizationId, answered.installationReservationId],
      )).rows[0];
      assert(intent?.id);
      await recordProviderUsageReceipt(tx, {
        organizationId: answered.organizationId,
        providerCallIntentId: intent.id,
        receipt: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          ...reported,
        },
      });
    });
    await post(answeredAssignment, {
      state: "failed",
      score: 0.25,
      reason: "The reply was curt.",
      judgeOutput: { verdict: "curt" },
    }, reported);
    assertEquals(await usageRow(reported.usageFactId), [
      {
        measurement: "reported",
        costUsd: "0.030000",
        providerCallId: reported.providerCallId,
      },
    ]);
    assertEquals(await runAccount(answered.runId), [
      { reservedUsd: "0.000000", settledUsd: "0.030000" },
    ]);
    const measured = await stored(rows[0].id);
    assertEquals([measured?.state, measured?.score], ["failed", 0.25]);

    // (b) A timed-out call: unknown usage under the attempt-named call id,
    // no cost. The hold stays reserved (money may be owed, never free) and
    // the result is unscored.
    const timedOut = await runFor(rows[1].id, "judge-timeout");
    const timeoutAssignment = await claim(timedOut);
    const unknown = judgeReceipt(timedOut, timeoutAssignment, {
      providerCallId: "evaluation.score.timeout:" +
        timeoutAssignment.attemptId,
      costUsd: null,
    });
    assertEquals("costUsd" in unknown, false);
    await withPgTransaction(db, (tx) =>
      bindProviderCallIntent(tx, {
        organizationId: timedOut.organizationId,
        installationReservationId: timedOut.installationReservationId,
        providerCallId: unknown.providerCallId,
      }));
    await post(timeoutAssignment, {
      state: "unscored",
      score: null,
      reason: "the judge did not answer within 1000 ms",
      judgeOutput: null,
    }, unknown);
    assertEquals(await usageRow(unknown.usageFactId), [
      {
        measurement: "unknown",
        costUsd: null,
        providerCallId: unknown.providerCallId,
      },
    ]);
    assertEquals(await runAccount(timedOut.runId), [
      { reservedUsd: "0.050000", settledUsd: "0.000000" },
    ]);
    const unmeasured = await stored(rows[1].id);
    assertEquals([unmeasured?.state, unmeasured?.score], ["unscored", null]);
    assert(String(unmeasured?.reason).includes("did not answer"));
  }));
