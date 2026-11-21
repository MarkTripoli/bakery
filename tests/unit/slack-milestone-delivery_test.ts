/**
 * Reading what Slack answered, and the transport that asks it.
 *
 * Slack answers `chat.postMessage` with HTTP 200 and `{"ok": false}` for most
 * failures, so the tests that matter are the ones where the status says nothing:
 * a refused channel, a revoked token, a rate limit that is not a refusal, and a
 * 200 that carries no message timestamp — the last one would otherwise be
 * recorded as a delivered post nobody can find or reply to.
 */
import { assertEquals } from "@std/assert";
import {
  createSlackPostTransport,
  readSlackPostResponse,
  type SlackBlock,
} from "../../apps/server/src/modules/integrations/slack-delivery.ts";

const headers = (values: Record<string, string> = {}) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

const BLOCKS: readonly SlackBlock[] = [
  { type: "section", text: { type: "mrkdwn", text: "Started." } },
];

Deno.test("slack delivery: a 200 that says ok is a post only when it names the message", () => {
  assertEquals(
    readSlackPostResponse(200, headers(), {
      ok: true,
      ts: "1700000000.000100",
    }),
    { ok: true, messageTs: "1700000000.000100" },
  );
  // ok without a timestamp is not a post anyone can find, let alone reply to.
  assertEquals(
    readSlackPostResponse(200, headers(), { ok: true }),
    { ok: false, transportFailure: true },
  );
  assertEquals(
    readSlackPostResponse(200, headers(), { ok: true, ts: "" }),
    { ok: false, transportFailure: true },
  );
});

Deno.test("slack delivery: a refusal is named, never a generic failure", () => {
  const refusal = (error: string) =>
    readSlackPostResponse(200, headers(), { ok: false, error });

  assertEquals(refusal("not_in_channel"), {
    ok: false,
    refusal: "not_in_channel",
  });
  assertEquals(refusal("channel_not_found"), {
    ok: false,
    refusal: "channel_not_found",
  });
  assertEquals(refusal("token_revoked"), {
    ok: false,
    refusal: "token_revoked",
  });
  // An error string this build has never seen still reads as a refusal, so a new
  // Slack error cannot be mistaken for a network fault and retried forever.
  assertEquals(refusal("some_new_error"), { ok: false, refusal: "unknown" });
  assertEquals(readSlackPostResponse(200, headers(), { ok: false }), {
    ok: false,
    refusal: "unknown",
  });
});

Deno.test("slack delivery: a rate limit is a wait, not a refusal", () => {
  assertEquals(
    readSlackPostResponse(429, headers({ "retry-after": "7" }), null),
    {
      ok: false,
      rateLimitedForSeconds: 7,
    },
  );
  // Slack sends this one as a 200 too, with the same header.
  assertEquals(
    readSlackPostResponse(
      200,
      headers({ "retry-after": "30" }),
      { ok: false, error: "ratelimited" },
    ),
    { ok: false, rateLimitedForSeconds: 30 },
  );
  // A missing or unusable header floors at one second rather than spinning.
  assertEquals(
    readSlackPostResponse(200, headers(), { ok: false, error: "ratelimited" }),
    { ok: false, rateLimitedForSeconds: 1 },
  );
  assertEquals(
    readSlackPostResponse(
      429,
      headers({ "retry-after": "-5" }),
      null,
    ),
    { ok: false, rateLimitedForSeconds: 1 },
  );
});

Deno.test("slack delivery: a server fault is a transport failure, not a refusal", () => {
  assertEquals(readSlackPostResponse(503, headers(), null), {
    ok: false,
    transportFailure: true,
  });
  assertEquals(readSlackPostResponse(200, headers(), "not json"), {
    ok: false,
    transportFailure: true,
  });
});

Deno.test("slack delivery: the transport sends the channel, blocks and thread, and keeps the token out of the body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = createSlackPostTransport({
    token: "xoxb-secret-token",
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, ts: "1700000000.000200" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch,
  });

  const result = await transport({
    channelId: "C0123456789",
    blocks: BLOCKS,
    fallbackText: "Started.",
    threadTs: "1700000000.000100",
  });

  assertEquals(result, { ok: true, messageTs: "1700000000.000200" });
  assertEquals(calls.length, 1);
  const [call] = calls;
  assertEquals(call.url, "https://slack.com/api/chat.postMessage");
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assertEquals(body.channel, "C0123456789");
  assertEquals(body.thread_ts, "1700000000.000100");
  assertEquals(body.text, "Started.");
  assertEquals(body.blocks, BLOCKS);
  // The token travels in the header and appears nowhere in the payload, so a
  // recorded or retried post cannot leak it.
  assertEquals(JSON.stringify(body).includes("xoxb-secret-token"), false);
  const authorization =
    (call.init.headers as Record<string, string>).authorization;
  assertEquals(authorization, "Bearer xoxb-secret-token");
});

Deno.test("slack delivery: a post with no thread sends none, and a dead network is a transport failure", async () => {
  let sent: Record<string, unknown> = {};
  const transport = createSlackPostTransport({
    token: "t",
    fetch: ((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 }),
      );
    }) as unknown as typeof fetch,
  });
  await transport({
    channelId: "C0123456789",
    blocks: BLOCKS,
    fallbackText: "Started.",
  });
  // Absent, not empty: Slack reads an empty thread_ts as a malformed request.
  assertEquals("thread_ts" in sent, false);
  assertEquals(sent.channel, "C0123456789");

  const dead = createSlackPostTransport({
    token: "t",
    fetch: (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch,
  });
  assertEquals(
    await dead({
      channelId: "C0123456789",
      blocks: BLOCKS,
      fallbackText: "Started.",
    }),
    { ok: false, transportFailure: true },
  );
});
