import { assertEquals } from "@std/assert";
import {
  assertDurableCoreAuditLinks,
  createDurableCoreCase,
} from "../helpers/durable-core/evidence.ts";
import {
  createDurableArtifactClients,
  fetchArtifact,
  fetchArtifactMetadata,
  fetchArtifactVersionMetadata,
  fetchRunSteps,
  fetchTaskSync,
  postWorkerResult,
  publishArtifact,
} from "../e2e/helpers/durable-core/artifact-client.ts";
import { upDurableCoreStack } from "../helpers/durable-core/stack.ts";

type ProblemEvidence = {
  readonly raw: string;
  readonly code: string;
  readonly requestId: string;
  readonly traceId: string;
};

async function problemEvidence(response: Response): Promise<ProblemEvidence> {
  const raw = await response.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  assertEquals(typeof body.code, "string", raw);
  assertEquals(typeof body.requestId, "string", raw);
  assertEquals(typeof body.traceId, "string", raw);
  return {
    raw,
    code: body.code as string,
    requestId: body.requestId as string,
    traceId: body.traceId as string,
  };
}

const PRE_AUDIT_DENIAL_REASONS = Object.freeze({
  foreignRun:
    "verified zero audit_events rows for foreign-run-reference request/trace",
  foreignProgress:
    "verified zero audit_events rows for foreign-progress-reference request/trace",
  foreignArtifact:
    "verified zero audit_events rows for foreign-artifact-reference request/trace",
  anonymousArtifact:
    "verified zero audit_events rows for anonymous-artifact-reference request/trace",
});

function assertNoIdentifierLeak(
  body: string,
  identifiers: readonly string[],
): void {
  for (const identifier of identifiers) {
    assertEquals(body.includes(identifier), false);
  }
}

