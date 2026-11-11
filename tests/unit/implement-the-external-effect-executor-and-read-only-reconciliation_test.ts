import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  authorizeInvocation,
  type BoundInvocation,
  denyAllProviderRequests,
  type IntegrationGrantRecord,
  type ProviderRequestPort,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { opaqueCredential } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import {
  assertHostProfile,
  HOST_AUTH_PROFILES,
} from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import {
  markProviderFailure,
  providerFailureClass,
  ProviderFailureClassSchema,
} from "../../apps/server/src/modules/catalog/integration-provider-outcome.ts";
import { ClaimEffectInputSchema } from "../../apps/server/src/modules/effects/claim.ts";
import { runAdmission } from "../../apps/server/src/modules/effects/admission.ts";
import {
  classifyDispatch,
  computeRequestDigest,
  EffectApprovalRefSchema,
  EffectFailureCodeSchema,
  type EffectIdentity,
  EffectOutcomeSchema,
  ExternalEffectRowSchema,
  ExternalEffectStatusSchema,
  type HandlerEnd,
  PrepareEffectInputSchema,
  PrepareEffectResultSchema,
  ReconcileEffectInputSchema,
  ReconciliationEvidenceSchema,
  type RequestRecord,
  retryDelaySeconds,
  RunEffectInputSchema,
} from "../../apps/server/src/modules/effects/index.ts";
import {
  RecordOutcomeInputSchema,
  runObserved,
} from "../../apps/server/src/modules/effects/dispatch.ts";
import { confirmedOutcome } from "../../apps/server/src/modules/effects/classify.ts";
import { assertLeaseTimings } from "../../apps/server/src/modules/effects/executor.ts";
import { findSchemaDescriptionDefects } from "@bakery/integration-sdk";

const ORG = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const REPOSITORY = "00000000-0000-4000-8000-000000000005";
const EFFECT = "00000000-0000-4000-8000-0000000000e1";
const ACTION = "github.issue.comment.create";
const REQUEST_REF = { id: "github.issue.comment.create", version: 1 };
const ARGS = { issueNumber: 7, body: "hello" };
const REQUEST_INPUT = { issue_number: 7, body: "hello" };

const registry = activateDeployedIntegrations(deployedIntegrations);
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
    providerId: "bakery.github",
    manifestDigest: DIGEST,
    enabled: true,
    approvedScopes: [],
  },
  connection: {
    id: CONNECTION,
    installId: "inst-1",
    state: "active",
    providerPermissions: { issues: "write" },
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
    repositoryId: REPOSITORY,
  },
  grants: [grant],
  policyRevision: 1,
};

const snapshotPort = { load: () => Promise.resolve(snapshot) };

async function bind(): Promise<BoundInvocation> {
  return await authorizeInvocation(registry, snapshotPort, {
    organizationId: ORG,
    actorRef: ACTOR,
    connectionId: CONNECTION,
    effectId: EFFECT,
  }, {
    actionId: ACTION,
    actionVersion: 1,
    resourceId: RESOURCE,
    arguments: ARGS,
  });
}

type Calls = { fetches: number; resolves: number };

function rig(
  stubFetch: typeof fetch,
  options: {
    credentials?: () => Promise<ReturnType<typeof opaqueCredential>>;
    port?: typeof snapshotPort;
  } = {},
) {
  const calls: Calls = { fetches: 0, resolves: 0 };
  const broker = createBrokerForTesting({
    registry,
    credentials: {
      resolve: () => {
        calls.resolves++;
        return options.credentials
          ? options.credentials()
          : Promise.resolve(opaqueCredential("ghs_UNIT_token"));
      },
    },
    fetch: ((...args: Parameters<typeof fetch>) => {
      calls.fetches++;
      return stubFetch(...args);
    }) as typeof fetch,
    snapshotPort: options.port ?? snapshotPort,
    profiles: {
      "github-app": {
        ...HOST_AUTH_PROFILES["github-app"]!,
        origin: "http://127.0.0.1:1",
      },
    },
  });
  return { broker, calls };
}

const COMMENT_OK = () =>
  Response.json({ id: 1, body: "x", user: { id: 4242, type: "Bot" } }, {
    status: 201,
  });

