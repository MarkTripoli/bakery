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
import { EMAIL_LINK_ORGANIZATION_PARAM } from "./request-email.ts";

export const REQUEST_SLACK_FUNCTION_ID = "bakery-person-request-slack";
export const REQUEST_SLACK_MAX_ATTEMPTS = 3;
export const REQUEST_SLACK_RETRY_BASE_MINUTES = 10;
export const REQUEST_SLACK_TITLE_LIMIT = 120;
export const REQUEST_SLACK_LEASE_MINUTES = 10;
export const REQUEST_SLACK_MARKER_PARAM = "request";
export const SLACK_DELIVERY_PURPOSE = "slack.delivery";
const REQUEST_SLACK_BATCH = 100;
const SLACK_CHANNEL = "slack";
const SLACK_PROVIDER = "slack";
const SLACK_WORKSPACE_KIND = "slack.workspace";
const DM_OPEN = { id: "slack.dm.open", version: 1 } as const;
const MESSAGE_POST = { id: "slack.message.post", version: 1 } as const;
const MESSAGE_UPDATE = { id: "slack.message.update", version: 1 } as const;
const UNCERTAIN_CODE = "uncertain";
const CRASHED_CODE = "crashed";
const CLOSED_UNCONFIRMED_CODE = "closed_unconfirmed";
const CLOSED_BEFORE_SEND_CODE = "closed_before_send";

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
  audienceName: string | null;
  stepName: string | null;
  workItem: string;
  passedOnFrom: string | null;
  expiresAt: Date;
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

type RequestRow = Target & {
  id: string;
  organization_id: string;
  recipient_id: string;
  task_id: string;
  intent: string;
  asker_name: string | null;
  audience_name: string | null;
  step_key: string | null;
  work_item: string;
  passed_on_from: string | null;
  expires_at: Date;
};

type ClosedRow = RequestRow & {
  delivery_state: string;
  delivery_attempts: number;
  external_ref: string | null;
  final_status: RequestSlackFinalStatus;
  closed_by_name: string | null;
};

type SendResult =
  | { kind: "confirmed"; output: unknown }
  | { kind: "failed"; code: string }
  | { kind: "uncertain" };

const STATUS_WORD: Readonly<Record<string, string>> = {
  approve: "Needs a decision",
  review: "Review requested",
  answer: "Question for you",
  take_over: "Take over requested",
};
const FOR_YOUR_INFORMATION = "For your information";
const READ_IN_BAKERY = new Set(["review", "answer", "take_over"]);

export function requestSlackMarker(requestId: string): string {
  return `${REQUEST_SLACK_MARKER_PARAM}=${requestId}`;
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
  facts: Pick<RequestSlackFacts, "organizationId" | "taskId" | "requestId">,
): string {
  const address = new URL(`/tasks/${facts.taskId}`, publicBaseUrl);
  address.searchParams.set(EMAIL_LINK_ORGANIZATION_PARAM, facts.organizationId);
  address.searchParams.set(REQUEST_SLACK_MARKER_PARAM, facts.requestId);
  return address.toString();
}

export function requestSlackStatusWord(intent: string): string {
  return STATUS_WORD[intent] ?? FOR_YOUR_INFORMATION;
}

function askedFor(intent: string, step: string | null): string | null {
  switch (intent) {
    case "approve":
      return step === null ? "approve this step" : `approve ${step}`;
    case "review":
      return step === null ? "review this work" : `review ${step}`;
    case "answer":
      return step === null
        ? "answer a question"
        : `answer a question in ${step}`;
    case "take_over":
      return step === null ? "take over a step" : `take over ${step}`;
    default:
      return null;
  }
}

function slackDate(at: Date): string {
  const seconds = Math.floor(at.getTime() / 1000);
  return `<!date^${seconds}^{date_short_pretty}|${
    at.toISOString().slice(0, 10)
  }>`;
}

function openingLines(facts: RequestSlackFacts): string[] {
  const asker = escapeSlack(facts.askerName ?? "A workflow");
  const step = facts.stepName === null ? null : escapeSlack(facts.stepName);
  const audience = facts.audienceName === null
    ? "you"
    : escapeSlack(facts.audienceName);
  const action = askedFor(facts.intent, step);
  const sentences: string[] = [];
  if (action === null) {
    sentences.push(`${asker} wants ${audience} to see this.`);
  } else if (facts.passedOnFrom !== null) {
    sentences.push(
      `${
        escapeSlack(facts.passedOnFrom)
      } did not answer, so ${asker}'s request to ${action} now comes to you.`,
    );
  } else {
    sentences.push(`${asker} asked ${audience} to ${action}.`);
  }
  if (facts.audienceName !== null && facts.passedOnFrom === null) {
    sentences.push("Any one member can answer.");
  }
  if (READ_IN_BAKERY.has(facts.intent)) {
    sentences.push("Open Bakery to read it.");
  }
  return [
    `*${requestSlackStatusWord(facts.intent)}* · ${
      escapeSlack(capSlackTitle(facts.workItem))
    }`,
    sentences.join(" "),
  ];
}

