import { z } from "zod";
import {
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { effectivePermissions } from "../auth/application/authorize.ts";
import {
  hasLivePowerGrant,
  RUN_POWER_ACTIONS,
} from "../auth/application/run-grants.ts";
import { decideApproval } from "../conversation/approvals.ts";
import { findSlackIdentityLink } from "../integrations/slack-identity-links.ts";
import { internalContext } from "../workflows/automations/start.ts";
import {
  REQUEST_SLACK_APPROVE_ACTION,
  REQUEST_SLACK_REJECT_ACTION,
  type RequestSlackDependencies,
  rewriteClosedRequestSlackMessages,
  sendRequestSlackEphemeral,
  type SlackBlock,
} from "./request-slack.ts";

export const SLACK_PRESS_NOT_LINKED =
  "Nothing was decided. Your Slack account is not linked to a Bakery account, so Bakery cannot tell who is deciding. Link your account, then press the button again.";
export const SLACK_PRESS_NO_PERMISSION =
  "Nothing was decided. You do not have permission to approve or reject this work.";
export const SLACK_PRESS_NOT_RECORDED =
  "Your decision was not recorded. Try again.";
const DECIDE_PERMISSION = "approval:decide";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const slackId = (what: string) =>
  z.string().regex(/^[A-Z0-9]{2,32}$/).describe(what);

const pressedAction = z.object({
  action_id: z.string().max(64).describe(
    "The name of the button that was pressed.",
  ),
  value: z.string().max(200).optional().describe(
    "What the button carries; absent on link buttons.",
  ),
  action_ts: z.string().regex(/^[0-9]+\.[0-9]+$/).describe(
    "When Slack recorded the press.",
  ),
}).describe("One pressed Block Kit element.");

export const SlackBlockActionsSchema = z.object({
  type: z.literal("block_actions").describe(
    "Slack's name for a press on a message button.",
  ),
  api_app_id: slackId("The Slack app the press was sent to."),
  team: z.object({
    id: slackId("The Slack workspace the press came from."),
  }).describe("The workspace the press came from."),
  user: z.object({
    id: slackId("The Slack user who pressed the button."),
  }).describe("The person who pressed the button."),
  channel: z.object({
    id: slackId("The conversation the message is in."),
  }).describe("The conversation the pressed message is in."),
  container: z.object({
    message_ts: z.string().regex(/^[0-9]+\.[0-9]+$/).describe(
      "The timestamp of the pressed message.",
    ),
  }).describe("The message that holds the button."),
  actions: z.array(pressedAction).min(1).max(5).describe(
    "The elements pressed; Slack sends one per press.",
  ),
}).describe("The part of a Slack block_actions payload Bakery reads.");

export type SlackPressDecision = "approve" | "reject";

export type SlackPress = Readonly<{
  appId: string;
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  actionTs: string;
  decision: SlackPressDecision;
  requestId: string;
}>;

export type SlackPressReading =
  | Readonly<{ kind: "press"; press: SlackPress }>
  | Readonly<{ kind: "ignored" }>;

const DECISION_OF: Readonly<Record<string, SlackPressDecision>> = {
  [REQUEST_SLACK_APPROVE_ACTION]: "approve",
  [REQUEST_SLACK_REJECT_ACTION]: "reject",
};

export function readSlackInteractionPayload(
  raw: Uint8Array<ArrayBuffer>,
): Record<string, unknown> | null {
  const text = new TextDecoder().decode(raw);
  const payload = new URLSearchParams(text).get("payload");
  if (payload === null) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function readSlackPress(payload: unknown): SlackPressReading {
  const parsed = SlackBlockActionsSchema.safeParse(payload);
  if (!parsed.success) return { kind: "ignored" };
  const action = parsed.data.actions[0]!;
  const decision = DECISION_OF[action.action_id];
  if (decision === undefined || action.value === undefined) {
    return { kind: "ignored" };
  }
  return {
    kind: "press",
    press: {
      appId: parsed.data.api_app_id,
      teamId: parsed.data.team.id,
      userId: parsed.data.user.id,
      channelId: parsed.data.channel.id,
      messageTs: parsed.data.container.message_ts,
      actionTs: action.action_ts,
      decision,
      requestId: action.value,
    },
  };
}

export type SlackPressOutcome =
  | Readonly<{ kind: "decided"; approvalId: string }>
  | Readonly<{ kind: "already_decided"; approvalId: string; name: string }>
  | Readonly<{ kind: "closed"; approvalId: string }>
  | Readonly<{ kind: "not_linked" }>
  | Readonly<{ kind: "no_permission" }>
  | Readonly<{ kind: "not_recorded" }>;

type Approval = {
  id: string;
  status: string;
  version: number;
  decided_by_name: string | null;
};

async function loadApproval(
  transaction: PgTransactionClient,
  organizationId: string,
  approvalId: string,
): Promise<Approval | undefined> {
  const found = await transaction.query<Approval>(
    `select question.id, question.status, question.version,
            decider.display_name as decided_by_name
       from bakery.questions question
       left join bakery.principals decider on decider.id = question.decided_by
      where question.organization_id = $1 and question.id = $2
        and question.subject_type = 'run_step'`,
    [organizationId, approvalId],
  );
  return found.rows[0];
}

function settledOutcome(approval: Approval): SlackPressOutcome {
  return approval.status === "answered"
    ? {
      kind: "already_decided",
      approvalId: approval.id,
      name: approval.decided_by_name ?? "Someone",
    }
    : { kind: "closed", approvalId: approval.id };
}

type Pressed =
  | Readonly<{ kind: "outcome"; outcome: SlackPressOutcome }>
  | Readonly<{ kind: "decide"; approvalId: string }>;

const DECIDE_POWER = RUN_POWER_ACTIONS["approvals.decide"]!.power;

async function mayDecideApproval(
  transaction: PgTransactionClient,
  organizationId: string,
  actor: Awaited<ReturnType<typeof resolveOrganizationActor>>,
  principalId: string,
  approvalId: string,
): Promise<boolean> {
  if (effectivePermissions(actor).includes(DECIDE_PERMISSION)) return true;
  return await hasLivePowerGrant(
    transaction,
    organizationId,
    principalId,
    DECIDE_POWER,
    { kind: "question", id: approvalId },
  );
}

async function checkPress(
  transaction: PgTransactionClient,
  organizationId: string,
  press: SlackPress,
): Promise<Pressed> {
  const done = (outcome: SlackPressOutcome): Pressed => ({
    kind: "outcome",
    outcome,
  });
  const link = await findSlackIdentityLink(transaction, {
    organizationId,
    appId: press.appId,
    teamId: press.teamId,
    userId: press.userId,
  });
  if (link === undefined || link.state !== "active" || !link.memberCurrent) {
    return done({ kind: "not_linked" });
  }
  if (!UUID.test(press.requestId)) return done({ kind: "no_permission" });
  const request = await transaction.query<{ target_id: string }>(
    `select target_id from bakery.person_requests
      where organization_id = $1 and id = $2 and intent = 'approve'
        and target_id is not null`,
    [organizationId, press.requestId],
  );
  const approvalId = request.rows[0]?.target_id;
  if (approvalId === undefined) return done({ kind: "no_permission" });
  const addressed = await transaction.query(
    `select 1 from bakery.person_requests
      where organization_id = $1 and target_id = $2 and intent = 'approve'
        and recipient_id = $3
      limit 1`,
    [organizationId, approvalId, link.principalId],
  );
  if (addressed.rows.length === 0) return done({ kind: "no_permission" });
  const approval = await loadApproval(transaction, organizationId, approvalId);
  if (approval === undefined) return done({ kind: "no_permission" });
  if (approval.status !== "open") return done(settledOutcome(approval));
  let actor;
  try {
    actor = await resolveOrganizationActor(
      transaction,
      toPrincipalId(link.principalId),
      toOrganizationId(organizationId),
    );
  } catch (error) {
    if (error instanceof StandardError) return done({ kind: "no_permission" });
    throw error;
  }
  if (
    actor.subject.principalType !== "human" ||
    !(await mayDecideApproval(
      transaction,
      organizationId,
      actor,
      link.principalId,
      approvalId,
    ))
  ) return done({ kind: "no_permission" });
  await decideApproval(
    internalContext(
      transaction,
      actor,
      { requestId: crypto.randomUUID(), traceId: crypto.randomUUID() },
      { id: approvalId },
    ),
    { decision: press.decision, expectedVersion: approval.version },
  );
  return { kind: "decide", approvalId };
}

export async function decideSlackPress(
  database: PgDatabase,
  organizationId: string,
  press: SlackPress,
): Promise<SlackPressOutcome> {
  try {
    const pressed = await withPgTransaction(
      database,
      (transaction) => checkPress(transaction, organizationId, press),
    );
    return pressed.kind === "outcome"
      ? pressed.outcome
      : { kind: "decided", approvalId: pressed.approvalId };
  } catch (error) {
    if (!(error instanceof StandardError)) return { kind: "not_recorded" };
    if (error.code === "RESOURCE_NOT_FOUND") return { kind: "no_permission" };
    if (error.code !== "STATE_CONFLICT") return { kind: "not_recorded" };
    const approvalId = await withPgTransaction(
      database,
      async (transaction) =>
        (await transaction.query<{ target_id: string }>(
          `select target_id from bakery.person_requests
          where organization_id = $1 and id = $2`,
          [organizationId, press.requestId],
        )).rows[0]?.target_id,
    );
    if (approvalId === undefined) return { kind: "not_recorded" };
    const approval = await withPgTransaction(
      database,
      (transaction) => loadApproval(transaction, organizationId, approvalId),
    );
    return approval === undefined || approval.status === "open"
      ? { kind: "not_recorded" }
      : settledOutcome(approval);
  }
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

export function slackAlreadyDecided(name: string): string {
  return `Nothing changed. ${escapeSlack(name)} already decided this.`;
}

export type SlackPressReply = Readonly<{
  text: string;
  blocks?: readonly SlackBlock[];
}>;

export function slackPressReply(
  outcome: SlackPressOutcome,
): SlackPressReply | null {
  switch (outcome.kind) {
    case "decided":
    case "closed":
      return null;
    case "already_decided":
      return { text: slackAlreadyDecided(outcome.name) };
    case "no_permission":
      return { text: SLACK_PRESS_NO_PERMISSION };
    case "not_recorded":
      return { text: SLACK_PRESS_NOT_RECORDED };
    case "not_linked":
      return { text: SLACK_PRESS_NOT_LINKED };
  }
}

export async function answerSlackPress(
  options: RequestSlackDependencies & { database: PgDatabase },
  organizationId: string,
  press: SlackPress,
  outcome: SlackPressOutcome,
): Promise<void> {
  if ("approvalId" in outcome) {
    await rewriteClosedRequestSlackMessages({
      ...options,
      targetId: outcome.approvalId,
    });
  }
  const reply = slackPressReply(outcome);
  if (reply === null) return;
  await sendRequestSlackEphemeral(options, {
    organizationId,
    teamId: press.teamId,
    channelId: press.channelId,
    userId: press.userId,
    text: reply.text,
    ...(reply.blocks === undefined ? {} : { blocks: reply.blocks }),
    idempotencyKey:
      `slack-press:${press.appId}:${press.teamId}:${press.userId}:${press.actionTs}`,
  });
}
