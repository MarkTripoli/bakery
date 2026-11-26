import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  defineAction,
  defineIntegration,
  IntegrationActivationError,
} from "../../packages/integration-sdk/mod.ts";
import {
  defineServerProvider,
  serverProviderDefects,
} from "../../packages/integration-sdk/provider.ts";
import { slackProviderManifest } from "../../packages/integration-slack/src/manifest.ts";
import { slackServerProvider } from "../../packages/integration-slack/src/server/provider.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import type { HostAuthProfile } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import {
  type CredentialRequest,
  opaqueCredential,
} from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import {
  type IntegrationInvokeDeps,
  invokeIntegration,
} from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import {
  createProviderCredentialPort,
  decodeSecretSlots,
  encodeSecretSlots,
  routeCredentialsByProfile,
} from "../../apps/server/src/modules/integrations/provider-credential-port.ts";

const PROFILE = "mockchat-bot";
const GATE_ID = "bakery.mockchat";
const READ = { id: "mockchat.channel.read", version: 1 } as const;
const POST = { id: "mockchat.message.post", version: 1 } as const;
const LIST = { id: "mockchat.messages.list", version: 1 } as const;

const manifest = {
  ...slackProviderManifest,
  slug: "mockchat",
  integrationId: GATE_ID,
  providerUuid: "6a7b6c3e-2f0b-5d1e-9a4c-0d6f2b1e7a90",
  nameKey: "integrations.slack.name",
} as const;

const channelBinding = z.strictObject({
  teamId: z.string().regex(/^T[A-Z0-9]+$/).describe(
    "Workspace the channel belongs to, recorded when it was selected.",
  ),
  channelId: z.string().regex(/^[CD][A-Z0-9]+$/).describe(
    "Channel or direct-message conversation the bot writes to.",
  ),
}).describe("Host-recorded binding of one mock chat conversation.");

const profile: HostAuthProfile = {
  id: PROFILE,
  origin: "https://chat.example.test",
  credentialPlacement: "authorization-bearer",
  fixedHeaders: {},
  providerPermissions: { chat: ["read", "write"] },
  resourceKinds: {
    "mockchat.channel": {
      bindingSchema: channelBinding,
      projectable: [],
      externalIdentity: { account: "teamId", resource: "channelId" },
    },
  },
};

const channel = z.object({
  id: z.string().describe("Conversation id the provider answered for."),
  name: z.string().describe("Conversation name as the provider shows it."),
}).describe("Provider conversation projection; other fields are dropped.");

const posted = z.object({
  ts: z.string().describe("Provider timestamp naming the posted message."),
}).describe("Provider receipt for a posted message.");

const noInput = z.strictObject({}).describe(
  "No arguments: the conversation comes from the bound resource.",
);
const postInput = z.strictObject({
  text: z.string().min(1).max(4000).describe("Message text to post."),
}).describe("Arguments of a message post.");

const readChannel = defineAction({
  id: READ.id,
  version: READ.version,
  input: noInput,
  output: channel,
  effect: "read",
  resourceKind: "mockchat.channel",
  requests: [READ],
  providerPermissions: { chat: "read" },
  async execute(ctx) {
    return channel.parse(await ctx.provider.request(READ, {}));
  },
});

const postMessage = defineAction({
  id: POST.id,
  version: POST.version,
  input: postInput,
  output: posted,
  effect: "reconcile",
  resourceKind: "mockchat.channel",
  requests: [POST],
  reconcileRequests: [LIST],
  providerPermissions: { chat: "write" },
  async execute(ctx, input) {
    return posted.parse(
      await ctx.provider.request(POST, { text: input.text }),
    );
  },
  reconcile: () => Promise.resolve({ status: "uncertain" as const }),
});

const gateSource = (id = GATE_ID, authenticationProfile = PROFILE) => ({
  sdkVersion: 1,
  id,
  version: "1.0.0",
  authenticationProfile,
  bakery: { required: [], optional: [] },
  actions: [{ ...READ }, { ...POST }],
  resourceKinds: ["mockchat.channel"],
  requests: [
    {
      ...READ,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "mockchat.channel",
      pathTemplate: "/conversations/{channel}",
      pathParams: { channel: "binding:channelId" },
      input: noInput,
      query: [],
      response: channel,
      maxResponseBytes: 16_384,
      providerPermissions: { chat: "read" },
    },
    {
      ...POST,
      method: "POST",
      effect: "write",
      idempotent: false,
      resourceKind: "mockchat.channel",
      pathTemplate: "/conversations/{channel}/messages",
      pathParams: { channel: "binding:channelId" },
      input: postInput,
      query: [],
      body: postInput,
      response: posted,
      maxResponseBytes: 16_384,
      providerPermissions: { chat: "write" },
    },
    {
      ...LIST,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "mockchat.channel",
      pathTemplate: "/conversations/{channel}/messages",
      pathParams: { channel: "binding:channelId" },
      input: noInput,
      query: [],
      response: z.array(posted).max(100).describe(
        "One page of recent messages inspected when a post is uncertain.",
      ),
      maxResponseBytes: 65_536,
      providerPermissions: { chat: "read" },
    },
  ],
  optionalFeatures: [],
  subscriptions: [],
});