async function failureOf(
  stub: typeof fetch,
): Promise<{ error: StandardError; calls: Calls }> {
  const { broker, calls } = rig(stub);
  const bound = await bind();
  const error = await assertRejects(
    () => broker.request(bound, REQUEST_REF, REQUEST_INPUT),
    StandardError,
  );
  return { error, calls };
}

const respond = (status: number, headers: Record<string, string> = {}) =>
  (() =>
    Promise.resolve(new Response("{}", { status, headers }))) as typeof fetch;

Deno.test("outcome class schema is described and strict", () => {
  assertEquals(findSchemaDescriptionDefects(ProviderFailureClassSchema), []);
  assert(
    !ProviderFailureClassSchema.safeParse({
      kind: "rejected",
      retryable: true,
      retryAfterSeconds: 0,
    }).success,
  );
  assert(
    !ProviderFailureClassSchema.safeParse({
      kind: "not_sent",
      retryable: true,
      extra: 1,
    }).success,
  );
});

Deno.test("marks live on the error object only and primitives stay unknown", () => {
  const error = new Error("x");
  assertEquals(providerFailureClass(error), undefined);
  markProviderFailure(error, { kind: "not_sent", retryable: false });
  assertEquals(providerFailureClass(error), {
    kind: "not_sent",
    retryable: false,
  });
  assertEquals(providerFailureClass(new Error("x")), undefined);
  assertEquals(providerFailureClass("text"), undefined);
  assertEquals(providerFailureClass(undefined), undefined);
});

Deno.test("broker: 2xx success reaches the caller unmarked", async () => {
  const { broker } = rig((() => Promise.resolve(COMMENT_OK())) as typeof fetch);
  const bound = await bind();
  const out = await broker.request(bound, REQUEST_REF, REQUEST_INPUT) as {
    id: number;
  };
  assertEquals(out.id, 1);
});

Deno.test("broker: authoritative rejections are marked rejected with unchanged text", async () => {
  for (const status of [400, 403, 404, 409, 410, 422]) {
    const { error, calls } = await failureOf(respond(status));
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(error.safeDetail, "provider request failed");
    assertEquals(calls.fetches, 1);
    assertEquals(providerFailureClass(error), {
      kind: "rejected",
      retryable: false,
    }, `status ${status}`);
  }
});

Deno.test("broker: rate limits are retryable with bounded Retry-After", async () => {
  const cases: Array<[number, Record<string, string>, number | undefined]> = [
    [429, {}, undefined],
    [429, { "retry-after": "30" }, 30],
    [429, { "retry-after": "0" }, 1],
    [429, { "retry-after": "999999" }, 3600],
    [429, { "retry-after": "garbage" }, undefined],
    [403, { "x-ratelimit-remaining": "0" }, undefined],
    [401, {}, undefined],
    [401, { "retry-after": "5" }, 5],
    [403, { "retry-after": "7" }, 7],
  ];
  for (const [status, headers, after] of cases) {
    const { error } = await failureOf(respond(status, headers));
    assertEquals(error.safeDetail, "provider request failed");
    assertEquals(
      providerFailureClass(error),
      {
        kind: "rejected",
        retryable: true,
        ...(after === undefined ? {} : { retryAfterSeconds: after }),
      },
      `status ${status} ${JSON.stringify(headers)}`,
    );
  }
});

Deno.test("broker: 408, 5xx and transport failures stay unmarked", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const { error } = await failureOf(respond(status));
    assertEquals(providerFailureClass(error), undefined, `status ${status}`);
    assertEquals(error.safeDetail, "provider request failed");
  }
  const thrown = await failureOf(
    (() => Promise.reject(new TypeError("connection reset"))) as typeof fetch,
  );
  assertEquals(providerFailureClass(thrown.error), undefined);
  assertEquals(thrown.calls.fetches, 1);
  const abort = await failureOf(
    (() =>
      Promise.reject(
        new DOMException("aborted", "AbortError"),
      )) as typeof fetch,
  );
  assertEquals(providerFailureClass(abort.error), undefined);
});

Deno.test("broker: unparseable and credential-leaking successes stay unmarked", async () => {
  const bad = await failureOf(
    (() =>
      Promise.resolve(
        new Response("not json", { status: 200 }),
      )) as typeof fetch,
  );
  assertEquals(providerFailureClass(bad.error), undefined);
  const leak = await failureOf(
    (() =>
      Promise.resolve(
        Response.json({
          id: 1,
          body: "ghs_UNIT_token",
          user: { id: 4242, type: "Bot" },
        }),
      )) as typeof fetch,
  );
  assertEquals(providerFailureClass(leak.error), undefined);
});

