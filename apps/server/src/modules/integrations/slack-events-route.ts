/**
 * The Slack events endpoint: the URL the settings screen shows a person
 * (#415).
 *
 * Two things arrive here. Slack's own `url_verification` challenge, which must
 * be answered with the `challenge` value verbatim or Slack refuses to save the
 * URL at all, and workspace events, of which only a `message` in a thread
 * Bakery posted to means anything: it steers the run that thread belongs to.
 *
 * The order is the same as the interactions endpoint, for the same reasons:
 * verify the bytes, claim the delivery, and only then read the body. Nothing is
 * parsed before the HMAC passes, so a body that names a team, a channel or a
 * user is not trusted until Slack's signature says it came from Slack.
 *
 * Slack insists on an answer within three seconds and retries anything else, so
 * a request this endpoint does not understand is acknowledged and ignored rather
 * than failed: a 500 would make Slack retry a request that can never work.
 */
import type { Context, Hono } from "hono";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  getTraceId,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { openAppSecret } from "./callbacks.ts";
import { INTAKE_MAX_BODY_BYTES, readBoundedBody } from "./intake-body.ts";
import {
  loadSlackAppCredentials,
  recordSlackRequest,
  type SlackAppCredentials,
} from "./slack-app-credentials.ts";
import { claimSlackRequest } from "./slack-request-receipts.ts";
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  verifySlackRequest,
} from "./slack-request-signature.ts";
import { steerFromSlackThread } from "./slack-thread-steers.ts";

/** Where Slack delivers events for the app a person set up. */
export const SLACK_EVENTS_PATH = "/v1/webhooks/slack/events";

/** Slack's acknowledgement budget for an event delivery. */
export const SLACK_EVENTS_DEADLINE_MS = 2_500;

export type SlackEventsRouteOptions = {
  database: PgDatabase;
  /** Public base URL, used to build problem documents. */
  publicBaseUrl: string;
  /** Mounted secrets key; without one no signing secret opens and every request is 404. */
  secretsKey?: SecretsKeyConfig;
  /** Injected clock, so the freshness window is testable. */
  now?: () => number;
  /** Where the "no app configured" line goes; stderr by default. */
  log?: (line: string) => void;
};

/** The part of an events envelope this endpoint reads, and nothing more. */
type SlackEventEnvelope = {
  readonly type?: string;
  readonly challenge?: string;
  readonly team_id?: string;
  readonly api_app_id?: string;
  readonly event?: {
    readonly type?: string;
    readonly channel?: string;
    readonly user?: string;
    readonly text?: string;
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly subtype?: string;
    readonly bot_id?: string;
  };
};

/**
 * Opens the signing secret of the app the installation is configured with. The
 * app id comes from the stored settings row, never from the body.
 */
async function openSigningSecret(
  secretsKey: SecretsKeyConfig,
  credentials: SlackAppCredentials,
): Promise<string | null> {
  try {
    const key = await loadSecretKey(secretsKey);
    return await openAppSecret(key, credentials.signingSecret);
  } catch {
    return null;
  }
}

