/**
 * #41 against Postgres and the real routes. AC1: a batch pins exact versions,
 * so the same pins give the same digest and a loose pin is refused. AC2: an
 * optional model scorer that never ran neither blocks the release gate nor
 * stands in for a required check, and a deterministic check cannot be made
 * optional. AC3: the corpus report keeps unknown and unrun apart from zero, a
 * duplicate completion is one attempt, and an interrupted result that recovers
 * is counted once.
 */

import { assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleJob } from "../helpers/worker-execution.ts";
import { recordAttempt } from "../../apps/server/src/modules/evaluations/store.ts";

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

const PIN = {
  kind: "agentVersion",
  id: "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7",
  version: 2,
};

function admitWith(
  fixture: Fixture,
  w: Awaited<ReturnType<typeof world>>,
  body: Json,
) {
  return call(fixture, "POST", "/v1/evaluation-batches", {
    body: { datasetId: w.dataset.id, candidate: PIN, ...body },
  });
}

Deno.test("AC1: a loose pin is refused, and the same pins give the same digest", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const scorerIds = [w.schema.id];
    for (
      const [candidate, reason] of [
        [{ kind: "agent", id: PIN.id, version: 1 }, "pin_kind_unknown"],
        [{ kind: "agentVersion", id: PIN.id }, "pin_version_required"],
        [{ kind: "agentVersion", id: "x", version: 1 }, "pin_id_invalid"],
        [{ ...PIN, latest: true }, "pin_unknown_field"],
      ] as const
    ) {
      const refused = await admitWith(fixture, w, { candidate, scorerIds });
      const text = await refused.text();
      assertEquals(refused.status, 422, text);
      assertEquals(text.includes(reason), true, text);
    }
    const first = await ok(await admitWith(fixture, w, { scorerIds }), 201);
    const again = await ok(await admitWith(fixture, w, { scorerIds }), 201);
    assertEquals(typeof first.pinDigest, "string");
    assertEquals(first.pinDigest, again.pinDigest, "same pins, same digest");
    const other = await ok(
      await admitWith(fixture, w, {
        scorerIds,
        candidate: { ...PIN, version: 3 },
      }),
      201,
    );
    assertEquals(other.pinDigest === first.pinDigest, false);
    const more = await ok(
      await admitWith(fixture, w, { scorerIds, repetitions: 2 }),
      201,
    );
    assertEquals(more.pinDigest === first.pinDigest, false);
    // The budget is not part of what is measured.
    const budgeted = await ok(
      await admitWith(fixture, w, { scorerIds, budgetLimitUsd: "5" }),
      201,
    );
    assertEquals(budgeted.pinDigest, first.pinDigest);
  }));

Deno.test("AC2: an optional model scorer that never ran neither blocks the gate nor replaces a required check", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    // A deterministic check is never optional; the scorer must be pinned.
    for (const optionalScorerIds of [[w.schema.id], [crypto.randomUUID()]]) {
      const refused = await admitWith(fixture, w, {
        scorerIds: [w.schema.id, w.rubric.id],
        optionalScorerIds,
      });
      assertEquals(refused.status, 422, await refused.text());
    }
    const batch = await ok(
      await admitWith(fixture, w, {
        scorerIds: [w.schema.id, w.rubric.id],
        optionalScorerIds: [w.rubric.id],
      }),
      201,
    );
    assertEquals(
      (batch.scorers as Json[]).map((s) => [s.evaluatorType, s.required]),
      [["deterministic", true], ["model", false]],
    );
    // Only the deterministic results are required: 2 cases x 1 scorer.
    assertEquals(batch.requiredCount, 2);
    assertEquals((batch.report as Json).total, 2);
    assertEquals((batch.optionalReport as Json).total, 2);
    assertEquals((batch.optionalReport as Json).unrun, 2);
    const rows = await results(fixture, batch.id);
    assertEquals(rows.length, 4);
    // The model scorer is unavailable: its results stay unscored with a reason.
    for (const row of rows) {
      if (row.scorerId === w.rubric.id) {
        await record(fixture, row.id, "unscored", null);
      } else await record(fixture, row.id, "passed", 1);
    }
    const read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    assertEquals([read.state, (read.gate as Json).decision], [
      "completed",
      "met",
    ]);
    assertEquals((read.report as Json).passed, 2);
    const optional = read.optionalReport as Json;
    assertEquals([optional.attempted, optional.passed, optional.unknown], [
      2,
      0,
      2,
    ]);
    assertEquals(
      optional.passedOfAttempted,
      0,
      "measured nothing passed: a real zero, not unknown",
    );
    // A required model scorer that is unavailable keeps the gate from judging.
    const strict = await ok(
      await admitWith(fixture, w, { scorerIds: [w.schema.id, w.rubric.id] }),
      201,
    );
    for (const row of await results(fixture, strict.id)) {
      if (row.scorerId === w.rubric.id) {
        await record(fixture, row.id, "unscored", null);
      } else await record(fixture, row.id, "passed", 1);
    }
    const judged = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + strict.id),
    );
    assertEquals((judged.gate as Json).decision, "cannot_be_judged");
  }));

