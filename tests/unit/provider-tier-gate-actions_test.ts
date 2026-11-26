import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  defineIntegration,
  IntegrationActivationError,
} from "../../packages/integration-sdk/mod.ts";
import {
  defineServerProvider,
  serverProviderDefects,
} from "../../packages/integration-sdk/provider.ts";
import { activateDeployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate.ts";
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
  providerGateProfiles,
  routeCredentialsByProfile,
} from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import {
  activate,
  gate,
  GATE_ID,
  gateSource,
  handlers,
  manifest,
  minted,
  POST,
  PROFILE,
  profile,
  provider,
  READ,
  snapshotFor,
} from "../helpers/mock-provider-gate.ts";

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

Deno.test("a profile a provider's gate serves mints through that provider; any other keeps installation tokens", async () => {
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
    providerGateProfiles({ providers: [provider] }),
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

Deno.test("two provider gates on one profile, or a definition on a gate's profile, stop activation", () => {
  const twin = defineIntegration(
    { ...gateSource(), id: "bakery.mockchat2" },
    handlers,
  );
  const twinManifest = {
    ...manifest,
    slug: "mockchat2",
    integrationId: "bakery.mockchat2",
    providerUuid: "0d7e1f2a-3b4c-5d6e-8f90-a1b2c3d4e5f6",
  };
  const shared = assertThrows(
    () =>
      activateDeployedIntegrations([], undefined, [manifest, twinManifest], [
        gate,
        twin,
      ], { [PROFILE]: profile }),
    IntegrationActivationError,
  );
  assert(
    shared.defects.some((defect) =>
      defect.code === "provider-gate-profile-shared"
    ),
  );
  const legacy = defineIntegration(
    { ...gateSource(), id: "bakery.legacy" },
    handlers,
  );
  const overlap = assertThrows(
    () =>
      activateDeployedIntegrations([legacy], undefined, [manifest], [gate], {
        [PROFILE]: profile,
      }),
    IntegrationActivationError,
  );
  assert(
    overlap.defects.some((defect) =>
      defect.code === "provider-gate-profile-shared"
    ),
  );
});

Deno.test("a slot store that fails is a dependency failure, not a missing credential", async () => {
  const cause = new Error("connection refused");
  const port = createProviderCredentialPort({
    providers: { providers: [provider] },
    readStoredSlots: () => Promise.reject(cause),
  });
  const error = await assertRejects(() =>
    port.resolve(credentialRequest())
  ) as {
    code?: string;
    cause?: unknown;
  };
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(error.cause, cause);
});

Deno.test("a read with no grant is refused before any secret is read or request sent", async () => {
  const registry = activate();
  const ids = {
    organizationId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
  };
  const snapshot = { ...snapshotFor(registry, ids), grants: [] };
  let slotReads = 0;
  let sends = 0;
  const broker = createBrokerForTesting({
    registry,
    credentials: createProviderCredentialPort({
      providers: { providers: [provider] },
      readStoredSlots: () => {
        slotReads += 1;
        return Promise.resolve(encodeSecretSlots({ access_token: "x" }));
      },
    }),
    fetch: () => {
      sends += 1;
      return Promise.resolve(Response.json({}));
    },
    snapshotPort: { load: () => Promise.resolve(snapshot) },
    generationOf: () => 0,
    profiles: { [PROFILE]: profile },
  });
  await assertRejects(() =>
    invokeIntegration(
      {
        registry,
        snapshots: { load: () => Promise.resolve(snapshot) },
        providerRequests: broker,
      } as unknown as IntegrationInvokeDeps,
      {
        organizationId: ids.organizationId,
        actorRef: ids.principalId,
        connectionId: ids.connectionId,
        input: {
          actionId: READ.id,
          actionVersion: READ.version,
          resourceId: ids.resourceId,
          arguments: {},
        },
      },
    )
  );
  assertEquals([slotReads, sends], [0, 0]);
});