Deno.test("broker: failures before fetch are not_sent and never reach the provider", async () => {
  const bound = await bind();
  // Policy denial: undeclared request reference is terminal.
  const denied = rig((() => Promise.resolve(COMMENT_OK())) as typeof fetch);
  const error = await assertRejects(
    () =>
      denied.broker.request(bound, { id: "nope", version: 1 }, REQUEST_INPUT),
    StandardError,
  );
  assertEquals(providerFailureClass(error), {
    kind: "not_sent",
    retryable: false,
  });
  assertEquals(denied.calls.fetches, 0);

  // Revoked grant at request time is terminal not_sent.
  const revoked = rig((() => Promise.resolve(COMMENT_OK())) as typeof fetch, {
    port: {
      load: () =>
        Promise.resolve({
          ...snapshot,
          grants: [{ ...grant, revokedAt: new Date(0).toISOString() }],
        } as AuthoritySnapshot),
    },
  });
  const revokedError = await assertRejects(
    () => revoked.broker.request(bound, REQUEST_REF, REQUEST_INPUT),
    StandardError,
  );
  assertEquals(providerFailureClass(revokedError), {
    kind: "not_sent",
    retryable: false,
  });
  assertEquals(revoked.calls.fetches, 0);

  // Credential store failure is transient.
  const noCred = rig((() => Promise.resolve(COMMENT_OK())) as typeof fetch, {
    credentials: () => Promise.reject(new Error("vault unavailable")),
  });
  const credError = await assertRejects(() =>
    noCred.broker.request(bound, REQUEST_REF, REQUEST_INPUT)
  );
  assertEquals(providerFailureClass(credError), {
    kind: "not_sent",
    retryable: true,
  });
  assertEquals(noCred.calls.fetches, 0);

  // Snapshot transport failure (non-StandardError) is transient.
  const flaky = rig((() => Promise.resolve(COMMENT_OK())) as typeof fetch, {
    port: { load: () => Promise.reject(new Error("db down")) },
  });
  const flakyError = await assertRejects(() =>
    flaky.broker.request(bound, REQUEST_REF, REQUEST_INPUT)
  );
  assertEquals(providerFailureClass(flakyError), {
    kind: "not_sent",
    retryable: true,
  });
  assertEquals(flaky.calls.fetches, 0);

  // A transient StandardError from reauth is a host fault, not a policy answer.
  for (const code of ["SERVICE_UNAVAILABLE", "RATE_LIMITED", "INTERNAL"]) {
    const transient = rig(
      (() => Promise.resolve(COMMENT_OK())) as typeof fetch,
      {
        port: {
          load: () =>
            Promise.reject(
              new StandardError({
                code: code as StandardError["code"],
                detail: "snapshot store unavailable",
              }),
            ),
        },
      },
    );
    const transientError = await assertRejects(() =>
      transient.broker.request(bound, REQUEST_REF, REQUEST_INPUT)
    );
    assertEquals(providerFailureClass(transientError), {
      kind: "not_sent",
      retryable: true,
    }, code);
    assertEquals(transient.calls.fetches, 0);
  }
});

Deno.test("denyAllProviderRequests rejects not_sent terminal", async () => {
  const bound = await bind();
  const error = await assertRejects(() =>
    denyAllProviderRequests.request(bound, REQUEST_REF, REQUEST_INPUT)
  );
  assertEquals(providerFailureClass(error), {
    kind: "not_sent",
    retryable: false,
  });
});

Deno.test("github profile declares installation and repository as external identity", () => {
  const kind = HOST_AUTH_PROFILES["github-app"]!.resourceKinds[
    "github.repository"
  ]!;
  assertEquals(kind.externalIdentity, {
    account: "installationId",
    resource: "repositoryId",
  });
  assertHostProfile(HOST_AUTH_PROFILES["github-app"]!);
});

Deno.test("assertHostProfile rejects bad external identity declarations", () => {
  const github = HOST_AUTH_PROFILES["github-app"]!;
  const kind = github.resourceKinds["github.repository"]!;
  const withIdentity = (
    externalIdentity: { account: string; resource: string },
  ) => ({
    ...github,
    resourceKinds: { "github.repository": { ...kind, externalIdentity } },
  });
  for (
    const identity of [
      { account: "installationId", resource: "installationId" },
      { account: "installationId", resource: "missing" },
      { account: "constructor", resource: "repositoryId" },
    ]
  ) {
    let threw = false;
    try {
      assertHostProfile(withIdentity(identity));
    } catch (error) {
      threw = (error as Error).message.includes("external identity");
    }
    assert(threw, JSON.stringify(identity));
  }
});

