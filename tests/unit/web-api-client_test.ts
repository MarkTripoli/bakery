import { assertEquals } from "@std/assert";
import type { HealthResponse } from "../../packages/contracts/src/health.ts";
import {
  createBakeryApiClient,
  type RunControlCapabilities,
} from "../../apps/web/src/api/client.ts";

const health: HealthResponse = {
  service: "bakery-server",
  state: "unavailable",
  version: "test",
  dependencies: [{
    name: "postgres",
    state: "unavailable",
    reason: "CONNECTION_FAILED",
  }],
};

const problem = {
  type: "https://bakery.example/problems/auth-required",
  title: "Authentication required",
  status: 401,
  detail: "Authentication is required.",
  code: "AUTH_REQUIRED",
  requestId: "00000000-0000-4000-8000-000000000124",
  traceId: "00000000-0000-4000-8000-000000000125",
  retryable: false,
};

function fetchReturning(response: () => Response): typeof fetch {
  return (() => Promise.resolve(response())) as typeof fetch;
}

Deno.test("readiness treats a 503 health payload as typed data", async () => {
  const client = createBakeryApiClient({
    fetchImpl: fetchReturning(() => Response.json(health, { status: 503 })),
  });
  assertEquals(await client.readiness(), { ok: true, data: health });
});

Deno.test("readiness rejects malformed success payloads", async () => {
  const client = createBakeryApiClient({
    fetchImpl: fetchReturning(() => Response.json({ state: "ok" })),
  });
  assertEquals(await client.readiness(), {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
});

Deno.test("tasks list uses generated parameters and returns bounded Problems", async () => {
  let captured: Request | undefined;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return Promise.resolve(Response.json(
        { ...problem, ignoredSecret: "not projected" },
        {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        },
      ));
    }) as typeof fetch,
  });
  assertEquals(
    await client.listTasks({
      organizationId: "00000000-0000-4000-8000-000000000000",
      cursor: "next",
      limit: 25,
    }),
    { ok: false, error: { kind: "problem", problem } },
  );
  assertEquals(
    captured?.url,
    "https://bakery.example/v1/tasks?cursor=next&limit=25",
  );
  assertEquals(
    captured?.headers.get("Bakery-Organization-Id"),
    "00000000-0000-4000-8000-000000000000",
  );
  assertEquals(captured?.credentials, "include");
});

Deno.test("task creation dispatches the generated operation with the reviewed profile", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000000";
  const applicationId = "00000000-0000-4000-8000-000000000001";
  const repositoryId = "00000000-0000-4000-8000-000000000010";
  const repositoryProfileId = "00000000-0000-4000-8000-000000000011";
  let captured: Request | undefined;
  const task = {
    id: "00000000-0000-4000-8000-000000000012",
    applicationId,
    repositoryId,
    conversationId: "00000000-0000-4000-8000-000000000013",
    parentTaskId: null,
    title: "Profile-bound task",
    description: "Preserve the reviewed profile.",
    taskType: "feature",
    status: "draft",
    priority: 50,
    createdBy: "00000000-0000-4000-8000-000000000014",
    currentRunId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    repositoryProfileId,
    repositoryProfileRevision: 3,
    repositoryProfileDigest: "a".repeat(64),
    observationId: null,
    observationDigest: null,
    baseSha: null,
  } as const;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return Promise.resolve(Response.json(task, { status: 201 }));
    }) as typeof fetch,
  });

  assertEquals(
    await client.createTask({
      organizationId,
      idempotencyKey: "task-create-key",
      input: {
        applicationId,
        repositoryId,
        repositoryProfileId,
        taskType: "feature",
        title: task.title,
        description: task.description,
      },
    }),
    { ok: true, data: task },
  );
  assertEquals(captured?.url, "https://bakery.example/v1/tasks");
  assertEquals(captured?.method, "POST");
  assertEquals(captured?.headers.get("Bakery-Organization-Id"), organizationId);
  assertEquals(captured?.headers.get("Idempotency-Key"), "task-create-key");
  assertEquals(
    (await captured?.json()).repositoryProfileId,
    repositoryProfileId,
  );
});

