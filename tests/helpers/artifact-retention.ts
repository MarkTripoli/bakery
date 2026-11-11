import { assert } from "@std/assert";
import {
  closeWorkerFixture,
  openWorkerFixture,
  seedEligibleJob,
} from "./worker-execution.ts";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

export async function retentionFixture(
  options: { env?: Record<string, string> } = {},
) {
  const fixture = await openWorkerFixture(options);
  try {
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await fixture.pgDatabase.query(
      "update bakery.tasks set status='completed' where id=$1",
      [job.taskId],
    );
    await fixture.pgDatabase.query(
      "update bakery.workflow_runs set status='completed' where id=$1",
      [job.runId],
    );
    await fixture.pgDatabase.query(
      "update bakery.run_steps set status='completed' where id=$1",
      [job.runStepId],
    );
    await fixture.pgDatabase.query(
      "update bakery.jobs set status='completed' where id=$1",
      [job.jobId],
    );
    const artifactId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'plan','Retention test')",
      [artifactId, fixture.organizationId, job.taskId],
    );
    const content = new TextEncoder().encode("Immutable retention evidence");
    const sha256 = await sha256Bytes(content);
    const versionId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class,expires_at)
      values($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain','evidence',now()-interval '1 day')`,
      [
        versionId,
        fixture.organizationId,
        artifactId,
        job.taskId,
        fixture.principalId,
        content,
        sha256,
        content.length,
      ],
    );
    await fixture.pgDatabase.query(
      "update bakery.artifacts set current_version_id=$1,revision=2 where id=$2",
      [versionId, artifactId],
    );
    return {
      ...fixture,
      job,
      artifactId,
      versionId,
      content,
      sha256,
      async publish(publishedContent = content) {
        return await withPgTransaction(
          fixture.runtimePgDatabase,
          async (transaction) =>
            await commitArtifactVersion(transaction, {
              scope: {
                organizationId: fixture.organizationId,
                taskId: job.taskId,
                applicationId: job.applicationId,
                repositoryId: null,
                conversationId: job.conversationId,
              },
              parent: {
                id: artifactId,
                revision: 2,
                version: 1,
                currentVersionId: versionId,
              },
              version: {
                parentVersionId: `"${versionId}"`,
                runStepId: null,
                authorId: fixture.principalId,
                subjectHeadSha: null,
                subjectBaseSha: null,
                stepKey: null,
                metadata: { retentionClass: "transient" },
                content: publishedContent,
                sha256: await sha256Bytes(publishedContent),
                mediaType: "text/plain",
              },
              promotion: { kind: "human" },
            }),
        );
      },
      request(
        path: string,
        options: {
          pinned?: boolean;
          version?: number;
          organizationId?: string;
          headers?: Record<string, string>;
        } = {},
      ) {
        return fixture.app.fetch(
          new Request(`${fixture.config.publicBaseUrl}${path}`, {
            method: options.pinned === undefined ? "GET" : "PATCH",
            headers: {
              cookie: fixture.adminCookie,
              "bakery-organization-id": options.organizationId ??
                fixture.organizationId,
              ...(options.pinned === undefined ? {} : {
                "content-type": "application/json",
                "origin": fixture.config.publicBaseUrl,
                "idempotency-key": crypto.randomUUID(),
              }),
              ...(options.version === undefined
                ? {}
                : { "if-match": `"${options.version}"` }),
              ...options.headers,
            },
            ...(options.pinned === undefined
              ? {}
              : { body: JSON.stringify({ pinned: options.pinned }) }),
          }),
        );
      },
      async closeRetention() {
        await fixture.pgDatabase.query(
          "delete from bakery.artifact_drafts where organization_id=$1",
          [fixture.organizationId],
        );
        await closeWorkerFixture(fixture);
      },
    };
  } catch (error) {
    await closeWorkerFixture(fixture);
    throw error;
  }
}

export async function assertRetained(
  fixture: Awaited<ReturnType<typeof retentionFixture>>,
) {
  const result = await fixture.pgDatabase.query<{ present: boolean }>(
    "select content is not null and purged_at is null as present from bakery.artifact_versions where id=$1",
    [fixture.versionId],
  );
  assert(result.rows[0]?.present);
}
