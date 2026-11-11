import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import {
  assertSchemaDescriptions,
  findSchemaDescriptionDefects,
  integrationManifestSchema,
  isStrictObject,
  parsePathTemplate,
  requestTemplateSchema,
} from "@bakery/integration-sdk";
import {
  defineAction,
  defineIntegration,
  IntegrationActivationError,
  IntegrationContractError,
  isDefinedIntegration,
  validateIntegration,
} from "@bakery/integration-sdk";
import type { DefinedAction } from "@bakery/integration-sdk";
import {
  createFakeActionContext,
  createFakeReconciliationContext,
  deterministicEffectId,
  FakePermissionDenied,
} from "@bakery/integration-sdk/testing";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  ActionReferenceSchema,
  type IntegrationScope,
} from "../../packages/contracts/src/integrations.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  computeConnectionCapabilities,
  discoverProviders,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  assertHostProfile,
  HOST_AUTH_PROFILES,
} from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { githubIntegration } from "../../apps/server/src/modules/catalog/integration-providers/github.ts";

const FIXTURE_DESCRIPTION =
  "Fixture schema with a meaningful description used by the integration SDK tests.";

function withoutMetadata<T extends z.ZodType>(schema: T, run: () => void) {
  const metadata = z.globalRegistry.get(schema);
  z.globalRegistry.remove(schema);
  try {
    run();
  } finally {
    if (metadata) z.globalRegistry.add(schema, metadata);
  }
}

function withMetadata<T extends z.ZodType>(
  schema: T,
  description: string,
  run: () => void,
) {
  const metadata = z.globalRegistry.get(schema);
  z.globalRegistry.remove(schema);
  z.globalRegistry.add(schema, { description });
  try {
    run();
  } finally {
    z.globalRegistry.remove(schema);
    if (metadata) z.globalRegistry.add(schema, metadata);
  }
}

const listInput = () =>
  (z.strictObject({
    owner: z.string().describe(FIXTURE_DESCRIPTION),
    repo: z.string().describe(FIXTURE_DESCRIPTION),
    page: z.number().int().describe(FIXTURE_DESCRIPTION),
  })).describe(FIXTURE_DESCRIPTION);

const template = () => ({
  id: "github.issue.comments.list",
  version: 1,
  method: "GET" as const,
  effect: "read" as const,
  idempotent: true,
  resourceKind: "github.repository",
  pathTemplate: "/repos/{owner}/{repo}/issues/comments",
  pathParams: { owner: "binding:owner", repo: "binding:repo" },
  input: listInput(),
  query: ["page"],
  response: (z.array(z.string().describe(FIXTURE_DESCRIPTION))).describe(
    FIXTURE_DESCRIPTION,
  ),
  maxResponseBytes: 1024,
  providerPermissions: { issues: "read" as const },
});

const manifest = () => ({
  sdkVersion: 1 as const,
  id: "bakery.github",
  version: "1.0.0",
  authenticationProfile: "github-app",
  bakery: {
    required: [] as string[],
    optional: ["runs:start", "tasks:read", "events:subscribe"],
  },
  actions: [{ id: "github.issue.comment.create", version: 1 }],
  resourceKinds: ["github.repository"],
  requests: [template()],
  optionalFeatures: [],
  subscriptions: [],
});

Deno.test("manifest accepts a valid definition", () => {
  const result = integrationManifestSchema.safeParse(manifest());
  assert(result.success, JSON.stringify(result.error?.issues));
});

Deno.test("manifest rejects wildcard, unknown scope, duplicates and credential fields", () => {
  const m = manifest();
  const parse = (value: unknown) => integrationManifestSchema.safeParse(value);
  for (const scope of ["*", "bakery:admin", "tasks:*", "secrets:read"]) {
    assert(
      !parse({ ...m, bakery: { required: [scope], optional: [] } }).success,
    );
  }
  for (
    const extra of [
      "url",
      "origin",
      "baseUrl",
      "headers",
      "privateKey",
      "getSecret",
    ]
  ) {
    assert(!parse({ ...m, [extra]: "forbidden" }).success, extra);
  }
  assert(
    !parse({
      ...m,
      bakery: { required: ["tasks:read"], optional: ["tasks:read"] },
    }).success,
  );
  assert(!parse({ ...m, actions: [...m.actions, ...m.actions] }).success);
  assert(!parse({ ...m, resourceKinds: [] }).success);
  assert(
    !parse({ ...m, resourceKinds: ["github.repository", "github.repository"] })
      .success,
  );
  assert(!parse({ ...m, requests: [template(), template()] }).success);
  assert(!parse({ ...m, subscriptions: ["secret.changed"] }).success);
  assert(!parse({ ...m, resourceKinds: ["github"] }).success);
  assert(
    !parse({ ...m, actions: [{ id: "github.*", version: 1 }] }).success,
  );
  assert(
    !parse({
      ...m,
      requests: [{ ...template(), resourceKind: "github.issue" }],
    }).success,
  );
});

Deno.test("subscriptions need events:subscribe and tasks:read", () => {
  const m = manifest();
  assert(
    integrationManifestSchema.safeParse({
      ...m,
      subscriptions: ["tasks.updated"],
    }).success,
  );
  assert(
    !integrationManifestSchema.safeParse({
      ...m,
      bakery: { required: [], optional: ["runs:start"] },
      subscriptions: ["tasks.updated"],
    }).success,
  );
});

Deno.test("optional features must reference declared scopes and actions", () => {
  const feature = {
    id: "start-runs",
    description: "Starts a run from a provider event when approved.",
    scopes: ["runs:start"],
    actions: [{ id: "github.issue.comment.create", version: 1 }],
    providerPermissions: { issues: "write" },
  };
  const parse = (value: unknown) =>
    integrationManifestSchema.safeParse({
      ...manifest(),
      optionalFeatures: [value],
    });
  assert(parse(feature).success);
  assert(!parse({ ...feature, scopes: ["tasks:create"] }).success);
  assert(
    !parse({
      ...feature,
      actions: [{ id: "github.issue.comment.create", version: 2 }],
    }).success,
  );
  assert(!parse({ ...feature, url: "https://example.com" }).success);
});