Deno.test("run control dispatches exact path, input, headers, and signal", async () => {
  const runId = "00000000-0000-4000-8000-000000000002";
  const organizationId = "00000000-0000-4000-8000-000000000000";
  const controller = new AbortController();
  let captured: Request | undefined;
  const run = {
    id: runId,
    taskId: "00000000-0000-4000-8000-000000000001",
    workflowVersionId: "00000000-0000-4000-8000-000000000003",
    repositoryProfileId: null,
    repositoryProfileRevision: null,
    repositoryProfileDigest: null,
    observationId: null,
    observationDigest: null,
    baseSha: null,
    workspaceBaseSha: null,
    requestedBy: "00000000-0000-4000-8000-000000000004",
    inngestRunId: null,
    status: "running",
    budgetLimitUsd: "1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    budgetSummary: {
      installation: null,
      run: {
        scope: "run",
        runId,
        periodStart: null,
        periodEnd: null,
        limitUsd: "1",
        reservedUsd: "0",
        settledUsd: "0",
        availableUsd: "1",
        unknownCount: 1,
      },
    },
  } as const;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return Promise.resolve(Response.json(run));
    }) as typeof fetch,
  });
  assertEquals(
    await client.controlRun({
      organizationId,
      runId,
      input: { action: "pause", reason: "operator request" },
      idempotencyKey: "control-retry-key",
      signal: controller.signal,
    }),
    { ok: true, data: run },
  );
  assertEquals(
    captured?.url,
    `https://bakery.example/v1/runs/${runId}/controls`,
  );
  assertEquals(captured?.method, "POST");
  assertEquals(captured?.headers.get("Idempotency-Key"), "control-retry-key");
  assertEquals(captured?.headers.get("Bakery-Organization-Id"), organizationId);
  assertEquals(await captured?.json(), {
    action: "pause",
    reason: "operator request",
  });
  assertEquals(captured?.signal.aborted, false);
  controller.abort();
  assertEquals(captured?.signal.aborted, true);
});

Deno.test("run control capabilities dispatches canonical GET with scope and signal", async () => {
  const runId = "00000000-0000-4000-8000-000000000002";
  const organizationId = "00000000-0000-4000-8000-000000000000";
  const controller = new AbortController();
  let captured: Request | undefined;
  const capabilities = {
    runId,
    actions: [
      { action: "pause", canRequest: true, reason: "allowed" },
      { action: "resume", canRequest: false, reason: "no_active_attempt" },
      { action: "cancel", canRequest: false, reason: "authority_unavailable" },
      { action: "interrupt", canRequest: false, reason: "already_terminal" },
    ],
  } satisfies RunControlCapabilities;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return Promise.resolve(Response.json(capabilities));
    }) as typeof fetch,
  });
  assertEquals(
    await client.getRunControlCapabilities({
      organizationId,
      runId,
      signal: controller.signal,
    }),
    { ok: true, data: capabilities },
  );
  assertEquals(
    captured?.url,
    `https://bakery.example/v1/runs/${runId}/controls`,
  );
  assertEquals(captured?.method, "GET");
  assertEquals(captured?.headers.get("Bakery-Organization-Id"), organizationId);
  assertEquals(captured?.credentials, "include");
  assertEquals(captured?.signal?.aborted, false);
  controller.abort();
  assertEquals(captured?.signal?.aborted, true);
});

