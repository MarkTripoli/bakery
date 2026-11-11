import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction, defineIntegration } from "@bakery/integration-sdk";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  type AuthoritySnapshot,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshotPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  DERIVED_EFFECT_KEY_PREFIX,
  deriveEffectIdempotencyKey,
  findActiveAction,
  type IntegrationInvokeDeps,
  IntegrationInvokeInputSchema,
  invokeIntegration,
} from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import {
  assertHostProfile,
  HOST_AUTH_PROFILES,
} from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import {
  type ProviderRequestPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { z } from "zod";

const ORG = "00000000-0000-4000-8000-000000000101";
const ACTOR = "00000000-0000-4000-8000-000000000102";
const OTHER_ACTOR = "00000000-0000-4000-8000-000000000103";
const CONNECTION = "00000000-0000-4000-8000-000000000104";
const RESOURCE = "00000000-0000-4000-8000-000000000105";
const ACTION = "github.issue.comment.create";

// ---- a deployed read-classified integration, used by the direct route ----

const READ_REF = { id: "bakerytest.issue.comments.list", version: 1 } as const;
const PAGE_SIZE = 100;

const listedComment = z.object({
  id: z.number().int().positive().describe("Provider comment id."),
}).describe("One provider comment projection read by the test action.");

const readActionInput = z.strictObject({
  issueNumber: z.number().int().positive().describe(
    "Issue number within the authorized repository.",
  ),
}).describe("Read action arguments for the test provider page read.");

const readActionOutput = z.strictObject({
  count: z.number().int().min(0).max(PAGE_SIZE).describe(
    "Comments on the first provider page.",
  ),
  effectId: z.string().min(1).max(200).describe(
    "Effect identifier the gate handed to the action context.",
  ),
  sawQuery: z.string().describe(
    "Query the provider port received, proving the bound template was used.",
  ),
}).describe("Read action output for the direct-route test.");

const readRequestInput = z.strictObject({
  issue_number: z.number().int().positive().describe(
    "Issue number placed in the request path.",
  ),
}).describe("Read request input carried in the request path.");

const readRequestResponse = z.array(listedComment).max(PAGE_SIZE).describe(
  "Provider comment page.",
);

const readAction = defineAction({
  id: READ_REF.id,
  version: READ_REF.version,
  input: readActionInput,
  output: readActionOutput,
  effect: "read",
  resourceKind: "github.repository",
  requests: [READ_REF],
  providerPermissions: { issues: "read" },
  resourceProjection: ["botUserId"],
  async execute(ctx, input) {
    const page = await ctx.provider.request(READ_REF, {
      issue_number: input.issueNumber,
    });
    return {
      count: (page as { length: number }).length,
      effectId: ctx.effect.id,
      sawQuery: "bound-template",
    };
  },
});

const readManifest = {
  sdkVersion: 1,
  id: "bakery.testread",
  version: "1.0.0",
  authenticationProfile: "github-app",
  bakery: { required: [], optional: [] },
  actions: [{ ...READ_REF }],
  resourceKinds: ["github.repository"],
  requests: [
    {
      ...READ_REF,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: "github.repository",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
      pathParams: {
        owner: "binding:owner",
        repo: "binding:repo",
        issue_number: "input",
      },
      input: readRequestInput,
      query: [],
      response: readRequestResponse,
      maxResponseBytes: 131_072,
      providerPermissions: { issues: "read" },
    },
  ],
  optionalFeatures: [],
  subscriptions: [],
} as const;

const integration = defineIntegration(readManifest, {
  [`${READ_REF.id}@${READ_REF.version}`]: readAction,
});

const readRegistry = activateDeployedIntegrations(
  [deployedIntegrations[0], integration],
);

const READ_DIGEST = readRegistry.integrations[1]!.manifestDigest;

function readSnapshot(actor: string, permissions: string[]): AuthoritySnapshot {
  const grant = {
    grantId: "00000000-0000-4000-8000-0000000000b1",
    organizationId: ORG,
    connectionId: CONNECTION,
    subjectType: "principal",
    subjectPrincipalId: actor,
    direction: "out_of_bakery",
    capability: READ_REF.id,
    actionVersion: 1,
    resourceId: RESOURCE,
    revokedAt: null,
    policyRevision: 1,
  } as IntegrationGrantRecord;
  return {
    organizationId: ORG,
    actor: {
      principalId: actor,
      subjectType: "principal",
      active: true,
      permissions,
    },
    install: {
      id: "inst-read-1",
      providerId: readManifest.id,
      manifestDigest: READ_DIGEST,
      enabled: true,
      approvedScopes: [],
    },
    connection: {
      id: CONNECTION,
      installId: "inst-read-1",
      state: "active",
      providerPermissions: { issues: "read" },
    },
    resource: {
      id: RESOURCE,
      kind: "github.repository",
      selected: true,
      available: true,
      binding: {
        owner: "bakery-org",
        repo: "bakery-repo",
        repositoryId: 1234,
        installationId: 987654,
        botUserId: 4242,
      },
      repositoryId: "00000000-0000-4000-8000-000000000106",
    },
    grants: [grant],
    policyRevision: 1,
  };
}

function readPort(permanentSnapshot: AuthoritySnapshot): AuthoritySnapshotPort {
  return { load: () => Promise.resolve(permanentSnapshot) };
}

/** Recording provider port that answers every declared request with one page. */
function recordingProviderPort(): ProviderRequestPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const port: ProviderRequestPort & { calls: unknown[][] } = {
    calls,
    request(_bound, ref, input, allowed) {
      calls.push([ref, input, allowed]);
      return Promise.resolve([{ id: 42 }]);
    },
  };
  return port;
}

