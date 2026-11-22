import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import catalog from "../../docs/technical-design/api-catalog.json" with {
  type: "json",
};
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import migration from "../../docs/technical-design/contract-migrations/v1-unreleased-principal-organization-contracts.json" with {
  type: "json",
};
import {
  assertCompatible,
  assertDescribedJsonSchema,
  assertDescribedSchema,
  assertInventoryCoverage,
  assertSafeProjection,
  type CatalogAction,
  findDescriptionDefects,
  findMissingDescriptions,
  generateContracts,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_METADATA_BYTES,
  toJsonSchema,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { ContractQualityError } from "../../packages/contracts/src/exceptions.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import contractQualityPlugin from "../../scripts/lint/contract-quality.ts";
import {
  isApprovedCompatibilityMigration,
} from "../../scripts/generate-contracts.ts";

function parseStrictJson(source: string): unknown {
  let offset = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} at offset ${offset}`);
  };
  const skipWhitespace = (): void => {
    while (offset < source.length && /\s/.test(source[offset]!)) offset++;
  };
  const parseString = (): string => {
    const start = offset;
    if (source[offset] !== '"') fail("expected JSON string");
    offset++;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x22) {
        offset++;
        return JSON.parse(source.slice(start, offset)) as string;
      }
      if (code === 0x5c) {
        if (offset + 1 >= source.length) fail("unterminated JSON escape");
        offset += 2;
        continue;
      }
      if (code < 0x20) fail("control character in JSON string");
      offset++;
    }
    return fail("unterminated JSON string");
  };
  function parseObject(): null {
    offset++;
    skipWhitespace();
    const keys = new Set<string>();
    if (source[offset] === "}") {
      offset++;
      return null;
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) fail(`duplicate JSON object key ${key}`);
      keys.add(key);
      skipWhitespace();
      if (source[offset] !== ":") fail("expected JSON object colon");
      offset++;
      parseValue();
      skipWhitespace();
      if (source[offset] === "}") {
        offset++;
        return null;
      }
      if (source[offset] !== ",") fail("expected JSON object comma");
      offset++;
      skipWhitespace();
    }
  }
  function parseArray(): null {
    offset++;
    skipWhitespace();
    if (source[offset] === "]") {
      offset++;
      return null;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (source[offset] === "]") {
        offset++;
        return null;
      }
      if (source[offset] !== ",") fail("expected JSON array comma");
      offset++;
      skipWhitespace();
    }
  }
  function parseValue(): unknown {
    skipWhitespace();
    const token = source[offset];
    if (token === "{") return parseObject();
    if (token === "[") return parseArray();
    if (token === '"') return parseString();
    const start = offset;
    while (
      offset < source.length &&
      !/[\s,\]}]/.test(source[offset]!)
    ) offset++;
    if (start === offset) fail("expected JSON value");
    try {
      return JSON.parse(source.slice(start, offset));
    } catch {
      fail("invalid JSON value");
    }
  }
  parseValue();
  skipWhitespace();
  if (offset !== source.length) fail("trailing JSON input");
  return JSON.parse(source) as unknown;
}

const transportSchemaPath = new URL(
  "../../docs/technical-design/transport-schemas.json",
  import.meta.url,
);

Deno.test("authored transport schema has no duplicate JSON object keys", async () => {
  const source = parseStrictJson(
    await Deno.readTextFile(transportSchemaPath),
  ) as typeof transport;
  generateContracts(source);
});
Deno.test("strict JSON parsing rejects duplicate object keys", () => {
  assertThrows(
    () => parseStrictJson('{"ArtifactQuery":{"a":1},"ArtifactQuery":{"a":2}}'),
    Error,
    "duplicate JSON object key ArtifactQuery",
  );
});

Deno.test("ArtifactQuery exposes only implemented scoped filters", () => {
  const schema = generateContracts(transport).schemas.ArtifactQuery;
  const repositoryId = "00000000-0000-4000-8000-000000000001";
  assert(schema.safeParse({}).success);
  assert(
    schema.safeParse({
      repositoryId,
      taskId: repositoryId,
      artifactType: "patch",
      limit: 1,
    }).success,
  );
  assert(!schema.safeParse({ status: "review" }).success);
});

const lintSource = (fileName: string, source: string) =>
  Deno.lint.runPlugin(contractQualityPlugin, fileName, source);

const descriptionDiagnostics = (fileName: string, source: string) =>
  lintSource(fileName, source).filter((diagnostic) =>
    diagnostic.id === "bakery-contracts/described-zod-schema"
  );

function withCatalogMutation(
  mutate: (actions: CatalogAction[]) => void,
  check: () => void,
): void {
  const actions = catalog.actions as unknown as CatalogAction[];
  const original = structuredClone(actions);
  try {
    mutate(actions);
    check();
  } finally {
    actions.splice(0, actions.length, ...original);
  }
}

function findCatalogAction(
  actions: CatalogAction[],
  name: CatalogAction["action"],
): CatalogAction {
  const action = actions.find((candidate) => candidate.action === name);
  if (!action) throw new Error(`missing catalog action ${name}`);
  return action;
}

Deno.test("generated source marks exactly the runtime action set implemented", () => {
  const generated = generateContracts();
  assertEquals(generated.actions.length, catalog.actions.length);
  assertEquals(generated.implementedActions, [...implementedActions]);
  assertEquals(
    generated.actions.filter((action) => action.implemented).map((action) =>
      action.action
    ).sort(),
    [...implementedActions].sort(),
  );
  assertInventoryCoverage();
});

Deno.test("catalog identity rail rejects duplicate action names", () => {
  withCatalogMutation(
    (actions) => {
      findCatalogAction(actions, "applications.get").action =
        findCatalogAction(actions, "applications.list").action;
    },
    () =>
      assertThrows(
        () => assertInventoryCoverage(),
        ContractQualityError,
        "duplicate catalog action applications.list",
      ),
  );
});

Deno.test("catalog identity rail rejects normalized route collisions", () => {
  withCatalogMutation(
    (actions) => {
      actions[0].path = "/v1/applications/{applicationId}";
    },
    () =>
      assertThrows(
        () => assertInventoryCoverage(),
        ContractQualityError,
        "duplicate catalog route GET /v1/applications/:param",
      ),
  );
});

Deno.test("catalog identity rail rejects duplicate MCP names", () => {
  withCatalogMutation(
    (actions) => {
      findCatalogAction(actions, "applications.get").mcp =
        findCatalogAction(actions, "applications.list").mcp;
    },
    () =>
      assertThrows(
        () => assertInventoryCoverage(),
        ContractQualityError,
        "duplicate catalog MCP name bakery_applications_list",
      ),
  );
});

Deno.test("catalog identity rail rejects unknown access values", () => {
  withCatalogMutation(
    (actions) => {
      (findCatalogAction(actions, "applications.list") as unknown as {
        access: string;
      }).access = "Owner";
    },
    () =>
      assertThrows(
        () => assertInventoryCoverage(),
        ContractQualityError,
        "applications.list: invalid access Owner",
      ),
  );
});

Deno.test("catalog identity rail rejects unresolved MCP default tools", () => {
  const broken = structuredClone(transport) as unknown as typeof transport;
  const mcp = broken.mcp as unknown as { defaultTools: string[] };
  mcp.defaultTools = [...mcp.defaultTools, "bakery_missing_tool"];
  assertThrows(
    () => assertInventoryCoverage(broken),
    ContractQualityError,
    "MCP default tool bakery_missing_tool resolves to 0 catalog actions",
  );
});

Deno.test("inventory rail aggregates missing transport schemas", () => {
  const broken = structuredClone(transport) as unknown as typeof transport;
  delete (broken.inputs as unknown as Record<string, unknown>).CursorQuery;
  delete (broken.outputs as unknown as Record<string, unknown>).Application;
  assertThrows(
    () => assertInventoryCoverage(broken),
    ContractQualityError,
    "applications.list: missing input CursorQuery",
  );
  assertThrows(
    () => assertInventoryCoverage(broken),
    ContractQualityError,
    "applications.get: missing output Application",
  );
});

Deno.test("native lint plugin enforces terminal Zod descriptions", () => {
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const direct = z.string().describe("Text owned by the contract.");
       const metadata = z.string().meta({ description: "Text metadata." });
       const helper = described(z.string(), "Text owned by the helper.");`,
    ),
    [],
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      "const missing = z.string();",
    ).length,
    1,
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      "const composed = z.string().optional();",
    ).length,
    1,
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const helperThenComposed = described(z.string(), "Text owned by the helper.").optional();`,
    ).length,
    1,
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      "const makeSchema = () => z.string();",
    ).length,
    1,
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const invalidHelper = described(z.string(), "TODO");`,
    ).length,
    1,
  );
});