function closingLines(
  facts: RequestSlackFacts,
  closing: RequestSlackClosing,
): string[] {
  const title = escapeSlack(capSlackTitle(facts.workItem));
  switch (closing.status) {
    case "answered":
    case "handled":
      return [
        closing.closedByName === null
          ? `*Handled* · ${title}`
          : `*Handled by ${escapeSlack(closing.closedByName)}* · ${title}`,
      ];
    case "expired":
      return [
        `*Expired* · ${title}`,
        `Nobody answered by ${slackDate(facts.expiresAt)}.`,
      ];
    case "withdrawn":
      return [
        `*Withdrawn* · ${title}`,
        `${
          escapeSlack(facts.askerName ?? "A workflow")
        } withdrew this request.`,
      ];
  }
}

export function requestSlackText(
  publicBaseUrl: string,
  facts: RequestSlackFacts,
  closing?: RequestSlackClosing,
): string {
  const lines = closing === undefined
    ? openingLines(facts)
    : closingLines(facts, closing);
  return [
    ...lines,
    `<${requestSlackLink(publicBaseUrl, facts)}|Open in Bakery>`,
  ].join("\n");
}

const REQUEST_COLUMNS = `request.id, request.organization_id,
  request.recipient_id, request.task_id, request.intent, request.step_key,
  request.expires_at, asker.display_name as asker_name,
  case when request.audience_group_id is not null
         or request.audience_role_key is not null
       then coalesce(request.audience_name, audience_group.name) end
    as audience_name,
  passed_on.name as passed_on_from,
  task.title as work_item, target.connection_id, target.team_id,
  target.resource_id, target.principal_id`;

function requestJoins(kind: number, purpose: number, provider: number) {
  return `join bakery.tasks task
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
   and audience_group.id = request.audience_group_id
  left join lateral (
    select coalesce(earlier.audience_name, earlier_recipient.display_name)
             as name
      from bakery.person_requests earlier
      join bakery.principals earlier_recipient
        on earlier_recipient.id = earlier.recipient_id
     where request.step_key is not null
       and earlier.organization_id = request.organization_id
       and earlier.run_id = request.run_id
       and earlier.step_key = request.step_key
       and earlier.step_iteration is not distinct from request.step_iteration
       and earlier.created_at < request.created_at
     order by earlier.created_at, earlier.id
     limit 1
  ) passed_on on true`;
}

