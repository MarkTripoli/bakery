import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import type { Context, Hono } from "hono";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { openInstallationSecret } from "../secrets/installation-secrets.ts";
import { INTAKE_MAX_BODY_BYTES, readBoundedBody } from "./intake-body.ts";
import { receiveSlackEvent, type SlackSigningSecret } from "./slack-intake.ts";
import { commitSlackReceipt, findSlackInstallation } from "./slack-receipts.ts";
import { sha256Hex } from "./intake-signature.ts";

export const SLACK_EVENTS_PATH = "/v1/webhooks/slack/events";
const SLACK_INTAKE_DEADLINE_MS = 2_500;
const MAX_SLACK_SIGNING_SECRET_CANDIDATES = 4;

type SlackIntakeRouteOptions = {
  readonly database: PgDatabase;
  readonly secretsKey?: SecretsKeyConfig;
  readonly now?: () => number;
  readonly deadlineMs?: number;
};

type SlackSecretRow = {
  readonly appId: string;
  readonly signingSecretId: string;
};
async function readSlackSigningSecret(
  transaction: Parameters<typeof openInstallationSecret>[0],
  options: SlackIntakeRouteOptions,
  row: SlackSecretRow,
): Promise<SlackSigningSecret | null> {
  try {
    const plaintext = await openInstallationSecret(
      transaction,
      options.secretsKey,
      row.signingSecretId,
    );
    return {
      appId: row.appId,
      secret: new TextEncoder().encode(plaintext),
    };
  } catch {
    return null;
  }
}

async function readSlackSigningSecrets(
  options: SlackIntakeRouteOptions,
  appId: string,
  signal: AbortSignal,
): Promise<readonly SlackSigningSecret[]> {
  return await withPgTransaction(options.database, async (transaction) => {
    const result = await transaction.query<SlackSecretRow>(
      `select distinct app_id as "appId",
         signing_secret_id as "signingSecretId"
         from bakery.slack_installations
        where app_id = $1 and status = 'active'
          and signing_secret_id is not null
        order by signing_secret_id
        limit $2`,
      [appId, MAX_SLACK_SIGNING_SECRET_CANDIDATES],
    );
    const candidates: SlackSigningSecret[] = [];
    for (const row of result.rows) {
      const candidate = await readSlackSigningSecret(
        transaction,
        options,
        row,
      );
      if (candidate !== null) candidates.push(candidate);
    }
    return candidates;
  }, signal);
}

async function handleSlackEvent(
  context: Context<{ Variables: AuthVariables }>,
  options: SlackIntakeRouteOptions,
): Promise<Response> {
  const request = context.req.raw;
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort("deadline"),
    options.deadlineMs ?? SLACK_INTAKE_DEADLINE_MS,
  );
  try {
    const raw = await readBoundedBody(
      request,
      INTAKE_MAX_BODY_BYTES,
      controller.signal,
    );
    const now = options.now ?? Date.now;
    const result = await receiveSlackEvent({
      raw,
      signatureHeader: request.headers.get("x-slack-signature"),
      timestampHeader: request.headers.get("x-slack-request-timestamp"),
    }, {
      signingSecrets: (appId) =>
        readSlackSigningSecrets(options, appId, controller.signal),
      findInstallation: (appId, teamId) =>
        withPgTransaction(
          options.database,
          (transaction) =>
            findSlackInstallation(transaction, { appId, teamId }),
          controller.signal,
        ),
      commit: async ({ installation, eventId, payloadDigest, decision }) => {
        try {
          return await withPgTransaction(
            options.database,
            (transaction) =>
              commitSlackReceipt(transaction, {
                installationId: installation.installationId,
                appId: installation.appId,
                eventId,
                payloadDigest,
                decision,
                now: new Date(now()),
              }),
            controller.signal,
          );
        } catch (error) {
          if (decision.kind !== "ignore") {
            throw new StandardError({
              code: "DEPENDENCY_UNAVAILABLE",
              cause: error,
            });
          }
          throw error;
        }
      },
      sha256Hex,
      now,
    });
    if (result.kind === "refused") {
      throw new StandardError({ code: result.code });
    }
    if (result.kind === "challenge") {
      return context.json({ challenge: result.challenge }, 200, {
        "Cache-Control": "no-store",
      });
    }
    return context.json(
      {
        disposition: result.disposition,
        receiptId: result.receiptId,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (error) {
    if (controller.signal.aborted && !request.signal.aborted) {
      throw new StandardError({ code: "DEPENDENCY_TIMEOUT", cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

export function mountSlackIntakeRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: SlackIntakeRouteOptions,
): void {
  app.post(
    SLACK_EVENTS_PATH,
    (context) => handleSlackEvent(context, options),
  );
}
