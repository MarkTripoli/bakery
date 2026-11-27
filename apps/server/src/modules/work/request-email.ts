import type { Inngest } from "inngest";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  emailState,
  openEmailPassword,
  readEmailSettings,
} from "./email-settings.ts";
import {
  sendMail,
  type SmtpConnection,
  type SmtpMessage,
  type SmtpOptions,
  SmtpOutcome,
} from "./smtp-client.ts";

export const REQUEST_EMAIL_FUNCTION_ID = "bakery-person-request-email";
export const REQUEST_EMAIL_AFTER_MS = 15 * 60_000;
export const REQUEST_EMAIL_MAX_ATTEMPTS = 3;
export const REQUEST_EMAIL_RETRY_BASE_MINUTES = 10;
const REQUEST_EMAIL_BATCH = 100;
const EMAIL_CHANNEL = "email";

export type RequestEmailSend = (
  connection: SmtpConnection,
  message: SmtpMessage,
  options: SmtpOptions,
) => Promise<SmtpOutcome>;

export type RequestEmailDependencies = Readonly<{
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  allowPlainLoopback?: boolean;
  send?: RequestEmailSend;
}>;

export type RequestEmailOutcome = Readonly<{
  requestId: string;
  result: "delivered" | "failed";
  code?: string;
}>;

type DueRequest = {
  id: string;
  organization_id: string;
  task_id: string;
  intent: string;
  asker_name: string | null;
  group_name: string | null;
  work_item: string;
  email: string;
};

export const INTENT_VERB: Readonly<Record<string, string>> = {
  approve: "approve",
  review: "review",
  answer: "answer a question",
  take_over: "take over a step",
};

const INTENT_ASK: Readonly<Record<string, string>> = {
  approve: "approve a step of",
  review: "review work in",
  answer: "answer a question about",
  take_over: "take over a step of",
};

export const EMAIL_LINK_ORGANIZATION_PARAM = "organization";
const SIGN_IN_LINE =
  "You will need to sign in. This email has no details on purpose: they stay in Bakery.";
const WHY_LINE =
  "You are getting this because the request has not been opened in Bakery for 15 minutes.";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type RequestEmailFacts = Readonly<{
  organizationId: string;
  taskId: string;
  intent: string;
  askerName: string | null;
  groupName: string | null;
  workItem: string;
}>;

export function requestEmailMessage(
  publicBaseUrl: string,
  facts: RequestEmailFacts,
  from: Readonly<{ fromAddress: string; fromName: string; to: string }>,
): SmtpMessage {
  const address = new URL(`/tasks/${facts.taskId}`, publicBaseUrl);
  address.searchParams.set(EMAIL_LINK_ORGANIZATION_PARAM, facts.organizationId);
  const link = address.toString();
  const asker = facts.askerName ?? "A workflow";
  const audience = facts.groupName ?? "you";
  const verb = INTENT_VERB[facts.intent];
  const subject = verb === undefined
    ? `${asker} wants ${audience} to see this in Bakery`
    : `${asker} asked ${audience} to ${verb} in Bakery`;
  const ask = INTENT_ASK[facts.intent];
  const opening = ask === undefined
    ? `${asker} wants ${audience} to see ${facts.workItem}.`
    : `${asker} asked ${audience} to ${ask} ${facts.workItem}.`;
  return {
    ...from,
    subject,
    text: [
      opening,
      "",
      `Open in Bakery: ${link}`,
      "",
      SIGN_IN_LINE,
      "",
      WHY_LINE,
    ].join("\n"),
    html: [
      "<!doctype html>",
      '<html><body style="font-family:sans-serif;line-height:1.5">',
      `<p>${escapeHtml(opening)}</p>`,
      `<p><a href="${
        escapeHtml(link)
      }" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f2937;color:#ffffff;text-decoration:none">Open in Bakery</a></p>`,
      `<p>${escapeHtml(SIGN_IN_LINE)}</p>`,
      `<p style="color:#6b7280">${escapeHtml(WHY_LINE)}</p>`,
      "</body></html>",
    ].join("\n"),
  };
}

