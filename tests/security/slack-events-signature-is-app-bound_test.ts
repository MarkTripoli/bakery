import { assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/modules/integrations/intake-signature.ts";
import { receiveSlackEvent } from "../../apps/server/src/modules/integrations/slack-intake.ts";
import type { SlackInstallationRecord } from "../../apps/server/src/modules/integrations/slack-receipts.ts";

const encoder = new TextEncoder();
const nowMs = 1_800_000_000_000;

async function sign(
  timestamp: string,
  body: string,
  secret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
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
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

Deno.test("a Slack app signature cannot authorize another app", async () => {
  const signedAppId = "A0APP";
  const namedAppInstallation: SlackInstallationRecord = {
    installationId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    appId: "A1OTHER",
    teamId: "T0TEAM",
    botUserId: "U0BOT",
    signingSecretId: null,
    status: "active",
  };
  const body = JSON.stringify({
    type: "event_callback",
    event_id: "Ev1",
    api_app_id: namedAppInstallation.appId,
    team_id: namedAppInstallation.teamId,
    authorizations: [{
      team_id: namedAppInstallation.teamId,
      user_id: namedAppInstallation.botUserId,
    }],
    event: {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "1.1",
      text: "hi",
    },
  });
  const timestamp = String(Math.floor(nowMs / 1000));
  const signingSecret = encoder.encode("app-a-secret");
  let commitCount = 0;
  const requestedAppIds: string[] = [];
  const result = await receiveSlackEvent({
    raw: encoder.encode(body),
    signatureHeader: await sign(timestamp, body, signingSecret),
    timestampHeader: timestamp,
  }, {
    signingSecrets: (appId) => {
      requestedAppIds.push(appId);
      return Promise.resolve([{ appId: signedAppId, secret: signingSecret }]);
    },
    findInstallation: () => Promise.resolve(namedAppInstallation),
    commit: () => {
      commitCount += 1;
      return Promise.resolve({
        kind: "recorded",
        receiptId: crypto.randomUUID(),
      });
    },
    sha256Hex,
    now: () => nowMs,
  });

  assertEquals(result, { kind: "refused", code: "AUTH_INVALID" });
  assertEquals(commitCount, 0);
  assertEquals(requestedAppIds, [namedAppInstallation.appId]);
});
