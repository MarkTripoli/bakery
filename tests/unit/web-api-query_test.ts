import { assertEquals } from "@std/assert";
import type { BakeryApiClient } from "../../apps/web/src/api/client.ts";
import { protectedQueryKey } from "../../apps/web/src/app/query-scope.ts";
import {
  readinessQueryOptions,
  runControlCapabilitiesQueryOptions,
  runQueryOptions,
  runsListQueryOptions,
  runStepsListQueryOptions,
  syncQueryOptions,
  tasksListQueryOptions,
} from "../../apps/web/src/api/query.ts";

const client: Pick<
  BakeryApiClient,
  | "readiness"
  | "listTasks"
  | "listRuns"
  | "getRun"
  | "getRunControlCapabilities"
  | "listRunSteps"
  | "sync"
  | "listApplications"
  | "createApplication"
  | "listRepositories"
  | "getRepository"
  | "createRepository"
  | "updateRepository"
  | "listRepositoryProfiles"
  | "createRepositoryProfile"
> = {
  readiness: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listTasks: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listRuns: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  getRun: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  getRunControlCapabilities: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listRunSteps: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  sync: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listApplications: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  createApplication: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listRepositories: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  getRepository: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  createRepository: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  updateRepository: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  listRepositoryProfiles: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
  createRepositoryProfile: () =>
    Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    }),
};

Deno.test("public readiness and protected resource keys stay in separate scopes", () => {
  assertEquals([...readinessQueryOptions(client).queryKey], [
    "public",
    "health",
    "ready",
  ]);
  assertEquals(
    [
      ...protectedQueryKey(
        { sessionGeneration: 7, organizationId: "organization-a" },
        "tasks.list",
        { cursor: null, limit: 25 },
      ),
    ],
    [
      "protected",
      7,
      "organization-a",
      "tasks.list",
      { cursor: null, limit: 25 },
    ],
  );
  assertEquals(
    [
      ...tasksListQueryOptions(
        client,
        { sessionGeneration: 0, organizationId: null },
      ).queryKey,
    ],
    [
      "protected",
      0,
      "none",
      "tasks.list",
      {
        cursor: null,
        limit: null,
        status: null,
        repositoryId: null,
        search: null,
      },
    ],
  );
});

Deno.test("scoped run query keys include every input and authority", () => {
  const scope = { sessionGeneration: 8, organizationId: "org-a" };
  assertEquals(
    [
      ...runsListQueryOptions(client, scope, "task-a", {
        cursor: "c",
        limit: 10,
      }).queryKey,
    ],
    ["protected", 8, "org-a", "runs.list", {
      taskId: "task-a",
      cursor: "c",
      limit: 10,
    }],
  );
  assertEquals(
    [...runQueryOptions(client, scope, "run-a").queryKey],
    ["protected", 8, "org-a", "runs.get", { runId: "run-a" }],
  );
  assertEquals(
    [...runControlCapabilitiesQueryOptions(client, scope, "run-a").queryKey],
    ["protected", 8, "org-a", "runs.controlCapabilities", { runId: "run-a" }],
  );
  assertEquals(
    [
      ...runStepsListQueryOptions(client, scope, "run-a", {
        cursor: "c",
        limit: 10,
      }).queryKey,
    ],
    ["protected", 8, "org-a", "runSteps.list", {
      runId: "run-a",
      cursor: "c",
      limit: 10,
    }],
  );
  assertEquals(
    [
      ...syncQueryOptions(client, scope, {
        scopeType: "task",
        scopeId: "task-a",
        after: "c",
        limit: 10,
      }).queryKey,
    ],
    ["protected", 8, "org-a", "sync.snapshot", {
      scopeType: "task",
      scopeId: "task-a",
      after: "c",
      limit: 10,
    }],
  );
  assertEquals(
    runsListQueryOptions(client, { ...scope, sessionGeneration: 9 }, "task-a")
      .queryKey[1],
    9,
  );
  assertEquals(
    runQueryOptions(client, { ...scope, organizationId: "org-b" }, "run-a")
      .queryKey[2],
    "org-b",
  );
});

