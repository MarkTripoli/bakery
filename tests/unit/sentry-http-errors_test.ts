import { assertEquals } from "@std/assert";
import {
  installProblemErrorReporter,
  StandardError,
  toProblem,
} from "../../packages/contracts/src/http.ts";

Deno.test("handled unexpected errors reach monitoring without changing safe problem responses", () => {
  const error = new Error("private content");
  const options = {
    requestId: "test-request",
    traceId: "test-trace",
    publicBaseUrl: "https://example.com",
  };
  const expected = toProblem(error, options);
  const reported: unknown[] = [];
  const restore = installProblemErrorReporter((failure) =>
    reported.push(failure)
  );
  try {
    assertEquals(toProblem(error, options), expected);
    assertEquals(reported, [error]);
    assertEquals(
      toProblem(new StandardError({ code: "AUTH_FORBIDDEN" }), options).status,
      403,
    );
    assertEquals(reported.length, 1);
  } finally {
    restore();
  }
});

Deno.test("a failed telemetry observer preserves the original problem response", () => {
  const error = new Error("private content");
  const options = {
    requestId: "test-request",
    traceId: "test-trace",
    publicBaseUrl: "https://example.com",
  };
  const expected = toProblem(error, options);
  const restore = installProblemErrorReporter(() => {
    throw new Error("telemetry unavailable");
  });
  try {
    assertEquals(toProblem(error, options), expected);
  } finally {
    restore();
  }
});
