import { z } from "zod";
import {
  defineAction,
  defineIntegration,
} from "../../packages/integration-sdk/mod.ts";
import { defineServerProvider } from "../../packages/integration-sdk/provider.ts";
import { slackProviderManifest } from "../../packages/integration-slack/src/manifest.ts";
import { slackServerProvider } from "../../packages/integration-slack/src/server/provider.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import type { HostAuthProfile } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";

export const PROFILE = "mockchat-bot";
export const GATE_ID = "bakery.mockchat";
export const READ = { id: "mockchat.channel.read", version: 1 } as const;
export const POST = { id: "mockchat.message.post", version: 1 } as const;
export const LIST = { id: "mockchat.messages.list", version: 1 } as const;

export const manifest = {
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

export const profile: HostAuthProfile = {
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

export const gateSource = (id = GATE_ID, authenticationProfile = PROFILE) => ({
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

export const handlers = {
  [`${READ.id}@${READ.version}`]: readChannel,
  [`${POST.id}@${POST.version}`]: postMessage,
};

export const gate = defineIntegration(gateSource(), handlers);

export const minted: { slots: string[]; permissions: unknown }[] = [];
export const provider = defineServerProvider(manifest, {
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

export const activate = () =>
  activateDeployedIntegrations([], undefined, [manifest], [gate], {
    [PROFILE]: profile,
  });

export function snapshotFor(
  registry: ReturnType<typeof activate>,
  ids: {
    organizationId: string;
    principalId: string;
    connectionId: string;
    resourceId: string;
  },
  action: { id: string; version: number } = READ,
): AuthoritySnapshot {
  const grant = {
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