export function mountSlackEventsRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: SlackEventsRouteOptions,
): void {
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  app.post(SLACK_EVENTS_PATH, async (context: Context) => {
    const request = new Request(context.req.raw);
    const traceId = getTraceId(request);
    let credentials: SlackAppCredentials | null;
    try {
      credentials = await loadSlackAppCredentials(options.database);
    } catch {
      return problemResponse(
        context,
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
        { publicBaseUrl: options.publicBaseUrl, traceId },
      );
    }
    if (credentials === null || options.secretsKey === undefined) {
      log(
        "bakery: Slack event received but no Slack app is configured; save the app's details on the installation's integrations page",
      );
      return problemResponse(
        context,
        new StandardError({ code: "RESOURCE_NOT_FOUND" }),
        { publicBaseUrl: options.publicBaseUrl, traceId },
      );
    }
    const signingSecret = await openSigningSecret(
      options.secretsKey,
      credentials,
    );
    if (signingSecret === null) {
      log(
        "bakery: Slack event received but the configured signing secret could not be opened",
      );
      return problemResponse(
        context,
        new StandardError({ code: "RESOURCE_NOT_FOUND" }),
        { publicBaseUrl: options.publicBaseUrl, traceId },
      );
    }

    let rawBody: Uint8Array<ArrayBuffer>;
    try {
      rawBody = await readBoundedBody(
        request,
        INTAKE_MAX_BODY_BYTES,
        AbortSignal.timeout(SLACK_EVENTS_DEADLINE_MS),
      );
    } catch (error) {
      return problemResponse(
        context,
        error instanceof StandardError
          ? error
          : new StandardError({ code: "MALFORMED_REQUEST" }),
        { publicBaseUrl: options.publicBaseUrl, traceId },
      );
    }

    const verdict = await verifySlackRequest({
      signingSecret,
      signatureHeader: context.req.header(SLACK_SIGNATURE_HEADER) ?? null,
      timestampHeader: context.req.header(SLACK_TIMESTAMP_HEADER) ?? null,
      rawBody,
      now: now(),
    });
    if (!verdict.ok) {
      await withPgTransaction(
        options.database,
        (transaction) => recordSlackRequest(transaction, "refused"),
      );
      log(`bakery: Slack event refused (${verdict.reason}) trace=${traceId}`);
      return problemResponse(
        context,
        new StandardError({ code: "AUTH_INVALID" }),
        { publicBaseUrl: options.publicBaseUrl, traceId },
      );
    }

    const claim = await withPgTransaction(
      options.database,
      async (transaction) => {
        await recordSlackRequest(transaction, "accepted");
        return await claimSlackRequest(transaction, {
          replayKey: verdict.replayKey,
          bodyDigest: verdict.bodyDigest,
          requestedAt: verdict.timestamp,
          teamId: null,
        });
      },
    );

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return context.json({ ok: true } as const, 200);
    }

    // Slack refuses to save an Events URL that does not echo the challenge, so
    // this answer is the difference between a URL that works and one that cannot
    // be set at all. It is answered after verification like everything else.
    if (envelope.type === "url_verification" && envelope.challenge) {
      return context.json({ challenge: envelope.challenge }, 200);
    }

    // A retry of a delivery already answered: acknowledged, never applied twice.
    if (claim.disposition === "duplicate") {
      return context.json({ ok: true } as const, 200);
    }

    const event = envelope.event;
    const teamId = envelope.team_id;
    // A bot's own message, an edit, a join: none of them is a person steering.
    if (
      envelope.type !== "event_callback" || event?.type !== "message" ||
      event.subtype !== undefined || event.bot_id !== undefined ||
      typeof event.channel !== "string" || typeof event.user !== "string" ||
      typeof event.text !== "string" || typeof event.ts !== "string" ||
      typeof teamId !== "string"
    ) {
      return context.json({ ok: true } as const, 200);
    }
    // Only a reply steers: a new message in a channel is not in a thread, and a
    // milestone thread's root is what resolves to a run.
    const rootTs = event.thread_ts;
    if (rootTs === undefined) return context.json({ ok: true } as const, 200);

    const steered = await steerFromSlackThread(options.database, {
      teamId,
      userId: event.user,
      channelId: event.channel,
      rootTs,
      text: event.text,
      receiptId: claim.receiptId,
      ...(envelope.api_app_id === undefined
        ? {}
        : { appId: envelope.api_app_id }),
      traceId,
      log,
    });
    if (steered.kind === "refused") {
      // The person is told in the thread by the delivery that carries the
      // refusal; this endpoint's job is to acknowledge Slack's delivery.
      log(
        `bakery: Slack thread reply not steered (${steered.reason}) trace=${traceId}`,
      );
    }
    return context.json({ ok: true } as const, 200);
  });
}
