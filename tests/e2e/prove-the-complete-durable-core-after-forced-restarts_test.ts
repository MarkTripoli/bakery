import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type ArtifactRef,
  createDurableArtifactClients,
  type DurableArtifactClients,
  type DurableWorkerEvent,
  fetchArtifact,
  fetchArtifactMetadata,
  fetchArtifactVersionMetadata,
  fetchRunSteps,
  postWorkerEvents,
  postWorkerResult,
  publishArtifact,
  publishArtifactResponse,
  withWorkerAssignment,
} from "./helpers/durable-core/artifact-client.ts";
import type { DurableCoreAuditRef } from "../helpers/durable-core/evidence.ts";
import {
  type DurableCoreStack,
  upDurableCoreStack,
} from "../helpers/durable-core/stack.ts";

Deno.test(
  "durable core publishes one immutable artifact across independent TCP clients",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-artifact");
    try {
      const clients = await createDurableArtifactClients(stack);
      const bytes = new TextEncoder().encode("durable-core-terminal-artifact");
      const effectKey = `durable-core-artifact-${crypto.randomUUID()}`;
      const first = await publishArtifact(
        clients.producer,
        bytes,
        effectKey,
      );
      const replay = await publishArtifact(
        clients.producer,
        bytes,
        effectKey,
      );

      const mismatch = await publishArtifactResponse(
        clients.producer,
        new TextEncoder().encode("durable-core-terminal-artifact-mutated"),
        effectKey,
      );
      assertEquals(mismatch.status, 422);
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );

      assertEquals(replay, first);
      assertNotEquals(clients.producer.cookie, clients.consumer.cookie);

      const metadataResponse = await fetchArtifactMetadata(
        clients.consumer,
        first,
      );
      assertEquals(metadataResponse.status, 200);
      const metadata = await metadataResponse.json() as {
        id: string;
        taskId: string;
        currentVersionId: string;
        version: number;
      };
      assertEquals(metadata.id, first.artifactId);
      assertEquals(metadata.taskId, clients.job.taskId);
      assertEquals(metadata.currentVersionId, first.versionId);
      assertEquals(metadata.version, 2);

      const versionsResponse = await fetchArtifactVersionMetadata(
        clients.consumer,
        first,
      );
      assertEquals(versionsResponse.status, 200);
      const versions = await versionsResponse.json() as {
        items: Array<{ id: string; artifactId: string; sha256: string }>;
      };
      assertEquals(versions.items.length, 1);
      assertEquals(versions.items[0]?.id, first.versionId);
      assertEquals(versions.items[0]?.artifactId, first.artifactId);
      assertEquals(versions.items[0]?.sha256, first.sha256);

      const contentResponse = await fetchArtifact(clients.consumer, first);
      assertEquals(contentResponse.status, 200);
      assertEquals(
        Array.from(new Uint8Array(await contentResponse.arrayBuffer())),
        Array.from(bytes),
      );
      assertEquals(contentResponse.headers.get("etag"), `"${first.sha256}"`);

      const foreignMetadata = await fetchArtifactMetadata(
        clients.foreign,
        first,
      );
      const foreignMetadataBody = await foreignMetadata.text();
      assertEquals(foreignMetadata.status, 404);
      assertEquals(foreignMetadataBody.includes(first.artifactId), false);
      assertEquals(foreignMetadataBody.includes(first.versionId), false);

      const foreignContent = await fetchArtifact(clients.foreign, first);
      const foreignContentBody = await foreignContent.text();
      assertEquals(foreignContent.status, 404);
      assertEquals(foreignContentBody.includes(first.artifactId), false);
      assertEquals(foreignContentBody.includes(first.versionId), false);
      assertEquals(
        foreignContentBody.includes("durable-core-terminal-artifact"),
        false,
      );

      const anonymousMetadata = await fetchArtifactMetadata(
        clients.anonymous,
        first,
      );
      const anonymousMetadataBody = await anonymousMetadata.text();
      assertEquals(anonymousMetadata.status, 401);
      assertEquals(anonymousMetadataBody.includes(first.artifactId), false);

      const anonymousContent = await fetchArtifact(clients.anonymous, first);
      const anonymousContentBody = await anonymousContent.text();
      assertEquals(anonymousContent.status, 401);
      assertEquals(anonymousContentBody.includes(first.versionId), false);
      assertEquals(
        anonymousContentBody.includes("durable-core-terminal-artifact"),
        false,
      );

      const facts = await stack.psql<{
        artifacts: number;
        versions: number;
        replays: number;
        events: number;
      }>(
        `select
           (select count(*)::int from bakery.artifacts
             where organization_id = $1 and task_id = $2) as artifacts,
           (select count(*)::int from bakery.artifact_versions
             where organization_id = $1 and task_id = $2) as versions,
           (select count(*)::int from bakery.artifact_publication_replays
             where organization_id = $1 and attempt_id = $3
               and idempotency_key = $4) as replays,
           (select count(*)::int from bakery.domain_events
             where organization_id = $1 and aggregate_id = $5
               and event_type = 'artifact.version_created') as events`,
        [
          clients.producer.organizationId,
          clients.job.taskId,
          clients.producer.producer!.assignment.attemptId,
          effectKey,
          first.artifactId,
        ],
      );
      assertEquals(facts, [{
        artifacts: 1,
        versions: 1,
        replays: 1,
        events: 1,
      }]);
      assert(
        first.sha256.length === 64,
        "the returned reference must retain the server-computed digest",
      );
    } finally {
      await stack.down();
    }
  },
);

