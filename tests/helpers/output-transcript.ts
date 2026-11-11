import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { batch, clientFor, event, setup } from "./output-ingestion.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  expireAndSupersedeAttempt,
  readExecutionState,
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "./worker-execution.ts";
import { withWorkerFixture } from "./worker-execution/scenarios.ts";
import { WorkerRequestError } from "../../apps/worker/src/client.ts";
import {
  setOutputFinalizationAfterSavepointReleaseFaultForTest,
  setOutputFinalizationIntentInsertFaultForTest,
  TRANSCRIPT_LIMITS,
} from "../../packages/persistence/src/session-output-finalization.ts";
import { authTestOrigin, openAuthFixture } from "./auth.ts";
import {
  setOutputTranscriptPathProbeForTest,
  setOutputTranscriptPublicationFaultForTest,
  transcriptManifestMaximumBytes,
} from "../../apps/server/src/modules/execution/output-transcript.ts";
import { setOutputFinalizationResponseDropForTest } from "../../apps/server/src/modules/execution/output.ts";
import {
  sweepOutputHistory,
  sweepOutputTranscripts,
} from "../../apps/server/src/modules/execution/output-archive.ts";
import {
  expireOutputHistory,
  withPgTransaction,
} from "../../packages/persistence/src/index.ts";
import {
  bindProviderCallIntent,
  recordProviderUsageReceipt,
  type UsageReceipt,
} from "../../apps/server/src/modules/work/budget.ts";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import {
  OutputBatchSchema,
  outputDigest,
} from "../../packages/contracts/src/output.ts";

type Grant = {
  id: string;
  payload_digest: string;
  finalization_identity: string;
  state: string;
  author_id: string;
  worker_host_id: string;
  frozen_highwater: string;
};
type TranscriptStatus = {
  sessionId: string;
  capture: string;
  captureReason: string;
  frozenHighwater: string;
  coveredHighwater: string;
  exportDisposition: string;
  history: string;
  segments: Array<{
    versionId: string;
    sizeBytes: number;
    sha256: string;
  }>;
  manifest: { versionId: string; sizeBytes: number; sha256: string } | null;
};
type Receipt = {
  grantId: string;
  sessionId: string;
  frozenHighwater: string;
  payloadDigest: string;
  exportDisposition: string;
  segments: Array<{
    ordinal: number;
    firstSequence: string;
    lastSequence: string;
    versionId: string;
    sizeBytes: number;
    sha256: string;
  }>;
  manifest: { versionId: string; sizeBytes: number; sha256: string };
};

async function grantFor(
  fixture: WorkerFixture,
  sessionId: string,
): Promise<Grant> {
  const result = await fixture.pgDatabase.query<Grant>(
    `select id,payload_digest,finalization_identity,state,author_id,worker_host_id,
            frozen_highwater::text
       from bakery.session_output_finalizations
      where organization_id=$1 and session_id=$2`,
    [fixture.organizationId, sessionId],
  );
  assertEquals(result.rows.length, 1);
  assert(result.rows[0]?.payload_digest);
  assert(result.rows[0]?.finalization_identity);
  return result.rows[0];
}

async function statusFor(
  fixture: WorkerFixture,
  sessionId: string,
  scope = fixture,
): Promise<TranscriptStatus> {
  const response = await fixture.app.fetch(
    new Request(
      `${authTestOrigin}/v1/output-streams/${sessionId}/transcript?sessionId=${sessionId}`,
      {
        headers: {
          cookie: scope.adminCookie,
          origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": scope.organizationId,
        },
      },
    ),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as TranscriptStatus;
}

type StreamProjection = {
  archive: string;
  archiveFailure: string | null;
  historyExpiresAt: string | null;
  segments: Array<{
    segmentIndex: number;
    artifactVersionId: string;
    sha256: string;
    sizeBytes: number;
    completeness: string;
  }>;
};

async function streamFor(
  fixture: WorkerFixture,
  sessionId: string,
): Promise<StreamProjection> {
  const response = await fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/output-streams/${sessionId}`, {
      headers: {
        cookie: fixture.adminCookie,
        origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
      },
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json()).stream as StreamProjection;
}

async function readVersion(
  fixture: WorkerFixture,
  versionId: string,
  scope = fixture,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const response = await fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/artifact-versions/${versionId}/content`, {
      headers: {
        cookie: scope.adminCookie,
        origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": scope.organizationId,
      },
    }),
  );
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function insertBatches(
  fixture: WorkerFixture,
  own: Awaited<ReturnType<typeof setup>>,
  firstSequence: number,
  lastSequence: number,
  text: string,
): Promise<void> {
  const rows: Array<{ eventId: string; payload: unknown }> = [];
  for (let sequence = firstSequence; sequence <= lastSequence; sequence++) {
    rows.push({
      eventId: crypto.randomUUID(),
      payload: await batch(own.binding, text, String(sequence)),
    });
  }
  await fixture.pgDatabase.query(
    `insert into bakery.session_output_batches
       (organization_id,session_id,sequence,batch_id,writer_generation,attempt_id,event_id,payload)
     select $1,(item->'payload'->>'sessionId')::uuid,
            (item->'payload'->>'sequence')::bigint,
            (item->'payload'->>'batchId')::uuid,
            (item->'payload'->>'writerGeneration')::bigint,
            $2,(item->>'eventId')::uuid,item->'payload'
       from jsonb_array_elements($3::jsonb) item`,
    [fixture.organizationId, own.assignment.attemptId, JSON.stringify(rows)],
  );
  await fixture.pgDatabase.query(
    `update bakery.session_output_streams set highwater=$3 where organization_id=$1 and id=$2`,
    [fixture.organizationId, own.binding.sessionId, String(lastSequence)],
  );
}

async function insertSizedBatches(
  fixture: WorkerFixture,
  own: Awaited<ReturnType<typeof setup>>,
  firstSequence: number,
  count: number,
  textBytes: number,
): Promise<void> {
  await insertBatches(
    fixture,
    own,
    firstSequence,
    firstSequence + count - 1,
    "x".repeat(textBytes),
  );
}

async function closeWithGrant(
  fixture: WorkerFixture,
  text: string,
  capture: "complete" | "truncated" | "interrupted" = "complete",
  reason: "clean-end" | "text-limit" | "source-lost" = "clean-end",
) {
  const own = await setup(fixture);
  const output = await batch(own.binding, text);
  await own.client.postEvents(own.assignment.attemptId, {
    ...own.open,
    events: [{
      eventId: crypto.randomUUID(),
      localSeq: "1",
      eventType: "job.output",
      payload: output,
    }],
  });
  const closed = await own.client.closeOutput(
    own.assignment.attemptId,
    {
      ...own.open,
      sessionId: own.binding.sessionId,
      writerGeneration: own.binding.writerGeneration,
      capture,
      reason,
    },
    crypto.randomUUID(),
  );
  const grant = await grantFor(fixture, own.binding.sessionId);
  return { ...own, output, closed, grant };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        bytes as unknown as BufferSource,
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function statusResponse(
  fixture: WorkerFixture,
  sessionId: string,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(
      `${authTestOrigin}/v1/output-streams/${sessionId}/transcript?sessionId=${sessionId}`,
      {
        headers: {
          cookie: fixture.adminCookie,
          origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
        },
      },
    ),
  );
}

/**
 * Closes with a real close-hook publication fault, leaving a genuinely
 * retryable grant with intact intents (no fabricated pre-publication state).
 */
async function closeRetryable(
  fixture: WorkerFixture,
  text: string,
): Promise<Awaited<ReturnType<typeof closeWithGrant>>> {
  setOutputTranscriptPublicationFaultForTest("segment");
  try {
    const own = await closeWithGrant(fixture, text);
    assertEquals(own.grant.state, "retryable");
    return own;
  } finally {
    setOutputTranscriptPublicationFaultForTest(null);
  }
}

function finalizationBody(own: Awaited<ReturnType<typeof closeWithGrant>>) {
  return {
    grantId: own.grant.id,
    sessionId: own.binding.sessionId,
    frozenHighwater: own.grant.frozen_highwater,
    payloadDigest: own.grant.payload_digest,
  };
}

