import { assertEquals } from "@std/assert";
import { StandardError, toProblem } from "../../packages/contracts/src/http.ts";
import {
  type ApiProblem,
  ApiProblemError,
} from "../../packages/contracts/src/client.ts";
import { toApiFailure } from "../../apps/web/src/api/client.ts";

const reasonOf = (reason: string) =>
  toProblem(
    new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason },
    }),
    {
      requestId: "req",
      traceId: "trace",
      publicBaseUrl: "https://bakery.test",
    },
  ).reason;

Deno.test("a web-address archive that cannot be read says which way", () => {
  assertEquals(reasonOf("SOURCE_UNAVAILABLE"), "SOURCE_UNAVAILABLE");
  assertEquals(reasonOf("SOURCE_TIMEOUT"), "SOURCE_TIMEOUT");
  assertEquals(reasonOf("SOURCE_INVALID"), "SOURCE_INVALID");
  assertEquals(reasonOf("getaddrinfo ENOTFOUND intranet"), undefined);
});

Deno.test("the page is given the archive reason the server sent", () => {
  const kept = (reason: string) => {
    const failure = toApiFailure(
      new ApiProblemError(
        toProblem(
          new StandardError({
            code: "DEPENDENCY_UNAVAILABLE",
            params: { reason },
          }),
          {
            requestId: "req",
            traceId: "trace",
            publicBaseUrl: "https://bakery.test",
          },
        ) as unknown as ApiProblem,
      ),
    );
    return failure.kind === "problem" ? failure.problem.reason : "no problem";
  };
  assertEquals(kept("SOURCE_TIMEOUT"), "SOURCE_TIMEOUT");
  assertEquals(kept("draft_worker_pool_busy"), undefined);
});