Deno.test("run control capabilities rejects wrong IDs and malformed payloads", async () => {
  const runId = "00000000-0000-4000-8000-000000000002";
  const options = { organizationId: "org-a", runId };
  const wrongIdClient = createBakeryApiClient({
    fetchImpl: fetchReturning(() =>
      Response.json({
        runId: "00000000-0000-4000-8000-000000000099",
        actions: [],
      })
    ),
  });
  assertEquals(await wrongIdClient.getRunControlCapabilities(options), {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
  const malformedClient = createBakeryApiClient({
    fetchImpl: fetchReturning(() =>
      Response.json({ runId, actions: [{ nope: true }] })
    ),
  });
  assertEquals(await malformedClient.getRunControlCapabilities(options), {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
});

Deno.test("run control preserves typed forbidden and conflict Problems", async () => {
  for (
    const [status, code] of [[403, "AUTH_FORBIDDEN"], [
      409,
      "STATE_CONFLICT",
    ]] as const
  ) {
    const failure = { ...problem, status, code };
    const client = createBakeryApiClient({
      fetchImpl: fetchReturning(() =>
        Response.json(failure, {
          status,
          headers: { "content-type": "application/problem+json" },
        })
      ),
    });
    assertEquals(
      await client.controlRun({
        organizationId: "00000000-0000-4000-8000-000000000000",
        runId: "00000000-0000-4000-8000-000000000002",
        input: { action: "cancel" },
        idempotencyKey: "k",
      }),
      { ok: false, error: { kind: "problem", problem: failure } },
    );
  }
});

Deno.test("auth.signOut reaches the sign-out endpoint through the injected baseUrl and fetchImpl", async () => {
  let captured: Request | undefined;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);
      return Promise.resolve(Response.json({}, { status: 200 }));
    }) as typeof fetch,
  });

  await client.auth.signOut();

  assertEquals(captured?.url, "https://bakery.example/api/auth/sign-out");
});

Deno.test("Problem media type and required fields fail closed", async () => {
  for (
    const response of [
      () => Response.json(problem, { status: 401 }),
      () =>
        Response.json(
          { ...problem, traceId: undefined },
          {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          },
        ),
    ]
  ) {
    const client = createBakeryApiClient({
      fetchImpl: fetchReturning(response),
    });
    assertEquals(await client.readiness(), {
      ok: false,
      error: { kind: "invalid-response", status: 401 },
    });
  }
});

Deno.test("fetch rejection and abort collapse to network failure", async () => {
  const client = createBakeryApiClient({
    fetchImpl: (() =>
      Promise.reject(new Error("secret transport text"))) as typeof fetch,
  });
  assertEquals(await client.readiness(), {
    ok: false,
    error: { kind: "network" },
  });
});

const repository = {
  id: "00000000-0000-4000-8000-000000000010",
  applicationId: "00000000-0000-4000-8000-000000000001",
  integrationConnectionId: "00000000-0000-4000-8000-000000000002",
  providerRepoId: "12345",
  owner: "octo",
  name: "bakery",
  defaultBranch: "main",
  activeProfileId: "00000000-0000-4000-8000-000000000011",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 3,
};

const repositoryProfile = {
  id: "00000000-0000-4000-8000-000000000011",
  repositoryId: "00000000-0000-4000-8000-000000000010",
  revision: 1,
  config: { schemaVersion: 1 },
  digest: "a".repeat(64),
  createdBy: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

Deno.test("updateRepository and createRepositoryProfile substitute the path id and forward concurrency/idempotency headers", async () => {
  const repositoryId = repository.id;
  const organizationId = "00000000-0000-4000-8000-000000000000";

  let updateCaptured: Request | undefined;
  const updateClient = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      updateCaptured = new Request(input, init);
      return Promise.resolve(Response.json(repository, { status: 200 }));
    }) as typeof fetch,
  });
  await updateClient.updateRepository({
    organizationId,
    id: repositoryId,
    input: { activeProfileId: repositoryProfile.id },
    ifMatch: '"2"',
    idempotencyKey: "k",
  });
  assertEquals(
    updateCaptured?.url,
    `https://bakery.example/v1/repositories/${repositoryId}`,
  );
  assertEquals(updateCaptured?.method, "PATCH");
  assertEquals(updateCaptured?.headers.get("If-Match"), '"2"');
  assertEquals(updateCaptured?.headers.get("Idempotency-Key"), "k");
  assertEquals(
    updateCaptured?.headers.get("Bakery-Organization-Id"),
    organizationId,
  );
  assertEquals(await updateCaptured?.json(), {
    activeProfileId: repositoryProfile.id,
  });

  let createCaptured: Request | undefined;
  const createClient = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      createCaptured = new Request(input, init);
      return Promise.resolve(
        Response.json(repositoryProfile, { status: 201 }),
      );
    }) as typeof fetch,
  });
  await createClient.createRepositoryProfile({
    organizationId,
    repositoryId,
    input: {
      revision: repositoryProfile.revision,
      config: repositoryProfile.config,
      digest: repositoryProfile.digest,
    },
    idempotencyKey: "k2",
  });
  assertEquals(
    createCaptured?.url,
    `https://bakery.example/v1/repositories/${repositoryId}/profiles`,
  );
  assertEquals(createCaptured?.method, "POST");
  assertEquals(createCaptured?.headers.get("Idempotency-Key"), "k2");
  assertEquals(
    createCaptured?.headers.get("Bakery-Organization-Id"),
    organizationId,
  );
  assertEquals(await createCaptured?.json(), {
    revision: repositoryProfile.revision,
    config: repositoryProfile.config,
    digest: repositoryProfile.digest,
  });
});

