import { assert, assertEquals } from "@std/assert";
import {
  parseSlackSignature,
  readSlackEvent,
  SLACK_MAX_SKEW_SECONDS,
  type SlackAppIdentity,
  verifySlackRequest,
} from "../../apps/server/src/modules/integrations/slack-request.ts";

const app: SlackAppIdentity = {
  appId: "A0APP",
  teamId: "T0TEAM",
  botUserId: "U0BOT",
};
const NOW_MS = 1_800_000_000_000;
const encoder = new TextEncoder();
const secret = encoder.encode("signing-secret");

async function sign(
  timestamp: string,
  body: string,
  key: Uint8Array<ArrayBuffer> = secret,
): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      hmac,
      encoder.encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${
    [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

const stamp = (offsetSeconds = 0) =>
  String(Math.floor(NOW_MS / 1000) + offsetSeconds);

Deno.test("a request signed over timestamp and raw body verifies", async () => {
  const body = "token=x&text=hello";
  const result = await verifySlackRequest({
    secret,
    signatureHeader: await sign(stamp(), body),
    timestampHeader: stamp(),
    raw: encoder.encode(body),
    nowMs: NOW_MS,
  });
  assertEquals(result.ok, true);
});

Deno.test("a changed body, secret or timestamp does not verify", async () => {
  const body = "a=1";
  const header = await sign(stamp(), body);
  const base = { timestampHeader: stamp(), nowMs: NOW_MS };
  const changedBody = await verifySlackRequest({
    ...base,
    secret,
    signatureHeader: header,
    raw: encoder.encode("a=2"),
  });
  const wrongSecret = await verifySlackRequest({
    ...base,
    secret: encoder.encode("other"),
    signatureHeader: header,
    raw: encoder.encode(body),
  });
  // Signed for one timestamp, presented with another still inside the window.
  const otherTimestamp = await verifySlackRequest({
    secret,
    signatureHeader: header,
    timestampHeader: stamp(1),
    raw: encoder.encode(body),
    nowMs: NOW_MS,
  });
  for (const result of [changedBody, wrongSecret, otherTimestamp]) {
    assertEquals(result, { ok: false, reason: "mismatch" });
  }
});

Deno.test("an empty secret never verifies", async () => {
  const empty = new Uint8Array(0);
  const result = await verifySlackRequest({
    secret: empty,
    signatureHeader: await sign(stamp(), "x", encoder.encode("k")),
    timestampHeader: stamp(),
    raw: encoder.encode("x"),
    nowMs: NOW_MS,
  });
  assertEquals(result, { ok: false, reason: "mismatch" });
});

Deno.test("a stale or future timestamp is refused even with a valid signature", async () => {
  for (
    const offset of [-(SLACK_MAX_SKEW_SECONDS + 1), SLACK_MAX_SKEW_SECONDS + 1]
  ) {
    const result = await verifySlackRequest({
      secret,
      signatureHeader: await sign(stamp(offset), "x"),
      timestampHeader: stamp(offset),
      raw: encoder.encode("x"),
      nowMs: NOW_MS,
    });
    assertEquals(result, { ok: false, reason: "stale" });
  }
  const edge = await verifySlackRequest({
    secret,
    signatureHeader: await sign(stamp(-SLACK_MAX_SKEW_SECONDS), "x"),
    timestampHeader: stamp(-SLACK_MAX_SKEW_SECONDS),
    raw: encoder.encode("x"),
    nowMs: NOW_MS,
  });
  assertEquals(edge.ok, true);
});

Deno.test("missing and malformed headers are refused with a code, not an echo", async () => {
  const raw = encoder.encode("x");
  const good = await sign(stamp(), "x");
  const cases: [string | null, string | null, "missing" | "malformed"][] = [
    [null, stamp(), "missing"],
    [good, null, "missing"],
    [good.replace("v0=", "v1="), stamp(), "malformed"],
    [good.toUpperCase(), stamp(), "malformed"],
    [good.slice(0, -2), stamp(), "malformed"],
    [good, "12abc", "malformed"],
    [good, " " + stamp(), "malformed"],
  ];
  for (const [signatureHeader, timestampHeader, reason] of cases) {
    assertEquals(
      await verifySlackRequest({
        secret,
        signatureHeader,
        timestampHeader,
        raw,
        nowMs: NOW_MS,
      }),
      { ok: false, reason },
    );
  }
  assertEquals(parseSlackSignature("v0=" + "a".repeat(64))?.byteLength, 32);
});

function callback(
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "event_callback",
    event_id: "Ev1",
    api_app_id: app.appId,
    team_id: app.teamId,
    authorizations: [{ team_id: app.teamId, user_id: app.botUserId }],
    event: { channel: "C1", user: "U1", ts: "100.1", text: "hi", ...event },
    ...extra,
  };
}

Deno.test("the verification handshake answers its challenge and admits nothing", () => {
  assertEquals(
    readSlackEvent({ type: "url_verification", challenge: "abc" }, app),
    { kind: "challenge", challenge: "abc" },
  );
  assertEquals(
    readSlackEvent({ type: "url_verification" }, app),
    { kind: "ignore", reason: "malformed" },
  );
});

Deno.test("a mention starts or addresses a thread; a threaded reply is a candidate", () => {
  assertEquals(
    readSlackEvent(callback({ type: "app_mention" }), app),
    {
      kind: "mention",
      eventId: "Ev1",
      channelId: "C1",
      userId: "U1",
      ts: "100.1",
      threadTs: "100.1",
      text: "hi",
    },
  );
  const reply = readSlackEvent(
    callback({ type: "message", thread_ts: "90.0" }),
    app,
  );
  assertEquals(reply.kind, "thread_reply");
  assert(reply.kind === "thread_reply" && reply.threadTs === "90.0");
  assertEquals(
    readSlackEvent(callback({ type: "app_mention", thread_ts: "90.0" }), app)
      .kind,
    "mention",
  );
});

Deno.test("bot echoes, edits and deletes are dropped before any content is kept", () => {
  const echoes = [
    { type: "message", thread_ts: "1.0", bot_id: "B1" },
    { type: "message", thread_ts: "1.0", app_id: "A9" },
    { type: "message", thread_ts: "1.0", user: app.botUserId },
    { type: "app_mention", user: app.botUserId },
    { type: "message", thread_ts: "1.0", subtype: "bot_message" },
  ];
  for (const event of echoes) {
    const decision = readSlackEvent(callback(event), app);
    assertEquals(decision.kind, "ignore", JSON.stringify(event));
    assert(!("text" in decision));
  }
  assertEquals(
    readSlackEvent(
      callback({
        type: "message",
        thread_ts: "1.0",
        subtype: "message_changed",
      }),
      app,
    ),
    { kind: "ignore", reason: "edited_or_deleted" },
  );
  assertEquals(
    readSlackEvent(
      callback({ type: "message", thread_ts: "1.0", subtype: "channel_join" }),
      app,
    ),
    { kind: "ignore", reason: "unsupported_event" },
  );
  assertEquals(
    readSlackEvent(callback({ type: "message" }), app),
    { kind: "ignore", reason: "unsupported_event" },
  );
});

Deno.test("another app, another workspace or another installation is not ours", () => {
  assertEquals(
    readSlackEvent(
      callback({ type: "app_mention" }, { api_app_id: "A9" }),
      app,
    ),
    { kind: "ignore", reason: "wrong_app" },
  );
  assertEquals(
    readSlackEvent(callback({ type: "app_mention" }, { team_id: "T9" }), app),
    { kind: "ignore", reason: "wrong_workspace" },
  );
  for (
    const authorizations of [
      undefined,
      [],
      [{ team_id: "T9", user_id: app.botUserId }],
      [{ team_id: app.teamId, user_id: "U9" }],
    ]
  ) {
    assertEquals(
      readSlackEvent(
        callback({ type: "app_mention" }, { authorizations }),
        app,
      ),
      { kind: "ignore", reason: "not_authorized" },
    );
  }
});

Deno.test("an event without an id, an object or a text is malformed, not guessed", () => {
  assertEquals(
    readSlackEvent(
      callback({ type: "app_mention" }, { event_id: undefined }),
      app,
    ),
    { kind: "ignore", reason: "malformed" },
  );
  assertEquals(readSlackEvent("nope", app), {
    kind: "ignore",
    reason: "malformed",
  });
  assertEquals(
    readSlackEvent(callback({ type: "app_mention", text: undefined }), app),
    { kind: "ignore", reason: "malformed" },
  );
});
