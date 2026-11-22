import { assert, assertEquals } from "@std/assert";
import { createHmac } from "node:crypto";
import {
  type AlertMessage,
  sendSignedWebhook,
  signWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TRACE_HEADER,
  webhookBody,
} from "../../apps/server/src/platform/alerts/webhook.ts";
import { allowAnyAddress } from "../../apps/server/src/platform/telemetry-destinations/index.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const message: AlertMessage = {
  id: "7a1f6f5e-8c4e-4b8b-9f43-1d8f3d6f6f10",
  type: "alert.fired",
  text: "A worker stopped answering.",
  sentAt: 1_800_000_000,
};

function recorder(status = 200, text = "ok") {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(text, { status }));
  }) as unknown as typeof fetch;
  return { seen, fetcher };
}

const send = (
  fetcher: typeof fetch,
  overrides: Partial<Parameters<typeof sendSignedWebhook>[0]> = {},
) =>
  sendSignedWebhook({
    address: "https://hooks.example.test/alerts",
    secret: "whsec_test",
    message,
    fetch: fetcher,
    addressPolicy: allowAnyAddress,
    signal: AbortSignal.timeout(2_000),
    ...overrides,
  });

Deno.test("a webhook is signed over its timestamp and body, and names the message", async () => {
  const { seen, fetcher } = recorder();
  const outcome = await send(fetcher);
  assertEquals(outcome, { ok: true, status: 200, reason: null, answer: "ok" });
  const { init } = seen[0];
  const headers = init.headers as Record<string, string>;
  const body = init.body as string;
  assertEquals(headers[WEBHOOK_EVENT_HEADER], message.id);
  const expected = createHmac("sha256", "whsec_test")
    .update(`${message.sentAt}.${body}`).digest("hex");
  assertEquals(
    headers[WEBHOOK_SIGNATURE_HEADER],
    `t=${message.sentAt},v1=${expected}`,
  );
  assertEquals(
    headers[WEBHOOK_SIGNATURE_HEADER],
    signWebhook("whsec_test", message.sentAt, body),
  );
  assertEquals(init.redirect, "manual");
  // A different secret does not verify.
  assert(
    signWebhook("whsec_other", message.sentAt, body) !==
      headers[WEBHOOK_SIGNATURE_HEADER],
  );
});

Deno.test("an alert about work in a trace carries the trace id in the header and the body", async () => {
  const { seen, fetcher } = recorder();
  const traceparent = `00-${TRACE}-${SPAN}-01`;
  await send(fetcher, { message: { ...message, traceparent } });
  const headers = seen[0].init.headers as Record<string, string>;
  assertEquals(headers[WEBHOOK_TRACE_HEADER], traceparent);
  assertEquals(
    JSON.parse(seen[0].init.body as string).traceId,
    TRACE,
  );
  // The signature covers the trace id too, so it cannot be swapped in transit.
  assertEquals(
    headers[WEBHOOK_SIGNATURE_HEADER],
    signWebhook("whsec_test", message.sentAt, seen[0].init.body as string),
  );
});

Deno.test("an alert with no trace, or a malformed one, sends neither header nor id", async () => {
  for (
    const traceparent of [
      undefined,
      "garbage",
      `00-${"0".repeat(32)}-${SPAN}-01`,
    ]
  ) {
    const { seen, fetcher } = recorder();
    await send(fetcher, { message: { ...message, traceparent } });
    const headers = seen[0].init.headers as Record<string, string>;
    assertEquals(WEBHOOK_TRACE_HEADER in headers, false);
    assertEquals(
      "traceId" in JSON.parse(webhookBody({ ...message, traceparent })),
      false,
    );
  }
});

Deno.test("a refused address, a redirect, a refusal and a timeout each read as a plain failure", async () => {
  const refused = await send(recorder().fetcher, {
    addressPolicy: () => Promise.resolve({ ok: false, reason: "private" }),
  });
  assertEquals(refused, {
    ok: false,
    status: null,
    reason: "private",
    answer: null,
  });
  const redirect = await send(recorder(302).fetcher);
  assertEquals(redirect.ok, false);
  assertEquals(
    redirect.reason,
    "The address answered with a redirect, which Bakery does not follow.",
  );
  const refusedByReceiver = await send(recorder(403, "no").fetcher);
  assertEquals(refusedByReceiver.reason, "The receiver refused the message.");
  assertEquals(refusedByReceiver.answer, "no");
  const slow = await send(
    (() =>
      Promise.reject(
        Object.assign(new Error("x"), { name: "AbortError" }),
      )) as unknown as typeof fetch,
  );
  assertEquals(slow.reason, "The receiver did not answer in time.");
  const down = await send(
    (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch,
  );
  assertEquals(down.reason, "Bakery could not reach the receiver.");
});
