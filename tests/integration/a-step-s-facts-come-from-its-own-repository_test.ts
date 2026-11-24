import { assertEquals } from "@std/assert";
import { chooseStepFacts } from "../../apps/server/src/modules/knowledge/step-facts.ts";
import { openWorkerFixture } from "../helpers/worker-execution.ts";

type Db = Awaited<ReturnType<typeof openWorkerFixture>>["pgDatabase"];

async function seedRepository(
  db: Db,
  organizationId: string,
): Promise<string> {
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  await db.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1,$2,$3,'Facts application')`,
    [applicationId, organizationId, `app-${applicationId}`],
  );
  await db.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1,$2,$3,$4,$5,'facts-owner',$6,'main')`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `repo-${repositoryId}`,
      `repo-${repositoryId}`,
    ],
  );
  return repositoryId;
}

async function seedCitedVersion(
  db: Db,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1,$2,$3,'Facts seed')`,
    [applicationId, organizationId, `app-${applicationId}`],
  );
  await db.query(
    `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
     values ($1,$2,$3,'Facts seed',$4)`,
    [conversationId, organizationId, applicationId, principalId],
  );
  await db.query(
    `insert into bakery.tasks (id, organization_id, application_id, conversation_id,
       title, task_type, status, priority, created_by)
     values ($1,$2,$3,$4,'Facts seed','feature','active',50,$5)`,
    [taskId, organizationId, applicationId, conversationId, principalId],
  );
  await db.query(
    `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
     values ($1,$2,$3,'research','facts seed')`,
    [artifactId, organizationId, taskId],
  );
  await db.query(
    `insert into bakery.artifact_versions (
       id, organization_id, artifact_id, task_id, author_id, revision,
       metadata, content, sha256, size_bytes, media_type
     ) values ($1,$2,$3,$4,$5,1,'{}'::jsonb,$6,$7,1,'text/plain')`,
    [
      versionId,
      organizationId,
      artifactId,
      taskId,
      principalId,
      new Uint8Array([1]),
      "a".repeat(64),
    ],
  );
  return versionId;
}

async function seedFact(
  db: Db,
  input: {
    organizationId: string;
    repositoryId: string;
    sourceVersionId: string;
    createdBy: string;
    body: string;
    status: "active" | "proposed" | "retired";
    updatedAt: string;
  },
): Promise<void> {
  const memoryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.memory_entries
       (id, organization_id, repository_id, topic, status, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$6)`,
    [
      memoryId,
      input.organizationId,
      input.repositoryId,
      `topic ${memoryId}`,
      input.status,
      input.updatedAt,
    ],
  );
  await db.query(
    `insert into bakery.memory_revisions (
       id, organization_id, memory_id, revision, body,
       source_artifact_version_id, confidence, created_by, created_at
     ) values ($1,$2,$3,1,$4,$5,0.9,$6,$7)`,
    [
      revisionId,
      input.organizationId,
      memoryId,
      input.body,
      input.sourceVersionId,
      input.createdBy,
      input.updatedAt,
    ],
  );
  await db.query(
    "update bakery.memory_entries set current_revision_id = $2 where id = $1",
    [memoryId, revisionId],
  );
}

Deno.test("a step's facts are only the active ones in its own repository and organization", async () => {
  const fixture = await openWorkerFixture({});
  try {
    const organizationId = fixture.organizationId;
    const repositoryId = await seedRepository(
      fixture.pgDatabase,
      organizationId,
    );
    const neighbour = await seedRepository(fixture.pgDatabase, organizationId);
    const sourceVersionId = await seedCitedVersion(
      fixture.pgDatabase,
      organizationId,
      fixture.principalId,
    );
    const common = {
      organizationId,
      sourceVersionId,
      createdBy: fixture.principalId,
    };
    await seedFact(fixture.pgDatabase, {
      ...common,
      repositoryId,
      body: "older in-scope fact",
      status: "active",
      updatedAt: "2026-11-01T10:00:00.000Z",
    });
    await seedFact(fixture.pgDatabase, {
      ...common,
      repositoryId,
      body: "newer in-scope fact",
      status: "active",
      updatedAt: "2026-11-20T10:00:00.000Z",
    });
    await seedFact(fixture.pgDatabase, {
      ...common,
      repositoryId,
      body: "retired fact",
      status: "retired",
      updatedAt: "2026-11-21T10:00:00.000Z",
    });
    await seedFact(fixture.pgDatabase, {
      ...common,
      repositoryId,
      body: "proposed fact",
      status: "proposed",
      updatedAt: "2026-11-22T10:00:00.000Z",
    });
    await seedFact(fixture.pgDatabase, {
      ...common,
      repositoryId: neighbour,
      body: "neighbour repository fact",
      status: "active",
      updatedAt: "2026-11-23T10:00:00.000Z",
    });

    const chosen = await chooseStepFacts(fixture.pgDatabase, {
      organizationId,
      repositoryId,
    });
    assertEquals(chosen.facts.map((fact) => fact.wording), [
      "newer in-scope fact",
      "older in-scope fact",
    ]);
    assertEquals(chosen.omitted, 0);

    const wrongOrganization = await chooseStepFacts(fixture.pgDatabase, {
      organizationId: crypto.randomUUID(),
      repositoryId,
    });
    assertEquals(wrongOrganization.facts, []);
    assertEquals(wrongOrganization.omitted, 0);
  } finally {
    await fixture.close();
  }
});