async function dueRequests(
  database: PgDatabase,
  now: Date,
): Promise<readonly DueRequest[]> {
  const found = await database.query<DueRequest>(
    `select request.id, request.organization_id, request.task_id,
            request.intent, asker.display_name as asker_name,
            audience_group.name as group_name, task.title as work_item,
            provider_user.email
       from bakery.person_requests request
       join bakery.principals principal
         on principal.id = request.recipient_id and principal.disabled_at is null
       join bakery.organization_memberships membership
         on membership.organization_id = request.organization_id
        and membership.principal_id = request.recipient_id
        and membership.status = 'active'
       join public."user" provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.tasks task
         on task.organization_id = request.organization_id
        and task.id = request.task_id
       left join bakery.principals asker on asker.id = request.asked_by
       left join bakery.organization_groups audience_group
         on audience_group.organization_id = request.organization_id
        and audience_group.id = request.audience_group_id
       left join bakery.person_request_deliveries delivery
         on delivery.request_id = request.id and delivery.channel = $3
      where request.status = 'open'
        and request.created_at <= $1
        and request.expires_at > $2
        and (delivery.id is null or
             (delivery.state = 'failed' and delivery.attempts < $4
              and delivery.updated_at <= $2 - make_interval(
                mins => $6 * power(3, delivery.attempts - 1)::int)))
      order by request.created_at, request.id
      limit $5`,
    [
      new Date(now.getTime() - REQUEST_EMAIL_AFTER_MS),
      now,
      EMAIL_CHANNEL,
      REQUEST_EMAIL_MAX_ATTEMPTS,
      REQUEST_EMAIL_BATCH,
      REQUEST_EMAIL_RETRY_BASE_MINUTES,
    ],
  );
  return found.rows;
}

async function claim(database: PgDatabase, request: DueRequest) {
  return await withPgTransaction(database, async (transaction) => {
    const claimed = await transaction.query(
      `insert into bakery.person_request_deliveries
         (organization_id, request_id, channel, state)
       values ($1, $2, $3, 'sending')
       on conflict (request_id, channel) do update
         set state = 'sending', attempts = person_request_deliveries.attempts + 1,
             failure_code = null, updated_at = now(),
             version = person_request_deliveries.version + 1
         where person_request_deliveries.state = 'failed'
           and person_request_deliveries.attempts < $4
       returning 1`,
      [
        request.organization_id,
        request.id,
        EMAIL_CHANNEL,
        REQUEST_EMAIL_MAX_ATTEMPTS,
      ],
    );
    return claimed.rows.length === 1;
  });
}

async function settle(
  database: PgDatabase,
  request: DueRequest,
  outcome: SmtpOutcome,
  now: Date,
): Promise<void> {
  const delivered = outcome === SmtpOutcome.Delivered;
  await database.query(
    `update bakery.person_request_deliveries
        set state = $3, failure_code = $4,
            delivered_at = case when $5::boolean then $6::timestamptz end,
            updated_at = $6::timestamptz, version = version + 1
      where request_id = $1 and channel = $2 and state = 'sending'`,
    [
      request.id,
      EMAIL_CHANNEL,
      delivered ? "delivered" : "failed",
      delivered ? null : outcome,
      delivered,
      now,
    ],
  );
}

export async function sendDueRequestEmails(
  options: RequestEmailDependencies & {
    database: PgDatabase;
    now?: Date;
  },
): Promise<RequestEmailOutcome[]> {
  const settings = await readEmailSettings(options.database);
  if (settings === null || emailState(settings) !== "working") return [];
  const now = options.now ?? new Date();
  const due = await dueRequests(options.database, now);
  if (due.length === 0) return [];
  const password = await openEmailPassword(
    options.database,
    options.secretsKey,
    settings,
  );
  const connection: SmtpConnection = {
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    password,
  };
  const send = options.send ?? sendMail;
  const outcomes: RequestEmailOutcome[] = [];
  for (const request of due) {
    if (!await claim(options.database, request)) continue;
    const outcome = await send(
      connection,
      requestEmailMessage(
        options.publicBaseUrl,
        {
          organizationId: request.organization_id,
          taskId: request.task_id,
          intent: request.intent,
          askerName: request.asker_name,
          groupName: request.group_name,
          workItem: request.work_item,
        },
        {
          fromAddress: settings.fromAddress,
          fromName: settings.fromName,
          to: request.email,
        },
      ),
      { allowPlainLoopback: options.allowPlainLoopback },
    );
    await settle(options.database, request, outcome, now);
    outcomes.push(
      outcome === SmtpOutcome.Delivered
        ? { requestId: request.id, result: "delivered" }
        : { requestId: request.id, result: "failed", code: outcome },
    );
  }
  return outcomes;
}

export function createRequestEmailFunction(
  options: RequestEmailDependencies & {
    database: PgDatabase;
    client: Inngest;
  },
) {
  return options.client.createFunction(
    {
      id: REQUEST_EMAIL_FUNCTION_ID,
      retries: 0,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "send-due-request-emails",
        async () => await sendDueRequestEmails(options),
      ),
  );
}
