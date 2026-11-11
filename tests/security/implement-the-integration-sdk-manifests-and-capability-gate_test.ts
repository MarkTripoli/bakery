import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { defineAction, defineIntegration } from "@bakery/integration-sdk";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  INTEGRATION_SCOPE_OPERATIONS,
  type IntegrationScope,
} from "../../packages/contracts/src/integrations.ts";
import {
  activateDeployedIntegrations,
  type ActiveIntegrationRegistry,
  type AuthoritySnapshot,
  type AuthoritySnapshotPort,
  authorizeInvocation,
  type BakeryOperationPort,
  type BoundInvocation,
  type ContextDeps,
  createActionContext,
  createReconciliationContext,
  type IntegrationGrantRecord,
  parseGrantCapability,
  type ProviderRequestPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  createBroker,
  type CredentialPort,
  opaqueCredential,
} from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import {
  assertHostProfile,
  getHostProfile,
  HOST_AUTH_PROFILES,
  type HostAuthProfile,
} from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { githubIntegration } from "../../apps/server/src/modules/catalog/integration-providers/github.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const REPOSITORY = "00000000-0000-4000-8000-000000000005";
const OTHER_REPOSITORY = "00000000-0000-4000-8000-000000000006";
const APPLICATION = "00000000-0000-4000-8000-000000000007";
const EFFECT = "00000000-0000-4000-8000-0000000000e1";
const ACTION = "github.issue.comment.create";
const CANARY = "ghs_CANARY_installation_token";

const BINDING = {
  owner: "bakery-org",
  repo: "bakery-repo",
  repositoryId: 1234,
  installationId: 987654,
  botUserId: 4242,
};

const ENVELOPE = {
  organizationId: ORG,
  actorRef: ACTOR,
  connectionId: CONNECTION,
  effectId: EFFECT,
};

const registry = activateDeployedIntegrations(deployedIntegrations);
const DIGEST = registry.integrations[0]!.manifestDigest;

function outbound(
  over: Partial<IntegrationGrantRecord> = {},
): IntegrationGrantRecord {
  return {
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
    ...over,
  } as IntegrationGrantRecord;
}

function inbound(
  scope: IntegrationScope,
  over: Partial<IntegrationGrantRecord> = {},
): IntegrationGrantRecord {
  return {
    grantId: "00000000-0000-4000-8000-0000000000b1",
    organizationId: ORG,
    connectionId: CONNECTION,
    subjectType: "principal",
    subjectPrincipalId: ACTOR,
    direction: "into_bakery",
    capability: scope,
    repositoryId: REPOSITORY,
    revokedAt: null,
    policyRevision: 1,
    ...over,
  } as IntegrationGrantRecord;
}

type Overrides = {
  providerId?: string;
  approved?: IntegrationScope[];
  digest?: string;
  org?: string;
  actor?: Partial<AuthoritySnapshot["actor"]>;
  install?: Partial<AuthoritySnapshot["install"]>;
  connection?: Partial<AuthoritySnapshot["connection"]>;
  resource?: Partial<AuthoritySnapshot["resource"]>;
  grants?: IntegrationGrantRecord[];
};

function snapshotFor(over: Overrides = {}): AuthoritySnapshot {
  return {
    organizationId: over.org ?? ORG,
    actor: {
      principalId: ACTOR,
      subjectType: "principal",
      active: true,
      permissions: ["integrationConnection:invoke", "task:read"],
      ...over.actor,
    },
    install: {
      id: "inst-1",
      providerId: over.providerId ?? "bakery.github",
      manifestDigest: over.digest ?? DIGEST,
      enabled: true,
      approvedScopes: over.approved ?? [],
      ...over.install,
    },
    connection: {
      id: CONNECTION,
      installId: "inst-1",
      state: "active",
      providerPermissions: { issues: "write" },
      ...over.connection,
    },
    resource: {
      id: RESOURCE,
      kind: "github.repository",
      selected: true,
      available: true,
      binding: { ...BINDING },
      repositoryId: REPOSITORY,
      ...over.resource,
    },
    grants: over.grants ?? [outbound()],
    policyRevision: 1,
  };
}

function portOf(
  build: () => AuthoritySnapshot | null,
): AuthoritySnapshotPort & { loads: number } {
  const port = {
    loads: 0,
    load: (_key: unknown) => {
      port.loads++;
      return Promise.resolve(build());
    },
  };
  return port;
}

function spies() {
  const provider = {
    calls: [] as unknown[],
    request: (_bound: BoundInvocation, ref: unknown, input: unknown) => {
      provider.calls.push({ ref, input });
      return Promise.resolve({ ok: true });
    },
  } satisfies ProviderRequestPort & { calls: unknown[] };
  const bakery = {
    calls: [] as unknown[],
    call: (request: unknown) => {
      bakery.calls.push(request);
      return Promise.resolve({ done: true });
    },
  } satisfies BakeryOperationPort & { calls: unknown[] };
  return { provider, bakery };
}

const args = { issueNumber: 7, body: "hello" };

function input(over: Record<string, unknown> = {}) {
  return {
    actionId: ACTION,
    actionVersion: 1,
    resourceId: RESOURCE,
    arguments: args,
    ...over,
  };
}

async function denied(
  code: string,
  build: () => AuthoritySnapshot | null,
  rawInput: unknown = input(),
  reg: ActiveIntegrationRegistry = registry,
  reason?: string,
) {
  const port = portOf(build);
  const error = await assertRejects(
    () => authorizeInvocation(reg, port, ENVELOPE, rawInput),
    StandardError,
  );
  assertEquals((error as StandardError).code, code);
  if (reason) {
    assertEquals((error as StandardError).params?.reason, reason);
  }
  assertEquals(port.loads <= 1, true);
}

Deno.test("authorize: baseline succeeds and returns a frozen binding", async () => {
  const port = portOf(() => snapshotFor());
  const bound = await authorizeInvocation(registry, port, ENVELOPE, input());
  assertEquals(port.loads, 1);
  assert(Object.isFrozen(bound));
  assertEquals(bound.actionRef, { id: ACTION, version: 1 });
  assertEquals(bound.effectId, EFFECT);
  assertEquals("target" in bound, false);
  assertEquals(bound.grantId, outbound().grantId);
  assertEquals(bound.manifestDigest, DIGEST);
});

Deno.test("authorize 404: foreign org, connection, resource and kind", async () => {
  await denied("RESOURCE_NOT_FOUND", () => null);
  await denied("RESOURCE_NOT_FOUND", () => snapshotFor({ org: "other-org" }));
  const otherConnection = snapshotFor();
  await denied("RESOURCE_NOT_FOUND", () => ({
    ...otherConnection,
    connection: { ...otherConnection.connection, id: "other-connection" },
  }));
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor(),
    input({ resourceId: "00000000-0000-4000-8000-0000000000ff" }),
  );
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor({ resource: { kind: "github.other" } }),
  );
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor({ actor: { principalId: "someone-else" } }),
  );
});

