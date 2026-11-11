import { NativeOutputCapture } from "../../apps/worker/src/native-output.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
} from "./repository-inspection.ts";
import { startOutputServer } from "../e2e/helpers/output-server.ts";
import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import {
  sweepOutputHistory,
  sweepOutputTranscripts,
} from "../../apps/server/src/modules/execution/output-archive.ts";
import { setOutputTranscriptPublicationFaultForTest } from "../../apps/server/src/modules/execution/output-transcript.ts";
import { TRANSCRIPT_LIMITS } from "../../packages/persistence/src/session-output-finalization.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import {
  fastSleep,
  supervisorConfig,
  waitForCondition,
} from "./worker-execution/recovery-support.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import { authTestOrigin, openAuthFixture } from "./auth.ts";
import { connectWebSocket } from "./ws-client.ts";
import { OUTPUT_LIMITS } from "../../packages/contracts/src/output.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  type OutputBatch,
  OutputBatchSchema,
  outputDigest,
} from "../../packages/contracts/src/output.ts";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { type WorkerOutputBinding } from "../../apps/worker/src/types.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  expireAndSupersedeAttempt,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerFixtureCapabilities,
} from "./worker-execution.ts";
import { seedEligibleNonmodelJob } from "./worker-execution/nonmodel-job.ts";
import { withWorkerFixture } from "./worker-execution/scenarios.ts";

