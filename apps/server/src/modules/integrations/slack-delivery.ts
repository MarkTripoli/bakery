/**
 * Delivering one composed post to Slack, and reading what Slack said back.
 *
 * Two things are deliberately outside this module: the words (a composer
 * supplies blocks, and nothing here invents a sentence) and the token (the
 * transport is handed one by its caller, and no result, reason or error this
 * module returns can carry it).
 *
 * Slack answers `chat.postMessage` with HTTP 200 and `{"ok": false, "error":
 * "..."}` far more often than with a 4xx, so a delivery that only checked the
 * status would report success for a message no one can see. Everything here
 * starts from the body.
 *
 * Rate limiting is the one "failure" that is not a refusal: Slack says how long
 * to wait, and a caller that treated it as a refusal would drop a milestone post
 * for a busy channel.
 */
/** The five moments a run announces (owner decision O21). */
export const SlackMilestoneSchema = [
  "started",
  "waiting",
  "stuck",
  "failed",
  "done",
] as const;

export type SlackMilestone = (typeof SlackMilestoneSchema)[number];

/** One block of a Slack message; narrowed to the shapes a milestone post uses. */
export type SlackBlock =
  | {
    readonly type: "section";
    readonly text: { readonly type: "mrkdwn"; readonly text: string };
  }
  | {
    readonly type: "context";
    readonly elements: readonly {
      readonly type: "mrkdwn";
      readonly text: string;
    }[];
  }
  | {
    readonly type: "actions";
    readonly elements: readonly SlackButton[];
  };

export type SlackButton = {
  readonly type: "button";
  readonly text: { readonly type: "plain_text"; readonly text: string };
  readonly action_id: string;
  readonly style?: "primary" | "danger";
  readonly value: string;
};

/**
 * A post as it is handed to the transport: the channel, the blocks, and the
 * thread it belongs to when it is a reply rather than a new message.
 */
export type SlackPost = {
  readonly channelId: string;
  readonly blocks: readonly SlackBlock[];
  /** Plain-text fallback Slack shows in notifications and clients without blocks. */
  readonly fallbackText: string;
  readonly threadTs?: string;
};

/** What the transport is. Injected so a test never calls Slack. */
export type SlackPostTransport = (
  post: SlackPost,
) => Promise<SlackPostResult>;

export type SlackPostRefusal =
  | "not_in_channel"
  | "channel_not_found"
  | "invalid_auth"
  | "token_revoked"
  | "msg_too_long"
  | "restricted_action"
  | "unknown";

export type SlackPostResult =
  | { readonly ok: true; readonly messageTs: string }
  | { readonly ok: false; readonly refusal: SlackPostRefusal }
  | {
    readonly ok: false;
    readonly rateLimitedForSeconds: number;
  }
  | { readonly ok: false; readonly transportFailure: true };

const REFUSALS: Readonly<Record<string, SlackPostRefusal>> = {
  not_in_channel: "not_in_channel",
  channel_not_found: "channel_not_found",
  invalid_auth: "invalid_auth",
  token_revoked: "token_revoked",
  msg_too_long: "msg_too_long",
  restricted_action: "restricted_action",
};

/**
 * Reads a `chat.postMessage` answer.
 *
 * `ts` is required on success: a 200 with `ok: true` and no timestamp is not a
 * post anyone can find, so it is a transport failure rather than a success with
 * an empty id. `Retry-After` wins over the body, because Slack sends the
 * `ratelimited` error with both and the header is the precise one.
 */
export function readSlackPostResponse(
  status: number,
  headers: { get(name: string): string | null },
  body: unknown,
): SlackPostResult {
  if (status === 429) {
    return { ok: false, rateLimitedForSeconds: retryAfterSeconds(headers) };
  }
  if (status >= 500) return { ok: false, transportFailure: true };
  if (typeof body !== "object" || body === null) {
    return { ok: false, transportFailure: true };
  }
  const record = body as Record<string, unknown>;
  if (record.ok === true) {
    const ts = record.ts;
    return typeof ts === "string" && ts.length > 0
      ? { ok: true, messageTs: ts }
      : { ok: false, transportFailure: true };
  }
  const error = record.error;
  if (error === "ratelimited") {
    return { ok: false, rateLimitedForSeconds: retryAfterSeconds(headers) };
  }
  return {
    ok: false,
    refusal: typeof error === "string"
      ? REFUSALS[error] ?? "unknown"
      : "unknown",
  };
}

/**
 * Slack's `Retry-After` is in seconds and may be absent; one second is the floor
 * so a caller never spins, and a value that is not a positive integer is treated
 * as absent rather than trusted.
 */
function retryAfterSeconds(headers: {
  get(name: string): string | null;
}): number {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * A `fetch`-shaped transport. The token is closed over, never part of the post,
 * so a post that is logged, retried or recorded cannot leak it.
 */
export function createSlackPostTransport(options: {
  readonly token: string;
  readonly fetch?: typeof fetch;
}): SlackPostTransport {
  const call = options.fetch ?? fetch;
  return async (post) => {
    const response = await call("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({
        channel: post.channelId,
        blocks: post.blocks,
        text: post.fallbackText,
        ...(post.threadTs === undefined ? {} : { thread_ts: post.threadTs }),
      }),
    }).catch(() => null);
    if (response === null) return { ok: false, transportFailure: true };
    const body = await response.json().catch(() => null);
    return readSlackPostResponse(response.status, response.headers, body);
  };
}
