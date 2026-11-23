import { assert, assertEquals } from "@std/assert";
import { FAULTS, isFaultCode } from "../../packages/contracts/src/faults.ts";
import { FAULTS as SERVED_FAULTS } from "../../packages/contracts/src/http.ts";
import {
  catalogActions,
  documentedErrorResponses,
} from "../../packages/contracts/src/contracts.ts";
import contracts from "../../packages/contracts/generated/contracts.json" with {
  type: "json",
};

Deno.test("the server answers with the one error status table", () => {
  assert(SERVED_FAULTS === FAULTS);
});

Deno.test("every catalog error code has a status in the table", () => {
  const unknown = [
    ...new Set(catalogActions.flatMap((action) => action.errors)),
  ].filter((code) => !isFaultCode(code));
  assertEquals(unknown, []);
});

Deno.test("a route listing STATE_CONFLICT documents 409", () => {
  const listing = catalogActions.filter((action) =>
    action.errors.includes("STATE_CONFLICT")
  );
  assert(listing.length > 0);
  const paths = contracts.openapi.paths as Record<
    string,
    Record<string, { responses: Record<string, { description: string }> }>
  >;
  for (const action of listing) {
    const conflict =
      paths[action.path][action.method.toLowerCase()].responses["409"];
    assert(conflict, `${action.action} documents no 409`);
    assert(
      conflict.description.includes("STATE_CONFLICT"),
      `${action.action}: ${conflict.description}`,
    );
  }
});

Deno.test("each listed code is documented under its own status", () => {
  const responses = documentedErrorResponses([
    "RESOURCE_NOT_FOUND",
    "STATE_CONFLICT",
    "VERSION_CONFLICT",
    "VALIDATION_FAILED",
  ]);
  assertEquals(
    responses["404"].description,
    "Resource not found (RESOURCE_NOT_FOUND).",
  );
  assertEquals(
    responses["409"].description,
    "Conflict (STATE_CONFLICT, VERSION_CONFLICT).",
  );
  assertEquals(
    responses["422"].description,
    "Unprocessable request (VALIDATION_FAILED).",
  );
  assertEquals(Object.keys(responses), [
    "400",
    "401",
    "403",
    "404",
    "409",
    "422",
    "500",
  ]);
});
