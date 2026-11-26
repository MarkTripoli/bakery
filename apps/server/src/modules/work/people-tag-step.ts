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

const DEFAULT_ESCALATION_HOURS = 24;
const MAX_ESCALATION_HOURS = 72;

export const PEOPLE_TAG_PACING = Object.freeze({
  retryMs: 60_000,
  waitLimitMs: (REQUEST_LIFETIME_DAYS + 1) * 86_400_000 +
    MAX_ESCALATION_HOURS * 3_600_000,
});

type TagRow = Readonly<{
  recipient_id: string;
  status: string;
  expires_at: Date;
  created_at: Date;
}>;

type Escalation = Readonly<{
  afterHours?: number;
  recipientId?: string;
  recipientRoleKey?: string;
  recipientGroupId?: string;
  recipientRunRole?: "starter" | "task_owner";
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
    `select recipient_id, status, expires_at, created_at
       from bakery.person_requests
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

function recipientCount(escalation: Escalation): number {
  return [
    escalation.recipientId,
    escalation.recipientRoleKey,
    escalation.recipientGroupId,
    escalation.recipientRunRole,
  ].filter((recipient) => recipient !== undefined).length;
}

function reviewedArtifactVersion(
  request: EngineStepRequest,
): string | undefined {
  const input = request.input as { artifactVersionId?: unknown };
  return typeof input.artifactVersionId === "string"
    ? input.artifactVersionId
    : undefined;
}

export function escalationDue(
  tags: readonly TagRow[],
  escalation: Escalation,
  now: number,
): boolean {
  const firstAskedAt = Math.min(
    ...tags.map((tag) => tag.created_at.getTime()),
  );
  const afterMs = (escalation.afterHours ?? DEFAULT_ESCALATION_HOURS) *
    3_600_000;
  return now >= firstAskedAt + afterMs;
}

async function claimNextAsk(
  transaction: PgTransactionClient,
  request: EngineStepRequest,
): Promise<boolean> {
  const claimed = await transaction.query(
    `insert into bakery.person_request_next_asks
       (organization_id, run_id, step_key, step_iteration)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning 1`,
    [
      request.organizationId,
      request.runId,
      request.stepKey,
      request.iteration,
    ],
  );
  return claimed.rows.length === 1;
}

async function markOwnTagsExpired(
  database: PgDatabase,
  request: EngineStepRequest,
): Promise<void> {
  await withPgTransaction(database, (tx) =>
    tx.query(
      `update bakery.person_requests
          set status = 'expired', updated_at = now(), version = version + 1
        where organization_id = $1 and run_id = $2 and step_key = $3
          and step_iteration = $4 and status = 'open' and expires_at <= now()`,
      [
        request.organizationId,
        request.runId,
        request.stepKey,
        request.iteration,
      ],
    ));
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
    const escalation: Escalation | undefined = input.ifNobodyAnswers;
    if (escalation !== undefined && input.wait !== true) {
      return failed(
        "TAG_INPUT_INVALID",
        "Asking someone next needs wait: a step that carries on waits for nobody.",
      );
    }
    if (escalation !== undefined && recipientCount(escalation) !== 1) {
      return failed(
        "TAG_INPUT_INVALID",
        "Name exactly one person to ask next.",
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
    if (!open) {
      await markOwnTagsExpired(deps.database, request);
      return completed({ outcome: "expired", asked });
    }
    if (escalation !== undefined && escalationDue(tags, escalation, now)) {
      const asked = await askNext(request, escalation, trace);
      if (asked !== null) return asked;
    }
    return { kind: "pending" };
  }

  async function askNext(
    request: EngineStepRequest,
    escalation: Escalation,
    trace: Readonly<{ requestId: string; traceId: string }>,
  ): Promise<EngineStepResult | null> {
    try {
      const outcome = await withPgTransaction(deps.database, async (tx) => {
        const tags = await ownTags(tx, request);
        if (!escalationDue(tags, escalation, Date.now())) return null;
        if (!await claimNextAsk(tx, request)) return null;
        const reviewedVersion = reviewedArtifactVersion(request);
        const actor = await liveActor(
          tx,
          request.organizationId,
          request.requestedBy,
        );
        if (actor === null) return "actor_unavailable" as const;
        const recipientId = escalation.recipientRunRole === undefined
          ? escalation.recipientId
          : await runRolePerson(tx, request, escalation.recipientRunRole);
        if (recipientId === null) return "recipient_unknown" as const;
        if (
          recipientId !== undefined &&
          tags.some((tag) => tag.recipient_id === recipientId)
        ) return null;
        await askFromWorkflowStep(
          internalContext(tx, actor, trace, { id: request.runId }, {
            operation: "runRequests.create",
            idempotencyKey:
              `tag-next:${request.runId}:${request.stepKey}:${request.iteration}`,
            target: `/v1/runs/${request.runId}/requests`,
          }),
          {
            stepKey: request.stepKey,
            iteration: request.iteration,
            intent: "review",
            ...(recipientId === undefined ? {} : { recipientId }),
            ...(escalation.recipientRoleKey === undefined
              ? {}
              : { recipientRoleKey: escalation.recipientRoleKey }),
            ...(escalation.recipientGroupId === undefined
              ? {}
              : { recipientGroupId: escalation.recipientGroupId }),
            ...(reviewedVersion === undefined
              ? {}
              : { artifactVersionId: reviewedVersion }),
          },
        );
        return null;
      });
      if (outcome === "actor_unavailable") {
        return failed(
          "TAG_ACTOR_UNAVAILABLE",
          "The person who started the run can no longer write runs, so nobody was asked next.",
        );
      }
      if (outcome === "recipient_unknown") {
        return failed(
          "TAG_RECIPIENT_UNKNOWN",
          "The run names nobody in that role, so nobody was asked next.",
        );
      }
      return null;
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      return failed(
        "TAG_REFUSED",
        `Nobody was asked next: ${refusalReason(error)}.`,
      );
    }
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