Deno.test(
  "durable artifact reads enforce signed-session tenant boundaries",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-security");
    try {
      const clients = await createDurableArtifactClients(stack);
      const bytes = new TextEncoder().encode("security-boundary-artifact");
      const effectKey = `durable-core-security-${crypto.randomUUID()}`;
      const ref = await publishArtifact(clients.producer, bytes, effectKey);

      const ownMetadata = await fetchArtifactMetadata(clients.consumer, ref);
      assertEquals(ownMetadata.status, 200);
      const ownContent = await fetchArtifact(clients.consumer, ref);
      assertEquals(ownContent.status, 200);
      assertEquals(
        Array.from(new Uint8Array(await ownContent.arrayBuffer())),
        Array.from(bytes),
      );

      const before = await stack.psql<{
        artifactId: string;
        currentVersionId: string;
        artifactVersion: number;
        artifactRevision: number;
        versionCount: number;
        replayCount: number;
        eventCount: number;
      }>(
        `select
           a.id as "artifactId",
           a.current_version_id as "currentVersionId",
           a.version as "artifactVersion",
           a.revision as "artifactRevision",
           (select count(*)::int from bakery.artifact_versions v
             where v.organization_id = a.organization_id
               and v.artifact_id = a.id) as "versionCount",
           (select count(*)::int from bakery.artifact_publication_replays r
             where r.organization_id = a.organization_id
               and r.attempt_id = $2
               and r.idempotency_key = $3) as "replayCount",
           (select count(*)::int from bakery.domain_events e
             where e.organization_id = a.organization_id
               and e.aggregate_id = a.id
               and e.event_type = 'artifact.version_created') as "eventCount"
         from bakery.artifacts a
        where a.organization_id = $1 and a.id = $4`,
        [
          clients.producer.organizationId,
          clients.producer.producer!.assignment.attemptId,
          effectKey,
          ref.artifactId,
        ],
      );
      assertEquals(before.length, 1);
      assertEquals(before[0]?.currentVersionId, ref.versionId);
      assertEquals(before[0]?.versionCount, 1);
      assertEquals(before[0]?.replayCount, 1);
      assertEquals(before[0]?.eventCount, 1);

      const foreignMetadata = await fetchArtifactMetadata(clients.foreign, ref);
      const foreignMetadataEvidence = await problemEvidence(foreignMetadata);
      const foreignMetadataBody = foreignMetadataEvidence.raw;
      assertEquals(foreignMetadata.status, 404);
      assertEquals(foreignMetadataEvidence.code, "RESOURCE_NOT_FOUND");
      assertNoIdentifierLeak(foreignMetadataBody, [
        ref.artifactId,
        ref.versionId,
      ]);

      const foreignVersions = await fetchArtifactVersionMetadata(
        clients.foreign,
        ref,
      );
      const foreignVersionsEvidence = await problemEvidence(foreignVersions);
      const foreignVersionsBody = foreignVersionsEvidence.raw;
      assertEquals(foreignVersions.status, 404);
      assertEquals(foreignVersionsEvidence.code, "RESOURCE_NOT_FOUND");
      assertNoIdentifierLeak(foreignVersionsBody, [
        ref.artifactId,
        ref.versionId,
      ]);

      const foreignContent = await fetchArtifact(clients.foreign, ref);
      const foreignContentEvidence = await problemEvidence(foreignContent);
      const foreignContentBody = foreignContentEvidence.raw;
      assertEquals(foreignContent.status, 404);
      assertEquals(foreignContentEvidence.code, "RESOURCE_NOT_FOUND");
      assertNoIdentifierLeak(foreignContentBody, [
        ref.artifactId,
        ref.versionId,
        "security-boundary-artifact",
      ]);

      const anonymousMetadata = await fetchArtifactMetadata(
        clients.anonymous,
        ref,
      );
      const anonymousMetadataEvidence = await problemEvidence(
        anonymousMetadata,
      );
      const anonymousMetadataBody = anonymousMetadataEvidence.raw;
      assertEquals(anonymousMetadata.status, 401);
      assertEquals(anonymousMetadataEvidence.code, "AUTH_REQUIRED");
      assertNoIdentifierLeak(anonymousMetadataBody, [ref.artifactId]);

      const anonymousContent = await fetchArtifact(clients.anonymous, ref);
      const anonymousContentEvidence = await problemEvidence(
        anonymousContent,
      );
      const anonymousContentBody = anonymousContentEvidence.raw;
      assertEquals(anonymousContent.status, 401);
      assertEquals(anonymousContentEvidence.code, "AUTH_REQUIRED");
      assertNoIdentifierLeak(anonymousContentBody, [
        ref.versionId,
        "security-boundary-artifact",
      ]);

      const foreignRun = await fetchRunSteps(
        clients.foreign,
        clients.job.runId,
      );
      const foreignRunEvidence = await problemEvidence(foreignRun);
      assertEquals(foreignRun.status, 404);
      assertEquals(foreignRunEvidence.code, "RESOURCE_NOT_FOUND");
      assertNoIdentifierLeak(foreignRunEvidence.raw, [
        clients.job.runId,
        clients.job.taskId,
      ]);

      const foreignProgress = await fetchTaskSync(
        clients.foreign,
        clients.job.taskId,
      );
      const foreignProgressEvidence = await problemEvidence(foreignProgress);
      assertEquals(foreignProgress.status, 404);
      assertEquals(foreignProgressEvidence.code, "RESOURCE_NOT_FOUND");
      assertNoIdentifierLeak(foreignProgressEvidence.raw, [
        clients.job.taskId,
        clients.job.runId,
      ]);

      const after = await stack.psql<{
        artifactId: string;
        currentVersionId: string;
        artifactVersion: number;
        artifactRevision: number;
        versionCount: number;
        replayCount: number;
        eventCount: number;
      }>(
        `select
           a.id as "artifactId",
           a.current_version_id as "currentVersionId",
           a.version as "artifactVersion",
           a.revision as "artifactRevision",
           (select count(*)::int from bakery.artifact_versions v
             where v.organization_id = a.organization_id
               and v.artifact_id = a.id) as "versionCount",
           (select count(*)::int from bakery.artifact_publication_replays r
             where r.organization_id = a.organization_id
               and r.attempt_id = $2
               and r.idempotency_key = $3) as "replayCount",
           (select count(*)::int from bakery.domain_events e
             where e.organization_id = a.organization_id
               and e.aggregate_id = a.id
               and e.event_type = 'artifact.version_created') as "eventCount"
         from bakery.artifacts a
        where a.organization_id = $1 and a.id = $4`,
        [
          clients.producer.organizationId,
          clients.producer.producer!.assignment.attemptId,
          effectKey,
          ref.artifactId,
        ],
      );
      assertEquals(after, before);

      const cancelResponse = await stack.fetch(
        new Request(`${stack.origin}/v1/runs/${clients.job.runId}/controls`, {
          method: "POST",
          headers: {
            cookie: clients.consumer.cookie!,
            origin: stack.origin,
            "Bakery-Organization-Id": clients.consumer.organizationId!,
            "content-type": "application/json",
            "Idempotency-Key":
              `durable-core-security-cancel-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ action: "cancel" }),
        }),
      );
      assertEquals(
        cancelResponse.status,
        201,
        await cancelResponse.clone().text(),
      );

      type CancellationState = {
        readonly jobStatus: string;
        readonly attemptStatus: string;
        readonly runStatus: string;
        readonly attemptEventCount: number;
      };
      const cancellationStateQuery = `
        select job.status as "jobStatus",
               attempt.status as "attemptStatus",
               run.status as "runStatus",
               (select count(*)::int
                  from bakery.attempt_events event
                 where event.organization_id = job.organization_id
                   and event.attempt_id = attempt.id) as "attemptEventCount"
          from bakery.jobs job
          join bakery.job_attempts attempt
            on attempt.organization_id = job.organization_id
           and attempt.job_id = job.id
          join bakery.run_steps step
            on step.organization_id = job.organization_id
           and step.id = job.run_step_id
          join bakery.workflow_runs run
            on run.organization_id = step.organization_id
           and run.id = step.run_id
         where job.organization_id = $1
           and job.id = $2
           and attempt.id = $3`;
      const cancellationBefore = await stack.psql<CancellationState>(
        cancellationStateQuery,
        [
          clients.producer.organizationId,
          clients.job.jobId,
          clients.producer.producer!.assignment.attemptId,
        ],
      );
      assertEquals(cancellationBefore, [{
        jobStatus: "canceled",
        attemptStatus: "canceled",
        runStatus: "canceled",
        attemptEventCount: 0,
      }]);

      const canceledSuccess = await postWorkerResult(
        clients.producer,
        {
          localSeq: "1",
          status: "completed",
          result: {
            headSha: "durable-core-canceled-head",
            baseSha: "durable-core-canceled-base",
            sessionId: clients.job.sessionId,
            artifacts: [],
          },
        },
        crypto.randomUUID(),
      );
      const canceledSuccessEvidence = await problemEvidence(canceledSuccess);
      assertEquals(canceledSuccess.status, 409);
      assertEquals(canceledSuccessEvidence.code, "ALREADY_TERMINAL");
      assertNoIdentifierLeak(canceledSuccessEvidence.raw, [
        clients.job.runId,
        clients.job.taskId,
        clients.job.jobId,
        clients.producer.producer!.assignment.attemptId,
        ref.artifactId,
        ref.versionId,
      ]);
      const cancellationAfter = await stack.psql<CancellationState>(
        cancellationStateQuery,
        [
          clients.producer.organizationId,
          clients.job.jobId,
          clients.producer.producer!.assignment.attemptId,
        ],
      );
      assertEquals(cancellationAfter, cancellationBefore);
      const preAuditDeniedEvidence = [
        foreignRunEvidence,
        foreignProgressEvidence,
        foreignContentEvidence,
        anonymousContentEvidence,
      ];
      const preAuditDeniedRows = await stack.psql<{
        id: string;
        requestId: string;
        traceId: string;
      }>(
        `select audit.id,
                audit.request_id as "requestId",
                audit.trace_id as "traceId"
           from bakery.audit_events audit
          where exists (
              select 1
                from unnest($1::text[], $2::text[]) as denied(request_id, trace_id)
               where denied.request_id = audit.request_id
                 and denied.trace_id = audit.trace_id
            )`,
        [
          preAuditDeniedEvidence.map((evidence) => evidence.requestId),
          preAuditDeniedEvidence.map((evidence) => evidence.traceId),
        ],
      );
      // Foreign and anonymous denials are pre-audit paths; query every
      // organization so a row under the actual requester cannot be hidden.
      assertEquals(preAuditDeniedRows, []);

      const canceledSuccessAuditRows = await stack.psql<{
        id: string;
        organizationId: string;
        resourceType: string;
        resourceId: string;
        operation: string;
        outcome: string;
        requestId: string;
        traceId: string;
        requestedStatus: string;
        observedStatus: string;
        code: string;
        httpStatus: number;
      }>(
        `select audit.id,
                audit.organization_id as "organizationId",
                audit.resource_type as "resourceType",
                audit.resource_id as "resourceId",
                audit.operation,
                audit.outcome,
                audit.request_id as "requestId",
                audit.trace_id as "traceId",
                audit.details->>'requested' as "requestedStatus",
                audit.details->>'observed' as "observedStatus",
                audit.details->>'code' as code,
                (audit.details->>'httpStatus')::int as "httpStatus"
           from bakery.audit_events audit
          where audit.organization_id = $1
            and audit.request_id = $2
            and audit.trace_id = $3
            and audit.operation = 'workers.result'
            and audit.resource_type = 'job_attempt'
            and audit.resource_id = $4`,
        [
          clients.producer.organizationId,
          canceledSuccessEvidence.requestId,
          canceledSuccessEvidence.traceId,
          clients.producer.producer!.assignment.attemptId,
        ],
      );
      assertEquals(canceledSuccessAuditRows.length, 1);
      const canceledSuccessAudit = canceledSuccessAuditRows[0];
      if (!canceledSuccessAudit) {
        throw new Error("CANCELED_SUCCESS_AUDIT_ROW_MISSING");
      }
      assertEquals(
        {
          organizationId: canceledSuccessAudit.organizationId,
          resourceType: canceledSuccessAudit.resourceType,
          resourceId: canceledSuccessAudit.resourceId,
          operation: canceledSuccessAudit.operation,
          outcome: canceledSuccessAudit.outcome,
          requestId: canceledSuccessAudit.requestId,
          traceId: canceledSuccessAudit.traceId,
          requestedStatus: canceledSuccessAudit.requestedStatus,
          observedStatus: canceledSuccessAudit.observedStatus,
          code: canceledSuccessAudit.code,
          httpStatus: canceledSuccessAudit.httpStatus,
        },
        {
          organizationId: clients.producer.organizationId,
          resourceType: "job_attempt",
          resourceId: clients.producer.producer!.assignment.attemptId,
          operation: "workers.result",
          outcome: "denied",
          requestId: canceledSuccessEvidence.requestId,
          traceId: canceledSuccessEvidence.traceId,
          requestedStatus: "completed",
          observedStatus: "canceled",
          code: "ALREADY_TERMINAL",
          httpStatus: 409,
        },
      );
      const canceledSuccessAuditRef = {
        id: canceledSuccessAudit.id,
        organizationId: canceledSuccessAudit.organizationId,
        resourceType: canceledSuccessAudit.resourceType,
        resourceId: canceledSuccessAudit.resourceId,
        operation: canceledSuccessAudit.operation,
        outcome: canceledSuccessAudit.outcome,
        requestId: canceledSuccessAudit.requestId,
        traceId: canceledSuccessAudit.traceId,
      };

      const cases = [
        createDurableCoreCase({
          name: "foreign-run-reference",
          outcome: "passed",
          requestId: foreignRunEvidence.requestId,
          traceId: foreignRunEvidence.traceId,
          auditRefs: [],
          auditReason: PRE_AUDIT_DENIAL_REASONS.foreignRun,
        }),
        createDurableCoreCase({
          name: "foreign-progress-reference",
          outcome: "passed",
          requestId: foreignProgressEvidence.requestId,
          traceId: foreignProgressEvidence.traceId,
          auditRefs: [],
          auditReason: PRE_AUDIT_DENIAL_REASONS.foreignProgress,
        }),
        createDurableCoreCase({
          name: "foreign-artifact-reference",
          outcome: "passed",
          requestId: foreignContentEvidence.requestId,
          traceId: foreignContentEvidence.traceId,
          auditRefs: [],
          auditReason: PRE_AUDIT_DENIAL_REASONS.foreignArtifact,
        }),
        createDurableCoreCase({
          name: "anonymous-artifact-reference",
          outcome: "passed",
          requestId: anonymousContentEvidence.requestId,
          traceId: anonymousContentEvidence.traceId,
          auditRefs: [],
          auditReason: PRE_AUDIT_DENIAL_REASONS.anonymousArtifact,
        }),
        createDurableCoreCase({
          name: "canceled-success-mutation",
          outcome: "passed",
          requestId: canceledSuccessEvidence.requestId,
          traceId: canceledSuccessEvidence.traceId,
          auditRefs: [canceledSuccessAuditRef],
        }),
      ] as const;
      await assertDurableCoreAuditLinks(stack.psql, cases, {
        "canceled-success-mutation": {
          organizationId: clients.identity.organizationId,
          resourceType: "job_attempt",
          resourceId: clients.producer.producer!.assignment.attemptId,
          operation: "workers.result",
          outcome: "denied",
        },
      });
      for (const durableCase of cases) {
        console.log(`DURABLE_CORE_CASE ${JSON.stringify(durableCase)}`);
      }

      const audit = await stack.psql<{
        id: string;
        organizationId: string;
        aggregateId: string;
        eventType: string;
      }>(
        `select id,
                organization_id as "organizationId",
                aggregate_id as "aggregateId",
                event_type as "eventType"
           from bakery.domain_events
          where organization_id = $1
            and aggregate_id = $2
            and event_type = 'artifact.version_created'`,
        [clients.producer.organizationId, ref.artifactId],
      );
      assertEquals(audit.length, 1);
      assertEquals(audit[0]?.organizationId, clients.producer.organizationId);
      assertEquals(audit[0]?.aggregateId, ref.artifactId);
      assertEquals(audit[0]?.eventType, "artifact.version_created");
    } finally {
      await stack.down();
    }
  },
);
