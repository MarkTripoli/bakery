import { assertStrictEquals } from "@std/assert";
import { z } from "zod";
import {
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  type CatalogActionName,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";

const TestInput = z.object({
  count: z.number().describe("Local test-only input field."),
}).describe(
  "Local schema exercising generic inference independent of the catalog.",
);
const TestOutput = z.object({
  ok: z.boolean().describe("Local test-only output field."),
}).describe(
  "Local schema exercising output inference independent of the catalog.",
);

function typedRegistry() {
  return new ActionRegistry().register({
    name: "health.read" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/health",
    input: TestInput,
    output: TestOutput,
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    handler: (_context, input) => {
      const count: number = input.count;
      return { ok: count > 0 };
    },
  });
}

function compileTimeFailures() {
  new ActionRegistry().register({
    name: "health.invalid-input" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/health",
    input: TestInput,
    output: TestOutput,
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    handler: (_context, input) => {
      // @ts-expect-error TestInput has no `invitationId` field.
      input.invitationId;
      return { ok: true };
    },
  });

  new ActionRegistry().register({
    name: "health.invalid-output" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/health",
    input: TestInput,
    output: TestOutput,
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    // @ts-expect-error TestOutput requires an `ok` boolean, not a string.
    handler: () => "not-an-output",
  });
}
void compileTimeFailures;

Deno.test("action registrations carry physical schemas and infer the handler contract", () => {
  const action = typedRegistry().get("health.read");
  assertStrictEquals(action.input, TestInput);
  assertStrictEquals(action.output, TestOutput);
});

Deno.test("contractSchemas exposes the identical physical schema registered handlers receive", () => {
  const registry = new ActionRegistry().register({
    name: "identity.get" as CatalogActionName,
    method: HttpMethod.Get,
    path: "/v1/identity",
    input: contractSchemas.CursorQuery,
    output: contractSchemas.NoContent,
    policy: { type: ActionKind.Query, access: ActionAccess.Public },
    handler: (_context, input) => {
      const limit: number | undefined = input.limit;
      return limit === undefined ? null : null;
    },
  });
  const action = registry.get("identity.get");
  assertStrictEquals(action.input, contractSchemas.CursorQuery);
  assertStrictEquals(action.output, contractSchemas.NoContent);
});
