import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import { sha256Hex } from "../../../apps/server/src/platform/canonical-json.ts";
import {
  OutputBatchSchema,
  outputDigest,
} from "../../../packages/contracts/src/output.ts";
import { summarizePatch } from "../../../apps/web/src/pages/patch-summary.ts";
import type { Stack } from "./stack.ts";

const outputLines = [
  "14:32:01  worker atlas-01 acquired attempt 2",
  "14:32:02  $ pnpm test:unit",
  "14:32:03  artifact retention … passed",
  "14:32:04  immutable revision … passed",
  "14:32:05  18 tests passed, 0 failed",
  "14:32:06  writing delivery-notes.md",
  "14:32:07  published revision 3",
  "14:32:08  waiting for next output…",
] as const;

export async function seedRunOutput(
  stack: Pick<Stack, "ownerDatabaseUrl">,
  fixture: Readonly<
    {
      taskId: string;
      runId: string;
      stepId: string;
      scope: { organizationId: string; principalId: string };
    }
  >,
  attemptId: string,
): Promise<
  {
    streamId: string;
    jobId: string;
    artifactId: string;
    versionId: string;
    sha256: string;
  }
> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    return await withPgTransaction(database, async (transaction) => {
      const execution = (await transaction.query<{
        jobId: string;
        hostId: string;
        workerSessionId: string;
        workerSessionGeneration: string;
        fence: string;
        applicationId: string;
        conversationId: string;
      }>(
        `select a.job_id as "jobId", a.worker_host_id as "hostId", a.worker_session_id as "workerSessionId",
         a.worker_session_generation::text as "workerSessionGeneration", a.fence::text,
         task.application_id as "applicationId",task.conversation_id as "conversationId"
         from bakery.job_attempts a join bakery.jobs job on job.organization_id=a.organization_id and job.id=a.job_id
         join bakery.tasks task on task.organization_id=a.organization_id and task.id=$3
         where a.organization_id=$1 and a.id=$2 and job.run_step_id=$4 and job.application_id=task.application_id`,
        [
          fixture.scope.organizationId,
          attemptId,
          fixture.taskId,
          fixture.stepId,
        ],
      )).rows[0];
      assert(execution, "Seed attempt must have frozen task application scope");
      const streamId = crypto.randomUUID();
      const scope = {
        organizationId: fixture.scope.organizationId,
        applicationId: execution.applicationId,
        jobId: execution.jobId,
        taskId: fixture.taskId,
        runStepId: fixture.stepId,
        conversationId: execution.conversationId,
        logicalActor: "harness.implement:native",
      };
      await transaction.query(
        `insert into bakery.session_output_streams
        (id,organization_id,job_id,scope_digest,scope,highwater,writer_generation,display_bytes)
        values ($1,$2,$3,$4,$5::jsonb,8,1,$6)`,
        [
          streamId,
          fixture.scope.organizationId,
          execution.jobId,
          await outputDigest({ ...scope, input: {} }),
          JSON.stringify(scope),
          new TextEncoder().encode(outputLines.join("")).byteLength,
        ],
      );
      await transaction.query(
        `insert into bakery.session_output_producers
        (organization_id,session_id,writer_generation,attempt_id,worker_host_id,worker_session_id,worker_session_generation,fence)
        values ($1,$2,1,$3,$4,$5,$6,$7)`,
        [
          fixture.scope.organizationId,
          streamId,
          attemptId,
          execution.hostId,
          execution.workerSessionId,
          execution.workerSessionGeneration,
          execution.fence,
        ],
      );
      for (const [index, text] of outputLines.entries()) {
        const batchId = crypto.randomUUID();
        const payload = {
          sessionId: streamId,
          writerGeneration: "1",
          batchId,
          sequence: String(index + 1),
          parts: [{ itemId: crypto.randomUUID(), channel: "stdout", text }],
          capture: "capturing",
          reason: null,
        };
        const batch = OutputBatchSchema.parse({
          ...payload,
          digest: await outputDigest(payload),
        });
        await transaction.query(
          `insert into bakery.session_output_batches
          (organization_id,session_id,sequence,batch_id,writer_generation,attempt_id,event_id,payload)
          values ($1,$2,$3,$4,1,$5,$6,$7::jsonb)`,
          [
            fixture.scope.organizationId,
            streamId,
            batch.sequence,
            batchId,
            attemptId,
            crypto.randomUUID(),
            JSON.stringify(batch),
          ],
        );
      }
      const patch = ["retention.ts", "artifacts.ts", "output.ts"].map((file) =>
        [
          `diff --git a/${file} b/${file}`,
          `--- a/${file}`,
          `+++ b/${file}`,
          "@@ -1,4 +1,28 @@",
          ...Array.from({ length: 4 }, (_, i) =>
            `-old_${file}_${i}`),
          ...Array.from({ length: 28 }, (_, i) => `+durable_${file}_${i}`),
        ].join("\n")
      ).join("\n") + "\n";
      const contentText = patch.padEnd(13107, "\n");
      const content = new TextEncoder().encode(contentText);
      assertEquals(content.byteLength, 13107);
      assertEquals(summarizePatch(contentText), {
        files: 3,
        added: 84,
        removed: 12,
      });
      const digest = await sha256Hex(contentText);
      const artifactId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const baseSha = "8ac02e1".padEnd(40, "0");
      const headSha = "5d138ac".padEnd(40, "0");
      await transaction.query(
        `insert into bakery.artifacts
        (id,organization_id,task_id,artifact_type,name,revision,version)
        values ($1,$2,$3,'patch','delivery-notes.md',3,1)`,
        [artifactId, fixture.scope.organizationId, fixture.taskId],
      );
      await transaction.query(
        `insert into bakery.artifact_versions
        (id,organization_id,artifact_id,task_id,run_step_id,revision,author_id,subject_head_sha,subject_base_sha,step_key,metadata,content,sha256,size_bytes,media_type)
        values ($1,$2,$3,$4,$5,3,$6,$7,$8,'inspect',$9::jsonb,$10,$11,$12,'text/x-diff')`,
        [
          versionId,
          fixture.scope.organizationId,
          artifactId,
          fixture.taskId,
          fixture.stepId,
          fixture.scope.principalId,
          headSha,
          baseSha,
          JSON.stringify({
            fixture: "seeded/read proof only",
            resultKind: "not-a-coding-result",
          }),
          content,
          digest,
          content.byteLength,
        ],
      );
      await transaction.query(
        `update bakery.artifacts set current_version_id=$1 where organization_id=$2 and id=$3`,
        [versionId, fixture.scope.organizationId, artifactId],
      );
      return {
        streamId,
        jobId: execution.jobId,
        artifactId,
        versionId,
        sha256: digest,
      };
    });
  } finally {
    await closePgDatabase(database);
  }
}
