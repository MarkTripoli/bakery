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

Deno.test("the manifest connects with an OAuth2 workspace install and stores only the bot token", () => {
  const connect = slackProviderManifest.connect;
  assertEquals(connect.kind, "oauth2");
  if (connect.kind !== "oauth2") return;
  assertEquals(connect.siteSelection, true);
  assertEquals([...connect.secretSlots], ["access_token"]);
});

Deno.test("the app registration is exactly the client pair the host stores", () => {
  const registration = slackProviderManifest.appRegistration;
  assertEquals(registration?.kind, "client-credentials");
  if (registration?.kind !== "client-credentials") return;
  assertEquals(
    registration.fields.map((field) => field.id),
    ["client_id", "client_secret"],
  );
  assertEquals(
    registration.fields.map((field) => field.secret),
    [false, true],
  );
});

Deno.test("the bot asks for the features that exist and no private-channel history", () => {
  assertEquals([...SLACK_BOT_SCOPES], [
    "app_mentions:read",
    "channels:history",
    "channels:read",
    "chat:write",
    "commands",
  ]);
  assertEquals(SLACK_BOT_SCOPES.includes("groups:history" as never), false);
  assertEquals(
    [...slackServerProvider.impl.connect.scopes],
    [...SLACK_BOT_SCOPES],
  );
});

Deno.test("the credential is the stored bot token as a bearer, with the host's own expiry", async () => {
  const token = await slackServerProvider.impl.credentials.mint({
    binding: {},
    permissions: {},
    secrets: { access_token: encoder.encode("xoxb-token") },
    ctx: context(() => json({ ok: true })),
  });
  assertEquals(token.token, "xoxb-token");
  assertEquals(token.placement, "bearer");
  assertEquals(
    token.expiresAt.getTime() > Date.now() + 300 * 24 * 3_600_000,
    true,
  );
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
  const workspace = {
    ok: true,
    access_token: "xoxb-token",
    token_type: "bot",
    scope: "chat:write",
    bot_user_id: "U01234567",
    app_id: "A01234567",
    team: { id: "T01234567", name: "Acme" },
    is_enterprise_install: false,
  };
  assertEquals(slackTokenResponseSchema.safeParse(workspace).success, true);
  assertEquals(
    slackTokenResponseSchema.safeParse({
      ...workspace,
      is_enterprise_install: true,
    }).success,
    false,
  );
});

Deno.test("a refusal this build does not name still offers a retry", async () => {
  assertEquals(
    await slackServerProvider.impl.health.check(
      context(() => json({ ok: false, error: "not_authed" })),
    ),
    { healthy: false, reason: "dependency_refused", retryable: true },
  );
});
