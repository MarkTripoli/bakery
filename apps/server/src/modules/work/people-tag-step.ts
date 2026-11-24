import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { internalContext, liveActor } from "../workflows/automations/start.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../workflow-adapter/engine-steps.ts";
import { askFromWorkflowStep, REQUEST_LIFETIME_DAYS } from "./run-requests.ts";

export const PEOPLE_TAG_ACTION = "people.tag";

export const PEOPLE_TAG_PACING = Object.freeze({
  retryMs: 60_000,
  waitLimitMs: (REQUEST_LIFETIME_DAYS + 1) * 86_400_000,
});

type TagRow = Readonly<{
  recipient_id: string;
  status: string;
  expires_at: Date;
}>;

function peopleTagOutput(): { parse(value: unknown): unknown } {
  const found = (contractSchemas as unknown as Record<
    string,
    { parse(value: unknown): unknown } | undefined
  >).PeopleTagOutput;
  if (found === undefined) throw new StandardError({ code: "INTERNAL" });
  return found;
}

function failed(code: string, message: string): EngineStepResult {
  return { kind: "failed", code, message };
}

function completed(value: Record<string, unknown>): EngineStepResult {
  return {
    kind: "completed",
    output: peopleTagOutput().parse(value),
  };
}

function refusalReason(error: StandardError): string {
  const issues = error.params?.issues;
  if (Array.isArray(issues)) {
    const code = (issues[0] as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  const reason = error.params?.reason;
  return typeof reason === "string" ? reason : error.code;
}

async function ownTags(
  transaction: PgTransactionClient,
  request: EngineStepRequest,
): Promise<readonly TagRow[]> {
  const found = await transaction.query<TagRow>(
    `select recipient_id, status, expires_at from bakery.person_requests
      where organization_id = $1 and run_id = $2 and step_key = $3
        and step_iteration = $4
      order by created_at, id`,
    [
      request.organizationId,
      request.runId,
      request.stepKey,
      request.iteration,
    ],
  );
  return found.rows;
}

async function runRolePerson(
  transaction: PgTransactionClient,
  request: EngineStepRequest,
  role: "starter" | "task_owner",
): Promise<string | null> {
  const found = await transaction.query<
    { requested_by: string | null; task_created_by: string | null }
  >(
    `select run.requested_by, task.created_by as task_created_by
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
      where run.organization_id = $1 and run.id = $2`,
    [request.organizationId, request.runId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return role === "starter" ? row.requested_by : row.task_created_by;
}

export function createPeopleTagStepRunner(
  deps: Readonly<{ database: PgDatabase }>,
): EngineStepRunner {
  async function run(request: EngineStepRequest): Promise<EngineStepResult> {
    const parsed = contractSchemas.PeopleTagInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "TAG_INPUT_INVALID",
        "The step input does not match the tag contract.",
      );
    }
    const input = parsed.data;
    const named = [
      input.recipientId,
      input.recipientRoleKey,
      input.recipientGroupId,
      input.recipientRunRole,
    ].filter((recipient) => recipient !== undefined).length;
    if (named !== 1) {
      return failed("TAG_INPUT_INVALID", "Name exactly one recipient.");
    }
    if (input.wait === true && input.intent !== "review") {
      return failed(
        "TAG_INPUT_INVALID",
        "Only a review can be waited for: an FYI asks for nothing back.",
      );
    }
    const trace = { requestId: crypto.randomUUID(), traceId: request.traceId };
    let tags:
      | readonly TagRow[]
      | "step_unknown"
      | "actor_unavailable"
      | "recipient_unknown";
    try {
      tags = await withPgTransaction(deps.database, async (tx) => {
        const step = await tx.query(
          `select 1 from bakery.run_steps
            where organization_id = $1 and run_id = $2 and step_key = $3
              and iteration = $4`,
          [
            request.organizationId,
            request.runId,
            request.stepKey,
            request.iteration,
          ],
        );
        if (step.rows.length === 0) return "step_unknown" as const;
        const existing = await ownTags(tx, request);
        if (existing.length > 0) return existing;
        const actor = await liveActor(
          tx,
          request.organizationId,
          request.requestedBy,
        );
        if (actor === null) return "actor_unavailable" as const;
        const recipientId = input.recipientRunRole === undefined
          ? input.recipientId
          : await runRolePerson(tx, request, input.recipientRunRole);
        if (recipientId === null) return "recipient_unknown" as const;
        await askFromWorkflowStep(
          internalContext(tx, actor, trace, { id: request.runId }, {
            operation: "runRequests.create",
            idempotencyKey:
              `tag:${request.runId}:${request.stepKey}:${request.iteration}`,
            target: `/v1/runs/${request.runId}/requests`,
          }),
          {
            stepKey: request.stepKey,
            iteration: request.iteration,
            intent: input.intent,
            ...(recipientId === undefined ? {} : { recipientId }),
            ...(input.recipientRoleKey === undefined
              ? {}
              : { recipientRoleKey: input.recipientRoleKey }),
            ...(input.recipientGroupId === undefined
              ? {}
              : { recipientGroupId: input.recipientGroupId }),
            ...(input.artifactVersionId === undefined
              ? {}
              : { artifactVersionId: input.artifactVersionId }),
            ...(input.note === undefined ? {} : { note: input.note }),
          },
        );
        return await ownTags(tx, request);
      });
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      return failed(
        "TAG_REFUSED",
        `Nobody was tagged: ${refusalReason(error)}.`,
      );
    }
    if (tags === "step_unknown") {
      return failed("TAG_STEP_UNKNOWN", "The run has no such step.");
    }
    if (tags === "actor_unavailable") {
      return failed(
        "TAG_ACTOR_UNAVAILABLE",
        "The person who started the run can no longer write runs, so nobody was tagged.",
      );
    }
    if (tags === "recipient_unknown") {
      return failed(
        "TAG_RECIPIENT_UNKNOWN",
        "The run names nobody in that role, so nobody was tagged.",
      );
    }
    if (tags.length === 0) {
      return failed("TAG_REFUSED", "Nobody was tagged.");
    }
    const asked = tags.length;
    if (input.wait !== true) return completed({ outcome: "sent", asked });
    const responded = tags.find((tag) =>
      tag.status === "answered" || tag.status === "handled"
    );
    if (responded !== undefined) {
      return completed({
        outcome: "responded",
        asked,
        respondedBy: responded.recipient_id,
      });
    }
    const now = Date.now();
    const open = tags.some((tag) =>
      tag.status === "open" && tag.expires_at.getTime() > now
    );
    if (!open) return completed({ outcome: "expired", asked });
    return { kind: "pending" };
  }

  return {
    handles: (action) => action === PEOPLE_TAG_ACTION,
    pacing: (action) =>
      action === PEOPLE_TAG_ACTION ? PEOPLE_TAG_PACING : undefined,
    run(request) {
      if (request.action !== PEOPLE_TAG_ACTION) {
        return Promise.resolve(
          failed("TAG_ACTION_UNKNOWN", "This runner does not own that action."),
        );
      }
      return run(request);
    },
  };
}
