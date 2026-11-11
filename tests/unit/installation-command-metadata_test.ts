import { assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  createNormalizedCommandMetadata,
  StandardError,
} from "../../packages/contracts/src/http.ts";

const id = "00000000-0000-4000-8000-000000000001";
const revoke = {
  name: "installationAdministrators.revoke",
  method: "DELETE",
  path: "/v1/installation/administrators/:id",
  input: contractSchemas.IdPath,
  explicitIdempotency: "key-and-if-match",
} as const;

Deno.test("explicit DELETE administrator revoke requires both stable key and strong version", () => {
  const headers = { "Idempotency-Key": "revoke-intent-1", "If-Match": '"v3"' };
  assertEquals(
    createNormalizedCommandMetadata(
      revoke,
      new Request(`http://test/v1/installation/administrators/${id}`, {
        method: "DELETE",
        headers,
      }),
      { id },
    ),
    {
      operation: "installationAdministrators.revoke",
      idempotencyKey: "revoke-intent-1",
      target: `/v1/installation/administrators/${id}`,
      expectedVersion: 3,
    },
  );
  const invalidHeaders: Record<string, string>[] = [
    { "Idempotency-Key": "revoke-intent-1" },
    { "If-Match": '"v3"' },
    { ...headers, "If-Match": 'W/"v3"' },
  ];
  for (const invalid of invalidHeaders) {
    assertThrows(
      () =>
        createNormalizedCommandMetadata(
          revoke,
          new Request("http://test", { method: "DELETE", headers: invalid }),
          { id },
        ),
      StandardError,
    );
  }
});
