import { assertEquals } from "@std/assert";
import {
  createBakeryApiClient,
  type RunCreate,
  type RunResponse,
} from "../../apps/web/src/api/client.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const workflowVersionId = "00000000-0000-4000-8000-000000000003";
const repositoryProfileId = "00000000-0000-4000-8000-000000000004";
const runId = "00000000-0000-4000-8000-000000000005";
const otherId = "00000000-0000-4000-8000-000000000006";
const input: RunCreate = {
  workflowVersionId,
  repositoryProfileId,
  executionMode: "repository",
  budgetLimitUsd: "1.250000",
  inputs: { description: "Preserve this submitted intent." },
};
const options = {
  organizationId,
  taskId,
  input,
  idempotencyKey: "caller-owned-run-intent",
};
const run: RunResponse = {
  id: runId,
  taskId,
  workflowVersionId,
  repositoryProfileId,
  repositoryProfileRevision: 3,
  repositoryProfileDigest: "a".repeat(64),
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: otherId,
  inngestRunId: null,
  status: "queued",
  budgetLimitUsd: "1.250000",
  startedAt: null,
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
      limitUsd: "1.250000",
      reservedUsd: "0",
      settledUsd: "0",
      availableUsd: "1.250000",
      unknownCount: 0,
    },
  },
};

Deno.test("run creation treats malformed or mismatched admission receipts as unknown", async () => {
  for (
    const response of [
      {},
      { ...run, taskId: otherId },
      { ...run, workflowVersionId: otherId },
      { ...run, repositoryProfileId: otherId },
      { ...run, repositoryProfileId: null },
    ]
  ) {
    const client = createBakeryApiClient({
      fetchImpl: (() =>
        Promise.resolve(
          Response.json(response, { status: 201 }),
        )) as typeof fetch,
    });
    assertEquals(await client.createRun(options), {
      ok: false,
      error: { kind: "invalid-response", status: 201 },
    });
  }
});

Deno.test("run creation preserves bounded Problems without automatic mutation retries", async () => {
  for (
    const [status, code, retryable] of [
      [403, "AUTH_FORBIDDEN", false],
      [409, "STATE_CONFLICT", false],
      [409, "IDEMPOTENCY_IN_FLIGHT", true],
      [422, "UNPROCESSABLE_ENTITY", false],
      [429, "RATE_LIMITED", true],
      [503, "DEPENDENCY_UNAVAILABLE", true],
    ] as const
  ) {
    let calls = 0;
    const problem = {
      type: "https://bakery.example/problems/run-admission",
      title: "Run not admitted",
      status,
      code,
      retryable,
      detail: "The caller must use the returned admission outcome.",
      requestId: runId,
      traceId: otherId,
    };
    const client = createBakeryApiClient({
      fetchImpl: (() => {
        calls++;
        return Promise.resolve(
          Response.json({ ...problem, secret: "not exposed" }, {
            status,
            headers: { "content-type": "application/problem+json" },
          }),
        );
      }) as typeof fetch,
    });
    assertEquals(await client.createRun(options), {
      ok: false,
      error: { kind: "problem", problem },
    });
    assertEquals(calls, 1);
  }
});

Deno.test("run creation preserves an ambiguous lost response and the explicit retry key", async () => {
  const requests: Request[] = [];
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return requests.length === 1
        ? Promise.reject(new TypeError("response lost"))
        : Promise.resolve(Response.json(run, { status: 201 }));
    }) as typeof fetch,
  });
  assertEquals(await client.createRun(options), {
    ok: false,
    error: { kind: "network" },
  });
  assertEquals(requests.length, 1);
  assertEquals(await client.createRun(options), { ok: true, data: run });
  assertEquals(
    requests.map((request) => request.headers.get("Idempotency-Key")),
    [
      options.idempotencyKey,
      options.idempotencyKey,
    ],
  );
  assertEquals(await requests[0].json(), await requests[1].json());
});

Deno.test("run creation rejects a late receipt after observation was aborted", async () => {
  const controller = new AbortController();
  const client = createBakeryApiClient({
    fetchImpl: (() => {
      controller.abort();
      return Promise.resolve(Response.json(run, { status: 201 }));
    }) as typeof fetch,
  });
  assertEquals(
    await client.createRun({ ...options, signal: controller.signal }),
    {
      ok: false,
      error: { kind: "invalid-response", status: 201 },
    },
  );
});

