import { assert, assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import {
  APP_ID,
  CLIENT_SECRET,
  connectOnce,
  fakeSlack,
  open,
  slackCallback,
  TEAM_ID,
} from "../helpers/slack-connect.ts";

const SIGNING_SECRET = "slack-signing-secret-never-leaves";
const REPLACEMENT = "slack-signing-secret-replacement";
const REFUSED = "slack-signing-secret\u0007refused";
const encoder = new TextEncoder();

function captureConsole() {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) => {
          try {
            return typeof arg === "string" ? arg : JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(" "),
      );
    };
  }
  return {
    lines,
    restore: () => {
      methods.forEach((method, index) => (console[method] = original[index]));
    },
  };
}

async function signature(timestamp: string, body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

Deno.test("the Slack signing secret is in no response, audit row, stored plaintext or log line", async () => {
  const log = captureConsole();
  const startedAt = new Date();
  const o = await open(fakeSlack(), { signingSecret: SIGNING_SECRET });
  try {
    const bodies: string[] = [];
    const take = async (response: Response) => {
      bodies.push(await response.text());
      return response;
    };
    const read = async () => {
      const response = await take(
        await call(
          o.fixture,
          "GET",
          "/v1/integration-client-credentials/slack",
          o.fixture.adminCookie,
        ),
      );
      assertEquals(response.status, 200);
      return JSON.parse(bodies.at(-1)!) as { version: number };
    };
    const put = async (signingSecret: string, version: number) =>
      await take(
        await call(
          o.fixture,
          "PUT",
          "/v1/integration-client-credentials/slack",
          o.fixture.adminCookie,
          {
            body: {
              clientId: "1234.5678",
              clientSecret: CLIENT_SECRET,
              signingSecret,
            },
            headers: {
              "Idempotency-Key": crypto.randomUUID(),
              "If-Match": `"${version}"`,
            },
          },
        ),
      );

    const first = await read();
    assertEquals((await put(REFUSED, first.version)).status, 422);
    assertEquals((await put(REPLACEMENT, first.version)).status, 200);
    const connectionId = await connectOnce(o);
    const attempt = await take(
      await call(
        o.fixture,
        "POST",
        "/v1/integration-auth-attempts",
        o.fixture.adminCookie,
        {
          body: { provider: "slack", reconnectConnectionId: connectionId },
          headers: {
            "Bakery-Organization-Id": o.fixture.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      ),
    );
    const created = JSON.parse(bodies.at(-1)!) as { authorizationUrl: string };
    assertEquals(attempt.status, 201);
    await take(
      await slackCallback(o.fixture, {
        code: "slack-code-again",
        state: new URL(created.authorizationUrl).searchParams.get("state")!,
      }),
    );
    for (const secret of [REPLACEMENT, "a-signing-secret-nobody-saved"]) {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: `Ev${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        api_app_id: APP_ID,
        team_id: TEAM_ID,
        authorizations: [{ team_id: TEAM_ID, user_id: "U0TESTBOT" }],
        event: {
          type: "app_mention",
          channel: "C0TESTCHAN",
          user: "U0TESTUSER",
          ts: "1800000000.000200",
          text: "<@U0TESTBOT> hello",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      await take(
        await o.fixture.app.fetch(
          new Request(
            `${o.fixture.config.publicBaseUrl}/v1/webhooks/slack/events`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-slack-request-timestamp": timestamp,
                "x-slack-signature": await signature(timestamp, body, secret),
              },
              body,
            },
          ),
        ),
      );
    }
    await read();

    const audits = await o.fixture.pgDatabase.query<{ details: string }>(
      `select coalesce(details::text, '') as details from bakery.audit_events
        where created_at >= $1`,
      [startedAt],
    );
    assert(audits.rows.length >= 4);
    const plaintext = await o.fixture.pgDatabase.query<{ text: string }>(
      `select encode(version.ciphertext, 'escape') as text
         from bakery.secret_versions version
         join bakery.secrets secret on secret.id = version.secret_id
        where secret.provider = 'slack'`,
    );
    assert(plaintext.rows.length >= 2);
    const surfaces = [
      ...bodies.map((text) => ["response", text]),
      ...audits.rows.map((row) => ["audit", row.details]),
      ...plaintext.rows.map((row) => ["stored", row.text]),
      ...log.lines.map((line) => ["log", line]),
    ];
    for (const [surface, text] of surfaces) {
      for (const secret of [SIGNING_SECRET, REPLACEMENT, REFUSED]) {
        assert(
          !text!.includes(secret),
          `${surface} carries the signing secret: ${text}`,
        );
      }
    }
  } finally {
    log.restore();
    await o.finish();
  }
});
