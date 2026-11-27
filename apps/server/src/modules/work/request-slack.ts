import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import {
  type IntegrationInvokeResult,
  invokeIntegration,
} from "../catalog/integration-invoke.ts";
import { connectionInvokeDeps } from "../integrations/invoke.ts";
import { findActiveSlackLinkForPrincipal } from "../integrations/slack-identity-links.ts";
import { EMAIL_LINK_ORGANIZATION_PARAM, INTENT_VERB } from "./request-email.ts";

export const REQUEST_SLACK_FUNCTION_ID = "bakery-person-request-slack";
export const REQUEST_SLACK_MAX_ATTEMPTS = 3;
export const REQUEST_SLACK_RETRY_BASE_MINUTES = 10;
export const REQUEST_SLACK_TITLE_LIMIT = 120;
export const REQUEST_SLACK_LEASE_MINUTES = 10;
export const SLACK_DELIVERY_PURPOSE = "slack.delivery";
const REQUEST_SLACK_BATCH = 100;
const SLACK_CHANNEL = "slack";
const SLACK_PROVIDER = "slack";
const SLACK_WORKSPACE_KIND = "slack.workspace";
const DM_OPEN = { id: "slack.dm.open", version: 1 } as const;
const MESSAGE_POST = { id: "slack.message.post", version: 1 } as const;
const MESSAGE_UPDATE = { id: "slack.message.update", version: 1 } as const;
const UNCERTAIN_CODE = "uncertain";

export const SlackDeliveryState = {
  Sending: "sending",
  Delivered: "delivered",
  Retrying: "retrying",
  Failed: "failed",
  Rewriting: "rewriting",
  Rewritten: "rewritten",
  RewriteFailed: "rewrite_failed",
} as const;

export type RequestSlackDependencies = Readonly<{
  publicBaseUrl: string;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
}>;

export type RequestSlackOutcome = Readonly<{
  requestId: string;
  result: "delivered" | "retrying" | "failed" | "rewritten";
  code?: string;
}>;

export type RequestSlackFinalStatus =
  | "answered"
  | "handled"
  | "expired"
  | "withdrawn";

export type RequestSlackFacts = Readonly<{
  requestId: string;
  organizationId: string;
  taskId: string;
  intent: string;
  askerName: string | null;
  groupName: string | null;
  workItem: string;
}>;

export type RequestSlackClosing = Readonly<{
  status: RequestSlackFinalStatus;
  closedByName: string | null;
}>;

type Target = {
  connection_id: string;
  team_id: string;
  resource_id: string;
  principal_id: string;
};

type DueRequest = Target & {
  id: string;
  organization_id: string;
  recipient_id: string;
  task_id: string;
  intent: string;
  asker_name: string | null;
  group_name: string | null;
  work_item: string;
};

type ClosedDelivery = DueRequest & {
  external_ref: string;
  final_status: RequestSlackFinalStatus;
  closed_by_name: string | null;
};

type SendResult =
  | { kind: "confirmed"; output: unknown }
  | { kind: "failed"; code: string }
  | { kind: "uncertain" };