type ProtocolCase =
  | "duplicate"
  | "out-of-order"
  | "stale"
  | "lost-acknowledgement"
  | "completion-before-wait";

type WorkerAck = {
  eventId: string;
  status: "applied";
  lastEventSeq: string;
};

type DurableProtocolFacts = {
  terminalResults: number;
  terminalEvents: number;
  artifacts: number;
  versions: number;
  effects: number;
  artifactEvents: number;
  eventRows: number;
  savedAcks: Array<{ localSeq: string; savedAck: unknown }>;
  auditRefs: DurableCoreAuditRef[];
};

function now(): string {
  return new Date().toISOString();
}

function event(
  localSeq: string,
  eventType: string,
  payload: unknown,
): DurableWorkerEvent {
  return {
    eventId: crypto.randomUUID(),
    localSeq,
    eventType,
    payload,
  };
}

async function problemCode(response: Response): Promise<string> {
  const body = await response.json() as { code?: unknown };
  assert(
    typeof body.code === "string",
    "protocol problem responses must include a code",
  );
  return body.code;
}

async function assertProblem(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  const body = await response.clone().text();
  assertEquals(response.status, status, body);
  assertEquals(await problemCode(response), code, body);
}

async function readAck(
  response: Response,
  eventId: string,
  lastEventSeq: string,
  replayed: boolean,
): Promise<WorkerAck> {
  const body = await response.clone().text();
  assertEquals(response.status, 200, body);
  assertEquals(
    response.headers.get("Idempotent-Replayed"),
    replayed ? "true" : null,
  );
  const ack = await response.json() as WorkerAck;
  assertEquals(ack, {
    eventId,
    status: "applied",
    lastEventSeq,
  });
  return ack;
}

async function publishCaseArtifact(
  clients: DurableArtifactClients,
  caseName: ProtocolCase,
): Promise<{ artifact: ArtifactRef; effectKey: string }> {
  const bytes = new TextEncoder().encode(
    `durable-core-protocol-${caseName}-artifact`,
  );
  const effectKey = `durable-core-protocol-${caseName}-${crypto.randomUUID()}`;
  const artifact = await publishArtifact(
    clients.producer,
    bytes,
    effectKey,
  );
  const replay = await publishArtifact(
    clients.producer,
    bytes,
    effectKey,
  );
  assertEquals(replay, artifact);
  return { artifact, effectKey };
}