async function genericArtifactUpload(
  fixture: WorkerFixture,
  own: Awaited<ReturnType<typeof setup>>,
): Promise<Response> {
  const bytes = new TextEncoder().encode("stale generic upload");
  const form = new FormData();
  form.set("leaseToken", own.open.leaseToken);
  form.set("fence", own.open.fence);
  form.set("workerSessionId", own.open.workerSessionId);
  form.set(
    "workerSessionGeneration",
    own.open.workerSessionGeneration,
  );
  form.set("artifactType", "patch");
  form.set("name", "stale-generic-upload");
  form.set("contentType", "application/octet-stream");
  form.set("contentDigest", await sha256Bytes(bytes));
  form.set("runStepId", own.job.runStepId);
  form.set("stepKey", "worker");
  form.set("metadata", JSON.stringify({ source: "issue-284" }));
  form.set(
    "content",
    new File([bytes], "stale.bin", { type: "application/octet-stream" }),
  );
  return await fixture.app.fetch(
    new Request(
      `${authTestOrigin}/v1/worker/attempts/${own.assignment.attemptId}/artifacts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${own.worker.credential}`,
          "Idempotency-Key": crypto.randomUUID(),
          "X-Bakery-Worker-Protocol-Version": "2",
        },
        body: form,
      },
    ),
  );
}

async function segmentThresholds(
  fixture: WorkerFixture,
  own: Awaited<ReturnType<typeof setup>>,
  textBytes: number,
): Promise<{ sixteen: number; seventeen: number }> {
  const encoder = new TextEncoder();
  // Every threshold lands in four-digit highwaters, so the envelope's
  // highwater width is fixed while counting.
  const envelope = {
    organizationId: fixture.organizationId,
    streamId: own.binding.sessionId,
    highwater: "1000",
    completeness: "complete",
  };
  const segmentBytes = (
    first: string,
    last: string,
    batchBytes: number,
    count: number,
  ) =>
    encoder.encode(JSON.stringify({
      ...envelope,
      firstSequence: first,
      lastSequence: last,
      batches: [],
    })).byteLength + batchBytes + count - 1;
  let first = "1";
  let batchBytes = 0;
  let count = 0;
  let segments = 1;
  let sixteen = 0;
  for (let sequence = 1; sequence <= TRANSCRIPT_LIMITS.maxBatches; sequence++) {
    const payload = OutputBatchSchema.parse(
      await batch(own.binding, "x".repeat(textBytes), String(sequence)),
    );
    const bytes = encoder.encode(JSON.stringify(payload)).byteLength;
    if (
      count > 0 &&
      segmentBytes(first, String(sequence), batchBytes + bytes, count + 1) >
        TRANSCRIPT_LIMITS.maxSegmentBytes
    ) {
      segments++;
      first = String(sequence);
      batchBytes = 0;
      count = 0;
    }
    batchBytes += bytes;
    count++;
    if (segments === TRANSCRIPT_LIMITS.maxSegments && sixteen === 0) {
      sixteen = sequence;
    }
    if (segments === TRANSCRIPT_LIMITS.maxSegments + 1) {
      assertEquals(String(sixteen).length, 4);
      assertEquals(String(sequence).length, 4);
      return { sixteen, seventeen: sequence };
    }
  }
  throw new Error("TRANSCRIPT_SEGMENT_THRESHOLDS_UNREACHABLE");
}

async function assertDigestAndBytes(
  fixture: WorkerFixture,
  ref: { versionId: string; sizeBytes: number; sha256: string },
): Promise<Uint8Array> {
  const { response, bytes } = await readVersion(fixture, ref.versionId);
  assertEquals(response.status, 200);
  assertEquals(bytes.byteLength, ref.sizeBytes);
  assertEquals(response.headers.get("content-length"), String(ref.sizeBytes));
  assertEquals(response.headers.get("etag"), `"${ref.sha256}"`);
  assertEquals(await sha256Bytes(bytes), ref.sha256);
  return bytes;
}

