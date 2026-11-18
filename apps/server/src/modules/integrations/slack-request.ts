/**
 * What a Slack delivery has to prove before Bakery will look at it, decided as
 * plain functions so each rule can be tested without a database or a workspace.
 *
 * Two questions, in order. First, did Slack send these exact bytes just now?
 * That is the v0 HMAC over `v0:<timestamp>:<raw body>` plus a freshness bound,
 * and it is checked before any form or JSON is decoded. Second, is this event
 * about us and worth keeping? A bot's own echo, an edit, a delete, a message
 * from another app's installation and a delivery for another workspace are all
 * ignored here, before anything is stored or shown to a model.
 *
 * Nothing in this file reads a secret from storage or returns one. A signature
 * secret comes in as bytes and goes no further.
 */
/** Slack's documented replay window: a request older than five minutes is refused. */
export const SLACK_MAX_SKEW_SECONDS = 300;

const SIGNATURE_HEADER = /^v0=([0-9a-f]{64})$/;
const TIMESTAMP_HEADER = /^[0-9]{1,12}$/;
const SHA256_BYTES = 32;

/** Why a delivery was refused. A code only: it never echoes a header or a body. */
export type SlackVerification =
  | { readonly ok: true; readonly timestampSeconds: number }
  | {
    readonly ok: false;
    readonly reason: "missing" | "malformed" | "stale" | "mismatch";
  };

/** Decodes `v0=<64 lowercase hex>` to its 32 bytes; anything else is null. */
export function parseSlackSignature(
  value: string | null,
): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const match = SIGNATURE_HEADER.exec(value);
  if (match === null) return null;
  const hex = match[1]!;
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Checks signature and freshness of one Slack request. The timestamp is read
 * as plain digits and compared against `nowMs` in both directions, so a
 * request dated in the future is as stale as one dated in the past. The HMAC is
 * verified by `crypto.subtle.verify`, which compares in constant time; an empty
 * secret never verifies because Web Crypto cannot import a zero-length key.
 */
export async function verifySlackRequest(input: {
  readonly secret: Uint8Array<ArrayBuffer>;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly nowMs: number;
}): Promise<SlackVerification> {
  if (input.signatureHeader === null || input.timestampHeader === null) {
    return { ok: false, reason: "missing" };
  }
  if (!TIMESTAMP_HEADER.test(input.timestampHeader)) {
    return { ok: false, reason: "malformed" };
  }
  const signature = parseSlackSignature(input.signatureHeader);
  if (signature === null) return { ok: false, reason: "malformed" };
  const timestampSeconds = Number(input.timestampHeader);
  if (
    Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds) >
      SLACK_MAX_SKEW_SECONDS
  ) return { ok: false, reason: "stale" };
  if (input.secret.byteLength === 0) return { ok: false, reason: "mismatch" };
  const prefix = new TextEncoder().encode(`v0:${input.timestampHeader}:`);
  const signed = new Uint8Array(prefix.byteLength + input.raw.byteLength);
  signed.set(prefix, 0);
  signed.set(input.raw, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    input.secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, signature, signed);
  return valid ? { ok: true, timestampSeconds } : {
    ok: false,
    reason: "mismatch",
  };
}

/** What this deployment is: the facts an event must match before it is ours. */
export type SlackAppIdentity = {
  readonly appId: string;
  /** The verified workspace this connection serves. */
  readonly teamId: string;
  /** The bot's own user id, so its echoes are recognised. */
  readonly botUserId: string;
};

export type SlackIgnoreReason =
  | "malformed"
  | "wrong_app"
  | "wrong_workspace"
  | "not_authorized"
  | "bot_echo"
  | "unsupported_event"
  | "edited_or_deleted";

/** The outcome of reading one verified event body. */
export type SlackEventDecision =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "ignore"; readonly reason: SlackIgnoreReason }
  | {
    readonly kind: "mention";
    readonly eventId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly ts: string;
    /** The thread the mention sits in; its own `ts` when it starts one. */
    readonly threadTs: string;
    readonly text: string;
  }
  | {
    /** A reply inside a thread. Kept only if the host finds it linked. */
    readonly kind: "thread_reply";
    readonly eventId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly ts: string;
    readonly threadTs: string;
    readonly text: string;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Reads a verified, already-parsed event body. The order is the point: the
 * challenge answers without admitting work; every other event must name our
 * app and workspace and carry an `authorizations` entry for this installation;
 * only then are echoes, edits and unsupported types dropped. Nothing about a
 * dropped message other than the reason leaves this function, so the caller has
 * no content to store.
 */
export function readSlackEvent(
  body: unknown,
  app: SlackAppIdentity,
): SlackEventDecision {
  if (!isRecord(body)) return { kind: "ignore", reason: "malformed" };
  if (body.type === "url_verification") {
    return nonEmptyString(body.challenge)
      ? { kind: "challenge", challenge: body.challenge }
      : { kind: "ignore", reason: "malformed" };
  }
  if (body.type !== "event_callback") {
    return { kind: "ignore", reason: "malformed" };
  }
  if (!nonEmptyString(body.event_id) || !isRecord(body.event)) {
    return { kind: "ignore", reason: "malformed" };
  }
  if (body.api_app_id !== app.appId) {
    return { kind: "ignore", reason: "wrong_app" };
  }
  if (body.team_id !== app.teamId) {
    return { kind: "ignore", reason: "wrong_workspace" };
  }
  const authorizations = Array.isArray(body.authorizations)
    ? body.authorizations
    : [];
  const authorized = authorizations.some((entry) =>
    isRecord(entry) && entry.team_id === app.teamId &&
    entry.user_id === app.botUserId
  );
  if (!authorized) return { kind: "ignore", reason: "not_authorized" };

  const event = body.event;
  const channelId = event.channel;
  const userId = event.user;
  const ts = event.ts;
  const text = event.text;
  if (
    event.type !== "app_mention" && event.type !== "message"
  ) return { kind: "ignore", reason: "unsupported_event" };
  // A bot message names its bot or app; the bot's own user id is an echo even
  // when Slack omits `bot_id`.
  if (
    event.bot_id !== undefined || event.app_id !== undefined ||
    event.bot_profile !== undefined || userId === app.botUserId
  ) return { kind: "ignore", reason: "bot_echo" };
  // `subtype` marks edits, deletes, joins and bot posts. Only an ordinary
  // message (no subtype) or one shared back to its channel is a person talking.
  if (
    event.subtype !== undefined && event.subtype !== "thread_broadcast"
  ) {
    return {
      kind: "ignore",
      reason: event.subtype === "message_changed" ||
          event.subtype === "message_deleted"
        ? "edited_or_deleted"
        : "unsupported_event",
    };
  }
  if (
    !nonEmptyString(channelId) || !nonEmptyString(userId) ||
    !nonEmptyString(ts) || typeof text !== "string"
  ) return { kind: "ignore", reason: "malformed" };
  const threadTs = nonEmptyString(event.thread_ts) ? event.thread_ts : null;
  if (event.type === "app_mention") {
    return {
      kind: "mention",
      eventId: body.event_id,
      channelId,
      userId,
      ts,
      threadTs: threadTs ?? ts,
      text,
    };
  }
  // A plain channel message outside any thread cannot be a linked reply.
  if (threadTs === null) return { kind: "ignore", reason: "unsupported_event" };
  return {
    kind: "thread_reply",
    eventId: body.event_id,
    channelId,
    userId,
    ts,
    threadTs,
    text,
  };
}