export async function batch(
  binding: WorkerOutputBinding,
  text = "owned output",
  sequence = binding.nextSequence,
): Promise<OutputBatch> {
  const value = {
    sessionId: binding.sessionId,
    writerGeneration: binding.writerGeneration,
    batchId: crypto.randomUUID(),
    sequence,
    parts: [{ itemId: crypto.randomUUID(), channel: "stdout" as const, text }],
    capture: "capturing" as const,
    reason: null,
  };
  return OutputBatchSchema.parse({
    ...value,
    digest: await outputDigest(value),
  });
}
export function clientFor(
  fixture: WorkerFixture,
  credential: string,
): WorkerApiClient {
  return new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    credential,
    fetcher: async (input, init) =>
      await fixture.app.fetch(new Request(input, init)),
  });
}
export async function setup(
  fixture: WorkerFixture,
  options: Readonly<{ nonmodel?: boolean }> = {},
) {
  const worker = await registeredWorker(fixture, { slots: 2 });
  const job = options.nonmodel
    ? await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    )
    : await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
  const client = clientFor(fixture, worker.credential);
  const session = {
    workerSessionId: worker.registration.workerSessionId,
    workerSessionGeneration: worker.registration.workerSessionGeneration,
  };
  const assignment = (await client.claim({
    claimKey: crypto.randomUUID(),
    workerHostId: worker.registration.workerHostId,
    capabilities: [...workerFixtureCapabilities],
    ...session,
  })).value;
  assert(assignment);
  if (options.nonmodel) {
    assertEquals(assignment.agentVersionId, null);
  } else {
    assert(assignment.agentVersionId);
  }
  const open = contractSchemas.WorkerOutputOpen.parse({
    leaseToken: assignment.leaseToken,
    fence: assignment.fence,
    ...session,
  });
  const key = crypto.randomUUID();
  const binding =
    (await client.openOutput(assignment.attemptId, open, key)).value;
  assert(binding.sessionId !== session.workerSessionId);
  assertEquals(binding.applicationId, job.applicationId);
  assertEquals(binding.taskId, job.taskId);
  assertEquals(binding.archive, "pending");
  return { client, worker, job, assignment, open, key, binding };
}
export function event(payload: OutputBatch, localSeq = "1") {
  return {
    eventId: crypto.randomUUID(),
    localSeq,
    eventType: "job.output",
    payload,
  };
}
export async function rows(fixture: WorkerFixture, sessionId: string) {
  return (await fixture.pgDatabase.query<
    { sequence: string; payload: OutputBatch }
  >(
    `select sequence::text,payload from bakery.session_output_batches where organization_id=$1 and session_id=$2 order by sequence`,
    [fixture.organizationId, sessionId],
  )).rows;
}
async function failure(work: () => Promise<unknown>, code: string) {
  const error = await assertRejects(work, WorkerRequestError);
  assertEquals(error.code, code);
}
export function integrationTests(
  runFixture: typeof withWorkerFixture = withWorkerFixture,
): void {
  Deno.test("mounted production client commits output once and journal stores only its reference", () =>
    runFixture(async (fixture) => {
      const { client, assignment, open, binding } = await setup(fixture);
      const payload = await batch(binding);
      const record = event(payload);
      const body = { ...open, events: [record] };
      const first = await client.postEvents(assignment.attemptId, body);
      const retry = await client.postEvents(assignment.attemptId, body);
      assertEquals(retry.value, first.value);
      assertEquals(retry.replayed, true);
      assertEquals(
        (await rows(fixture, binding.sessionId)).map((row) => row.payload),
        [payload],
      );
      const journal = (await fixture.pgDatabase.query<
        { payload: unknown; payload_digest: string; saved_ack: unknown }
      >(
        `select payload,payload_digest,saved_ack from bakery.attempt_events where organization_id=$1 and attempt_id=$2`,
        [fixture.organizationId, assignment.attemptId],
      )).rows[0];
      assertEquals(journal.payload, {
        sessionId: payload.sessionId,
        batchId: payload.batchId,
        sequence: payload.sequence,
        writerGeneration: payload.writerGeneration,
        digest: payload.digest,
      });
      assertEquals(journal.payload_digest, await outputDigest(record));
      assertEquals(journal.saved_ack, first.value);
      const second = event(await batch(binding, "second", "2"), "2");
      await client.postEvents(assignment.attemptId, {
        ...open,
        events: [record, second],
      });
      assertEquals(
        (await rows(fixture, binding.sessionId)).map((row) => row.sequence),
        ["1", "2"],
      );
      const close = {
        ...open,
        sessionId: binding.sessionId,
        writerGeneration: binding.writerGeneration,
        capture: "complete" as const,
        reason: "clean-end" as const,
      };
      const key = crypto.randomUUID();
      const closed = await client.closeOutput(assignment.attemptId, close, key);
      assertEquals(closed.value.highwater, "2");
      assertEquals(closed.value.closed, true);
      assertEquals(closed.value.capture, "complete");
      assertEquals(closed.value.archive, "pending");
      assertEquals(
        (await client.closeOutput(assignment.attemptId, close, key)).value,
        closed.value,
      );
      const next = event(await batch(binding, "closed denied", "3"), "3");
      await failure(
        () =>
          client.postEvents(assignment.attemptId, { ...open, events: [next] }),
        "STATE_CONFLICT",
      );
      await failure(
        () =>
          client.openOutput(assignment.attemptId, open, crypto.randomUUID()),
        "STATE_CONFLICT",
      );
    }));
  Deno.test("output gaps, changed duplicates and later journal failure roll back all output and highwater", () =>
    runFixture(async (fixture) => {
      const { client, assignment, open, binding } = await setup(fixture);
      const first = event(await batch(binding));
      await client.postEvents(assignment.attemptId, {
        ...open,
        events: [first],
      });
      const changed = event(await batch(binding, "changed"));
      changed.eventId = first.eventId;
      await failure(
        () =>
          client.postEvents(assignment.attemptId, {
            ...open,
            events: [changed],
          }),
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      const reused = await batch(binding, "changed batch identity", "2");
      reused.batchId = first.payload.batchId;
      const { digest: _oldDigest, ...reuseEnvelope } = reused;
      reused.digest = await outputDigest(reuseEnvelope);
      await failure(
        () =>
          client.postEvents(assignment.attemptId, {
            ...open,
            events: [event(reused, "2")],
          }),
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      const wrongDigest = await batch(binding, "digest mismatch", "2");
      wrongDigest.digest = "0".repeat(64);
      await failure(
        () =>
          client.postEvents(assignment.attemptId, {
            ...open,
            events: [event(wrongDigest, "2")],
          }),
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      const gap = event(await batch(binding, "gap", "3"), "2");
      await failure(
        () =>
          client.postEvents(assignment.attemptId, { ...open, events: [gap] }),
        "EXPECTED_SEQUENCE",
      );
      const second = event(await batch(binding, "rolled back", "2"), "2");
      const bad = {
        eventId: crypto.randomUUID(),
        localSeq: "4",
        eventType: "job.progress",
        payload: { message: "gap after output", percent: null },
      };
      await failure(
        () =>
          client.postEvents(assignment.attemptId, {
            ...open,
            events: [second, bad],
          }),
        "EXPECTED_SEQUENCE",
      );
      assertEquals(
        (await rows(fixture, binding.sessionId)).map((row) => row.sequence),
        ["1"],
      );
      const stream = (await fixture.pgDatabase.query<{ highwater: string }>(
        `select highwater::text from bakery.session_output_streams where organization_id=$1 and id=$2`,
        [fixture.organizationId, binding.sessionId],
      )).rows[0];
      assertEquals(stream.highwater, "1");
      await client.postEvents(assignment.attemptId, {
        ...open,
        events: [second],
      });
    }));
}
// No direct persistence adapter is used by any producer test.
export function securityTests(): void {
  Deno.test("display budget exhaustion retains independent status reserve and truthful truncation close", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      // Owned storage fixture positions aggregate counters at the exact quota boundary.
      // Actual mounted writes must reject display and retain the separate final-marker reserve.
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set display_bytes=$3 where organization_id=$1 and id=$2`,
        [
          fixture.organizationId,
          own.binding.sessionId,
          OUTPUT_LIMITS.displayBytes,
        ],
      );
      const denied = event(await batch(own.binding, "above display quota"));
      await failure(
        () =>
          own.client.postEvents(own.assignment.attemptId, {
            ...own.open,
            events: [denied],
          }),
        "STATE_CONFLICT",
      );
      const marker = await batch(own.binding, "capture truncated");
      marker.parts[0].channel = "status";
      marker.capture = "truncated";
      marker.reason = "text-limit";
      const { digest: _digest, ...envelope } = marker;
      marker.digest = await outputDigest(envelope);
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [event(marker)],
      });
      const closed = (await own.client.closeOutput(own.assignment.attemptId, {
        ...own.open,
        sessionId: own.binding.sessionId,
        writerGeneration: "1",
        capture: "complete",
        reason: "clean-end",
      }, crypto.randomUUID())).value;
      assertEquals(closed.capture, "truncated");
      assertEquals(closed.reason, "text-limit");
      assertEquals(closed.highwater, "1");
      assertEquals(
        (await rows(fixture, own.binding.sessionId))[0].payload,
        marker,
      );
    }));
  Deno.test("authenticated attempt derives scope and rejects foreign app/org and forged authority without bytes", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture, { nonmodel: true });
      assertEquals(own.assignment.agentVersionId, null);
      const otherScope = await createWorkerScope(
        fixture,
        "output-other-org",
        fixture,
      );
      try {
        const otherWorker = await registeredWorker(fixture, {
          scope: otherScope,
        });
        const foreign = clientFor(fixture, otherWorker.credential);
        await failure(
          () =>
            foreign.openOutput(own.assignment.attemptId, {
              ...own.open,
              workerSessionId: otherWorker.registration.workerSessionId,
              workerSessionGeneration:
                otherWorker.registration.workerSessionGeneration,
            }, crypto.randomUUID()),
          "RESOURCE_NOT_FOUND",
        );
        const otherJob = await seedFundedModelJob(
          fixture.pgDatabase,
          fixture.organizationId,
          fixture.principalId,
        );
        const assignment = (await own.client.claim({
          claimKey: crypto.randomUUID(),
          workerHostId: own.worker.registration.workerHostId,
          capabilities: [...workerFixtureCapabilities],
          workerSessionId: own.open.workerSessionId,
          workerSessionGeneration: own.open.workerSessionGeneration,
        })).value;
        assert(assignment);
        assertEquals(assignment.jobId, otherJob.jobId);
        const open = {
          ...own.open,
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
        };
        const otherBinding = (await own.client.openOutput(
          assignment.attemptId,
          open,
          crypto.randomUUID(),
        )).value;
        assert(otherBinding.sessionId !== own.binding.sessionId);
        assert(otherBinding.applicationId !== own.binding.applicationId);
        const cross = event(await batch(own.binding));
        await failure(
          () =>
            own.client.postEvents(assignment.attemptId, {
              ...open,
              events: [cross],
            }),
          "RESOURCE_NOT_FOUND",
        );
        for (
          const patch of [{ leaseToken: "not-the-lease" }, { fence: "999" }, {
            workerSessionId: crypto.randomUUID(),
          }, { workerSessionGeneration: "999" }]
        ) {
          await failure(
            () =>
              own.client.openOutput(own.assignment.attemptId, {
                ...own.open,
                ...patch,
              }, crypto.randomUUID()),
            "LEASE_FENCED",
          );
        }
        const payload = await batch(own.binding);
        payload.writerGeneration = "999";
        const { digest: _digest, ...envelope } = payload;
        payload.digest = await outputDigest(envelope);
        await failure(
          () =>
            own.client.postEvents(own.assignment.attemptId, {
              ...own.open,
              events: [event(payload)],
            }),
          "LEASE_FENCED",
        );
        assertEquals(await rows(fixture, own.binding.sessionId), []);
        // The producer list attributes batches to attempts and discloses
        // nothing else: no worker host, session or lease identity.
        const visible = await outputReader(fixture)
          .actions["output.streams.read"]({
            streamId: own.binding.sessionId,
            limit: 1,
          });
        const producers = visible.stream.producers ?? [];
        assertEquals(producers.length, 1);
        assertEquals(
          Object.keys(producers[0]).sort(),
          ["attemptId", "attemptNo", "writerGeneration"],
        );
        // A reader scoped to another organization finds no such stream.
        await assertRejects(() =>
          outputReader({
            ...fixture,
            organizationId: otherScope.organizationId,
          })
            .actions["output.streams.read"]({
              streamId: own.binding.sessionId,
              limit: 1,
            })
        );
        const forged = { ...own.open, applicationId: otherJob.applicationId };
        await assertRejects(() =>
          own.client.openOutput(
            own.assignment.attemptId,
            forged,
            crypto.randomUUID(),
          )
        );
      } finally {
        await closeWorkerScope(fixture, otherScope);
      }
    }));
  Deno.test("expired lease cannot append unseen bytes while exact saved receipts remain replayable", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const first = event(await batch(own.binding));
      const body = { ...own.open, events: [first] };
      const ack = await own.client.postEvents(own.assignment.attemptId, body);
      await fixture.pgDatabase.query(
        `update bakery.job_attempts set lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.assignment.attemptId],
      );
      assertEquals(
        (await own.client.postEvents(own.assignment.attemptId, body)).value,
        ack.value,
      );
      assertEquals(
        (await own.client.openOutput(
          own.assignment.attemptId,
          own.open,
          own.key,
        )).value,
        own.binding,
      );
      const next = event(await batch(own.binding, "expired", "2"), "2");
      await failure(
        () =>
          own.client.postEvents(own.assignment.attemptId, {
            ...own.open,
            events: [first, next],
          }),
        "LEASE_EXPIRED",
      );
      assertEquals((await rows(fixture, own.binding.sessionId)).length, 1);
    }));
  Deno.test("changed authoritative conversation scope discovers a new stream, never reinterprets the old UUID", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const other = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      await fixture.pgDatabase.query(
        `update bakery.tasks set conversation_id=$3 where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.job.taskId, other.conversationId],
      );
      const next = (await own.client.openOutput(
        own.assignment.attemptId,
        own.open,
        crypto.randomUUID(),
      )).value;
      assert(next.sessionId !== own.binding.sessionId);
      assertEquals(next.conversationId, other.conversationId);
      assertEquals(next.nextSequence, "1");
      const old = event(await batch(own.binding));
      await failure(
        () =>
          own.client.postEvents(own.assignment.attemptId, {
            ...own.open,
            events: [old],
          }),
        "LEASE_FENCED",
      );
      assertEquals(
        (await own.client.openOutput(
          own.assignment.attemptId,
          own.open,
          own.key,
        )).value,
        own.binding,
      );
    }));
}
export function recoveryTests(): void {
  Deno.test("lost acknowledgement sanitized journal reopens, producer replacement continues output sequence and old replay stays exact", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const directory = await Deno.makeTempDir({
        prefix: "bakery-output-journal-",
      });
      try {
        const payload = await batch(own.binding, "before replacement");
        const record = event(payload);
        const options = {
          path: `${directory}/spool.json`,
          maxRecords: 32,
          maxBytes: 262144,
        };
        const spool = await EventSpool.open(options);
        await spool.enqueueEvent({
          ...record,
          attemptId: own.assignment.attemptId,
          leaseToken: own.open.leaseToken,
          fence: own.open.fence,
          eventType: "job.output",
        });
        let lost = true;
        const losingClient = new WorkerApiClient({
          baseUrl: fixture.config.publicBaseUrl,
          credential: own.worker.credential,
          fetcher: async (input, init) => {
            const response = await fixture.app.fetch(new Request(input, init));
            if (
              lost && String(input).endsWith("/events") &&
              response.status === 200
            ) {
              lost = false;
              await response.arrayBuffer();
              throw new Error("OWNED_ACK_LOSS");
            }
            return response;
          },
        });
        const body = { ...own.open, events: [record] };
        await assertRejects(
          () => losingClient.postEvents(own.assignment.attemptId, body),
          WorkerRequestError,
        );
        const reopened = await EventSpool.open(options);
        const saved = reopened.records()[0];
        assertEquals(saved.payload, payload);
        const restarted = await openAuthFixture();
        let newClient: WorkerApiClient;
        try {
          newClient = clientFor(
            { ...fixture, app: restarted.app },
            own.worker.credential,
          );
          const savedAck = await newClient.postEvents(
            own.assignment.attemptId,
            body,
          );
          assertEquals(savedAck.replayed, true);
        } finally {
          await restarted.close();
        }
        newClient = clientFor(fixture, own.worker.credential);
        const replay = await newClient.postEvents(own.assignment.attemptId, {
          ...own.open,
          events: [{
            eventId: saved.eventId,
            localSeq: saved.localSeq,
            eventType: saved.type,
            payload: saved.payload,
          }],
        });
        assertEquals(replay.replayed, true);
        await reopened.acknowledge(
          own.assignment.attemptId,
          replay.value.lastEventSeq,
        );
        assertEquals(reopened.records(), []);
        await expireAndSupersedeAttempt(fixture.pgDatabase, own.job.jobId);
        const replacement = (await newClient.claim({
          claimKey: crypto.randomUUID(),
          workerHostId: own.worker.registration.workerHostId,
          capabilities: [...workerFixtureCapabilities],
          workerSessionId: own.open.workerSessionId,
          workerSessionGeneration: own.open.workerSessionGeneration,
        })).value;
        assert(replacement);
        const open = {
          ...own.open,
          leaseToken: replacement.leaseToken,
          fence: replacement.fence,
        };
        const binding = (await newClient.openOutput(
          replacement.attemptId,
          open,
          crypto.randomUUID(),
        )).value;
        assertEquals(binding.sessionId, own.binding.sessionId);
        assertEquals(binding.writerGeneration, "2");
        assertEquals(binding.nextSequence, "2");
        assertEquals(binding.capture, "interrupted");
        assertEquals(binding.reason, "producer-replaced");
        const next = event(await batch(binding, "after replacement"));
        await newClient.postEvents(replacement.attemptId, {
          ...open,
          events: [next],
        });
        // The reader attributes each batch to its attempt through the
        // writer generation: the same stream, one producer per attempt.
        const attributed = await outputReader(fixture)
          .actions["output.streams.read"]({
            streamId: binding.sessionId,
            limit: 10,
          });
        assertEquals(attributed.stream.producers, [
          {
            writerGeneration: "1",
            attemptId: own.assignment.attemptId,
            attemptNo: 1,
          },
          {
            writerGeneration: "2",
            attemptId: replacement.attemptId,
            attemptNo: 2,
          },
        ]);
        assertEquals(
          attributed.batches.map((item) => item.writerGeneration),
          ["1", "2"],
        );
        const committed = await rows(fixture, binding.sessionId);
        assertEquals(
          (await newClient.postEvents(own.assignment.attemptId, body)).value,
          replay.value,
        );
        assertEquals(
          (await newClient.openOutput(
            own.assignment.attemptId,
            own.open,
            own.key,
          )).value,
          own.binding,
        );
        const unseen = event(await batch(own.binding, "stale", "3"), "2");
        await failure(
          () =>
            newClient.postEvents(own.assignment.attemptId, {
              ...own.open,
              events: [record, unseen],
            }),
          "LEASE_FENCED",
        );
        assertEquals(
          (await rows(fixture, binding.sessionId)).map((row) =>
            row.payload.parts[0].text
          ),
          ["before replacement", "after replacement"],
        );
        // A fenced stale producer wrote nothing: committed batches, and so
        // their attribution, are byte-identical to before the rejected append.
        assertEquals(await rows(fixture, binding.sessionId), committed);
        const closed = (await newClient.closeOutput(replacement.attemptId, {
          ...open,
          sessionId: binding.sessionId,
          writerGeneration: binding.writerGeneration,
          capture: "complete",
          reason: "clean-end",
        }, crypto.randomUUID())).value;
        assertEquals(closed.capture, "interrupted");
        assertEquals(closed.highwater, "2");
        assertEquals(closed.archive, "pending");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }));
  Deno.test("worker process-session replacement fences unseen output but preserves old append/open/close receipts", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const first = event(await batch(own.binding));
      const body = { ...own.open, events: [first] };
      const ack = await own.client.postEvents(own.assignment.attemptId, body);
      const newSessionId = crypto.randomUUID();
      const heartbeat = await own.client.heartbeat(
        {
          workerHostId: own.worker.registration.workerHostId,
          observedAt: new Date().toISOString(),
          load: 0,
          activeAttemptIds: [own.assignment.attemptId],
          ackCommandIds: [],
          rejectedCommandIds: [],
          workerSessionId: newSessionId,
          workerSessionGeneration: own.open.workerSessionGeneration,
        },
        undefined,
        crypto.randomUUID(),
      );
      assertEquals(heartbeat.value.workerSessionId, newSessionId);
      const generation = heartbeat.value.workerSessionGeneration;
      assert(typeof generation === "string");
      const open = {
        ...own.open,
        workerSessionId: newSessionId,
        workerSessionGeneration: generation,
      };
      // Genuine claim replay rebinds the live attempt to the host's new process session.
      // The old request can still replay; unseen writes cannot borrow that receipt.
      assertEquals(
        (await own.client.postEvents(own.assignment.attemptId, body)).value,
        ack.value,
      );
      const unseen = event(await batch(own.binding, "old process", "2"), "2");
      await failure(
        () =>
          own.client.postEvents(own.assignment.attemptId, {
            ...own.open,
            events: [first, unseen],
          }),
        "LEASE_FENCED",
      );
      // Heartbeat reconciliation rebinds active attempts for the authenticated host.
      const replacement = (await own.client.openOutput(
        own.assignment.attemptId,
        open,
        crypto.randomUUID(),
      )).value;
      assertEquals(replacement.sessionId, own.binding.sessionId);
      assertEquals(replacement.writerGeneration, "2");
      assertEquals(replacement.nextSequence, "2");
      const staleGeneration = event(
        await batch(own.binding, "stale generation", "2"),
        "2",
      );
      await failure(
        () =>
          own.client.postEvents(own.assignment.attemptId, {
            ...open,
            events: [first, staleGeneration],
          }),
        "LEASE_FENCED",
      );
      assertEquals((await rows(fixture, own.binding.sessionId)).length, 1);
      await own.client.postEvents(own.assignment.attemptId, {
        ...open,
        events: [event(await batch(replacement, "new process"), "2")],
      });
      const close = {
        ...open,
        sessionId: replacement.sessionId,
        writerGeneration: replacement.writerGeneration,
        capture: "interrupted" as const,
        reason: "source-lost" as const,
      };
      const key = crypto.randomUUID();
      const closed = await own.client.closeOutput(
        own.assignment.attemptId,
        close,
        key,
      );
      await expireAndSupersedeAttempt(fixture.pgDatabase, own.job.jobId);
      assertEquals(
        (await own.client.closeOutput(own.assignment.attemptId, close, key))
          .value,
        closed.value,
      );
    }));
}

async function prepareArchive(fixture: WorkerFixture) {
  const own = await setup(fixture);
  const payloads: OutputBatch[] = [];
  for (let sequence = 1; sequence <= 70; sequence++) {
    const payload = await batch(
      own.binding,
      "界".repeat(5000),
      String(sequence),
    );
    payloads.push(payload);
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [event(payload, String(sequence))],
    });
  }
  const reader = outputReader(fixture);
  const before = await reader.actions["output.streams.read"]({
    streamId: own.binding.sessionId,
    limit: 1,
  });
  await own.client.closeOutput(own.assignment.attemptId, {
    ...own.open,
    sessionId: own.binding.sessionId,
    writerGeneration: own.binding.writerGeneration,
    capture: "truncated",
    reason: "text-limit",
  }, crypto.randomUUID());
  // The close hook publishes; concurrent sweeps must replay, not duplicate.
  await Promise.all([
    sweepOutputTranscripts(fixture.runtimePgDatabase),
    sweepOutputTranscripts(fixture.runtimePgDatabase),
  ]);
  const archived = await reader.actions["output.streams.read"]({
    streamId: own.binding.sessionId,
    limit: 1,
  });
  return { own, payloads, reader, before, archived };
}

export function archiveIntegrationTests(
  runFixture: typeof withWorkerFixture = withWorkerFixture,
): void {
  Deno.test("archive segments retain digests and references after transient content expires", () =>
    runFixture(async (fixture) => {
      const publicationStart = Date.now();
      const { own, payloads, archived } = await prepareArchive(fixture);
      const publicationEnd = Date.now();
      assertEquals(archived.stream.archive, "archived");
      assertEquals(archived.stream.segments.length, 2);
      const reader = outputReader(fixture);
      const artifacts = await reader.actions["artifacts.list"]({
        taskId: own.job.taskId,
      });
      const recovered: OutputBatch[] = [];
      for (const segment of archived.stream.segments) {
        const listed = artifacts.items.find((artifact) =>
          artifact.currentVersionId === segment.artifactVersionId
        );
        assert(listed);
        assertEquals(listed.artifactType, "log");
        const artifact = await reader.actions["artifacts.get"]({
          id: listed.id,
        });
        assertEquals(artifact, listed);
        assertEquals(artifact.artifactType, "log");
        assertEquals(
          artifact.name,
          `output-transcript/${own.binding.sessionId}/segment/${
            String(segment.segmentIndex + 1).padStart(6, "0")
          }`,
        );
        const retention = await fixture.pgDatabase.query<{
          retention_class: string;
          expires_at: Date;
        }>(
          `select retention_class, expires_at from bakery.artifact_versions where organization_id=$1 and id=$2`,
          [fixture.organizationId, segment.artifactVersionId],
        );
        assertEquals(retention.rows[0].retention_class, "transient");
        const publishedAt = retention.rows[0].expires_at.getTime() -
          30 * 86400000;
        assert(
          publishedAt >= publicationStart && publishedAt <= publicationEnd,
        );
        assert(segment.sizeBytes <= TRANSCRIPT_LIMITS.maxSegmentBytes);
        assertEquals(segment.completeness, "truncated");
        const response = await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/artifact-versions/${segment.artifactVersionId}/content`,
            {
              headers: {
                cookie: fixture.adminCookie,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
        assertEquals(response.status, 200);
        const content = new Uint8Array(await response.arrayBuffer());
        assertEquals(content.byteLength, segment.sizeBytes);
        assertEquals(await sha256Bytes(content), segment.sha256);
        const document = JSON.parse(new TextDecoder().decode(content));
        assertEquals(document.streamId, own.binding.sessionId);
        assertEquals(document.firstSequence, segment.firstSequence);
        assertEquals(document.lastSequence, segment.lastSequence);
        recovered.push(
          ...OutputBatchSchema.array().describe(
            "Committed transcript batches in segment order.",
          ).parse(document.batches),
        );
      }
      assertEquals(recovered, payloads);
      // Versions attributed to the producing run step stay protected until
      // that step and its run are terminal.
      await fixture.pgDatabase.query(
        `update bakery.tasks set status='completed' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.job.taskId],
      );
      for (const segment of archived.stream.segments) {
        assertEquals(
          await collectArtifactVersion(
            fixture.pgDatabase,
            segment.artifactVersionId,
          ),
          false,
        );
      }
      await fixture.pgDatabase.query(
        `update bakery.run_steps set status='completed' where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.job.runStepId],
      );
      await fixture.pgDatabase.query(
        `update bakery.workflow_runs set status='completed'
          where organization_id=$1
            and id=(select run_id from bakery.run_steps where organization_id=$1 and id=$2)`,
        [fixture.organizationId, own.job.runStepId],
      );
      for (const segment of archived.stream.segments) {
        assertEquals(
          await collectArtifactVersion(
            fixture.pgDatabase,
            segment.artifactVersionId,
          ),
          false,
        );
        await fixture.pgDatabase.query(
          `update bakery.artifact_versions set expires_at=now()-interval '1 second' where organization_id=$1 and id=$2`,
          [fixture.organizationId, segment.artifactVersionId],
        );
        assertEquals(
          await collectArtifactVersion(
            fixture.pgDatabase,
            segment.artifactVersionId,
          ),
          true,
        );
        const response = await fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/artifact-versions/${segment.artifactVersionId}/content`,
            {
              headers: {
                cookie: fixture.adminCookie,
                "Bakery-Organization-Id": fixture.organizationId,
              },
            },
          ),
        );
        assertEquals(response.status, 410);
        assertEquals((await response.json()).code, "ARTIFACT_CONTENT_EXPIRED");
      }
      const collected = await outputReader(fixture).actions
        ["output.streams.read"]({
          streamId: own.binding.sessionId,
          limit: 1,
        });
      assertEquals(collected.stream.segments, archived.stream.segments);
      const deleted = await fixture.pgDatabase.query(
        `delete from bakery.artifact_versions where organization_id=$1 and id=any($2::uuid[]) returning id`,
        [
          fixture.organizationId,
          archived.stream.segments.map((segment) => segment.artifactVersionId),
        ],
      );
      assertEquals(deleted.rowCount, 2);
      assertEquals(
        (await fixture.pgDatabase.query(
          `select * from bakery.output_transcript_segments where organization_id=$1 and stream_id=$2`,
          [fixture.organizationId, own.binding.sessionId],
        )).rows,
        [],
      );
    }));

  Deno.test("failed archive rolls back artifacts and preserves lifecycle, receipts and batches for retry", () =>
    runFixture(async (fixture) => {
      const own = await setup(fixture);
      const record = event(await batch(own.binding));
      const body = { ...own.open, events: [record] };
      const ack = await own.client.postEvents(own.assignment.attemptId, body);
      for (let sequence = 2; sequence <= 72; sequence++) {
        await own.client.postEvents(own.assignment.attemptId, {
          ...own.open,
          events: [
            event(
              await batch(own.binding, "x".repeat(16000), String(sequence)),
              String(sequence),
            ),
          ],
        });
      }
      // Fail the close hook's publication after its first segment commit.
      setOutputTranscriptPublicationFaultForTest("segment");
      try {
        await own.client.closeOutput(own.assignment.attemptId, {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          capture: "interrupted",
          reason: "source-lost",
        }, crypto.randomUUID());
      } finally {
        setOutputTranscriptPublicationFaultForTest(null);
      }
      const lifecycle = await fixture.pgDatabase.query(
        `select * from bakery.jobs where id=$1`,
        [own.job.jobId],
      );
      const failed = await outputReader(fixture).actions["output.streams.read"](
        { streamId: own.binding.sessionId },
      );
      assertEquals(failed.stream.closed, true);
      assertEquals(failed.stream.archive, "failed");
      assertEquals(failed.stream.archiveFailure, "archive_publication_failed");
      assertEquals(failed.stream.segments, []);
      assertEquals(
        (await fixture.pgDatabase.query(
          `select id from bakery.artifacts where task_id=$1 and artifact_type='log'`,
          [own.job.taskId],
        )).rows,
        [],
      );
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 0);
      assertEquals(
        (await fixture.pgDatabase.query(
          `select count(*)::int as count from bakery.session_output_batches where session_id=$1`,
          [own.binding.sessionId],
        )).rows[0].count,
        72,
      );
      assertEquals(
        (await own.client.postEvents(own.assignment.attemptId, body)).value,
        ack.value,
      );
      assertEquals(
        await sweepOutputTranscripts(fixture.runtimePgDatabase),
        { finalized: 1, failed: 0, expired: 0 },
      );
      assertEquals(
        (await fixture.pgDatabase.query(
          `select * from bakery.jobs where id=$1`,
          [own.job.jobId],
        )).rows,
        lifecycle.rows,
      );
      const retry = await outputReader(fixture).actions["output.streams.read"]({
        streamId: own.binding.sessionId,
      });
      assertEquals(retry.stream.archive, "archived");
      assertEquals(retry.stream.archiveFailure, null);
      assertEquals(retry.stream.segments[0].completeness, "interrupted");
    }));
}

export function archiveRecoveryTests(
  runFixture: typeof withWorkerFixture = withWorkerFixture,
): void {
  Deno.test("restart and expired cursors reset to immutable archive references", () =>
    runFixture(async (fixture) => {
      const { own, reader, before, archived } = await prepareArchive(
        fixture,
      );
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 0);
      await fixture.pgDatabase.query(
        `update bakery.session_output_streams set history_expires_at=now()-interval '1 second' where id=$1`,
        [own.binding.sessionId],
      );
      assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 70);
      const restarted = await openAuthFixture();
      try {
        await sweepOutputTranscripts(restarted.runtimePgDatabase);
        const reset = await outputReader({ ...fixture, app: restarted.app })
          .actions["output.streams.read"]({
            streamId: own.binding.sessionId,
            cursor: before.cursor,
          });
        assertEquals(reset.disposition, "reset_required");
        assertEquals(reset.resumeAfter, "70");
        assertEquals(reset.batches, []);
        assertEquals(reset.stream.segments, archived.stream.segments);
        const server = Deno.serve({
          hostname: "127.0.0.1",
          port: 0,
          onListen: () => {},
        }, (request) => restarted.app.fetch(request));
        try {
          const socket = await connectWebSocket(
            `ws://127.0.0.1:${server.addr.port}/v1/events?organizationId=${fixture.organizationId}`,
            {
              headers: { cookie: fixture.adminCookie, origin: authTestOrigin },
            },
          );
          assert("send" in socket);
          try {
            await socket.next(2000);
            await socket.send(
              JSON.stringify({
                type: "output.subscribe",
                requestId: crypto.randomUUID(),
                streamId: own.binding.sessionId,
                after: null,
              }),
            );
            const raw = await socket.next(2000);
            assert(typeof raw === "string");
            const frame = contractSchemas.WebSocketFrame.parse(JSON.parse(raw));
            assertEquals(
              frame.type,
              "output.reset_required",
              JSON.stringify(frame),
            );
            assert("stream" in frame);
            assertEquals(frame.stream?.segments, archived.stream.segments);
            assertEquals(frame.retainedFrom, null);
          } finally {
            await socket.close();
          }
        } finally {
          await server.shutdown();
        }
        const initial = await reader.actions["output.streams.read"]({
          streamId: own.binding.sessionId,
        });
        assertEquals(initial.disposition, "reset_required");
      } finally {
        await restarted.close();
      }
    }));
}