export function requestSlackMarker(requestId: string): string {
  return `[bkr-${requestId}]`;
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

export function capSlackTitle(title: string): string {
  const characters = [...title];
  return characters.length <= REQUEST_SLACK_TITLE_LIMIT
    ? title
    : characters.slice(0, REQUEST_SLACK_TITLE_LIMIT - 1).join("") + "\u2026";
}

export function requestSlackLink(
  publicBaseUrl: string,
  facts: Pick<RequestSlackFacts, "organizationId" | "taskId">,
): string {
  const address = new URL(`/tasks/${facts.taskId}`, publicBaseUrl);
  address.searchParams.set(EMAIL_LINK_ORGANIZATION_PARAM, facts.organizationId);
  return address.toString();
}

function closingLine(closing: RequestSlackClosing): string {
  const by = closing.closedByName === null
    ? ""
    : ` by ${escapeSlack(closing.closedByName)}`;
  switch (closing.status) {
    case "answered":
      return `Answered${by}`;
    case "handled":
      return `Handled${by}`;
    case "expired":
      return "Expired";
    case "withdrawn":
      return "Withdrawn";
  }
}

export function requestSlackText(
  publicBaseUrl: string,
  facts: RequestSlackFacts,
  closing?: RequestSlackClosing,
): string {
  const title = escapeSlack(capSlackTitle(facts.workItem));
  const link = requestSlackLink(publicBaseUrl, facts);
  const marker = requestSlackMarker(facts.requestId);
  if (closing !== undefined) {
    return [
      `${closingLine(closing)}: ${title}`,
      `Open in Bakery: ${link}`,
      marker,
    ].join("\n");
  }
  const asker = escapeSlack(facts.askerName ?? "A workflow");
  const audience = facts.groupName === null
    ? "you"
    : escapeSlack(facts.groupName);
  const verb = INTENT_VERB[facts.intent];
  const ask = verb === undefined
    ? `${asker} wants ${audience} to see`
    : `${asker} asked ${audience} to ${verb}`;
  return [`${ask}: ${title}`, `Open in Bakery: ${link}`, marker].join(
    "\n",
  );
}

const REQUEST_COLUMNS = `request.id, request.organization_id,
  request.recipient_id, request.task_id, request.intent,
  asker.display_name as asker_name, audience_group.name as group_name,
  task.title as work_item, target.connection_id, target.team_id,
  target.resource_id, target.principal_id`;

function joins(kind: number, purpose: number, provider: number): string {
  return `join bakery.principals principal
    on principal.id = request.recipient_id and principal.disabled_at is null
  join bakery.tasks task
    on task.organization_id = request.organization_id
   and task.id = request.task_id
  join lateral (
    select connection.id as connection_id,
           connection.external_account_id as team_id,
           resource.id as resource_id,
           delivery_principal.principal_id
      from bakery.integration_connections connection
      join bakery.integration_resources resource
        on resource.organization_id = connection.organization_id
       and resource.connection_id = connection.id
       and resource.kind = $${kind}
       and resource.external_id = connection.external_account_id
       and resource.archived_at is null
      join bakery.delivery_principals delivery_principal
        on delivery_principal.organization_id = connection.organization_id
       and delivery_principal.purpose = $${purpose}
     where connection.organization_id = request.organization_id
       and connection.provider = $${provider}
       and connection.status = 'enabled'
       and connection.archived_at is null
     order by connection.created_at, connection.id
     limit 1
  ) target on true
  left join bakery.principals asker on asker.id = request.asked_by
  left join bakery.organization_groups audience_group
    on audience_group.organization_id = request.organization_id
   and audience_group.id = request.audience_group_id`;
}

async function dueRequests(
  database: PgDatabase,
  now: Date,
): Promise<readonly DueRequest[]> {
  const found = await database.query<DueRequest>(
    `select ${REQUEST_COLUMNS}
       from bakery.person_requests request
       ${joins(6, 7, 8)}
       left join bakery.person_request_deliveries delivery
         on delivery.request_id = request.id and delivery.channel = $2
      where request.status = 'open'
        and request.expires_at > $1
        and (delivery.id is null or
             (delivery.state = 'retrying' and delivery.attempts < $3
              and delivery.updated_at <= $1 - make_interval(
                mins => $5 * power(3, delivery.attempts - 1)::int))
             or (delivery.state = 'sending'
              and delivery.updated_at <= $1 - make_interval(mins => $9)))
      order by request.created_at, request.id
      limit $4`,
    [
      now,
      SLACK_CHANNEL,
      REQUEST_SLACK_MAX_ATTEMPTS,
      REQUEST_SLACK_BATCH,
      REQUEST_SLACK_RETRY_BASE_MINUTES,
      SLACK_WORKSPACE_KIND,
      SLACK_DELIVERY_PURPOSE,
      SLACK_PROVIDER,
      REQUEST_SLACK_LEASE_MINUTES,
    ],
  );
  return found.rows;
}

async function closedDeliveries(
  database: PgDatabase,
  now: Date,
): Promise<readonly ClosedDelivery[]> {
  const found = await database.query<ClosedDelivery>(
    `select ${REQUEST_COLUMNS}, delivery.external_ref,
            closing.final_status, closer.display_name as closed_by_name
       from bakery.person_request_deliveries delivery
       join bakery.person_requests request
         on request.organization_id = delivery.organization_id
        and request.id = delivery.request_id
       cross join lateral (
         select case when request.status = 'open' and request.expires_at <= $1
                     then 'expired' else request.status end as final_status
       ) closing
       ${joins(5, 6, 7)}
       left join lateral (
         select decision.decided_by
           from bakery.decisions_ledger decision
          where decision.organization_id = request.organization_id
            and decision.kind = 'request_handled'
            and decision.detail ->> 'requestId' = request.id::text
          order by decision.created_at desc
          limit 1
       ) handled on closing.final_status in ('answered', 'handled')
       left join bakery.principals closer on closer.id = handled.decided_by
      where delivery.channel = $2
        and delivery.external_ref is not null
        and closing.final_status <> 'open'
        and ((delivery.state = 'delivered' and delivery.attempts < $8
              and (delivery.failure_code is null
                   or delivery.updated_at <= $1 - make_interval(
                     mins => $4 * power(3, delivery.attempts - 1)::int)))
             or (delivery.state = 'rewriting'
              and delivery.updated_at <= $1 - make_interval(mins => $9)))
      order by delivery.updated_at, delivery.id
      limit $3`,
    [
      now,
      SLACK_CHANNEL,
      REQUEST_SLACK_BATCH,
      REQUEST_SLACK_RETRY_BASE_MINUTES,
      SLACK_WORKSPACE_KIND,
      SLACK_DELIVERY_PURPOSE,
      SLACK_PROVIDER,
      REQUEST_SLACK_MAX_ATTEMPTS,
      REQUEST_SLACK_LEASE_MINUTES,
    ],
  );
  return found.rows;
}

async function claim(database: PgDatabase, request: DueRequest, now: Date) {
  const claimed = await database.query(
    `insert into bakery.person_request_deliveries
       (organization_id, request_id, channel, state)
     values ($1, $2, $3, 'sending')
     on conflict (request_id, channel) do update
       set state = 'sending', attempts = person_request_deliveries.attempts + 1,
           failure_code = null, updated_at = $5::timestamptz,
           version = person_request_deliveries.version + 1
       where (person_request_deliveries.state = 'retrying'
              and person_request_deliveries.attempts < $4)
          or (person_request_deliveries.state = 'sending'
              and person_request_deliveries.updated_at
                  <= $5::timestamptz - make_interval(mins => $6))
     returning 1`,
    [
      request.organization_id,
      request.id,
      SLACK_CHANNEL,
      REQUEST_SLACK_MAX_ATTEMPTS,
      now,
      REQUEST_SLACK_LEASE_MINUTES,
    ],
  );
  return claimed.rows.length === 1;
}

async function settleSend(
  database: PgDatabase,
  requestId: string,
  facts: Readonly<{
    state: string;
    failureCode: string | null;
    externalRef: string | null;
    now: Date;
  }>,
): Promise<void> {
  await database.query(
    `update bakery.person_request_deliveries
        set state = $3, failure_code = $4, external_ref = $5,
            attempts = case when $3 = 'delivered' then 0 else attempts end,
            delivered_at = case when $5::text is null then null
                                else $6::timestamptz end,
            updated_at = $6::timestamptz, version = version + 1
      where request_id = $1 and channel = $2 and state = 'sending'`,
    [
      requestId,
      SLACK_CHANNEL,
      facts.state,
      facts.failureCode,
      facts.externalRef,
      facts.now,
    ],
  );
}

async function claimRewrite(
  database: PgDatabase,
  requestId: string,
  now: Date,
): Promise<number | null> {
  const claimed = await database.query<{ attempts: number }>(
    `update bakery.person_request_deliveries
        set state = 'rewriting', attempts = attempts + 1,
            updated_at = $3::timestamptz, version = version + 1
      where request_id = $1 and channel = $2
        and (state = 'delivered'
             or (state = 'rewriting'
                 and updated_at <= $3::timestamptz - make_interval(mins => $4)))
      returning attempts`,
    [requestId, SLACK_CHANNEL, now, REQUEST_SLACK_LEASE_MINUTES],
  );
  return claimed.rows[0]?.attempts ?? null;
}

async function moveRewrite(
  database: PgDatabase,
  requestId: string,
  from: string,
  to: string,
  failureCode: string | null,
  now: Date,
): Promise<boolean> {
  const moved = await database.query(
    `update bakery.person_request_deliveries
        set state = $4, failure_code = $5, updated_at = $6::timestamptz,
            version = version + 1
      where request_id = $1 and channel = $2 and state = $3
      returning 1`,
    [requestId, SLACK_CHANNEL, from, to, failureCode, now],
  );
  return moved.rows.length === 1;
}

function refusalCode(result: IntegrationInvokeResult): string {
  if (result.route !== "ledger") return "action_not_a_write";
  const providerCode = result.run.refusal?.params?.providerCode;
  if (typeof providerCode === "string" && /^[a-z_]+$/.test(providerCode)) {
    return providerCode;
  }
  return result.run.effect.failureCode ?? "effect_failed";
}

function createSender(
  options: RequestSlackDependencies & { database: PgDatabase },
) {
  const invoke = connectionInvokeDeps(
    options.registry,
    options.providerRequests,
  );
  return async (
    target: Target & { organization_id: string },
    action: Readonly<{ id: string; version: number }>,
    args: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<SendResult> => {
    try {
      const result = await invokeIntegration({
        database: options.database,
        registry: options.registry,
        snapshotsFor: invoke.snapshotsFor,
        providerRequests: options.providerRequests,
        snapshots: {
          load: (key) =>
            withPgTransaction(
              options.database,
              (transaction) => invoke.snapshotsFor(transaction).load(key),
            ),
        },
      }, {
        organizationId: target.organization_id,
        actorRef: target.principal_id,
        connectionId: target.connection_id,
        input: {
          actionId: action.id,
          actionVersion: action.version,
          resourceId: target.resource_id,
          arguments: args,
        },
        idempotencyKey,
      });
      if (result.route !== "ledger") {
        return { kind: "failed", code: refusalCode(result) };
      }
      if (result.run.outcome === "confirmed") {
        return { kind: "confirmed", output: result.output };
      }
      if (result.run.outcome === "failed") {
        return { kind: "failed", code: refusalCode(result) };
      }
      return { kind: "uncertain" };
    } catch (error) {
      if (!(error instanceof StandardError)) return { kind: "uncertain" };
      const reason = error.params?.reason;
      return {
        kind: "failed",
        code: typeof reason === "string" && /^[a-z_]+$/.test(reason)
          ? reason
          : String(error.code).toLowerCase(),
      };
    }
  };
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === "string" && found.length > 0 ? found : null;
}

function factsOf(request: DueRequest): RequestSlackFacts {
  return {
    requestId: request.id,
    organizationId: request.organization_id,
    taskId: request.task_id,
    intent: request.intent,
    askerName: request.asker_name,
    groupName: request.group_name,
    workItem: request.work_item,
  };
}

function splitExternalRef(
  externalRef: string,
): { channelId: string; ts: string } | null {
  const at = externalRef.indexOf(":");
  if (at <= 0 || at === externalRef.length - 1) return null;
  return { channelId: externalRef.slice(0, at), ts: externalRef.slice(at + 1) };
}

export async function sendDueRequestSlackMessages(
  options: RequestSlackDependencies & { database: PgDatabase; now?: Date },
): Promise<RequestSlackOutcome[]> {
  const now = options.now ?? new Date();
  const due = await dueRequests(options.database, now);
  if (due.length === 0) return [];
  const send = createSender(options);
  const outcomes: RequestSlackOutcome[] = [];
  for (const request of due) {
    const link = await withPgTransaction(
      options.database,
      (transaction) =>
        findActiveSlackLinkForPrincipal(transaction, {
          organizationId: request.organization_id,
          principalId: request.recipient_id,
          teamId: request.team_id,
        }),
    );
    if (link === undefined) continue;
    if (!await claim(options.database, request, now)) continue;
    const attempts = (await options.database.query<{ attempts: number }>(
      `select attempts from bakery.person_request_deliveries
        where request_id = $1 and channel = $2`,
      [request.id, SLACK_CHANNEL],
    )).rows[0]?.attempts ?? 1;
    const opened = await send(
      request,
      DM_OPEN,
      { userId: link.userId },
      `request:${request.id}:slack:open`,
    );
    const channelId = opened.kind === "confirmed"
      ? stringField(opened.output, "channelId")
      : null;
    const posted: SendResult = opened.kind !== "confirmed"
      ? opened
      : channelId === null
      ? { kind: "failed", code: "dm_channel_missing" }
      : await send(request, MESSAGE_POST, {
        channelId,
        text: requestSlackText(options.publicBaseUrl, factsOf(request)),
        marker: requestSlackMarker(request.id),
      }, `request:${request.id}:slack:post`);
    const ts = posted.kind === "confirmed"
      ? stringField(posted.output, "ts")
      : null;
    if (posted.kind === "confirmed" && channelId !== null && ts !== null) {
      await settleSend(options.database, request.id, {
        state: SlackDeliveryState.Delivered,
        failureCode: null,
        externalRef: `${channelId}:${ts}`,
        now,
      });
      outcomes.push({ requestId: request.id, result: "delivered" });
      continue;
    }
    if (posted.kind === "failed" || posted.kind === "confirmed") {
      const code = posted.kind === "failed" ? posted.code : "post_ts_missing";
      await settleSend(options.database, request.id, {
        state: SlackDeliveryState.Failed,
        failureCode: code,
        externalRef: null,
        now,
      });
      outcomes.push({ requestId: request.id, result: "failed", code });
      continue;
    }
    const exhausted = attempts >= REQUEST_SLACK_MAX_ATTEMPTS;
    await settleSend(options.database, request.id, {
      state: exhausted
        ? SlackDeliveryState.Failed
        : SlackDeliveryState.Retrying,
      failureCode: UNCERTAIN_CODE,
      externalRef: null,
      now,
    });
    outcomes.push({
      requestId: request.id,
      result: exhausted ? "failed" : "retrying",
      code: UNCERTAIN_CODE,
    });
  }
  return outcomes;
}

export async function rewriteClosedRequestSlackMessages(
  options: RequestSlackDependencies & { database: PgDatabase; now?: Date },
): Promise<RequestSlackOutcome[]> {
  const now = options.now ?? new Date();
  const closed = await closedDeliveries(options.database, now);
  if (closed.length === 0) return [];
  const send = createSender(options);
  const outcomes: RequestSlackOutcome[] = [];
  for (const delivery of closed) {
    const posted = splitExternalRef(delivery.external_ref);
    const attempts = await claimRewrite(options.database, delivery.id, now);
    if (attempts === null) continue;
    const updated: SendResult = posted === null
      ? { kind: "failed", code: "external_ref_invalid" }
      : await send(delivery, MESSAGE_UPDATE, {
        channelId: posted.channelId,
        ts: posted.ts,
        text: requestSlackText(options.publicBaseUrl, factsOf(delivery), {
          status: delivery.final_status,
          closedByName: delivery.closed_by_name,
        }),
      }, `request:${delivery.id}:slack:update:${delivery.final_status}`);
    if (updated.kind === "confirmed") {
      await moveRewrite(
        options.database,
        delivery.id,
        SlackDeliveryState.Rewriting,
        SlackDeliveryState.Rewritten,
        null,
        now,
      );
      outcomes.push({ requestId: delivery.id, result: "rewritten" });
      continue;
    }
    if (updated.kind === "failed") {
      await moveRewrite(
        options.database,
        delivery.id,
        SlackDeliveryState.Rewriting,
        SlackDeliveryState.RewriteFailed,
        updated.code,
        now,
      );
      outcomes.push({
        requestId: delivery.id,
        result: "failed",
        code: updated.code,
      });
      continue;
    }
    const exhausted = attempts >= REQUEST_SLACK_MAX_ATTEMPTS;
    await moveRewrite(
      options.database,
      delivery.id,
      SlackDeliveryState.Rewriting,
      exhausted
        ? SlackDeliveryState.RewriteFailed
        : SlackDeliveryState.Delivered,
      UNCERTAIN_CODE,
      now,
    );
    outcomes.push({
      requestId: delivery.id,
      result: exhausted ? "failed" : "retrying",
      code: UNCERTAIN_CODE,
    });
  }
  return outcomes;
}

export function createRequestSlackFunction(
  options: RequestSlackDependencies & {
    database: PgDatabase;
    client: Inngest;
  },
) {
  return options.client.createFunction(
    {
      id: REQUEST_SLACK_FUNCTION_ID,
      retries: 0,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => ({
      sent: await step.run(
        "send-due-request-slack-messages",
        async () => await sendDueRequestSlackMessages(options),
      ),
      rewritten: await step.run(
        "rewrite-closed-request-slack-messages",
        async () => await rewriteClosedRequestSlackMessages(options),
      ),
    }),
  );
}
