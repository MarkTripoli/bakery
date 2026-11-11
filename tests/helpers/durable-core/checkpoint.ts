import type { ArtifactRef } from "../../e2e/helpers/durable-core/artifact-client.ts";
import type { DurableCoreStack } from "./stack.ts";

export type PersistedCheckpoint = {
  readonly eventId: string;
  readonly localSeq: string;
  readonly ackedLocalSeq: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly runStepId: string;
  readonly artifact: ArtifactRef;
  readonly effectKey: string;
};

type CheckpointRow = {
  eventId: string;
  localSeq: string;
  ackedLocalSeq: string;
  attemptId: string;
  jobId: string;
  runId: string;
  runStepId: string;
  artifactId: string;
  versionId: string;
  sha256: string;
  effectKey: string | null;
};

function isCheckpointRow(
  value: CheckpointRow | undefined,
): value is CheckpointRow {
  return value !== undefined && value.effectKey !== null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForPersistedCheckpoint(options: {
  readonly stack: DurableCoreStack;
  readonly attemptId: string;
  readonly effectKey: string;
  readonly artifact: ArtifactRef;
  readonly expectedLocalSeq?: string;
  readonly timeoutMs?: number;
}): Promise<PersistedCheckpoint> {
  if (options.effectKey.trim() === "") {
    throw new Error("DURABLE_CORE_CHECKPOINT_EFFECT_KEY_REQUIRED");
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastRows: CheckpointRow[] = [];
  while (Date.now() < deadline) {
    lastRows = await options.stack.psql<CheckpointRow>(
      `select event.event_id as "eventId",
              event.local_seq::text as "localSeq",
              attempt.last_event_seq::text as "ackedLocalSeq",
              attempt.id as "attemptId",
              attempt.job_id as "jobId",
              step.run_id as "runId",
              step.id as "runStepId",
              event.payload->'artifact'->>'artifactId' as "artifactId",
              event.payload->'artifact'->>'versionId' as "versionId",
              event.payload->'artifact'->>'sha256' as "sha256",
              event.payload->>'resumeHandleRef' as "effectKey"
         from bakery.attempt_events event
         join bakery.job_attempts attempt
           on attempt.id = event.attempt_id
         join bakery.jobs job
           on job.organization_id = attempt.organization_id
          and job.id = attempt.job_id
         join bakery.run_steps step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
        where event.event_type = 'job.checkpoint'
          and attempt.id = $1
        order by event.local_seq desc
        limit 1`,
      [options.attemptId],
    );
    const row = lastRows[0];
    if (
      isCheckpointRow(row) &&
      row.effectKey === options.effectKey &&
      row.artifactId === options.artifact.artifactId &&
      row.versionId === options.artifact.versionId &&
      row.sha256 === options.artifact.sha256 &&
      (options.expectedLocalSeq === undefined ||
        row.localSeq === options.expectedLocalSeq) &&
      BigInt(row.ackedLocalSeq) >= BigInt(row.localSeq)
    ) {
      return {
        eventId: row.eventId,
        localSeq: row.localSeq,
        ackedLocalSeq: row.ackedLocalSeq,
        attemptId: row.attemptId,
        jobId: row.jobId,
        runId: row.runId,
        runStepId: row.runStepId,
        artifact: options.artifact,
        effectKey: row.effectKey,
      };
    }
    await delay(100);
  }
  const logs = await Promise.all(
    (["server", "inngest", "worker"] as const).map(async (service) =>
      `${service}:\n${await options.stack.logs(service)}`
    ),
  );
  throw new Error(
    `DURABLE_CORE_CHECKPOINT_TIMEOUT:attempt=${options.attemptId}:effect=${options.effectKey}:rows=${
      JSON.stringify(
        lastRows,
      )
    }\n${logs.join("\n")}`,
  );
}
