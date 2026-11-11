import { assertEquals, assertExists, assertThrows } from "@std/assert";
import transport from "../../packages/contracts/generated/transport-schemas.ts";
import {
  type CatalogActionName,
  catalogActions,
  type ContractInputName,
  type ContractOutputName,
  contractSchemas,
  generateContracts,
  isCatalogActionName,
} from "../../packages/contracts/src/contracts.ts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true
  : false;
type Expect<Value extends true> = Value;

type PhaseOneCatalogLiteralMembers = Extract<
  CatalogActionName,
  "artifactVersions.import" | "artifactVersions.extract"
>;
type ExpectedPhaseOneCatalogLiteralMembers =
  | "artifactVersions.import"
  | "artifactVersions.extract";
const _phaseOneCatalogLiteralMembers: Expect<
  Equal<PhaseOneCatalogLiteralMembers, ExpectedPhaseOneCatalogLiteralMembers>
> = true;

type PhaseOneInputLiteralMembers = Extract<
  ContractInputName,
  "ArtifactVersionImport" | "ArtifactExtractQuery"
>;
type ExpectedPhaseOneInputLiteralMembers =
  | "ArtifactVersionImport"
  | "ArtifactExtractQuery";
const _phaseOneInputLiteralMembers: Expect<
  Equal<PhaseOneInputLiteralMembers, ExpectedPhaseOneInputLiteralMembers>
> = true;

type PhaseOneOutputLiteralMembers = Extract<
  ContractOutputName,
  "ArtifactExtraction"
>;
const _phaseOneOutputLiteralMember: Expect<
  Equal<PhaseOneOutputLiteralMembers, "ArtifactExtraction">
> = true;

const artifactVersionId = "00000000-0000-4000-8000-000000000001";
const principalId = "00000000-0000-4000-8000-000000000002";
const commitSha = "a".repeat(40);
const digest = "b".repeat(64);

type GeneratedOperation = {
  parameters?: Array<{
    name: string;
    in: string;
    required: boolean;
  }>;
  operationId: string;
  responses: Record<string, {
    description?: string;
    content?: Record<string, { schema?: { $ref?: string } }>;
  }>;
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
};

function generatedOperation(
  path: string,
  method: "get" | "post",
): GeneratedOperation {
  const generated = generateContracts();
  const paths = generated.openapi.paths as Record<
    string,
    Record<string, unknown>
  >;
  return paths[path]?.[method] as GeneratedOperation;
}

Deno.test("artifact import and extraction catalog contracts", () => {
  const importAction = catalogActions.find(({ action }) =>
    action === "artifactVersions.import"
  );
  assertEquals(importAction?.group, "Artifacts");
  assertEquals(importAction?.method, "POST");
  assertEquals(importAction?.path, "/v1/artifacts/{id}/versions/import");
  assertEquals(importAction?.action, "artifactVersions.import");
  assertEquals(importAction?.access, "Developer");
  assertEquals(importAction?.input, "ArtifactVersionImport");
  assertEquals(importAction?.output, "ArtifactVersionMetadata");
  assertEquals(importAction?.event, "artifact.version_created");
  assertEquals(
    importAction?.organizationContext,
    "required_authenticated_context",
  );

  const extractAction = catalogActions.find(({ action }) =>
    action === "artifactVersions.extract"
  );
  assertEquals(extractAction?.group, "Artifacts");
  assertEquals(extractAction?.method, "GET");
  assertEquals(
    extractAction?.path,
    "/v1/artifact-versions/{id}/extract",
  );
  assertEquals(extractAction?.action, "artifactVersions.extract");
  assertEquals(extractAction?.access, "Developer");
  assertEquals(extractAction?.input, "ArtifactExtractQuery");
  assertEquals(extractAction?.output, "ArtifactExtraction");
  assertEquals(
    extractAction?.organizationContext,
    "required_authenticated_context",
  );

  assertEquals(
    generatedOperation(
      "/v1/artifacts/{id}/versions/import",
      "post",
    ).operationId,
    "artifactVersions.import",
  );
  assertEquals(
    generatedOperation(
      "/v1/artifact-versions/{id}/extract",
      "get",
    ).operationId,
    "artifactVersions.extract",
  );
});

