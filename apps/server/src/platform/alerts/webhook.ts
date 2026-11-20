import { createHmac, randomBytes } from "node:crypto";
import { parseTraceparent } from "@bakery/config/telemetry-trace";
import {
  ADDRESS_REFUSED_REASON,
  type AddressPolicy,
} from "../telemetry-destinations/address-policy.ts";
import {
  isAddressRefusal,
  readAnswer,
} from "../telemetry-destinations/pinned-fetch.ts";

/** The header a receiver reads to verify a message came from this Bakery. */
export const WEBHOOK_SIGNATURE_HEADER = "bakery-signature";
/** The W3C header that carries the trace an alert belongs to. */
export const WEBHOOK_TRACE_HEADER = "traceparent";
/** The header that names the message, so a receiver can ignore a repeat. */
export const WEBHOOK_EVENT_HEADER = "bakery-event-id";

/** The longest piece of a receiver's answer kept for the person reading it. */
export const WEBHOOK_ANSWER_MAX_CHARS = 300;

/** What an alert message is: a test, a problem that started, or one that ended. */
export type AlertMessageType = "alert.test" | "alert.fired" | "alert.resolved";

/** One message to an alert channel. The text reads the same in a webhook and in Slack. */
export type AlertMessage = Readonly<{
  /** Unique per message; a receiver may use it to ignore a repeat. */
  id: string;
  type: AlertMessageType;
  /** The sentence a person reads. */
  text: string;
  /** Seconds since the epoch when the message was made. */
  sentAt: number;
  /**
   * The trace the alert belongs to, when it is about work in one. A well-formed
   * value is sent as the `traceparent` header and its trace id is in the body,
   * so a receiver can join the alert to the run it is about.
   */
  traceparent?: string;
}>;

/** A fresh signing secret: random, URL-safe and prefixed so it is recognisable. */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** The body a webhook receives. Plain JSON, so any language can read it. */
export function webhookBody(message: AlertMessage): string {
  const trace = parseTraceparent(message.traceparent);
  return JSON.stringify({
    id: message.id,
    type: message.type,
    text: message.text,
    sentAt: new Date(message.sentAt * 1000).toISOString(),
    ...(trace === undefined ? {} : { traceId: trace.traceId }),
  });
}

/**
 * The signature header value: `t=<seconds>,v1=<hex>`, where v1 is an HMAC-SHA256
 * of `<seconds>.<body>` under the signing secret. The timestamp is inside the
 * signed text, so a receiver can refuse an old message.
 */
export function signWebhook(
  secret: string,
  seconds: number,
  body: string,
): string {
  const digest = createHmac("sha256", secret).update(`${seconds}.${body}`)
    .digest("hex");
  return `t=${seconds},v1=${digest}`;
}

/** The result of one send, in words a person can read. */
export type WebhookOutcome = Readonly<{
  ok: boolean;
  status: number | null;
  reason: string | null;
  answer: string | null;
}>;

function outcome(
  ok: boolean,
  status: number | null,
  reason: string | null,
  answer: string | null,
): WebhookOutcome {
  return Object.freeze({ ok, status, reason, answer: answer || null });
}

/**
 * Sends one signed message and reports what the receiver said. The address is
 * checked again here, at send time, because a name can come to point somewhere
 * private after it was saved. That check alone could be answered differently
 * when the connection resolves the name again, so the production `fetch` is the
 * pinned one: it dials only the addresses it checked. A redirect is a failure,
 * not something followed, so the signed body cannot be bounced to a host nobody
 * approved.
 */
export async function sendSignedWebhook(options: {
  address: string;
  secret: string;
  message: AlertMessage;
  fetch: typeof fetch;
  addressPolicy: AddressPolicy;
  signal: AbortSignal;
}): Promise<WebhookOutcome> {
  const verdict = await options.addressPolicy(options.address);
  if (!verdict.ok) return outcome(false, null, verdict.reason, null);
  const body = webhookBody(options.message);
  try {
    const response = await options.fetch(options.address, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_EVENT_HEADER]: options.message.id,
        ...(parseTraceparent(options.message.traceparent) === undefined
          ? {}
          : { [WEBHOOK_TRACE_HEADER]: options.message.traceparent as string }),
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(
          options.secret,
          options.message.sentAt,
          body,
        ),
      },
      body,
      signal: options.signal,
    });
    // Read up to the cap and cancel: a receiver that keeps sending is not buffered.
    const text = await readAnswer(response, WEBHOOK_ANSWER_MAX_CHARS);
    if (response.ok) return outcome(true, response.status, null, text);
    return outcome(
      false,
      response.status,
      response.status >= 300 && response.status < 400
        ? "The address answered with a redirect, which Bakery does not follow."
        : response.status === 401 || response.status === 403
        ? "The receiver refused the message."
        : "The receiver did not accept the message.",
      text,
    );
  } catch (error) {
    // The connection itself refused a name that now points somewhere private.
    if (isAddressRefusal(error)) {
      return outcome(false, null, ADDRESS_REFUSED_REASON, null);
    }
    const timedOut = options.signal.aborted ||
      (error as { name?: string }).name === "AbortError";
    return outcome(
      false,
      null,
      timedOut
        ? "The receiver did not answer in time."
        : "Bakery could not reach the receiver.",
      null,
    );
  }
}
