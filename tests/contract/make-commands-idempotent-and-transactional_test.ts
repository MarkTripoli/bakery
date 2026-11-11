import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  ActionAuthorizationError,
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  type CatalogActionName,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  createApiRouter,
  StandardError,
} from "../../packages/contracts/src/http.ts";
import { commandFingerprint } from "../../apps/server/src/platform/command-replay.ts";

const Phase1HttpInput = z.object({
  message: z.string().min(1).describe(
    "Validated command message for Phase 1 HTTP tests.",
  ),
}).describe("Input used to exercise the Phase 1 HTTP command boundary.");
const Phase1HttpOutput = z.object({
  message: z.string().min(1).describe(
    "Returned command message for Phase 1 HTTP tests.",
  ),
}).describe("Output used to exercise the Phase 1 HTTP command boundary.");

const id = "00000000-0000-4000-8000-000000000001";
const body = JSON.stringify({ message: "request", ignored: "not delivered" });

function request(
  path: string,
  method: "GET" | "POST" | "PATCH" = "POST",
  headers: HeadersInit = {},
): Request {
  return new Request(`http://test${path}`, {
    method,
    ...(method === "GET" ? {} : { body }),
    headers: { "content-type": "application/json", ...headers },
  });
}

Deno.test("HTTP re-emits an encoded command response byte-for-byte", async () => {
  let seenMetadata: unknown;
  let handlerInput: unknown;
  const committedBody = new TextEncoder().encode('{"message":"committed é"}');
  const registry = new ActionRegistry(undefined, {
    run: async ({ metadata, invokeAndEncode }) => {
      seenMetadata = metadata;
      if (metadata.idempotencyKey === "mismatch") {
        throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
      }
      if (metadata.idempotencyKey === "flight") {
        throw new StandardError({ code: "IDEMPOTENCY_IN_FLIGHT" });
      }
      const encoded = await invokeAndEncode();
      return {
        ...encoded,
        body: committedBody,
        headers: {
          "content-type": "application/json",
          location: `/v1/phase1/${id}`,
          etag: '"task-v3"',
        },
        replayed: true,
      };
    },
  }).register({
    name: "phase1.create" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/phase1/:id",
    input: Phase1HttpInput,
    output: Phase1HttpOutput,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: (_context, input) => {
      handlerInput = input;
      return { message: "handler" };
    },
  });

  const response = await createApiRouter({ registry }).fetch(
    request(
      `/v1/phase1/${id}?ignored=query`,
      "POST",
      { "idempotency-key": " command-1 " },
    ),
  );
  assertEquals(response.status, 201);
  assertEquals(new Uint8Array(await response.arrayBuffer()), committedBody);
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(response.headers.get("location"), `/v1/phase1/${id}`);
  assertEquals(response.headers.get("etag"), '"task-v3"');
  assertEquals(response.headers.get("idempotent-replayed"), "true");
  assertEquals(seenMetadata, {
    operation: "phase1.create",
    idempotencyKey: "command-1",
    target: `/v1/phase1/${id}`,
  });
  assertEquals(handlerInput, { message: "request" });
});

Deno.test("HTTP requires bounded command headers without changing query behavior", async () => {
  let commandCalls = 0;
  let queryCalls = 0;
  let expectedVersion: unknown;
  const registry = new ActionRegistry(undefined, {
    run: async ({ metadata, invokeAndEncode }) => {
      commandCalls++;
      expectedVersion = metadata.expectedVersion;
      return await invokeAndEncode();
    },
  }).register({
    name: "phase1.update" as CatalogActionName,
    method: HttpMethod.Patch,
    path: "/v1/phase1/:id",
    input: Phase1HttpInput,
    output: Phase1HttpOutput,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => ({ message: "updated" }),
  });
  registry.register({
    name: "phase1.query" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/phase1-query",
    input: contractSchemas.CursorQuery,
    output: Phase1HttpOutput,
    policy: { type: ActionKind.Query, access: "Public" },
    handler: () => {
      queryCalls++;
      return { message: "query" };
    },
  });

  const app = createApiRouter({ registry });
  for (
    const headers of [
      {},
      { "idempotency-key": "k".repeat(256), "if-match": '"3"' },
      { "idempotency-key": "k", "if-match": 'W/"3"' },
      { "idempotency-key": "k", "if-match": '"3", "4"' },
    ] as HeadersInit[]
  ) {
    const response = await app.fetch(
      request(`/v1/phase1/${id}`, "PATCH", headers),
    );
    assertEquals(response.status, 428);
    assertEquals((await response.json()).code, "PRECONDITION_REQUIRED");
  }
  const updated = await app.fetch(
    request(`/v1/phase1/${id}`, "PATCH", {
      "idempotency-key": "update-1",
      "if-match": '"task-v4"',
    }),
  );
  assertEquals(updated.status, 200);
  assertEquals(expectedVersion, 4);
  assertEquals(commandCalls, 1);

  const query = await app.fetch(request("/v1/phase1-query?limit=7", "GET"));
  assertEquals(query.status, 200);
  assertEquals(await query.json(), { message: "query" });
  assertEquals(queryCalls, 1);
});