Deno.test("authorize 404: unknown provider, unknown action, undeclared version", async () => {
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor({ providerId: "nope.nope" }),
  );
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor(),
    input({ actionId: "github.issue.delete" }),
  );
  await denied(
    "RESOURCE_NOT_FOUND",
    () => snapshotFor(),
    input({ actionVersion: 3 }),
  );
});

Deno.test("authorize 403: inactive actor, missing invoke permission with exact grant", async () => {
  await denied(
    "AUTH_FORBIDDEN",
    () => snapshotFor({ actor: { active: false } }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () => snapshotFor({ actor: { permissions: ["task:read"] } }),
  );
});

Deno.test("authorize 409: connection, install, digest and resource state", async () => {
  const cases: [string, Overrides, string][] = [
    [
      "disabled connection",
      { connection: { state: "disabled" } },
      "connection_disabled",
    ],
    [
      "reconnect required",
      { connection: { state: "reconnect_required" } },
      "auth_required",
    ],
    [
      "install disabled",
      { install: { enabled: false } },
      "connection_disabled",
    ],
    ["digest drift", { digest: "0".repeat(64) }, "unsupported"],
    [
      "install mismatch",
      { connection: { installId: "inst-2" } },
      "unsupported",
    ],
    [
      "resource unselected",
      { resource: { selected: false } },
      "resource_unselected",
    ],
    [
      "resource unavailable",
      { resource: { available: false } },
      "resource_unselected",
    ],
    [
      "provider permission undiscovered",
      { connection: { providerPermissions: { issues: "read" } } },
      "provider_permission_missing",
    ],
    [
      "binding incomplete",
      { resource: { binding: { owner: "o", repositoryId: 1 } } },
      "resource_binding_incomplete",
    ],
    [
      "binding with traversal owner",
      { resource: { binding: { ...BINDING, owner: "../etc" } } },
      "resource_binding_incomplete",
    ],
  ];
  for (const [, over, reason] of cases) {
    await denied(
      "STATE_CONFLICT",
      () => snapshotFor(over),
      input(),
      registry,
      reason,
    );
  }
});

Deno.test("authorize 403: missing, revoked, expired and foreign grants", async () => {
  await denied("AUTH_FORBIDDEN", () => snapshotFor({ grants: [] }));
  await denied(
    "AUTH_FORBIDDEN",
    () =>
      snapshotFor({
        grants: [outbound({ revokedAt: "2026-01-01T00:00:00Z" })],
      }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () =>
      snapshotFor({
        grants: [outbound({ expiresAt: "2000-01-01T00:00:00Z" })],
      }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () => snapshotFor({ grants: [outbound({ subjectPrincipalId: "other" })] }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () =>
      snapshotFor({
        grants: [
          outbound({ resourceId: "00000000-0000-4000-8000-0000000000ff" }),
        ],
      }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () => snapshotFor({ grants: [outbound({ organizationId: "other-org" })] }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () =>
      snapshotFor({ grants: [outbound({ connectionId: "other-connection" })] }),
  );
  await denied(
    "AUTH_FORBIDDEN",
    () => snapshotFor({ grants: [inbound("tasks:read")] }),
  );
});

Deno.test("authorize: malformed grants never match", async () => {
  const malformed: Partial<IntegrationGrantRecord>[] = [
    { capability: "*" },
    { capability: "github.*" },
    { capability: "github.issue.*" },
    { capability: `${ACTION}@1` },
    { capability: `${ACTION}@latest` },
    { capability: ACTION, actionVersion: undefined },
    { capability: ACTION, resourceId: undefined },
    { capability: ACTION, repositoryId: REPOSITORY },
  ];
  for (const over of malformed) {
    const record = outbound(over);
    assertEquals(parseGrantCapability(record), null);
    await denied("AUTH_FORBIDDEN", () => snapshotFor({ grants: [record] }));
  }
  assertEquals(parseGrantCapability(inbound("tasks:read")) !== null, true);
  for (
    const bad of [
      { capability: "tasks:*" },
      { capability: "tasks:read", actionVersion: 1 },
      { capability: "tasks:read", applicationId: APPLICATION },
      { capability: "tasks:read", repositoryId: undefined },
      { capability: "tasks:read", resourceId: RESOURCE },
    ] as Partial<IntegrationGrantRecord>[]
  ) {
    assertEquals(parseGrantCapability(inbound("tasks:read", bad)), null);
  }
});

Deno.test("authorize 412: grant for another version of the same action", async () => {
  const base = githubIntegration.manifest;
  const v1 = githubIntegration.handlers[`${ACTION}@1`]!;
  const v2 = defineAction({ ...v1, version: 2 } as never);
  const twoVersions = activateDeployedIntegrations([
    defineIntegration({
      ...base,
      actions: [{ id: ACTION, version: 1 }, { id: ACTION, version: 2 }],
    }, { [`${ACTION}@1`]: v1, [`${ACTION}@2`]: v2 }),
  ]);
  const digest = twoVersions.integrations[0]!.manifestDigest;
  await denied(
    "PRECONDITION_FAILED",
    () => snapshotFor({ digest }),
    input({ actionVersion: 2 }),
    twoVersions,
  );
  const port = portOf(() => snapshotFor({ digest }));
  await authorizeInvocation(twoVersions, port, ENVELOPE, input());
});

Deno.test("authorize: a role-subject grant matches only the snapshot role key", async () => {
  const roleGrant = outbound({
    subjectType: "organization_role",
    subjectPrincipalId: undefined,
    subjectRole: "developer",
  });
  const run = (membershipRoleKey?: string) =>
    authorizeInvocation(
      registry,
      portOf(() =>
        snapshotFor({ grants: [roleGrant], actor: { membershipRoleKey } })
      ),
      ENVELOPE,
      input(),
    );
  await run("developer");
  for (const key of ["viewer", "Developer", "developer ", undefined]) {
    const error = await assertRejects(() => run(key), StandardError);
    assertEquals(error.code, "AUTH_FORBIDDEN");
  }
});

Deno.test("authorize: automation grants need the automation definition", async () => {
  const automation = outbound({
    subjectType: "automation",
    subjectPrincipalId: undefined,
    automationDefinitionId: "00000000-0000-4000-8000-0000000000d1",
  });
  await denied("AUTH_FORBIDDEN", () => snapshotFor({ grants: [automation] }));
  await authorizeInvocation(
    registry,
    portOf(() =>
      snapshotFor({
        grants: [automation],
        actor: {
          subjectType: "automation",
          automationDefinitionId: "00000000-0000-4000-8000-0000000000d1",
        },
      })
    ),
    ENVELOPE,
    input(),
  );
});

Deno.test("authorize 422: bad, extra, oversize and structurally invalid input", async () => {
  await denied("UNPROCESSABLE", () => snapshotFor(), input({ arguments: {} }));
  await denied(
    "UNPROCESSABLE",
    () => snapshotFor(),
    input({ arguments: { ...args, organizationId: ORG } }),
  );
  await denied(
    "UNPROCESSABLE",
    () => snapshotFor(),
    input({ arguments: { ...args, url: "https://evil.example" } }),
  );
  await denied(
    "UNPROCESSABLE",
    () => snapshotFor(),
    input({ arguments: { issueNumber: 7, body: "x".repeat(70_000) } }),
  );
  await denied("UNPROCESSABLE", () => snapshotFor(), { actionId: ACTION });
  await denied("UNPROCESSABLE", () => snapshotFor(), "not an object");
  const bad = await assertRejects(
    () =>
      authorizeInvocation(
        registry,
        portOf(() => snapshotFor()),
        { ...ENVELOPE, effectId: "not-a-uuid" },
        input(),
      ),
    StandardError,
  );
  assertEquals(bad.code, "UNPROCESSABLE");
});

Deno.test("authorize: reloads the snapshot on every call and honors revocation", async () => {
  let grants = [outbound()];
  const port = portOf(() => snapshotFor({ grants }));
  await authorizeInvocation(registry, port, ENVELOPE, input());
  grants = [];
  const error = await assertRejects(
    () => authorizeInvocation(registry, port, ENVELOPE, input()),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(port.loads, 2);
});

function bakeryRegistry(optional: IntegrationScope[]) {
  const base = githubIntegration.manifest;
  const reg = activateDeployedIntegrations([
    defineIntegration(
      { ...base, bakery: { required: [], optional } },
      { ...githubIntegration.handlers },
    ),
  ]);
  return { reg, digest: reg.integrations[0]!.manifestDigest };
}

async function scoped(
  state: { snapshot: () => AuthoritySnapshot },
  extra: Partial<ContextDeps> = {},
) {
  const { reg, digest } = bakeryRegistry(["tasks:read", "integrations:invoke"]);
  const s = spies();
  const port = portOf(() => ({
    ...state.snapshot(),
    install: { ...state.snapshot().install, manifestDigest: digest },
  }));
  const b = await authorizeInvocation(reg, port, ENVELOPE, input());
  const deps: ContextDeps = {
    registry: reg,
    snapshots: port,
    providerRequests: s.provider,
    bakeryOperations: s.bakery,
    ...extra,
  };
  return { ctx: createActionContext(b, deps), port, s, bound: b };
}

const withBakery = (over: Overrides = {}): AuthoritySnapshot =>
  snapshotFor({
    approved: ["tasks:read", "integrations:invoke"],
    grants: [outbound(), inbound("tasks:read"), inbound("integrations:invoke")],
    ...over,
  });

Deno.test("bakery.call: allowed with scope, target grant and permission; reloads per call", async () => {
  const { ctx, port, s } = await scoped({ snapshot: () => withBakery() });
  const before = port.loads;
  assertEquals(await ctx.bakery.call("tasks.get", { id: "t1" }), {
    done: true,
  });
  assertEquals(port.loads, before + 1);
  assertEquals(s.bakery.calls.length, 1);
  const call = s.bakery.calls[0] as Record<string, unknown>;
  assertEquals(call.target, { repositoryId: REPOSITORY });
  assertEquals(call.operation, "tasks.get");
  assertEquals(call.organizationId, ORG);
  await ctx.bakery.call("tasks.list", {});
  assertEquals(port.loads, before + 2);
});

Deno.test("bakery.call: grant revoked between calls denies the second call", async () => {
  let live = true;
  const state = {
    snapshot: () =>
      withBakery({
        grants: live ? [outbound(), inbound("tasks:read")] : [
          outbound(),
          inbound("tasks:read", { revokedAt: "2026-01-01T00:00:00Z" }),
        ],
      }),
  };
  const { ctx, port, s } = await scoped(state);
  await ctx.bakery.call("tasks.get", {});
  const loads = port.loads;
  live = false;
  const error = await assertRejects(
    () => ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(port.loads, loads + 1);
  assertEquals(s.bakery.calls.length, 1);
});

Deno.test("bakery.call: revoked invocation grant, disabled connection and drift deny", async () => {
  let mode: "ok" | "revoked" | "disabled" | "drift" = "ok";
  const state = {
    snapshot: () => {
      const base = withBakery();
      if (mode === "revoked") {
        return withBakery({ grants: [inbound("tasks:read")] });
      }
      if (mode === "disabled") {
        return withBakery({ connection: { state: "disabled" } });
      }
      if (mode === "drift") return withBakery({ install: { id: "inst-9" } });
      return base;
    },
  };
  const { ctx, s } = await scoped(state);
  await ctx.bakery.call("tasks.get", {});
  mode = "revoked";
  assertEquals(
    (await assertRejects(() => ctx.bakery.call("tasks.get", {}), StandardError))
      .code,
    "AUTH_FORBIDDEN",
  );
  mode = "disabled";
  assertEquals(
    (await assertRejects(() => ctx.bakery.call("tasks.get", {}), StandardError))
      .code,
    "STATE_CONFLICT",
  );
  mode = "drift";
  await assertRejects(() => ctx.bakery.call("tasks.get", {}), StandardError);
  assertEquals(s.bakery.calls.length, 1);
});

Deno.test("bakery.call: cross-target grant is denied", async () => {
  const { ctx, s } = await scoped({
    snapshot: () =>
      withBakery({
        grants: [
          outbound(),
          inbound("tasks:read", { repositoryId: OTHER_REPOSITORY }),
        ],
      }),
  });
  const error = await assertRejects(
    () => ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(s.bakery.calls.length, 0);
  const app = await scoped({
    snapshot: () =>
      withBakery({
        grants: [
          outbound(),
          inbound("tasks:read", {
            repositoryId: undefined,
            applicationId: APPLICATION,
          }),
        ],
      }),
  });
  await assertRejects(
    () => app.ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  assertEquals(app.s.bakery.calls.length, 0);
});

Deno.test("bakery.call: app target matches only an app-bound resource", async () => {
  const { ctx, s } = await scoped({
    snapshot: () =>
      withBakery({
        resource: { repositoryId: undefined, applicationId: APPLICATION },
        grants: [
          outbound(),
          inbound("tasks:read", {
            repositoryId: undefined,
            applicationId: APPLICATION,
          }),
        ],
      }),
  });
  await ctx.bakery.call("tasks.get", {});
  assertEquals((s.bakery.calls[0] as Record<string, unknown>).target, {
    applicationId: APPLICATION,
  });
});

Deno.test("bakery.call: integrationConnections.invoke is denied even with scope and grant", async () => {
  const { ctx, s } = await scoped({
    snapshot: () =>
      withBakery({
        actor: { permissions: ["integrationConnection:invoke", "task:read"] },
      }),
  });
  const error = await assertRejects(
    () => ctx.bakery.call("integrationConnections.invoke" as never, {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(s.bakery.calls.length, 0);
});

Deno.test("bakery.call: scope, permission and operation gates", async () => {
  const noPermission = await scoped({
    snapshot: () =>
      withBakery({ actor: { permissions: ["integrationConnection:invoke"] } }),
  });
  await assertRejects(
    () => noPermission.ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  const unapproved = await scoped({
    snapshot: () => withBakery({ approved: [] }),
  });
  await assertRejects(
    () => unapproved.ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  const unmapped = await scoped({ snapshot: () => withBakery() });
  for (
    const op of ["tasks.create", "runs.create", "nope.nothing", 7, undefined]
  ) {
    await assertRejects(
      () => unmapped.ctx.bakery.call(op as never, {}),
      StandardError,
    );
  }
  for (const s of [noPermission.s, unapproved.s, unmapped.s]) {
    assertEquals(s.bakery.calls.length, 0);
  }
});

Deno.test("bakery.call: default port denies even when everything else allows", async () => {
  const { reg, digest } = bakeryRegistry(["tasks:read"]);
  const port = portOf(() => ({
    ...withBakery({ approved: ["tasks:read"] }),
    install: {
      ...withBakery().install,
      manifestDigest: digest,
      approvedScopes: ["tasks:read"],
    },
  }));
  const b = await authorizeInvocation(reg, port, ENVELOPE, input());
  const ctx = createActionContext(b, { registry: reg, snapshots: port });
  const error = await assertRejects(
    () => ctx.bakery.call("tasks.get", {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
});

Deno.test("bakery.call: bakery.github declares no scopes so every operation is denied", async () => {
  const s = spies();
  const port = portOf(() =>
    snapshotFor({
      approved: [
        ...(Object.keys(INTEGRATION_SCOPE_OPERATIONS) as IntegrationScope[]),
      ],
      grants: [
        outbound(),
        ...(Object.keys(INTEGRATION_SCOPE_OPERATIONS) as IntegrationScope[])
          .map((scope) => inbound(scope)),
      ],
      actor: {
        permissions: [
          "integrationConnection:invoke",
          "task:read",
          "task:write",
        ],
      },
    })
  );
  const b = await authorizeInvocation(registry, port, ENVELOPE, input());
  const ctx = createActionContext(b, {
    registry,
    snapshots: port,
    bakeryOperations: s.bakery,
  });
  const operations = Object.values(INTEGRATION_SCOPE_OPERATIONS).flat();
  assert(operations.length > 0);
  for (const op of operations) {
    const error = await assertRejects(
      () => ctx.bakery.call(op, {}),
      StandardError,
    );
    assertEquals(error.code, "AUTH_FORBIDDEN");
  }
  assertEquals(s.bakery.calls.length, 0);
});

Deno.test("context: exactly the fixed keys, no credential or installation accessor", async () => {
  const s = spies();
  const port = portOf(() => snapshotFor());
  const b = await authorizeInvocation(registry, port, ENVELOPE, input());
  const ctx = createActionContext(b, {
    registry,
    snapshots: port,
    providerRequests: s.provider,
  });
  assertEquals(Reflect.ownKeys(ctx).map(String).sort(), [
    "bakery",
    "effect",
    "provider",
    "resource",
    "signal",
  ]);
  assertEquals(Object.getPrototypeOf(ctx), null);
  assert(Object.isFrozen(ctx));
  assert(Object.isFrozen(ctx.bakery));
  assert(Object.isFrozen(ctx.provider));
  assertEquals(Reflect.ownKeys(ctx.provider).map(String), ["request"]);
  assertEquals(Reflect.ownKeys(ctx.bakery).map(String), ["call"]);
  assertEquals(Object.getOwnPropertyNames(ctx.resource).sort(), [
    "botUserId",
    "kind",
  ]);
  assertEquals(ctx.resource.botUserId, 4242);
  assertEquals(ctx.effect, { id: EFFECT });
  const probe = ctx as unknown as Record<string, unknown>;
  assertEquals(probe.getSecret, undefined);
  assertEquals(probe.credentials, undefined);
  assertEquals(
    (ctx.provider as unknown as Record<string, unknown>).credentials,
    undefined,
  );
  assertEquals(
    (ctx.resource as Record<string, unknown>).installationId,
    undefined,
  );
  assertEquals((ctx.resource as Record<string, unknown>).owner, undefined);
  assertEquals((ctx.resource as Record<string, unknown>).repo, undefined);
  assertEquals(Reflect.getPrototypeOf(ctx.resource), null);
  const text = JSON.stringify(ctx);
  for (
    const needle of [
      "installationId",
      "987654",
      "bakery-org",
      CANARY,
      "binding",
    ]
  ) {
    assertEquals(text.includes(needle), false, needle);
  }
  assertEquals(Object.isFrozen(b.resource.binding), true);
  assertEquals(b.resource.binding.installationId, 987654);
});

Deno.test("context: provider.request is limited to the action's declared requests", async () => {
  const s = spies();
  const port = portOf(() => snapshotFor());
  const b = await authorizeInvocation(registry, port, ENVELOPE, input());
  const ctx = createActionContext(b, {
    registry,
    snapshots: port,
    providerRequests: s.provider,
  });
  await ctx.provider.request({ id: ACTION, version: 1 }, {
    issue_number: 1,
    body: "b",
  });
  assertEquals(s.provider.calls.length, 1);
  for (
    const ref of [
      { id: "github.issue.comments.list", version: 1 },
      { id: ACTION, version: 2 },
      "https://evil.example/x",
      null,
      { id: "*", version: 1 },
    ]
  ) {
    const error = await assertRejects(
      () => ctx.provider.request(ref as never, {}),
      StandardError,
    );
    assertEquals(error.code, "UNPROCESSABLE");
  }
  assertEquals(s.provider.calls.length, 1);
});

Deno.test("reconciliation context: read-only provider, no bakery, frozen input", async () => {
  const s = spies();
  const port = portOf(() => snapshotFor());
  const b = await authorizeInvocation(registry, port, ENVELOPE, input());
  const ctx = createReconciliationContext<
    { issueNumber: number; body: string }
  >(
    b,
    args,
    { registry, snapshots: port, providerRequests: s.provider },
  );
  assertEquals(Reflect.ownKeys(ctx).map(String).sort(), [
    "effect",
    "input",
    "provider",
    "resource",
    "signal",
  ]);
  assertEquals(Object.getPrototypeOf(ctx), null);
  assert(Object.isFrozen(ctx));
  assert(Object.isFrozen(ctx.input));
  assertEquals((ctx as unknown as Record<string, unknown>).bakery, undefined);
  assertEquals(ctx.input, args);
  assertEquals(ctx.resource.botUserId, 4242);
  const error = await assertRejects(
    () => ctx.provider.request({ id: ACTION, version: 1 }, {}),
    StandardError,
  );
  assertEquals(error.code, "UNPROCESSABLE");
  await ctx.provider.request({ id: "github.issue.comments.list", version: 1 }, {
    issue_number: 7,
    per_page: 100,
    page: 1,
  });
  assertEquals(s.provider.calls.length, 1);
  assertEquals(
    (await assertRejects(
      () =>
        Promise.resolve().then(() =>
          createReconciliationContext(b, { issueNumber: 7 }, {
            registry,
            snapshots: port,
          })
        ),
      StandardError,
    )).code,
    "UNPROCESSABLE",
  );
});

Deno.test("default provider port denies and sends nothing", async () => {
  const port = portOf(() => snapshotFor());
  const b = await authorizeInvocation(registry, port, ENVELOPE, input());
  const ctx = createActionContext(b, { registry, snapshots: port });
  const error = await assertRejects(
    () => ctx.provider.request({ id: ACTION, version: 1 }, {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
});

// ---- Phase 5b: broker binding, fetch hardening, redaction ----

const COMMENT_REF = { id: ACTION, version: 1 } as const;
const LIST_REF = { id: "github.issue.comments.list", version: 1 } as const;
const PROBE_ACTION = "github.probe.read";
const PROBE_REF = { id: "github.probe.item.read", version: 1 } as const;
const COMMENT_OK = { id: 1, body: null, user: null };

function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response> =
    () => Response.json(COMMENT_OK),
) {
  const f = {
    calls: [] as { url: string; init: RequestInit }[],
    fn: ((url: string | URL | Request, init?: RequestInit) => {
      f.calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(respond(String(url), init ?? {}));
    }) as typeof fetch,
  };
  return f;
}

function fakeCredentials() {
  const c = {
    calls: [] as unknown[],
    resolve: (request: unknown) => {
      c.calls.push(request);
      return Promise.resolve(opaqueCredential(CANARY));
    },
  } satisfies CredentialPort & { calls: unknown[] };
  return c;
}

const probeHandler = defineAction({
  id: PROBE_ACTION,
  version: 1,
  input: z.strictObject({
    name: z.string().max(60).describe(
      "Probe item name that the request template places in one path segment.",
    ),
    q: z.string().max(60).describe(
      "Optional probe search text sent as an allowlisted query value.",
    ).optional().describe(
      "Optional probe search text sent as an allowlisted query value.",
    ),
  }).describe("Probe action arguments used to exercise path encoding."),
  output: z.strictObject({
    ok: z.boolean().describe("True when the probe request returned."),
  }).describe("Probe action receipt."),
  effect: "read",
  resourceKind: "github.repository",
  requests: [PROBE_REF],
  providerPermissions: { issues: "read" },
  async execute(ctx, input) {
    await ctx.provider.request(PROBE_REF, input);
    return { ok: true };
  },
});

const probeIntegration = defineIntegration({
  ...githubIntegration.manifest,
  actions: [{ id: PROBE_ACTION, version: 1 }],
  requests: [{
    ...PROBE_REF,
    method: "GET",
    effect: "read",
    idempotent: true,
    resourceKind: "github.repository",
    pathTemplate: "/repos/{owner}/{repo}/items/{name}",
    pathParams: { owner: "binding:owner", repo: "binding:repo", name: "input" },
    input: z.strictObject({
      name: z.string().max(60).describe(
        "Item name placed in one path segment.",
      ),
      q: z.string().max(60).describe(
        "Search text sent as the only allowlisted query value.",
      ).optional().describe(
        "Search text sent as the only allowlisted query value.",
      ),
    }).describe("Probe request input: item name and search text."),
    query: ["q"],
    response: z.strictObject({
      ok: z.boolean().describe("Probe response flag."),
    }).describe("Probe response body."),
    maxResponseBytes: 1024,
    providerPermissions: { issues: "read" },
  }],
}, { [`${PROBE_ACTION}@1`]: probeHandler });
const probeRegistry = activateDeployedIntegrations([probeIntegration]);
const PROBE_DIGEST = probeRegistry.integrations[0]!.manifestDigest;

type World = Awaited<ReturnType<typeof world>>;

async function world(
  opts: {
    probe?: boolean;
    respond?: Parameters<typeof fakeFetch>[0];
    state?: { snapshot: () => AuthoritySnapshot };
    make?: typeof createBroker;
  } = {},
) {
  const probe = opts.probe ?? false;
  const reg = probe ? probeRegistry : registry;
  const digest = probe ? PROBE_DIGEST : DIGEST;
  const actionId = probe ? PROBE_ACTION : ACTION;
  const state = opts.state ?? {
    snapshot: () =>
      snapshotFor({
        digest,
        grants: [outbound({ capability: actionId })],
      }),
  };
  const port = portOf(() => state.snapshot());
  const fetcher = fakeFetch(opts.respond);
  const credentials = fakeCredentials();
  const broker = (opts.make ?? createBroker)({
    registry: reg,
    credentials,
    fetch: fetcher.fn,
    snapshotPort: port,
  });
  const bound = await authorizeInvocation(
    reg,
    port,
    ENVELOPE,
    input({
      actionId,
      arguments: probe ? { name: "item" } : args,
    }),
  );
  const deps: ContextDeps = {
    registry: reg,
    snapshots: port,
    providerRequests: broker,
  };
  return { reg, port, fetcher, credentials, broker, bound, deps, state };
}

async function code(promise: Promise<unknown>): Promise<StandardError> {
  return await assertRejects(() => promise, StandardError);
}

function untouched(w: World) {
  assertEquals(w.fetcher.calls.length, 0);
  assertEquals(w.credentials.calls.length, 0);
}

Deno.test("broker: request goes to the template URL with fixed headers and the bearer only", async () => {
  const w = await world();
  const ctx = createActionContext(w.bound, w.deps);
  assertEquals(
    await ctx.provider.request(COMMENT_REF, { issue_number: 7, body: "hi" }),
    COMMENT_OK,
  );
  const [call] = w.fetcher.calls;
  assertEquals(
    call!.url,
    "https://api.github.com/repos/bakery-org/bakery-repo/issues/7/comments",
  );
  assertEquals(call!.init.method, "POST");
  assertEquals(call!.init.redirect, "error");
  assert(call!.init.signal instanceof AbortSignal);
  assertEquals(call!.init.body, JSON.stringify({ body: "hi" }));
  const headers = new Headers(call!.init.headers);
  assertEquals(
    [...headers.keys()].sort(),
    ["accept", "authorization", "content-type", "x-github-api-version"],
  );
  assertEquals(headers.get("authorization"), `Bearer ${CANARY}`);
  assertEquals(w.credentials.calls.length, 1);
  assertEquals(w.credentials.calls[0], {
    organizationId: ORG,
    connectionId: CONNECTION,
    resourceId: RESOURCE,
    profileId: "github-app",
    providerPermissions: { issues: "write" },
  });
});

Deno.test("broker: every request reloads the snapshot", async () => {
  const w = await world();
  const before = w.port.loads;
  await w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" });
  await w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "b" });
  assertEquals(w.port.loads, before + 2);
});

Deno.test("broker: grant revoked after discovery denies the next request before any credential", async () => {
  let grants = [outbound()];
  const state = { snapshot: () => snapshotFor({ grants }) };
  const w = await world({ state });
  const before = w.port.loads;
  grants = [outbound({ revokedAt: "2026-01-01T00:00:00.000Z" })];
  const error = await code(
    w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(w.port.loads, before + 1);
  untouched(w);
});

Deno.test("broker: disabled connection and lost provider permission deny before any credential", async () => {
  let mode: "ok" | "disabled" | "noperm" = "ok";
  const state = {
    snapshot: () =>
      snapshotFor({
        connection: mode === "disabled"
          ? { state: "disabled" }
          : mode === "noperm"
          ? { providerPermissions: { issues: "read" } }
          : {},
      }),
  };
  const w = await world({ state });
  for (const next of ["disabled", "noperm"] as const) {
    mode = next;
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "STATE_CONFLICT");
    untouched(w);
  }
});

Deno.test("broker: path escapes in the host binding are rejected before fetch", async () => {
  const bad = [
    "..",
    ".",
    "a/b",
    "%2e%2e",
    "%2E%2E",
    "a%2fb",
    "a?x=1",
    "a#f",
    "//evil.example",
    "\\evil",
    "a\\b",
    "\u2024\u2024",
    "\uff0e\uff0e",
    "a b",
    "",
    "a\nb",
  ];
  for (const owner of bad) {
    const binding = { ...BINDING, owner };
    const w = await world({
      state: { snapshot: () => snapshotFor() },
    });
    w.state.snapshot = () => snapshotFor({ resource: { binding } });
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "STATE_CONFLICT", JSON.stringify(owner));
    assertEquals(error.params?.reason, "resource_binding_incomplete");
    untouched(w);
  }
});

Deno.test("broker: missing or mistyped binding value is a 409 with no fetch", async () => {
  for (
    const binding of [
      {
        owner: BINDING.owner,
        repositoryId: 1,
        installationId: 2,
        botUserId: 3,
      },
      { ...BINDING, repositoryId: "1234" },
      { ...BINDING, installationId: 2 ** 60 },
      { ...BINDING, extra: "x" },
    ]
  ) {
    const w = await world();
    w.state.snapshot = () => snapshotFor({ resource: { binding } });
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "resource_binding_incomplete");
    untouched(w);
  }
});

Deno.test("broker: numeric overflow and non-integers never reach the path", async () => {
  const w = await world();
  for (
    const issue_number of [
      2 ** 53,
      1e21,
      -1,
      0,
      1.5,
      Number.NaN,
      "7",
      "../7",
      null,
    ]
  ) {
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number, body: "a" }),
    );
    assertEquals(error.code, "UNPROCESSABLE");
  }
  untouched(w);
});

Deno.test("broker: input naming host-bound or transport fields is rejected", async () => {
  const w = await world();
  for (
    const key of [
      "owner",
      "repo",
      "installationId",
      "repositoryId",
      "botUserId",
      "url",
      "headers",
      "authorization",
      "origin",
      "host",
    ]
  ) {
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, {
        issue_number: 7,
        body: "a",
        [key]: "evil",
      }),
    );
    assertEquals(error.code, "UNPROCESSABLE", key);
  }
  for (const raw of [null, "x", [], 7]) {
    assertEquals(
      (await code(w.broker.request(w.bound, COMMENT_REF, raw))).code,
      "UNPROCESSABLE",
    );
  }
  untouched(w);
});

Deno.test("broker: string path input is segment-checked and query is allowlisted and encoded", async () => {
  const w = await world({
    probe: true,
    respond: () => Response.json({ ok: true }),
  });
  const escapes = [
    "../",
    "..",
    ".",
    "%2e%2e",
    "%2E%2e%2F",
    "a/b",
    "?x=1",
    "a?x=1",
    "#f",
    "a#f",
    "//evil.example",
    "\\evil",
    "\u2024\u2024",
    "\uff0e\uff0e",
    "\u2215evil",
    "a b",
    "",
    "a\u0000b",
    "-leading",
    "x".repeat(201).slice(0, 60) + "/",
  ];
  for (const name of escapes) {
    const error = await code(w.broker.request(w.bound, PROBE_REF, { name }));
    assertEquals(error.code, "UNPROCESSABLE", JSON.stringify(name));
  }
  untouched(w);
  await w.broker.request(w.bound, PROBE_REF, {
    name: "item-1.v2",
    q: "a&owner=evil#x",
  });
  const url = new URL(w.fetcher.calls[0]!.url);
  assertEquals(url.origin, "https://api.github.com");
  assertEquals(url.pathname, "/repos/bakery-org/bakery-repo/items/item-1.v2");
  assertEquals([...url.searchParams.keys()], ["q"]);
  assertEquals(url.searchParams.get("q"), "a&owner=evil#x");
  assertEquals(url.hash, "");
  assertEquals(
    (await code(
      w.broker.request(w.bound, PROBE_REF, { name: "ok", page: 2 }),
    )).code,
    "UNPROCESSABLE",
  );
});

Deno.test("broker: request references must be exact declared objects", async () => {
  const w = await world();
  const bad: unknown[] = [
    "https://evil.example/steal",
    "github.issue.comment.create@1",
    { id: "https://evil.example", version: 1 },
    { id: ACTION, version: 2 },
    { id: ACTION, version: "1" },
    { id: "github.*", version: 1 },
    { id: "github.issue.delete", version: 1 },
    null,
    undefined,
    7,
  ];
  for (const ref of bad) {
    const error = await code(
      w.broker.request(w.bound, ref as never, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "UNPROCESSABLE", JSON.stringify(ref));
    const viaContext = await code(
      createActionContext(w.bound, w.deps).provider.request(
        ref as never,
        { issue_number: 7, body: "a" },
      ),
    );
    assertEquals(viaContext.code, "UNPROCESSABLE");
  }
  // The list template is declared but belongs to recovery only.
  assertEquals(
    (await code(
      w.broker.request(w.bound, LIST_REF, {
        issue_number: 7,
        per_page: 1,
        page: 1,
      }),
    )).code,
    "UNPROCESSABLE",
  );
  untouched(w);
});

Deno.test("broker: the reconcile context cannot send the POST template", async () => {
  const w = await world({
    respond: () => Response.json([]),
  });
  const rctx = createReconciliationContext(w.bound, args, w.deps);
  const error = await code(
    rctx.provider.request(COMMENT_REF, { issue_number: 7, body: "a" }),
  );
  assertEquals(error.code, "UNPROCESSABLE");
  untouched(w);
  // Even a hand-built allowed set cannot name a template the action never declared.
  assertEquals(
    (await code(
      w.broker.request(
        w.bound,
        COMMENT_REF,
        { issue_number: 7, body: "a" },
        [LIST_REF],
      ),
    )).code,
    "UNPROCESSABLE",
  );
  assertEquals(
    await rctx.provider.request(LIST_REF, {
      issue_number: 7,
      per_page: 100,
      page: 1,
    }),
    [],
  );
  const [call] = w.fetcher.calls;
  assertEquals(call!.init.method, "GET");
  assertEquals(call!.init.body, undefined);
  assertEquals(
    call!.url,
    "https://api.github.com/repos/bakery-org/bakery-repo/issues/7/comments?per_page=100&page=1",
  );
});

Deno.test("broker: redirects are never followed", async () => {
  const redirected = await world({
    respond: () =>
      Object.defineProperty(Response.json(COMMENT_OK), "redirected", {
        value: true,
      }),
  });
  assertEquals(
    (await code(
      redirected.broker.request(redirected.bound, COMMENT_REF, {
        issue_number: 7,
        body: "a",
      }),
    )).code,
    "UNPROCESSABLE",
  );
  const thrown = await world({
    respond: (url, init) => {
      assertEquals(init.redirect, "error");
      throw new TypeError(`redirect to ${url} with ${CANARY}`);
    },
  });
  const error = await code(
    thrown.broker.request(thrown.bound, COMMENT_REF, {
      issue_number: 7,
      body: "a",
    }),
  );
  assertEquals(error.code, "UNPROCESSABLE");
  assert(!JSON.stringify(error).includes(CANARY));
  assert(!String(error.message).includes(CANARY));
  assert(!String(error.message).includes("api.github.com"));
  const status = await world({
    respond: () =>
      new Response("{}", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
  });
  assertEquals(
    (await code(
      status.broker.request(status.bound, COMMENT_REF, {
        issue_number: 7,
        body: "a",
      }),
    )).code,
    "UNPROCESSABLE",
  );
});

Deno.test("broker: oversize responses are rejected, streamed or declared", async () => {
  const big = '{"id":1,"body":"' + "a".repeat(600_000) + '","user":null}';
  const cases: (() => Response)[] = [
    () => new Response(big),
    () => new Response("{}", { headers: { "content-length": "600000" } }),
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(100_000).fill(97));
          },
        }),
      ),
  ];
  for (const respond of cases) {
    const w = await world({ respond });
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "UNPROCESSABLE");
  }
});

Deno.test("broker: an oversize reconcile page never yields confirmed", async () => {
  const w = await world({
    respond: () => new Response("[" + "0,".repeat(5_000_000) + "0]"),
  });
  const rctx = createReconciliationContext(w.bound, args, w.deps);
  const handler = githubIntegration.handlers[`${ACTION}@1`]!;
  const outcome = await handler.invokeReconcile(rctx).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  assert("error" in outcome);
  assert(!("value" in outcome));
});

Deno.test("broker: responses are parsed with the template schema", async () => {
  for (const body of ["not json", '{"id":"x"}', "[]", ""]) {
    const w = await world({ respond: () => new Response(body) });
    assertEquals(
      (await code(
        w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
      )).code,
      "UNPROCESSABLE",
    );
  }
  const w = await world({
    respond: () => new Response("{}", { status: 500 }),
  });
  assertEquals(
    (await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    )).code,
    "UNPROCESSABLE",
  );
});

Deno.test("broker: a canary credential never appears in errors, results or the context", async () => {
  const variants = [
    CANARY,
    encodeURIComponent(CANARY),
    btoa(CANARY),
    Array.from(
      new TextEncoder().encode(CANARY),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(""),
  ];
  for (const variant of variants) {
    const w = await world({
      respond: () =>
        Response.json({ id: 1, body: `echo ${variant}`, user: null }),
    });
    const error = await code(
      w.broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assertEquals(error.code, "UNPROCESSABLE");
    const text = JSON.stringify(error) + String(error.message) +
      String(error.stack);
    for (const v of variants) assert(!text.includes(v));
  }
  const w = await world();
  const ctx = createActionContext(w.bound, w.deps);
  const result = await ctx.provider.request(COMMENT_REF, {
    issue_number: 7,
    body: "a",
  });
  assert(!JSON.stringify(result).includes(CANARY));
  assert(!JSON.stringify(ctx).includes(CANARY));
  assert(!JSON.stringify(w.bound).includes(CANARY));
  for (const name of Reflect.ownKeys(ctx.provider)) {
    assert(!String(name).toLowerCase().includes("credential"));
  }
  const failing = await world({
    respond: () => {
      throw new Error(`boom ${CANARY}`);
    },
  });
  const failure = await code(
    failing.broker.request(failing.bound, COMMENT_REF, {
      issue_number: 7,
      body: "a",
    }),
  );
  assert(!JSON.stringify(failure).includes(CANARY));
  assert(!failure.message.includes(CANARY));
});

Deno.test("broker: an empty credential fails closed without a fetch", async () => {
  const w = await world();
  const broker = createBroker({
    registry: w.reg,
    credentials: { resolve: () => Promise.resolve(opaqueCredential("")) },
    fetch: w.fetcher.fn,
    snapshotPort: w.port,
  });
  const error = await code(
    broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(w.fetcher.calls.length, 0);
});

Deno.test("broker: a slow provider is aborted by the deadline", async () => {
  const w = await world();
  const broker = createBroker({
    registry: w.reg,
    credentials: w.credentials,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () =>
            reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch,
    snapshotPort: w.port,
    deadlineMs: 20,
  });
  const error = await code(
    broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
  );
  assertEquals(error.code, "UNPROCESSABLE");
});

const profile = (origin: string, over: Partial<HostAuthProfile> = {}) =>
  ({
    ...HOST_AUTH_PROFILES["github-app"]!,
    origin,
    ...over,
  }) as HostAuthProfile;

Deno.test("profiles: production assertions reject http, userinfo, path, query and hash", () => {
  assertHostProfile(HOST_AUTH_PROFILES["github-app"]!);
  for (
    const origin of [
      "http://api.github.com",
      "http://127.0.0.1:8080",
      "https://user:pw@api.github.com",
      "https://api.github.com/v3",
      "https://api.github.com/?a=1",
      "https://api.github.com/#f",
      "https://api.github.com:8443/x",
      "not a url",
    ]
  ) {
    let failed = false;
    try {
      assertHostProfile(profile(origin));
    } catch {
      failed = true;
    }
    assert(failed, origin);
  }
  assertEquals(getHostProfile("test-loopback"), undefined);
  assertEquals(getHostProfile("constructor"), undefined);
  assertEquals(createBroker.length, 1);
});

Deno.test("profiles: only the testing factory accepts a bare loopback http origin", async () => {
  const w = await world();
  const deps = {
    registry: w.reg,
    credentials: w.credentials,
    fetch: w.fetcher.fn,
    snapshotPort: w.port,
  };
  const build = (origin: string) =>
    createBrokerForTesting({
      ...deps,
      profiles: { "github-app": profile(origin) },
    });
  const loopback = build("http://127.0.0.1:41234");
  await loopback.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" });
  assertEquals(
    w.fetcher.calls[0]!.url,
    "http://127.0.0.1:41234/repos/bakery-org/bakery-repo/issues/7/comments",
  );
  for (
    const origin of [
      "http://evil.example",
      "http://localhost:80",
      "http://127.0.0.1:80/x",
      "http://user@127.0.0.1:80",
      "http://127.0.0.1",
      "http://127.0.0.1:80/?q=1",
      "ftp://127.0.0.1:21",
    ]
  ) {
    let failed = false;
    try {
      build(origin);
    } catch {
      failed = true;
    }
    assert(failed, origin);
  }
});

Deno.test("profiles: a manifest naming a test profile id fails activation", () => {
  let failed = false;
  try {
    activateDeployedIntegrations([
      defineIntegration(
        {
          ...githubIntegration.manifest,
          authenticationProfile: "test-loopback",
        },
        { ...githubIntegration.handlers },
      ),
    ]);
  } catch {
    failed = true;
  }
  assert(failed);
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const FORBIDDEN_CALLS = [
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bDeno\.env\b/,
  /\bDeno\.readFile\b/,
  /\bDeno\.readTextFile\b/,
];

Deno.test("static scan: integration gate and SDK have no dynamic code, env or file access", () => {
  const catalog = "apps/server/src/modules/catalog";
  const gate = sourceFiles(catalog).filter((p) => /\/integration-/.test(p));
  const sdk = sourceFiles("packages/integration-sdk");
  assert(gate.length >= 4 && sdk.length >= 8);
  for (const path of [...gate, ...sdk]) {
    const text = Deno.readTextFileSync(path);
    for (const pattern of FORBIDDEN_CALLS) {
      assert(!pattern.test(text), `${path} matches ${pattern}`);
    }
  }
  for (const path of sdk) {
    const text = Deno.readTextFileSync(path);
    assert(!/\bfetch\s*\(/.test(text), `${path} calls fetch`);
    assert(!/["']node:/.test(text), `${path} imports node:`);
  }
});

Deno.test("static scan: no production code imports the broker testing module", () => {
  const importers = sourceFiles("apps/server/src").filter((path) =>
    Deno.readTextFileSync(path).includes("integration-gate-broker-testing")
  );
  assertEquals(importers, []);
  for (const path of sourceFiles("packages")) {
    assert(
      !Deno.readTextFileSync(path).includes("integration-gate-broker-testing"),
      path,
    );
  }
});

Deno.test("bakery.call: resource with both ids dispatches only the matched grant's target", async () => {
  const { ctx, s } = await scoped({
    snapshot: () =>
      withBakery({
        resource: { applicationId: APPLICATION, repositoryId: REPOSITORY },
        grants: [outbound(), inbound("tasks:read")],
      }),
  });
  await ctx.bakery.call("tasks.get", {});
  assertEquals((s.bakery.calls[0] as Record<string, unknown>).target, {
    repositoryId: REPOSITORY,
  });
});

Deno.test("authorize: a principal grant never matches an automation actor with the same id", async () => {
  const error = await assertRejects(
    () =>
      authorizeInvocation(
        registry,
        portOf(() =>
          snapshotFor({
            actor: {
              subjectType: "automation",
              automationDefinitionId: ACTOR,
            },
          })
        ),
        ENVELOPE,
        input(),
      ),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
});

Deno.test("broker: install or manifest drift on the bound invocation denies before any credential", async () => {
  const w = await world();
  for (
    const bound of [
      { ...w.bound, installId: "other-install" },
      { ...w.bound, manifestDigest: "0".repeat(64) },
    ]
  ) {
    const error = await code(
      w.broker.request(bound as never, COMMENT_REF, {
        issue_number: 7,
        body: "a",
      }),
    );
    assert(
      error.code === "AUTH_FORBIDDEN" || error.code === "RESOURCE_NOT_FOUND",
      error.code,
    );
  }
  untouched(w);
});

Deno.test("broker: the caller's abort signal cancels the provider fetch", async () => {
  const w = await world();
  const controller = new AbortController();
  controller.abort();
  const error = await code(
    w.broker.request(
      w.bound,
      COMMENT_REF,
      { issue_number: 7, body: "a" },
      undefined,
      controller.signal,
    ),
  );
  assert(error instanceof StandardError);
});

Deno.test("broker: a credential with control or non-ASCII characters fails closed without leaking", async () => {
  const secret = "ghs_SECRETCANARY";
  for (
    const bad of [
      `${secret}\u0000tail`,
      `${secret}\rtail`,
      `${secret}\ntail`,
      `${secret} tail`,
      `${secret}\u00e9`,
    ]
  ) {
    const w = await world();
    const broker = createBroker({
      registry: w.reg,
      credentials: { resolve: () => Promise.resolve(opaqueCredential(bad)) },
      fetch: w.fetcher.fn,
      snapshotPort: w.port,
    });
    const error = await code(
      broker.request(w.bound, COMMENT_REF, { issue_number: 7, body: "a" }),
    );
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    const text = JSON.stringify(error) + String(error.message) +
      String(error.stack);
    assert(!text.includes(secret));
    assertEquals(w.fetcher.calls.length, 0);
  }
});

Deno.test("authorize: a grant with an unparseable expiry never authorizes", async () => {
  for (const expiresAt of ["garbage", "", "NaN"]) {
    await denied(
      "AUTH_FORBIDDEN",
      () => snapshotFor({ grants: [outbound({ expiresAt })] }),
    );
  }
});

Deno.test("authorize: an organization_role grant never matches an automation actor", async () => {
  const roleGrant = outbound({
    subjectType: "organization_role",
    subjectPrincipalId: undefined,
    subjectRole: "developer",
  });
  await denied(
    "AUTH_FORBIDDEN",
    () =>
      snapshotFor({
        grants: [roleGrant],
        actor: {
          subjectType: "automation",
          automationDefinitionId: "00000000-0000-4000-8000-0000000000d1",
          membershipRoleKey: "developer",
        },
      }),
  );
});

Deno.test("bakery.call: a read-effect action cannot reach mutating Bakery operations", async () => {
  const base = probeIntegration.manifest;
  const reg = activateDeployedIntegrations([
    defineIntegration(
      {
        ...base,
        bakery: { required: [], optional: ["tasks:read", "tasks:create"] },
      },
      { [`${PROBE_ACTION}@1`]: probeHandler },
    ),
  ]);
  const digest = reg.integrations[0]!.manifestDigest;
  const snapshot = () =>
    snapshotFor({
      digest,
      approved: ["tasks:read", "tasks:create"],
      grants: [
        outbound({ capability: PROBE_ACTION }),
        inbound("tasks:read"),
        inbound("tasks:create", {
          grantId: "00000000-0000-4000-8000-0000000000b2",
        }),
      ],
      actor: {
        permissions: [
          "integrationConnection:invoke",
          "task:read",
          "task:write",
        ],
      },
    });
  const port = portOf(snapshot);
  const s = spies();
  const bound = await authorizeInvocation(
    reg,
    port,
    ENVELOPE,
    input({ actionId: PROBE_ACTION, arguments: { name: "item" } }),
  );
  assertEquals(bound.actionRef.id, PROBE_ACTION);
  const ctx = createActionContext(bound, {
    registry: reg,
    snapshots: port,
    bakeryOperations: s.bakery,
  });
  const error = await assertRejects(
    () => ctx.bakery.call("tasks.create", { title: "x" }),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(s.bakery.calls.length, 0);
  await ctx.bakery.call("tasks.get", { id: "t1" });
  assertEquals(s.bakery.calls.length, 1);
  const call = s.bakery.calls[0] as Record<string, unknown>;
  assertEquals(call.effectId, EFFECT);
  assertEquals(call.installId, "inst-1");
  assertEquals(call.connectionId, CONNECTION);
});