assertHostProfile(HOST_AUTH_PROFILES["github-app"]!);

function readDeps(
  actor: string,
  options: {
    providerRequests?: ProviderRequestPort;
  } = {},
): IntegrationInvokeDeps {
  const snapshot = readSnapshot(actor, ["integrationConnection:invoke"]);
  return {
    database: {} as never,
    registry: readRegistry,
    snapshots: readPort(snapshot),
    // The executor's claim recheck authority; unused by the direct route.
    snapshotsFor: () => readPort(snapshot),
    providerRequests: options.providerRequests ?? recordingProviderPort(),
  };
}

// ---- classification helpers ----

Deno.test("deriveEffectIdempotencyKey is deterministic across argument key order", async () => {
  const base = {
    actorRef: ACTOR,
    connectionId: CONNECTION,
    actionRef: { id: ACTION, version: 1 },
    resourceId: RESOURCE,
  };
  const first = await deriveEffectIdempotencyKey({
    ...base,
    arguments: { issueNumber: 7, body: "hello" },
    runStepId: null,
    budgetReservationId: null,
    approval: null,
  });
  const second = await deriveEffectIdempotencyKey({
    ...base,
    arguments: { body: "hello", issueNumber: 7 },
    runStepId: null,
    budgetReservationId: null,
    approval: null,
  });
  assertEquals(first, second);
  assert(first.startsWith(DERIVED_EFFECT_KEY_PREFIX));
  assert(first.length <= 200, "derived key stays inside the ledger bound");
});

Deno.test("deriveEffectIdempotencyKey separates sends that differ in any fact", async () => {
  const base = {
    actorRef: ACTOR,
    connectionId: CONNECTION,
    actionRef: { id: ACTION, version: 1 },
    resourceId: RESOURCE,
    arguments: { issueNumber: 7, body: "hello" },
    runStepId: null,
    budgetReservationId: null,
    approval: null,
  };
  const others = [
    {
      // Different actor.
      ...base,
      actorRef: OTHER_ACTOR,
    },
    {
      // Different arguments.
      ...base,
      arguments: { issueNumber: 7, body: "changed" },
    },
    {
      // Different action version.
      ...base,
      actionRef: { id: ACTION, version: 2 },
    },
    {
      // Different run step.
      ...base,
      runStepId: "00000000-0000-4000-8000-000000000107",
    },
  ];
  const first = await deriveEffectIdempotencyKey(base);
  for (const candidate of others) {
    assert(await deriveEffectIdempotencyKey(candidate) !== first);
  }
});

Deno.test("findActiveAction resolves an exact id and version across providers", () => {
  assert(
    findActiveAction(readRegistry, READ_REF) !== null,
    "declared read action resolves",
  );
  const writeAction = findActiveAction(readRegistry, {
    id: ACTION,
    version: 1,
  });
  assert(writeAction !== null);
  assertEquals(writeAction.effect, "write");
  assertEquals(
    findActiveAction(readRegistry, { id: ACTION, version: 2 }),
    null,
  );
  assertEquals(
    findActiveAction(readRegistry, { id: "no.action", version: 1 }),
    null,
  );
});