// ---- Phase 3a: ledger schema, digest and description audit ----

const identity: EffectIdentity = {
  operation: ACTION,
  actionVersion: 1,
  target: `integration-resource:${RESOURCE}`,
  connectionId: CONNECTION,
  resourceId: RESOURCE,
  externalAccountId: "9001",
  externalResourceId: "7001",
  arguments: ARGS,
  actorRef: ACTOR,
  runStepId: null,
  automationDefinitionId: null,
  budgetReservationId: null,
  approval: null,
};

Deno.test("request digest is canonical and stable", async () => {
  const first = await computeRequestDigest(identity);
  assert(/^[0-9a-f]{64}$/.test(first));
  const reordered = await computeRequestDigest({
    ...identity,
    arguments: { body: "hello", issueNumber: 7 },
  });
  assertEquals(reordered, first);
});

Deno.test("request digest changes with every identity field", async () => {
  const base = await computeRequestDigest(identity);
  const variants: Record<string, EffectIdentity> = {
    operation: { ...identity, operation: "github.issue.comment.update" },
    actionVersion: { ...identity, actionVersion: 2 },
    target: { ...identity, target: "integration-resource:other" },
    connectionId: { ...identity, connectionId: RESOURCE },
    resourceId: { ...identity, resourceId: CONNECTION },
    externalAccountId: { ...identity, externalAccountId: "9002" },
    externalResourceId: { ...identity, externalResourceId: "7002" },
    arguments: { ...identity, arguments: { ...ARGS, body: "other" } },
    actorRef: { ...identity, actorRef: CONNECTION },
    runStepId: { ...identity, runStepId: REPOSITORY },
    automationDefinitionId: { ...identity, automationDefinitionId: REPOSITORY },
    budgetReservationId: { ...identity, budgetReservationId: REPOSITORY },
    approval: {
      ...identity,
      approval: { id: REPOSITORY, stage: "plan", policyDigest: "p1" },
    },
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert(
      (await computeRequestDigest(variant)) !== base,
      `digest ignores ${name}`,
    );
  }
});

Deno.test("request digest ignores authority version counters", async () => {
  const base = await computeRequestDigest(identity);
  const withCounters = {
    ...identity,
    authorizationRevision: 99,
    manifestDigest: "other-manifest",
    installId: "inst-2",
    grantId: "grant-2",
    effectId: "00000000-0000-4000-8000-0000000000ff",
  } as EffectIdentity;
  assertEquals(await computeRequestDigest(withCounters), base);
});

const now = new Date("2026-10-22T12:00:00Z");
const rowBase = {
  id: EFFECT,
  organizationId: ORG,
  runStepId: null,
  automationDefinitionId: null,
  subscriptionId: null,
  operation: ACTION,
  actionVersion: 1,
  target: `integration-resource:${RESOURCE}`,
  integrationConnectionId: CONNECTION,
  integrationResourceId: RESOURCE,
  mcpConnectionId: null,
  integrationInstallId: "inst-1",
  integrationGrantId: "grant-1",
  adapterManifestDigest: DIGEST,
  repositoryProfileId: null,
  requestingPrincipalId: ACTOR,
  actorRef: ACTOR,
  idempotencyKey: "key-1",
  requestDigest: "a".repeat(64),
  safeArguments: ARGS,
  argumentArtifactVersionId: null,
  externalAccountId: "9001",
  externalResourceId: "7001",
  adapterVersion: "bakery.github@1.0.0",
  credentialVersionId: null,
  authorizationRevision: 1,
  budgetReservationId: null,
  approvalId: null,
  approvalStage: null,
  approvalPolicyDigest: null,
  status: "prepared",
  remoteId: null,
  safeResult: null,
  failureCode: null,
  nextRetryAt: null,
  dispatchGeneration: 0,
  leaseExpiresAt: null,
  lastCheckedAt: null,
  reconciliationAttempts: 0,
  reconciliationEvidence: null,
  createdAt: now,
  updatedAt: now,
  version: 1,
};