Deno.test("AC3: unknown and unrun stay apart from zero, a duplicate completion is one attempt, and a recovery is counted once", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const batch = await ok(
      await admitWith(fixture, w, { scorerIds: [w.schema.id], repetitions: 2 }),
      201,
    );
    const rows = await results(fixture, batch.id);
    assertEquals(rows.length, 4);
    // Nothing attempted: no share, not zero.
    let report = batch.report as Json;
    assertEquals([report.total, report.attempted, report.unrun], [4, 0, 4]);
    assertEquals(report.passedOfAttempted, null);
    assertEquals(report.recoveredOfInterrupted, null);

    // One duplicate delivery adds nothing.
    const key = crypto.randomUUID();
    assertEquals(
      await record(fixture, rows[0].id, "passed", 1, key),
      "recorded",
    );
    assertEquals(
      await record(fixture, rows[0].id, "passed", 1, key),
      "duplicate",
    );
    // One result is interrupted and then recovers.
    assertEquals(
      await record(fixture, rows[1].id, "interrupted", null),
      "recorded",
    );
    let read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    report = read.report as Json;
    assertEquals(
      [report.attempted, report.passed, report.unknown, report.unrun],
      [2, 1, 1, 2],
    );
    assertEquals([report.interrupted, report.recovered], [1, 0]);
    // An interrupted attempt leaves its result an error with the reason.
    const interrupted = (await results(fixture, batch.id, "error"))[0];
    assertEquals(interrupted.id, rows[1].id);
    assertEquals(await record(fixture, rows[1].id, "failed", 0), "recorded");
    // A third result fails outright.
    assertEquals(await record(fixture, rows[2].id, "failed", 0), "recorded");
    read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    report = read.report as Json;
    assertEquals(
      [
        report.attempted,
        report.passed,
        report.failed,
        report.unknown,
        report.unrun,
      ],
      [3, 1, 2, 0, 1],
    );
    assertEquals([report.interrupted, report.recovered], [1, 1]);
    assertEquals(report.recoveredOfInterrupted, 1);
    assertEquals(report.passedOfAttempted, 1 / 3);
    assertEquals(report.failedOfAttempted, 2 / 3);
    const attempts = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + rows[1].id + "/attempts",
      ),
    );
    assertEquals((attempts.items as Json[]).map((a) => a.state), [
      "interrupted",
      "failed",
    ]);
  }));

Deno.test("AC3: a model attempt that ends with no ledger receipt is an unknown cost, never free, and a duplicate completion is one record", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const batch = await ok(
      await admitWith(fixture, w, {
        scorerIds: [w.schema.id, w.rubric.id],
        budgetLimitUsd: "0.10",
      }),
      201,
    );
    assertEquals(batch.budget, {
      limitUsd: "0.100000",
      settledUsd: "0.000000",
      unknownCount: 0,
      status: "within",
    });
    const rows = await results(fixture, batch.id);
    const model = rows.filter((r) => r.scorerId === w.rubric.id);
    const check = rows.find((r) => r.scorerId === w.schema.id)!;
    // The deterministic check costs nothing: it is not in the budget at all.
    await record(fixture, check.id, "passed", 1);
    let read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    assertEquals((read.budget as Json).unknownCount, 0);
    assertEquals((read.budget as Json).status, "within");
    // The provider failed before any receipt: the attempt costs an unknown
    // amount. The same delivery twice is still one attempt, so one unknown.
    const key = crypto.randomUUID();
    assertEquals(
      await record(fixture, model[0].id, "error", null, key),
      "recorded",
    );
    assertEquals(
      await record(fixture, model[0].id, "error", null, key),
      "duplicate",
    );
    read = await ok(
      await call(fixture, "GET", "/v1/evaluation-batches/" + batch.id),
    );
    assertEquals(read.budget, {
      limitUsd: "0.100000",
      settledUsd: "0.000000",
      unknownCount: 1,
      status: "unsettled",
    });
    const attempts = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + model[0].id + "/attempts",
      ),
    );
    assertEquals((attempts.items as Json[]).map((a) => a.usage), [
      { measurement: "unknown", costUsd: null },
    ]);
    const checkAttempts = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + check.id + "/attempts",
      ),
    );
    assertEquals((checkAttempts.items as Json[]).map((a) => a.usage), [null]);
  }));

