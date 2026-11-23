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
    "c81df5445",
  ];
  // The base the approval it displaced was bound to. That approval is history
  // now, so its own base must not pass either.
  const displacedBase = "7f539aaf305c1d7b004abd7113c8c9ab7f694c58";
  const approvedDigest =
    "sha256:efdefddd74d7df9cb0173f66b12b36a00ddffd017d8b85a5f0872c21c7195c1b";
  // The approval this one displaced, at the head of the chain. It is history:
  // it may not pass again, or a digest nobody reviewed would silently
  // re-authorise a delta. A rebind that changes no contract keeps the same
  // digest, so the displaced approval is told apart by its base, not by a
  // different digest.
  const rejectedPriorDigests = [
    "sha256:efdefddd74d7df9cb0173f66b12b36a00ddffd017d8b85a5f0872c21c7195c1b",
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
  // A prior approval's digest is history, and so is its base: neither passes,
  // and a rebind that changes no contract keeps the same digest, so the base is
  // what tells the two apart.
  for (const compatibilityDigest of rejectedPriorDigests) {
    assertEquals(
      isApprovedCompatibilityMigration(migration, {
        baseRef: displacedBase,
        resolvedBaseRef: displacedBase,
        compatibilityDigest,
      }),
      false,
    );
  }
  // A prior approval's base is not this approval's base, whatever digest is
  // offered with it.
  assertEquals(
    isApprovedCompatibilityMigration(migration, {
      baseRef: displacedBase,
      resolvedBaseRef: displacedBase,
      compatibilityDigest: approvedDigest,
    }),
    false,
  );
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
