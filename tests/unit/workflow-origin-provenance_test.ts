import { assertEquals } from "@std/assert";
import { toWorkflowDefinition } from "../../apps/server/src/modules/workflows/postgres.ts";

/**
 * A workflow definition's origin is what tells an installed catalog workflow
 * from an authored one and from a copy. The read shape is the only place a
 * caller can see it, so these cases pin the mapping rather than the SQL: a
 * column that is written but never surfaced is provenance nobody can read.
 *
 * The row shape is the database's, snake_case and all, because that is what
 * `toWorkflowDefinition` is handed. Building the row by hand keeps the test
 * honest about which columns it depends on.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "review",
    name: "Review",
    description: null,
    active_version_id: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
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
    ...overrides,
  };
}

Deno.test("an authored definition carries no catalog origin", () => {
  const definition = toWorkflowDefinition(row());
  assertEquals(definition.origin, {
    kind: "authored",
    catalogKey: null,
    catalogVersion: null,
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  });
  assertEquals(definition.visibility, "listed");
});

Deno.test("an installed definition carries the catalog key and version it came from", () => {
  const definition = toWorkflowDefinition(
    row({
      slug: "preset:review",
      origin_kind: "catalog",
      origin_catalog_key: "review",
      origin_catalog_version: 3,
    }),
  );
  assertEquals(definition.origin, {
    kind: "catalog",
    catalogKey: "review",
    catalogVersion: 3,
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  });
});

Deno.test("a copied definition is distinguishable from an installed one", () => {
  // The distinction AC2 depends on: a copy is editable, an install is locked,
  // and both may share a slug shape. Only the origin tells them apart.
  const copy = toWorkflowDefinition(
    row({ slug: "preset:review", origin_kind: "copy" }),
  );
  const install = toWorkflowDefinition(
    row({
      slug: "preset:review",
      origin_kind: "catalog",
      origin_catalog_key: "review",
      origin_catalog_version: 1,
    }),
  );
  assertEquals(copy.origin.kind, "copy");
  assertEquals(install.origin.kind, "catalog");
  assertEquals(copy.origin.catalogKey, null);
});

Deno.test("origin is reported beside the fields it qualifies, not instead of them", () => {
  // A regression guard: adding provenance must not drop the existing shape.
  const definition = toWorkflowDefinition(
    row({
      origin_kind: "catalog",
      origin_catalog_key: "review",
      origin_catalog_version: 2,
    }),
  );
  assertEquals(definition.slug, "review");
  assertEquals(definition.name, "Review");
  assertEquals(definition.enabled, true);
  assertEquals(definition.version, 1);
});

Deno.test("a coordinator definition names the conversation and turn that proposed it and reads as unlisted", () => {
  const definition = toWorkflowDefinition(
    row({
      origin_kind: "coordinator",
      visibility: "unlisted",
      origin_conversation_id: "22222222-2222-2222-2222-222222222222",
      origin_turn_id: "33333333-3333-3333-3333-333333333333",
    }),
  );
  assertEquals(definition.origin, {
    kind: "coordinator",
    catalogKey: null,
    catalogVersion: null,
    conversationId: "22222222-2222-2222-2222-222222222222",
    turnId: "33333333-3333-3333-3333-333333333333",
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  });
  assertEquals(definition.visibility, "unlisted");
});
