import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  manifestDefects,
  serverProviderDefects,
} from "../../packages/integration-sdk/provider.ts";
import type { DriverContext } from "../../packages/integration-sdk/provider.ts";
import {
  SLACK_BOT_SCOPES,
  slackProviderManifest,
  slackServerProvider,
  slackTokenResponseSchema,
} from "../../packages/integration-slack/src/server/mod.ts";

const encoder = new TextEncoder();

const context = (respond: () => Response): DriverContext => ({
  provider: {
    send: async () => {
      const response = respond();
      return {
        status: response.status,
        headers: {},
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  },
  origin: {
    apiBaseUrl: new URL("https://slack.com/api"),
    webBaseUrl: new URL("https://slack.com"),
  },
  signal: new AbortController().signal,
  now: () => new Date("2026-11-24T00:00:00Z"),
});

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("the Slack manifest and implementation pass the SDK's own checks", () => {
  assertEquals(manifestDefects(slackProviderManifest), []);
  assertEquals(serverProviderDefects(slackServerProvider), []);
});

Deno.test("the manifest names a Slack provider that claims no port family yet", () => {
  assertEquals(slackProviderManifest.slug, "slack");
  assertEquals(slackProviderManifest.integrationId, "bakery.slack");
  assertEquals([...slackProviderManifest.families], []);
  assertEquals([...slackProviderManifest.resourceKinds], []);
  assertEquals(slackProviderManifest.ingress, null);
});

Deno.test("the manifest connects with OAuth2 and stores both rotation secrets", () => {
  const connect = slackProviderManifest.connect;
  assertEquals(connect.kind, "oauth2");
  if (connect.kind !== "oauth2") return;
  assertEquals(connect.siteSelection, true);
  assertEquals([...connect.secretSlots], ["access_token", "refresh_token"]);
});

Deno.test("Slack's documented plain, rotating and warning responses parse", () => {
  const plain = {
    ok: true,
    access_token: "xoxb-bot",
    token_type: "bot",
    scope: "commands,incoming-webhook",
    bot_user_id: "U0KRQLJ9H",
    app_id: "A0KRD7HC3",
    team: { name: "Slack Softball Team", id: "T9TK3CUKW" },
    enterprise: { name: "slack-sports", id: "E12345678" },
    authed_user: {
      id: "U1234",
      scope: "chat:write",
      access_token: "xoxp-user",
      token_type: "user",
    },
  } as const;
  assertEquals(slackTokenResponseSchema.parse(plain), plain);

  const rotating = {
    ...plain,
    access_token: "xoxe.xoxb-bot",
    expires_in: 43_200,
    refresh_token: "xoxe-1-bot",
    authed_user: {
      ...plain.authed_user,
      access_token: "xoxe.xoxp-user",
      expires_in: 43_200,
      refresh_token: "xoxe-1-user",
    },
  } as const;
  assertEquals(slackTokenResponseSchema.parse(rotating), rotating);

  const warned = {
    ...plain,
    warning: "slackbot_mcp_unavailable",
    response_metadata: {
      warnings: ["slackbot_mcp_unavailable"] as string[],
    },
  } as const;
  assertEquals(slackTokenResponseSchema.parse(warned), warned);
});

Deno.test("the app registration is the client pair plus the signing secret the host stores", () => {
  const registration = slackProviderManifest.appRegistration;
  assertEquals(registration?.kind, "client-credentials");
  if (registration?.kind !== "client-credentials") return;
  assertEquals(
    registration.fields.map((field) => field.id),
    ["client_id", "client_secret", "signing_secret"],
  );
  assertEquals(
    registration.fields.map((field) => field.secret),
    [false, true, true],
  );
});

Deno.test("the bot asks for the features that exist, direct messages included, and no private-channel history", () => {
  assertEquals([...SLACK_BOT_SCOPES], [
    "app_mentions:read",
    "channels:history",
    "channels:read",
    "chat:write",
    "commands",
    "im:history",
    "im:read",
    "im:write",
  ]);
  assertEquals(SLACK_BOT_SCOPES.includes("groups:history" as never), false);
  assertEquals(
    [...slackServerProvider.impl.connect.scopes],
    [...SLACK_BOT_SCOPES],
  );
});

Deno.test("the stored bot token is a bearer with no invented expiry", async () => {
  const token = await slackServerProvider.impl.credentials.mint({
    binding: {},
    permissions: {},
    secrets: { access_token: encoder.encode("xoxb-token") },
    ctx: context(() => json({ ok: true })),
  });
  assertEquals(token.token, "xoxb-token");
  assertEquals(token.placement, "bearer");
  assertEquals(token.expiresAt, null);
  assertThrows(() =>
    slackServerProvider.impl.credentials.mint({
      binding: {},
      permissions: {},
      secrets: {},
      ctx: context(() => json({ ok: true })),
    })
  );
});

Deno.test("identify names the workspace, not the person who installed the app", async () => {
  const identity = await slackServerProvider.impl.connect.identify(
    context(() => json({ ok: true, team_id: "T01234567", team: "Acme" })),
  );
  assertEquals(identity.externalAccountId, "T01234567");
  assertEquals(identity.accountLabel, "Acme");
  await assertRejects(() =>
    slackServerProvider.impl.connect.identify(
      context(() => json({ ok: false, error: "invalid_auth" })),
    )
  );
});

Deno.test("health separates a revocation a person must fix from a refusal that may clear", async () => {
  assertEquals(
    await slackServerProvider.impl.health.check(
      context(() => json({ ok: true, team_id: "T01234567" })),
    ),
    { healthy: true },
  );
  assertEquals(
    await slackServerProvider.impl.health.check(
      context(() => json({ ok: false, error: "invalid_auth" })),
    ),
    { healthy: false, reason: "auth_required", retryable: false },
  );
  const rateLimited = await slackServerProvider.impl.health.check(
    context(() => json({ ok: false, error: "ratelimited" }, 429)),
  );
  assertEquals(rateLimited.healthy, false);
  assertEquals(rateLimited.healthy === false && rateLimited.retryable, true);
  const unreachable = await slackServerProvider.impl.health.check({
    ...context(() => json({ ok: true })),
    provider: {
      send: () => Promise.reject(new Error("down")),
    },
  });
  assertEquals(
    unreachable.healthy === false && unreachable.retryable,
    true,
  );
});

Deno.test("discovery answers nothing because no resource kind is declared", async () => {
  assertEquals(
    await slackServerProvider.impl.discovery.list({
      resourceKindId: "channel",
      cursor: null,
      ctx: context(() => json({ ok: true })),
    }),
    { resources: [], nextCursor: null },
  );
});

Deno.test("an organization-wide grant never validates as a workspace installation", () => {
  const documented = {
    ok: true,
    access_token: "bot-access-token-placeholder",
    token_type: "bot",
    scope: "commands,incoming-webhook",
    bot_user_id: "U0KRQLJ9H",
    app_id: "A0KRD7HC3",
    team: { name: "Slack Softball Team", id: "T9TK3CUKW" },
    enterprise: { name: "slack-sports", id: "E12345678" },
    authed_user: {
      id: "U1234",
      scope: "chat:write",
      access_token: "user-access-token-placeholder",
      token_type: "user",
    },
    is_enterprise_install: false,
  };
  assertEquals(slackTokenResponseSchema.safeParse(documented).success, true);
  assertEquals(
    slackTokenResponseSchema.safeParse({ ...documented, enterprise: null })
      .success,
    true,
  );
  assertEquals(
    slackTokenResponseSchema.safeParse({
      ok: true,
      access_token: documented.access_token,
      bot_user_id: documented.bot_user_id,
      app_id: documented.app_id,
      team: documented.team,
    }).success,
    true,
  );
  assertEquals(
    slackTokenResponseSchema.safeParse({
      ...documented,
      is_enterprise_install: true,
    }).success,
    false,
  );
});

Deno.test("a refusal this build does not name still offers a retry", async () => {
  assertEquals(
    await slackServerProvider.impl.health.check(
      context(() => json({ ok: false, error: "fatal_error" })),
    ),
    { healthy: false, reason: "dependency_refused", retryable: true },
  );
});
