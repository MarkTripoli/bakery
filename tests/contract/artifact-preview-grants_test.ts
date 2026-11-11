import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import {
  ArtifactImplementedAction,
  artifactImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { createArtifactResourceRoutes } from "../../apps/server/src/modules/knowledge/resource-routes.ts";
import { previewAvailability } from "../../apps/server/src/modules/knowledge/previews/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const expected = {
  "artifactPreviews.create": [
    "POST",
    "/v1/artifact-versions/{id}/preview-grants",
    "IdPath",
    "ArtifactPreviewGrant",
  ],
  "artifactPreviews.revoke": [
    "DELETE",
    "/v1/artifact-preview-grants/{id}",
    "IdPath",
    "NoContent",
  ],
  "artifactPreviews.availability": [
    "GET",
    "/v1/artifact-preview-availability",
    "Empty",
    "ArtifactPreviewAvailability",
  ],
} as const;

Deno.test("the catalog declares the three preview operations with read authority", () => {
  for (
    const [action, [method, path, input, output]] of Object.entries(expected)
  ) {
    const entry = catalogActions.find((candidate) =>
      candidate.action === action
    );
    assert(entry, action);
    assertEquals(entry.method, method, action);
    assertEquals(entry.path, path, action);
    assertEquals(entry.input, input, action);
    assertEquals(entry.output, output, action);
    assertEquals(entry.permission, "artifactVersion:read", action);
    assertEquals(entry.access, "Developer", action);
    assertEquals(entry.mcp, null, action);
    assertEquals(entry.organizationContext, "required_authenticated_context");
  }
  const create = catalogActions.find((entry) =>
    entry.action === "artifactPreviews.create"
  )!;
  assert(create.idempotency.startsWith("Not replayed"));
  assert((create.errors as string[]).includes("STATE_CONFLICT"));
  assert((create.errors as string[]).includes("ARTIFACT_CONTENT_EXPIRED"));
  assert((create.errors as string[]).includes("UNSUPPORTED_MEDIA_TYPE"));
});

Deno.test("the preview operations are implemented actions", () => {
  assertEquals(
    [
      ArtifactImplementedAction.ArtifactPreviewsCreate,
      ArtifactImplementedAction.ArtifactPreviewsRevoke,
      ArtifactImplementedAction.ArtifactPreviewsAvailability,
    ].every((name) => artifactImplementedActions.includes(name)),
    true,
  );
});

Deno.test("registration holds catalog parity with and without a preview origin", () => {
  // Registration runs assertRegisteredActions: method, path, schemas, access
  // and organization context must equal each catalog entry.
  for (const artifactPreviewOrigin of [undefined, "http://localhost:8789"]) {
    createArtifactResourceRoutes({
      database: {} as PgDatabase,
      browserSession: async (_context, next) => await next(),
      publicBaseUrl: "http://127.0.0.1:8788",
      secret: "contract-secret-0123456789abcdef0123456789",
      artifactPreviewOrigin,
    });
  }
});

Deno.test("preview output schemas carry meaningful descriptions", () => {
  for (
    const name of [
      "ArtifactPreviewGrant",
      "ArtifactPreviewAvailability",
    ] as const
  ) {
    const schema = contractSchemas[name];
    assertEquals(
      descriptionDefectKind(schema.description, name),
      undefined,
      name,
    );
    const shape = (schema as unknown as {
      shape: Record<string, { description?: string }>;
    }).shape;
    for (const [field, child] of Object.entries(shape)) {
      assertEquals(
        descriptionDefectKind(child.description, `${name}.${field}`),
        undefined,
        `${name}.${field}`,
      );
    }
  }
});

Deno.test("the grant response shape is exact and rejects extras", () => {
  const grant = {
    grantId: crypto.randomUUID(),
    grant: "A".repeat(43),
    exchangeUrl: "http://localhost:8789/artifact-preview/exchange",
    expiresAt: new Date().toISOString(),
    revisionPath: "/tasks/t/artifacts/a?version=v",
  };
  assertEquals(contractSchemas.ArtifactPreviewGrant.parse(grant), grant);
  assertEquals(
    contractSchemas.ArtifactPreviewGrant.safeParse({ ...grant, extra: 1 })
      .success,
    false,
  );
  assertEquals(
    contractSchemas.ArtifactPreviewGrant.safeParse({ ...grant, grantId: "x" })
      .success,
    false,
  );
});

Deno.test("availability follows the configured origin exactly", () => {
  assertEquals(previewAvailability({}), { available: false });
  assertEquals(
    previewAvailability({ previewOrigin: "http://localhost:8789" }),
    { available: true },
  );
});