Deno.test("ledger row schema accepts a complete integration row", () => {
  assert(ExternalEffectRowSchema.safeParse(rowBase).success);
});

Deno.test("ledger row schema enforces the integration-effect invariant", () => {
  for (
    const column of [
      "integrationConnectionId",
      "integrationResourceId",
      "actionVersion",
      "externalAccountId",
      "externalResourceId",
      "authorizationRevision",
      "integrationInstallId",
      "integrationGrantId",
      "adapterManifestDigest",
    ]
  ) {
    assert(
      !ExternalEffectRowSchema.safeParse({ ...rowBase, [column]: null })
        .success,
      `${column} may not be null for an integration effect`,
    );
  }
  assert(
    ExternalEffectRowSchema.safeParse({
      ...rowBase,
      target: "other:thing",
      integrationConnectionId: null,
      integrationResourceId: null,
      actionVersion: null,
      externalAccountId: null,
      externalResourceId: null,
      authorizationRevision: null,
      integrationInstallId: null,
      integrationGrantId: null,
      adapterManifestDigest: null,
    }).success,
  );
});

Deno.test("ledger row schema enforces approval and state rules", () => {
  const parse = (patch: Record<string, unknown>) =>
    ExternalEffectRowSchema.safeParse({ ...rowBase, ...patch }).success;
  assert(!parse({ approvalId: CONNECTION }));
  assert(
    !parse({
      approvalId: CONNECTION,
      approvalStage: "plan",
      approvalPolicyDigest: "p1",
    }),
  );
  assert(parse({
    approvalId: CONNECTION,
    approvalStage: "plan",
    approvalPolicyDigest: "p1",
    runStepId: REPOSITORY,
  }));
  assert(!parse({ status: "failed" }));
  assert(parse({ status: "failed", failureCode: "run_terminal" }));
  assert(!parse({ status: "submitted" }));
  assert(parse({ status: "submitted", dispatchGeneration: 1 }));
  assert(!parse({ leaseExpiresAt: now }));
  assert(!parse({ status: "bogus" }));
  assert(!parse({ extra: true }));
});

Deno.test("effect schemas carry meaningful descriptions", () => {
  for (
    const schema of [
      ExternalEffectRowSchema,
      PrepareEffectInputSchema,
      PrepareEffectResultSchema,
      EffectOutcomeSchema,
      ReconciliationEvidenceSchema,
      EffectApprovalRefSchema,
      EffectFailureCodeSchema,
      ExternalEffectStatusSchema,
      ClaimEffectInputSchema,
    ]
  ) {
    assertEquals(findSchemaDescriptionDefects(schema), []);
  }
});

Deno.test("run admission blocks terminal runs, canceled jobs and finished jobs only", () => {
  const run = (runStatus: string, stepStatus = "running") => ({
    runId: "r",
    taskId: "t",
    runStatus,
    stepStatus,
  });
  const job = (status: string, cancelRequested = false) => ({
    id: "j",
    status,
    cancelRequested,
  });
  assertEquals(runAdmission(null, []), null);
  assertEquals(runAdmission(run("running"), []), null);
  assertEquals(runAdmission(run("running"), [job("running")]), null);
  for (const status of ["completed", "failed", "canceled", "blocked"]) {
    assertEquals(runAdmission(run(status), []), "run_terminal");
    assertEquals(runAdmission(run("running", status), []), "run_terminal");
  }
  assertEquals(
    runAdmission(run("running"), [job("running", true)]),
    "job_canceled",
  );
  assertEquals(
    runAdmission(run("running"), [job("canceled")]),
    "job_canceled",
  );
  assertEquals(
    runAdmission(run("running"), [job("completed"), job("failed")]),
    "job_terminal",
  );
  assertEquals(
    runAdmission(run("running"), [job("completed"), job("running")]),
    null,
  );
});

// ---- outcome classification, request observation and the single write door ----

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const req = (
  state: RequestRecord["state"],
  extra: Partial<RequestRecord> = {},
): RequestRecord => ({ ref: "r@1", state, retryable: false, ...extra });

const classify = (
  end: HandlerEnd,
  requests: RequestRecord[],
  generation = 1,
  maxGenerations = 5,
) => classifyDispatch({ end, requests, generation, maxGenerations });

const THREW: HandlerEnd = { kind: "threw", timedOut: false };

