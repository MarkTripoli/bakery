import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import {
  sweepOutputHistory,
  sweepOutputTranscripts,
} from "../../../apps/server/src/modules/execution/output-archive.ts";
import { collectArtifactVersion } from "../../../apps/server/src/modules/knowledge/retention/collector.ts";
import { seedArchiveProducer } from "./run-archive-seed.ts";
import { NativeOutputCapture } from "../../../apps/worker/src/native-output.ts";
import { EventSpool } from "../../../apps/worker/src/spool.ts";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import { OUTPUT_LIMITS } from "../../../packages/contracts/src/output.ts";
import type { Stack } from "./stack.ts";

export async function assertRunArchiveAcceptance(stack: Stack, options: {
  readonly principalId: string;
  readonly organizationId: string;
  readonly baseUrl: string;
  readonly sessionCookie: string;
}) {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  const directory = await Deno.makeTempDir({ prefix: "run-archive-" });
  try {
    const { job, assignment, client, open, binding } =
      await seedArchiveProducer(database, stack.origin, options);
    const spool = await EventSpool.open({
      path: directory + "/spool.json",
      maxRecords: 100,
      maxBytes: 2 * 1024 * 1024,
    });
    const leaseSeconds = assignment.leaseDurationSeconds;
    assert(leaseSeconds !== undefined && leaseSeconds > 0);
    let leaseDeadline = performance.now() + leaseSeconds * 1000;
    const flush = async () => {
      if (performance.now() + leaseSeconds * 500 >= leaseDeadline) {
        const renewed = (await client.renewLease(assignment.attemptId, {
          ...open,
          leaseSeconds,
        })).value;
        assertEquals(renewed.status, "active");
        assert(renewed.leaseDurationSeconds !== undefined);
        leaseDeadline = performance.now() + renewed.leaseDurationSeconds * 1000;
      }
      for (const record of spool.records()) {
        assertEquals(record.type, "job.output");
        await client.postEvents(assignment.attemptId, {
          ...open,
          events: [{
            eventId: record.eventId,
            localSeq: record.localSeq,
            eventType: record.type,
            payload: record.payload,
          }],
        });
        await spool.acknowledge(assignment.attemptId, record.localSeq);
      }
    };
    const canary = "run-ui-secret-canary";
    const capture = new NativeOutputCapture({
      assignment,
      binding,
      client,
      spool,
      workerSessionId: open.workerSessionId,
      workerSessionGeneration: open.workerSessionGeneration,
      configuredSecrets: [canary],
      leaseActive: () => performance.now() < leaseDeadline,
      waitForAck: flush,
    });
    await capture.write(
      "stdout",
      new TextEncoder().encode("visible canary prefix run-ui-secret-"),
    );
    await capture.write(
      "stdout",
      new TextEncoder().encode("canary safe suffix\n"),
    );
    // Feed real chunks beyond the production limit; retain the sanitizer's actual marker.
    const chunk = new TextEncoder().encode(
      "bounded output ".repeat(1000) + "\n",
    );
    for (
      let bytes = 0;
      bytes <= OUTPUT_LIMITS.displayBytes + chunk.byteLength;
      bytes += chunk.byteLength
    ) {
      await capture.write("stdout", chunk);
      await flush();
    }
    const disposition = await capture.finish();
    assertEquals(disposition?.capture, "truncated");
    assert(disposition);
    await flush();
    await client.closeOutput(assignment.attemptId, {
      ...open,
      sessionId: binding.sessionId,
      writerGeneration: binding.writerGeneration,
      ...disposition,
    }, crypto.randomUUID());
    await sweepOutputTranscripts(database);
    const response = await stack.fetch(
      new Request(stack.origin + "/v1/output-streams/" + binding.sessionId, {
        headers: {
          cookie: options.sessionCookie,
          "Bakery-Organization-Id": options.organizationId,
        },
      }),
    );
    assertEquals(response.status, 200);
    const stream = contractSchemas.OutputStream.parse(
      (await response.json()).stream,
    );
    assertEquals(stream.capture, "truncated");
    assertEquals(stream.archive, "archived");
    assert(stream.segments.length > 1);
    const browser = async (phase: string) => {
      const child = new Deno.Command("node", {
        args: ["apps/web/tests/helpers/run-archive-browser.mjs"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          JSON.stringify({
            ...options,
            taskId: job.taskId,
            streamId: binding.sessionId,
            segments: stream.segments,
            canary,
            phase,
          }),
        ),
      );
      await writer.close();
      const result = await child.output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      console.log("RUN_ARCHIVE_BROWSER=" + phase + ":passed");
    };
    await browser("retained");
    await database.query(
      "update bakery.session_output_streams set history_expires_at=now()-interval '1 second' where id=$1",
      [binding.sessionId],
    );
    await sweepOutputHistory(database);
    await browser("reset");
    await database.query(
      "update bakery.tasks set status='completed' where id=$1",
      [job.taskId],
    );
    // Run-step attributed transcript versions stay protected until the step
    // and run are terminal.
    await database.query(
      `update bakery.run_steps set status='completed' where id=(
         select run_step_id from bakery.jobs where id=$1)`,
      [job.jobId],
    );
    await database.query(
      `update bakery.workflow_runs set status='completed' where id=(
         select step.run_id from bakery.run_steps step
           join bakery.jobs job on job.run_step_id=step.id where job.id=$1)`,
      [job.jobId],
    );
    for (const version of stream.segments) {
      await database.query(
        "update bakery.artifact_versions set expires_at=now()-interval '1 second' where id=$1",
        [version.artifactVersionId],
      );
      assertEquals(
        await collectArtifactVersion(database, version.artifactVersionId),
        true,
      );
    }
    await browser("expired");
  } finally {
    await closePgDatabase(database);
    await Deno.remove(directory, { recursive: true });
  }
}