/** A scorer revision with its own config (a deterministic check is {kind, config}). */
async function definition(
  fixture: Fixture,
  slug: string,
  evaluatorType: string,
  config: unknown,
) {
  return await ok(
    await call(fixture, "POST", "/v1/evaluation-definitions", {
      body: { slug, revision: 1, evaluatorType, config },
    }),
    201,
  );
}

const runBatch = async (fixture: Fixture, batchId: unknown, status = 200) =>
  await ok(
    await call(fixture, "POST", "/v1/evaluation-batches/" + batchId + "/run", {
      body: {},
    }),
    status,
  );

const outcome = (rows: Json[]) =>
  rows.map((r) => [r.caseName, r.scorerId, r.state, r.reason, r.score]);

Deno.test("AC1: a fixed corpus on the same pins gives the same outcomes and keeps the recorded output as its evidence", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const pass = await definition(fixture, "has-hi", "deterministic", {
      kind: "contains",
      config: { substring: "hi" },
    });
    const fail = await definition(fixture, "has-zz", "deterministic", {
      kind: "contains",
      config: { substring: "zz" },
    });
    const notACheck = await definition(
      fixture,
      "not-a-check",
      "deterministic",
      {
        check: "x",
      },
    );
    const scorerIds = [pass.id, fail.id, notACheck.id];
    const first = await ok(await admitWith(fixture, w, { scorerIds }), 201);
    const second = await ok(await admitWith(fixture, w, { scorerIds }), 201);
    assertEquals(first.pinDigest, second.pinDigest);

    const ran = await runBatch(fixture, first.id);
    // 2 cases x 3 scorers, each settled: pass, fail, and a config that is no check.
    const rows = await results(fixture, first.id);
    assertEquals(rows.length, 6);
    const by = (id: unknown) => rows.filter((r) => r.scorerId === id);
    assertEquals(by(pass.id).map((r) => [r.state, r.score]), [["passed", 1], [
      "passed",
      1,
    ]]);
    assertEquals(by(fail.id).map((r) => [r.state, r.score]), [["failed", 0], [
      "failed",
      0,
    ]]);
    assertEquals(by(notACheck.id).map((r) => [r.state, r.score]), [[
      "error",
      null,
    ], ["error", null]]);
    assertEquals(
      String(by(notACheck.id)[0].reason).startsWith(
        "The scorer config is not a check",
      ),
      true,
    );
    // The recorded output is the evidence of every result and every result has one attempt.
    assertEquals(
      rows.map((r) => r.outputArtifactVersionId),
      rows.map(() => w.versionId),
    );
    assertEquals(rows.map((r) => r.attemptCount), rows.map(() => 1));
    const report = ran.report as Json;
    assertEquals(
      [
        report.total,
        report.attempted,
        report.passed,
        report.failed,
        report.unknown,
        report.unrun,
      ],
      [6, 6, 2, 2, 2, 0],
    );
    assertEquals(ran.state, "completed_with_errors");
    assertEquals(
      (ran.gate as Json).decision,
      "cannot_be_judged",
      "an error is not a pass",
    );

    // The same corpus again, on another batch with the same pins: the same outcomes.
    await runBatch(fixture, second.id);
    assertEquals(outcome(await results(fixture, second.id)), outcome(rows));

    // A repeat settles nothing again: still one attempt each.
    await runBatch(fixture, first.id);
    assertEquals(
      (await results(fixture, first.id)).map((r) => r.attemptCount),
      rows.map(() => 1),
    );
  }));