Deno.test("classify: every started request must settle before anything but uncertain", () => {
  // An unsettled request wins over any handler end.
  assertEquals(
    classify({ kind: "resolved", output: { remoteId: "1" } }, [
      req("pending"),
    ]),
    { kind: "uncertain" },
  );
  assertEquals(classify(THREW, [req("pending")]), { kind: "uncertain" });
  assertEquals(classify(THREW, [req("not_sent"), req("pending")]), {
    kind: "uncertain",
  });
});

Deno.test("classify: resolved handler confirms with a bounded result", () => {
  assertEquals(
    classify({ kind: "resolved", output: { remoteId: "42" } }, [
      req("fulfilled"),
    ]),
    { kind: "confirmed", remoteId: "42", safeResult: { remoteId: "42" } },
  );
  assertEquals(classify({ kind: "resolved", output: {} }, []), {
    kind: "confirmed",
    remoteId: null,
    safeResult: {},
  });
  const huge = classify({
    kind: "resolved",
    output: { remoteId: "1", pad: "x".repeat(70_000) },
  }, [req("fulfilled")]);
  assertEquals(huge.kind, "confirmed");
  if (huge.kind === "confirmed") {
    assertEquals(huge.safeResult, null);
    assertEquals(huge.remoteId, "1");
  }
});

Deno.test("classify: a throw is final only when nothing may have reached the provider or it was refused", () => {
  // Never sent.
  assertEquals(classify(THREW, []), {
    kind: "failed",
    failureCode: "provider_not_sent",
  });
  assertEquals(classify(THREW, [req("not_sent")]), {
    kind: "failed",
    failureCode: "provider_not_sent",
  });
  assertEquals(classify(THREW, [req("not_sent", { retryable: true })]), {
    kind: "retry",
    retryAfterSeconds: 60,
  });
  // Authoritative refusal.
  assertEquals(classify(THREW, [req("rejected")]), {
    kind: "failed",
    failureCode: "provider_rejected",
  });
  assertEquals(
    classify(THREW, [
      req("not_sent"),
      req("rejected", { retryable: true, retryAfterSeconds: 30 }),
    ]),
    { kind: "retry", retryAfterSeconds: 30 },
  );
  // Retry exhaustion.
  assertEquals(
    classify(
      THREW,
      [req("rejected", { retryable: true, retryAfterSeconds: 30 })],
      5,
      5,
    ),
    { kind: "failed", failureCode: "retry_exhausted" },
  );
  // Everything else is unknown.
  for (
    const requests of [
      [req("unknown")],
      [req("fulfilled")],
      [req("rejected"), req("rejected")],
      [req("rejected"), req("unknown")],
      [req("fulfilled"), req("not_sent")],
    ]
  ) {
    assertEquals(classify(THREW, requests), { kind: "uncertain" });
  }
  // A deadline is always uncertain, even with nothing started.
  assertEquals(classify({ kind: "threw", timedOut: true }, []), {
    kind: "uncertain",
  });
  assertEquals(classify({ kind: "threw", timedOut: true }, [req("rejected")]), {
    kind: "uncertain",
  });
});

Deno.test("retry delay: provider hint is bounded, backoff doubles and is capped", () => {
  assertEquals(retryDelaySeconds(1, 5), 5);
  assertEquals(retryDelaySeconds(1, 0), 1);
  assertEquals(retryDelaySeconds(1, 99_999), 3600);
  assertEquals(retryDelaySeconds(1), 60);
  assertEquals(retryDelaySeconds(2), 120);
  assertEquals(retryDelaySeconds(3), 240);
  assertEquals(retryDelaySeconds(30), 3600);
});

function innerPort(
  behavior: (n: number) => Promise<unknown>,
): { port: ProviderRequestPort; calls: () => number } {
  let n = 0;
  return {
    port: { request: () => behavior(n++) },
    calls: () => n,
  };
}

const COMMENT_REF_FOR_TEST = { id: ACTION, version: 1 };

Deno.test("a fire-and-forget handler that returns leaves an unsettled request and is uncertain", async () => {
  const bound = await bind();
  const inner = innerPort(async () => {
    await tick(40);
    return { id: 1 };
  });
  const result = await runObserved({
    inner: inner.port,
    deadlineMs: 5_000,
    generation: 1,
    maxGenerations: 5,
    run: (port) => {
      // Starts the POST and does not wait for it.
      port.request(bound, COMMENT_REF_FOR_TEST, {}).catch(() => {});
      return Promise.resolve({ remoteId: "1" });
    },
  });
  assertEquals(result.outcome, { kind: "uncertain" });
  assertEquals(result.requests.map((r) => r.state), ["pending"]);
  assertEquals(inner.calls(), 1);
});