// ---- the send door: classification and errors before any send ----

Deno.test("invokeInput schema rejects unknown or malformed envelope fields", () => {
  assertEquals(IntegrationInvokeInputSchema.safeParse({}).success, false);
  assertEquals(
    IntegrationInvokeInputSchema.safeParse({
      organizationId: ORG,
      actorRef: ACTOR,
      connectionId: CONNECTION,
      extra: 1,
      input: {
        actionId: ACTION,
        actionVersion: 1,
        resourceId: RESOURCE,
        arguments: {},
      },
    }).success,
    false,
    "unknown envelope fields are rejected",
  );
  assertEquals(
    IntegrationInvokeInputSchema.safeParse({
      organizationId: "not-a-uuid",
      actorRef: ACTOR,
      connectionId: CONNECTION,
      input: {
        actionId: ACTION,
        actionVersion: 1,
        resourceId: RESOURCE,
        arguments: {},
      },
    }).success,
    false,
    "organization identity must be a uuid",
  );
});

function invocation(overrides: Record<string, unknown> = {}): unknown {
  return {
    organizationId: ORG,
    actorRef: ACTOR,
    connectionId: CONNECTION,
    input: {
      actionId: ACTION,
      actionVersion: 1,
      resourceId: RESOURCE,
      arguments: { issueNumber: 7, body: "hello" },
    },
    ...overrides,
  };
}

const send = invocation as (
  overrides?: Record<string, unknown>,
) => Parameters<typeof invokeIntegration>[1];

Deno.test("write-classified actions always resolve through the door's ledger classification", () => {
  // The comment action is write-classified by the gate (reconcile effect).
  const action = findActiveAction(readRegistry, { id: ACTION, version: 1 })!;
  assert(action.effect === "write");
});

async function codeOf(promise: Promise<unknown>): Promise<StandardError> {
  const error = await assertRejects(() => promise);
  assert(error instanceof StandardError, `unexpected ${String(error)}`);
  return error;
}

Deno.test("unknown action, unknown version and malformed input are refused before any classified route", async () => {
  const deps = readDeps(ACTOR);
  const refused = async (overrides: Record<string, unknown>) =>
    (await codeOf(invokeIntegration(deps, send(overrides)))).code;
  assertEquals(
    await refused({
      input: {
        actionId: "missing.action",
        actionVersion: 1,
        resourceId: RESOURCE,
        arguments: {},
      },
    }),
    "UNPROCESSABLE",
    "unknown action id",
  );
  assertEquals(
    await refused({
      input: {
        actionId: ACTION,
        actionVersion: 99,
        resourceId: RESOURCE,
        arguments: { issueNumber: 7, body: "hello" },
      },
    }),
    "UNPROCESSABLE",
    "unknown action version",
  );
  assertEquals(
    await refused({
      input: { actionId: ACTION, actionVersion: 1 },
    }),
    "UNPROCESSABLE",
    "malformed invocation body",
  );
});

// ---- direct route for read-classified sends ----

Deno.test("read-classified action sends directly and returns the handler output", async () => {
  const port = recordingProviderPort();
  const result = await invokeIntegration(
    readDeps(ACTOR, { providerRequests: port }),
    {
      organizationId: ORG,
      actorRef: ACTOR,
      connectionId: CONNECTION,
      input: {
        actionId: READ_REF.id,
        actionVersion: 1,
        resourceId: RESOURCE,
        arguments: { issueNumber: 7 },
      },
    },
  );
  assert(result.route === "direct", "read sends stay direct");
  assertEquals(result.action.effect, "read");
  const output = result.output as { count: number; effectId: string };
  assertEquals(output.count, 1);
  assert(output.effectId.length > 0);
  assertEquals(port.calls.length, 1);
  const [ref, input, allowed] = port.calls[0] as [
    { id: string; version: number },
    unknown,
    readonly { id: string; version: number }[],
  ];
  assertEquals(ref, READ_REF);
  assertEquals(input, { issue_number: 7 });
  assertEquals(allowed, [READ_REF]);
});