Deno.test("HTTP emits a runner NoContent response without a body", async () => {
  const registry = new ActionRegistry(undefined, {
    run: ({ invokeAndEncode }) => invokeAndEncode(),
  }).register({
    name: "phase1.no-content" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/phase1-no-content",
    input: Phase1HttpInput,
    output: contractSchemas.NoContent,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => null,
  });
  const response = await createApiRouter({ registry }).fetch(
    request("/v1/phase1-no-content", "POST", {
      "idempotency-key": "no-content-1",
    }),
  );
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
});

Deno.test("HTTP fingerprints physical and generated UUID schemas identically", async () => {
  const routeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const repositoryProfileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const identity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const generatedNullableUuid = (contractSchemas.Run as unknown as z.ZodObject)
    .shape
    .repositoryProfileId.describe(
      "Described clone of a generated nullable UUID schema.",
    );
  const seenFingerprints: string[] = [];
  const seenInputs: unknown[] = [];
  const seenContextParams: unknown[] = [];
  const registry = new ActionRegistry(undefined, {
    run: async ({ metadata, input, invokeAndEncode }) => {
      seenFingerprints.push(await commandFingerprint({ metadata, input }));
      seenInputs.push(input);
      return await invokeAndEncode();
    },
  }).register({
    name: "phase1.natural-delete" as CatalogActionName,
    method: HttpMethod.Delete,
    path: "/v1/phase1-natural/:id",
    input: z.object({
      id: z.uuid().optional().nullable().describe(
        "Wrapped physical UUID command route identifier.",
      ),
      repositoryProfileId: generatedNullableUuid,
      identity: z.uuid().readonly().describe(
        "Required physical UUID natural idempotency identity.",
      ),
    }).describe("Natural command input with physical and generated UUIDs."),
    output: contractSchemas.NoContent,
    naturalIdempotency: true,
    naturalIdempotencyInputField: "identity",
    policy: { type: ActionKind.Command, access: "Public" },
    handler: (context, input) => {
      seenContextParams.push(context.params.id);
      assertEquals(input, { id: routeId, repositoryProfileId, identity });
      return null;
    },
  });
  const app = createApiRouter({ registry });

  const invoke = (
    idValue: string,
    profileValue: string,
    identityValue: string,
  ) =>
    app.fetch(
      new Request(`http://test/v1/phase1-natural/${idValue}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: idValue,
          repositoryProfileId: profileValue,
          identity: identityValue,
        }),
      }),
    );
  const upperResponse = await invoke(
    routeId.toUpperCase(),
    repositoryProfileId.toUpperCase(),
    identity.toUpperCase(),
  );
  const lowerResponse = await invoke(routeId, repositoryProfileId, identity);

  assertEquals([upperResponse.status, lowerResponse.status], [204, 204]);
  assertEquals(seenContextParams, [routeId, routeId]);
  assertEquals(seenInputs, [
    { id: routeId, repositoryProfileId, identity },
    { id: routeId, repositoryProfileId, identity },
  ]);
  assertEquals(seenFingerprints[0], seenFingerprints[1]);
});

Deno.test("authorization fails before a command runner can inspect replay metadata", async () => {
  let runnerCalls = 0;
  const registry = new ActionRegistry(undefined, {
    run: () => {
      runnerCalls++;
      throw new Error("must not run");
    },
  }).register({
    name: "phase1.denied" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/phase1-denied",
    input: Phase1HttpInput,
    output: Phase1HttpOutput,
    policy: {
      type: ActionKind.Command,
      access: "Developer",
      authorize: () => {
        throw new ActionAuthorizationError("denied");
      },
    },
    handler: () => ({ message: "never" }),
  });
  const response = await createApiRouter({ registry }).fetch(
    request("/v1/phase1-denied", "POST", { "idempotency-key": "denied" }),
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "AUTH_FORBIDDEN");
  assertEquals(runnerCalls, 0);
});

Deno.test("runner Problems retain their registered status and code", async () => {
  const registry = new ActionRegistry(undefined, {
    run: ({ metadata }) => {
      throw new StandardError({
        code: metadata.idempotencyKey === "flight"
          ? "IDEMPOTENCY_IN_FLIGHT"
          : "IDEMPOTENCY_PAYLOAD_MISMATCH",
      });
    },
  }).register({
    name: "phase1.problem" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/phase1-problem",
    input: Phase1HttpInput,
    output: Phase1HttpOutput,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => ({ message: "never" }),
  });
  const app = createApiRouter({ registry });
  for (
    const [key, status, code] of [
      ["mismatch", 422, "IDEMPOTENCY_PAYLOAD_MISMATCH"],
      ["flight", 409, "IDEMPOTENCY_IN_FLIGHT"],
    ] as const
  ) {
    const response = await app.fetch(
      request("/v1/phase1-problem", "POST", { "idempotency-key": key }),
    );
    assertEquals(response.status, status);
    assertEquals((await response.json()).code, code);
  }
});