Deno.test("task reads carry exact filters, authority and cancellation across the generated boundary", async () => {
  const requests: Request[] = [];
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    }) as typeof fetch,
  });
  const abort = new AbortController();
  const organizationId = "00000000-0000-4000-8000-000000000000";
  const repositoryId = "00000000-0000-4000-8000-000000000010";
  await client.listTasks({
    organizationId,
    repositoryId,
    status: "blocked",
    search: "%_\\",
    cursor: "opaque",
    limit: 25,
    signal: abort.signal,
  });
  const url = new URL(requests[0].url);
  assertEquals(Object.fromEntries(url.searchParams), {
    repositoryId,
    status: "blocked",
    search: "%_\\",
    cursor: "opaque",
    limit: "25",
  });
  assertEquals(
    requests[0].headers.get("Bakery-Organization-Id"),
    organizationId,
  );
  abort.abort();
  assertEquals(requests[0].signal.aborted, true);
  const result = await client.getTask({ organizationId, id: repositoryId });
  assertEquals(
    requests[1].url,
    `https://bakery.example/v1/tasks/${repositoryId}`,
  );
  assertEquals(result, {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
});

Deno.test("run reads and sync use generated queries, authority, cancellation, and failures", async () => {
  const requests: Request[] = [];
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/runs/00000000-0000-4000-8000-000000000099") {
        return Promise.resolve(Response.json(problem, {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }));
      }
      if (url.pathname === "/v1/runs/00000000-0000-4000-8000-000000000002") {
        return Promise.resolve(
          Response.json({ id: "00000000-0000-4000-8000-000000000002" }),
        );
      }
      if (url.pathname === "/v1/sync") {
        return Promise.resolve(Response.json({
          resourceState: {},
          highwater: "1",
          events: [],
          nextCursor: null,
          resetRequired: false,
        }));
      }
      return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    }) as typeof fetch,
  });
  const organizationId = "00000000-0000-4000-8000-000000000000";
  const controller = new AbortController();
  const signal = controller.signal;

  assertEquals(
    await client.listRuns({
      organizationId,
      taskId: "00000000-0000-4000-8000-000000000001",
      cursor: "cursor-1",
      limit: 10,
      signal,
    }),
    { ok: true, data: { items: [], nextCursor: null } },
  );
  assertEquals(
    await client.getRun({
      organizationId,
      runId: "00000000-0000-4000-8000-000000000002",
    }),
    {
      ok: false,
      error: { kind: "invalid-response", status: 200 },
    },
  );
  assertEquals(
    await client.listRunSteps({
      organizationId,
      runId: "00000000-0000-4000-8000-000000000002",
      cursor: "cursor-2",
      limit: 20,
    }),
    { ok: true, data: { items: [], nextCursor: null } },
  );
  assertEquals(
    await client.sync({
      organizationId,
      scopeType: "task",
      scopeId: "00000000-0000-4000-8000-000000000001",
      after: "event-1",
      limit: 50,
    }),
    {
      ok: true,
      data: {
        resourceState: {},
        highwater: "1",
        events: [],
        nextCursor: null,
        resetRequired: false,
      },
    },
  );

  assertEquals(requests.map((request) => request.url), [
    "https://bakery.example/v1/tasks/00000000-0000-4000-8000-000000000001/runs?cursor=cursor-1&limit=10",
    "https://bakery.example/v1/runs/00000000-0000-4000-8000-000000000002",
    "https://bakery.example/v1/runs/00000000-0000-4000-8000-000000000002/steps?cursor=cursor-2&limit=20",
    "https://bakery.example/v1/sync?scopeType=task&scopeId=00000000-0000-4000-8000-000000000001&after=event-1&limit=50",
  ]);
  for (const request of requests) {
    assertEquals(request.headers.get("Bakery-Organization-Id"), organizationId);
  }
  controller.abort();
  assertEquals(requests[0].signal.aborted, true);

  const failure = await client.getRun({
    organizationId,
    runId: "00000000-0000-4000-8000-000000000099",
  });
  assertEquals(failure, { ok: false, error: { kind: "problem", problem } });
});

