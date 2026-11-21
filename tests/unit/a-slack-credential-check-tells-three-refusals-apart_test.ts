/**
 * #415: "Check now" has four sentences, and three of them are refusals.
 *
 * The value of this check is entirely in telling the refusals apart. A screen that
 * says "Slack refused the client secret" when Slack really meant "I do not know this
 * client ID" sends a person to rotate the wrong secret; a screen that says "Slack
 * could not be reached" when Slack answered is a lie that hides the one fact the
 * person needs. So each branch is pinned, including the two that must not guess: a
 * body that is not Slack's shape, and a success from a code that was meant to fail.
 */
import { assertEquals } from "@std/assert";
import {
  checkSlackClientCredentials,
  SLACK_CHECK_CODE,
} from "../../apps/server/src/modules/integrations/slack-client-check.ts";

/** A transport that answers one payload, and records what was sent. */
function answering(
  payload: unknown,
  options: { status?: number; fail?: boolean } = {},
) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init.body)),
    });
    if (options.fail) return Promise.reject(new TypeError("connection reset"));
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const check = (fetchImpl: typeof fetch) =>
  checkSlackClientCredentials({
    clientId: "1234567890.0987654321",
    clientSecret: "client-secret-value",
    fetch: fetchImpl,
  });

Deno.test("a refused code is the app's credentials working", async () => {
  const { calls, fetch } = answering({ ok: false, error: "invalid_code" });
  const outcome = await check(fetch);
  assertEquals(outcome.result, "accepted");
  // The pair travels in the body, not the URL: a secret in a query string ends up
  // in somebody's proxy log.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.body.get("client_id"), "1234567890.0987654321");
  assertEquals(calls[0]!.body.get("client_secret"), "client-secret-value");
  assertEquals(calls[0]!.body.get("code"), SLACK_CHECK_CODE);
  assertEquals(calls[0]!.url.includes("client_secret"), false);
});

Deno.test("the two credential refusals are not one refusal", async () => {
  const idRefused = await check(
    answering({ ok: false, error: "invalid_client_id" }).fetch,
  );
  assertEquals(idRefused.result, "client_id_refused");
  const secretRefused = await check(
    answering({ ok: false, error: "bad_client_secret" }).fetch,
  );
  assertEquals(secretRefused.result, "client_secret_refused");
});

Deno.test("a transport failure blames nobody", async () => {
  const outcome = await check(answering({}, { fail: true }).fetch);
  assertEquals(outcome.result, "unreachable");
  assertEquals(outcome.slackError, null);
});

Deno.test("an answer that is not Slack's shape is not a verdict", async () => {
  // A proxy's 502 page: a status, a body, nothing about a credential.
  const html = new Response("<html>bad gateway</html>", { status: 502 });
  const notSlack = (() => Promise.resolve(html)) as unknown as typeof fetch;
  assertEquals((await check(notSlack)).result, "unreachable");

  // An error code Slack has never used is not evidence either.
  const unknown = await check(
    answering({ ok: false, error: "ratelimited" }).fetch,
  );
  assertEquals(unknown.result, "unreachable");
  assertEquals(unknown.slackError, "ratelimited");
});

Deno.test("a success from an unusable code is not 'accepted'", async () => {
  // If Slack ever answers this with ok:true, the check has stopped asking the
  // question the screen's sentences assume, and saying "accepted" would be a
  // confident wrong answer.
  const outcome = await check(answering({ ok: true }).fetch);
  assertEquals(outcome.result, "unreachable");
});
