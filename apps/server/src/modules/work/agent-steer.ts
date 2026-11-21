import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { AgentSpawnConfig } from "@bakery/config";
import type { PgTransactionClient } from "../../platform/database.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  AgentPower,
  attemptOrigin,
} from "../auth/application/agent-power-grants.ts";
import { spawnAuthority } from "./agent-spawn.ts";
import { REVIEW_ACTION } from "../knowledge/reviewer-isolation.ts";

/**
 * An agent steering another agent (chapter 25 section 9, issue #413, O19 as
 * replaced). It uses the operations a person uses, `sessions.steer` for a
 * running session and `runSteps.note` for a step that has not started, so there
 * is one delivery path and one record. What changes is who may steer and what
 * is checked first:
 *
 *   1. permission  the steer power, along the whole spawn chain (a child never
 *                  holds more than its parent),
 *   2. target      only a run the agent spawned, never its own (O51: nothing
 *                  for oneself), and never a reviewer step,
 *   3. count       how many steers the agent's run has already sent.
 *
 * Budget and depth do not apply: a steer is text and spends nothing, and the
 * target is already inside the agent's own tree. Permission comes first so a
 * caller who may not steer learns nothing about what exists or what the limits
 * are.
 */
export const SteerRefusal = Object.freeze(
  {
    RequiresGrant: "steer_requires_grant",
    OwnRun: "steer_own_run",
    ReviewerUnavailable: "steer_reviewer_unavailable",
    CountExceeded: "steer_count_exceeded",
  } as const,
);
export type SteerRefusal = typeof SteerRefusal[keyof typeof SteerRefusal];

export type SteerFacts = Readonly<{
  holdsPower: boolean;
  /** The target is the agent's own run. */
  targetIsOwnRun: boolean;
  /** The target is a strict descendant of the agent's run. */
  targetIsDescendant: boolean;
  /** The target step or session belongs to a reviewer. */
  targetIsReviewer: boolean;
  /** The agent's workflow also holds the steer_reviewer power. */
  holdsReviewerPower: boolean;
  /** Steers the agent's run has already sent. */
  steersSent: number;
  limits: AgentSpawnConfig;
}>;

/**
 * The decision, with no I/O. `null` means proceed; `"not_found"` is a target
 * outside the agent's tree, answered like a task that does not exist so nothing
 * leaks about other runs.
 */
export function decideSteer(
  facts: SteerFacts,
): SteerRefusal | "not_found" | null {
  if (!facts.holdsPower) return SteerRefusal.RequiresGrant;
  if (facts.targetIsOwnRun) return SteerRefusal.OwnRun;
  if (!facts.targetIsDescendant) return "not_found";
  // Messaging a reviewer is off by default (O18). It is granted separately, and
  // because a steered review is refused as not independent when it finalizes, an
  // agent cannot defeat the independent-review control by messaging first.
  if (facts.targetIsReviewer && !facts.holdsReviewerPower) {
    return SteerRefusal.ReviewerUnavailable;
  }
  if (facts.steersSent >= facts.limits.maxSteers) {
    return SteerRefusal.CountExceeded;
  }
  return null;
}

/** What an admitted agent steer needs afterwards, to record it. */
export type SteerAdmission = Readonly<{
  fromRunId: string;
  sessionId: string | null;
}>;

