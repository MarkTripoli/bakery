import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { toWorkflowDefinition } from "../../apps/server/src/modules/workflows/postgres.ts";

// The server's read shape and the contract that validates it are two places that
// must agree, and nothing but a real request used to check it: a field added to
// `toWorkflowDefinition` and not to the `Workflow` schema passes every unit test
// and then fails every workflow request with a 500, because the action registry
// refuses an output its schema does not describe.
const now = new Date("2026-11-18T05:00:00Z");
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "release-flow",
  name: "Release flow",
  description: "Synthetic release workflow.",
  active_version_id: null,
  enabled: true,
  created_at: now,
  updated_at: now,
  version: 1,
  origin_kind: "authored",
  origin_catalog_key: null,
  origin_catalog_version: null,
  visibility: "listed",
  origin_conversation_id: null,
  origin_turn_id: null,
};

Deno.test("an authored definition's read shape satisfies the Workflow contract", () => {
  const shape = toWorkflowDefinition(row);
  assertEquals(shape.origin, {
    kind: "authored",
    catalogKey: null,
    catalogVersion: null,
    conversationId: null,
    turnId: null,
  });
  const parsed = contractSchemas.Workflow.safeParse(shape);
  assertEquals(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

Deno.test("a catalog definition's read shape carries its key and revision and satisfies the contract", () => {
  const shape = toWorkflowDefinition({
    ...row,
    slug: "preset:fixed-coding",
    origin_kind: "catalog",
    origin_catalog_key: "fixed-coding",
    origin_catalog_version: 3,
  });
  assertEquals(shape.origin, {
    kind: "catalog",
    catalogKey: "fixed-coding",
    catalogVersion: 3,
    conversationId: null,
    turnId: null,
  });
  const parsed = contractSchemas.Workflow.safeParse(shape);
  assertEquals(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

Deno.test("an unlisted coordinator definition's read shape satisfies the contract", () => {
  const shape = toWorkflowDefinition({
    ...row,
    origin_kind: "coordinator",
    visibility: "unlisted",
    origin_conversation_id: "22222222-2222-4222-8222-222222222222",
    origin_turn_id: "33333333-3333-4333-8333-333333333333",
  });
  assertEquals(shape.visibility, "unlisted");
  const parsed = contractSchemas.Workflow.safeParse(shape);
  assertEquals(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

Deno.test("a read shape without its origin is refused by the contract", () => {
  const { origin: _origin, ...withoutOrigin } = toWorkflowDefinition(row);
  assertEquals(
    contractSchemas.Workflow.safeParse(withoutOrigin).success,
    false,
  );
});
