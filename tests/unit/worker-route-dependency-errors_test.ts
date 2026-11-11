import { assert, assertEquals, assertFalse } from "@std/assert";
import { StandardError, toProblem } from "../../packages/contracts/src/http.ts";
import { isPgConnectionFailure } from "../../packages/persistence/src/postgres.ts";
import { workerRouteError } from "../../apps/server/src/modules/execution/routes.ts";

function withCode(code: string): Error {
  return Object.assign(new Error("db"), { code });
}

Deno.test("isPgConnectionFailure recognises connection-level failures", () => {
  assert(isPgConnectionFailure(withCode("08006")));
  assert(isPgConnectionFailure(withCode("08001")));
  assert(isPgConnectionFailure(withCode("57P01")));
  assert(isPgConnectionFailure(withCode("57P02")));
  assert(isPgConnectionFailure(withCode("57P03")));
  assert(isPgConnectionFailure(withCode("ECONNREFUSED")));
  assert(isPgConnectionFailure(withCode("ECONNRESET")));
  assert(isPgConnectionFailure(withCode("EPIPE")));
  assert(isPgConnectionFailure(withCode("ETIMEDOUT")));
  assert(isPgConnectionFailure({ code: "08006" }));
  assert(isPgConnectionFailure(new Error("Connection terminated")));
  assert(
    isPgConnectionFailure(new Error("Connection terminated unexpectedly")),
  );
  assert(isPgConnectionFailure(
    new Error(
      "Client has encountered a connection error and is not queryable",
    ),
  ));
  assert(isPgConnectionFailure(
    new Error("timeout exceeded when trying to connect"),
  ));
  assert(isPgConnectionFailure(
    new Error("x", { cause: { code: "ECONNRESET" } }),
  ));
  assert(isPgConnectionFailure(
    new Error("x", { cause: new Error("y", { cause: withCode("08006") }) }),
  ));
});

Deno.test("isPgConnectionFailure rejects everything else", () => {
  assertFalse(isPgConnectionFailure({ code: "23505" }));
  assertFalse(isPgConnectionFailure({ code: "40001" }));
  assertFalse(isPgConnectionFailure({ code: "40P01" }));
  assertFalse(
    isPgConnectionFailure(new StandardError({ code: "LEASE_FENCED" })),
  );
  assertFalse(isPgConnectionFailure(new Error("boom")));
  assertFalse(
    isPgConnectionFailure(new DOMException("aborted", "AbortError")),
  );
  assertFalse(isPgConnectionFailure(undefined));
  assertFalse(isPgConnectionFailure("Connection terminated"));
  // A cause chain deeper than three levels is not followed.
  assertFalse(isPgConnectionFailure(
    new Error("a", {
      cause: new Error("b", {
        cause: new Error("c", { cause: withCode("08006") }),
      }),
    }),
  ));
});

Deno.test("workerRouteError maps a lost connection to a retryable 503", () => {
  const terminated = new Error("Connection terminated unexpectedly");
  const mapped = workerRouteError(terminated);
  assert(mapped instanceof StandardError);
  assertEquals(mapped.cause, terminated);
  const problem = toProblem(mapped, {
    requestId: "request",
    traceId: "trace",
    publicBaseUrl: "http://localhost",
  });
  assertEquals(problem.status, 503);
  assertEquals(problem.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(problem.retryable, true);
});

Deno.test("workerRouteError leaves every other error untouched", () => {
  const other = new Error("boom");
  assert(workerRouteError(other) === other);
  const standard = new StandardError({ code: "LEASE_FENCED" });
  assert(workerRouteError(standard) === standard);
});