Deno.test("path template grammar", () => {
  for (
    const ok of [
      "/repos/{owner}/{repo}/issues/{issue_number}/comments",
      "/user",
      "/a.b/c-d_e~f",
    ]
  ) assert(parsePathTemplate(ok), ok);
  for (
    const bad of [
      "",
      "repos",
      "/",
      "//a",
      "/a//b",
      "/a/",
      "/../x",
      "/a/..",
      "/a/.",
      "/a%2fb",
      "/a?x=1",
      "/a#f",
      "/a\\b",
      "/a/x{owner}",
      "/a/{owner}{repo}",
      "/{Owner}",
      "/{owner}/{owner}",
      "https://evil.example/a",
    ]
  ) assertEquals(parsePathTemplate(bad), null, bad);
  assertEquals(
    parsePathTemplate("/repos/{owner}/x")?.placeholders,
    ["owner"],
  );
});

Deno.test("request template accepts a valid read template", () => {
  const result = requestTemplateSchema.safeParse(template());
  assert(result.success, JSON.stringify(result.error?.issues));
});

Deno.test("request template effect, method and idempotency parity", () => {
  const parse = (value: unknown) => requestTemplateSchema.safeParse(value);
  const post = {
    ...template(),
    method: "POST" as const,
    idempotent: false,
    effect: "write" as const,
    body: (z.strictObject({ body: z.string().describe(FIXTURE_DESCRIPTION) }))
      .describe(
        FIXTURE_DESCRIPTION,
      ),
  };
  assert(parse(post).success);
  assert(!parse({ ...post, effect: "read" }).success);
  assert(!parse({ ...template(), effect: "write" }).success);
  assert(!parse({ ...template(), idempotent: false }).success);
  assert(!parse({ ...template(), method: "HEAD", effect: "write" }).success);
  assert(!parse({ ...template(), body: post.body }).success);
});

Deno.test("request template bounds response bytes", () => {
  const parse = (maxResponseBytes: number) =>
    requestTemplateSchema.safeParse({ ...template(), maxResponseBytes })
      .success;
  assert(!parse(0));
  assert(parse(1));
  assert(parse(8_388_608));
  assert(!parse(8_388_609));
  assert(!parse(1.5));
});

Deno.test("request template path params and query stay inside the template", () => {
  const parse = (value: unknown) => requestTemplateSchema.safeParse(value);
  assert(
    !parse({ ...template(), pathParams: { owner: "binding:owner" } }).success,
  );
  assert(
    !parse({
      ...template(),
      pathParams: { ...template().pathParams, extra: "input" },
    }).success,
  );
  assert(
    !parse({
      ...template(),
      pathParams: { owner: "https://x", repo: "binding:repo" },
    }).success,
  );
  assert(
    !parse({
      ...template(),
      pathParams: { owner: "input", repo: "binding:repo" },
      input:
        (z.strictObject({ page: z.number().describe(FIXTURE_DESCRIPTION) }))
          .describe(
            FIXTURE_DESCRIPTION,
          ),
    }).success,
  );
  assert(!parse({ ...template(), query: ["unlisted"] }).success);
  assert(!parse({ ...template(), query: ["page", "page"] }).success);
  assert(!parse({ ...template(), pathTemplate: "/a/../b" }).success);
  assert(
    !parse({ ...template(), pathParams: {}, pathTemplate: "/a?x=1" }).success,
  );
});

Deno.test("request input root must be a strict object", () => {
  const loose = (z.object({
    owner: z.string().describe(FIXTURE_DESCRIPTION),
    repo: z.string().describe(FIXTURE_DESCRIPTION),
    page: z.number().describe(FIXTURE_DESCRIPTION),
  })).describe(FIXTURE_DESCRIPTION);
  assert(!isStrictObject(loose));
  assert(isStrictObject(listInput()));
  assert(!isStrictObject(z.string().describe(FIXTURE_DESCRIPTION)));
  assert(
    !requestTemplateSchema.safeParse({ ...template(), input: loose }).success,
  );
  assert(
    !requestTemplateSchema.safeParse({ ...template(), input: "x" }).success,
  );
});

Deno.test("description audit accepts described nested schemas incl. .meta", () => {
  const schema = (z.strictObject({
    a: z.string().describe(FIXTURE_DESCRIPTION).optional().describe(
      "Optional wrapper fixture for the nested description audit.",
    ),
    b: z.string().meta({
      description: "Meta registered description for the audit fixture.",
    }),
  })).describe(FIXTURE_DESCRIPTION);
  assertSchemaDescriptions(schema, "ok");
});

Deno.test("description audit reports exact paths at nested kinds", () => {
  const leaf = z.string().describe(FIXTURE_DESCRIPTION);
  const inner = z.string().describe(FIXTURE_DESCRIPTION);
  const lazyInner = z.string().describe(FIXTURE_DESCRIPTION);
  const recordValue = z.string().describe(FIXTURE_DESCRIPTION);
  const arrayElement = z.string().describe(FIXTURE_DESCRIPTION);
  const unionOption = z.number().describe(FIXTURE_DESCRIPTION);
  const pipeIn = z.string().describe(FIXTURE_DESCRIPTION);
  const schema = (z.strictObject({
    leaf,
    opt: (z.optional(inner)).describe(FIXTURE_DESCRIPTION),
    arr: (z.array(arrayElement)).describe(FIXTURE_DESCRIPTION),
    rec: (z.record(z.string().describe(FIXTURE_DESCRIPTION), recordValue))
      .describe(FIXTURE_DESCRIPTION),
    uni: (z.union([unionOption, z.string().describe(FIXTURE_DESCRIPTION)]))
      .describe(FIXTURE_DESCRIPTION),
    lazy: (z.lazy(() => lazyInner)).describe(FIXTURE_DESCRIPTION),
    pipe: (pipeIn.pipe(z.string().describe(FIXTURE_DESCRIPTION))).describe(
      FIXTURE_DESCRIPTION,
    ),
  })).describe(FIXTURE_DESCRIPTION);
  assertEquals(findSchemaDescriptionDefects(schema, "s"), []);
  const cases: Array<[z.ZodType, string]> = [
    [leaf, "s.leaf"],
    [inner, "s.opt?"],
    [arrayElement, "s.arr[]"],
    [recordValue, "s.rec{value}"],
    [unionOption, "s.uni|0"],
    [lazyInner, "s.lazy<lazy>"],
    [pipeIn, "s.pipe<in>"],
  ];
  for (const [node, path] of cases) {
    withoutMetadata(node, () => {
      const defects = findSchemaDescriptionDefects(schema, "s");
      assert(
        defects.some((d) => d.path === path && d.kind === "missing"),
        path,
      );
      let message = "";
      try {
        assertSchemaDescriptions(schema, "s");
      } catch (error) {
        message = (error as Error).message;
      }
      assertStringIncludes(message, path);
    });
  }
});

