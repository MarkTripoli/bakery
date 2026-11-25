import { assert, assertEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/modules/integrations/intake-signature.ts";
import { receiveSlackEvent } from "../../apps/server/src/modules/integrations/slack-intake.ts";
import type { SlackInstallationRecord } from "../../apps/server/src/modules/integrations/slack-receipts.ts";
import {
  commitSlackReceipt,
  registerSlackInstallation,
} from "../../apps/server/src/modules/integrations/slack-receipts.ts";
import type { SlackInstallation } from "../../apps/server/src/modules/integrations/slack-scope.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import { openInstallationFixture } from "../helpers/installation-settings.ts";

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
        outcome: "accepted",
      });
    },
    sha256Hex,
    now: () => nowMs,
  });

  assertEquals(result, { kind: "refused", code: "AUTH_INVALID" });
  assertEquals(commitCount, 0);
  assertEquals(requestedAppIds, [namedAppInstallation.appId]);
});

Deno.test("a Slack receipt cannot bind one app to another app's installation", async () => {
  const fixture = await openInstallationFixture();
  try {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const first: SlackInstallation = {
      kind: "workspace",
      appId: `A${suffix.slice(0, 10)}`,
      teamId: `T${suffix.slice(10, 20)}`,
      botUserId: `U${suffix.slice(20, 30)}`,
      scopes: [],
    };
    const second: SlackInstallation = {
      kind: "workspace",
      appId: `A${suffix.slice(1, 11)}`,
      teamId: `T${suffix.slice(11, 21)}`,
      botUserId: `U${suffix.slice(21, 31)}`,
      scopes: [],
    };
    const firstRegistration = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        registerSlackInstallation(transaction, {
          organizationId: fixture.organizationId,
          installation: first,
        }),
    );
    const secondRegistration = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        registerSlackInstallation(transaction, {
          organizationId: fixture.organizationId,
          installation: second,
        }),
    );
    assert(firstRegistration.ok);
    assert(secondRegistration.ok);
    assertEquals(
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          commitSlackReceipt(transaction, {
            installationId: secondRegistration.installation.installationId,
            appId: first.appId,
            eventId: "EvAppBound1",
            payloadDigest: "a".repeat(64),
            decision: {
              kind: "mention",
              eventId: "EvAppBound1",
              channelId: "C0CHANNEL",
              userId: "U0AUTHOR",
              ts: "1.1",
              threadTs: "1.1",
              text: "secure",
            },
            now: new Date(),
          }),
      ),
      { kind: "inactive" },
    );
    const receipts = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.slack_event_receipts
        where event_id = 'EvAppBound1'`,
    );
    assertEquals(receipts.rows[0]?.count, "0");
  } finally {
    await fixture.finish();
  }
});

type SlackAuthorityCounts = {
  conversations: number;
  bindings: number;
  receipts: number;
  messages: number;
  turns: number;
  events: number;
  outbox: number;
  audits: number;
};

async function authorityCounts(
  fixture: Awaited<ReturnType<typeof openInstallationFixture>>,
): Promise<SlackAuthorityCounts> {
  const result = await fixture.pgDatabase.query<SlackAuthorityCounts>(
    `select
       (select count(*)::int from bakery.conversations
         where organization_id = $1) as conversations,
       (select count(*)::int from bakery.slack_thread_bindings
         where organization_id = $1) as bindings,
       (select count(*)::int from bakery.slack_event_receipts receipt
          join bakery.slack_installations installation
            on installation.id = receipt.installation_id
         where installation.organization_id = $1) as receipts,
       (select count(*)::int from bakery.messages
         where organization_id = $1) as messages,
       (select count(*)::int from bakery.conversation_turns
         where organization_id = $1) as turns,
       (select count(*)::int from bakery.domain_events
         where organization_id = $1) as events,
       (select count(*)::int from bakery.outbox
         where organization_id = $1) as outbox,
       (select count(*)::int from bakery.audit_events
         where organization_id = $1) as audits`,
    [fixture.organizationId],
  );
  const counts = result.rows[0];
  if (!counts) throw new Error("SLACK_AUTHORITY_COUNTS_MISSING");
  return counts;
}

Deno.test("Slack coordinator admission requires live human action authority", async () => {
  const fixture = await openInstallationFixture(true);
  try {
    const developerId = fixture.developerId;
    assert(typeof developerId === "string");
    const value: SlackInstallation = {
      kind: "workspace",
      appId: `A${
        crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
      }`,
      teamId: `T${
        crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
      }`,
      botUserId: `U${
        crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
      }`,
      scopes: [],
    };
    const registered = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        registerSlackInstallation(transaction, {
          organizationId: fixture.organizationId,
          installation: value,
        }),
    );
    assert(registered.ok);
    const adminLink = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        linkSlackIdentity(transaction, {
          organizationId: fixture.organizationId,
          principalId: fixture.adminId,
          identity: {
            appId: value.appId,
            teamId: value.teamId,
            userId: "U0ADMIN",
          },
          verifiedAt: new Date(),
        }),
    );
    assert(adminLink.ok);
    const accepted = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        commitSlackReceipt(transaction, {
          installationId: registered.installation.installationId,
          appId: value.appId,
          eventId: "EvAuthAdmin",
          payloadDigest: "b".repeat(64),
          decision: {
            kind: "mention",
            eventId: "EvAuthAdmin",
            channelId: "C0AUTH",
            userId: "U0ADMIN",
            ts: "1.1",
            threadTs: "1.1",
            text: "authorized",
          },
          now: new Date(),
        }),
    );
    assertEquals(accepted.kind, "recorded");
    assertEquals(
      accepted.kind === "recorded" ? accepted.outcome : null,
      "accepted",
    );
    const binding = await fixture.pgDatabase.query<{
      conversation_id: string;
    }>(
      `select conversation_id from bakery.slack_thread_bindings
        where organization_id = $1 and installation_id = $2
          and channel_id = 'C0AUTH' and thread_ts = '1.1'`,
      [fixture.organizationId, registered.installation.installationId],
    );
    const conversationId = binding.rows[0]?.conversation_id;
    assert(typeof conversationId === "string");

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'guest'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, developerId],
    );
    const guestLink = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        linkSlackIdentity(transaction, {
          organizationId: fixture.organizationId,
          principalId: developerId,
          identity: {
            appId: value.appId,
            teamId: value.teamId,
            userId: "U0GUEST",
          },
          verifiedAt: new Date(),
        }),
    );
    assert(guestLink.ok);
    const beforeGuest = await authorityCounts(fixture);
    const guestDenied = await assertRejects(
      () =>
        withPgTransaction(
          fixture.runtimePgDatabase,
          (transaction) =>
            commitSlackReceipt(transaction, {
              installationId: registered.installation.installationId,
              appId: value.appId,
              eventId: "EvAuthGuest",
              payloadDigest: "c".repeat(64),
              decision: {
                kind: "mention",
                eventId: "EvAuthGuest",
                channelId: "C0GUEST",
                userId: "U0GUEST",
                ts: "2.1",
                threadTs: "2.1",
                text: "forbidden",
              },
              now: new Date(),
            }),
        ),
      StandardError,
    );
    assertEquals(guestDenied.code, "RESOURCE_NOT_FOUND");
    assertEquals(await authorityCounts(fixture), beforeGuest);

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'viewer'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, developerId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversation_access_grants (
         organization_id, conversation_id, principal_id, granted_by)
       values ($1, $2, $3, $4)`,
      [
        fixture.organizationId,
        conversationId,
        developerId,
        fixture.adminId,
      ],
    );
    const beforeGrantOnly = await authorityCounts(fixture);
    const grantOnlyDenied = await assertRejects(
      () =>
        withPgTransaction(
          fixture.runtimePgDatabase,
          (transaction) =>
            commitSlackReceipt(transaction, {
              installationId: registered.installation.installationId,
              appId: value.appId,
              eventId: "EvAuthGrant",
              payloadDigest: "d".repeat(64),
              decision: {
                kind: "thread_reply",
                eventId: "EvAuthGrant",
                channelId: "C0AUTH",
                userId: "U0GUEST",
                ts: "1.2",
                threadTs: "1.1",
                text: "grant only",
              },
              now: new Date(),
            }),
        ),
      StandardError,
    );
    assertEquals(grantOnlyDenied.code, "AUTH_FORBIDDEN");
    assertEquals(await authorityCounts(fixture), beforeGrantOnly);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.slack_installations where organization_id = $1",
      [fixture.organizationId],
    );
    await fixture.finish();
  }
});