Deno.test("checked-in import OpenAPI headers and statuses match HTTP", async () => {
  const generated = JSON.parse(
    await Deno.readTextFile("packages/contracts/generated/contracts.json"),
  ) as {
    openapi: {
      paths: Record<string, Record<string, GeneratedOperation>>;
    };
  };
  const operation = generated.openapi
    .paths["/v1/artifacts/{id}/versions/import"]?.post;
  assertExists(operation);
  assertEquals(
    operation.parameters?.filter(({ in: location }) => location === "header")
      .map(({ name, required }) => [name, required]),
    [
      ["Bakery-Organization-Id", true],
      ["Idempotency-Key", true],
      ["If-Match", true],
    ],
  );
  assertEquals(Object.keys(operation.responses).sort(), [
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "412",
    "422",
    "428",
    "500",
    "503",
    "504",
  ]);
  assertEquals(
    operation.responses["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ArtifactVersionMetadata",
  );
});

Deno.test("artifact import input is exactly path and commitSha", () => {
  const valid = { path: "src/main.ts", commitSha };
  assertEquals(contractSchemas.ArtifactVersionImport.parse(valid), valid);
  assertEquals(
    contractSchemas.ArtifactVersionImport.parse({
      path: "a".repeat(500),
      commitSha,
    }),
    { path: "a".repeat(500), commitSha },
  );
  assertThrows(() =>
    contractSchemas.ArtifactVersionImport.parse({
      path: "a".repeat(501),
      commitSha,
    })
  );
  assertThrows(() =>
    contractSchemas.ArtifactVersionImport.parse({
      path: "src/main.ts",
      commitSha: "a".repeat(39),
    })
  );

  const callerAuthorityFields = [
    ["repositoryId", "00000000-0000-4000-8000-000000000003"],
    ["runStepId", "00000000-0000-4000-8000-000000000004"],
    ["content", new Uint8Array([1, 2, 3])],
    ["sha256", digest],
    ["sourceRepositoryId", "00000000-0000-4000-8000-000000000005"],
    ["provenance", { repositoryId: "caller-supplied" }],
  ] as const;
  for (const [field, value] of callerAuthorityFields) {
    assertThrows(() =>
      contractSchemas.ArtifactVersionImport.parse({
        ...valid,
        [field]: value,
      })
    );
  }
});

Deno.test("artifact extraction bounds use UTF-8 bytes", () => {
  assertEquals(contractSchemas.ArtifactExtractQuery.parse({}), {});
  assertEquals(
    contractSchemas.ArtifactExtractQuery.parse({
      startByte: 0,
      maxBytes: 1,
    }),
    { startByte: 0, maxBytes: 1 },
  );
  assertEquals(
    contractSchemas.ArtifactExtractQuery.parse({
      startByte: 10_485_760,
      maxBytes: 65_536,
    }),
    { startByte: 10_485_760, maxBytes: 65_536 },
  );
  for (
    const input of [
      { startByte: -1 },
      { startByte: 10_485_761 },
      { startByte: 1.5 },
      { maxBytes: 0 },
      { maxBytes: 65_537 },
      { maxBytes: 1.5 },
      { startByte: 0, maxBytes: 1, unsupported: true },
    ]
  ) {
    assertThrows(() => contractSchemas.ArtifactExtractQuery.parse(input));
  }

  const base = {
    versionId: artifactVersionId,
    sha256: digest,
    mediaType: "text/plain",
    startByte: 0,
    endByteExclusive: 0,
    hasMore: false,
  };
  const asciiAtCap = "a".repeat(65_536);
  assertEquals(
    contractSchemas.ArtifactExtraction.parse({
      ...base,
      endByteExclusive: 65_536,
      text: asciiAtCap,
    }),
    { ...base, endByteExclusive: 65_536, text: asciiAtCap },
  );
  assertThrows(() =>
    contractSchemas.ArtifactExtraction.parse({
      ...base,
      endByteExclusive: 65_537,
      text: "a".repeat(65_537),
    })
  );

  const utf8AtCap = "é".repeat(32_768);
  assertEquals(new TextEncoder().encode(utf8AtCap).byteLength, 65_536);
  assertEquals(
    contractSchemas.ArtifactExtraction.parse({
      ...base,
      endByteExclusive: 65_536,
      text: utf8AtCap,
      hasMore: true,
    }),
    { ...base, endByteExclusive: 65_536, text: utf8AtCap, hasMore: true },
  );
  assertThrows(() =>
    contractSchemas.ArtifactExtraction.parse({
      ...base,
      endByteExclusive: 65_538,
      text: "é".repeat(32_769),
    })
  );
});

Deno.test("BinaryArtifact keeps all read variants", () => {
  const variants = transport.outputs.BinaryArtifact.httpVariants;
  assertEquals(
    variants.map(({ status, body }) => [status, body]),
    [
      [200, "BinaryArtifactBytes"],
      [206, "BinaryArtifactBytes"],
      [304, null],
      [416, null],
    ],
  );
  assertEquals(variants[0]?.contentType, "*/*");
  assertEquals(variants[1]?.contentType, "*/*");

  const operation = generatedOperation(
    "/v1/artifact-versions/{id}/content",
    "get",
  );
  assertEquals(
    operation.responses["200"]?.content?.["*/*"]?.schema?.$ref,
    "#/components/schemas/BinaryArtifactBytes",
  );
  assertEquals(
    operation.responses["206"]?.content?.["*/*"]?.schema?.$ref,
    "#/components/schemas/BinaryArtifactBytes",
  );
  assertEquals(Object.hasOwn(operation.responses, "304"), true);
  assertEquals(operation.responses["304"]?.content, undefined);
  assertEquals(Object.hasOwn(operation.responses, "416"), true);
  assertEquals(operation.responses["416"]?.content, undefined);
});

Deno.test("capability enum includes import and extraction", () => {
  assertEquals(isCatalogActionName("artifactVersions.import"), true);
  assertEquals(isCatalogActionName("artifactVersions.extract"), true);
  assertEquals(
    isCatalogActionName("artifactVersions.not-a-real-action"),
    false,
  );

  const input = {
    principalId,
    expiresAt: null,
  };
  assertEquals(
    contractSchemas.PermissionGrantCreate.parse({
      ...input,
      capability: "artifactVersions.import",
    }).capability,
    "artifactVersions.import",
  );
  assertEquals(
    contractSchemas.PermissionGrantCreate.parse({
      ...input,
      capability: "artifactVersions.extract",
    }).capability,
    "artifactVersions.extract",
  );
  assertThrows(() =>
    contractSchemas.PermissionGrantCreate.parse({
      ...input,
      capability: "artifactVersions.not-a-real-action",
    })
  );

  const generated = generateContracts();
  const components = generated.openapi.components as {
    schemas: Record<string, {
      properties?: Record<string, { enum?: unknown[] }>;
    }>;
  };
  const capabilityEnum = components.schemas.PermissionGrantCreate.properties
    ?.capability.enum;
  assertEquals(capabilityEnum?.includes("artifactVersions.import"), true);
  assertEquals(capabilityEnum?.includes("artifactVersions.extract"), true);
});
Deno.test("generated retrieval contracts keep conditional reads raw and extraction bounded", () => {
  const contentQuery = contractSchemas.ContentRangeQuery;
  assertEquals(contentQuery.parse({}), {});
  assertThrows(() =>
    contentQuery.parse({
      range: "bytes=0-1",
      ifNoneMatch: `"${digest}"`,
    })
  );

  const extractOperation = generatedOperation(
    "/v1/artifact-versions/{id}/extract",
    "get",
  );
  const extractParameters = Object.fromEntries(
    (extractOperation.parameters ?? [])
      .map(({ name, in: location, required }) =>
        location === "query" || location === "path"
          ? [`${location}:${name}`, required]
          : null
      )
      .filter((entry): entry is [string, boolean] => entry !== null),
  );
  assertEquals(extractParameters, {
    "path:id": true,
    "query:startByte": false,
    "query:maxBytes": false,
  });
  assertEquals(
    extractOperation.responses["200"]?.content?.["application/json"]?.schema
      ?.$ref,
    "#/components/schemas/ArtifactExtraction",
  );
});