Deno.test("cloud-only run creation does not invent a repository profile", async () => {
  const cloudInput: RunCreate = {
    workflowVersionId,
    executionMode: "cloud_only",
  };
  const cloudRun = {
    ...run,
    repositoryProfileId: null,
    repositoryProfileRevision: null,
    repositoryProfileDigest: null,
  };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: (() =>
      Promise.resolve(
        Response.json(cloudRun, { status: 201 }),
      )) as typeof fetch,
  });
  assertEquals(await client.createRun({ ...options, input: cloudInput }), {
    ok: true,
    data: cloudRun,
  });
});

const presetInput: RunCreate = {
  presetId: "fixed-coding",
  repositoryProfileId,
  executionMode: "repository",
  budgetLimitUsd: "5.00",
};
const presetOptions = {
  organizationId,
  taskId,
  input: presetInput,
  idempotencyKey: "caller-owned-intent:run",
};

Deno.test("preset run creation sends presetId only and records the materialized version", async () => {
  const requests: Request[] = [];
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return Promise.resolve(Response.json(run, { status: 201 }));
    }) as typeof fetch,
  });
  // The server picked workflowVersionId; the client has none to compare with.
  assertEquals(await client.createRun(presetOptions), {
    ok: true,
    data: run,
  });
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].headers.get("Idempotency-Key"),
    "caller-owned-intent:run",
  );
  const body = await requests[0].json();
  assertEquals(body.presetId, "fixed-coding");
  assertEquals("workflowVersionId" in body, false);
  assertEquals(body.repositoryProfileId, repositoryProfileId);
  assertEquals(body.executionMode, "repository");
  assertEquals(body.budgetLimitUsd, "5.00");
});

Deno.test("preset run creation still rejects receipts for another task or profile", async () => {
  for (
    const response of [
      { ...run, taskId: otherId },
      { ...run, repositoryProfileId: otherId },
      { ...run, repositoryProfileId: null },
      { ...run, workflowVersionId: null },
    ]
  ) {
    const client = createBakeryApiClient({
      fetchImpl: (() =>
        Promise.resolve(
          Response.json(response, { status: 201 }),
        )) as typeof fetch,
    });
    assertEquals(await client.createRun(presetOptions), {
      ok: false,
      error: { kind: "invalid-response", status: 201 },
    });
  }
});

Deno.test("preset run retry after a lost response replays the same key and body", async () => {
  const requests: Request[] = [];
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return requests.length === 1
        ? Promise.reject(new TypeError("response lost"))
        : Promise.resolve(Response.json(run, { status: 201 }));
    }) as typeof fetch,
  });
  assertEquals(await client.createRun(presetOptions), {
    ok: false,
    error: { kind: "network" },
  });
  assertEquals(await client.createRun(presetOptions), { ok: true, data: run });
  assertEquals(requests.length, 2);
  assertEquals(
    requests.map((request) => request.headers.get("Idempotency-Key")),
    ["caller-owned-intent:run", "caller-owned-intent:run"],
  );
  assertEquals(await requests[0].json(), await requests[1].json());
});

Deno.test("preset listing sends the repository filter and nothing else", async () => {
  const requests: Request[] = [];
  const page = { items: [], nextCursor: null };
  const client = createBakeryApiClient({
    baseUrl: "https://bakery.example",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return Promise.resolve(Response.json(page));
    }) as typeof fetch,
  });
  assertEquals(
    await client.listWorkflowPresets({ organizationId, repositoryId: otherId }),
    { ok: true, data: page },
  );
  assertEquals(await client.listWorkflowPresets({ organizationId }), {
    ok: true,
    data: page,
  });
  assertEquals(new URL(requests[0].url).pathname, "/v1/workflow-presets");
  assertEquals(
    new URL(requests[0].url).searchParams.get("repositoryId"),
    otherId,
  );
  assertEquals([...new URL(requests[1].url).searchParams.keys()], []);
});
