import { assertEquals } from "@std/assert";
import {
  assertDescribedJsonSchema,
  assertDescribedOpenApi,
  generateContracts,
  toJsonSchema,
} from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";

Deno.test("transport metadata is generated from the described source boundary", () => {
  const generated = generateContracts();
  const application = toJsonSchema(generated.schemas.Application) as {
    properties: Record<string, { description?: string }>;
  };
  assertEquals(
    application.properties.id.description,
    "Stable UUID identifying the application record.",
  );
  assertEquals(
    generated.actions.filter((action) => action.implemented).map((action) =>
      action.action
    ).sort(),
    [...implementedActions].sort(),
  );
  assertEquals(generated.implementedActions, [...implementedActions]);
});

Deno.test("all generated JSON Schema and OpenAPI targets retain descriptions", () => {
  const generated = generateContracts();
  for (const [name, schema] of Object.entries(generated.schemas)) {
    assertDescribedJsonSchema(toJsonSchema(schema), `schemas.${name}`);
  }
  assertDescribedOpenApi(generated.openapi);
});
