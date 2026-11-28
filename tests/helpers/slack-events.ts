type EventFixture = {
  app: { fetch(request: Request): Response | Promise<Response> };
  config: { publicBaseUrl: string };
};

async function slackSignature(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

export async function postSlackEvent(
  f: EventFixture,
  signingSecret: string,
  payload: unknown,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return await f.app.fetch(
    new Request(`${f.config.publicBaseUrl}/v1/webhooks/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": await slackSignature(
          timestamp,
          body,
          signingSecret,
        ),
      },
      body,
    }),
  );
}