export function transcriptIntegrationTests(
  runFixture: typeof withWorkerFixture = withWorkerFixture,
): void {
  Deno.test("mounted finalization publishes a stable stream and authorized immutable bytes", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      const oldOutput = await batch(own.binding, "old generation");
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.output",
          payload: oldOutput,
        }],
      });
      await expireAndSupersedeAttempt(fixture.pgDatabase, own.job.jobId);
      const replacementAssignment = (await own.client.claim({
        claimKey: crypto.randomUUID(),
        workerHostId: own.worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        workerSessionId: own.open.workerSessionId,
        workerSessionGeneration: own.open.workerSessionGeneration,
      })).value;
      assert(replacementAssignment);
      const replacementOpen = {
        ...own.open,
        leaseToken: replacementAssignment.leaseToken,
        fence: replacementAssignment.fence,
      };
      const replacementBinding = (await own.client.openOutput(
        replacementAssignment.attemptId,
        replacementOpen,
        crypto.randomUUID(),
      )).value;
      assertEquals(replacementBinding.sessionId, own.binding.sessionId);
      assertEquals(replacementBinding.writerGeneration, "2");
      const replacementOutput = await batch(
        replacementBinding,
        "replacement",
        "2",
      );
      await own.client.postEvents(replacementAssignment.attemptId, {
        ...replacementOpen,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.output",
          payload: replacementOutput,
        }],
      });
      const closed = await own.client.closeOutput(
        replacementAssignment.attemptId,
        {
          ...replacementOpen,
          sessionId: replacementBinding.sessionId,
          writerGeneration: replacementBinding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      assertEquals(closed.value.sessionId, own.binding.sessionId);
      assertEquals(closed.value.highwater, "2");
      const grant = await grantFor(fixture, own.binding.sessionId);
      assertEquals(grant.state, "published");
      assert(grant.author_id);
      assertNotEquals(grant.author_id, grant.worker_host_id);

      const replay = await own.client.finalizeOutput(
        replacementAssignment.attemptId,
        grant.id,
        {
          grantId: grant.id,
          sessionId: own.binding.sessionId,
          frozenHighwater: grant.frozen_highwater,
          payloadDigest: grant.payload_digest,
        },
      );
      assertEquals(replay.replayed, true);
      const receipt = replay.value as unknown as Receipt;
      assertEquals(receipt.sessionId, own.binding.sessionId);
      assertEquals(receipt.frozenHighwater, "2");
      assertEquals(receipt.exportDisposition, "incomplete");
      assertEquals(receipt.segments.length, 1);

      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "incomplete");
      assertEquals(status.history, "available");
      assertEquals(status.frozenHighwater, "2");
      assertEquals(status.coveredHighwater, "2");
      assert(status.manifest);
      const manifestBytes = await assertDigestAndBytes(
        fixture,
        status.manifest,
      );
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        segments: Array<{ versionId: string; sha256: string }>;
      };
      assertEquals(manifest.segments.length, 1);
      const segmentBytes = await assertDigestAndBytes(
        fixture,
        status.segments[0]!,
      );
      const document = JSON.parse(new TextDecoder().decode(segmentBytes)) as {
        streamId: string;
        completeness: string;
        firstSequence: string;
        lastSequence: string;
        batches: Array<{ parts: Array<{ text: string }> }>;
      };
      assertEquals(document.streamId, own.binding.sessionId);
      assertEquals(document.completeness, "interrupted");
      assertEquals(document.firstSequence, "1");
      assertEquals(document.lastSequence, "2");
      assertEquals(document.batches.length, 2);
      assertEquals(document.batches[0]!.parts[0]!.text, "old generation");
      assertEquals(document.batches[1]!.parts[0]!.text, "replacement");
      // The stream reader sees exactly the finalizer's references: one publisher.
      const stream = await streamFor(fixture, own.binding.sessionId);
      assertEquals(stream.archive, "archived");
      assertEquals(stream.archiveFailure, null);
      assertEquals(stream.segments.length, 1);
      assertEquals(
        stream.segments[0]!.artifactVersionId,
        status.segments[0]!.versionId,
      );
      assertEquals(stream.segments[0]!.sha256, status.segments[0]!.sha256);
      assertEquals(stream.segments[0]!.completeness, "interrupted");
      assertEquals(
        await sha256Bytes(manifestBytes),
        status.manifest.sha256,
      );
      assertEquals(status.segments[0]?.sha256, manifest.segments[0]?.sha256);
      assertEquals(replacementAssignment.attemptId.length, 36);
    }));

  Deno.test("closed incomplete captures and source corruption never become complete", () =>
    runFixture(async (fixture) => {
      const own = await closeWithGrant(
        fixture,
        "truncated",
        "truncated",
        "text-limit",
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.capture, "truncated");
      assertEquals(status.captureReason, "text-limit");
      assertEquals(status.exportDisposition, "incomplete");
      const manifest = status.manifest;
      assert(manifest);
      const parsed = JSON.parse(
        new TextDecoder().decode(await assertDigestAndBytes(fixture, manifest)),
      ) as { completeness: string; reason: string };
      assertEquals(parsed.completeness, "incomplete");
      assertEquals(parsed.reason, "text-limit");

      await fixture.pgDatabase.query(
        `update bakery.artifact_versions set content=$3 where organization_id=$1 and id=$2`,
        [
          fixture.organizationId,
          manifest.versionId,
          new TextEncoder().encode("corrupt"),
        ],
      );
      const corrupted = await readVersion(fixture, manifest.versionId);
      assertEquals(corrupted.response.status, 500);
      assert(
        !new TextDecoder().decode(corrupted.bytes).includes("corrupt"),
      );
    }));

  Deno.test("interior source gaps publish only explicit incomplete coverage", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      await insertBatches(fixture, own, 1, 3, "gap");
      await fixture.pgDatabase.query(
        `delete from bakery.session_output_batches
          where organization_id=$1 and session_id=$2 and sequence=2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "incomplete");
      assertEquals(status.coveredHighwater, "1");
      assert(status.manifest);
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await assertDigestAndBytes(fixture, status.manifest),
        ),
      ) as { completeness: string; reason: string };
      assertEquals(manifest.completeness, "incomplete");
      assertEquals(manifest.reason, "source-gap");
    }));

  Deno.test("missing immutable segments and artifact digest corruption fail closed", () =>
    runFixture(async (fixture) => {
      const own = await closeWithGrant(fixture, "immutable segment");
      const status = await statusFor(fixture, own.binding.sessionId);
      const segment = status.segments[0];
      assert(segment);
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions set sha256=$3
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, segment.versionId, "0".repeat(64)],
      );
      const corruptRead = await readVersion(fixture, segment.versionId);
      assertEquals(corruptRead.response.status, 500);
      assertEquals(
        (await statusResponse(fixture, own.binding.sessionId)).status,
        412,
      );
    }));

  Deno.test("a missing immutable segment cannot retain a complete status", () =>
    runFixture(async (fixture) => {
      const own = await closeWithGrant(fixture, "missing immutable segment");
      const status = await statusFor(fixture, own.binding.sessionId);
      const segment = status.segments[0];
      assert(segment);
      await fixture.pgDatabase.query(
        `update bakery.artifacts set current_version_id=null
          where organization_id=$1 and current_version_id=$2`,
        [fixture.organizationId, segment.versionId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.artifact_versions
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, segment.versionId],
      );
      assertEquals(
        (await statusResponse(fixture, own.binding.sessionId)).status,
        412,
      );
    }));

  Deno.test("runtime segment packing and fixed-bound relationships are proven through PostgreSQL", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      // The public batch contract caps one encoded batch at 32 KiB.  This
      // workload crosses the production 1 MiB segment boundary without
      // bypassing the finalizer or fabricating artifact bytes.
      await insertSizedBatches(fixture, own, 1, 70, 15_000);
      const closed = await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      assertEquals(closed.value.highwater, "70");
      const status = await statusFor(fixture, own.binding.sessionId);
      assert(status.manifest);
      assert(status.segments.length > 1);
      assert(
        status.segments.every((segment) =>
          segment.sizeBytes <= TRANSCRIPT_LIMITS.maxSegmentBytes
        ),
      );
      assert(
        status.segments.reduce(
          (total, segment) => total + segment.sizeBytes,
          0,
        ) <=
          TRANSCRIPT_LIMITS.maxTotalBytes,
      );
      assert(status.manifest.sizeBytes <= TRANSCRIPT_LIMITS.maxManifestBytes);

      // These are fixed, non-configurable bounds.  Total bytes cannot be
      // reached before the segment-count guard: 16 * 1 MiB = 16 MiB exactly.
      // The manifest has at most 16 segment descriptors, so its 256 KiB guard
      // is likewise a deterministic lower-bound proof, not an invented knob.
      assertEquals(
        TRANSCRIPT_LIMITS.maxSegments * TRANSCRIPT_LIMITS.maxSegmentBytes,
        TRANSCRIPT_LIMITS.maxTotalBytes,
      );
      assert(
        transcriptManifestMaximumBytes() < TRANSCRIPT_LIMITS.maxManifestBytes,
      );
      assert(TRANSCRIPT_LIMITS.maxSegmentBytes > 32 * 1024);
    }));

  Deno.test("sixteen runtime segments publish complete at the exact fixed boundary", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      const thresholds = await segmentThresholds(fixture, own, 15_000);
      await insertSizedBatches(fixture, own, 1, thresholds.sixteen, 15_000);
      await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.segments.length, TRANSCRIPT_LIMITS.maxSegments);
      assertEquals(status.exportDisposition, "published");
    }));

  Deno.test("a seventeenth runtime segment is rejected as incomplete", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      const thresholds = await segmentThresholds(fixture, own, 15_000);
      await insertSizedBatches(fixture, own, 1, thresholds.seventeen, 15_000);
      await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.segments.length, TRANSCRIPT_LIMITS.maxSegments);
      assertEquals(status.exportDisposition, "incomplete");
      assert(status.manifest);
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await assertDigestAndBytes(fixture, status.manifest),
        ),
      ) as { reason: string };
      assertEquals(manifest.reason, "resource-limit-segments");
    }));

  Deno.test("finalization limits are finite and source plans reject over-bound batch counts", () =>
    runFixture(async (fixture) => {
      assertEquals(TRANSCRIPT_LIMITS.maxBatches, 4096);
      assertEquals(TRANSCRIPT_LIMITS.maxSegments, 16);
      assertEquals(TRANSCRIPT_LIMITS.maxSegmentBytes, 1024 * 1024);
      assertEquals(TRANSCRIPT_LIMITS.maxTotalBytes, 16 * 1024 * 1024);
      assertEquals(TRANSCRIPT_LIMITS.maxManifestBytes, 256 * 1024);
      assertEquals(TRANSCRIPT_LIMITS.maxAttempts, 8);
      assertEquals(TRANSCRIPT_LIMITS.cleanupBatches, 256);

      const own = await closeWithGrant(fixture, "bounded");
      await insertBatches(
        fixture,
        own,
        2,
        TRANSCRIPT_LIMITS.cleanupBatches + 1,
        "cleanup",
      );
      const published = await statusFor(fixture, own.binding.sessionId);
      assertEquals(published.exportDisposition, "published");
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams
            set history_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      // Reads derive expiry but never delete history.
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.history, "expired");
      assertEquals(status.exportDisposition, "published");
      assertEquals(status.segments, published.segments);
      assertEquals(status.manifest, published.manifest);
      const count = async () =>
        (await fixture.pgDatabase.query<{ count: number }>(
          `select count(*)::int as count from bakery.session_output_batches where organization_id=$1 and session_id=$2`,
          [fixture.organizationId, own.binding.sessionId],
        )).rows[0]?.count;
      assertEquals(await count(), TRANSCRIPT_LIMITS.cleanupBatches + 1);
      // One expiry pass is bounded; the sweep finishes the remainder.
      assertEquals(
        await withPgTransaction(
          fixture.runtimePgDatabase,
          (transaction) => expireOutputHistory(transaction),
        ),
        TRANSCRIPT_LIMITS.cleanupBatches,
      );
      assertEquals(await count(), 1);
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 1);
      assertEquals(await count(), 0);
      const expired = await statusFor(fixture, own.binding.sessionId);
      assertEquals(expired.history, "expired");
      assertEquals(expired.exportDisposition, "published");
      assertEquals(expired.manifest, published.manifest);
      const stream = await streamFor(fixture, own.binding.sessionId);
      assertEquals(stream.archive, "archived");
      assertEquals(stream.segments.length, 1);
      assertEquals(
        stream.segments[0]!.artifactVersionId,
        expired.segments[0]!.versionId,
      );
    }));

  Deno.test("unpublished transcripts expire explicitly and never become complete", () =>
    runFixture(async (fixture) => {
      setOutputTranscriptPublicationFaultForTest("manifest");
      let own: Awaited<ReturnType<typeof closeWithGrant>>;
      try {
        own = await closeWithGrant(fixture, "never published");
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      const failed = await streamFor(fixture, own.binding.sessionId);
      assertEquals(failed.archive, "failed");
      assertEquals(failed.archiveFailure, "archive_publication_failed");
      assertEquals(
        (await statusFor(fixture, own.binding.sessionId)).exportDisposition,
        "retryable",
      );
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams
            set history_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 1);
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.history, "expired");
      assertEquals(status.exportDisposition, "expired");
      assertEquals(status.segments, []);
      assertEquals(status.manifest, null);
      const stream = await streamFor(fixture, own.binding.sessionId);
      assertEquals(stream.archive, "failed");
      assertEquals(stream.archiveFailure, "history_expired");
      assertEquals(stream.segments, []);
      // An expired grant cannot be published by a later sweep or worker.
      assertEquals(
        await sweepOutputTranscripts(fixture.runtimePgDatabase),
        { finalized: 0, failed: 0, expired: 0 },
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            finalizationBody(own),
          ),
        WorkerRequestError,
      );
      assertEquals(
        (await fixture.pgDatabase.query(
          `select count(*)::int as count from bakery.artifact_versions where organization_id=$1 and task_id=$2`,
          [fixture.organizationId, own.job.taskId],
        )).rows[0]?.count,
        0,
      );
    }));

  Deno.test("4097 committed batches publish an incomplete bounded plan without pretending coverage", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      await insertBatches(
        fixture,
        own,
        1,
        TRANSCRIPT_LIMITS.maxBatches + 1,
        "bounded batch",
      );
      const closed = await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      assertEquals(
        closed.value.highwater,
        String(TRANSCRIPT_LIMITS.maxBatches + 1),
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "incomplete");
      // The batch bound still publishes the verified contiguous prefix.
      assertEquals(
        status.coveredHighwater,
        String(TRANSCRIPT_LIMITS.maxBatches),
      );
      assert(status.segments.length > 0);
      assert(status.manifest);
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await assertDigestAndBytes(fixture, status.manifest),
        ),
      ) as { reason: string };
      assertEquals(manifest.reason, "resource-limit-batches");
    }));
}

export function transcriptSecurityTests(): void {
  Deno.test("finalization rejects foreign host, changed scope, payload and generic stale publication", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeWithGrant(fixture, "authorized");
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      const staleUpload = await genericArtifactUpload(fixture, own);
      assertEquals(staleUpload.status, 409);
      const exactBody = {
        grantId: own.grant.id,
        sessionId: own.binding.sessionId,
        frozenHighwater: own.grant.frozen_highwater,
        payloadDigest: own.grant.payload_digest,
      };
      const exact = await own.client.finalizeOutput(
        own.assignment.attemptId,
        own.grant.id,
        exactBody,
      );
      assertEquals(exact.replayed, true);
      await assertRejects(
        () =>
          own.client.finalizeOutput(own.assignment.attemptId, own.grant.id, {
            ...exactBody,
            payloadDigest: "0".repeat(64),
          }),
        WorkerRequestError,
      );

      const foreignScope = await createWorkerScope(
        fixture,
        "issue284-foreign",
        fixture,
      );
      try {
        const foreign = await registeredWorker(fixture, {
          scope: foreignScope,
        });
        await assertRejects(
          () =>
            clientFor(fixture, foreign.credential).finalizeOutput(
              own.assignment.attemptId,
              own.grant.id,
              exactBody,
            ),
          WorkerRequestError,
        );
      } finally {
        await closeWorkerScope(fixture, foreignScope);
      }
      const artifacts = await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count from bakery.artifact_versions where organization_id=$1 and task_id=$2`,
        [fixture.organizationId, own.job.taskId],
      );
      assertEquals(artifacts.rows[0]?.count, 2);
    }));

  Deno.test("stored transcript scope mutation is rejected before publication", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "stored scope");
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations set scope_digest=$3
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id, "0".repeat(64)],
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            finalizationBody(own),
          ),
        WorkerRequestError,
      );
      const versions = await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count from bakery.artifact_versions
          where organization_id=$1 and task_id=$2`,
        [fixture.organizationId, own.job.taskId],
      );
      assertEquals(versions.rows[0]?.count, 0);
    }));

  Deno.test("stored transcript author mutation is rejected before publication", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "stored author");
      const other = await registeredWorker(fixture, { name: "other-author" });
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations set author_id=$3
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id, other.registration.principalId],
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            finalizationBody(own),
          ),
        WorkerRequestError,
      );
      const versions = await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count from bakery.artifact_versions
          where organization_id=$1 and task_id=$2`,
        [fixture.organizationId, own.job.taskId],
      );
      assertEquals(versions.rows[0]?.count, 0);
    }));

  Deno.test("stored finalization identity mutation is rejected before publication", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "stored identity");
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations set finalization_identity=$3
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id, "0".repeat(64)],
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            finalizationBody(own),
          ),
        WorkerRequestError,
      );
      const writes = await fixture.pgDatabase.query<{
        versions: number;
        receipts: number;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and task_id=$2) as versions,
           (select count(*)::int
              from bakery.session_output_finalization_receipts
             where organization_id=$1 and grant_id=$3
               and operation='finalize') as receipts`,
        [fixture.organizationId, own.job.taskId, own.grant.id],
      );
      assertEquals(writes.rows[0], { versions: 0, receipts: 0 });
    }));
}

export function transcriptRecoveryTests(): void {
  for (const stage of ["segment", "manifest", "receipt"] as const) {
    Deno.test(`publication ${stage} transaction fault is retryable and atomic`, () =>
      withWorkerFixture(async (fixture) => {
        setOutputTranscriptPublicationFaultForTest(stage);
        let own: Awaited<ReturnType<typeof closeWithGrant>>;
        try {
          own = await closeWithGrant(fixture, `fault ${stage}`);
        } finally {
          setOutputTranscriptPublicationFaultForTest(null);
        }
        assertEquals(own.grant.state, "retryable");
        const failedPublication = await fixture.pgDatabase.query<{
          versions: number;
          manifests: number;
          receipts: number;
          attempt_count: number;
        }>(
          `select
             (select count(*)::int from bakery.artifact_versions
               where organization_id=$1 and task_id=$2) as versions,
             (select count(*)::int from bakery.artifacts
               where organization_id=$1 and task_id=$2
                 and artifact_type='log' and name like 'output-transcript/%/manifest'
                 and current_version_id is not null) as manifests,
             (select count(*)::int from bakery.session_output_finalization_receipts
               where organization_id=$1 and grant_id=$3
                 and operation='finalize') as receipts,
             (select attempt_count from bakery.session_output_finalizations
               where organization_id=$1 and id=$3) as attempt_count`,
          [fixture.organizationId, own.job.taskId, own.grant.id],
        );
        assertEquals(failedPublication.rows[0], {
          versions: 0,
          manifests: 0,
          receipts: 0,
          attempt_count: 1,
        });
        const retry = await own.client.finalizeOutput(
          own.assignment.attemptId,
          own.grant.id,
          finalizationBody(own),
        );
        assertEquals(retry.replayed, false);
        const published = await fixture.pgDatabase.query<{
          state: string;
          attempt_count: number;
          versions: number;
        }>(
          `select grant_row.state,grant_row.attempt_count,
             (select count(*)::int from bakery.artifact_versions
               where organization_id=$1 and task_id=$2) as versions
             from bakery.session_output_finalizations grant_row
            where grant_row.organization_id=$1 and grant_row.id=$3`,
          [fixture.organizationId, own.job.taskId, own.grant.id],
        );
        assertEquals(published.rows[0]?.state, "published");
        assertEquals(published.rows[0]?.attempt_count, 2);
        assertEquals(published.rows[0]?.versions, 2);
      }));
  }

  Deno.test("eight publication transaction faults become durably failed", () =>
    withWorkerFixture(async (fixture) => {
      setOutputTranscriptPublicationFaultForTest("receipt");
      let own: Awaited<ReturnType<typeof closeWithGrant>>;
      try {
        own = await closeWithGrant(fixture, "bounded publication failure");
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      for (
        let attempt = 1;
        attempt < TRANSCRIPT_LIMITS.maxAttempts;
        attempt++
      ) {
        setOutputTranscriptPublicationFaultForTest("receipt");
        try {
          await assertRejects(
            () =>
              own.client.finalizeOutput(
                own.assignment.attemptId,
                own.grant.id,
                finalizationBody(own),
              ),
            WorkerRequestError,
          );
        } finally {
          setOutputTranscriptPublicationFaultForTest(null);
        }
      }
      const state = await fixture.pgDatabase.query<{
        state: string;
        attempt_count: number;
        versions: number;
        manifests: number;
      }>(
        `select grant_row.state,grant_row.attempt_count,
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and task_id=$2) as versions,
           (select count(*)::int from bakery.artifacts
             where organization_id=$1 and task_id=$2
               and artifact_type='log' and name like 'output-transcript/%/manifest'
               and current_version_id is not null) as manifests
           from bakery.session_output_finalizations grant_row
          where grant_row.organization_id=$1 and grant_row.id=$3`,
        [fixture.organizationId, own.job.taskId, own.grant.id],
      );
      assertEquals(state.rows[0], {
        state: "failed",
        attempt_count: TRANSCRIPT_LIMITS.maxAttempts,
        versions: 0,
        manifests: 0,
      });
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            finalizationBody(own),
          ),
        WorkerRequestError,
      );
    }));

  Deno.test("dropped finalization response replays byte-identical JSON without duplicate versions", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "dropped response");
      let droppedRaw = "";
      setOutputFinalizationResponseDropForTest((raw) => droppedRaw = raw);
      let dropped: Response;
      try {
        dropped = await workerRequest(
          fixture,
          own.worker.credential,
          `/v1/worker/attempts/${own.assignment.attemptId}/output-finalizations/${own.grant.id}`,
          finalizationBody(own),
          { headers: { "X-Bakery-Worker-Protocol-Version": "2" } },
        );
      } finally {
        setOutputFinalizationResponseDropForTest(null);
      }
      assertEquals(dropped.status, 500);
      assert(droppedRaw.length > 0);
      const replay = await workerRequest(
        fixture,
        own.worker.credential,
        `/v1/worker/attempts/${own.assignment.attemptId}/output-finalizations/${own.grant.id}`,
        finalizationBody(own),
        { headers: { "X-Bakery-Worker-Protocol-Version": "2" } },
      );
      assertEquals(replay.status, 200, await replay.clone().text());
      assertEquals(await replay.text(), droppedRaw);
      const versions = await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count from bakery.artifact_versions
          where organization_id=$1 and task_id=$2`,
        [fixture.organizationId, own.job.taskId],
      );
      assertEquals(versions.rows[0]?.count, 2);
    }));

  Deno.test("finalization retry, read, and app restart consume only stored transcript data", () =>
    withWorkerFixture(async (fixture) => {
      const events: string[] = [];
      setOutputTranscriptPathProbeForTest((event) => events.push(event));
      let restarted: Awaited<ReturnType<typeof openAuthFixture>> | undefined;
      try {
        const own = await closeWithGrant(fixture, "no reinference");
        await own.client.finalizeOutput(
          own.assignment.attemptId,
          own.grant.id,
          finalizationBody(own),
        );
        await statusFor(fixture, own.binding.sessionId);
        restarted = await openAuthFixture();
        const response = await restarted.app.fetch(
          new Request(
            `${authTestOrigin}/v1/output-streams/${own.binding.sessionId}/transcript?sessionId=${own.binding.sessionId}`,
            {
              headers: {
                cookie: fixture.adminCookie,
                origin: fixture.config.publicBaseUrl,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
        assertEquals(response.status, 200, await response.clone().text());
      } finally {
        setOutputTranscriptPathProbeForTest(null);
        await restarted?.close();
      }
      assertEquals(events, [
        "finalize-stored-intents",
        "finalize-stored-receipt",
        "status-stored-ledger",
        "status-stored-ledger",
      ]);
    }));

  Deno.test("forced-close source scan fault preserves authoritative result and exit facts", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const batchId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.session_output_batches
           (organization_id,session_id,sequence,batch_id,writer_generation,attempt_id,event_id,payload)
         values ($1,$2,1,$3,1,$4,$5,'{}'::jsonb)`,
        [
          fixture.organizationId,
          own.binding.sessionId,
          batchId,
          own.assignment.attemptId,
          eventId,
        ],
      );
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set highwater='1' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      const terminalBody = {
        ...own.open,
        localSeq: "1",
        status: "failed" as const,
        fault: {
          type: "about:blank",
          title: "Worker execution failed",
          status: 500,
          detail: "forced-close source scan fault",
          code: "TRANSCRIPT_SOURCE_SCAN_FAULT",
          requestId: crypto.randomUUID(),
          retryable: false,
        },
      } as Parameters<typeof own.client.postResult>[1];
      const result = await own.client.postResult(
        own.assignment.attemptId,
        terminalBody,
        crypto.randomUUID(),
      );
      assertEquals(result.value.status, "applied");
      const state = await readExecutionState(fixture.pgDatabase, own.job.jobId);
      assertEquals(state.job.status, "failed");
      assertEquals(state.run.status, "failed");
      assertEquals(state.step.status, "failed");
      assertEquals(state.attempts[0]?.status, "failed");
      assertEquals(
        (state.events[0]?.payload as { status?: string })?.status,
        "failed",
      );
      assertEquals(state.events.length, 1);
      const grant = await grantFor(fixture, own.binding.sessionId);
      assertEquals(grant.state, "published");
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "incomplete");
      assertEquals(status.coveredHighwater, "0");
    }));

  Deno.test("second intent PostgreSQL failure rolls back the savepoint and preserves lifecycle facts", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const output = await batch(own.binding, "intent fault");
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.output",
          payload: output,
        }],
      });
      setOutputFinalizationIntentInsertFaultForTest(true);
      try {
        const result = await own.client.postResult(
          own.assignment.attemptId,
          {
            ...own.open,
            localSeq: "2",
            status: "failed",
            fault: {
              type: "about:blank",
              title: "Worker execution failed",
              status: 500,
              detail: "forced-close intent insert fault",
              code: "TRANSCRIPT_INTENT_INSERT_FAULT",
              requestId: crypto.randomUUID(),
              retryable: false,
            },
          } as Parameters<typeof own.client.postResult>[1],
          crypto.randomUUID(),
        );
        assertEquals(result.value.status, "applied");
      } finally {
        setOutputFinalizationIntentInsertFaultForTest(false);
      }
      const state = await readExecutionState(fixture.pgDatabase, own.job.jobId);
      assertEquals(state.job.status, "failed");
      assertEquals(state.run.status, "failed");
      assertEquals(state.step.status, "failed");
      assertEquals(state.attempts[0]?.status, "failed");
      const grant = (await fixture.pgDatabase.query<
        { id: string; state: string; assembly_failure: string | null }
      >(
        `select id,state,assembly_failure from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      )).rows[0];
      assert(grant);
      assertEquals(grant.state, "failed");
      assertEquals(grant.assembly_failure, "intent-persist-failed");
      const durable = await fixture.pgDatabase.query<{
        artifacts: number;
        segment_intents: number;
        manifest_intents: number;
        output_events: number;
        result_events: number;
        audits: number;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and task_id=$2) as artifacts,
           (select count(*)::int
              from bakery.session_output_finalization_segments
             where organization_id=$1 and grant_id=$4) as segment_intents,
           (select count(*)::int
              from bakery.session_output_finalization_manifests
             where organization_id=$1 and grant_id=$4) as manifest_intents,
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$3::uuid
               and event_type='job.output') as output_events,
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$3::uuid
               and event_type='job.failed') as result_events,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and resource_id=$3::text
               and operation='workers.result') as audits`,
        [
          fixture.organizationId,
          own.job.taskId,
          own.assignment.attemptId,
          grant.id,
        ],
      );
      assertEquals(durable.rows[0], {
        artifacts: 0,
        segment_intents: 0,
        manifest_intents: 0,
        output_events: 1,
        result_events: 1,
        audits: 1,
      });
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams
            set history_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      await sweepOutputHistory(fixture.runtimePgDatabase);
      await statusFor(fixture, own.binding.sessionId);
      const afterExpiry = await fixture.pgDatabase.query<{
        output_events: number;
        result_events: number;
        audits: number;
      }>(
        `select
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$2::uuid
               and event_type='job.output') as output_events,
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$2::uuid
               and event_type='job.failed') as result_events,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and resource_id=$2::text
               and operation='workers.result') as audits`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      assertEquals(afterExpiry.rows[0], {
        output_events: 1,
        result_events: 1,
        audits: 1,
      });
    }));

  Deno.test("provider usage, result and exit facts stay authoritative when transcript export fails and history expires", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.output",
          payload: await batch(own.binding, "usage-bearing output"),
        }],
      });
      const reservation = (await fixture.pgDatabase.query<
        { installationReservationId: string }
      >(
        `select installation_reservation_id as "installationReservationId"
           from bakery.jobs where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.job.jobId],
      )).rows[0];
      assert(reservation?.installationReservationId);
      const usage: UsageReceipt = {
        usageFactId: `${own.job.runId}-transcript-usage`,
        providerCallId: `${own.job.runId}-transcript-call`,
        provider: "openai",
        billingAccountId: "budget-test-account",
        model: "gpt-5.6-luna",
        billingRoute: "api",
        pricingMetadataSnapshot: "budget-test-price-v1",
        inputTokens: "11",
        outputTokens: "7",
        costUsd: "0.000100",
        measurement: "reported",
        occurredAt: new Date().toISOString(),
      };
      // The provider's authoritative receipt is the external fact; the
      // mounted result route alone settles it into usage_records.
      await withPgTransaction(fixture.pgDatabase, async (transaction) => {
        await bindProviderCallIntent(transaction, {
          organizationId: fixture.organizationId,
          installationReservationId: reservation.installationReservationId,
          providerCallId: usage.providerCallId,
        });
        const intent = (await transaction.query<{ id: string }>(
          `select provider_call_intent_id as id from bakery.budget_action_intents
            where organization_id=$1 and installation_reservation_id=$2`,
          [fixture.organizationId, reservation.installationReservationId],
        )).rows[0];
        assert(intent);
        await recordProviderUsageReceipt(transaction, {
          organizationId: fixture.organizationId,
          providerCallIntentId: intent.id,
          receipt: usage,
        });
      });
      // The result force-closes the open stream; its transcript export fails.
      setOutputTranscriptPublicationFaultForTest("segment");
      try {
        const result = await own.client.postResult(
          own.assignment.attemptId,
          {
            ...own.open,
            localSeq: "2",
            status: "failed",
            fault: {
              type: "about:blank",
              title: "Worker execution failed",
              status: 500,
              detail: "usage survives transcript failure",
              code: "TRANSCRIPT_USAGE_INDEPENDENCE",
              requestId: crypto.randomUUID(),
              retryable: false,
            },
            usage,
          } as Parameters<typeof own.client.postResult>[1],
          crypto.randomUUID(),
        );
        assertEquals(result.value.status, "applied");
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      const attempts = async () => {
        const response = await fixture.app.fetch(
          new Request(
            `${authTestOrigin}/v1/jobs/${own.job.jobId}/attempts?taskId=${own.job.taskId}`,
            {
              headers: {
                cookie: fixture.adminCookie,
                origin: fixture.config.publicBaseUrl,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
        assertEquals(response.status, 200, await response.clone().text());
        const page = await response.json() as {
          items: Array<
            {
              id: string;
              status: string;
              outcome: {
                exitCode: number | null;
                usage: {
                  inputTokens: string;
                  outputTokens: string;
                  costUsd: string;
                } | null;
              } | null;
            }
          >;
        };
        return page.items.find((item) => item.id === own.assignment.attemptId);
      };
      const usageRows = async () =>
        (await fixture.pgDatabase.query(
          `select usage_fact_id, input_tokens::text, output_tokens::text, cost_usd::text, measurement
             from bakery.usage_records where organization_id=$1 and attempt_id=$2`,
          [fixture.organizationId, own.assignment.attemptId],
        )).rows;
      const settled = await attempts();
      assert(settled);
      assertEquals(settled.status, "failed");
      assertEquals(settled.outcome?.usage?.inputTokens, "11");
      assertEquals(settled.outcome?.usage?.outputTokens, "7");
      const storedUsage = await usageRows();
      assertEquals(storedUsage.length, 1);
      const failed = await streamFor(fixture, own.binding.sessionId);
      assertEquals(failed.archive, "failed");
      assertEquals(failed.archiveFailure, "archive_publication_failed");
      assertEquals(
        (await statusFor(fixture, own.binding.sessionId)).exportDisposition,
        "retryable",
      );
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set history_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 1);
      const expired = await statusFor(fixture, own.binding.sessionId);
      assertEquals(expired.exportDisposition, "expired");
      assertEquals(expired.history, "expired");
      assertEquals(
        (await streamFor(fixture, own.binding.sessionId)).archiveFailure,
        "history_expired",
      );
      assertEquals(await attempts(), settled);
      assertEquals(await usageRows(), storedUsage);
    }));

  Deno.test("after-savepoint-release failure rolls back the result and exact live retry succeeds", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const output = await batch(own.binding, "after release");
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.output",
          payload: output,
        }],
      });
      const body = {
        ...own.open,
        localSeq: "2",
        status: "failed" as const,
        fault: {
          type: "about:blank",
          title: "Worker execution failed",
          status: 500,
          detail: "after savepoint release fault",
          code: "TRANSCRIPT_AFTER_RELEASE_FAULT",
          requestId: crypto.randomUUID(),
          retryable: false,
        },
      } as Parameters<typeof own.client.postResult>[1];
      const key = crypto.randomUUID();
      setOutputFinalizationAfterSavepointReleaseFaultForTest(true);
      try {
        await assertRejects(
          () => own.client.postResult(own.assignment.attemptId, body, key),
          WorkerRequestError,
        );
      } finally {
        setOutputFinalizationAfterSavepointReleaseFaultForTest(false);
      }
      const rolledBack = await fixture.pgDatabase.query<{
        closed: boolean;
        grants: number;
        result_events: number;
        audits: number;
      }>(
        `select stream.closed,
           (select count(*)::int from bakery.session_output_finalizations
             where organization_id=$1 and session_id=$2) as grants,
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$3::uuid
               and event_type='job.failed') as result_events,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and resource_id=$3::text
               and operation='workers.result') as audits
          from bakery.session_output_streams stream
         where stream.organization_id=$1 and stream.id=$2`,
        [
          fixture.organizationId,
          own.binding.sessionId,
          own.assignment.attemptId,
        ],
      );
      assertEquals(rolledBack.rows[0], {
        closed: false,
        grants: 0,
        result_events: 0,
        audits: 0,
      });
      const retry = await own.client.postResult(
        own.assignment.attemptId,
        body,
        key,
      );
      assertEquals(retry.value.status, "applied");
      const state = await readExecutionState(fixture.pgDatabase, own.job.jobId);
      assertEquals(state.job.status, "failed");
      assertEquals(state.run.status, "failed");
      assertEquals(state.step.status, "failed");
      assertEquals(state.attempts[0]?.status, "failed");
      const committed = await fixture.pgDatabase.query<{
        grants: number;
        result_events: number;
        audits: number;
      }>(
        `select
           (select count(*)::int from bakery.session_output_finalizations
             where organization_id=$1 and session_id=$2) as grants,
           (select count(*)::int from bakery.attempt_events
             where organization_id=$1 and attempt_id=$3::uuid
               and event_type='job.failed') as result_events,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and resource_id=$3::text
               and operation='workers.result') as audits`,
        [
          fixture.organizationId,
          own.binding.sessionId,
          own.assignment.attemptId,
        ],
      );
      assertEquals(committed.rows[0], {
        grants: 1,
        result_events: 1,
        audits: 1,
      });
    }));

  Deno.test("a valid grant recovers after lease expiry with exact immutable readback", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "post-lease recovery");
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      const recovered = await own.client.finalizeOutput(
        own.assignment.attemptId,
        own.grant.id,
        {
          grantId: own.grant.id,
          sessionId: own.binding.sessionId,
          frozenHighwater: own.grant.frozen_highwater,
          payloadDigest: own.grant.payload_digest,
        },
      );
      assertEquals(recovered.replayed, false);
      assertEquals(recovered.value.grantId, own.grant.id);
      assertEquals(
        (await grantFor(fixture, own.binding.sessionId)).state,
        "published",
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assert(status.manifest);
      const bytes = await assertDigestAndBytes(fixture, status.segments[0]!);
      assert(new TextDecoder().decode(bytes).includes("post-lease recovery"));
    }));

  Deno.test("retry budget and grant expiry deny mutation at their exact runtime boundaries", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "bounded retry");
      const body = {
        grantId: own.grant.id,
        sessionId: own.binding.sessionId,
        frozenHighwater: own.grant.frozen_highwater,
        payloadDigest: own.grant.payload_digest,
      };
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations
            set state='pending',attempt_count=$3,grant_expires_at=now()+interval '1 hour'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id, TRANSCRIPT_LIMITS.maxAttempts],
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            body,
          ),
        WorkerRequestError,
      );
      const exhausted = await fixture.pgDatabase.query<
        { attempt_count: number }
      >(
        `select attempt_count from bakery.session_output_finalizations where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id],
      );
      assertEquals(
        exhausted.rows[0]?.attempt_count,
        TRANSCRIPT_LIMITS.maxAttempts,
      );
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations set attempt_count=0,grant_expires_at=now()-interval '1 second' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id],
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(
            own.assignment.attemptId,
            own.grant.id,
            body,
          ),
        WorkerRequestError,
      );
      assertEquals(
        (await grantFor(fixture, own.binding.sessionId)).state,
        "failed",
      );
    }));

  Deno.test("revoke receipt replays exactly and blocks later publication", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeRetryable(fixture, "to revoke");
      const body = {
        grantId: own.grant.id,
        leaseToken: own.open.leaseToken,
        fence: own.open.fence,
        workerSessionId: own.open.workerSessionId,
        workerSessionGeneration: own.open.workerSessionGeneration,
      };
      const key = crypto.randomUUID();
      const first = await own.client.revokeOutput(
        own.assignment.attemptId,
        own.grant.id,
        body,
        key,
      );
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      const second = await own.client.revokeOutput(
        own.assignment.attemptId,
        own.grant.id,
        body,
        key,
      );
      assertEquals(second.replayed, true);
      assertEquals(second.value, first.value);
      assertEquals(
        (await fixture.pgDatabase.query<{ state: string }>(
          `select state from bakery.session_output_finalizations where organization_id=$1 and id=$2`,
          [fixture.organizationId, own.grant.id],
        )).rows[0]?.state,
        "revoked",
      );
      await assertRejects(
        () =>
          own.client.finalizeOutput(own.assignment.attemptId, own.grant.id, {
            grantId: own.grant.id,
            sessionId: own.binding.sessionId,
            frozenHighwater: own.grant.frozen_highwater,
            payloadDigest: own.grant.payload_digest,
          }),
        WorkerRequestError,
      );
      await assertRejects(
        () =>
          own.client.revokeOutput(
            own.assignment.attemptId,
            own.grant.id,
            body,
            crypto.randomUUID(),
          ),
        WorkerRequestError,
      );
    }));
}

function failedResultBody(
  open: Awaited<ReturnType<typeof setup>>["open"],
  overrides: { leaseToken?: string; fence?: string; localSeq?: string } = {},
) {
  return {
    ...open,
    localSeq: "1",
    ...overrides,
    status: "failed" as const,
    fault: {
      type: "about:blank",
      title: "Worker execution failed",
      status: 500,
      detail: "transcript review regression",
      code: "TRANSCRIPT_REVIEW_REGRESSION",
      requestId: crypto.randomUUID(),
      retryable: false,
    },
  };
}

async function streamRow(fixture: WorkerFixture, sessionId: string) {
  return (await fixture.pgDatabase.query<{
    closed: boolean;
    capture: string;
    archive_state: string;
    archive_failure: string | null;
    history_expires_at: Date | null;
  }>(
    `select closed,capture,archive_state,archive_failure,history_expires_at
       from bakery.session_output_streams where organization_id=$1 and id=$2`,
    [fixture.organizationId, sessionId],
  )).rows[0];
}

async function retainedIntentBytes(
  fixture: WorkerFixture,
  grantId: string,
): Promise<number> {
  return (await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count from bakery.session_output_finalization_segments
      where organization_id=$1 and grant_id=$2 and content is not null`,
    [fixture.organizationId, grantId],
  )).rows[0]!.count;
}