export function replayHarnessTests(
  runFixture: typeof withWorkerFixture = withWorkerFixture,
): void {
  Deno.test("scripted harness count survives process restart and cursor resume", () =>
    runFixture(async (fixture) => {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const directory = await Deno.makeTempDir({ prefix: "output-archive-" });
      const registrationStore = new RegistrationStore(
        `${directory}/registration.json`,
      );
      await registrationStore.saveRegistered(
        worker.credential,
        worker.registration,
      );
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 100,
        maxBytes: 1024 * 1024,
      });
      let harnessInvocations = 0;
      let activeServer = await startOutputServer(directory).catch(
        async (error) => {
          await Deno.remove(directory, { recursive: true });
          throw error;
        },
      );
      let available = Promise.resolve();
      let idleClaims = 0;
      const scriptedHarness: WorkerExecutor = {
        capturesNativeOutput: true,
        supportedActions: ["harness.implement"],
        async execute(_assignment, _signal, output) {
          harnessInvocations++;
          assert(output);
          await output.write(
            "stdout",
            new TextEncoder().encode("first committed output"),
          );
          await output.write(
            "stderr",
            new TextEncoder().encode("second committed output"),
          );
          return {
            status: "completed",
            result: {
              headSha: "head",
              baseSha: "base",
              sessionId: job.sessionId,
              artifacts: [],
            },
          };
        },
      };
      const supervisor = new WorkerSupervisor({
        config: {
          ...supervisorConfig(directory),
          serverUrl: fixture.config.publicBaseUrl,
        },
        client: new WorkerApiClient({
          baseUrl: fixture.config.publicBaseUrl,
          credential: worker.credential,
          fetcher: async (input, init) => {
            await available;
            const response = await activeServer.fetch(new Request(input, init));
            if (
              new URL(String(input)).pathname.endsWith("/claims") &&
              response.status === 204
            ) idleClaims++;
            return response;
          },
        }),
        registrationStore,
        spool,
        executor: scriptedHarness,
        sleep: fastSleep,
      });
      const running = supervisor.run();
      try {
        await waitForCondition(
          async () =>
            (await fixture.pgDatabase.query(
                `select stream.id from bakery.session_output_streams stream join bakery.jobs job on job.id=stream.job_id where stream.job_id=$1 and stream.closed and job.status='completed'`,
                [job.jobId],
              )).rows.length === 1 && spool.peek() === null,
          "SCRIPTED_OUTPUT_CLOSED",
        );
        const stream = (await fixture.pgDatabase.query<{ id: string }>(
          `select id from bakery.session_output_streams where job_id=$1`,
          [job.jobId],
        )).rows[0];
        const initialReader = outputReader({ ...fixture, app: activeServer });
        const first = await initialReader.actions["output.streams.read"]({
          streamId: stream.id,
          limit: 1,
        });
        assertEquals(first.batches.length, 1);
        const all = await initialReader.actions["output.streams.read"]({
          streamId: stream.id,
        });
        assert(all.batches.length > 1);
        assertEquals(harnessInvocations, 1);
        const beforeInvocations = harnessInvocations;
        const originalPid = activeServer.pid;
        const restarting = Promise.withResolvers<void>();
        available = restarting.promise;
        try {
          await activeServer.stop();
          activeServer = await startOutputServer(directory);
          assert(activeServer.pid !== originalPid);
        } finally {
          restarting.resolve();
        }
        const reader = outputReader({ ...fixture, app: activeServer });
        const resumed = await reader.actions["output.streams.read"]({
          streamId: stream.id,
          cursor: first.cursor,
        });
        assertEquals(resumed.disposition, "page");
        assertEquals(resumed.batches, all.batches.slice(1));
        const afterResumeClaims = idleClaims;
        await waitForCondition(
          () => idleClaims >= afterResumeClaims + 3,
          "RESTARTED_SERVER_IDLE_CLAIMS",
        );
        assertEquals(harnessInvocations, beforeInvocations);
        await sweepOutputTranscripts(fixture.runtimePgDatabase);
        await fixture.pgDatabase.query(
          `update bakery.session_output_streams set history_expires_at=now()-interval '1 second' where id=$1`,
          [stream.id],
        );
        await sweepOutputHistory(fixture.runtimePgDatabase);
        for (let replay = 0; replay < 2; replay++) {
          const page = await reader.actions["output.streams.read"]({
            streamId: stream.id,
            cursor: first.cursor,
          });
          assertEquals(page.disposition, "reset_required");
          const segment = page.stream.segments[0];
          const stored = await fixture.pgDatabase.query<
            { content: Uint8Array }
          >(`select content from bakery.artifact_versions where id=$1`, [
            segment.artifactVersionId,
          ]);
          assertEquals(
            await sha256Bytes(stored.rows[0].content),
            segment.sha256,
          );
        }
        const afterResetClaims = idleClaims;
        await waitForCondition(
          () => idleClaims >= afterResetClaims + 3,
          "EXPIRED_REPLAY_IDLE_CLAIMS",
        );
        assertEquals(harnessInvocations, beforeInvocations);
      } finally {
        supervisor.requestStop("archive-test-cleanup");
        try {
          await running;
        } finally {
          await activeServer.stop();
          await Deno.remove(directory, { recursive: true });
        }
      }
    }));
}

