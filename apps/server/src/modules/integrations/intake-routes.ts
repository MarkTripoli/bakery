import type { Context, Hono } from "hono";
import type { SecretsKeyConfig } from "@bakery/config";
import type { ActionRegistry } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { IntegrationsImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  getTraceId,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { withVerifiedDelivery } from "./actions.ts";
import { GitHubAppPath } from "./github-app.ts";
import { INTAKE_MAX_BODY_BYTES, readBoundedBody } from "./intake-body.ts";
import {
  parseDelivery,
  parseDeliveryIdHeader,
  parseEventNameHeader,
  parseIntakeContentType,
} from "./intake-events.ts";
import {
  deliveryFailure,
  readWebhookSecret,
  verifyWithWebhookSecret,
} from "./intake-receipts.ts";
import { parseSignatureHeader, sha256Hex } from "./intake-signature.ts";

export type IntakeRouteOptions = {
  /** Registry holding the `intake.github` action. */
  registry: ActionRegistry;
  database: PgDatabase;
  /** Mounted secrets key; without one no webhook secret opens and every delivery is refused. */
  secretsKey?: SecretsKeyConfig;
  publicBaseUrl: string;
  /**
   * Time the whole delivery may take, read and commit included. The default
   * stays inside GitHub's ten-second delivery timeout.
   */
  deadlineMs?: number;
};

/** Default time budget for one delivery; GitHub abandons a delivery after ten seconds. */
export const INTAKE_DEADLINE_MS = 9_000;

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A caller-supplied request id is echoed in problems and logs, so only a short
 * token of safe characters is kept; anything else gets a fresh id.
 */
function requestIdOf(context: Context): string {
  const supplied = context.req.header("x-request-id");
  return supplied !== undefined && REQUEST_ID.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

/** Releases a body the handler will not read; a body already consumed or locked is ignored. */
function discardBody(request: Request): void {
  void request.body?.cancel().catch(() => undefined);
}

function authInvalid(): StandardError {
  return new StandardError({ code: "AUTH_INVALID" });
}

/**
 * One structured line for a refused oversize body: the limit and the request
 * ids only. No row is written because nothing is verified yet and no
 * installation is known; no header or byte of the request is logged.
 */
function logOversize(requestId: string, traceId: string): void {
  console.warn(JSON.stringify({
    component: "integrations",
    event: "github_webhook_body_too_large",
    limit: INTAKE_MAX_BODY_BYTES,
    requestId,
    traceId,
  }));
}

/**
 * POST /v1/webhooks/github: the raw-body receiver for GitHub App deliveries.
 * Checks run cheapest first and every authentication failure answers the same
 * 401, so a caller learns nothing about which check refused it:
 *
 * 1. signature header present and well formed (401)
 * 2. content type JSON or form (415)
 * 3. Content-Length, then a bounded read of the exact bytes (413, logged, no row)
 * 4. webhook secret opened and the HMAC over the bytes verified (401)
 * 5. delivery id and event name headers well formed (400)
 * 6. body decoded and checked against the event's schema (400)
 * 7. the registered `intake.github` action persists the receipt (202)
 *
 * No session middleware applies: the signature is the only credential, and it
 * proves GitHub sent the bytes, never which organization may act on them.
 */
async function handleDelivery(
  context: Context,
  options: IntakeRouteOptions,
): Promise<Response> {
  const request = context.req.raw;
  const requestId = requestIdOf(context);
  const traceId = getTraceId(request);
  const failure = { requestId, traceId };
  // The body is read before anything is authenticated, so the whole delivery
  // runs under a deadline: a body that trickles in, or a commit that stalls,
  // is cancelled instead of holding the request open. A client that goes away
  // aborts it too.
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort("deadline"),
    options.deadlineMs ?? INTAKE_DEADLINE_MS,
  );
  try {
    const signature = parseSignatureHeader(
      request.headers.get("x-hub-signature-256"),
    );
    if (signature === null) {
      discardBody(request);
      throw authInvalid();
    }
    const contentType = request.headers.get("content-type");
    if (parseIntakeContentType(contentType) === null) {
      discardBody(request);
      throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = await readBoundedBody(
        request,
        INTAKE_MAX_BODY_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (error instanceof StandardError && error.code === "BODY_TOO_LARGE") {
        logOversize(requestId, traceId);
      }
      throw error;
    }
    let stored;
    try {
      stored = await readWebhookSecret(options.database, options.secretsKey);
    } catch (error) {
      throw deliveryFailure(error, "secret", failure);
    }
    if (stored === null) throw authInvalid();
    if (!await verifyWithWebhookSecret(stored, signature, raw)) {
      throw authInvalid();
    }
    const deliveryId = parseDeliveryIdHeader(
      request.headers.get("x-github-delivery"),
    );
    const eventName = parseEventNameHeader(
      request.headers.get("x-github-event"),
    );
    if (deliveryId === null || eventName === null) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const event = parseDelivery({ contentType, raw, eventName });
    const digest = await sha256Hex(raw);
    const receipt = contractSchemas.WebhookReceipt.parse(
      await options.registry.execute(
        IntegrationsImplementedAction.IntakeGithub,
        withVerifiedDelivery(
          {
            request,
            params: {},
            requestId,
            traceId,
            signal: controller.signal,
          },
          {
            registrationId: stored.registrationId,
            deliveryId,
            eventName,
            digest,
            event,
          },
        ),
        {
          deliveryId,
          eventType: eventName,
          payload: event.supported ? event.payload : null,
        },
      ),
    );
    return context.json(receipt, 202, { "Cache-Control": "no-store" });
  } catch (error) {
    // Which deadline answers which status. A body that stalls in the read
    // stage already fails as a DEPENDENCY_TIMEOUT StandardError (504) and
    // passes through this block unchanged. The AbortError mapped here is only
    // raised when the deadline had already fired between database steps: the
    // registry refuses to start or continue an aborted action, and the
    // transaction helper refuses the next statement and the commit. A
    // statement the deadline cancels while it runs is a database failure
    // instead: PostgreSQL rejects it with SQLSTATE 57014, deliveryFailure maps
    // it to DEPENDENCY_UNAVAILABLE and the answer is a retryable 503. Either
    // way the transaction rolls back, so nothing is persisted and GitHub's
    // redelivery of the same id is a first delivery.
    const reported =
      error instanceof DOMException && error.name === "AbortError" &&
        controller.signal.aborted
        ? new StandardError({ code: "DEPENDENCY_TIMEOUT", cause: error })
        : error;
    return problemResponse(context, reported, {
      publicBaseUrl: options.publicBaseUrl,
      requestId,
      traceId,
    });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

/**
 * Mounts the webhook receiver. Call it before the JSON router is mounted, so
 * the router's own `intake.github` binding never serves this path, which it
 * could not do: the router reads a Bakery envelope, not GitHub's raw body.
 */
export function mountIntakeRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: IntakeRouteOptions,
): void {
  app.post(
    GitHubAppPath.Webhook,
    (context) => handleDelivery(context, options),
  );
}