async function readDurableProtocolFacts(
  stack: DurableCoreStack,
  clients: DurableArtifactClients,
  artifact: ArtifactRef,
  effectKey: string,
): Promise<DurableProtocolFacts> {
  const organizationId = clients.producer.organizationId;
  assert(typeof organizationId === "string");
  const attemptId = clients.producer.producer!.assignment.attemptId;
  const countRows = await stack.psql<{
    terminalResults: number;
    terminalEvents: number;
    artifacts: number;
    versions: number;
    effects: number;
    artifactEvents: number;
    eventRows: number;
  }>(
    `select
       (select count(*)::int from bakery.job_attempts
         where job_id = $1 and status = 'completed') as "terminalResults",
       (select count(*)::int from bakery.attempt_events event
         join bakery.job_attempts attempt on attempt.id = event.attempt_id
        where attempt.job_id = $1 and event.event_type = 'job.succeeded')
         as "terminalEvents",
       (select count(*)::int from bakery.artifacts
         where organization_id = $2 and task_id = $3 and id = $6)
         as "artifacts",
       (select count(*)::int from bakery.artifact_versions
         where organization_id = $2 and artifact_id = $6)
         as "versions",
       (select count(*)::int from bakery.artifact_publication_replays
         where organization_id = $2 and attempt_id = $4
           and idempotency_key = $5) as "effects",
       (select count(*)::int from bakery.domain_events
         where organization_id = $2 and aggregate_id = $6
           and event_type = 'artifact.version_created') as "artifactEvents",
       (select count(*)::int from bakery.attempt_events event
         join bakery.job_attempts attempt on attempt.id = event.attempt_id
        where attempt.job_id = $1) as "eventRows"`,
    [
      clients.job.jobId,
      organizationId,
      clients.job.taskId,
      attemptId,
      effectKey,
      artifact.artifactId,
    ],
  );
  assertEquals(countRows.length, 1);
  const savedAcks = await stack.psql<{
    localSeq: string;
    savedAck: unknown;
  }>(
    `select local_seq::text as "localSeq", saved_ack as "savedAck"
       from bakery.attempt_events
      where organization_id = $1 and attempt_id = $2
      order by local_seq`,
    [organizationId, attemptId],
  );
  const auditRefs = await stack.psql<DurableCoreAuditRef>(
    `select id,
            organization_id as "organizationId",
            resource_type as "resourceType",
            resource_id as "resourceId",
            operation,
            outcome,
            request_id as "requestId",
            trace_id as "traceId"
       from bakery.audit_events
      where organization_id = $1
        and operation = 'workers.result'
        and resource_id = $2
        and outcome = 'succeeded'
      order by created_at`,
    [organizationId, attemptId],
  );
  return {
    ...countRows[0]!,
    savedAcks,
    auditRefs,
  };
}

function assertDurableProtocolFacts(
  facts: DurableProtocolFacts,
  acceptedEventId: string,
  resultKey: string,
  organizationId: string,
  attemptId: string,
  caseName: ProtocolCase,
  requestId: string,
  traceId: string,
): void {
  assertEquals(facts.terminalResults, 1, `${caseName}: terminal result count`);
  assertEquals(facts.terminalEvents, 1, `${caseName}: terminal event count`);
  assertEquals(facts.artifacts, 1, `${caseName}: artifact count`);
  assertEquals(facts.versions, 1, `${caseName}: artifact version count`);
  assertEquals(facts.effects, 1, `${caseName}: effect key count`);
  assertEquals(facts.artifactEvents, 1, `${caseName}: artifact event count`);
  assertEquals(facts.eventRows, 2, `${caseName}: attempt event count`);
  assertEquals(facts.savedAcks, [
    {
      localSeq: "1",
      savedAck: {
        eventId: acceptedEventId,
        status: "applied",
        lastEventSeq: "1",
      },
    },
    {
      localSeq: "2",
      savedAck: {
        eventId: resultKey,
        status: "applied",
        lastEventSeq: "2",
      },
    },
  ], `${caseName}: saved acknowledgements`);
  assertEquals(facts.auditRefs.length, 1, `${caseName}: accepted audit count`);
  const audit = facts.auditRefs[0]!;
  assert(audit.id.length > 0, `${caseName}: missing audit id`);
  assertEquals(audit.organizationId, organizationId);
  assertEquals(audit.resourceType, "job_attempt");
  assertEquals(audit.resourceId, attemptId);
  assertEquals(audit.operation, "workers.result");
  assertEquals(audit.outcome, "succeeded");
  assert(audit.requestId.length > 0, `${caseName}: missing audit request id`);
  assert(audit.traceId.length > 0, `${caseName}: missing audit trace id`);
  assertEquals(audit.requestId, requestId, `${caseName}: audit request id`);
  assertEquals(audit.traceId, traceId, `${caseName}: audit trace id`);
}

