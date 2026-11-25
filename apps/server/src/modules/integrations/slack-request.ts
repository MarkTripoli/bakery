export const SLACK_MAX_SKEW_SECONDS = 300;

const SIGNATURE_HEADER = /^v0=([0-9a-f]{64})$/;
const TIMESTAMP_HEADER = /^[0-9]{1,12}$/;
const SHA256_BYTES = 32;

export type SlackVerification =
  | { readonly ok: true; readonly timestampSeconds: number }
  | {
    readonly ok: false;
    readonly reason: "missing" | "malformed" | "stale" | "mismatch";
  };

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

export type SlackAppIdentity = {
  readonly appId: string;

  readonly teamId: string;

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

export type SlackEventDecision =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "ignore"; readonly reason: SlackIgnoreReason }
  | {
    readonly kind: "mention";
    readonly eventId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly ts: string;

    readonly threadTs: string;
    readonly text: string;
  }
  | {
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
  if (
    event.bot_id !== undefined || event.app_id !== undefined ||
    event.bot_profile !== undefined || userId === app.botUserId
  ) return { kind: "ignore", reason: "bot_echo" };
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
