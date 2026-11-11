import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  ApiProblemError,
  createBakeryClient,
} from "../../packages/contracts/src/client.ts";
import { toProblem, unprocessable } from "../../packages/contracts/src/http.ts";
import { createBakeryApiClient } from "../../apps/web/src/api/client.ts";

const BASE = "https://bakery.example";

/** A 422 produced by the real server helpers, serialized like the listener does. */
function serverUnprocessable(path: readonly (string | number)[], code: string) {
  const problem = toProblem(unprocessable(path, code), {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    publicBaseUrl: BASE,
  });
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "content-type": "application/problem+json" },
  });
}

Deno.test("real server problem with array issue paths yields issueCodes", async () => {
  const response = serverUnprocessable(
    ["secretAccessKey"],
    "credentials_rejected",
  );
  const body = await response.clone().json();
  assertEquals(body.issues[0].path, ["secretAccessKey"]);
  const client = createBakeryClient({
    baseUrl: BASE,
    fetch: (() => Promise.resolve(response)) as typeof fetch,
  });
  const error = await client.actions["skillStorageSettings.verify"]({}, {
    idempotencyKey: "key-1",
  }).catch((caught: unknown) => caught);
  assertInstanceOf(error, ApiProblemError);
  assertEquals(error.problem.status, 422);
  assertEquals(error.problem.issueCodes, ["credentials_rejected"]);
});

Deno.test("web client surfaces issueCodes from the real server shape", async () => {
  const client = createBakeryApiClient({
    baseUrl: BASE,
    fetchImpl: (() =>
      Promise.resolve(
        serverUnprocessable(["a/b", "c~d", 3], "bucket_unreachable"),
      )) as typeof fetch,
  });
  const result = await client.skillStorage.verify({
    idempotencyKey: "key-2",
  });
  assertEquals(result.ok, false);
  if (result.ok || result.error.kind !== "problem") {
    throw new Error("expected a problem failure");
  }
  assertEquals(result.error.problem.issueCodes, ["bucket_unreachable"]);
});

Deno.test("string issue paths still validate", async () => {
  const problem = toProblem(unprocessable([], "credentials_rejected"), {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    publicBaseUrl: BASE,
  });
  const withString = {
    ...problem,
    issues: [{
      path: "/secretAccessKey",
      code: "credentials_rejected",
      message: "x",
    }],
  };
  const client = createBakeryClient({
    baseUrl: BASE,
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(withString), {
          status: 422,
          headers: { "content-type": "application/problem+json" },
        }),
      )) as typeof fetch,
  });
  const error = await client.actions["skillStorageSettings.verify"]({}, {
    idempotencyKey: "key-3",
  }).catch((caught: unknown) => caught);
  assertInstanceOf(error, ApiProblemError);
  assertEquals(error.problem.issueCodes, ["credentials_rejected"]);
});