Deno.test("native lint plugin traverses array and lazy schema children", () => {
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const validUnion = z.union([
         z.string().describe("Union string value."),
         z.number().describe("Union number value."),
       ]).describe("Union contract.");
       const validTuple = z.tuple([
         z.boolean().describe("Tuple boolean value."),
         z.string().describe("Tuple string value."),
       ]).describe("Tuple contract.");
       const validLazy = z.lazy(() =>
         z.number().describe("Lazy number value.")
       ).describe("Lazy contract.");`,
    ),
    [],
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const union = z.union([z.string(), z.number()]).describe(
         "Union contract."
       );
       const tuple = z.tuple([z.boolean(), z.string().describe(
         "Tuple string value."
       )]).describe("Tuple contract.");
       const lazy = z.lazy(() => z.number()).describe("Lazy contract.");`,
    ).length,
    4,
  );
});

Deno.test("native lint plugin reports schemas in escaping arrays", () => {
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      "const schemas = [z.string()];",
    ).length,
    1,
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      "const container = { schemas: [z.string()] };",
    ).length,
    1,
  );
});

Deno.test("native lint plugin traverses lazy schema branch expressions", () => {
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const validConditional = z.lazy(() =>
         condition
           ? z.string().describe("Conditional string value.")
           : z.number().describe("Conditional number value.")
       ).describe("Conditional schema.");
       const validLogical = z.lazy(() =>
         z.boolean().describe("Logical boolean value.") ||
         z.date().describe("Logical date value.")
       ).describe("Logical schema.");
       const validSequence = z.lazy(() =>
         (recordSchema(), z.bigint().describe("Sequence bigint value."))
       ).describe("Sequence schema.");`,
    ),
    [],
  );
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const conditional = z.lazy(() =>
         condition ? z.string() : z.number()
       ).describe("Conditional schema.");
       const logical = z.lazy(() => z.boolean() || z.date()).describe(
         "Logical schema."
       );
       const sequence = z.lazy(() =>
         (recordSchema(), z.bigint())
       ).describe("Sequence schema.");`,
    ).length,
    5,
  );
});

Deno.test("native lint plugin rejects static blank and filler descriptions", () => {
  for (
    const source of [
      `const blank = z.string().describe("");`,
      `const whitespace = z.string().describe("   ");`,
      `const todo = z.string().describe("TODO: describe this");`,
      `const metadata = z.string().meta({ description: "" });`,
      `const type = z.string().describe("string");`,
    ]
  ) {
    assertEquals(
      descriptionDiagnostics("packages/contracts/src/example.ts", source)
        .length,
      1,
    );
  }
  assertEquals(
    descriptionDiagnostics(
      "packages/contracts/src/example.ts",
      `const description = getDescription();
       const dynamic = z.string().describe(description);`,
    ),
    [],
  );
});

Deno.test("generation fails when an authored field description is removed", () => {
  const broken = structuredClone(transport) as unknown as typeof transport;
  delete (broken.inputs.ApplicationCreate.fields[2] as { description?: string })
    .description;
  assertThrows(
    () => generateContracts(broken),
    ContractQualityError,
    "missing schema description at ApplicationCreate.description",
  );
});

Deno.test("recursive description rail reports exact child paths", () => {
  const value = z.string().describe("Nested scalar value.");
  const nested = z.object({ value }).describe("Nested value object.");
  const nestedValues = z.array(nested).describe("Nested values collection.");
  const broken = z.object({ nested: nestedValues }).describe("Root contract.");
  const nestedMetadata = z.globalRegistry.get(nestedValues);
  const valueMetadata = z.globalRegistry.get(value);
  z.globalRegistry.remove(nestedValues);
  z.globalRegistry.remove(value);
  try {
    assertEquals(findMissingDescriptions(broken), [
      "schema.nested",
      "schema.nested[].value",
    ]);
    assertThrows(
      () => assertDescribedSchema(broken),
      ContractQualityError,
      "schema.nested",
    );
  } finally {
    if (nestedMetadata) z.globalRegistry.add(nestedValues, nestedMetadata);
    if (valueMetadata) z.globalRegistry.add(value, valueMetadata);
  }
});

Deno.test("description rail rejects deterministic defects and aggregates paths", () => {
  const defects = [
    "   ",
    "field",
    "Task.field value",
    "string",
    "TODO: describe this",
    "TBD",
    "A description",
    "Value for applications.id; format uuid.",
    "Generic bounded string value.",
    "description",
    "property",
    "value",
    "data",
    "n/a",
    "none",
    "unknown",
    "...",
  ];
  for (const description of defects) {
    const field = z.string().describe("Meaningful field description.");
    const schema = z.object({ field }).describe(
      "Meaningful object description.",
    );
    const path = description === "Task.field value" ? "schemas.Task" : "schema";
    const metadata = z.globalRegistry.get(field);
    z.globalRegistry.remove(field);
    z.globalRegistry.add(field, { description });
    try {
      assertEquals(findDescriptionDefects(schema, path), [`${path}.field`]);
      assertThrows(
        () => assertDescribedSchema(schema, path),
        ContractQualityError,
        `${path}.field`,
      );
    } finally {
      z.globalRegistry.remove(field);
      if (metadata) z.globalRegistry.add(field, metadata);
    }
  }

  const runStepDescription = ["Run", "step", "ID."].join(" ");
  const camelCase = z.object({
    runStepId: z.string().describe(runStepDescription),
  }).describe("Meaningful object.");
  assertEquals(findDescriptionDefects(camelCase), ["schema.runStepId"]);

  const first = z.string().describe("First meaningful field.");
  const second = z.number().describe("Second meaningful field.");
  const schema = z.object({ first, second }).describe("Meaningful object.");
  const firstMetadata = z.globalRegistry.get(first);
  const secondMetadata = z.globalRegistry.get(second);
  z.globalRegistry.remove(first);
  z.globalRegistry.remove(second);
  z.globalRegistry.add(first, { description: "value" });
  z.globalRegistry.add(second, { description: "number" });
  try {
    assertEquals(findDescriptionDefects(schema), [
      "schema.first",
      "schema.second",
    ]);
    assertThrows(
      () => assertDescribedSchema(schema),
      ContractQualityError,
      "schema.first, schema.second",
    );
  } finally {
    z.globalRegistry.remove(first);
    z.globalRegistry.remove(second);
    if (firstMetadata) z.globalRegistry.add(first, firstMetadata);
    if (secondMetadata) z.globalRegistry.add(second, secondMetadata);
  }
});

