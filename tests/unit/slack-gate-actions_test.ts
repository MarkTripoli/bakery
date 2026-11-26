import { assertEquals, assertRejects } from "@std/assert";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  authorizeInvocation,
  createActionContext,
  createReconciliationContext,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { HOST_AUTH_PROFILES } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import {
  createProviderCredentialPort,
  encodeSecretSlots,
} from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import { grantedScopes } from "../../apps/server/src/modules/integrations/oauth2-connect.ts";
import { slackProviderManifest } from "../../packages/integration-slack/src/manifest.ts";
import {
  SLACK_DM_OPEN,
  SLACK_GATE_ID,
  SLACK_MESSAGE_POST,
  SLACK_MESSAGE_UPDATE,
  SlackApiError,
  slackGate,
} from "../../packages/integration-slack/src/server/gate.ts";
import {
  SLACK_BOT_SCOPES,
  slackServerProvider,
} from "../../packages/integration-slack/src/server/provider.ts";

const DM = "D0DELIVERY";
const TS = "1700000000.000100";

type Sent = { method: string; path: string; query: string; body: unknown };

function setup(reply: (request: Sent) => unknown) {
  const registry = activateDeployedIntegrations(
    [],
    undefined,
    [slackProviderManifest],
    [slackGate],
  );
  const ids = {
    organizationId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    installId: crypto.randomUUID(),
  };
  const grant = (action: { id: string; version: number }) =>
    ({
      grantId: crypto.randomUUID(),
      organizationId: ids.organizationId,
      connectionId: ids.connectionId,
      subjectType: "principal",
      subjectPrincipalId: ids.principalId,
      direction: "out_of_bakery",
      capability: action.id,
      actionVersion: action.version,
      resourceId: ids.resourceId,
      revokedAt: null,
      policyRevision: 1,
    }) as IntegrationGrantRecord;
  const snapshot: AuthoritySnapshot = {
    organizationId: ids.organizationId,
    actor: {
      principalId: ids.principalId,
      subjectType: "principal",
      active: true,
      permissions: ["integrationConnection:invoke"],
    },
    install: {
      id: ids.installId,
      providerId: SLACK_GATE_ID,
      manifestDigest: registry.get(SLACK_GATE_ID)!.manifestDigest,
      enabled: true,
      approvedScopes: [],
    },
    connection: {
      id: ids.connectionId,
      installId: ids.installId,
      state: "active",
      providerPermissions: grantedScopes(slackServerProvider.impl.connect, {
        access_token: "xoxb-unit",
        scope: SLACK_BOT_SCOPES.join(","),
      }),
    },
    resource: {
      id: ids.resourceId,
      kind: "slack.workspace",
      selected: true,
      available: true,
      binding: { teamId: "T0TEAM", botUserId: "U0BOT" },
    },
    grants: [SLACK_DM_OPEN, SLACK_MESSAGE_POST, SLACK_MESSAGE_UPDATE].map(
      grant,
    ),
    policyRevision: 1,
  };
  const sent: Sent[] = [];
  const authorizations: (string | null)[] = [];
  const port = { load: () => Promise.resolve(snapshot) };
  const broker = createBrokerForTesting({
    registry,
    credentials: createProviderCredentialPort({
      providers: { providers: [slackServerProvider] },
      readStoredSlots: () =>
        Promise.resolve(encodeSecretSlots({ access_token: "xoxb-unit" })),
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const text = init?.body === undefined || init.body === null
        ? ""
        : await new Response(init.body).text();
      const request = {
        method: init?.method ?? "GET",
        path: url.pathname,
        query: url.search,
        body: text === "" ? undefined : JSON.parse(text),
      };
      sent.push(request);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json(reply(request));
    },
    snapshotPort: port,
    generationOf: () => 0,
    profiles: HOST_AUTH_PROFILES,
  });
  const deps = { registry, snapshots: port, providerRequests: broker };
  const bind = (
    action: { id: string; version: number },
    args: Record<string, unknown>,
  ) =>
    authorizeInvocation(registry, port, {
      organizationId: ids.organizationId,
      actorRef: ids.principalId,
      connectionId: ids.connectionId,
      effectId: crypto.randomUUID(),
    }, {
      actionId: action.id,
      actionVersion: action.version,
      resourceId: ids.resourceId,
      arguments: args,
    });
  const handler = (action: { id: string; version: number }) =>
    registry.findAction(SLACK_GATE_ID, action.id, action.version)!.handler;
  const execute = async (
    action: { id: string; version: number },
    args: Record<string, unknown>,
  ) =>
    await handler(action).invoke(
      createActionContext(await bind(action, args), deps),
      args,
    );
  const reconcile = async (
    action: { id: string; version: number },
    args: Record<string, unknown>,
  ) =>
    await handler(action).invokeReconcile(
      createReconciliationContext(await bind(action, args), args, deps),
    );
  return { sent, authorizations, execute, reconcile };
}

const post = {
  channelId: DM,
  text: "A request needs you [bkr-00000001]",
  marker: "[bkr-00000001]",
};

Deno.test("the Slack scopes become the permission levels the gate compares", () => {
  assertEquals(
    grantedScopes(slackServerProvider.impl.connect, {
      access_token: "x",
      scope: SLACK_BOT_SCOPES.join(","),
    }),
    {
      app_mentions: "read",
      channels: "read",
      chat: "write",
      im: "write",
    },
  );
  assertEquals(
    grantedScopes(slackServerProvider.impl.connect, {
      access_token: "x",
      scope: "im:history commands chat:write.public users:read",
    }),
    { im: "read", users: "read" },
  );
});

Deno.test("opening a DM posts the user to conversations.open and answers the channel", async () => {
  const gate = setup(() => ({ ok: true, channel: { id: DM } }));
  assertEquals(await gate.execute(SLACK_DM_OPEN, { userId: "U0PERSON" }), {
    channelId: DM,
  });
  assertEquals(gate.sent, [{
    method: "POST",
    path: "/api/conversations.open",
    query: "",
    body: { users: "U0PERSON" },
  }]);
  assertEquals(gate.authorizations, ["Bearer xoxb-unit"]);
});

Deno.test("a post goes to chat.postMessage and answers the channel and timestamp", async () => {
  const gate = setup(() => ({ ok: true, channel: DM, ts: TS }));
  assertEquals(await gate.execute(SLACK_MESSAGE_POST, post), {
    channelId: DM,
    ts: TS,
  });
  assertEquals(gate.sent, [{
    method: "POST",
    path: "/api/chat.postMessage",
    query: "",
    body: { channel: DM, text: post.text },
  }]);
});

Deno.test("Slack's ok:false is an error naming Slack's reason", async () => {
  const gate = setup(() => ({ ok: false, error: "channel_not_found" }));
  const error = await assertRejects(
    () => gate.execute(SLACK_MESSAGE_POST, post),
    SlackApiError,
  );
  assertEquals(error.code, "channel_not_found");
  assertEquals(
    error.message,
    "Slack refused chat.postMessage: channel_not_found.",
  );
});

Deno.test("a post whose text does not carry its marker is refused before Slack is called", async () => {
  const gate = setup(() => ({ ok: true, channel: DM, ts: TS }));
  const error = await assertRejects(
    () =>
      gate.execute(SLACK_MESSAGE_POST, { ...post, marker: "[bkr-missing]" }),
    SlackApiError,
  );
  assertEquals(error.code, "marker_missing");
  assertEquals(gate.sent, []);
});

Deno.test("an uncertain post is confirmed when recent history carries its marker", async () => {
  const gate = setup(() => ({
    ok: true,
    messages: [
      { ts: "1700000001.000200", text: "Something else" },
      { ts: TS, text: post.text },
    ],
  }));
  assertEquals(await gate.reconcile(SLACK_MESSAGE_POST, post), {
    status: "confirmed",
    result: { channelId: DM, ts: TS },
  });
  assertEquals(gate.sent, [{
    method: "GET",
    path: "/api/conversations.history",
    query: `?channel=${DM}&limit=50`,
    body: undefined,
  }]);
});

Deno.test("an uncertain post stays uncertain when no recent message carries its marker", async () => {
  const gate = setup(() => ({
    ok: true,
    messages: [{ ts: TS, text: "A request needs you [bkr-00000009]" }],
  }));
  assertEquals(await gate.reconcile(SLACK_MESSAGE_POST, post), {
    status: "uncertain",
  });
});

Deno.test("an update goes to chat.update and is confirmed by history showing the new text", async () => {
  const update = { channelId: DM, ts: TS, text: "Answered" };
  const gate = setup((request) =>
    request.path === "/api/chat.update"
      ? { ok: true, channel: DM, ts: TS }
      : { ok: true, messages: [{ ts: TS, text: "Answered" }] }
  );
  assertEquals(await gate.execute(SLACK_MESSAGE_UPDATE, update), {
    channelId: DM,
    ts: TS,
  });
  assertEquals(gate.sent[0]!.body, { channel: DM, ts: TS, text: "Answered" });
  assertEquals(await gate.reconcile(SLACK_MESSAGE_UPDATE, update), {
    status: "confirmed",
    result: { channelId: DM, ts: TS },
  });
  assertEquals(
    await gate.reconcile(SLACK_MESSAGE_UPDATE, { ...update, text: "Other" }),
    { status: "uncertain" },
  );
});

Deno.test("an uncertain DM open is confirmed by the bot's direct message with that user", async () => {
  const gate = setup(() => ({
    ok: true,
    channels: [{ id: "D0OTHER", user: "U0SOMEONE" }, {
      id: DM,
      user: "U0PERSON",
    }],
  }));
  assertEquals(await gate.reconcile(SLACK_DM_OPEN, { userId: "U0PERSON" }), {
    status: "confirmed",
    result: { channelId: DM },
  });
  assertEquals(await gate.reconcile(SLACK_DM_OPEN, { userId: "U0NOBODY" }), {
    status: "uncertain",
  });
  assertEquals(gate.sent[0]!.query, "?types=im&limit=200");
});
