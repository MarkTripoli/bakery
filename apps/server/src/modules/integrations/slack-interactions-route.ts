/**
 * The Slack interactions endpoint: one button press, verified, claimed, decided
 * (#415).
 *
 * The order is the whole point, and each step exists because the one before it can
 * fail:
 *
 * 1. **Verify the bytes.** Slack signs `v0:{timestamp}:{raw body}` with the app's
 *    signing secret. Nothing in the body is trusted before this passes -- not the
 *    team, not the user, not even the interaction type -- so the form is not decoded
 *    and the JSON is not parsed until the HMAC is right.
 * 2. **Claim the delivery.** A retry arrives as the same signed bytes and therefore
 *    the same receipt key; the second copy answers `duplicate` and the decision is
 *    never applied twice.
 * 3. **Decode, then dispatch.** Only now is the form parsed, the `payload` decoded
 *    and the interaction type read. Anything this endpoint does not understand is
 *    acknowledged and ignored, because a 500 makes Slack retry a request that will
 *    never work.
 *
 * The response is Bakery's receipt, not Slack's protocol body: Slack only shows the
 * caller that the press was received. `disposition` says what happened, and the
 * `receiptId` is the row a support question can be traced back to.
 *
 * Absence is answered as absence: an installation with no Slack app configured has
 * no route, so the endpoint is 404 and the log names the table a person would fill,
 * rather than accepting presses it cannot verify.
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
  readSlackAppCredentials,
  type SlackAppCredentials,
} from "./slack-app-credentials.ts";
import { recordSlackRequest } from "./slack-app-credentials.ts";
import { decideSlackApproval } from "./slack-decisions.ts";
import { claimSlackRequest } from "./slack-request-receipts.ts";
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  verifySlackRequest,
} from "./slack-request-signature.ts";

/** Where Slack delivers button presses and other interactive components. */
export const SLACK_INTERACTIONS_PATH = "/v1/webhooks/slack/interactions";

/** How long the whole request may take: Slack's own three-second acknowledgement budget. */
export const SLACK_INTERACTIONS_DEADLINE_MS = 2_500;

export type SlackInteractionsRouteOptions = {
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

type Acknowledgement = {
  readonly disposition: "accepted" | "duplicate" | "rejected";
  readonly receiptId: string | null;
};

/** The part of a block-action payload this endpoint reads, and nothing more. */
type SlackBlockActionPayload = {
  readonly type: string;
  readonly team?: { readonly id?: string };
  readonly user?: { readonly id?: string };
  readonly api_app_id?: string;
  readonly actions?: readonly {
    readonly action_id?: string;
    readonly value?: string;
  }[];
};

function ack(
  context: Context,
  body: Acknowledgement,
  status = 200,
): Response {
  return context.json(body, status as 200);
}

/** Reads `payload` out of the form-encoded body. Only ever called after verification. */
function readPayloadField(rawBody: Uint8Array): string | undefined {
  const form = new URLSearchParams(new TextDecoder().decode(rawBody));
  const payload = form.get("payload");
  return payload === null || payload === "" ? undefined : payload;
}

/**
 * Opens the signing secret of the app that is configured for *this* request.
 *
 * The app id is supplied by the caller from the verified settings row, never from
 * the body: a body that named a different app would otherwise choose its own key.
 */
async function openSigningSecret(
  secretsKey: SecretsKeyConfig,
  credentials: SlackAppCredentials,
): Promise<string | null> {
  try {
    const key = await loadSecretKey(secretsKey);
    const plaintext = await openAppSecret(key, credentials.signingSecret);
    return plaintext;
  } catch {
    // An unopenable secret is a configuration fault, not a caller's: the caller is
    // told the endpoint does not exist, and the log says the secret could not be
    // opened.
    return null;
  }
}

export function mountSlackInteractionsRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: SlackInteractionsRouteOptions,
): void {
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  app.post(SLACK_INTERACTIONS_PATH, async (context) => {
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
        "bakery: Slack interactions received but no Slack app is configured; set bakery.slack_app_settings (app id, client id, signing and client secrets)",
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
        "bakery: Slack interactions received but the configured signing secret could not be opened",
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
        AbortSignal.timeout(SLACK_INTERACTIONS_DEADLINE_MS),
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
      // The settings screen's second row reports this: a person who regenerated the
      // signing secret in Slack sees "a request did not match the signing secret"
      // there, which is the only way the secret is ever tested.
      await withPgTransaction(
        options.database,
        (transaction) => recordSlackRequest(transaction, "refused"),
      );
      // The reason is logged, never returned: "signature_mismatch" is not something
      // Slack or a person can act on, and it would tell a prober how close they got.
      log(
        `bakery: Slack interaction refused (${verdict.reason}) trace=${traceId}`,
      );
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
          // The workspace is only known once the payload is decoded, so the receipt
          // does not claim one; the decision matches it against the post.
          teamId: null,
        });
      },
    );

    const payloadText = readPayloadField(rawBody);
    if (payloadText === undefined) {
      // A verified body without a payload is an interaction type this endpoint does
      // not serve. It is still a delivery Bakery received, so the receipt stands.
      return ack(context, {
        disposition: "rejected",
        receiptId: claim.receiptId,
      });
    }
    let payload: SlackBlockActionPayload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return ack(context, {
        disposition: "rejected",
        receiptId: claim.receiptId,
      });
    }

    // A retry of a press already answered: the receipt is the answer, and the
    // decision is not re-applied.
    if (claim.disposition === "duplicate") {
      return ack(context, {
        disposition: "duplicate",
        receiptId: claim.receiptId,
      });
    }

    if (payload.type !== "block_actions") {
      // Events, view submissions and shortcuts are other endpoints' work.
      return ack(context, {
        disposition: "rejected",
        receiptId: claim.receiptId,
      });
    }
    const action = payload.actions?.find((entry) =>
      entry.action_id === "approve" || entry.action_id === "reject"
    );
    const teamId = payload.team?.id;
    const userId = payload.user?.id;
    if (
      action === undefined || action.value === undefined ||
      teamId === undefined || userId === undefined
    ) {
      return ack(context, {
        disposition: "rejected",
        receiptId: claim.receiptId,
      });
    }

    const decided = await decideSlackApproval(options.database, {
      receiptId: claim.receiptId,
      decisionId: action.value,
      choice: action.action_id === "approve" ? "approve" : "reject",
      teamId,
      userId,
      appId: payload.api_app_id ?? credentials.appId,
      traceId,
    });
    return ack(context, {
      // A refusal is still a receipt: the press was received, understood and
      // refused, and the thread has a sentence for it.
      disposition: decided.kind === "decided" ? "accepted" : "rejected",
      receiptId: claim.receiptId,
    });
  });
}

/** Exported so the route's caller reads one name, and the settings reader another. */
export { readSlackAppCredentials };