Deno.test("description rail rejects the templated description family", () => {
  const templates = [
    "Supplies foo for Bar. Encoded as uuid.",
    "Supplies height for inputs.CommentAnchor.image; encoded as number(0,1].",
    "Billing policy field maxTokens; encoded as integer.",
    "Limit usd value recorded for this budget account record.",
    "Input object for RunRetry; fields are validated at the transport boundary.",
    "output contract for Page<Message>; fields are validated at the transport boundary.",
    "Input contract for CheckInput; fields are validated at the transport boundary.",
    "Bounded string value identifying or describing this external ticket record.",
  ];
  for (const description of templates) {
    const field = z.string().describe("Meaningful field description.");
    const schema = z.object({ field }).describe(description);
    const metadata = z.globalRegistry.get(field);
    z.globalRegistry.remove(field);
    z.globalRegistry.add(field, { description });
    try {
      assertEquals(findDescriptionDefects(schema), ["schema", "schema.field"]);
      assertThrows(
        () => assertDescribedSchema(schema),
        ContractQualityError,
        "schema.field",
      );
    } finally {
      z.globalRegistry.remove(field);
      if (metadata) z.globalRegistry.add(field, metadata);
    }
  }

  // Same vocabulary, real content: none of these is a template.
  const nearMisses = [
    "Supplies the merge queue with the head SHA the entry was created against; the queue rejects entries whose head has moved.",
    "Retry policy field: encoded as an ISO-8601 duration, applied after the first failed attempt.",
    "Reserved USD value recorded for this budget account record at reservation time; released on settlement.",
    "Input object for the retry; the server re-validates the original run's lease before enqueueing.",
    "Bounded string value identifying or describing this external ticket record; providers may change it between syncs.",
  ];
  for (const description of nearMisses) {
    const schema = z.object({
      field: z.string().describe(description),
    }).describe(description);
    assertEquals(findDescriptionDefects(schema), []);
  }
});

Deno.test("description rail rejects an undescribed authored lazy child", () => {
  const child = z.string().describe("Deferred child value.");
  const parent = z.lazy(() => child).describe("Deferred parent schema.");
  const metadata = z.globalRegistry.get(child);
  z.globalRegistry.remove(child);
  try {
    assertThrows(
      () => assertDescribedSchema(parent),
      ContractQualityError,
      "schema<lazy>",
    );
  } finally {
    if (metadata) z.globalRegistry.add(child, metadata);
  }
});

Deno.test("safe output rail rejects denied fields and preserves JSON descriptions", () => {
  const unsafe = z.object({
    resumeHandle: z.string().describe("Internal resume handle."),
  }).describe("Unsafe output.");
  assertThrows(
    () => assertSafeProjection(unsafe),
    Error,
    "output.resumeHandle",
  );
  const generated = generateContracts();
  const schema = toJsonSchema(generated.schemas.Application);
  assert(
    typeof schema.description === "string" && schema.description.length > 0,
  );
  const unsafeRecord = z.record(
    z.string().describe("Dynamic output key."),
    z.object({ resumeHandle: z.string().describe("Private handle.") }).describe(
      "Dynamic output value.",
    ),
  ).describe("Dynamic output record.");
  assertThrows(() => assertSafeProjection(unsafeRecord), Error, "resumeHandle");
});

Deno.test("rendered JSON values use source descriptions without filler", () => {
  const schema = toJsonSchema(generateContracts().schemas.ArtifactVersionCreate)
    .properties as Record<string, Record<string, unknown>>;
  const metadata = schema.metadata;
  const branches = metadata.anyOf as Record<string, unknown>[];
  assertEquals(
    branches.map((branch) => branch.description),
    [
      "JSON string value.",
      "JSON number value.",
      "JSON boolean value.",
      "JSON null value.",
      "JSON array value.",
      "JSON object value.",
    ],
  );
  const objectBranch = branches[5];
  assertEquals(
    (objectBranch.propertyNames as Record<string, unknown>).description,
    "JSON object key.",
  );
  assertEquals(metadata["x-utf8-max-bytes"], MAX_ARTIFACT_METADATA_BYTES);
  assert(!JSON.stringify(metadata).includes("This branch accepts JSON"));
});

Deno.test("nullable JSON Schema branches require descriptions", () => {
  const schema = toJsonSchema(
    z.union([
      z.string().describe("Source value description."),
      z.null().describe("Null indicates that the source value is unavailable."),
    ]).describe("Nullable source value."),
  ) as { description?: string; anyOf: Array<Record<string, unknown>> };
  assertEquals(schema.description, "Nullable source value.");
  assertEquals(schema.anyOf[0].description, "Source value description.");
  assertEquals(
    schema.anyOf[1].description,
    "Null indicates that the source value is unavailable.",
  );
  assertDescribedJsonSchema(schema);
  assertThrows(
    () =>
      assertDescribedJsonSchema(
        toJsonSchema(
          z.string().describe("Source value description.").nullable().describe(
            "Nullable source value.",
          ),
        ),
      ),
    ContractQualityError,
    "root.anyOf[1]",
  );
});

Deno.test("native JSON Schema retains constraints and compositions", () => {
  const schema = z.object({
    id: z.string().uuid().describe("Resource identifier."),
    kind: z.enum(["a", "b"]).describe("Resource kind."),
    values: z.array(z.number().int().min(1).describe("Positive value."))
      .describe("Resource values."),
    metadata: z.record(
      z.string().describe("Metadata key."),
      z.string().describe("Metadata value."),
    ).describe("Resource metadata."),
  }).strict().describe("Resource contract.");
  const json = toJsonSchema(schema) as {
    properties: Record<string, {
      format?: string;
      enum?: string[];
      items?: { type?: string };
    }>;
    additionalProperties?: boolean;
  };
  assertEquals(json.properties.id.format, "uuid");
  assertEquals(json.properties.kind.enum, ["a", "b"]);
  assertEquals(json.properties.values.items?.type, "integer");
  assertEquals(json.additionalProperties, false);
});

Deno.test("description rail rejects pipe children without mutating them", () => {
  const child = z.string().describe("Output value.");
  const broken = z.string().describe("Input value.").pipe(child).describe(
    "Piped input and output value.",
  );
  const metadata = z.globalRegistry.get(child);
  z.globalRegistry.remove(child);
  try {
    assertThrows(
      () => assertDescribedSchema(broken),
      ContractQualityError,
      "<out>",
    );
  } finally {
    if (metadata) z.globalRegistry.add(child, metadata);
  }
});

Deno.test("worker results keep exact wire types, variants, and bounds", () => {
  const schema = generateContracts().schemas.WorkerResult;
  const reference = {
    artifactId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    sha256: "a".repeat(64),
  };
  const valid = {
    leaseToken: "lease",
    fence: "9223372036854775807",
    localSeq: "1",
    status: "completed",
    result: { artifact: reference },
  };
  assert(schema.safeParse(valid).success);
  assert(
    !schema.safeParse({
      ...valid,
      result: { artifact: { artifactId: reference.artifactId } },
    }).success,
  );
  assert(!schema.safeParse({ ...valid, fence: 1 }).success);
  assert(
    !schema.safeParse({ ...valid, result: { resumeHandle: "private" } })
      .success,
  );
  assert(
    !schema.safeParse({ ...valid, status: "completed", fault: {} }).success,
  );
  const json = toJsonSchema(schema);
  const fence = (json.anyOf as Array<
    { properties: Record<string, Record<string, unknown>> }
  >)[0].properties.fence;
  assertEquals(fence.pattern, "^(?:0|[1-9][0-9]*)$");
  assert(!schema.safeParse({ ...valid, localSeq: "0" }).success);
  const assignment = generateContracts().schemas.JobAssignment;
  assert(
    !assignment.safeParse({ currentCheckpoints: Array(101).fill({}) }).success,
  );
  const anchor = generateContracts().schemas.CommentAnchor;
  assert(
    !anchor.safeParse({ kind: "image", x: 0, y: 0, width: 1.1, height: 1 })
      .success,
  );
  assert(
    !anchor.safeParse({ kind: "image", x: 0.5, y: 0, width: 0.6, height: 1 })
      .success,
  );
});

