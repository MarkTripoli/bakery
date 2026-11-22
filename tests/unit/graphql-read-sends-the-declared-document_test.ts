/**
 * The broker path a `kind: graphql` template actually takes.
 *
 * The other tests prove the envelope builder and the document guard in
 * isolation. This one drives the real broker with a provider that declares a
 * GraphQL read, because the defect covered here was precisely that the builder
 * was never called on the send path: `effect: read` was a claim about a document
 * nobody sent, so a template could declare a query and post a mutation in the
 * body, skipping the write and approval gates that a read bypasses.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  defineAction,
  defineIntegration,
  IntegrationActivationError,
} from "@bakery/integration-sdk";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  authorizeInvocation,
  type BoundInvocation,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { opaqueCredential } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import { HOST_AUTH_PROFILES } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const EFFECT = "00000000-0000-4000-8000-0000000000e1";

const ACTION = "linear.issue.list";
const REF = { id: ACTION, version: 1 };
const DOCUMENT =
  "query Issues($first: Int!) { issues(first: $first) { nodes { id } } }";

const variables = z.strictObject({
  first: z.number().int().min(1).max(50).describe(
    "Page size sent as a GraphQL variable; the caller never supplies the document.",
  ),
}).describe("GraphQL variables for the declared query.");

const emptyEnvelope = z.object({}).describe(
  "Provider GraphQL envelope; the read ignores it here.",
);

/**
 * A provider that declares one GraphQL read. No deployed provider uses GraphQL
 * yet, so this stands in for the template a real one will declare. Everything
 * the broker checks (effect, resource kind, permission, template version) is
 * the production rule; only the provider is synthetic.
 */
function graphqlProvider(body: z.ZodType = variables) {
  const list = defineAction({
    id: ACTION,
    version: 1,
    input: variables,
    output: emptyEnvelope,
    effect: "read",
    resourceKind: "github.repository",
    requests: [REF],
    providerPermissions: { issues: "read" as const },
    execute: () => Promise.resolve({}),
  });
  return defineIntegration({
    sdkVersion: 1,
    id: "bakery.linear",
    version: "1.0.0",
    authenticationProfile: "github-app",
    bakery: { required: [], optional: [] },
    resourceKinds: ["github.repository"],
    requests: [
      {
        kind: "graphql",
        id: REF.id,
        version: REF.version,
        method: "POST",
        effect: "read",
        idempotent: true,
        resourceKind: "github.repository",
        pathTemplate: "/graphql",
        pathParams: {},
        input: variables,
        query: [],
        body,
        response: emptyEnvelope,
        maxResponseBytes: 65_536,
        providerPermissions: { issues: "read" },
        graphqlQuery: DOCUMENT,
      },
    ],
    actions: [{ ...REF }],
    optionalFeatures: [],
    subscriptions: [],
  }, { [`${REF.id}@${REF.version}`]: list });
}

const catalog = [...catalogActions, { action: ACTION }];
const registry = activateDeployedIntegrations([graphqlProvider()], catalog);
const DIGEST = registry.integrations[0]!.manifestDigest;

const grant = {
  grantId: "00000000-0000-4000-8000-0000000000a1",
  organizationId: ORG,
  connectionId: CONNECTION,
  subjectType: "principal",
  subjectPrincipalId: ACTOR,
  direction: "out_of_bakery",
  capability: ACTION,
  actionVersion: 1,
  resourceId: RESOURCE,
  revokedAt: null,
  policyRevision: 1,
} as IntegrationGrantRecord;

const snapshot: AuthoritySnapshot = {
  organizationId: ORG,
  actor: {
    principalId: ACTOR,
    subjectType: "principal",
    active: true,
    permissions: ["integrationConnection:invoke"],
  },
  install: {
    id: "inst-1",
    providerId: "bakery.linear",
    manifestDigest: DIGEST,
    enabled: true,
    approvedScopes: [],
  },
  connection: {
    id: CONNECTION,
    installId: "inst-1",
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
    repositoryId: "00000000-0000-4000-8000-000000000005",
  },
  grants: [grant],
  policyRevision: 1,
};

/** A snapshot whose install digest matches the registry under test. */
const snapshotPortFor = (
  active: { integrations: readonly { manifestDigest: string }[] },
) => ({
  load: () =>
    Promise.resolve({
      ...snapshot,
      install: {
        ...snapshot.install,
        manifestDigest: active.integrations[0]!.manifestDigest,
      },
    }),
});

type Captured = { url: string; body: string | undefined };

function rig(
  active: typeof registry,
  respond: () => Response,
): { broker: ReturnType<typeof createBrokerForTesting>; sent: Captured[] } {
  const sent: Captured[] = [];
  const broker = createBrokerForTesting({
    registry: active,
    credentials: {
      resolve: () => Promise.resolve(opaqueCredential("ghs_UNIT_token")),
    },
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Promise.resolve(respond());
    }) as typeof fetch,
    snapshotPort: snapshotPortFor(active),
    profiles: {
      "github-app": {
        ...HOST_AUTH_PROFILES["github-app"]!,
        origin: "http://127.0.0.1:1",
      },
    },
  });
  return { broker, sent };
}