const handlers = {
  [`${READ.id}@${READ.version}`]: readChannel,
  [`${POST.id}@${POST.version}`]: postMessage,
};

const gate = defineIntegration(gateSource(), handlers);

const minted: { slots: string[]; permissions: unknown }[] = [];
const provider = defineServerProvider(manifest, {
  ...slackServerProvider.impl,
  hostProfile: PROFILE,
  gate,
  credentials: {
    secretSlots: ["access_token"],
    mint({ secrets, permissions }) {
      minted.push({ slots: Object.keys(secrets), permissions });
      const token = new TextDecoder().decode(secrets.access_token);
      return Promise.resolve({
        token: `minted-${token}`,
        expiresAt: null,
        placement: "bearer" as const,
      });
    },
  },
});

const activate = () =>
  activateDeployedIntegrations([], undefined, [manifest], [gate], {
    [PROFILE]: profile,
  });

Deno.test("a provider package's gate actions are registered under its own gate id", () => {
  assertEquals(serverProviderDefects(provider), []);
  const registry = activate();
  const read = registry.findAction(GATE_ID, READ.id, READ.version);
  const post = registry.findAction(GATE_ID, POST.id, POST.version);
  assertEquals(read?.effect, "read");
  assertEquals(post?.effect, "write");
  assertEquals(registry.getProviderByIntegrationId(GATE_ID)?.slug, "mockchat");
});

Deno.test("gate actions for another provider, or another profile, are a provider defect", () => {
  const foreign = defineServerProvider(manifest, {
    ...provider.impl,
    gate: defineIntegration(gateSource("bakery.other"), handlers),
  });
  assert(
    serverProviderDefects(foreign).some((defect) =>
      defect.path === "impl.gate.manifest.id"
    ),
  );
  const elsewhere = defineServerProvider(manifest, {
    ...provider.impl,
    gate: defineIntegration(gateSource(GATE_ID, "github-app"), handlers),
  });
  assert(
    serverProviderDefects(elsewhere).some((defect) =>
      defect.path === "impl.gate.manifest.authenticationProfile"
    ),
  );
});

Deno.test("gate actions with no provider package, or a plain definition on a provider's id, stop activation", () => {
  const unowned = assertThrows(
    () =>
      activateDeployedIntegrations([], undefined, [], [gate], {
        [PROFILE]: profile,
      }),
    IntegrationActivationError,
  );
  assert(
    unowned.defects.some((defect) => defect.code === "provider-gate-unowned"),
  );
  const shadow = assertThrows(
    () =>
      activateDeployedIntegrations([gate], undefined, [manifest], [], {
        [PROFILE]: profile,
      }),
    IntegrationActivationError,
  );
  assert(
    shadow.defects.some((defect) =>
      defect.code === "integration-duplicate-provider"
    ),
  );
});

function snapshotFor(
  registry: ReturnType<typeof activate>,
  ids: {
    organizationId: string;
    principalId: string;
    connectionId: string;
    resourceId: string;
  },
): AuthoritySnapshot {
  const grant = {
    grantId: crypto.randomUUID(),
    organizationId: ids.organizationId,
    connectionId: ids.connectionId,
    subjectType: "principal",
    subjectPrincipalId: ids.principalId,
    direction: "out_of_bakery",
    capability: READ.id,
    actionVersion: READ.version,
    resourceId: ids.resourceId,
    revokedAt: null,
    policyRevision: 1,
  } as IntegrationGrantRecord;
  return {
    organizationId: ids.organizationId,
    actor: {
      principalId: ids.principalId,
      subjectType: "principal",
      active: true,
      permissions: ["integrationConnection:invoke"],
    },
    install: {
      id: "install-mockchat",
      providerId: GATE_ID,
      manifestDigest: registry.get(GATE_ID)!.manifestDigest,
      enabled: true,
      approvedScopes: [],
    },
    connection: {
      id: ids.connectionId,
      installId: "install-mockchat",
      state: "active",
      providerPermissions: { chat: "read" },
    },
    resource: {
      id: ids.resourceId,
      kind: "mockchat.channel",
      selected: true,
      available: true,
      binding: { teamId: "T1", channelId: "D123" },
    },
    grants: [grant],
    policyRevision: 1,
  };
}