Deno.test("worker artifact content keeps normalized and raw bytes separate", () => {
  const schema = generateContracts().schemas.WorkerArtifact;
  const base = {
    leaseToken: "lease",
    fence: "1",
    artifactType: "log",
    name: "log",
    contentType: "text/plain",
    content: new Uint8Array([1, 2, 3]),
    metadata: {},
  };
  assert(schema.safeParse(base).success);
  assert(!schema.safeParse({ ...base, content: "AQID" }).success);
  const input = toJsonSchema(schema) as {
    properties: Record<
      string,
      {
        type?: string;
        format?: string;
        "x-utf8-max-bytes"?: number;
      }
    >;
  };
  assertEquals(input.properties.content.type, "string");
  assertEquals(input.properties.content.format, "binary");
  assertEquals(
    input.properties.content["x-utf8-max-bytes"],
    MAX_ARTIFACT_BYTES,
  );
  assertEquals(
    input.properties.metadata["x-utf8-max-bytes"],
    MAX_ARTIFACT_METADATA_BYTES,
  );
  const output = toJsonSchema(generateContracts().schemas.BinaryArtifact);
  assertEquals(output.type, "string");
  assertEquals(output.format, "base64");
  const rawOutput = toJsonSchema(
    generateContracts().schemas.BinaryArtifactBytes,
  ) as { type?: string; format?: string };
  assertEquals(rawOutput.type, "string");
  assertEquals(rawOutput.format, "binary");
});

Deno.test("authored field enums are enforced regardless of primitive type", () => {
  const schema = generateContracts().schemas.SlackEvent;
  assert(schema.safeParse({ type: "event_callback" }).success);
  assert(!schema.safeParse({ type: "bogus" }).success);
});

Deno.test("compatibility digest changes for nested wire contract changes", () => {
  const mutated = structuredClone(transport) as unknown as typeof transport;
  mutated.inputs.ApplicationCreate.fields[1].type = "integer";
  assert(
    generateContracts().compatibilityDigest !==
      generateContracts(mutated).compatibilityDigest,
  );
});

Deno.test("CheckOutput field descriptions say what each field means before they state a bound", () => {
  const generated = toJsonSchema(workerActionOutputSchema("quality.check")) as {
    properties: Record<string, { description?: string }>;
  };
  const expected: Record<string, RegExp> = {
    allRequired: /^True only when every required command/,
    checkRunIds: /^Identifiers of the reported observations/,
    failedCheckIds: /^Identifiers \(checkRunId\) of the required observations/,
    observations: /^One observation per selected fixed command/,
    headSha: /^Full commit SHA the checks ran against/,
    baseSha: /^Base commit SHA pinned by the inspected repository profile/,
    policyDigest: /^Digest of the effective policy the checks ran under/,
  };
  assertEquals(
    Object.keys(generated.properties).sort(),
    Object.keys(expected).sort(),
  );
  for (const [field, meaning] of Object.entries(expected)) {
    const description = generated.properties[field]?.description ?? "";
    assert(meaning.test(description), `${field}: ${description}`);
    // A bound, when there is one, follows the meaning and never replaces it.
    assert(
      !/^CheckOutput\.\w+ (must|output)/.test(description),
      `${field} states only its bound: ${description}`,
    );
  }
});

