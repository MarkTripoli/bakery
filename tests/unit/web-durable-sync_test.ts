import { assertEquals } from "@std/assert";
import type {
  ApiFailure,
  ApiResult,
  BakeryApiClient,
  SyncResponse,
} from "../../apps/web/src/api/client.ts";
import {
  createDurableTaskSyncState,
  type DurableTaskSyncAuthority,
  durableTaskSyncReducer,
  noteDurableTaskInvalidation,
  pollDurableTaskSync,
} from "../../apps/web/src/api/durable-sync.ts";

const authority: DurableTaskSyncAuthority = {
  sessionGeneration: 4,
  organizationId: "org-a",
  taskId: "task-a",
};

function event(id: string, sequence: string) {
  return {
    id,
    sequence,
    type: "task.updated",
    schemaVersion: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    taskId: "task-a",
    repositoryId: null,
    payload: {},
    conversationId: null,
    workerHostId: null,
    workerEnrollmentId: null,
  } satisfies SyncResponse["events"][number];
}

function response(
  nextCursor: string | null,
  options: Readonly<{
    resourceState?: SyncResponse["resourceState"];
    events?: SyncResponse["events"];
  }> = {},
): SyncResponse {
  return {
    resourceState: options.resourceState ?? {},
    highwater: "9",
    events: options.events ?? [],
    nextCursor,
    resetRequired: false,
  };
}

function resetFailure(): ApiFailure {
  return {
    kind: "problem",
    problem: {
      type: "https://bakery.dev/problems/state-conflict",
      title: "State conflict",
      status: 409,
      code: "STATE_CONFLICT",
      retryable: false,
      detail: "Cursor expired",
      requestId: "00000000-0000-4000-8000-000000000001",
      traceId: "trace-a",
      resetRequired: true,
      retainedFrom: "8",
      retryWithoutAfter: true,
    },
  };
}

function queuedClient(
  queued: ApiResult<SyncResponse>[],
  calls: Parameters<BakeryApiClient["sync"]>[0][],
): Pick<BakeryApiClient, "sync"> {
  return {
    sync: (options) => {
      calls.push(options);
      const result = queued.shift();
      if (!result) throw new Error("unexpected sync call");
      return Promise.resolve(result);
    },
  };
}

function seededState(cursor = "cursor-0") {
  return durableTaskSyncReducer(createDurableTaskSyncState(authority), {
    type: "response",
    response: response(cursor, { resourceState: { task: { id: "task-a" } } }),
    requestedCursor: null,
    freshSnapshot: true,
  });
}

Deno.test("durable task sync consumes server cursors and preserves the terminal checkpoint", async () => {
  const calls: Parameters<BakeryApiClient["sync"]>[0][] = [];
  const result = await pollDurableTaskSync({
    client: queuedClient([
      { ok: true, data: response("cursor-7", { resourceState: { v: 1 } }) },
      { ok: true, data: response(null) },
    ], calls),
    state: createDurableTaskSyncState(authority),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });

  assertEquals(calls.map((call) => call.after), [undefined, "cursor-7"]);
  assertEquals(
    calls.map((call) => [
      call.organizationId,
      call.scopeType,
      call.scopeId,
    ]),
    [
      ["org-a", "task", "task-a"],
      ["org-a", "task", "task-a"],
    ],
  );
  assertEquals(result.reason, "caught-up");
  assertEquals(result.pages, 2);
  assertEquals(result.state.resourceState, { v: 1 });
  assertEquals(result.state.confirmedCursor, "cursor-7");
  assertEquals(result.state.caughtUp, true);
  assertEquals(result.state.connectivity, "online");
});

Deno.test("durable task sync bounds pagination and retains the actual continuation", async () => {
  const calls: Parameters<BakeryApiClient["sync"]>[0][] = [];
  const result = await pollDurableTaskSync({
    client: queuedClient([
      { ok: true, data: response("cursor-7") },
      { ok: true, data: response("cursor-93") },
    ], calls),
    state: seededState(),
    signal: new AbortController().signal,
    isCurrent: () => true,
    maxPages: 2,
  });

  assertEquals(calls.map((call) => call.after), ["cursor-0", "cursor-7"]);
  assertEquals(result.reason, "page-limit");
  assertEquals(result.pages, 2);
  assertEquals(result.state.confirmedCursor, "cursor-93");
  assertEquals(result.state.caughtUp, false);
});