Deno.test("a provider-tier read goes through the gate with the token the provider mints", async () => {
  const registry = activate();
  const ids = {
    organizationId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
  };
  const snapshot = snapshotFor(registry, ids);
  const sent: { url: string; authorization: string | null }[] = [];
  const reads: CredentialRequest[] = [];
  const broker = createBrokerForTesting({
    registry,
    credentials: createProviderCredentialPort({
      providers: { providers: [provider] },
      readStoredSlots: (request) => {
        reads.push(request);
        return Promise.resolve(encodeSecretSlots({ access_token: "xoxb-1" }));
      },
    }),
    fetch: (input, init) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(
        Response.json({ id: "D123", name: "dm", extra: "dropped" }),
      );
    },
    snapshotPort: { load: () => Promise.resolve(snapshot) },
    generationOf: () => 0,
    profiles: { [PROFILE]: profile },
  });
  const deps = {
    registry,
    snapshots: { load: () => Promise.resolve(snapshot) },
    providerRequests: broker,
  } as unknown as IntegrationInvokeDeps;
  const result = await invokeIntegration(deps, {
    organizationId: ids.organizationId,
    actorRef: ids.principalId,
    connectionId: ids.connectionId,
    input: {
      actionId: READ.id,
      actionVersion: READ.version,
      resourceId: ids.resourceId,
      arguments: {},
    },
  });
  assertEquals(result.route, "direct");
  assertEquals(result.output, { id: "D123", name: "dm" });
  assertEquals(sent.length, 1);
  assertEquals(new URL(sent[0]!.url).pathname, "/conversations/D123");
  assertEquals(sent[0]!.authorization, "Bearer minted-xoxb-1");
  assertEquals(reads[0]!.connectionId, ids.connectionId);
  assertEquals(minted.at(-1)?.slots, ["access_token"]);
});

const credentialRequest = (
  overrides: Partial<CredentialRequest> = {},
): CredentialRequest => ({
  organizationId: crypto.randomUUID(),
  connectionId: crypto.randomUUID(),
  resourceId: crypto.randomUUID(),
  profileId: PROFILE,
  providerPermissions: { chat: "write" },
  generation: 0,
  subject: { installId: crypto.randomUUID(), resourceKind: "mockchat.channel" },
  ...overrides,
});

Deno.test("the provider credential port refuses offline runs, missing secrets, other placements and unknown profiles", async () => {
  const stored = encodeSecretSlots({ access_token: "xoxb-2" });
  const port = createProviderCredentialPort({
    providers: { providers: [provider] },
    readStoredSlots: () => Promise.resolve(stored),
  });
  const reason = async (promise: Promise<unknown>) =>
    ((await assertRejects(() => promise)) as { params?: { reason?: string } })
      .params?.reason;
  assertEquals(
    await reason(
      port.resolve(credentialRequest({ runEnvironment: "offline" })),
    ),
    "environment_offline",
  );
  assertEquals(
    await reason(port.resolve(credentialRequest({ profileId: "nobody" }))),
    "unknown_profile",
  );
  const empty = createProviderCredentialPort({
    providers: { providers: [provider] },
    readStoredSlots: () => Promise.resolve(null),
  });
  assertEquals(
    await reason(empty.resolve(credentialRequest())),
    "auth_required",
  );
  const basic = defineServerProvider(manifest, {
    ...provider.impl,
    credentials: {
      secretSlots: ["access_token"],
      mint: () =>
        Promise.resolve({
          token: "user:pass",
          expiresAt: null,
          placement: "basic" as const,
        }),
    },
  });
  const basicPort = createProviderCredentialPort({
    providers: { providers: [basic] },
    readStoredSlots: () => Promise.resolve(stored),
  });
  assertEquals(
    await reason(basicPort.resolve(credentialRequest())),
    "auth_required",
  );
  assertEquals(
    await port.resolve(credentialRequest()),
    opaqueCredential("minted-xoxb-2"),
  );
});

Deno.test("GitHub keeps its installation tokens; every other profile mints through its provider", async () => {
  const seen: string[] = [];
  const route = routeCredentialsByProfile(
    {
      resolve:
        () => (seen.push("installation"),
          Promise.resolve(opaqueCredential("ghs"))),
    },
    {
      resolve:
        () => (seen.push("provider"),
          Promise.resolve(opaqueCredential("xoxb"))),
    },
    new Set(["github-app"]),
  );
  await route.resolve(credentialRequest({ profileId: "github-app" }));
  await route.resolve(credentialRequest());
  assertEquals(seen, ["installation", "provider"]);
});

Deno.test("stored secret slots round-trip as bytes, and only the slots a strategy names are opened", () => {
  const stored = encodeSecretSlots({ access_token: "tök", refresh_token: "r" });
  const opened = decodeSecretSlots(stored, ["access_token"]);
  assertEquals(Object.keys(opened), ["access_token"]);
  assertEquals(new TextDecoder().decode(opened.access_token), "tök");
  assertThrows(() => encodeSecretSlots({ "Bad Slot": "x" }));
});