Deno.test("compatibility migration approves only its exact generated delta", () => {
  // The approval currently in force: the base it was bound to, and the digest
  // of the tree it authorises.
  const approvedBases = [
    "bf7a7885ed28afeb65f8234eea4e3c9a8c7d58c1",
  ];
  const approvedDigest =
    "sha256:8bcbd4129c9fbeb34cd3813bff31e89fe0889a4a121aa520beef4a3e23f2ac87";
  // Every approval this one displaced, in order. They are history: none of
  // them may pass again, or a stale digest would silently re-authorise a delta
  // nobody reviewed.
  const rejectedPriorDigests = [
    // Displaced by the #427 offline runs rebind onto main bf7a7885e: main's own #19 approval, kept unchanged.
    "sha256:3428fc0daed512dc4b5b86a3b937270ba7a3740191e24b1e2b90ff6cc2f49765",
    // Displaced by the #19 preview rebind onto main 4bc760431: main's own #892 approval, kept unchanged.
    "sha256:b7783aa18b7e646a6a052a3735b601fac76c9523d0b4b3eabc3509250d7a6250",
    // Displaced by the #39 proposals read rebind onto main c0f886bf8: main's own #42 approval, kept unchanged.
    "sha256:e2186db90c4ab331ef2d618e8a37454155a10040e69f5a1367165582e5edb32f",
    // Displaced when main moved again (#891 merged): my #42 approval on main b750d78a4.
    "sha256:c3794204f1e29bc7ea756ede5cbe7bcd8301df62f8bfdb1292386ace01dfa748",
    // Displaced by the #42 scoped skills rebind onto main b750d78a4: main's own #431 approval, kept unchanged.
    "sha256:5d80c418459b0d5865f0de9e6b8952cc0930ab9e4aa457760c3bcc56873a9378",
    // Displaced by the #431 private skills rebind onto main 27ba7621c: main's own approval, kept unchanged.
    "sha256:841cef85d52d11f531540be0ec23de9b726c9029570bf9c724d3931350a6de9a",
    // Displaced by the #72 handoff read rebind onto main db286b23b: main's own #59 slice 3 approval, kept unchanged.
    "sha256:a8721cd04c1c5c1fc4036cd270953f30dada8993bfc16abdc29bca0373c60f74",
    // Displaced by the #59 slice 3 rebind onto main 8cad16fd6: main's own approval, kept unchanged.
    "sha256:5835d700baff5d3a6db269f82bf2d2b6daca1ca25e16f1d6cf287e8a41315345",
    // Displaced by the #41 evaluations rebind onto main dc1728c0f: main's own #878 approval, kept unchanged.
    "sha256:0e92d311a1f2274c39ae8f13895c0b7423df24a3b62458e2f278fbd990e255b2",
    // Displaced when main moved again (#876 merged): my previous #25 approval on main 9422f56a8.
    "sha256:dd56648af7ba5523cc95bd57715731a20eaf66a21f32266d21629f61f634027c",
    // Displaced when main moved again (#70 one-paste link merged): my previous #25 approval on main bab18ab7d/46f1ca889.
    "sha256:2199a6ed830ff45d9b59b5fe83b40c9f92dd0b0594789e40e697003d74dce978",
    // Displaced by the #25 maintenance rebind onto main 9422f56a8: main's own #70 approval, kept unchanged.
    "sha256:74cd9dbc5efe4ab6e8ddf44bd016fa24bcc95b07c43255cccde24f19183f763f",
    // Displaced earlier (#59 ask 9 merged): my #25 slice C approval on main 7ff69adbf.
    "sha256:6da4387e06fe3baf8453668e397561d7b4ac346ed9012201f9ea7409f987e74c",
    // Displaced by the #70 round-3 rebind onto main 46f1ca889: my previous #70 approval on main bab18ab7d, kept unchanged.
    "sha256:503059407be95022ac2cbf30a6e2560f71d4c1cf358494228b80ac079b5b5561",
    // Displaced by the #70 one-paste link rebind onto main bab18ab7d: main's own #59 ask 9 approval, kept unchanged.
    "sha256:410873c344d34c4871c225fa82e132a5134f68d02f15c29bd41b15d58afb1efd",
    // Displaced when main moved again (#867 merged): the digest follows the tree; my previous #59 ask 9 approval on main 2e1a18690.
    "sha256:5dc2c61e686ac8085c96decf85c409151156899804ac96cdd55561268eaeb5c2",
    // Displaced by the #59 ask 9 rebind onto main 2e1a18690: main's own approval, kept unchanged.
    "sha256:342031789a41b0d6954e7d86e02bf0427dfe01e81fe8b20108e71c4f5e36f370",
    // Displaced by the #64 E4 server rebind onto main 77dc67ce5: main's own approval, kept unchanged.
    "sha256:512ee3f1b960b1871b2f3dad5ce2e26e387d318f82e0553bc8da73b9731a6914",
    // Displaced by the #64 E4 server rebind onto main aa871531a: main's own #80 P1a approval, kept unchanged.
    "sha256:72801058163e0c9d7f8eefb0fbabdc15b7fc436355124e42ab17b78394aac147",
    // Displaced by the #77 desktop handoff rebind onto main f5ec00f7d: main's own approval, kept unchanged.
    "sha256:dc9bc9faa37e598d625d1fb669b99daaa3a52e6492cc63feebb4f07363963f31",
    // Displaced when main moved again (#848 merged): the digest follows the tree; my previous #58 item 3 approval on main fcf081cb.
    "sha256:282e7c27884d1391ae1a77fd9d18c934a7e8f93033f0bdbbec81965c31b313a0",
    // Displaced when main moved again (#846 merged): the digest follows the tree; my previous #58 item 3 approval on main 523b2647d.
    "sha256:aec7dd9ef6d8ecb08c7c33c910f664b11dfb3bf15c7c9a05bfd269ee9cfb1544",
    // Displaced when main moved again (#845 merged): the digest follows the tree; my previous #58 item 3 approval on main 88dafb556.
    "sha256:51e88572c295c52a4d4c78d5215a9f166f47c2aa448eadf3f50c1edbec4da04e",
    // Displaced by the #58 item 3 rebind onto main 88dafb556: main's own approval, kept unchanged.
    "sha256:b0253a3aff00da400668344c5c722ef264a95cac2480a9daefb10d4a985f76e0",
    // Displaced by the #46 slice C line-count rebind onto main a90e69c73: main's own approval, kept unchanged.
    "sha256:2faab4e9a06dac179b8cea4f14b8d780bfbb6765d9439579a1c58695ba9ca689",
    // Displaced by the #58 startable list rebind onto main 3f14137d0: the #76 plugin pages approval, kept unchanged.
    "sha256:1c141ac78d679b2bc98ce7f6ce69d5aa91aeed6c893e5f18fa8e264b319de2c3",
    // Displaced by the #76 plugin pages main-merge rebind bind onto main ad5241ce6: main's own approval, kept unchanged.
    "sha256:da92d61ec30ee51d5af5b216449f1be52859fd22b13f921b6d078680cdc62bcb",
    // Displaced by the #75 evaluation names rebind onto main d5b78073a: main's own approval, kept unchanged.
    "sha256:f485f696f3c4ca7f6b0f0e704bd118266e1c9ac0288e4ea77ed633a16697b6cc",
    // Displaced by the #70 chooser bind onto main 2b80e3de: main's own approval, kept unchanged.
    "sha256:310d095913989f75555035f8881bb459ef84b9b2fb0c8aa148faef3df220c930",
    // Displaced by the #448 S8a version provenance bind onto main ac855249: main's own approval, kept unchanged.
    "sha256:27f0cef78077fdb96b37869109edce7e61a49fc90011a81598c4f8fa9bc31341",
    // Displaced by the main-red rebind onto main 0b0c2706c: the approval bound to main 76b0d8e4, kept unchanged.
    "sha256:1cf004af3771a81ff0bf65260951658a68ad86256ac348a92f3a29fe91d3f759",
    // Displaced when main moved again (#808 merged): the digest follows the tree; my previous approval on the earlier main.
    "sha256:6be79e65f8d6390329197e6eeb666584a52b9104710badda9373f31cf33eb4ad",
    // Displaced by the #64 slice C cutoff re-bind onto main 35f272370: main's own approval, kept unchanged.
    "sha256:8e68e8856af05cf093594afce7f54f58b31f1ee7e41065c23fcfeea17847cd05",
    // Displaced by the #64 slice B quiesce re-bind onto main e321e76af: main's own approval, kept unchanged.
    "sha256:1f25130262c7f1a06b80a55cf63474047fd0dbd37cf8234a0898539354af3c69",
    // Displaced by the #70 slice 2 re-bind onto main 064ca6fd: main's own approval, then this PR's previous one, kept unchanged.
    "sha256:8a47341c72a1ca31d7f92cd3abdcfe15f9276ecca081f9947301907b1b16ee7b",
    "sha256:4c7ce0ae4caa534c2ceec4f5b125ffe45a2e213b8f9d484be0365ab13c20c517",
    // Displaced by the #739 cursor wording fix: this PR's previous approval, kept unchanged.
    "sha256:ea083571589f6da83d51efd60ecc88fbd387f29186d2f2c3bc01a7b685481c53",
    // Displaced by the #739 re-bind onto main 8d403f12: main's own approval (#57 merge-queue reads), kept unchanged.
    "sha256:af4c0cec80238c9475b30cfa542fdfbf918f4f1b892a86332649bd1a90474480",
    // Displaced by the #739 re-bind onto main 8d403f12: this PR's previous approval, kept unchanged.
    "sha256:78b2f8ca7fbaddc4dad1b5aa7aa413fc35aa31bfd8480a2839765308b1d021f2",
    // Displaced by the #739 re-bind onto main 49a52678: this PR's previous approval, kept unchanged.
    "sha256:b6340fefd73f1155f0b70b57f61530f9a538d482b7816f4588851b78f52c1123",
    // Displaced by the #739 provider re-bind onto main 168b504d: this PR's previous approval, kept unchanged.
    "sha256:a2990005fe2611b63e5122a6bea9699a1d73c4030c7f11b2c4e1cfe541674f77",
    // Displaced by the #57 merge-queue reads re-bind onto main 536ca2f6 (#788 merged): this PR's previous approval, kept unchanged.
    "sha256:5e6cbf87fc5f188cc0b7baf0b42f9b86c72229e09937616145eabbbb79c8f48c",
    // Displaced by the #57 merge-queue reads re-bind onto main 2de7c9744: main's own approval, kept unchanged.
    "sha256:9ba189cc43ffbe02eeddd3a250f68eb0a6fcd143089fa3732b2fdf597d4085a9",
    // Displaced by the #14 context pack limits re-bind onto main e1326d79: main's own approval, kept unchanged.
    "sha256:4b34d06824ea03e2862a772e2f7f1c56f85fc63037820b671eeba8b490a42d3e",
    // Displaced by the #448 S3-S6 re-bind onto main 8476585c: main's own approval, kept unchanged.
    "sha256:766a91a3406a6ef488de878590269f396d6b646fb70be95418e27e01a7071c2c",
    // Displaced by the #445 pin re-bind onto main a3a5a3400: main's own
    // approval, kept unchanged.
    "sha256:01305743634c3447fe91302c0a64559bbcd7503cb16ec7a76eeb1cff3f878713",
    // Displaced by the #44 evaluation batches re-bind onto main 133085d15: main's own approval, kept unchanged.
    "sha256:fdb9ae6084d1d4db3514b3596518187e565c6c128e770507f105f676b33e84e4",
    // Displaced by the #445 Library under Files re-bind onto main c8cf571ea: main's
    // own approval, kept unchanged.
    "sha256:f204f40485b2c391f018f947955664f5e1d9315c7dd5838cd8785bd12ead618d",
    // Displaced by the #46 development metrics re-bind onto main 2dcf89040: main's own approval, then this PR's previous one, kept unchanged.
    "sha256:7173fd9bec99984de1ef3b84f3b010c1fd28eb98a6776b08fbc4e19bc22908a3",
    "sha256:69c0243b9bd49da8b9278b63702507e0bdaac7fd701731cd4ec39ed1372ab67a",
    // Displaced by the #19 private previews re-bind onto main 0aceacbe: main's own
    // approval, kept unchanged.
    "sha256:5f21fc22924aa26340da277a3d286d70b5517b8bde6fb02c1e53b453a917491e",
    // Displaced by the #400 S2 plan admission re-bind onto main c0afffaa2 (#741 merged): main's own approval, then this PR's previous approval, kept unchanged.
    "sha256:e57de0de36c4f5a4aea4e34f5c1bffcd3c9ab0ea5823cd8137a28bafb2f24154",
    "sha256:8f13900a664e97c69caa28ca9c2d4855d57374d7e8db6a0c5d37721d9603a819",
    // Displaced when main moved again (#737 merged): the digest follows the tree.
    "sha256:68f8ed103f00f5939c295ca6fcdff4841ce299aa7adcbd10581d3a765d89d59a",
    // Displaced when main moved again (#733 merged): the digest follows the tree.
    "sha256:c2c9891d5d6ddcc2922c2874222e3d3d0b214119102017d39890e121da2df574",
    // Displaced by the #72 live updates re-bind onto main a1df1217 (#740 and #742 merged): main's own
    // approval, then this PR's earlier approvals, newest first.
    "sha256:1e96091b9990086d17c09e0bae292465d0f9ce34f5b698b29d9fceb229246276",
    "sha256:fb10887d4b159377b43b00903e72e8942c1804bb621ee75e18d5a3d40487193e",
    "sha256:52694c6c5c85601fc23bab0a2989c1d8cb4d422e0d44a7a73af72447e6c1ee70",
    "sha256:28b92c05eb6628790f55b608b89bda867f863b3476c3acf0e11e6aa5c9793eb2",
    "sha256:4bbd1def5f3a695bbb5f56ab36ef532ae64f6e9b501575f15d5f89167ccd0c9f",
    // Displaced by the #42 skill copy re-bind onto main 04c3fa8ff: main's own approval, kept unchanged.
    "sha256:c8c14f83cd6c0e6aa55afeb28d0ed880dbd695ca3cc4ec81491fce79f9bb3c96",
    // Displaced by the #72 memory re-bind onto main 4bd35c217 (#728 merged): main's own
    // approval, kept unchanged.
    "sha256:f61c0f4a77facec344684ffb9915710f8ea65201a8c67b62bbef25382a56b7c3",
    // Displaced by the same re-bind: my previous approval on the earlier main.
    "sha256:7d9b85a83e5f5a41393e5e6dcc407866073723de501b560c7518c019ba25c14e",
    // Displaced by the #72 memory current-revision projection re-bind: the same
    // fields on earlier mains (#731 and #735, then #726 and #729, changed other
    // contracts).
    "sha256:0fb3b25cf12e177a1109c01437a66d54d4b52f7353c5b5bfa3715e2950ffef89",
    "sha256:8b08cad643d87da63e23c5231fbad0dd44f45ae2fa14161439db45e37e6bc75b",
    // Displaced when main moved again (#735 and #731 merged): the digest follows the
    // tree, so the earlier one no longer authorises it.
    "sha256:465b0eac418d01b44c8e533f81a2236c7e9a75bdfc572d13453c4d5f8c531537",
    // Displaced when main moved again (#729 and #732 merged): the digest follows the
    // tree, so the earlier one no longer authorises it.
    "sha256:c5d59d227e19c3f94fe88c3d44873dc135008fd2478ac8d8ad8daa76397130cf",
    // Displaced by the #431 re-bind onto main 889c2fbfb: main's own approval, kept unchanged.
    "sha256:050bbfec6c6d3ccd73991e61264bee8b5d336bfd701d2a73dc9fc1374b2ee3aa",
    // Displaced when main moved again (#725): the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:350a67b467395a98dc007935426ca0ec22397a03e33c236f38510f471d3026d3",
    // Displaced by the #434 MCP connections re-bind: connection create and update drop
    // secretId for a write-only secret, and discovery, classification and use grants
    // add their actions.
    "sha256:6afc058c5118d256bd2cc5d538fd805ea1e13f0676bf8676a0b61e4e338fdfc1",
    // The same #57 merge from Bakery change before main moved again (#724): the
    // digest follows the tree, so the earlier one no longer authorises it.
    "sha256:468a1fc65fc3b08483d56cf8108a2d8cb76241bab428558a44b78b723a0d8a53",
    // Displaced by the #57 merge from Bakery re-bind: PullRequest gains required
    // mayMerge and mergeMethod, on top of the #69 memberships display name.
    "sha256:886e14f144b21807537d0f78ff691ae52afbaaddbca3f481f51201a2e0280926",
    // Displaced by the #69 memberships display name re-bind: the same field on a
    // later main (#715 and #722 changed other contracts).
    "sha256:7c605d89839ef7b4dedd92feda2afa1c33433e9f03109e821aa4d336b492e8dc",
    // Displaced by the #69 memberships display name re-bind: the same field on a
    // later main (run requests changed other contracts).
    "sha256:1d3651ae1239f8f54a3dc7cf7ff3d15dd4427d74ae6c38055011e3448025297b",
    // Displaced by the #69 memberships display name re-bind: the same field on a
    // later main (other contracts changed meanwhile).
    "sha256:bf42491992fc91771fa09e088016f5aa278fd410321433844f342fe80f58b9e1",
    // Newest first, matching the file: a displaced approval is prepended, so the
    // approval this change removed from force heads the history it joins.
    // Displaced by the #69 memberships display name re-bind: the same field on a
    // later main (#706 changed other contracts).
    "sha256:d07a0bb613385bd6e7f94c9d25aac4655dd74ea34b6196b1e9f89acb748619d3",
    // Displaced by the #69 memberships display name re-bind: OrganizationMembership
    // gains a required displayName.
    "sha256:fde2bf41e3caf11df66620b7a2a88273a0a65d334f02a2ee432fde53c0d59580",
    // Displaced by the #69 ticket preview, link reads and status note re-bind.
    "sha256:c22cd3f2f4e54fa2a414d3d24c1f9872c04df3eaead7354f46ea1cfaea241c5d",
    // Displaced by the #26 probe re-bind: RouteHealth gains reasonSince and the
    // `redirected` reason.
    "sha256:b0f68836f1e6252ec3d0c1914d16e96d35da033d0a564548be95ffc8f52d10e1",
    // Displaced by the #72 reader-relative memory source state re-bind.
    "sha256:fc5c7bededbed24e8541ca3168cde358c616922447161ade6ee7cec2f39ee429",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:fc6128799994a7ec2ab43bc364c1f126b47537717d43b7e6770761889a3a9684",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c2ea1145b2b35476f0f1f55b7034d2e12ad9df0a5ed876f7221e90fe1d5ddd1f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:4cc7f7f231a01ca2973fbc286f4835dbafded08006c964c3efc5bf6aa2151636",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:09b09f0f1fac1d0159314e792984f878628b3d34d48218f5793892e72943c4c1",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:622f0d8afe0eec3d53230a4b5ffe7b365ef882e20baf3832dc82ba93e1921077",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:d02b19736a599905534fcb9b8b98f981b8778f5ee24628ee430fb9134c797f8f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1eeaffbfef54aad388017ce455d32e39664ecd49bab7436c55abefb986a5f0bb",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:4ebf063b41c7e0de7863086c2e9105541c97b4d6c7a2c26f57bbd1c192de4e14",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:65049b75d0ce9f83d0abc3d3e42405c13de27df0dccadbc2706a677d7f877f5b",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:0ef9bcaa65279e2c611ac87438f9ec7e9b8417274528801e50a0ca66885713ef",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c4f2e0edb6e258b45e83f975b16500b8d9cc45f69d0879d9fb06f236aecce3be",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7e4e457c805485ab1f60b08ce27d39ddab856e952ab3a85e23aafc7c8a24607e",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:4c56e576cd84a373f4e2beb0d3d3bfa9f0e4093a3da28b12bbe5c4cb84dc3934",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:b46e578adb70220a6bd9d07883733a5a2e0a3ebb2c91284663c4e01657dc025b",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:51d027f5eaf15684db3485346558c5842f3f93e44ab1547e0c59ef66c6196c4b",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1761ce543c2948f552e4f84c2070e726bddc93284b7f15890f2eb48de466075e",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:6bfc1442f25c54b84101fd9cfac91715878bc3d6e4517147188cfa920f92ca58",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:2b7163b6c9e8c02d65232fdf104fec24f063107b9f4411a737cc3cbf2bae388c",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:ac1b07766e7d05e33254a0a07747af2b9112920fd1d540bd544d78c379eaa281",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:dbe1889d84e59edf1f69da64749e7b604addfe93ea97413c1d34dc40bf167231",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:139ea14b6964c5354840656bfacffc5447fff97615cb711676b40fc299f972d9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:623d6a7faf9f3c60e4e41572b883999bcf864ecabc499d9e2fbfcb49357a34cb",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:6658f8267455717fb9b29758d3923f1c686e6d02f81ce8ede67bc0db9d52c9a4",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:e97fc71fb0fdf9e1e49f56c8b3efc1ca4faa419017f68b8edc6675596c9e0eae",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c078bd6d5c6a6da2de8bd282e3509208b0aa436cc0e0f681d477e8047b72989d",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1ed6bad0484976eed09deea818a1a340eab2668f5de555c36169c18d611b01a2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:dc18cc1ed5f027113db82e9883fa59f8d9c8d2c5c710b74886f713f0906bb046",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c348efc564ffa81a7d0666542b97a81ca920e676a1c098a99e6dc79fb7722464",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:bd0e5ba6714874734c1938dcbc1120b3e4a8ebaf6631aaa2c0f4e7cd7dab1694",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:93d63773a5469970d19d17fe4a8f2422a655b73edd8b984d172dfa9f38a08203",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:ca7eeb37fa36f97f8835a11cbf65f8a91ae4a19534277c7a294bb6677d6510b9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:76372a8016c3cdd153ff1308f7a1f0e4b71fac96ffaf4a23d4053e9ebb80fdb7",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:2d18372cc36b196d0f0282a173157709e7cd199b760353482b03337eb10aa065",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:0c071f98ee7288dcd1470d8eea9462df86e806a04f59295215f96e384976ba14",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:fbc5e1c5877f5c5c082f05e69aea7c11d3ae32b57d9773475932910ec2a97d48",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1d9e3729892d3fbb160a9dfc87d61a8d6cac7be3daf52738cd9b008e4271ac53",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:710fc37ee626a3490d52ad50e01de1ca59955350e27fc3f70122541474cf92ac",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:aa50e96a36b4a59e869b5c0a12df68d8bdbe098cbcb6002a97bcbc15e40bd30f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:336ae1d04127b6ef149b6b9ee3d23e2bbf9bfa029dc4e8a44e2f67f38bb10478",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7e0a839ba2fc482e14c1764ec3cd48ed3f13daf8581ac7ade3806786f27493a9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:3345e618b68f07b4c9fe812f01fb68ff640b6067835898de182cb7290a881bf9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:a2cd7086b8ee983e07893c77ab31d1d0993801c247df3b6f8c08f6db1bfd77d8",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:353c3d594328f7e1bfdfdfd19e69af5a59ecb9f24965cdf72a01a059c2b08f76",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:8d6f8348ef7694438cfdcf5a0c1d5ba2fb88714683ea58c244bbc6d407f1aff6",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:12f827e5d5408adc37131d97995c8c2b15a5401b5e35bb0830ffcdf233f103bf",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:232a2c5758c59d59d31328ede6680fa0f9d66bd5927c8ea6f82d13d9d8c77c3c",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:78ee462aaef56f20505b31bded8d75585751303809e557a433485ec2f83b10c9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:68b743e80c5fb9c85c643d74d9385a55bdbd3eff154441ff2d363bcdf2bfc1a4",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:98fd81fd9287c8ad856c73e96dbf27903811cdbe58764f61f73c2ab25987f242",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7e19b404d23529f2a3b14a8f5c18c194aff26a81d41c5519fcfd2a9dc35dc2a1",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:55f636df3722b1a00102270811f8559d26b1fc983cc2b10ec22655a6bcb7a476",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:92d4d9c2af182d0ff6b64ef42e4ea5e5f5b286dd35f8f7bf2fcc2fd99398267f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:d5ef3702fa55af7c433997da1cb98f433417b2a1f0f26486640c8d3c54c5ddb1",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:4fc78d2de03e5e376dd79b87c3f189ddca5b3186b786acd34545a18a9511a8ba",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:cc6a65616c808782df86dfd9daef27c8aa6f4222438b6235e0eb64d716e7c7b4",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:9a576a3680e40f6172f243f5419f0d73af8e6b752f918863e25b394f46c44521",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:e02273ddd925972b33530f085536aa94a9d2654b6f167f758076be8d8bbcc188",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:0f2698701cb30196d67aa170e27651b16baded4bc00b6f1a0bcd9444fd205245",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:770a0d41eb29b5a176911b29a7523cde1e0daea10113cc9c23023b40832004c7",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:5bb840b9dcdbef0eb3f6b8e4955ae1c1f4e351b1e9f4f2e59c9af3b47670cd72",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:8f87027aa5c3c8e3f7c1ce56a43de3c53e814e27d5b711025bd6517215a741be",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:dee4469890ac830cb229330814505de465e6112912e959a65d0c56684ede3aa1",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c4d6006be3ff3fc414df1491792fc7be6733234bbd0b5649104cf4d230346efe",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:a504b9aca55fcf83165e0e7e2ded3a2dd45098fe9902a5e4dc042d60a62f32d6",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:5e61ef61d01e981d22ed477a987587315d2c66c31f674fd99a95be30493f51a2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1b1922aa621bbd8e7a12ecc87fd4dc37f894202cc5124bc0826ccbe7dbe99903",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:a6db8a26822842a0f197e755af058505d76d0d3c5b653921e922c2f1dcb2daab",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:4a9958548e5915a432e627dc9915c0d122f23d43d80d15184c8b95f8d9051b51",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:978785707cce0b228199da13704c2f05e84078dcd1bd79ba3599e4bbd1757667",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:51409633e9d771a2e8c761691aa2e62e6252dc53fee67db9fbc7a94a45aea7a9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:b3ffca3c7f59ff8a08115a6d1ee524c9871d07a1ce53116c3819512dab8e8d4b",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:46e470ec654319b74b99873e4238498ce15c56637694bd6dda5cb8de91e91cc2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:6c2254faae8fbf5c9b23b6240db42e3ed8868e6626e2328be6a5aa3ccd8b28d3",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:8549b0f4adcd52eda87064d7c2a6536747f375cefbfe8fc1d9df6e28575abf30",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:39bebac9652e364e16640714107e3d9d5849786f00c719be39ca60ab88d08ff6",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:2969de3294670cd497d82c862f9b0d5b98282a243df93ad70531f2f6d60287c2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7f37597e4998fcbe86728fbc927b0e5cd1c7ee1628d66b61be666b0df242db3f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:c6f7614c7da4c4ca8484f9edd2bbb674c061173ab1436a72f155d36d4739cd4e",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:ceb15810df3c1d583df237ccde52b43ebacf26f96aa40324903694ebbf93afa1",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:5300a71cd4e6abc6fa55b2932f7859b10aadbe82617918cbf084438b248c64a9",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:1a5e741ff89fecd5cb17269e47310f6edb1132c8de681d7069da92e886a0f172",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:07570c28bcb1792aae51252985674a668e1a945a71f857577e64f55652d316d2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:aebd28ef58a960d7e9da837659e60a32161c68f106add54c4018a6e541be355f",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:b1f7b4e099a9f48f3c26e181b8403577c183849450562df075e37459f3418b55",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7280b5cdfbbe881b136ec5c5a74e0baf8f92868382f139fe3772c3115b5e6b18",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:23925a33300c5bace9bf0ea5729725c8779c2e6ac70f0a3290aaf2335daff1f2",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:6bda73092281a4782bdf22990a05724cb6689eb6521e6002ce90c8a3649b68f8",
    // Displaced when main moved again: the digest follows the tree, so the
    // earlier one no longer authorises it.
    "sha256:7f121f3dd6d394422c44dbe266e087428464c62344c4a4c38fa568d0fefa008f",
    // Displaced by the #431 re-bind onto main 889c2fbfb: the approval in force before it.
    "sha256:8245596f161a86ab236363b8837998152825717ab568ad0db92131209088f602",
    // Displaced by the #431 re-bind onto main 0ab8a3035: the approval in force before it.
    "sha256:af74bd29915588674006ef96811da9402432fedb9dcef667c799dd54df482123",
    // Displaced by the #431 re-bind onto main 4e1f1fdf6 (#57 and #723 landed): the approval in force before it.
    "sha256:68ac5cc235510ebf89411e981e1797c03b18eb5817a1948fd0d1ac6794122147",
    // Displaced by the #431 re-bind onto main 94e8c0e8c (PR1 opened).
    "sha256:74939f698da35840e7aba037034e0e3452c6e17c35fd0790a3c9a0e37886e3d4",
    // Displaced by the #431 re-bind onto main 94e8c0e8c (PR1 opened).
    "sha256:0af27ea622064da472975b42034ebb6706ba64e6175512437fff8bf75ffe9cfa",
    // Displaced by the #431 private skills re-bind onto main a83b7ec57 (access
    // and the skill:author permission follow the personal/organization split).
    "sha256:1bb20d3e4b8b522b20bd353fb37d4c1b62b79f41d754036ea28804c650d7a9dc",
  ];
  const options = {
    baseRef: approvedBases[0],
    resolvedBaseRef: approvedBases[0],
    compatibilityDigest: approvedDigest,
  };
  const mutated = structuredClone(transport) as unknown as typeof transport;
  mutated.inputs.ApplicationCreate.fields[1].type = "integer";
  const alteredDigest = generateContracts(mutated).compatibilityDigest;

  assertEquals(migration.targetCompatibilityDigest, approvedDigest);
  assert(alteredDigest !== approvedDigest);
  assertEquals(
    migration.priorApprovals.map((approval) =>
      approval.targetCompatibilityDigest
    ),
    rejectedPriorDigests,
  );
  for (const approvedBase of approvedBases) {
    assertEquals(
      isApprovedCompatibilityMigration(migration, {
        baseRef: approvedBase,
        resolvedBaseRef: approvedBase,
        compatibilityDigest: approvedDigest,
      }),
      true,
    );
  }
  assertEquals(
    isApprovedCompatibilityMigration(migration, {
      ...options,
      compatibilityDigest: alteredDigest,
    }),
    false,
  );
  for (const compatibilityDigest of rejectedPriorDigests) {
    assertEquals(
      isApprovedCompatibilityMigration(migration, {
        ...options,
        compatibilityDigest,
      }),
      false,
    );
  }
  assertEquals(
    isApprovedCompatibilityMigration(migration, {
      ...options,
      compatibilityDigest: "sha256:" + "0".repeat(64),
    }),
    false,
  );
  assertEquals(
    isApprovedCompatibilityMigration(migration, {
      ...options,
      baseRef: "a858fcfffea12f7a71b16ad3e5c5a98317423acf",
      resolvedBaseRef: "a858fcfffea12f7a71b16ad3e5c5a98317423acf",
    }),
    false,
  );
});