Deno.test("network retry preserves the confirmed cursor and reports explicit connectivity", async () => {
  const calls: Parameters<BakeryApiClient["sync"]>[0][] = [];
  const network = { ok: false as const, error: { kind: "network" as const } };
  assertEquals(
    createDurableTaskSyncState(authority).connectivity,
    "unknown",
  );
  const recovered = await pollDurableTaskSync({
    client: queuedClient([
      network,
      { ok: true, data: response(null) },
    ], calls),
    state: seededState("cursor-5"),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(calls.map((call) => call.after), ["cursor-5", "cursor-5"]);
  assertEquals(recovered.state.confirmedCursor, "cursor-5");
  assertEquals(recovered.state.connectivity, "online");

  const exhausted = await pollDurableTaskSync({
    client: queuedClient([network, network], []),
    state: seededState("cursor-5"),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(exhausted.reason, "reconnecting");
  assertEquals(exhausted.attempts, 2);
  assertEquals(exhausted.state.confirmedCursor, "cursor-5");
  assertEquals(exhausted.state.resourceState, { task: { id: "task-a" } });

  const offline = await pollDurableTaskSync({
    client: queuedClient([network, network], []),
    state: createDurableTaskSyncState(authority),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(offline.reason, "offline");
  assertEquals(offline.state.connectivity, "offline");
  assertEquals(offline.state.confirmedCursor, null);
});

Deno.test("cursor reset performs one fresh snapshot and never loops", async () => {
  const calls: Parameters<BakeryApiClient["sync"]>[0][] = [];
  const recovered = await pollDurableTaskSync({
    client: queuedClient([
      { ok: false, error: resetFailure() },
      { ok: true, data: response("cursor-fresh", { resourceState: { v: 2 } }) },
      { ok: true, data: response(null) },
    ], calls),
    state: seededState("cursor-expired"),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(calls.map((call) => call.after), [
    "cursor-expired",
    undefined,
    "cursor-fresh",
  ]);
  assertEquals(recovered.resetPerformed, true);
  assertEquals(recovered.state.resourceState, { v: 2 });
  assertEquals(recovered.state.confirmedCursor, "cursor-fresh");

  const boundedCalls: Parameters<BakeryApiClient["sync"]>[0][] = [];
  const bounded = await pollDurableTaskSync({
    client: queuedClient([
      { ok: false, error: resetFailure() },
      { ok: false, error: resetFailure() },
    ], boundedCalls),
    state: seededState("cursor-expired"),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(boundedCalls.length, 2);
  assertEquals(bounded.reason, "error");
  assertEquals(bounded.resetPerformed, true);
  assertEquals(bounded.state.confirmedCursor, "cursor-expired");
});

Deno.test("events are deduplicated invalidation hints and never patch the snapshot", async () => {
  const duplicate = event("event-a", "8");
  const result = await pollDurableTaskSync({
    client: queuedClient([
      { ok: true, data: response("cursor-8", { events: [duplicate] }) },
      { ok: true, data: response(null, { events: [duplicate] }) },
    ], []),
    state: seededState(),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assertEquals(result.invalidationEventIds, ["event-a"]);
  assertEquals(result.state.recentEventIds, ["event-a"]);
  assertEquals(result.state.resourceState, { task: { id: "task-a" } });

  const same = noteDurableTaskInvalidation(result.state, authority, duplicate);
  assertEquals(same, result.state);
  const refreshed = durableTaskSyncReducer(same, {
    type: "response",
    response: response("cursor-fresh", { resourceState: { v: 3 } }),
    requestedCursor: null,
    freshSnapshot: true,
  });
  assertEquals(refreshed.recentEventIds, ["event-a"]);
  assertEquals(refreshed.resourceState, { v: 3 });
  const wrongTask = noteDurableTaskInvalidation(
    result.state,
    authority,
    { ...duplicate, id: "event-b", taskId: "task-b" },
  );
  assertEquals(wrongTask, result.state);
  const staleAuthority = noteDurableTaskInvalidation(
    result.state,
    { ...authority, sessionGeneration: 5 },
    { ...duplicate, id: "event-c" },
  );
  assertEquals(staleAuthority, result.state);
});

Deno.test("late responses after cancellation or authority change are ignored", async () => {
  for (const stop of ["cancel", "scope"] as const) {
    const controller = new AbortController();
    let current = true;
    let resolve!: (result: ApiResult<SyncResponse>) => void;
    let receivedSignal: AbortSignal | undefined;
    const pending = new Promise<ApiResult<SyncResponse>>((done) => {
      resolve = done;
    });
    const state = seededState("cursor-safe");
    const poll = pollDurableTaskSync({
      client: {
        sync: (options) => {
          receivedSignal = options.signal;
          return pending;
        },
      },
      state,
      signal: controller.signal,
      isCurrent: () => current,
    });
    if (stop === "cancel") controller.abort();
    else current = false;
    resolve({ ok: true, data: response("cursor-stale") });

    const result = await poll;
    assertEquals(receivedSignal, controller.signal);
    assertEquals(
      result.reason,
      stop === "cancel" ? "cancelled" : "scope-changed",
    );
    assertEquals(result.state, state);
    assertEquals(result.state.confirmedCursor, "cursor-safe");
  }
});