Deno.test("a fire-and-forget handler that then throws is uncertain, never failed", async () => {
  const bound = await bind();
  const inner = innerPort(async () => {
    await tick(40);
    throw markProviderFailure(new Error("late"), {
      kind: "rejected",
      retryable: false,
    });
  });
  const result = await runObserved({
    inner: inner.port,
    deadlineMs: 5_000,
    generation: 1,
    maxGenerations: 5,
    run: (port) => {
      port.request(bound, COMMENT_REF_FOR_TEST, {}).catch(() => {});
      return Promise.reject(new Error("handler gave up"));
    },
  });
  assertEquals(result.outcome, { kind: "uncertain" });
});

Deno.test("a request started after the handler settled is refused before the inner port", async () => {
  const bound = await bind();
  const inner = innerPort(() => Promise.resolve({ id: 1 }));
  let late: Promise<unknown> | undefined;
  const result = await runObserved({
    inner: inner.port,
    deadlineMs: 5_000,
    generation: 1,
    maxGenerations: 5,
    run: (port) => {
      late = (async () => {
        await tick(30);
        return await port.request(bound, COMMENT_REF_FOR_TEST, {});
      })();
      late.catch(() => {});
      return Promise.resolve({ remoteId: "1" });
    },
  });
  assertEquals(result.outcome.kind, "confirmed");
  const error = await assertRejects(() => late!);
  assertEquals(providerFailureClass(error), {
    kind: "not_sent",
    retryable: false,
  });
  assertEquals(inner.calls(), 0);
  assertEquals(result.requests.length, 0);
});

Deno.test("a handler that outlives the deadline is uncertain", async () => {
  const bound = await bind();
  const inner = innerPort(() => new Promise(() => {}));
  const result = await runObserved({
    inner: inner.port,
    deadlineMs: 30,
    generation: 1,
    maxGenerations: 5,
    run: (port) => port.request(bound, COMMENT_REF_FOR_TEST, {}),
  });
  assertEquals(result.outcome, { kind: "uncertain" });
});

Deno.test("observed requests carry the broker failure class into the outcome", async () => {
  const bound = await bind();
  const refusal = (cls: Parameters<typeof markProviderFailure>[1]) =>
    runObserved({
      inner: innerPort(() =>
        Promise.reject(markProviderFailure(new Error("x"), cls))
      )
        .port,
      deadlineMs: 5_000,
      generation: 1,
      maxGenerations: 5,
      run: (port) =>
        port.request(bound, COMMENT_REF_FOR_TEST, {}),
    });
  assertEquals(
    (await refusal({ kind: "rejected", retryable: true, retryAfterSeconds: 9 }))
      .outcome,
    { kind: "retry", retryAfterSeconds: 9 },
  );
  assertEquals(
    (await refusal({ kind: "rejected", retryable: false })).outcome,
    { kind: "failed", failureCode: "provider_rejected" },
  );
  assertEquals(
    (await refusal({ kind: "not_sent", retryable: false })).outcome,
    { kind: "failed", failureCode: "provider_not_sent" },
  );
  const unmarked = await runObserved({
    inner: innerPort(() => Promise.reject(new Error("5xx"))).port,
    deadlineMs: 5_000,
    generation: 1,
    maxGenerations: 5,
    run: (port) => port.request(bound, COMMENT_REF_FOR_TEST, {}),
  });
  assertEquals(unmarked.outcome, { kind: "uncertain" });
});

Deno.test("a confirmed result over the size bound is stored as null and keeps the remote id", () => {
  const small = confirmedOutcome({ remoteId: "9", note: "ok" });
  assertEquals(small.remoteId, "9");
  assertEquals(small.safeResult, { remoteId: "9", note: "ok" });
  const big = confirmedOutcome({ remoteId: "9", blob: "x".repeat(70_000) });
  assertEquals(big.remoteId, "9");
  assertEquals(big.safeResult, null);
  assertEquals(confirmedOutcome(undefined).safeResult, null);
});