Deno.test("description audit rejects filler and path restatement", () => {
  const leaf = z.string().describe(FIXTURE_DESCRIPTION);
  const schema = (z.strictObject({ leaf })).describe(FIXTURE_DESCRIPTION);
  withMetadata(leaf, "value", () => {
    assertEquals(
      findSchemaDescriptionDefects(schema, "s").map((d) => [d.path, d.kind]),
      [["s.leaf", "invalid"]],
    );
  });
  withMetadata(leaf, "Leaf", () => {
    assertEquals(findSchemaDescriptionDefects(schema, "s").length, 1);
  });
  withMetadata(leaf, "   ", () => {
    assertEquals(findSchemaDescriptionDefects(schema, "s")[0]?.kind, "missing");
  });
});

Deno.test("description audit fails closed on unknown nodes", () => {
  const schema = (z.strictObject({
    bad: z.string().describe(FIXTURE_DESCRIPTION),
  })).describe(FIXTURE_DESCRIPTION);
  const defects = findSchemaDescriptionDefects(
    { _zod: { def: { type: "mystery", shape: {} } } },
    "s",
  );
  assertEquals(defects.map((d) => d.kind), ["unknown-node"]);
  assertEquals(
    findSchemaDescriptionDefects("not a schema", "s")[0]?.kind,
    "unknown-node",
  );
  assertEquals(findSchemaDescriptionDefects(schema, "s"), []);
});

Deno.test("description audit covers request template schemas", () => {
  assertEquals(findSchemaDescriptionDefects(requestTemplateSchema, "t"), []);
  assertEquals(
    findSchemaDescriptionDefects(integrationManifestSchema, "m"),
    [],
  );
});

Deno.test("deterministic effect id is uuid-shaped", () => {
  assert(z.uuid().safeParse(deterministicEffectId(7)).success);
  assert(deterministicEffectId(1) !== deterministicEffectId(2));
});

// ---- Phase 3: actions, contexts, activation parity ----

const writeTemplate = () => ({
  ...template(),
  id: "github.issue.comment.create",
  method: "POST" as const,
  effect: "write" as const,
  idempotent: false,
  pathTemplate: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
  pathParams: {
    owner: "binding:owner",
    repo: "binding:repo",
    issue_number: "input",
  },
  input: (z.strictObject({
    issue_number: z.number().int().describe(FIXTURE_DESCRIPTION),
  })).describe(FIXTURE_DESCRIPTION),
  query: [] as string[],
  providerPermissions: { issues: "write" as const },
});

const receipt = () =>
  (z.strictObject({ remoteId: z.string().describe(FIXTURE_DESCRIPTION) }))
    .describe(FIXTURE_DESCRIPTION);

const commentInput = () =>
  (z.strictObject({
    issueNumber: z.number().int().describe(FIXTURE_DESCRIPTION),
    body: z.string().describe(FIXTURE_DESCRIPTION),
  })).describe(FIXTURE_DESCRIPTION);

const listRef = { id: "github.issue.comments.list", version: 1 };
const createRef = { id: "github.issue.comment.create", version: 1 };

function commentAction(
  overrides: Partial<Parameters<typeof defineAction>[0]> = {},
  onExecute?: () => void,
): DefinedAction {
  return defineAction(
    {
      id: "github.issue.comment.create",
      version: 1,
      input: commentInput(),
      output: receipt(),
      effect: "reconcile",
      resourceKind: "github.repository",
      requests: [createRef],
      reconcileRequests: [listRef],
      providerPermissions: { issues: "write" },
      execute: (_ctx, _input) => {
        onExecute?.();
        return Promise.resolve({ remoteId: "42" });
      },
      reconcile: () =>
        Promise.resolve({
          status: "confirmed" as const,
          result: { remoteId: "42" },
        }),
      ...overrides,
    } as Parameters<typeof defineAction>[0],
  );
}

const fullManifest = () => ({
  ...manifest(),
  requests: [template(), writeTemplate()],
});

const codes = (r: ReturnType<typeof validateIntegration>) =>
  r.ok ? [] : r.defects.map((d) => d.code);

Deno.test("valid integration activates and is branded", () => {
  const action = commentAction();
  const integration = defineIntegration(fullManifest(), {
    "github.issue.comment.create@1": action,
  });
  assert(isDefinedIntegration(integration));
  assert(!isDefinedIntegration({ ...integration }));
});

Deno.test("handler parity: undeclared, missing and version-mismatched", () => {
  const action = commentAction();
  const m = fullManifest();
  assertEquals(codes(validateIntegration({ manifest: m, handlers: {} })), [
    "missing-handler",
  ]);
  const extra = codes(validateIntegration({
    manifest: m,
    handlers: {
      "github.issue.comment.create@1": action,
      "github.other.thing@1": action,
    },
  }));
  assert(extra.includes("undeclared-handler"));
  assert(extra.includes("handler-version-mismatch"));
  const v2 = commentAction({ version: 2 });
  assert(
    codes(validateIntegration({
      manifest: m,
      handlers: { "github.issue.comment.create@1": v2 },
    })).includes("handler-version-mismatch"),
  );
  assertThrows(
    () => defineIntegration(m, {}),
    IntegrationActivationError,
  );
});