Deno.test("compatibility rail rejects removed actions and fields", () => {
  const current = generateContracts();
  const previous = { ...current, actions: current.actions.slice(1) };
  assertThrows(
    () => assertCompatible(current, previous),
    Error,
    "action removed",
  );
  const changed = {
    ...current,
    openapi: structuredClone(current.openapi) as Record<string, unknown>,
  };
  const schema = (changed.openapi as Record<string, unknown>).components as {
    schemas: Record<string, Record<string, unknown>>;
  };
  const application = schema.schemas.Application;
  const properties = application.properties as Record<string, unknown>;
  delete properties.id;
  assertThrows(
    () => assertCompatible(current, changed),
    Error,
    "field removed",
  );
});

Deno.test("compatibility rail rejects a removed nested property map", () => {
  const previous = generateContracts();
  const current = {
    ...previous,
    openapi: structuredClone(previous.openapi) as typeof previous.openapi,
  };
  const schemas = (current.openapi.components as {
    schemas: Record<string, Record<string, unknown>>;
  }).schemas;
  const config = (schemas.AgentVersionCreate.properties as Record<
    string,
    Record<string, unknown>
  >).config;
  delete config.properties;
  assertThrows(
    () => assertCompatible(previous, current),
    Error,
    "property map removed",
  );
});