async function runProtocolCase(
  stack: DurableCoreStack,
  caseName: ProtocolCase,
  reuse?: DurableArtifactClients,
): Promise<DurableArtifactClients> {
  const clients = await createDurableArtifactClients(stack, reuse);
  const requestId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const assignment = clients.producer.producer!.assignment;
  const organizationId = clients.producer.organizationId;
  if (typeof organizationId !== "string") {
    throw new Error("DURABLE_CORE_PROTOCOL_ORGANIZATION_ID_MISSING");
  }
  const acceptedEvent = event("1", "job.accepted", { acceptedAt: now() });

  if (caseName === "duplicate") {
    const first = await postWorkerEvents(clients.producer, [acceptedEvent]);
    await readAck(first, acceptedEvent.eventId, "1", false);
    const replay = await postWorkerEvents(clients.producer, [acceptedEvent]);
    await readAck(replay, acceptedEvent.eventId, "1", true);
  } else if (caseName === "out-of-order") {
    const gapEvent = event("2", "job.progress", {
      message: "gap before checkpoint",
      percent: 50,
    });
    await assertProblem(
      await postWorkerEvents(clients.producer, [gapEvent]),
      409,
      "EXPECTED_SEQUENCE",
    );
    const recovered = await postWorkerEvents(clients.producer, [
      acceptedEvent,
    ]);
    await readAck(recovered, acceptedEvent.eventId, "1", false);
  } else if (caseName === "stale") {
    const staleFence = await postWorkerEvents(
      withWorkerAssignment(clients.producer, {
        fence: (BigInt(assignment.fence) + 1n).toString(),
      }),
      [acceptedEvent],
    );
    await assertProblem(staleFence, 409, "LEASE_FENCED");
    const staleSessionEvent = event(
      "1",
      "job.accepted",
      { acceptedAt: now() },
    );
    const staleSession = await postWorkerEvents(
      withWorkerAssignment(clients.producer, {
        workerSessionId: crypto.randomUUID(),
      }),
      [staleSessionEvent],
    );
    await assertProblem(staleSession, 409, "LEASE_FENCED");
    const valid = await postWorkerEvents(clients.producer, [acceptedEvent]);
    await readAck(valid, acceptedEvent.eventId, "1", false);
  } else {
    const accepted = await postWorkerEvents(clients.producer, [acceptedEvent]);
    await readAck(accepted, acceptedEvent.eventId, "1", false);
  }

  const { artifact, effectKey } = await publishCaseArtifact(
    clients,
    caseName,
  );
  const terminalResult = {
    headSha: `durable-core-${caseName}-head`,
    baseSha: `durable-core-${caseName}-base`,
    sessionId: clients.job.sessionId,
    artifacts: [artifact],
  };
  const resultKey = crypto.randomUUID();
  const firstResult = await postWorkerResult(
    clients.producer,
    { localSeq: "2", status: "completed", result: terminalResult },
    resultKey,
    { requestId, traceId },
  );
  if (caseName === "lost-acknowledgement") {
    assertEquals(firstResult.status, 200);
    await firstResult.body?.cancel();
    const replay = await postWorkerResult(
      clients.producer,
      { localSeq: "2", status: "completed", result: terminalResult },
      resultKey,
      { requestId, traceId },
    );
    await readAck(replay, resultKey, "2", true);
  } else {
    await readAck(firstResult, resultKey, "2", false);
    if (caseName === "duplicate") {
      const replay = await postWorkerResult(
        clients.producer,
        { localSeq: "2", status: "completed", result: terminalResult },
        resultKey,
        { requestId, traceId },
      );
      await readAck(replay, resultKey, "2", true);
    }
  }

  if (caseName === "completion-before-wait") {
    const completed = await fetchRunSteps(
      clients.consumer,
      clients.job.runId,
    );
    const body = await completed.clone().text();
    assertEquals(completed.status, 200, body);
    const steps = await completed.json() as {
      items: Array<{ id: string; status: string }>;
    };
    assertEquals(
      steps.items.map(({ id, status }) => ({ id, status })),
      [{
        id: clients.job.runStepId,
        status: "completed",
      }],
    );
  }

  const facts = await readDurableProtocolFacts(
    stack,
    clients,
    artifact,
    effectKey,
  );
  assertDurableProtocolFacts(
    facts,
    acceptedEvent.eventId,
    resultKey,
    organizationId,
    assignment.attemptId,
    caseName,
    requestId,
    traceId,
  );
  console.log(
    `DURABLE_CORE_PROTOCOL_CASE ${
      JSON.stringify({
        name: caseName,
        outcome: "passed",
        requestId,
        traceId,
        terminalResults: facts.terminalResults,
        effects: facts.effects,
        artifacts: facts.artifacts,
        auditRefs: facts.auditRefs,
      })
    }`,
  );
  return clients;
}

const cases = [
  "duplicate",
  "out-of-order",
  "stale",
  "lost-acknowledgement",
  "completion-before-wait",
] as const;

Deno.test(
  "durable core records safe outcomes for real TCP replay and race cases",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-protocol");
    try {
      let clients: DurableArtifactClients | undefined;
      for (const caseName of cases) {
        clients = await runProtocolCase(stack, caseName, clients);
      }
    } finally {
      await stack.down();
    }
  },
);
