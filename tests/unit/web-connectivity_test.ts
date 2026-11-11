import { assertEquals } from "@std/assert";
import {
  type ConnectivityState,
  initialConnectivityState,
  reduceConnectivity,
} from "../../apps/web/src/app/connectivity-state.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isConflictFailure,
  isForbiddenFailure,
  isStaleRead,
} from "../../apps/web/src/app/async-state.ts";
import {
  AuthProviderError,
} from "../../packages/contracts/src/auth-provider-client.ts";

function run(
  signals: readonly Parameters<typeof reduceConnectivity>[1][],
  tracksRefetch: boolean,
  start: ConnectivityState = initialConnectivityState(true),
): ConnectivityState {
  return signals.reduce(
    (state, signal) => reduceConnectivity(state, signal, tracksRefetch),
    start,
  );
}

Deno.test("connectivity starts offline only when the browser says so", () => {
  assertEquals(initialConnectivityState(true).connectivity, "online");
  assertEquals(initialConnectivityState(undefined).connectivity, "online");
  assertEquals(initialConnectivityState(false).connectivity, "offline");
});

Deno.test("a routine background refetch never reports reconnecting", () => {
  const settled = run(
    ["refetch-started", "refetch-settled", "data-updated"],
    true,
  );
  assertEquals(settled.connectivity, "online");
  const mid = run(["refetch-started"], true);
  assertEquals(mid.connectivity, "online");
});

Deno.test("reconnecting follows an outage until one read settles", () => {
  const offline = run(["offline"], true);
  assertEquals(offline.connectivity, "offline");
  const back = run(["online"], true, offline);
  assertEquals(back.connectivity, "reconnecting");
  // A refetch that settled before the awaited one started does not end it.
  assertEquals(
    run(["refetch-settled"], true, back).connectivity,
    "reconnecting",
  );
  const started = run(["refetch-started"], true, back);
  assertEquals(started.connectivity, "reconnecting");
  assertEquals(run(["refetch-settled"], true, started).connectivity, "online");
  assertEquals(run(["data-updated"], true, back).connectivity, "online");
});

Deno.test("going offline again cancels the wait for a read", () => {
  const back = run(["offline", "online", "refetch-started"], true);
  assertEquals(run(["offline"], true, back), {
    connectivity: "offline",
    awaitingRefetch: false,
    sawRefetch: false,
  });
});

Deno.test("a caller with no read to wait for goes straight back online", () => {
  const state = run(["offline", "online"], false);
  assertEquals(state.connectivity, "online");
  assertEquals(state.awaitingRefetch, false);
});

Deno.test("online while already online keeps the same state object", () => {
  const start = initialConnectivityState(true);
  assertEquals(reduceConnectivity(start, "online", true), start);
});

Deno.test("connectivity maps to a settings async notice", () => {
  assertEquals(asyncKindForConnectivity("online"), null);
  assertEquals(asyncKindForConnectivity("offline"), "offline");
  assertEquals(asyncKindForConnectivity("reconnecting"), "reconnecting");
});

Deno.test("failures classify as forbidden, conflict, offline or error", () => {
  const problem = (status: number) => ({
    kind: "problem" as const,
    problem: {
      type: "t",
      title: "t",
      status,
      code: "X",
      retryable: false,
      detail: "d",
      requestId: "r",
      traceId: "t",
    },
  });
  assertEquals(asyncKindForError(problem(403)), "forbidden");
  assertEquals(asyncKindForError(problem(409)), "conflict");
  assertEquals(asyncKindForError(problem(412)), "conflict");
  assertEquals(asyncKindForError(problem(500)), "error");
  assertEquals(asyncKindForError({ kind: "network" }), "offline");
  assertEquals(
    asyncKindForError(
      new AuthProviderError("NETWORK", {
        status: 0,
        requestId: "r",
        retryAfterSeconds: null,
      }),
    ),
    "offline",
  );
  assertEquals(isForbiddenFailure(problem(403)), true);
  assertEquals(isConflictFailure(problem(403)), false);
  assertEquals(isForbiddenFailure(new Error("x")), false);
});

Deno.test("a read older than its window is stale; an unread one is not", () => {
  assertEquals(isStaleRead(0, 100_000, 1_000), false);
  assertEquals(isStaleRead(10_000, 10_500, 1_000), false);
  assertEquals(isStaleRead(10_000, 12_000, 1_000), true);
});

Deno.test("a second online event while reconnecting does not end it before the read settles", () => {
  const back = run(["offline", "online"], true);
  assertEquals(back.connectivity, "reconnecting");
  const again = run(["online"], true, back);
  assertEquals(again.connectivity, "reconnecting");
  assertEquals(again.awaitingRefetch, true);
  const started = run(["refetch-started", "online"], true, back);
  assertEquals(started.connectivity, "reconnecting");
  assertEquals(run(["refetch-settled"], true, started).connectivity, "online");
});
