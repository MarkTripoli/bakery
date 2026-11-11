import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  catalogActions,
  contractSchemas,
  generateContracts,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  ApiTransportError,
  createBakeryClient,
} from "../../packages/contracts/src/client.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import { WORKER_EVENT_PAYLOAD_SCHEMAS } from "../../apps/server/src/modules/execution/shared.ts";

const artifactId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const reference = { artifactId, versionId, sha256: "a".repeat(64) };

Deno.test("worker artifact handoffs use immutable ArtifactRef tuples", () => {
  const checkpoint = WORKER_EVENT_PAYLOAD_SCHEMAS["job.checkpoint"].parse({
    artifact: reference,
    resumeHandleRef: "resume-1",
  });
  const artifact = WORKER_EVENT_PAYLOAD_SCHEMAS["job.artifact"].parse({
    artifact: reference,
  });
  const success = WORKER_EVENT_PAYLOAD_SCHEMAS["job.succeeded"].parse({
    result: { artifact: reference },
  });
  assertEquals(checkpoint, {
    artifact: reference,
    resumeHandleRef: "resume-1",
  });
  assertEquals(artifact, { artifact: reference });
  assertEquals(success, {
    result: { artifact: reference },
  });
  assertThrows(() =>
    WORKER_EVENT_PAYLOAD_SCHEMAS["job.checkpoint"].parse({
      checkpointArtifactVersionId: versionId,
      resumeHandleRef: null,
    })
  );
  assertThrows(() =>
    WORKER_EVENT_PAYLOAD_SCHEMAS["job.succeeded"].parse({
      result: {},
      artifactRefs: [reference],
    })
  );
});
Deno.test("terminal worker outputs carry immutable artifact refs", () => {
  const output = workerActionOutputSchema("harness.implement").parse({
    headSha: "head",
    baseSha: "base",
    sessionId: crypto.randomUUID(),
    artifacts: [reference],
  });
  if (
    output === null || typeof output !== "object" || !("artifacts" in output)
  ) {
    throw new Error("terminal output missing artifacts");
  }
  assertEquals(output.artifacts, [reference]);
});

Deno.test("publication and resource actions expose implemented typed boundaries", () => {
  const runStepId = "00000000-0000-4000-8000-000000000003";
  const authorId = "00000000-0000-4000-8000-000000000004";
  const timestamp = "2026-09-20T00:00:00.000Z";
  const version = contractSchemas.ArtifactVersion.parse({
    id: versionId,
    artifactId,
    revision: 1,
    runStepId,
    authorId,
    mediaType: "application/octet-stream",
    sizeBytes: 3,
    sha256: "a".repeat(64),
    subjectHeadSha: null,
    subjectBaseSha: null,
    metadata: { source: "worker" },
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  });
  const metadata = contractSchemas.ArtifactVersionMetadata.parse(version);
  const artifact = contractSchemas.Artifact.parse({
    id: artifactId,
    taskId: "00000000-0000-4000-8000-000000000005",
    artifactType: "patch",
    name: "fixed-workflow",
    currentVersionId: versionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 2,
  });
  assertEquals(
    contractSchemas["Page<Artifact>"].parse({
      items: [artifact],
      nextCursor: null,
    }),
    { items: [artifact], nextCursor: null },
  );
  assertEquals(
    contractSchemas["Page<ArtifactVersionMetadata>"].parse({
      items: [metadata],
      nextCursor: null,
    }),
    { items: [metadata], nextCursor: null },
  );
  assertEquals(contractSchemas.BinaryArtifact.parse("YWJj"), "YWJj");
  const rawBytes = new Uint8Array([0, 255]);
  assertEquals(
    contractSchemas.BinaryArtifactBytes.parse(rawBytes),
    rawBytes,
  );
  assertThrows(() => contractSchemas.BinaryArtifactBytes.parse("YWJj"));

  const generated = generateContracts();
  const generatedActions = generated.actions;
  const contentOperation = (generated.openapi.paths as Record<string, unknown>)[
    "/v1/artifact-versions/{id}/content"
  ] as Record<string, unknown>;
  const contentGet = contentOperation.get as {
    responses: Record<
      string,
      { content?: Record<string, { schema: { $ref: string } }> }
    >;
  };
  assertEquals(
    contentGet.responses["200"].content?.["application/octet-stream"]?.schema
      .$ref,
    "#/components/schemas/BinaryArtifact",
  );
  assertEquals(
    contentGet.responses["200"].content?.["*/*"]?.schema.$ref,
    "#/components/schemas/BinaryArtifactBytes",
  );
  assertEquals(
    contentGet.responses["206"].content?.["application/octet-stream"]?.schema
      .$ref,
    "#/components/schemas/BinaryArtifact",
  );
  assertEquals(
    contentGet.responses["206"].content?.["*/*"]?.schema.$ref,
    "#/components/schemas/BinaryArtifactBytes",
  );
  assertEquals(contentGet.responses["416"].content, undefined);
  const components = generated.openapi.components as {
    schemas: Record<string, { type?: string; format?: string }>;
  };
  assertEquals(components.schemas.BinaryArtifact.type, "string");
  assertEquals(components.schemas.BinaryArtifact.format, "base64");
  assertEquals(components.schemas.BinaryArtifactBytes.type, "string");
  assertEquals(components.schemas.BinaryArtifactBytes.format, "binary");
  const expectedContracts = [
    ["worker.artifacts", "WorkerArtifact", "ArtifactVersion", false],
    ["artifacts.list", "ArtifactQuery", "Page<Artifact>", true],
    ["artifacts.get", "IdPath", "Artifact", true],
    [
      "artifactVersions.list",
      "CursorQuery",
      "Page<ArtifactVersionMetadata>",
      true,
    ],
    ["artifactVersions.content", "ContentRangeQuery", "BinaryArtifact", true],
  ] as const;
  for (
    const [actionName, input, output, expectedImplemented] of expectedContracts
  ) {
    const action = generatedActions.find(({ action }) => action === actionName);
    assertEquals(action?.input, input);
    assertEquals(action?.output, output);
    assertEquals(action?.implemented, expectedImplemented);
    assertEquals(
      implementedActions.some((implementedAction) =>
        implementedAction === actionName
      ),
      expectedImplemented,
    );
  }
  const workerArtifactCatalog = catalogActions.find(({ action }) =>
    action === "worker.artifacts"
  );
  const workerArtifacts = generatedActions.find(({ action }) =>
    action === "worker.artifacts"
  );
  assertEquals(
    workerArtifactCatalog?.idempotency.includes("Idempotency-Key"),
    true,
  );
  assertEquals(
    workerArtifactCatalog?.idempotency.includes("If-Match"),
    true,
  );
  assertEquals(
    workerArtifacts?.errors.includes("PRECONDITION_REQUIRED"),
    true,
  );
  assertEquals(
    workerArtifacts?.errors.includes("PRECONDITION_FAILED"),
    true,
  );
  assertEquals(
    workerArtifacts?.errors.includes("IDEMPOTENCY_PAYLOAD_MISMATCH"),
    true,
  );
  assertEquals(workerArtifacts?.errors.includes("STATE_CONFLICT"), false);
  assertEquals(
    generatedActions.find(({ action }) => action === "artifactVersions.list")
      ?.errors.includes("UNPROCESSABLE"),
    false,
  );
  assertEquals(
    generatedActions.find(({ action }) => action === "artifactVersions.content")
      ?.errors.includes("UNPROCESSABLE"),
    false,
  );
});

