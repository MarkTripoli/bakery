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
  origin_source_workflow_id: null,
  origin_source_version_id: null,
  origin_source_digest: null,
  visibility: "listed",
  origin_conversation_id: null,
  origin_turn_id: null,
  active_spec: null,
};

Deno.test("an authored definition's read shape satisfies the Workflow contract", () => {
  const shape = toWorkflowDefinition(row);
  assertEquals(shape.origin, {
    kind: "authored",
    catalogKey: null,
    catalogVersion: null,
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
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
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  });
  const parsed = contractSchemas.Workflow.safeParse(shape);
  assertEquals(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

Deno.test("a copy's read shape names its source and satisfies the contract", () => {
  const shape = toWorkflowDefinition({
    ...row,
    origin_kind: "copy",
    origin_source_workflow_id: "22222222-2222-4222-8222-222222222222",
    origin_source_version_id: "33333333-3333-4333-8333-333333333333",
    origin_source_digest: "a".repeat(64),
  });
  assertEquals(shape.origin, {
    kind: "copy",
    catalogKey: null,
    catalogVersion: null,
    sourceWorkflowId: "22222222-2222-4222-8222-222222222222",
    sourceVersionId: "33333333-3333-4333-8333-333333333333",
    sourceDigest: "a".repeat(64),
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

Deno.test("issue 407: needsInputs says whether the version in use declares a required input", () => {
  const spec = (required: boolean) => ({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "written",
    inputs: { note: { type: "string", required } },
    steps: [],
  });
  const needs = toWorkflowDefinition({ ...row, active_spec: spec(true) });
  const plain = toWorkflowDefinition({ ...row, active_spec: spec(false) });
  assertEquals([needs.needsInputs, plain.needsInputs], [true, false]);
  assertEquals(toWorkflowDefinition(row).needsInputs, false);
  const parsed = contractSchemas.Workflow.safeParse(needs);
  assertEquals(parsed.success, true, JSON.stringify(parsed.error?.issues));
});