function outputReader(
  fixture: Pick<WorkerFixture, "adminCookie" | "organizationId" | "config"> & {
    app: Pick<WorkerFixture["app"], "fetch">;
  },
) {
  return createBakeryClient({
    baseUrl: fixture.config.publicBaseUrl,
    getContext: () => ({ organizationId: fixture.organizationId }),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.adminCookie);
      return fixture.app.fetch(new Request(input, { ...init, headers }));
    },
  });
}

export function archiveSecurityTests(): void {
  Deno.test("split secrets remain redacted in immutable archive bytes", () =>
    withWorkerFixture(async (fixture) => {
      const own = await setup(fixture);
      const directory = await Deno.makeTempDir({
        prefix: "archive-redaction-",
      });
      try {
        const spool = await EventSpool.open({
          path: `${directory}/spool.json`,
          maxRecords: 100,
          maxBytes: 1024 * 1024,
        });
        const capture = new NativeOutputCapture({
          assignment: own.assignment,
          binding: own.binding,
          client: own.client,
          spool,
          workerSessionId: own.open.workerSessionId,
          workerSessionGeneration: own.open.workerSessionGeneration,
          configuredSecrets: ["split-secret-canary"],
          leaseActive: () => true,
          waitForAck: () => Promise.resolve(),
        });
        await capture.write(
          "stdout",
          new TextEncoder().encode("hello split-secret-"),
        );
        await capture.write("stdout", new TextEncoder().encode("canary world"));
        const disposition = await capture.finish();
        assert(disposition);
        for (const record of spool.records()) {
          assertEquals(record.type, "job.output");
          await own.client.postEvents(own.assignment.attemptId, {
            ...own.open,
            events: [{
              eventId: record.eventId,
              localSeq: record.localSeq,
              eventType: record.type,
              payload: record.payload,
            }],
          });
        }
        await own.client.closeOutput(own.assignment.attemptId, {
          ...own.open,
          sessionId: own.binding.sessionId,
          writerGeneration: own.binding.writerGeneration,
          ...disposition,
        }, crypto.randomUUID());
        await sweepOutputTranscripts(fixture.runtimePgDatabase);
        const page = await outputReader(fixture).actions["output.streams.read"](
          { streamId: own.binding.sessionId },
        );
        const segment = page.stream.segments[0];
        const stored = await fixture.pgDatabase.query<{ content: Uint8Array }>(
          `select content from bakery.artifact_versions where id=$1`,
          [segment.artifactVersionId],
        );
        const text = new TextDecoder().decode(stored.rows[0].content);
        assert(!text.includes("split-secret-canary"));
        assert(text.includes("[REDACTED]"));
        assertEquals(await sha256Bytes(stored.rows[0].content), segment.sha256);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }));
}

export function tasklessArchiveTests(): void {
  Deno.test("taskless inspection skips task-owned archive and expires history after thirty days", () =>
    withWorkerFixture(async (fixture) => {
      const harness = await openRepositoryInspectionHarness({
        authDb: fixture.pgDatabase,
        appPg: fixture.runtimePgDatabase,
      }, fixture);
      try {
        const repository = await harness.createRepository();
        await harness.onboard(repository.repositoryId);
        const assignment = await readInspectionAssignment(
          await harness.claim(),
        );
        const open = {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          workerSessionId: harness.registration.workerSessionId,
          workerSessionGeneration: harness.registration.workerSessionGeneration,
        };
        const opened = await harness.workerRequest(
          `/v1/worker/attempts/${assignment.attemptId}/output-bindings`,
          open,
        );
        assertEquals(opened.status, 200);
        const binding = contractSchemas.WorkerOutputBinding.parse(
          await opened.json(),
        );
        assertEquals(binding.taskId, null);
        for (let sequence = 1; sequence <= 2; sequence++) {
          const record = event(
            await batch(binding, "inspection log", String(sequence)),
            String(sequence),
          );
          const response = await harness.workerRequest(
            `/v1/worker/attempts/${assignment.attemptId}/events`,
            { ...open, events: [record] },
            record.eventId,
          );
          assertEquals(response.status, 200);
          await response.body?.cancel();
        }
        const reader = outputReader(fixture);
        const before = await reader.actions["output.streams.read"]({
          streamId: binding.sessionId,
          limit: 1,
        });
        // Close records the not-required disposition and its deadline.
        const start = Date.now();
        const closed = await harness.workerRequest(
          `/v1/worker/attempts/${assignment.attemptId}/output-bindings/close`,
          {
            ...open,
            sessionId: binding.sessionId,
            writerGeneration: binding.writerGeneration,
            capture: "complete",
            reason: "clean-end",
          },
        );
        assertEquals(closed.status, 200);
        await closed.body?.cancel();
        await sweepOutputTranscripts(fixture.runtimePgDatabase);
        const page = await reader.actions["output.streams.read"]({
          streamId: binding.sessionId,
        });
        assertEquals(page.stream.archive, "not_required");
        assertEquals(page.stream.archiveFailure, "no_task_owned_destination");
        assertEquals(page.stream.segments, []);
        assertEquals(page.stream.archivedAt, null);
        assert(page.stream.historyExpiresAt);
        const expiry = Date.parse(page.stream.historyExpiresAt);
        assert(expiry >= start + 30 * 86400_000);
        assert(expiry <= Date.now() + 30 * 86400_000);
        await sweepOutputTranscripts(fixture.runtimePgDatabase);
        assertEquals(
          (await reader.actions["output.streams.read"]({
            streamId: binding.sessionId,
          })).stream,
          page.stream,
        );
        assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 0);
        await fixture.pgDatabase.query(
          `update bakery.session_output_streams set history_expires_at=now()-interval '1 second' where id=$1`,
          [binding.sessionId],
        );
        assertEquals(await sweepOutputHistory(fixture.runtimePgDatabase), 2);
        const reset = await reader.actions["output.streams.read"]({
          streamId: binding.sessionId,
          cursor: before.cursor,
        });
        assertEquals(reset.disposition, "reset_required");
        assertEquals(reset.batches, []);
        assertEquals(reset.stream.segments, []);
        assertEquals(reset.stream.archive, "not_required");
        assertEquals(reset.resumeAfter, "2");
      } finally {
        await harness.close();
      }
    }));
}