Deno.test("handlers must come from defineAction", () => {
  const forged = { ...commentAction() } as unknown as DefinedAction;
  assert(
    codes(validateIntegration({
      manifest: fullManifest(),
      handlers: { "github.issue.comment.create@1": forged },
    })).includes("handler-unbranded"),
  );
});

Deno.test("read action cannot use a write request", () => {
  const readAction = commentAction({
    effect: "read",
    reconcile: undefined,
    reconcileRequests: undefined,
  });
  assert(
    codes(validateIntegration({
      manifest: fullManifest(),
      handlers: { "github.issue.comment.create@1": readAction },
    })).includes("effect-parity"),
  );
  const ok = commentAction({
    effect: "read",
    requests: [listRef],
    providerPermissions: { issues: "read" },
    reconcile: undefined,
    reconcileRequests: undefined,
  });
  assertEquals(
    validateIntegration({
      manifest: fullManifest(),
      handlers: { "github.issue.comment.create@1": ok },
    }),
    { ok: true },
  );
});

Deno.test("reconcile parity", () => {
  const m = fullManifest();
  const run = (a: DefinedAction) =>
    codes(validateIntegration({
      manifest: m,
      handlers: { "github.issue.comment.create@1": a },
    }));
  assert(
    run(commentAction({ reconcile: undefined })).includes("reconcile-handler"),
  );
  assert(
    run(commentAction({ effect: "native-idempotent" })).includes(
      "reconcile-handler",
    ),
  );
  assert(
    run(commentAction({ reconcileRequests: [] })).includes(
      "reconcile-requests",
    ),
  );
  assert(
    run(commentAction({ reconcileRequests: [createRef] })).includes(
      "effect-parity",
    ),
  );
  assert(
    run(commentAction({ effect: "native-idempotent", reconcile: undefined }))
      .includes("effect-parity") === true,
  );
});

Deno.test("request refs, resource kinds and permissions", () => {
  const m = fullManifest();
  const run = (a: DefinedAction, manifestValue: unknown = m) =>
    codes(validateIntegration({
      manifest: manifestValue,
      handlers: { "github.issue.comment.create@1": a },
    }));
  assert(
    run(commentAction({ requests: [{ id: "github.nope.x", version: 1 }] }))
      .includes("undeclared-request"),
  );
  assert(
    run(commentAction({ resourceKind: "github.issue" })).includes(
      "resource-kind",
    ),
  );
  const m2 = {
    ...m,
    resourceKinds: ["github.repository", "github.issue"],
  };
  assert(
    run(commentAction({ resourceKind: "github.issue" }), m2).includes(
      "request-resource-kind",
    ),
  );
  assert(
    run(commentAction({ providerPermissions: { issues: "read" } })).includes(
      "provider-permissions",
    ),
  );
  assert(
    run(commentAction({ providerPermissions: {} })).includes(
      "provider-permissions",
    ),
  );
});

Deno.test("action input must be a strict object with deep descriptions", () => {
  assertThrows(
    () =>
      commentAction({
        input: (z.object({
          body: z.string().describe(FIXTURE_DESCRIPTION),
        })).describe(FIXTURE_DESCRIPTION) as never,
      }),
    IntegrationActivationError,
  );
  const input = commentInput();
  const body = input.shape.body;
  withoutMetadata(body, () => {
    const error = assertThrows(
      () => commentAction({ input }),
      IntegrationActivationError,
    );
    assertStringIncludes(error.message, "body");
  });
  const output = receipt();
  withMetadata(output.shape.remoteId, "value", () => {
    assertThrows(
      () => commentAction({ output }),
      IntegrationActivationError,
    );
  });
});

Deno.test("manifest request schema descriptions are audited at activation", () => {
  const m = fullManifest();
  const list = template();
  m.requests[0] = list;
  const page = list.input.shape.page;
  withoutMetadata(page, () => {
    const r = validateIntegration({
      manifest: m,
      handlers: { "github.issue.comment.create@1": commentAction() },
    });
    assert(codes(r).includes("description-missing"));
  });
});

Deno.test("invoke rejects extra fields without calling execute", async () => {
  let calls = 0;
  const action = commentAction({}, () => calls++);
  const { context } = createFakeActionContext();
  for (
    const extra of [{ organizationId: "x" }, { url: "https://evil.example" }]
  ) {
    let thrown: unknown;
    try {
      await action.invoke(context, { issueNumber: 1, body: "hi", ...extra });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof IntegrationContractError);
  }
  assertEquals(calls, 0);
  assertEquals(
    await action.invoke(context, { issueNumber: 1, body: "hi" }),
    { remoteId: "42" },
  );
  assertEquals(calls, 1);
});

Deno.test("invoke rejects secret-bearing and oversize output", async () => {
  const { context } = createFakeActionContext();
  const leaky = commentAction({
    execute: () =>
      Promise.resolve({ remoteId: "42", secret: "token" } as never),
  });
  await assertRejects(
    () => leaky.invoke(context, { issueNumber: 1, body: "hi" }),
    IntegrationContractError,
  );
  const big = commentAction({
    maxOutputBytes: 8,
    execute: () => Promise.resolve({ remoteId: "x".repeat(100) }),
  });
  await assertRejects(
    () => big.invoke(context, { issueNumber: 1, body: "hi" }),
    IntegrationContractError,
    "exceeds",
  );
});

