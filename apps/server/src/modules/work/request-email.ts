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
  run_id: string;
  email: string;
};

export function requestEmailMessage(
  publicBaseUrl: string,
  request: Readonly<{ runId: string; requestId: string }>,
  from: Readonly<{ fromAddress: string; fromName: string; to: string }>,
): SmtpMessage {
  const link = new URL(
    `/runs/${request.runId}?request=${request.requestId}`,
    publicBaseUrl,
  ).toString();
  return {
    ...from,
    subject: "Someone in Bakery is waiting for you",
    text: [
      "Someone in Bakery asked you to look at something, and nobody has answered yet.",
      "",
      `Open it in Bakery: ${link}`,
      "",
      "This email carries only the link. What was asked is in Bakery.",
    ].join("\n"),
  };
}

async function dueRequests(
  database: PgDatabase,
  now: Date,
): Promise<readonly DueRequest[]> {
  const found = await database.query<DueRequest>(
    `select request.id, request.organization_id, request.run_id,
            provider_user.email
       from bakery.person_requests request
       join bakery.principals principal on principal.id = request.recipient_id
       join public."user" provider_user
         on provider_user.id = principal.provider_user_id
       left join bakery.person_request_deliveries delivery
         on delivery.request_id = request.id and delivery.channel = $3
      where request.status = 'open'
        and request.created_at <= $1
        and request.expires_at > $2
        and (delivery.id is null or
             (delivery.state = 'failed' and delivery.attempts < $4))
      order by request.created_at, request.id
      limit $5`,
    [
      new Date(now.getTime() - REQUEST_EMAIL_AFTER_MS),
      now,
      EMAIL_CHANNEL,
      REQUEST_EMAIL_MAX_ATTEMPTS,
      REQUEST_EMAIL_BATCH,
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
): Promise<void> {
  const delivered = outcome === SmtpOutcome.Delivered;
  await database.query(
    `update bakery.person_request_deliveries
        set state = $3, failure_code = $4,
            delivered_at = case when $5::boolean then now() else null end,
            updated_at = now(), version = version + 1
      where request_id = $1 and channel = $2 and state = 'sending'`,
    [
      request.id,
      EMAIL_CHANNEL,
      delivered ? "delivered" : "failed",
      delivered ? null : outcome,
      delivered,
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
  const due = await dueRequests(options.database, options.now ?? new Date());
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
        { runId: request.run_id, requestId: request.id },
        {
          fromAddress: settings.fromAddress,
          fromName: settings.fromName,
          to: request.email,
        },
      ),
      { allowPlainLoopback: options.allowPlainLoopback },
    );
    await settle(options.database, request, outcome);
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
