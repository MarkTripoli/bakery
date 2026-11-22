/**
 * Shared setup for the evaluation corpus journeys (#41): a worker fixture, a
 * case with a recorded output, a dataset, two scorers, and the calls that
 * run and read a batch over the real routes.
 */

import { assertEquals } from "@std/assert";
import { seedEligibleJob } from "./worker-execution.ts";
import type { withWorkerFixture } from "./worker-execution/scenarios.ts";

export type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
export type Json = Record<string, unknown>;

export function call(
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

export async function ok(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

/** A repository, an input artifact version, two cases, a dataset, two scorers. */
export async function world(fixture: Fixture) {
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

export async function results(
  fixture: Fixture,
  batchId: unknown,
  state?: string,
) {
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

/** A scorer revision with its own config (a deterministic check is {kind, config}). */
export async function definition(
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

export const runBatch = async (
  fixture: Fixture,
  batchId: unknown,
  status = 200,
) =>
  await ok(
    await call(fixture, "POST", "/v1/evaluation-batches/" + batchId + "/run", {
      body: {},
    }),
    status,
  );

/** Each case x scorer with its verdict, in a fixed order: result ids are random, so listing order is not. */