Deno.test("scoped run queries forward the signal and reject missing scope", async () => {
  const signal = new AbortController().signal;
  let receivedSignal: AbortSignal | undefined;
  const scopedClient = {
    ...client,
    listRuns: (options: Parameters<BakeryApiClient["listRuns"]>[0]) => {
      receivedSignal = options.signal;
      return Promise.resolve({
        ok: false as const,
        error: { kind: "network" as const },
      });
    },
  } satisfies Pick<BakeryApiClient, "listRuns">;
  const query = runsListQueryOptions(
    scopedClient,
    { sessionGeneration: 1, organizationId: "org-a" },
    "task-a",
  );
  if (typeof query.queryFn !== "function") throw new Error("missing query fn");
  await Promise.resolve().then(() => query.queryFn!({ signal } as never))
    .catch(() => {});
  assertEquals(receivedSignal, signal);
  const unscopedQuery = runsListQueryOptions(
    client,
    { sessionGeneration: 1, organizationId: null },
    "task-a",
  );
  if (typeof unscopedQuery.queryFn !== "function") {
    throw new Error("missing unscoped query fn");
  }
  let failure: unknown;
  try {
    await Promise.resolve().then(() =>
      unscopedQuery.queryFn!({ signal } as never)
    );
  } catch (error) {
    failure = error;
  }
  assertEquals(failure, { kind: "invalid-response", status: 0 });
  assertEquals(unscopedQuery.enabled, false);
  assertEquals(
    runQueryOptions(
      client,
      { sessionGeneration: 1, organizationId: null },
      "run-a",
    ).enabled,
    false,
  );
  assertEquals(
    runStepsListQueryOptions(client, {
      sessionGeneration: 1,
      organizationId: null,
    }, "run-a").enabled,
    false,
  );
  assertEquals(
    runControlCapabilitiesQueryOptions(client, {
      sessionGeneration: 1,
      organizationId: null,
    }, "run-a").enabled,
    false,
  );
  assertEquals(
    syncQueryOptions(client, { sessionGeneration: 1, organizationId: null }, {
      scopeType: "task",
      scopeId: "task-a",
    }).enabled,
    false,
  );
});

Deno.test("all run query options forward signals and retry only network once", async () => {
  const signal = new AbortController().signal;
  const scope = { sessionGeneration: 1, organizationId: "org-a" };
  const receivedSignals: AbortSignal[] = [];
  const record = (received: AbortSignal | undefined) => {
    if (!received) throw new Error("missing forwarded signal");
    receivedSignals.push(received);
    return Promise.resolve({
      ok: false as const,
      error: { kind: "network" as const },
    });
  };
  const queries = [
    runsListQueryOptions(
      {
        ...client,
        listRuns: (options) => record(options.signal),
      },
      scope,
      "task-a",
    ),
    runQueryOptions(
      { ...client, getRun: (options) => record(options.signal) },
      scope,
      "run-a",
    ),
    runStepsListQueryOptions(
      {
        ...client,
        listRunSteps: (options) => record(options.signal),
      },
      scope,
      "run-a",
    ),
    runControlCapabilitiesQueryOptions(
      {
        ...client,
        getRunControlCapabilities: (options) => record(options.signal),
      },
      scope,
      "run-a",
    ),
    syncQueryOptions(
      { ...client, sync: (options) => record(options.signal) },
      scope,
      {
        scopeType: "task",
        scopeId: "task-a",
      },
    ),
  ];

  for (const query of queries) {
    if (typeof query.queryFn !== "function") {
      throw new Error("missing query fn");
    }
    await Promise.resolve().then(() => query.queryFn!({ signal } as never))
      .catch(() => {});
    if (typeof query.retry !== "function") {
      throw new Error("missing retry predicate");
    }
    assertEquals(query.retry(0, { kind: "network" }), true);
    assertEquals(query.retry(1, { kind: "network" }), false);
    assertEquals(query.retry(0, { kind: "problem" } as never), false);
    assertEquals(query.retry(0, { kind: "unexpected" } as never), false);
  }
  assertEquals(receivedSignals, [signal, signal, signal, signal, signal]);
});

Deno.test("task filter keys isolate pages and every authority generation", () => {
  const scope = { sessionGeneration: 3, organizationId: "org-a" };
  const input = {
    status: "draft" as const,
    repositoryId: "repo",
    search: "%_",
    cursor: "next",
    limit: 25,
  };
  const key = tasksListQueryOptions(client, scope, input).queryKey;
  assertEquals([...key], ["protected", 3, "org-a", "tasks.list", input]);
  for (
    const changed of [
      { ...input, search: "other" },
      { ...input, repositoryId: "other" },
      { ...input, status: "blocked" as const },
      { ...input, cursor: undefined },
    ]
  ) {
    assertEquals(
      JSON.stringify(tasksListQueryOptions(client, scope, changed).queryKey) ===
        JSON.stringify(key),
      false,
    );
  }
  assertEquals(
    tasksListQueryOptions(client, { ...scope, sessionGeneration: 4 })
      .queryKey[1],
    4,
  );
  assertEquals(
    tasksListQueryOptions(client, { ...scope, organizationId: "org-b" })
      .queryKey[2],
    "org-b",
  );
});