async function dueRequests(
  database: PgDatabase,
  now: Date,
): Promise<readonly RequestRow[]> {
  const found = await database.query<RequestRow>(
    `select ${REQUEST_COLUMNS}
       from bakery.person_requests request
       join bakery.principals principal
         on principal.id = request.recipient_id
        and principal.disabled_at is null
       join bakery.organization_memberships membership
         on membership.organization_id = request.organization_id
        and membership.principal_id = request.recipient_id
        and membership.status = 'active'
       ${requestJoins(6, 7, 8)}
       left join bakery.person_request_deliveries delivery
         on delivery.request_id = request.id and delivery.channel = $2
      where request.status = 'open'
        and request.expires_at > $1
        and exists (
          select 1 from bakery.external_identity_links link
           where link.organization_id = request.organization_id
             and link.principal_id = request.recipient_id
             and link.provider = $8 and link.state = 'active'
             and link.identity_scope = target.team_id
        )
        and (delivery.id is null
             or (delivery.attempts < $3 and (
               (delivery.state = 'retrying'
                and delivery.updated_at <= $1 - make_interval(
                  mins => $5 * power(3, delivery.attempts - 1)::int))
               or (delivery.state = 'sending'
                and delivery.updated_at <= $1 - make_interval(mins => $9)))))
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

const CLOSING_JOINS = `cross join lateral (
         select case when request.status = 'open' and request.expires_at <= $1
                     then 'expired' else request.status end as final_status
       ) closing`;

const CLOSER_JOINS = `left join lateral (
         select decision.decided_by
           from bakery.decisions_ledger decision
          where decision.organization_id = request.organization_id
            and decision.kind = 'request_handled'
            and decision.detail ->> 'requestId' = request.id::text
          order by decision.created_at desc
          limit 1
       ) handled on closing.final_status in ('answered', 'handled')
       left join bakery.principals closer on closer.id = handled.decided_by`;

async function closedRows(
  database: PgDatabase,
  now: Date,
  states: string,
  stateParams: readonly number[],
): Promise<readonly ClosedRow[]> {
  const found = await database.query<ClosedRow>(
    `select ${REQUEST_COLUMNS}, delivery.state as delivery_state,
            delivery.attempts as delivery_attempts, delivery.external_ref,
            closing.final_status, closer.display_name as closed_by_name
       from bakery.person_request_deliveries delivery
       join bakery.person_requests request
         on request.organization_id = delivery.organization_id
        and request.id = delivery.request_id
       ${CLOSING_JOINS}
       ${requestJoins(4, 5, 6)}
       ${CLOSER_JOINS}
      where delivery.channel = $2
        and closing.final_status <> 'open'
        and delivery.attempts < $7
        and ${states}
      order by delivery.updated_at, delivery.id
      limit $3`,
    [
      now,
      SLACK_CHANNEL,
      REQUEST_SLACK_BATCH,
      SLACK_WORKSPACE_KIND,
      SLACK_DELIVERY_PURPOSE,
      SLACK_PROVIDER,
      REQUEST_SLACK_MAX_ATTEMPTS,
      ...stateParams,
    ],
  );
  return found.rows;
}

const UNSENT_STATES = `(delivery.state = 'retrying'
         or (delivery.state = 'sending'
             and delivery.updated_at <= $1 - make_interval(mins => $8)))`;

const REWRITE_STATES = `delivery.external_ref is not null
        and ((delivery.state = 'delivered'
              and (delivery.failure_code is null
                   or delivery.updated_at <= $1 - make_interval(
                     mins => $8 * power(3, delivery.attempts - 1)::int)))
             or (delivery.state = 'rewriting'
              and delivery.updated_at <= $1 - make_interval(mins => $9)))`;

async function giveUpCrashed(database: PgDatabase, now: Date): Promise<void> {
  await database.query(
    `update bakery.person_request_deliveries
        set state = case when state = 'rewriting' then 'rewrite_failed'
                         else 'failed' end,
            failure_code = $5, updated_at = $3::timestamptz,
            version = version + 1
      where channel = $1 and state in ('sending', 'rewriting')
        and attempts >= $2
        and updated_at <= $3::timestamptz - make_interval(mins => $4)`,
    [
      SLACK_CHANNEL,
      REQUEST_SLACK_MAX_ATTEMPTS,
      now,
      REQUEST_SLACK_LEASE_MINUTES,
      CRASHED_CODE,
    ],
  );
}

async function claimNew(
  database: PgDatabase,
  request: RequestRow,
  now: Date,
): Promise<number | null> {
  const claimed = await database.query<{ attempts: number }>(
    `insert into bakery.person_request_deliveries
       (organization_id, request_id, channel, state, updated_at)
     values ($1, $2, $3, 'sending', $5::timestamptz)
     on conflict (request_id, channel) do update
       set state = 'sending', attempts = person_request_deliveries.attempts + 1,
           failure_code = null, updated_at = $5::timestamptz,
           version = person_request_deliveries.version + 1
       where person_request_deliveries.attempts < $4
         and (person_request_deliveries.state = 'retrying'
              or (person_request_deliveries.state = 'sending'
                  and person_request_deliveries.updated_at
                      <= $5::timestamptz - make_interval(mins => $6)))
     returning attempts`,
    [
      request.organization_id,
      request.id,
      SLACK_CHANNEL,
      REQUEST_SLACK_MAX_ATTEMPTS,
      now,
      REQUEST_SLACK_LEASE_MINUTES,
    ],
  );
  return claimed.rows[0]?.attempts ?? null;
}

async function claimExisting(
  database: PgDatabase,
  requestId: string,
  fromState: string,
  toState: string,
  now: Date,
): Promise<number | null> {
  const claimed = await database.query<{ attempts: number }>(
    `update bakery.person_request_deliveries
        set state = $4, attempts = attempts + 1, failure_code = null,
            updated_at = $5::timestamptz, version = version + 1
      where request_id = $1 and channel = $2 and state = $3
      returning attempts`,
    [requestId, SLACK_CHANNEL, fromState, toState, now],
  );
  return claimed.rows[0]?.attempts ?? null;
}

async function settle(
  database: PgDatabase,
  requestId: string,
  facts: Readonly<{
    from: string;
    state: string;
    failureCode: string | null;
    externalRef?: string | null;
    resetAttempts?: boolean;
    now: Date;
  }>,
): Promise<void> {
  await database.query(
    `update bakery.person_request_deliveries
        set state = $4, failure_code = $5,
            external_ref = case when $6::boolean then $7::text
                                else external_ref end,
            delivered_at = case when $6::boolean and $7::text is not null
                                then $8::timestamptz else delivered_at end,
            attempts = case when $9::boolean then 0 else attempts end,
            updated_at = $8::timestamptz, version = version + 1
      where request_id = $1 and channel = $2 and state = $3`,
    [
      requestId,
      SLACK_CHANNEL,
      facts.from,
      facts.state,
      facts.failureCode,
      facts.externalRef !== undefined,
      facts.externalRef ?? null,
      facts.now,
      facts.resetAttempts ?? false,
    ],
  );
}

async function storedPost(
  database: PgDatabase,
  organizationId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const found = await database.query<
    { safe_arguments: Record<string, unknown> | null }
  >(
    `select safe_arguments from bakery.external_effects
      where organization_id = $1 and operation = $2 and idempotency_key = $3
      order by created_at desc
      limit 1`,
    [organizationId, MESSAGE_POST.id, idempotencyKey],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  return row.safe_arguments ?? {};
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

function factsOf(request: RequestRow): RequestSlackFacts {
  return {
    requestId: request.id,
    organizationId: request.organization_id,
    taskId: request.task_id,
    intent: request.intent,
    askerName: request.asker_name,
    audienceName: request.audience_name,
    stepName: request.step_key,
    workItem: request.work_item,
    passedOnFrom: request.passed_on_from,
    expiresAt: new Date(request.expires_at),
  };
}

function splitExternalRef(
  externalRef: string | null,
): { channelId: string; ts: string } | null {
  if (externalRef === null) return null;
  const at = externalRef.indexOf(":");
  if (at <= 0 || at === externalRef.length - 1) return null;
  return { channelId: externalRef.slice(0, at), ts: externalRef.slice(at + 1) };
}

const openKey = (id: string) => `request:${id}:slack:open`;
const postKey = (id: string) => `request:${id}:slack:post`;

function postedRef(posted: SendResult): string | null {
  if (posted.kind !== "confirmed") return null;
  const channelId = stringField(posted.output, "channelId");
  const ts = stringField(posted.output, "ts");
  return channelId === null || ts === null ? null : `${channelId}:${ts}`;
}

type Send = ReturnType<typeof createSender>;

async function sendOpen(
  options: RequestSlackDependencies & { database: PgDatabase },
  send: Send,
  request: RequestRow,
  userId: string,
): Promise<SendResult> {
  const stored = await storedPost(
    options.database,
    request.organization_id,
    postKey(request.id),
  );
  if (stored !== null) {
    return await send(request, MESSAGE_POST, stored, postKey(request.id));
  }
  const opened = await send(
    request,
    DM_OPEN,
    { userId },
    openKey(request.id),
  );
  if (opened.kind !== "confirmed") return opened;
  const channelId = stringField(opened.output, "channelId");
  if (channelId === null) return { kind: "failed", code: "dm_channel_missing" };
  return await send(request, MESSAGE_POST, {
    channelId,
    text: requestSlackText(options.publicBaseUrl, factsOf(request)),
    marker: requestSlackMarker(request.id),
  }, postKey(request.id));
}

export async function sendDueRequestSlackMessages(
  options: RequestSlackDependencies & { database: PgDatabase; now?: Date },
): Promise<RequestSlackOutcome[]> {
  const now = options.now ?? new Date();
  await giveUpCrashed(options.database, now);
  const send = createSender(options);
  const outcomes: RequestSlackOutcome[] = [];
  for (const request of await dueRequests(options.database, now)) {
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
    const attempts = await claimNew(options.database, request, now);
    if (attempts === null) continue;
    const posted = await sendOpen(options, send, request, link.userId);
    const externalRef = postedRef(posted);
    if (externalRef !== null) {
      await settle(options.database, request.id, {
        from: SlackDeliveryState.Sending,
        state: SlackDeliveryState.Delivered,
        failureCode: null,
        externalRef,
        resetAttempts: true,
        now,
      });
      outcomes.push({ requestId: request.id, result: "delivered" });
      continue;
    }
    if (posted.kind !== "uncertain") {
      const code = posted.kind === "failed" ? posted.code : "post_ts_missing";
      await settle(options.database, request.id, {
        from: SlackDeliveryState.Sending,
        state: SlackDeliveryState.Failed,
        failureCode: code,
        now,
      });
      outcomes.push({ requestId: request.id, result: "failed", code });
      continue;
    }
    const exhausted = attempts >= REQUEST_SLACK_MAX_ATTEMPTS;
    await settle(options.database, request.id, {
      from: SlackDeliveryState.Sending,
      state: exhausted
        ? SlackDeliveryState.Failed
        : SlackDeliveryState.Retrying,
      failureCode: UNCERTAIN_CODE,
      now,
    });
    outcomes.push({
      requestId: request.id,
      result: exhausted ? "failed" : "retrying",
      code: UNCERTAIN_CODE,
    });
  }
  for (
    const row of await closedRows(options.database, now, UNSENT_STATES, [
      REQUEST_SLACK_LEASE_MINUTES,
    ])
  ) {
    const attempts = await claimExisting(
      options.database,
      row.id,
      row.delivery_state,
      SlackDeliveryState.Sending,
      now,
    );
    if (attempts === null) continue;
    const stored = await storedPost(
      options.database,
      row.organization_id,
      postKey(row.id),
    );
    const posted: SendResult = stored === null
      ? { kind: "failed", code: CLOSED_BEFORE_SEND_CODE }
      : await send(row, MESSAGE_POST, stored, postKey(row.id));
    const externalRef = postedRef(posted);
    if (externalRef !== null) {
      await settle(options.database, row.id, {
        from: SlackDeliveryState.Sending,
        state: SlackDeliveryState.Delivered,
        failureCode: null,
        externalRef,
        resetAttempts: true,
        now,
      });
      outcomes.push({ requestId: row.id, result: "delivered" });
      continue;
    }
    const code = posted.kind === "failed"
      ? posted.code
      : CLOSED_UNCONFIRMED_CODE;
    await settle(options.database, row.id, {
      from: SlackDeliveryState.Sending,
      state: SlackDeliveryState.Failed,
      failureCode: code,
      now,
    });
    outcomes.push({ requestId: row.id, result: "failed", code });
  }
  return outcomes;
}

export async function rewriteClosedRequestSlackMessages(
  options: RequestSlackDependencies & { database: PgDatabase; now?: Date },
): Promise<RequestSlackOutcome[]> {
  const now = options.now ?? new Date();
  await giveUpCrashed(options.database, now);
  const send = createSender(options);
  const outcomes: RequestSlackOutcome[] = [];
  for (
    const row of await closedRows(options.database, now, REWRITE_STATES, [
      REQUEST_SLACK_RETRY_BASE_MINUTES,
      REQUEST_SLACK_LEASE_MINUTES,
    ])
  ) {
    const posted = splitExternalRef(row.external_ref);
    const attempts = await claimExisting(
      options.database,
      row.id,
      row.delivery_state,
      SlackDeliveryState.Rewriting,
      now,
    );
    if (attempts === null) continue;
    const updated: SendResult = posted === null
      ? { kind: "failed", code: "external_ref_invalid" }
      : await send(row, MESSAGE_UPDATE, {
        channelId: posted.channelId,
        ts: posted.ts,
        text: requestSlackText(options.publicBaseUrl, factsOf(row), {
          status: row.final_status,
          closedByName: row.closed_by_name,
        }),
      }, `request:${row.id}:slack:update:${row.final_status}`);
    if (updated.kind === "confirmed") {
      await settle(options.database, row.id, {
        from: SlackDeliveryState.Rewriting,
        state: SlackDeliveryState.Rewritten,
        failureCode: null,
        now,
      });
      outcomes.push({ requestId: row.id, result: "rewritten" });
      continue;
    }
    if (updated.kind === "failed") {
      await settle(options.database, row.id, {
        from: SlackDeliveryState.Rewriting,
        state: SlackDeliveryState.RewriteFailed,
        failureCode: updated.code,
        now,
      });
      outcomes.push({
        requestId: row.id,
        result: "failed",
        code: updated.code,
      });
      continue;
    }
    const exhausted = attempts >= REQUEST_SLACK_MAX_ATTEMPTS;
    await settle(options.database, row.id, {
      from: SlackDeliveryState.Rewriting,
      state: exhausted
        ? SlackDeliveryState.RewriteFailed
        : SlackDeliveryState.Delivered,
      failureCode: UNCERTAIN_CODE,
      now,
    });
    outcomes.push({
      requestId: row.id,
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