Deno.test("reconcile result shapes", async () => {
  const { context } = createFakeReconciliationContext({
    issueNumber: 1,
    body: "hi",
  });
  const withResult = (value: unknown) =>
    commentAction({ reconcile: () => Promise.resolve(value as never) });
  assertEquals(
    await withResult({ status: "confirmed", result: { remoteId: "42" } })
      .invokeReconcile(context),
    { status: "confirmed", result: { remoteId: "42" } },
  );
  assertEquals(
    await withResult({ status: "uncertain" }).invokeReconcile(context),
    { status: "uncertain" },
  );
  for (
    const bad of [
      { status: "confirmed" },
      { status: "confirmed", result: { remoteId: "42", secret: "s" } },
      { status: "done" },
      { confirmed: true, remoteId: "42" },
      { status: "uncertain", result: { remoteId: "42" } },
    ]
  ) {
    await assertRejects(
      () => withResult(bad).invokeReconcile(context),
      IntegrationContractError,
    );
  }
  await assertRejects(
    () =>
      commentAction({ reconcile: undefined, effect: "native-idempotent" })
        .invokeReconcile(context),
    IntegrationContractError,
  );
});

Deno.test("reconciliation context shape and frozen input", () => {
  const { context } = createFakeReconciliationContext({
    issueNumber: 1,
    body: "hi",
  });
  assertEquals(
    Object.keys(context).sort(),
    ["effect", "input", "provider", "resource", "signal"],
  );
  assert(Object.isFrozen(context));
  assert(Object.isFrozen(context.input));
  assertEquals(Object.getPrototypeOf(context), null);
  const action = createFakeActionContext().context;
  assertEquals(
    Object.keys(action).sort(),
    ["bakery", "effect", "provider", "resource", "signal"],
  );
});

Deno.test("native and third-party ids share the same port and fakes record denials", async () => {
  const fake = createFakeActionContext({
    providerResponses: { "github.issue.comment.create@1": { remoteId: "7" } },
    deniedOperations: ["tasks.get"],
  });
  const action = commentAction({
    execute: async (ctx) =>
      await ctx.provider.request(createRef, {}) as { remoteId: string },
  });
  for (const id of ["bakery.github", "example.github-helper"]) {
    const integration = defineIntegration({ ...fullManifest(), id }, {
      "github.issue.comment.create@1": action,
    });
    assertEquals(
      await integration.handlers["github.issue.comment.create@1"].invoke(
        fake.context,
        { issueNumber: 1, body: "hi" },
      ),
      { remoteId: "7" },
    );
  }
  assertEquals(fake.providerCalls.length, 2);
  await assertRejects(
    () => fake.context.bakery.call("tasks.get", {}),
    FakePermissionDenied,
  );
  assertEquals(fake.bakeryCalls.length, 1);
});

// ---- Phase 4: catalog gate -------------------------------------------------

type FixtureOptions = {
  profile?: string;
  kind?: string;
  binding?: string;
  projection?: string[];
  permission?: [string, "read" | "write"];
  required?: IntegrationScope[];
  optional?: IntegrationScope[];
  withFeature?: boolean;
  id?: string;
};

function fixtureIntegration(o: FixtureOptions = {}) {
  const kind = o.kind ?? "github.repository";
  const [perm, level] = o.permission ?? ["issues", "read"];
  const output = z.strictObject({
    ok: z.boolean().describe(FIXTURE_DESCRIPTION),
  })
    .describe(FIXTURE_DESCRIPTION);
  const input = z.strictObject({
    note: z.string().describe(FIXTURE_DESCRIPTION),
  })
    .describe(FIXTURE_DESCRIPTION);
  const ref = { id: "fixture.thing.get", version: 1 };
  const action = defineAction({
    ...ref,
    input,
    output,
    effect: "read",
    resourceKind: kind,
    requests: [ref],
    providerPermissions: { [perm]: level },
    resourceProjection: o.projection,
    execute: () => Promise.resolve({ ok: true }),
  });
  return defineIntegration({
    sdkVersion: 1,
    id: o.id ?? "fixture.thing",
    version: "1.0.0",
    authenticationProfile: o.profile ?? "github-app",
    bakery: {
      required: o.required ?? [],
      optional: o.optional ?? [],
    },
    actions: [ref],
    resourceKinds: [kind],
    requests: [{
      ...ref,
      method: "GET",
      effect: "read",
      idempotent: true,
      resourceKind: kind,
      pathTemplate: "/things/{owner}",
      pathParams: { owner: `binding:${o.binding ?? "owner"}` },
      input,
      query: [],
      response: output,
      maxResponseBytes: 1024,
      providerPermissions: { [perm]: level },
    }],
    optionalFeatures: o.withFeature
      ? [{
        id: "extra-feature",
        description: "Fixture optional feature that needs an optional scope.",
        scopes: ["runs:start"],
        actions: [ref],
        providerPermissions: {},
      }]
      : [],
    subscriptions: [],
  }, { "fixture.thing.get@1": action });
}

function activationDefects(list: unknown[], catalog?: { action: string }[]) {
  try {
    activateDeployedIntegrations(list, catalog);
  } catch (error) {
    assert(error instanceof IntegrationActivationError);
    return error.defects.map((d) => d.code);
  }
  return [];
}

Deno.test("real deployed registry activates and discovery lists bakery.github", () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const found = discoverProviders(registry);
  assertEquals(found.map((p) => p.providerId), ["bakery.github"]);
  assertEquals(found[0]!.scopes, { required: [], optional: [] });
  assertEquals(found[0]!.actions, [
    { id: "github.issue.comment.create", version: 1, effect: "write" },
  ]);
  assert(Object.isFrozen(registry));
  assert(Object.isFrozen(found));
});

Deno.test("registry and provider share one SDK instance", () => {
  assert(isDefinedIntegration(githubIntegration));
  assert(deployedIntegrations.every((d) => isDefinedIntegration(d)));
});

Deno.test("manifest digest is stable, hex sha256 and changes with the contract", () => {
  const a = activateDeployedIntegrations(deployedIntegrations);
  const b = activateDeployedIntegrations(deployedIntegrations);
  const digest = a.integrations[0]!.manifestDigest;
  assertEquals(digest, b.integrations[0]!.manifestDigest);
  assert(/^[0-9a-f]{64}$/.test(digest));
  const other = activateDeployedIntegrations([fixtureIntegration()]);
  assert(other.integrations[0]!.manifestDigest !== digest);
  const widened = activateDeployedIntegrations([
    fixtureIntegration({ permission: ["issues", "write"] }),
  ]);
  assert(
    widened.integrations[0]!.manifestDigest !==
      other.integrations[0]!.manifestDigest,
  );
});