async function bind(active: typeof registry): Promise<BoundInvocation> {
  return await authorizeInvocation(active, snapshotPortFor(active), {
    organizationId: ORG,
    actorRef: ACTOR,
    connectionId: CONNECTION,
    effectId: EFFECT,
  }, {
    actionId: ACTION,
    actionVersion: 1,
    resourceId: RESOURCE,
    arguments: { first: 5 },
  });
}

Deno.test("a graphql read sends the declared document, with the caller's values as variables", async () => {
  const { broker, sent } = rig(
    registry,
    () => Response.json({ data: { issues: { nodes: [] } } }),
  );
  const bound = await bind(registry);

  await broker.request(bound, REF, { first: 5 });

  assertEquals(sent.length, 1, "exactly one request is sent");
  const body = JSON.parse(sent[0]!.body ?? "") as {
    query: string;
    variables: Record<string, unknown>;
  };
  // The document checked as a read is the document on the wire, not the body.
  assertEquals(body.query, DOCUMENT);
  assertEquals(body.variables, { first: 5 });
  assertEquals(Object.keys(body).sort(), ["query", "variables"]);
});

Deno.test("a body that tries to carry a document is refused before any fetch", async () => {
  // A template whose variables would accept an envelope key, so the refusal is
  // the broker's and not the input schema's.
  const leaky = z.strictObject({
    first: z.number().int().min(1).max(50).describe(
      "Page size sent as a GraphQL variable.",
    ).optional().describe("Page size sent as a GraphQL variable."),
    query: z.string().describe(
      "A key that must never be accepted: it would carry the document.",
    ).optional().describe(
      "A key that must never be accepted: it would carry the document.",
    ),
  }).describe("Variables, plus a key that would carry the document.");
  const active = activateDeployedIntegrations(
    [graphqlProvider(leaky)],
    catalog,
  );
  const { broker, sent } = rig(active, () => Response.json({ data: {} }));
  const bound = await bind(active);

  const error = await assertRejects(
    () =>
      broker.request(bound, REF, {
        first: 5,
        query: "mutation M { issueDelete(id: 1) { id } }",
      }),
    StandardError,
  );
  assertEquals((error as StandardError).code, "UNPROCESSABLE");
  assertEquals(
    sent.length,
    0,
    "nothing is sent when a body carries a document",
  );
});

Deno.test("a graphql template without a document cannot be activated at all", () => {
  // The manifest schema refuses a graphql template that declares no document
  // and no body, so the broker's refusal is defence in depth rather than the
  // only barrier: a template that never declares one cannot reach a connection.
  assertThrows(
    () =>
      defineIntegration({
        sdkVersion: 1,
        id: "bakery.linear",
        version: "1.0.0",
        authenticationProfile: "github-app",
        bakery: { required: [], optional: [] },
        resourceKinds: ["github.repository"],
        requests: [
          {
            kind: "graphql",
            id: REF.id,
            version: REF.version,
            method: "POST",
            effect: "read",
            idempotent: true,
            resourceKind: "github.repository",
            pathTemplate: "/graphql",
            pathParams: {},
            input: variables,
            query: [],
            response: emptyEnvelope,
            maxResponseBytes: 65_536,
            providerPermissions: { issues: "read" },
          } as unknown as Record<string, unknown>,
        ],
        actions: [{ ...REF }],
        optionalFeatures: [],
        subscriptions: [],
      }, {
        [`${REF.id}@${REF.version}`]: defineAction({
          id: ACTION,
          version: 1,
          input: variables,
          output: emptyEnvelope,
          effect: "read",
          resourceKind: "github.repository",
          requests: [REF],
          providerPermissions: { issues: "read" as const },
          execute: () => Promise.resolve({}),
        }),
      }),
    IntegrationActivationError,
  );
});

Deno.test("the broker hands an offline run's environment to the credential port", async () => {
  // #427: the credential port refuses an offline run before any read, so the
  // broker must pass the bound run environment through to it.
  const seen: unknown[] = [];
  const sent: Captured[] = [];
  const broker = createBrokerForTesting({
    registry,
    credentials: {
      resolve: (request) => {
        seen.push((request as { runEnvironment?: unknown }).runEnvironment);
        return Promise.reject(
          new StandardError({
            code: "STATE_CONFLICT",
            params: { reason: "environment_offline" },
          }),
        );
      },
    },
    fetch: ((url: string | URL | Request) => {
      sent.push({ url: String(url), body: undefined });
      return Promise.resolve(Response.json({ data: {} }));
    }) as typeof fetch,
    snapshotPort: snapshotPortFor(registry),
    profiles: {
      "github-app": {
        ...HOST_AUTH_PROFILES["github-app"]!,
        origin: "http://127.0.0.1:1",
      },
    },
  });
  const bound = await bind(registry);
  await assertRejects(() =>
    broker.request({ ...bound, runEnvironment: "offline" }, REF, { first: 5 })
  );
  assertEquals(seen, ["offline"]);
  assertEquals(sent.length, 0, "nothing reaches the provider");
});