Deno.test("sync preserves validated cursor reset problem metadata", async () => {
  const resetProblem = {
    type: "https://bakery.example/problems/state-conflict",
    title: "State conflict",
    status: 409,
    detail: "The sync cursor is outside retention.",
    code: "STATE_CONFLICT",
    requestId: "00000000-0000-4000-8000-000000000126",
    traceId: "00000000-0000-4000-8000-000000000127",
    retryable: false,
    resetRequired: true,
    retainedFrom: "42",
    retryWithoutAfter: true,
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: fetchReturning(() =>
      Response.json(resetProblem, {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      })
    ),
  });

  assertEquals(
    await client.sync({
      organizationId: "00000000-0000-4000-8000-000000000000",
      scopeType: "task",
      scopeId: "00000000-0000-4000-8000-000000000001",
      after: "expired-cursor",
    }),
    { ok: false, error: { kind: "problem", problem: resetProblem } },
  );
});

const SETTINGS_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
const SETTINGS_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000001";

function capturing(body: unknown, sink: { request?: Request }): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    sink.request = new Request(input, init);
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;
}

Deno.test("profile update sends the version as a strong If-Match with an idempotency key", async () => {
  const sink: { request?: Request } = {};
  const profile = {
    principalId: SETTINGS_PRINCIPAL_ID,
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    title: null,
    image: null,
    email: "ada@example.test",
    emailVerified: false,
    version: 4,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(profile, sink),
  });
  const result = await client.profile.update({
    input: { name: "Ada Lovelace" },
    version: 3,
    idempotencyKey: "profile-key",
  });
  assertEquals(result, { ok: true, data: profile });
  assertEquals(sink.request?.method, "PATCH");
  assertEquals(sink.request?.url, "https://bakery.example/v1/me/profile");
  assertEquals(sink.request?.headers.get("If-Match"), '"v3"');
  assertEquals(sink.request?.headers.get("Idempotency-Key"), "profile-key");
  assertEquals(sink.request?.headers.get("Bakery-Organization-Id"), null);
});

Deno.test("preference update scopes to the organization and carries the CAS version in the body", async () => {
  const sink: { request?: Request } = {};
  const preferences = {
    id: null,
    organizationId: SETTINGS_ORGANIZATION_ID,
    principalId: SETTINGS_PRINCIPAL_ID,
    theme: "dark" as const,
    locale: null,
    timeZone: "Europe/Paris",
    effectiveLocale: "en",
    direction: "ltr" as const,
    availableLocales: ["en"],
    casVersion: 2,
    createdAt: null,
    updatedAt: null,
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(preferences, sink),
  });
  const result = await client.userPreferences.update({
    organizationId: SETTINGS_ORGANIZATION_ID,
    input: { theme: "dark", timeZone: "Europe/Paris", expectedCasVersion: 1 },
    idempotencyKey: "preference-key",
  });
  assertEquals(result, { ok: true, data: preferences });
  assertEquals(sink.request?.method, "PATCH");
  assertEquals(
    sink.request?.headers.get("Bakery-Organization-Id"),
    SETTINGS_ORGANIZATION_ID,
  );
  assertEquals(sink.request?.headers.get("Idempotency-Key"), "preference-key");
  assertEquals(sink.request?.headers.get("If-Match"), null);
  assertEquals((await sink.request?.json()).expectedCasVersion, 1);
});