Deno.test("activation rejects unbranded, duplicate and unknown-profile integrations", () => {
  assertEquals(activationDefects([{ manifest: {}, handlers: {} }]), [
    "integration-unbranded",
  ]);
  assertEquals(activationDefects([githubIntegration, githubIntegration]), [
    "duplicate-provider",
    "duplicate-action",
  ]);
  const other = fixtureIntegration({ id: "fixture.other" });
  const same = fixtureIntegration({ id: "fixture.same" });
  assertEquals(activationDefects([other, same]), ["duplicate-action"]);
  assertEquals(
    activationDefects([fixtureIntegration({ profile: "does-not-exist" })]),
    ["unknown-profile"],
  );
  assertEquals(
    activationDefects([fixtureIntegration({ profile: "constructor" })]),
    ["unknown-profile"],
  );
});

Deno.test("a manifest naming the loopback test profile fails activation", () => {
  assertEquals(
    activationDefects([fixtureIntegration({ profile: "test-loopback" })]),
    ["unknown-profile"],
  );
  assert(!("test-loopback" in HOST_AUTH_PROFILES));
});

Deno.test("activation rejects unknown resource kind, binding key and projection", () => {
  assertEquals(
    activationDefects([fixtureIntegration({ kind: "github.gist" })]),
    ["unknown-resource-kind"],
  );
  assertEquals(
    activationDefects([fixtureIntegration({ binding: "token" })]),
    ["unknown-binding-key"],
  );
  assertEquals(
    activationDefects([fixtureIntegration({ projection: ["installationId"] })]),
    ["projection-not-projectable"],
  );
  assertEquals(
    activationDefects([fixtureIntegration({ projection: ["botUserId"] })]),
    [],
  );
});

Deno.test("activation rejects provider permissions outside the profile vocabulary", () => {
  assertEquals(
    activationDefects([fixtureIntegration({ permission: ["admin", "read"] })]),
    ["permission-vocabulary", "permission-vocabulary"],
  );
  assertEquals(
    activationDefects([
      fixtureIntegration({ permission: ["metadata", "write"] }),
    ]),
    ["permission-vocabulary", "permission-vocabulary"],
  );
});

Deno.test("activation rejects scopes whose operations are not catalog actions", () => {
  assertEquals(
    activationDefects(
      [fixtureIntegration({ required: ["tasks:read"] })],
      [{ action: "tasks.get" }],
    ),
    ["unknown-operation"],
  );
  assertEquals(
    activationDefects([fixtureIntegration({ required: ["tasks:read"] })]),
    [],
  );
});

Deno.test("assertHostProfile accepts bare https origins only", () => {
  const github = HOST_AUTH_PROFILES["github-app"]!;
  assertHostProfile(github);
  for (
    const origin of [
      "http://127.0.0.1:8080",
      "http://api.github.com",
      "https://user:pw@api.github.com",
      "https://api.github.com/v3",
      "https://api.github.com/?x=1",
      "https://api.github.com/#f",
      "not a url",
    ]
  ) {
    assertThrows(
      () => assertHostProfile({ ...github, origin }),
      Error,
      "origin",
    );
  }
  assertThrows(
    () =>
      assertHostProfile({
        ...github,
        fixedHeaders: { Authorization: "Bearer x" },
      }),
    Error,
    "reserved",
  );
  assert(Object.isFrozen(HOST_AUTH_PROFILES));
  assert(Object.isFrozen(github));
  assert(Object.isFrozen(github.fixedHeaders));
});

const ORG = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const KEY = {
  organizationId: ORG,
  actorRef: ACTOR,
  connectionId: CONNECTION,
  resourceId: RESOURCE,
};

function grant(
  over: Partial<IntegrationGrantRecord> = {},
): IntegrationGrantRecord {
  return {
    grantId: "00000000-0000-4000-8000-0000000000a1",
    organizationId: ORG,
    connectionId: CONNECTION,
    subjectType: "principal",
    subjectPrincipalId: ACTOR,
    direction: "out_of_bakery",
    capability: "github.issue.comment.create",
    actionVersion: 1,
    resourceId: RESOURCE,
    revokedAt: null,
    policyRevision: 1,
    ...over,
  } as IntegrationGrantRecord;
}

function snapshotFor(
  digest: string,
  over: Partial<{
    providerId: string;
    approved: IntegrationScope[];
    install: Partial<AuthoritySnapshot["install"]>;
    connection: Partial<AuthoritySnapshot["connection"]>;
    resource: Partial<AuthoritySnapshot["resource"]>;
    grants: IntegrationGrantRecord[];
    actor: Partial<AuthoritySnapshot["actor"]>;
  }> = {},
): AuthoritySnapshot {
  return {
    organizationId: ORG,
    actor: {
      principalId: ACTOR,
      subjectType: "principal",
      active: true,
      permissions: ["integrationConnection:invoke"],
      ...over.actor,
    },
    install: {
      id: "inst-1",
      providerId: over.providerId ?? "bakery.github",
      manifestDigest: digest,
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
      binding: {},
      ...over.resource,
    },
    grants: over.grants ?? [grant()],
    policyRevision: 1,
  };
}

function countingPort(build: () => AuthoritySnapshot | null) {
  const port = {
    loads: 0,
    load: (_key: unknown) => {
      port.loads++;
      return Promise.resolve(build());
    },
  };
  return port;
}