Deno.test("compatibility rail checks path responses and request bodies deeply", () => {
  const current = generateContracts();
  const mutate = (change: (operation: Record<string, unknown>) => void) => {
    const changed = {
      ...current,
      openapi: structuredClone(current.openapi) as typeof current.openapi,
    };
    const operation = (changed.openapi.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >)["/v1/applications"].post;
    change(operation);
    return changed;
  };
  assertThrows(
    () =>
      assertCompatible(
        current,
        mutate((operation) => {
          const responses = operation.responses as Record<string, unknown>;
          delete responses[Object.keys(responses)[0]];
        }),
      ),
    Error,
    "responses",
  );
  assertThrows(
    () =>
      assertCompatible(
        current,
        mutate((operation) => {
          const body = operation.requestBody as Record<string, unknown>;
          const content = body.content as Record<
            string,
            Record<string, unknown>
          >;
          const schema = content["application/json"].schema as Record<
            string,
            unknown
          >;
          schema.$ref = "#/components/schemas/WorkerResult";
        }),
      ),
    Error,
    "requestBody",
  );
  assertThrows(
    () =>
      assertCompatible(
        current,
        mutate((operation) => {
          const response = (operation.responses as Record<string, unknown>)[
            "200"
          ] as Record<string, unknown>;
          const media = (response.content as Record<string, unknown>)[
            "application/json"
          ] as Record<string, unknown>;
          (media.schema as Record<string, unknown>).$ref =
            "#/components/schemas/WorkerResult";
        }),
      ),
    Error,
    "responses.200.content.application/json.schema",
  );
  assertThrows(
    () =>
      assertCompatible(
        current,
        mutate((operation) => {
          delete (operation.requestBody as Record<string, unknown>).content;
        }),
      ),
    Error,
    "requestBody",
  );
});