/** Whether a step of a run is a reviewer's: its job runs the review action. */
export async function stepIsReviewer(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  stepKey: string,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1
       from bakery.run_steps as step
       join bakery.jobs as job
         on job.organization_id = step.organization_id
        and job.run_step_id = step.id
      where step.organization_id = $1 and step.run_id = $2
        and step.step_key = $3 and job.action = $4
      limit 1`,
    [organizationId, runId, stepKey, REVIEW_ACTION],
  );
  return found.rows.length > 0;
}

/**
 * Admits an agent's steer of one run, or refuses it by name and writes nothing.
 * A person's steer returns null and is unchanged. The agent's run row is locked
 * first, so two steers cannot both take the last slot.
 */
export async function admitAgentSteer(
  transaction: PgTransactionClient,
  context: ActionContext,
  input: Readonly<{
    organizationId: string;
    principalId: string;
    targetRunId: string;
    /** The step the steer is for, when known, to recognise a reviewer's. */
    targetStepKey: string | null;
    limits: AgentSpawnConfig;
  }>,
): Promise<SteerAdmission | null> {
  if (attributeAction(context, input.principalId).actorKind === "person") {
    return null;
  }
  if (context.agentSession === undefined) {
    throw refusal(SteerRefusal.RequiresGrant);
  }
  const origin = await attemptOrigin(
    transaction,
    input.organizationId,
    context.agentSession.attemptId,
  );
  if (origin === null) throw refusal(SteerRefusal.RequiresGrant);

  await transaction.query(
    `select id from bakery.workflow_runs
      where organization_id = $1 and id = $2
      for update`,
    [input.organizationId, origin.runId],
  );
  const { holdsPower } = await spawnAuthority(
    transaction,
    input.organizationId,
    origin.runId,
    AgentPower.Steer,
  );

  // Whether the target sits below the agent's own run in the spawn tree.
  const below = await transaction.query(
    `with recursive up as (
       select id, spawned_by_run_id from bakery.workflow_runs
        where organization_id = $1 and id = $2
       union all
       select run.id, run.spawned_by_run_id
         from up
         join bakery.workflow_runs as run
           on run.organization_id = $1 and run.id = up.spawned_by_run_id
     )
     select 1 from up where id = $3 and id <> $2`,
    [input.organizationId, input.targetRunId, origin.runId],
  );

  const targetIsReviewer = input.targetStepKey !== null &&
    await stepIsReviewer(
      transaction,
      input.organizationId,
      input.targetRunId,
      input.targetStepKey,
    );
  const holdsReviewerPower = targetIsReviewer &&
    (await spawnAuthority(
      transaction,
      input.organizationId,
      origin.runId,
      AgentPower.SteerReviewer,
    )).holdsPower;

  const sent = await transaction.query<{ n: string }>(
    `select count(*)::text as n from bakery.decisions_ledger
      where organization_id = $1 and kind = 'steer'
        and detail ->> 'fromRunId' = $2::text`,
    [input.organizationId, origin.runId],
  );

  const refused = decideSteer({
    holdsPower,
    targetIsOwnRun: input.targetRunId === origin.runId,
    targetIsDescendant: below.rows.length > 0,
    targetIsReviewer,
    holdsReviewerPower,
    steersSent: Number(sent.rows[0]?.n ?? 0),
    limits: input.limits,
  });
  if (refused === "not_found") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (refused !== null) throw refusal(refused);
  return { fromRunId: origin.runId, sessionId: origin.agentSessionId };
}

/**
 * What a steer's ledger entry carries beyond its text, for a person's steer and
 * an agent's alike. The shape is the same; an agent's adds who it acted for, the
 * run it came from and its session (O50).
 */
export function steerRecordDetail(
  principalId: string,
  admission: SteerAdmission | null,
  steersReviewer = false,
): Record<string, string | boolean> {
  // The reviewer label is on every steer that reaches a reviewer, a person's or
  // an agent's: it is what marks the review steered.
  const label: Record<string, boolean> = steersReviewer
    ? { steersReviewer: true }
    : {};
  if (admission === null) return { actorKind: "person", ...label };
  return {
    actorKind: "agent",
    onBehalfOf: principalId,
    fromRunId: admission.fromRunId,
    ...(admission.sessionId === null ? {} : { sessionId: admission.sessionId }),
    ...label,
  };
}

function refusal(reason: SteerRefusal): StandardError {
  return new StandardError({
    code: reason === SteerRefusal.CountExceeded
      ? "STATE_CONFLICT"
      : "AUTH_FORBIDDEN",
    params: { reason },
  });
}