Deno.test("organization update sends defaultLocale with a strong If-Match", async () => {
  const sink: { request?: Request } = {};
  const organization = {
    id: SETTINGS_ORGANIZATION_ID,
    name: "Fixture Org",
    slug: "fixture-org",
    logo: null,
    metadata: {},
    defaultLocale: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    version: 6,
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(organization, sink),
  });
  const result = await client.organizations.update({
    organizationId: SETTINGS_ORGANIZATION_ID,
    input: { defaultLocale: "en" },
    version: 5,
  });
  assertEquals(result, { ok: true, data: organization });
  assertEquals(sink.request?.method, "PATCH");
  assertEquals(
    sink.request?.url,
    `https://bakery.example/v1/organizations/${SETTINGS_ORGANIZATION_ID}`,
  );
  assertEquals(sink.request?.headers.get("If-Match"), '"v5"');
  assertEquals(
    sink.request?.headers.get("Bakery-Organization-Id"),
    SETTINGS_ORGANIZATION_ID,
  );
  assertEquals((await sink.request?.json()).defaultLocale, "en");
});

Deno.test("effective access is a scoped read that refuses another organization's answer", async () => {
  const sink: { request?: Request } = {};
  const access = {
    organizationId: SETTINGS_ORGANIZATION_ID,
    role: "developer" as const,
    capabilities: ["task:read" as const],
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(access, sink),
  });
  const result = await client.organizations.effectiveAccess({
    organizationId: SETTINGS_ORGANIZATION_ID,
  });
  assertEquals(result, { ok: true, data: access });
  assertEquals(sink.request?.method, "GET");
  assertEquals(
    sink.request?.url,
    `https://bakery.example/v1/organizations/${SETTINGS_ORGANIZATION_ID}/effective-access`,
  );
  assertEquals(
    sink.request?.headers.get("Bakery-Organization-Id"),
    SETTINGS_ORGANIZATION_ID,
  );
  const other = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing({
      ...access,
      organizationId: "00000000-0000-4000-8000-0000000000ff",
    }, {}),
  });
  const refused = await other.organizations.effectiveAccess({
    organizationId: SETTINGS_ORGANIZATION_ID,
  });
  assertEquals(refused.ok, false);
});

Deno.test("organization reads reject a record for a different organization", async () => {
  const sink: { request?: Request } = {};
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing({
      id: "00000000-0000-4000-8000-0000000000ff",
      name: "Other",
      slug: "other",
      logo: null,
      metadata: {},
      defaultLocale: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    }, sink),
  });
  const result = await client.organizations.get({
    organizationId: SETTINGS_ORGANIZATION_ID,
  });
  assertEquals(result.ok, false);
});

Deno.test("installation capabilities are a public enum projection with no organization scope", async () => {
  const sink: { request?: Request } = {};
  const availability = {
    registration: "invitation",
    organizationCreation: "installation_admins",
    ssoAvailable: false,
  } as const;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(availability, sink),
  });
  assertEquals(await client.installationCapabilities.get(), {
    ok: true,
    data: availability,
  });
  assertEquals(sink.request?.method, "GET");
  assertEquals(
    sink.request?.url,
    "https://bakery.example/v1/installation/capabilities",
  );
  assertEquals(sink.request?.headers.get("Bakery-Organization-Id"), null);
});

Deno.test("installation settings save sends the read version and explicit stable replay key", async () => {
  const sink: { request?: Request } = {};
  const record = {
    registrationMode: "closed",
    organizationCreationPolicy: "installation_admins",
    version: 3,
    updatedByPrincipalId: null,
    updatedAt: "2026-10-12T00:00:00.000Z",
  } as const;
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: capturing(record, sink),
  });
  assertEquals(
    await client.installationSettings.update({
      input: {
        registrationMode: "closed",
        organizationCreationPolicy: "installation_admins",
      },
      version: 2,
      idempotencyKey: "installation-change-1",
    }),
    { ok: true, data: record },
  );
  assertEquals(sink.request?.method, "PATCH");
  assertEquals(
    sink.request?.url,
    "https://bakery.example/v1/installation/settings",
  );
  assertEquals(sink.request?.headers.get("If-Match"), '"v2"');
  assertEquals(
    sink.request?.headers.get("Idempotency-Key"),
    "installation-change-1",
  );
  assertEquals(sink.request?.headers.get("Bakery-Organization-Id"), null);
});