Deno.test("AgentVersionCreate config is strict at runtime", () => {
  const schema = generateContracts().schemas.AgentVersionCreate;
  const valid = {
    revision: 1,
    config: { harness: "codex", allowedCapabilities: ["shell"] },
    digest: "a".repeat(64),
  };
  assert(schema.safeParse(valid).success);
  assert(
    !schema.safeParse({ ...valid, config: { harness: "codex", unknown: true } })
      .success,
  );
  assert(
    !schema.safeParse({
      ...valid,
      config: { harness: "codex", allowedCapabilities: Array(101).fill("x") },
    }).success,
  );
});

Deno.test("OpenAPI preserves methods and path parameter schemas", () => {
  const openapi = generateContracts().openapi as {
    paths: Record<
      string,
      Record<string, { parameters?: Array<{ name: string; in: string }> }>
    >;
  };
  const path = openapi.paths["/v1/applications/{id}"];
  assert(
    path.get.parameters?.some((parameter) =>
      parameter.name === "id" && parameter.in === "path"
    ),
  );
  assert(
    path.patch.parameters?.some((parameter) =>
      parameter.name === "id" && parameter.in === "path"
    ),
  );
  assert(openapi.paths["/v1/applications"].get);
  assert(openapi.paths["/v1/applications"].post);
  const generated = generateContracts();
  const claim = generated.openapi.paths as Record<
    string,
    Record<string, { responses: Record<string, unknown> }>
  >;
  assert(claim["/v1/worker/claims"].post.responses["204"]);
  const upload = claim["/v1/worker/attempts/{id}/artifacts"].post;
  assert(upload);
});

Deno.test("generated OpenAPI resolves every local reference", () => {
  const openapi = generateContracts().openapi;
  const resolve = (pointer: string): unknown => {
    if (!pointer.startsWith("#/")) return undefined;
    let value: unknown = openapi;
    for (const part of pointer.slice(2).split("/")) {
      if (!value || typeof value !== "object") return undefined;
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      assert(resolve(object.$ref) !== undefined, object.$ref);
    }
    Object.values(object).forEach(visit);
  };
  visit(openapi);
});
