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
  const approvedBases = [
    "752daef1429173ec613fac0d76d7e3e225671bb4",
  ];
  const approvedDigest =
    "sha256:623d6a7faf9f3c60e4e41572b883999bcf864ecabc499d9e2fbfcb49357a34cb";
  const rejectedPriorDigests = [
    "sha256:6658f8267455717fb9b29758d3923f1c686e6d02f81ce8ede67bc0db9d52c9a4",
    "sha256:e97fc71fb0fdf9e1e49f56c8b3efc1ca4faa419017f68b8edc6675596c9e0eae",
    "sha256:c078bd6d5c6a6da2de8bd282e3509208b0aa436cc0e0f681d477e8047b72989d",
    "sha256:1ed6bad0484976eed09deea818a1a340eab2668f5de555c36169c18d611b01a2",
    "sha256:dc18cc1ed5f027113db82e9883fa59f8d9c8d2c5c710b74886f713f0906bb046",
    "sha256:c348efc564ffa81a7d0666542b97a81ca920e676a1c098a99e6dc79fb7722464",
    "sha256:bd0e5ba6714874734c1938dcbc1120b3e4a8ebaf6631aaa2c0f4e7cd7dab1694",
    "sha256:93d63773a5469970d19d17fe4a8f2422a655b73edd8b984d172dfa9f38a08203",
    "sha256:ca7eeb37fa36f97f8835a11cbf65f8a91ae4a19534277c7a294bb6677d6510b9",
    "sha256:76372a8016c3cdd153ff1308f7a1f0e4b71fac96ffaf4a23d4053e9ebb80fdb7",
    "sha256:2d18372cc36b196d0f0282a173157709e7cd199b760353482b03337eb10aa065",
    "sha256:0c071f98ee7288dcd1470d8eea9462df86e806a04f59295215f96e384976ba14",
    "sha256:fbc5e1c5877f5c5c082f05e69aea7c11d3ae32b57d9773475932910ec2a97d48",
    "sha256:1d9e3729892d3fbb160a9dfc87d61a8d6cac7be3daf52738cd9b008e4271ac53",
    "sha256:710fc37ee626a3490d52ad50e01de1ca59955350e27fc3f70122541474cf92ac",
    "sha256:aa50e96a36b4a59e869b5c0a12df68d8bdbe098cbcb6002a97bcbc15e40bd30f",
    "sha256:336ae1d04127b6ef149b6b9ee3d23e2bbf9bfa029dc4e8a44e2f67f38bb10478",
    "sha256:7e0a839ba2fc482e14c1764ec3cd48ed3f13daf8581ac7ade3806786f27493a9",
    "sha256:3345e618b68f07b4c9fe812f01fb68ff640b6067835898de182cb7290a881bf9",
    "sha256:a2cd7086b8ee983e07893c77ab31d1d0993801c247df3b6f8c08f6db1bfd77d8",
    "sha256:353c3d594328f7e1bfdfdfd19e69af5a59ecb9f24965cdf72a01a059c2b08f76",
    "sha256:8d6f8348ef7694438cfdcf5a0c1d5ba2fb88714683ea58c244bbc6d407f1aff6",
    "sha256:12f827e5d5408adc37131d97995c8c2b15a5401b5e35bb0830ffcdf233f103bf",
    "sha256:232a2c5758c59d59d31328ede6680fa0f9d66bd5927c8ea6f82d13d9d8c77c3c",
    "sha256:78ee462aaef56f20505b31bded8d75585751303809e557a433485ec2f83b10c9",
    "sha256:68b743e80c5fb9c85c643d74d9385a55bdbd3eff154441ff2d363bcdf2bfc1a4",
    "sha256:98fd81fd9287c8ad856c73e96dbf27903811cdbe58764f61f73c2ab25987f242",
    "sha256:7e19b404d23529f2a3b14a8f5c18c194aff26a81d41c5519fcfd2a9dc35dc2a1",
    "sha256:55f636df3722b1a00102270811f8559d26b1fc983cc2b10ec22655a6bcb7a476",
    "sha256:92d4d9c2af182d0ff6b64ef42e4ea5e5f5b286dd35f8f7bf2fcc2fd99398267f",
    "sha256:d5ef3702fa55af7c433997da1cb98f433417b2a1f0f26486640c8d3c54c5ddb1",
    "sha256:4fc78d2de03e5e376dd79b87c3f189ddca5b3186b786acd34545a18a9511a8ba",
    "sha256:cc6a65616c808782df86dfd9daef27c8aa6f4222438b6235e0eb64d716e7c7b4",
    "sha256:9a576a3680e40f6172f243f5419f0d73af8e6b752f918863e25b394f46c44521",
    "sha256:e02273ddd925972b33530f085536aa94a9d2654b6f167f758076be8d8bbcc188",
    "sha256:0f2698701cb30196d67aa170e27651b16baded4bc00b6f1a0bcd9444fd205245",
    "sha256:770a0d41eb29b5a176911b29a7523cde1e0daea10113cc9c23023b40832004c7",
    "sha256:5bb840b9dcdbef0eb3f6b8e4955ae1c1f4e351b1e9f4f2e59c9af3b47670cd72",
    "sha256:8f87027aa5c3c8e3f7c1ce56a43de3c53e814e27d5b711025bd6517215a741be",
    "sha256:dee4469890ac830cb229330814505de465e6112912e959a65d0c56684ede3aa1",
    "sha256:c4d6006be3ff3fc414df1491792fc7be6733234bbd0b5649104cf4d230346efe",
    "sha256:a504b9aca55fcf83165e0e7e2ded3a2dd45098fe9902a5e4dc042d60a62f32d6",
    "sha256:5e61ef61d01e981d22ed477a987587315d2c66c31f674fd99a95be30493f51a2",
    "sha256:1b1922aa621bbd8e7a12ecc87fd4dc37f894202cc5124bc0826ccbe7dbe99903",
    "sha256:a6db8a26822842a0f197e755af058505d76d0d3c5b653921e922c2f1dcb2daab",
    "sha256:4a9958548e5915a432e627dc9915c0d122f23d43d80d15184c8b95f8d9051b51",
    "sha256:978785707cce0b228199da13704c2f05e84078dcd1bd79ba3599e4bbd1757667",
    "sha256:51409633e9d771a2e8c761691aa2e62e6252dc53fee67db9fbc7a94a45aea7a9",
    "sha256:b3ffca3c7f59ff8a08115a6d1ee524c9871d07a1ce53116c3819512dab8e8d4b",
    "sha256:46e470ec654319b74b99873e4238498ce15c56637694bd6dda5cb8de91e91cc2",
    "sha256:6c2254faae8fbf5c9b23b6240db42e3ed8868e6626e2328be6a5aa3ccd8b28d3",
    "sha256:8549b0f4adcd52eda87064d7c2a6536747f375cefbfe8fc1d9df6e28575abf30",
    "sha256:39bebac9652e364e16640714107e3d9d5849786f00c719be39ca60ab88d08ff6",
    "sha256:2969de3294670cd497d82c862f9b0d5b98282a243df93ad70531f2f6d60287c2",
    "sha256:7f37597e4998fcbe86728fbc927b0e5cd1c7ee1628d66b61be666b0df242db3f",
    "sha256:c6f7614c7da4c4ca8484f9edd2bbb674c061173ab1436a72f155d36d4739cd4e",
    "sha256:ceb15810df3c1d583df237ccde52b43ebacf26f96aa40324903694ebbf93afa1",
    "sha256:5300a71cd4e6abc6fa55b2932f7859b10aadbe82617918cbf084438b248c64a9",
    "sha256:1a5e741ff89fecd5cb17269e47310f6edb1132c8de681d7069da92e886a0f172",
    "sha256:07570c28bcb1792aae51252985674a668e1a945a71f857577e64f55652d316d2",
    "sha256:aebd28ef58a960d7e9da837659e60a32161c68f106add54c4018a6e541be355f",
    "sha256:b1f7b4e099a9f48f3c26e181b8403577c183849450562df075e37459f3418b55",
    "sha256:7280b5cdfbbe881b136ec5c5a74e0baf8f92868382f139fe3772c3115b5e6b18",
    "sha256:23925a33300c5bace9bf0ea5729725c8779c2e6ac70f0a3290aaf2335daff1f2",
    "sha256:6bda73092281a4782bdf22990a05724cb6689eb6521e6002ce90c8a3649b68f8",
    "sha256:7f121f3dd6d394422c44dbe266e087428464c62344c4a4c38fa568d0fefa008f",
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