Deno.test("capability report: baseline is available, granted and schema-valid", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  const port = countingPort(() => snapshotFor(digest));
  const report = await computeConnectionCapabilities(registry, port, KEY);
  assertEquals(report.activation, "ready");
  assertEquals(report.actions.length, 1);
  const [entry] = report.actions;
  assertEquals(entry!.actionId, "github.issue.comment.create");
  assertEquals(entry!.effect, "write");
  assertEquals(entry!.requiredProviderPermissions, ["issues:write"]);
  assertEquals(entry!.granted, true);
  assertEquals(entry!.available, true);
  assertEquals(entry!.unavailableReason, null);
  assertEquals(port.loads, 1);
  await computeConnectionCapabilities(registry, port, KEY);
  assertEquals(port.loads, 2);
});

Deno.test("capability report: each emptied authority input makes the action unavailable", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  const cases: [string, Parameters<typeof snapshotFor>[1], string][] = [
    [
      "no provider permission",
      { connection: { providerPermissions: {} } },
      "provider_permission_missing",
    ],
    ["read-only permission", {
      connection: { providerPermissions: { issues: "read" } },
    }, "provider_permission_missing"],
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
      "resource of another kind",
      { resource: { kind: "github.gist" } },
      "resource_unselected",
    ],
    [
      "connection disabled",
      { connection: { state: "disabled" } },
      "connection_disabled",
    ],
    [
      "install disabled",
      { install: { enabled: false } },
      "connection_disabled",
    ],
    [
      "reconnect required",
      { connection: { state: "reconnect_required" } },
      "auth_required",
    ],
    [
      "digest drift",
      { install: { manifestDigest: "0".repeat(64) } },
      "unsupported",
    ],
    [
      "install belongs elsewhere",
      { connection: { installId: "other" } },
      "unsupported",
    ],
  ];
  for (const [name, over, reason] of cases) {
    const report = await computeConnectionCapabilities(
      registry,
      countingPort(() => snapshotFor(digest, over)),
      KEY,
    );
    const [entry] = report.actions;
    assertEquals(entry!.available, false, name);
    assertEquals(entry!.unavailableReason, reason, name);
  }
});

Deno.test("capability report: grants are exact, live and per subject", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  const granted = async (
    grants: IntegrationGrantRecord[],
    actor: Partial<AuthoritySnapshot["actor"]> = {},
  ) => {
    const report = await computeConnectionCapabilities(
      registry,
      countingPort(() => snapshotFor(digest, { grants, actor })),
      KEY,
      { now: new Date("2026-01-01T00:00:00Z") },
    );
    return report.actions[0]!.granted;
  };
  assertEquals(await granted([]), false);
  assertEquals(await granted([grant()]), true);
  assertEquals(
    await granted([grant({ revokedAt: "2025-12-01T00:00:00Z" })]),
    false,
  );
  assertEquals(
    await granted([grant({ expiresAt: "2025-12-31T00:00:00Z" })]),
    false,
  );
  assertEquals(
    await granted([grant({ expiresAt: "2026-02-01T00:00:00Z" })]),
    true,
  );
  assertEquals(await granted([grant({ actionVersion: 2 })]), false);
  assertEquals(await granted([grant({ actionVersion: undefined })]), false);
  assertEquals(await granted([grant({ capability: "github.*" })]), false);
  assertEquals(await granted([grant({ capability: "*" })]), false);
  assertEquals(
    await granted([grant({ capability: "github.issue.comment.create@1" })]),
    false,
  );
  assertEquals(
    await granted([
      grant({ resourceId: "00000000-0000-4000-8000-0000000000ff" }),
    ]),
    false,
  );
  assertEquals(
    await granted([
      grant({ connectionId: "00000000-0000-4000-8000-0000000000ff" }),
    ]),
    false,
  );
  assertEquals(
    await granted([
      grant({ organizationId: "00000000-0000-4000-8000-0000000000ff" }),
    ]),
    false,
  );
  assertEquals(await granted([grant({ direction: "into_bakery" })]), false);
  assertEquals(
    await granted([
      grant({ subjectPrincipalId: "00000000-0000-4000-8000-0000000000ff" }),
    ]),
    false,
  );
  const roleGrant = grant({
    subjectType: "organization_role",
    subjectRole: "developer",
    subjectPrincipalId: undefined,
  });
  assertEquals(
    await granted([roleGrant], { membershipRoleKey: "developer" }),
    true,
  );
  assertEquals(
    await granted([roleGrant], { membershipRoleKey: "viewer" }),
    false,
  );
  assertEquals(await granted([roleGrant]), false);
  const autoGrant = grant({
    subjectType: "automation",
    automationDefinitionId: "00000000-0000-4000-8000-0000000000b1",
    subjectPrincipalId: undefined,
  });
  assertEquals(
    await granted([autoGrant], {
      subjectType: "automation",
      automationDefinitionId: "00000000-0000-4000-8000-0000000000b1",
    }),
    true,
  );
  assertEquals(await granted([autoGrant]), false);
});

Deno.test("capability report: unsupported optional features stay listed with a reason", async () => {
  const fixture = fixtureIntegration({
    required: ["tasks:read"],
    optional: ["runs:start"],
    withFeature: true,
    permission: ["issues", "read"],
  });
  const registry = activateDeployedIntegrations([fixture]);
  const provider = registry.integrations[0]!;
  const report = async (
    approved: IntegrationScope[],
  ) =>
    await computeConnectionCapabilities(
      registry,
      countingPort(() =>
        snapshotFor(provider.manifestDigest, {
          providerId: "fixture.thing",
          approved,
          grants: [],
        })
      ),
      KEY,
    );

  const blocked = await report([]);
  assertEquals(blocked.activation, "blocked");
  assertEquals(blocked.blockedReason, "bakery_scope_missing");
  assertEquals(blocked.actions[0]!.unavailableReason, "bakery_scope_missing");
  assertEquals(blocked.features, [
    {
      id: "extra-feature",
      status: "unsupported",
      reason: "bakery_scope_missing",
    },
  ]);
  assertEquals(blocked.scopes.map((s) => [s.scope, s.requirement, s.status]), [
    ["tasks:read", "required", "missing"],
    ["runs:start", "optional", "missing"],
  ]);

  const partial = await report(["tasks:read"]);
  assertEquals(partial.activation, "ready");
  assertEquals(partial.features[0]!.status, "unsupported");
  assertEquals(partial.actions[0]!.available, false);
  assertEquals(partial.actions[0]!.unavailableReason, "bakery_scope_missing");

  const full = await report(["tasks:read", "runs:start"]);
  assertEquals(full.features, [
    { id: "extra-feature", status: "available", reason: null },
  ]);
  assertEquals(full.actions[0]!.available, true);
});

