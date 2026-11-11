import { z } from "zod";

const payloadUuid = (description: string) =>
  z.string().uuid().describe(description);
const resourceVersion = z.number().int().positive().describe(
  "Positive aggregate version consumers must re-read from authoritative state.",
);

export const INNGEST_EVENT_DEFINITIONS = {
  "conversation.turn_changed": {
    schemaVersion: 1,
    name: "bakery/conversation.turn_changed.v1",
    payload: z.object({
      resourceId: payloadUuid(
        "UUID of the changed conversation turn resource.",
      ),
      resourceVersion,
      conversationId: payloadUuid("UUID of the conversation owning the turn."),
      triggerMessageId: payloadUuid(
        "UUID of the message that triggered the turn.",
      ),
      status: z.enum([
        "queued",
        "active",
        "cancel_requested",
        "completed",
        "failed",
        "canceled",
      ]).describe(
        "Persisted lifecycle status reached by the conversation turn.",
      ),
    }).strict().describe("Version 1 conversation turn invalidation payload."),
  },
  "deployment.queued": {
    schemaVersion: 1,
    name: "bakery/deployment.queued.v1",
    payload: z.object({
      deploymentId: payloadUuid("UUID of the queued deployment."),
    }).strict().describe("Version 1 queued deployment payload."),
  },
  "deployment.rollback_requested": {
    schemaVersion: 1,
    name: "bakery/deployment.rollback_requested.v1",
    payload: z.object({
      deploymentId: payloadUuid(
        "UUID of the deployment requested for rollback.",
      ),
    }).strict().describe("Version 1 deployment rollback request payload."),
  },
  "evaluation.requested": {
    schemaVersion: 1,
    name: "bakery/evaluation.requested.v1",
    payload: z.object({
      evaluationRunId: payloadUuid("UUID of the requested evaluation run."),
    }).strict().describe("Version 1 evaluation request payload."),
  },
  "intake.received": {
    schemaVersion: 1,
    name: "bakery/intake.received.v1",
    payload: z.object({
      inboundEventId: payloadUuid("UUID of the persisted inbound event."),
    }).strict().describe("Version 1 intake receipt payload."),
  },
  "integration.action_requested": {
    schemaVersion: 1,
    name: "bakery/integration.action.requested.v1",
    payload: z.object({
      effectId: payloadUuid("UUID of the requested external effect."),
      resourceVersion,
    }).strict().describe("Version 1 integration action request payload."),
  },
  "integration.discovery_requested": {
    schemaVersion: 1,
    name: "bakery/integration.discovery.requested.v1",
    payload: z.object({
      resourceId: payloadUuid("UUID of the requested integration discovery."),
      resourceVersion,
    }).strict().describe("Version 1 integration discovery request payload."),
  },
  "job.completed": {
    schemaVersion: 1,
    name: "bakery/job.completed.v1",
    payload: z.object({
      runId: payloadUuid("UUID of the run owning the completed job."),
      stepId: payloadUuid("UUID of the run step owning the completed job."),
      jobId: payloadUuid("UUID of the completed job."),
      attemptId: payloadUuid("UUID of the terminal job attempt."),
      status: z.enum(["completed", "failed", "canceled"]).describe(
        "Terminal outcome reported for the job attempt.",
      ),
    }).strict().describe("Version 1 completed job payload."),
  },
  "merge.queued": {
    schemaVersion: 1,
    name: "bakery/merge.queued.v1",
    payload: z.object({
      mergeEntryId: payloadUuid("UUID of the queued merge entry."),
    }).strict().describe("Version 1 queued merge payload."),
  },
  "question.answered": {
    schemaVersion: 1,
    name: "bakery/question.answered.v1",
    payload: z.object({
      questionId: payloadUuid("UUID of the answered question."),
      runId: payloadUuid("UUID of the run waiting for the answer.").nullable(),
    }).strict().describe("Version 1 answered question payload."),
  },
  "run.control_requested": {
    schemaVersion: 1,
    name: "bakery/run.control_requested.v1",
    payload: z.object({
      runId: payloadUuid("UUID of the run receiving the control request."),
      action: z.enum(["pause", "resume", "cancel", "interrupt"]).describe(
        "Requested control transition for the run.",
      ),
    }).strict().describe("Version 1 run control request payload."),
  },
  "run.requested": {
    schemaVersion: 1,
    name: "bakery/run.requested.v1",
    payload: z.object({
      runId: payloadUuid("UUID of the run requested for execution."),
    }).strict().describe("Version 1 run request payload."),
  },
  "skill.import.requested": {
    schemaVersion: 1,
    name: "bakery/skill.import.requested.v1",
    payload: z.object({
      runId: payloadUuid("UUID of the requested pinned skill import run."),
    }).strict().describe("Version 1 pinned skill import request payload."),
  },
  "tasks.created": {
    schemaVersion: 1,
    name: "bakery/tasks.created.v1",
    payload: z.object({
      resourceId: payloadUuid("UUID of the created task."),
      resourceVersion,
    }).strict().describe("Version 1 created task invalidation payload."),
  },
  "tasks.updated": {
    schemaVersion: 1,
    name: "bakery/tasks.updated.v1",
    payload: z.object({
      resourceId: payloadUuid("UUID of the updated task."),
      resourceVersion,
    }).strict().describe("Version 1 updated task invalidation payload."),
  },
} as const;

export type InngestDomainEventType = keyof typeof INNGEST_EVENT_DEFINITIONS;
export type InngestEventName =
  (typeof INNGEST_EVENT_DEFINITIONS)[InngestDomainEventType]["name"];

export function isInngestDomainEventType(
  value: string,
): value is InngestDomainEventType {
  return Object.hasOwn(INNGEST_EVENT_DEFINITIONS, value);
}

export function inngestEventDefinition(
  domainEventType: string,
  schemaVersion: number,
) {
  if (!isInngestDomainEventType(domainEventType)) return null;
  const definition = INNGEST_EVENT_DEFINITIONS[domainEventType];
  return definition.schemaVersion === schemaVersion ? definition : null;
}

export function inngestEventName(
  domainEventType: string,
  schemaVersion: number,
): InngestEventName | null {
  return inngestEventDefinition(domainEventType, schemaVersion)?.name ?? null;
}
