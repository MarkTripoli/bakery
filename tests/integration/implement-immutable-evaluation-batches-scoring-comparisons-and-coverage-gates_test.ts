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
  seedEligibleJob,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
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
  return { cases, schema, rubric, dataset, scorer };
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