Deno.test("AC2: a local run never replaces a check with an opinion: model and baseline results are skipped with a reason and stay unrun", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const check = await definition(fixture, "has-hi-2", "deterministic", {
      kind: "contains",
      config: { substring: "hi" },
    });
    // A required model scorer that cannot run keeps the gate from judging.
    const strict = await ok(
      await admitWith(fixture, w, { scorerIds: [check.id, w.rubric.id] }),
      201,
    );
    let ran = await runBatch(fixture, strict.id);
    const rows = await results(fixture, strict.id);
    const model = rows.filter((r) => r.scorerId === w.rubric.id);
    assertEquals(model.map((r) => [r.state, r.attemptCount]), [["skipped", 0], [
      "skipped",
      0,
    ]]);
    assertEquals(
      String(model[0].reason).startsWith(
        "A local corpus run scores recorded outputs",
      ),
      true,
    );
    assertEquals(
      rows.filter((r) => r.scorerId === check.id).map((r) => r.state),
      ["passed", "passed"],
    );
    assertEquals((ran.gate as Json).decision, "cannot_be_judged");
    assertEquals(
      (ran.report as Json).unrun,
      2,
      "skipped is unrun, not unknown",
    );
    assertEquals((ran.report as Json).unknown, 0);

    // The same model scorer, optional: the required check decides, the opinion is reported apart.
    const loose = await ok(
      await admitWith(fixture, w, {
        scorerIds: [check.id, w.rubric.id],
        optionalScorerIds: [w.rubric.id],
      }),
      201,
    );
    ran = await runBatch(fixture, loose.id);
    assertEquals([ran.state, (ran.gate as Json).decision], [
      "completed",
      "met",
    ]);
    const optional = ran.optionalReport as Json;
    assertEquals([optional.total, optional.attempted, optional.unrun], [
      2,
      0,
      2,
    ]);

    // A baseline has no recorded output to score: skipped, and the candidate is still judged.
    const compared = await ok(
      await admitWith(fixture, w, {
        scorerIds: [check.id],
        baseline: { ...PIN, version: 1 },
      }),
      201,
    );
    ran = await runBatch(fixture, compared.id);
    const baseline = (await results(fixture, compared.id)).filter((r) =>
      r.role === "baseline"
    );
    assertEquals(baseline.map((r) => [r.state, r.attemptCount]), [[
      "skipped",
      0,
    ], ["skipped", 0]]);
    assertEquals([ran.state, (ran.gate as Json).decision], [
      "completed",
      "met",
    ]);
  }));

Deno.test("AC3: a canceled batch is not run, and two runs at once settle each result once", () =>
  withWorkerFixture(async (fixture) => {
    const w = await world(fixture);
    const check = await definition(fixture, "has-hi-3", "deterministic", {
      kind: "contains",
      config: { substring: "hi" },
    });
    const batch = await ok(
      await admitWith(fixture, w, { scorerIds: [check.id] }),
      201,
    );
    const both = await Promise.all([
      call(fixture, "POST", "/v1/evaluation-batches/" + batch.id + "/run", {
        body: {},
      }),
      call(fixture, "POST", "/v1/evaluation-batches/" + batch.id + "/run", {
        body: {},
      }),
    ]);
    for (const response of both) await ok(response, 200);
    const rows = await results(fixture, batch.id);
    assertEquals(rows.map((r) => [r.state, r.attemptCount]), [["passed", 1], [
      "passed",
      1,
    ]]);
    const attempts = await ok(
      await call(
        fixture,
        "GET",
        "/v1/evaluation-results/" + rows[0].id + "/attempts",
      ),
    );
    assertEquals(
      (attempts.items as Json[]).length,
      1,
      "one attempt record, not two",
    );

    const stopped = await ok(
      await admitWith(fixture, w, { scorerIds: [check.id] }),
      201,
    );
    await ok(
      await call(
        fixture,
        "POST",
        "/v1/evaluation-batches/" + stopped.id + "/cancel",
        {
          body: {},
          ifMatch: Number(stopped.version),
        },
      ),
      200,
    );
    const refused = await call(
      fixture,
      "POST",
      "/v1/evaluation-batches/" + stopped.id + "/run",
      { body: {} },
    );
    assertEquals(refused.status, 409, await refused.text());
    const unknown = await call(
      fixture,
      "POST",
      "/v1/evaluation-batches/" + crypto.randomUUID() + "/run",
      { body: {} },
    );
    assertEquals(unknown.status, 404, await unknown.text());
  }));