/** Regressions for independent review findings on #284 (review-1). */
export function transcriptReviewRegressionTests(): void {
  Deno.test("a replacement attempt's terminal result is never rolled back by a stale producer stream", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(await batch(own.binding, "stale producer output"))],
      });
      await expireAndSupersedeAttempt(fixture.pgDatabase, own.job.jobId);
      const replacement = (await own.client.claim({
        claimKey: crypto.randomUUID(),
        workerHostId: own.worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        workerSessionId: own.open.workerSessionId,
        workerSessionGeneration: own.open.workerSessionGeneration,
      })).value;
      assert(replacement);
      const result = await own.client.postResult(
        replacement.attemptId,
        failedResultBody(own.open, {
          leaseToken: replacement.leaseToken,
          fence: replacement.fence,
        }) as Parameters<typeof own.client.postResult>[1],
        crypto.randomUUID(),
      );
      assertEquals(result.value.status, "applied");
      const state = await readExecutionState(fixture.pgDatabase, own.job.jobId);
      assertEquals(state.job.status, "failed");
      const stream = await streamRow(fixture, own.binding.sessionId);
      assertEquals(stream?.closed, true);
      assertEquals(stream?.capture, "interrupted");
      assertEquals(stream?.archive_state, "failed");
      assertEquals(
        stream?.archive_failure,
        "finalization_authority_unavailable",
      );
      assert(stream?.history_expires_at);
      assertEquals(
        (await fixture.pgDatabase.query(
          `select 1 from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
          [fixture.organizationId, own.binding.sessionId],
        )).rowCount,
        0,
      );
    }));

  Deno.test("an unverifiable output binding never rolls back the producer's terminal result", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(await batch(own.binding, "scope drift output"))],
      });
      // A deploy that changes the frozen scope digest makes the binding
      // unverifiable; the result must still apply.
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set scope_digest=repeat('0',64)
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      const result = await own.client.postResult(
        own.assignment.attemptId,
        failedResultBody(own.open, { localSeq: "2" }) as Parameters<
          typeof own.client.postResult
        >[1],
        crypto.randomUUID(),
      );
      assertEquals(result.value.status, "applied");
      assertEquals(
        (await readExecutionState(fixture.pgDatabase, own.job.jobId)).job
          .status,
        "failed",
      );
      const stream = await streamRow(fixture, own.binding.sessionId);
      assertEquals(stream?.closed, true);
      assertEquals(stream?.archive_state, "failed");
      assertEquals(
        stream?.archive_failure,
        "finalization_authority_unavailable",
      );
    }));

  Deno.test("published transcripts retain no intent bytes, only ranges and digests", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeWithGrant(fixture, "published intent purge");
      assertEquals(own.grant.state, "published");
      assertEquals(await retainedIntentBytes(fixture, own.grant.id), 0);
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "published");
      assertEquals(status.segments.length, 1);
      await assertDigestAndBytes(fixture, status.segments[0]!);
    }));

  Deno.test("unpublished transcript intent bytes expire with transient history", () =>
    withWorkerFixture(async (fixture) => {
      setOutputTranscriptPublicationFaultForTest("manifest");
      let own: Awaited<ReturnType<typeof closeWithGrant>>;
      try {
        own = await closeWithGrant(fixture, "expired intent purge");
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      assertEquals(await retainedIntentBytes(fixture, own.grant.id), 1);
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set history_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      await sweepOutputHistory(fixture.runtimePgDatabase);
      assertEquals(await retainedIntentBytes(fixture, own.grant.id), 0);
      assertEquals(
        (await statusFor(fixture, own.binding.sessionId)).exportDisposition,
        "expired",
      );
    }));

  Deno.test("segment-bound coverage reports only the published contiguous prefix", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const thresholds = await segmentThresholds(fixture, own, 15_000);
      await insertSizedBatches(fixture, own, 1, thresholds.seventeen, 15_000);
      await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      assertEquals(status.exportDisposition, "incomplete");
      const last = (status.segments.at(-1) as unknown as {
        lastSequence: string;
      }).lastSequence;
      assertEquals(status.coveredHighwater, last);
      assert(BigInt(status.coveredHighwater) < BigInt(status.frozenHighwater));
      assert(status.manifest);
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await assertDigestAndBytes(fixture, status.manifest),
        ),
      ) as { coveredHighwater: string };
      assertEquals(manifest.coveredHighwater, last);
    }));

  Deno.test("transcript status keeps immutable published references after a later artifact version", () =>
    withWorkerFixture(async (fixture) => {
      const own = await closeWithGrant(fixture, "immutable references");
      const published = await statusFor(fixture, own.binding.sessionId);
      assert(published.manifest);
      const parent = (await fixture.pgDatabase.query<{
        id: string;
        revision: number;
        version: number;
        currentVersionId: string;
        applicationId: string;
        repositoryId: string | null;
        conversationId: string | null;
      }>(
        `select a.id,a.revision,a.version,a.current_version_id as "currentVersionId",
                t.application_id as "applicationId",t.repository_id as "repositoryId",
                t.conversation_id as "conversationId"
           from bakery.artifacts a join bakery.tasks t
             on t.organization_id=a.organization_id and t.id=a.task_id
          where a.organization_id=$1 and a.task_id=$2
            and a.name=$3`,
        [
          fixture.organizationId,
          own.job.taskId,
          `output-transcript/${own.binding.sessionId}/manifest`,
        ],
      )).rows[0];
      assert(parent);
      const content = new TextEncoder().encode('{"later":true}');
      await withPgTransaction(
        fixture.runtimePgDatabase,
        async (transaction) => {
          await commitArtifactVersion(transaction, {
            scope: {
              organizationId: fixture.organizationId,
              taskId: own.job.taskId,
              applicationId: parent.applicationId,
              repositoryId: parent.repositoryId,
              conversationId: parent.conversationId,
            },
            parent: {
              id: parent.id,
              revision: parent.revision,
              version: parent.version,
              currentVersionId: parent.currentVersionId,
            },
            version: {
              parentVersionId: `"${parent.currentVersionId}"`,
              runStepId: null,
              authorId: fixture.principalId,
              subjectHeadSha: null,
              subjectBaseSha: null,
              stepKey: null,
              metadata: {},
              content,
              sha256: await sha256Bytes(content),
              mediaType: "application/json",
            },
            promotion: { kind: "human" },
          });
        },
      );
      const after = await statusFor(fixture, own.binding.sessionId);
      assertEquals(after.manifest, published.manifest);
      assertEquals(after.segments, published.segments);
      assertEquals(after.exportDisposition, "published");
    }));

  Deno.test("an unpublished grant past its deadline is reported failed, never retryable", () =>
    withWorkerFixture(async (fixture) => {
      setOutputTranscriptPublicationFaultForTest("segment");
      let own: Awaited<ReturnType<typeof closeWithGrant>>;
      try {
        own = await closeWithGrant(fixture, "grant deadline");
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      assertEquals(
        (await statusFor(fixture, own.binding.sessionId)).exportDisposition,
        "retryable",
      );
      await fixture.pgDatabase.query(
        `update bakery.session_output_finalizations set grant_expires_at=now()-interval '1 second'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.grant.id],
      );
      assertEquals(
        (await statusFor(fixture, own.binding.sessionId)).exportDisposition,
        "failed",
      );
      await sweepOutputTranscripts(fixture.runtimePgDatabase);
      assertEquals(
        (await grantFor(fixture, own.binding.sessionId)).state,
        "failed",
      );
      const stream = await streamRow(fixture, own.binding.sessionId);
      assertEquals(stream?.archive_state, "failed");
      assertEquals(stream?.archive_failure, "archive_grant_expired");
    }));

  Deno.test("streams left open by a terminated job close and gain a finite history clock", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(await batch(own.binding, "terminated job output"))],
      });
      // Server-side termination (attempt exhaustion, cancellation) ends the
      // job without a worker close.
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set status='lost' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      await fixture.pgDatabase.query(
        `update bakery.jobs set status='failed' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.job.jobId],
      );
      await sweepOutputTranscripts(fixture.runtimePgDatabase);
      const stream = await streamRow(fixture, own.binding.sessionId);
      assertEquals(stream?.closed, true);
      assertEquals(stream?.capture, "interrupted");
      assertEquals(stream?.archive_state, "failed");
      assertEquals(
        stream?.archive_failure,
        "finalization_authority_unavailable",
      );
      assert(stream?.history_expires_at);
    }));

  Deno.test("legacy failed ungranted streams gain a finite history clock", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(await batch(own.binding, "legacy failed output"))],
      });
      // The pre-cutover cron left closed streams failed with no deadline.
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams
            set closed=true,capture='interrupted',reason='source-lost',
                archive_state='failed',archive_failure='archive_publication_failed'
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      );
      await sweepOutputTranscripts(fixture.runtimePgDatabase);
      const stream = await streamRow(fixture, own.binding.sessionId);
      assertEquals(stream?.archive_state, "failed");
      assertEquals(stream?.archive_failure, "no_finalization_grant");
      assert(stream?.history_expires_at);
    }));
}

/** Regressions for independent review findings on #284 (review-2, review-3). */
export function transcriptUpgradeRegressionTests(): void {
  Deno.test("output stream identity and stored scope stay exactly main's across the upgrade", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const row = (await fixture.pgDatabase.query<
        { scope: Record<string, unknown>; scope_digest: string; input: unknown }
      >(
        `select stream.scope, stream.scope_digest, job.input
           from bakery.session_output_streams stream
           join bakery.jobs job on job.organization_id=stream.organization_id and job.id=stream.job_id
          where stream.organization_id=$1 and stream.id=$2`,
        [fixture.organizationId, own.binding.sessionId],
      )).rows[0];
      assert(row);
      // main 63d7ce50 stored this exact scope shape and digest, so streams open
      // across a server deploy keep appending under the same identity.
      assertEquals(Object.keys(row.scope).sort(), MAIN_STREAM_SCOPE_KEYS);
      assertEquals(
        row.scope_digest,
        await outputDigest({ ...row.scope, input: row.input }),
      );
      const appended = await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(await batch(own.binding, "pre-upgrade stream"))],
      });
      assertEquals(appended.value.status, "applied");
      await own.client.closeOutput(
        own.assignment.attemptId,
        {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        },
        crypto.randomUUID(),
      );
      assertEquals(
        (await grantFor(fixture, own.binding.sessionId)).state,
        "published",
      );
      const status = await statusFor(fixture, own.binding.sessionId);
      const bytes = await assertDigestAndBytes(fixture, status.segments[0]!);
      assert(new TextDecoder().decode(bytes).includes("pre-upgrade stream"));
    }));

  Deno.test("worker output open and close responses keep main's exact binding keys", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const raw = async (path: string, body: unknown) => {
        const response = await workerRequest(
          fixture,
          own.worker.credential,
          `/v1/worker/attempts/${own.assignment.attemptId}/${path}`,
          body,
          {
            headers: {
              "X-Bakery-Worker-Protocol-Version": "2",
              "Idempotency-Key": crypto.randomUUID(),
            },
          },
        );
        assertEquals(response.status, 200, await response.clone().text());
        return await response.json() as Record<string, unknown>;
      };
      // Strict main-code workers reject unknown binding keys, so the server
      // must send exactly main's set on open (replay) and close.
      const opened = await raw("output-bindings", own.open);
      assertEquals(Object.keys(opened).sort(), MAIN_WORKER_OUTPUT_BINDING_KEYS);
      const closed = await raw("output-bindings/close", {
        ...own.open,
        sessionId: own.binding.sessionId,
        writerGeneration: own.binding.writerGeneration,
        capture: "complete",
        reason: "clean-end",
      });
      assertEquals(Object.keys(closed).sort(), MAIN_WORKER_OUTPUT_BINDING_KEYS);
    }));
}

/** `WorkerOutputBinding` fields at main 63d7ce50 (strict worker schema). */
const MAIN_WORKER_OUTPUT_BINDING_KEYS = [
  "sessionId",
  "organizationId",
  "applicationId",
  "jobId",
  "taskId",
  "runStepId",
  "conversationId",
  "logicalActor",
  "attemptId",
  "workerHostId",
  "workerSessionId",
  "workerSessionGeneration",
  "fence",
  "writerGeneration",
  "highwater",
  "nextSequence",
  "closed",
  "capture",
  "reason",
  "archive",
].sort();

/** Stored `session_output_streams.scope` keys at main 63d7ce50. */
const MAIN_STREAM_SCOPE_KEYS = [
  "organizationId",
  "applicationId",
  "jobId",
  "taskId",
  "runStepId",
  "conversationId",
  "logicalActor",
].sort();