Deno.test("typed artifact content clients model an unsatisfiable range", async () => {
  const digest = "a".repeat(64);
  const client = createBakeryClient({
    baseUrl: "https://example.test",
    getContext: () => ({
      organizationId: "00000000-0000-4000-8000-000000000009",
    }),
    fetch: () =>
      new Response(null, {
        status: 416,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "0",
          "content-range": "bytes */3",
          etag: `"${digest}"`,
        },
      }),
  });
  const result = await client.actions["artifactVersions.content"]({
    id: versionId,
    range: "bytes=999-1000",
  });
  assertEquals(result.status, 416);
  assertEquals(result.contentType, "application/octet-stream");
  assertEquals(result.contentLength, 0);
  assertEquals(result.contentDigest, digest);
  assertEquals(result.content.byteLength, 0);
  assertEquals(result.contentRange, "bytes */3");
});

Deno.test("typed artifact content clients preserve stored media types", async () => {
  const digest = "b".repeat(64);
  const client = createBakeryClient({
    baseUrl: "https://example.test",
    getContext: () => ({
      organizationId: "00000000-0000-4000-8000-000000000009",
    }),
    fetch: () =>
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: {
          "content-type": "text/plain",
          "content-length": "2",
          "content-range": "bytes 1-2/4",
          etag: `"${digest}"`,
        },
      }),
  });
  const result = await client.actions["artifactVersions.content"]({
    id: versionId,
    range: "bytes=1-2",
  });
  assertEquals(result.status, 206);
  assertEquals(result.contentType, "text/plain");
  assertEquals(result.contentRange, "bytes 1-2/4");
  assertEquals(result.content, new Uint8Array([1, 2]));
});

Deno.test("typed artifact content clients reject invalid partial ranges", async () => {
  const digest = "c".repeat(64);
  for (const contentRange of ["bytes malformed", "bytes 0-2/3"]) {
    const client = createBakeryClient({
      baseUrl: "https://example.test",
      getContext: () => ({
        organizationId: "00000000-0000-4000-8000-000000000009",
      }),
      fetch: () =>
        new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "2",
            "content-range": contentRange,
            etag: `"${digest}"`,
          },
        }),
    });
    const error = await assertRejects(() =>
      client.actions["artifactVersions.content"]({
        id: versionId,
        range: "bytes=1-2",
      })
    );
    assertInstanceOf(error, ApiTransportError);
    assertEquals(error.kind, "protocol");
    assertEquals(error.status, 206);
  }
});

Deno.test("artifact resource contracts keep scoped metadata and byte reads bounded", () => {
  const resourceActions = catalogActions
    .filter(({ action }) =>
      action === "artifacts.list" ||
      action === "artifacts.get" ||
      action === "artifactVersions.list" ||
      action === "artifactVersions.content"
    )
    .map(({ method, path }) => `${method} ${path}`)
    .sort();
  assertEquals(resourceActions, [
    "GET /v1/artifact-versions/{id}/content",
    "GET /v1/artifacts",
    "GET /v1/artifacts/{id}",
    "GET /v1/artifacts/{id}/versions",
  ]);

  const taskId = "00000000-0000-4000-8000-000000000001";
  assertEquals(
    contractSchemas.ArtifactQuery.parse({
      taskId,
      artifactType: "patch",
      limit: 1,
    }),
    { taskId, artifactType: "patch", limit: 1 },
  );
  assertEquals(
    contractSchemas.ContentRangeQuery.parse({ range: "bytes=0-4" }),
    { range: "bytes=0-4" },
  );
  assertThrows(() => contractSchemas.ArtifactQuery.parse({ taskId, page: 1 }));
  assertThrows(() =>
    contractSchemas.ContentRangeQuery.parse({ range: "bytes=0-1,3-4" })
  );
});