Deno.test("executor lease timings must be positive whole seconds that outlast the deadline", () => {
  assertLeaseTimings({});
  assertLeaseTimings({
    leaseSeconds: 31,
    reconcileLeaseSeconds: 31,
    deadlineMs: 30_000,
  });
  const reasons: Array<
    [Parameters<typeof assertLeaseTimings>[0], string]
  > = [
    [{ leaseSeconds: 0 }, "effect_dispatch_lease_must_be_positive_integer"],
    [{ leaseSeconds: 1.5 }, "effect_dispatch_lease_must_be_positive_integer"],
    [
      { reconcileLeaseSeconds: -1 },
      "effect_reconcile_lease_must_be_positive_integer",
    ],
    [{ leaseSeconds: 60 }, "effect_dispatch_lease_must_exceed_deadline"],
    [
      { reconcileLeaseSeconds: 30, deadlineMs: 30_000 },
      "effect_reconcile_lease_must_exceed_deadline",
    ],
    [{ deadlineMs: 0 }, "effect_deadline_must_be_positive"],
  ];
  for (const [timings, reason] of reasons) {
    let caught: unknown;
    try {
      assertLeaseTimings(timings);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof StandardError, reason);
    assertEquals(caught.code, "UNPROCESSABLE");
    assertEquals(caught.params?.reason, reason);
  }
});

Deno.test("executor schemas carry meaningful descriptions", () => {
  for (
    const schema of [
      RecordOutcomeInputSchema,
      ReconcileEffectInputSchema,
      RunEffectInputSchema,
    ]
  ) {
    assertEquals(findSchemaDescriptionDefects(schema), []);
  }
});

Deno.test("source scan: one write call, reconcile reads only, no forbidden imports", async () => {
  const dir = new URL(
    "../../apps/server/src/modules/effects/",
    import.meta.url,
  );
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files: Record<string, string> = {};
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    files[entry.name] = stripComments(
      await Deno.readTextFile(new URL(entry.name, dir)),
    );
  }
  const invokes = Object.entries(files).flatMap(([name, text]) =>
    [...text.matchAll(/\.invoke\(/g)].map(() => name)
  );
  assertEquals(invokes, ["dispatch.ts"]);
  const reconciles = Object.entries(files).flatMap(([name, text]) =>
    [...text.matchAll(/invokeReconcile\(/g)].map(() => name)
  );
  assertEquals(reconciles, ["reconcile.ts"]);
  for (const [name, text] of Object.entries(files)) {
    for (
      const forbidden of [
        "modules/workflows",
        "modules/workflow-actions",
        "agent-run-admission",
        "run-steps",
        "integration-gate-broker-testing",
      ]
    ) {
      assert(
        !text.includes(forbidden),
        `${name} must not reference ${forbidden}`,
      );
    }
  }
  // Only dispatch.ts may build a write context.
  const writers = Object.entries(files).filter(([, text]) =>
    text.includes("createActionContext(")
  ).map(([name]) => name);
  assertEquals(writers, ["dispatch.ts"]);

  // dispatch.ts is internal: the public surface never exports a write or an
  // outcome writer, and nothing outside the module imports it.
  const index = files["index.ts"]!;
  assert(
    !/dispatch\.ts/.test(
      index.replace(
        /export \{ DEFAULT_DEADLINE_MS \} from "\.\/dispatch\.ts";/,
        "",
      ),
    ),
    "index.ts may export only DEFAULT_DEADLINE_MS from dispatch.ts",
  );
  for (
    const name of [
      "dispatchEffect",
      "recordOutcome",
      "runObserved",
      "claimEffect",
      "ClaimDeps",
      "ClaimResult",
    ]
  ) {
    assert(
      !new RegExp(`\\b${name}\\b`).test(index),
      `index.ts must not export ${name}`,
    );
  }
  const outside: string[] = [];
  const walk = async (root: URL): Promise<void> => {
    for await (const entry of Deno.readDir(root)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), root);
      if (entry.isDirectory) {
        if (entry.name === "node_modules") continue;
        if (child.pathname === dir.pathname) continue;
        await walk(child);
      } else if (entry.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(child);
        if (/effects\/dispatch(\.ts)?["']/.test(text)) {
          outside.push(child.pathname);
        }
      }
    }
  };
  for (const root of ["../../apps/", "../../packages/"]) {
    await walk(new URL(root, import.meta.url));
  }
  assertEquals(outside, []);
});