Deno.test("capability report: missing, foreign or unknown-provider snapshots fail closed", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  const codeOf = async (build: () => AuthoritySnapshot | null) => {
    const error = await assertRejects(() =>
      computeConnectionCapabilities(registry, countingPort(build), KEY)
    );
    assert(error instanceof StandardError);
    return error.code;
  };
  assertEquals(await codeOf(() => null), "RESOURCE_NOT_FOUND");
  assertEquals(
    await codeOf(() => ({ ...snapshotFor(digest), organizationId: "other" })),
    "RESOURCE_NOT_FOUND",
  );
  assertEquals(
    await codeOf(() => snapshotFor(digest, { providerId: "nope.nope" })),
    "RESOURCE_NOT_FOUND",
  );
});

Deno.test("request template is strict: url, header and secret keys fail parse", () => {
  for (
    const key of [
      "url",
      "origin",
      "baseUrl",
      "headers",
      "privateKey",
      "getSecret",
    ]
  ) {
    assert(
      !requestTemplateSchema.safeParse({ ...template(), [key]: "x" }).success,
      key,
    );
    assert(
      !integrationManifestSchema.safeParse({
        ...manifest(),
        requests: [{ ...template(), [key]: "x" }],
      }).success,
      `manifest ${key}`,
    );
  }
});

Deno.test("activation rejects a request template smuggling a url or getSecret", () => {
  for (const key of ["url", "getSecret"]) {
    const good = fixtureIntegration() as unknown as {
      manifest: Record<string, unknown> & {
        requests: Record<string, unknown>[];
      };
      handlers: Record<string, unknown>;
    };
    let code: string[] = [];
    try {
      const bad = defineIntegration({
        ...good.manifest,
        requests: [{
          ...good.manifest.requests[0],
          [key]: "https://evil.test",
        }],
      } as never, good.handlers as never);
      code = activationDefects([bad]);
    } catch (error) {
      assert(error instanceof Error);
      code = ["manifest-invalid"];
    }
    assertEquals(code, ["manifest-invalid"], key);
  }
});

Deno.test("description walker audits template literal parts", () => {
  const part = z.string().describe(FIXTURE_DESCRIPTION);
  const schema = z.templateLiteral(["id-", part]).describe(
    FIXTURE_DESCRIPTION,
  );
  withoutMetadata(part, () => {
    const defects = findSchemaDescriptionDefects(schema, "s");
    assertEquals(defects.map((d) => d.kind), ["missing"]);
  });
  const described = z.templateLiteral([
    "id-",
    z.string().describe(FIXTURE_DESCRIPTION),
  ]).describe(FIXTURE_DESCRIPTION);
  assertEquals(findSchemaDescriptionDefects(described, "s"), []);
});

Deno.test("capability report: actorRef must match the snapshot actor", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  const error = await assertRejects(
    () =>
      computeConnectionCapabilities(
        registry,
        countingPort(() => snapshotFor(digest)),
        { ...KEY, actorRef: "00000000-0000-4000-8000-0000000000ff" },
      ),
    StandardError,
  );
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("defineAction snapshots input, output, execute and reconcile at define time", async () => {
  const source = {
    id: "github.issue.comment.create",
    version: 1,
    input: commentInput(),
    output: receipt(),
    effect: "reconcile",
    resourceKind: "github.repository",
    requests: [createRef],
    reconcileRequests: [listRef],
    providerPermissions: { issues: "write" },
    execute: () => Promise.resolve({ remoteId: "42" }),
    reconcile: () =>
      Promise.resolve({
        status: "confirmed" as const,
        result: { remoteId: "42" },
      }),
  } as Parameters<typeof defineAction>[0];
  const action = defineAction(source);
  const mutable = source as unknown as Record<string, unknown>;
  mutable.execute = () => Promise.resolve({ ok: false });
  mutable.input = z.object({}).describe(FIXTURE_DESCRIPTION);
  mutable.output = z.object({}).describe(FIXTURE_DESCRIPTION);
  mutable.reconcile = () => Promise.resolve({ status: "uncertain" });
  const { context } = createFakeActionContext();
  assertEquals(
    await action.invoke(context, { issueNumber: 1, body: "hi" }),
    { remoteId: "42" },
  );
  await assertRejects(
    () => action.invoke(context, { issueNumber: 1, body: "hi", evil: 1 }),
    IntegrationContractError,
  );
  const { context: recon } = createFakeReconciliationContext(
    { issueNumber: 1, body: "hi" },
  );
  assertEquals(await action.invokeReconcile(recon), {
    status: "confirmed",
    result: { remoteId: "42" },
  });
});

Deno.test("ActionReferenceSchema rejects unknown keys instead of stripping them", () => {
  assert(ActionReferenceSchema.safeParse({ ...createRef }).success);
  for (const extra of [{ url: "https://evil.example" }, { getSecret: true }]) {
    assert(
      !ActionReferenceSchema.safeParse({ ...createRef, ...extra }).success,
    );
  }
});

Deno.test("capability report: inactive or non-invoking actors get nothing granted or available", async () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const digest = registry.integrations[0]!.manifestDigest;
  for (
    const actor of [{ active: false }, { permissions: [] as string[] }]
  ) {
    const report = await computeConnectionCapabilities(
      registry,
      countingPort(() => snapshotFor(digest, { actor })),
      KEY,
    );
    const [entry] = report.actions;
    assertEquals(entry!.granted, false);
    assertEquals(entry!.available, false);
  }
});
