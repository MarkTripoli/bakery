import { assertEquals, assertThrows } from "@std/assert";
import transport from "../../docs/technical-design/transport-schemas.json" with {
  type: "json",
};
import {
  assertKnownBounds,
  contractSchemas,
  generateContracts,
} from "../../packages/contracts/src/contracts.ts";

type Shaped = {
  shape: Record<string, { safeParse(value: unknown): { success: boolean } }>;
};

const field = (schema: string, name: string) =>
  (contractSchemas as unknown as Record<string, Shaped>)[schema].shape[name];

Deno.test("bounds spelled minimum and maximum are enforced like min and max", () => {
  const size = field("BlobUploadStart", "sizeBytes");
  assertEquals(size.safeParse(0).success, true);
  assertEquals(size.safeParse(5_368_709_120).success, true);
  assertEquals(size.safeParse(5_368_709_121).success, false);
  assertEquals(size.safeParse(-1).success, false);
  assertEquals(
    field("WorkerMaintenanceReport", "sequence").safeParse(0).success,
    false,
  );
  assertEquals(
    field("WorkerMaintenanceReport", "sequence").safeParse(1).success,
    true,
  );
});

Deno.test("a bound key the generator does not know is refused loudly", () => {
  const error = assertThrows(
    () => assertKnownBounds({ maximumm: 3 }, "Example.count"),
    Error,
  );
  assertEquals(error.message, "Example.count names an unknown bound: maximumm");
  assertKnownBounds(
    { min: 1, max: 2, minimum: 1, maximum: 2 },
    "Example.count",
  );
});

Deno.test("bounds declared beside a schema's fields are applied to those fields", () => {
  const entry = (contractSchemas as unknown as Record<string, Shaped>)
    .SkillFileManifestEntry.shape;
  assertEquals(entry.path.safeParse("a".repeat(501)).success, false);
  assertEquals(entry.sizeBytes.safeParse(10_485_761).success, false);
  const issue = (contractSchemas as unknown as Record<string, Shaped>)
    .ValidationIssue.shape;
  assertEquals(issue.path.safeParse("p".repeat(501)).success, false);
  assertEquals(issue.code.safeParse("c".repeat(101)).success, false);
  assertEquals(issue.message.safeParse("m".repeat(501)).success, false);
  const problem = (contractSchemas as unknown as Record<string, Shaped>)
    .Problem.shape;
  assertEquals(problem.title.safeParse("t".repeat(201)).success, false);
  assertEquals(problem.detail.safeParse("d".repeat(2001)).success, false);
  const capability = (contractSchemas as unknown as Record<string, Shaped>)
    .IntegrationCapability.shape;
  assertEquals(
    capability.requiredProviderPermissions.safeParse(
      Array.from({ length: 101 }, (_, index) => `p${index}`),
    ).success,
    false,
  );
});

Deno.test("a misspelled, unusable or misplaced bound stops generation", () => {
  type Field = { name: string; bounds: Record<string, unknown> };
  type Source = {
    inputs: Record<string, { fields: Field[] }>;
    outputs: Record<string, { bounds: Record<string, unknown> }>;
  };
  const withBound = (edit: (source: Source) => void) => {
    const source = structuredClone(transport) as unknown as Source;
    edit(source);
    return () => generateContracts(source as unknown as typeof transport);
  };
  const sizeBytes = (source: Source) =>
    source.inputs.BlobUploadStart.fields.find((field) =>
      field.name === "sizeBytes"
    )!;
  assertThrows(
    withBound((source) => {
      source.outputs.SkillFileManifestEntry.bounds.pathMaximumLenght = 5;
    }),
    Error,
    "names an unknown bound: pathMaximumLenght",
  );
  assertThrows(
    withBound((source) => {
      sizeBytes(source).bounds.maximum = "3";
    }),
    Error,
    "has an unusable value",
  );
  assertThrows(
    withBound((source) => {
      sizeBytes(source).bounds.maxLength = 3;
    }),
    Error,
    "does not apply to a number",
  );
});

Deno.test("unions, pages, the page envelope, plain strings and integers refuse bounds they cannot use", () => {
  type Loose = Record<string, Record<string, Record<string, unknown>>> & {
    pageEnvelope: Record<string, unknown>;
  };
  const generate = (edit: (source: Loose) => void) => () => {
    const source = structuredClone(transport) as unknown as Loose;
    edit(source);
    return generateContracts(source as unknown as typeof transport);
  };
  const inputField = (source: Loose, schema: string, name: string) =>
    (source.inputs[schema].fields as { name: string; bounds?: object }[])
      .find((field) => field.name === name)!;
  assertThrows(
    generate((source) => {
      source.outputs.WebSocketFrame.bounds = { framesMaxItemz: 3 };
    }),
    Error,
    "unknown bound: framesMaxItemz",
  );
  assertThrows(
    generate((source) => {
      source.outputs["Page<CoordinationPlan>"].bounds = { itemsMaxItemz: 3 };
    }),
    Error,
    "unknown bound: itemsMaxItemz",
  );
  assertThrows(
    generate((source) => {
      source.pageEnvelope.bounds = { cursorMaxLenght: 3 };
    }),
    Error,
    "unknown bound: cursorMaxLenght",
  );
  assertThrows(
    generate((source) => {
      inputField(source, "CoordinationPlanCreateFromWorkflow", "nodeId")
        .bounds = { max: 3 };
    }),
    Error,
    "does not apply to a string",
  );
  assertThrows(
    generate((source) => {
      inputField(source, "CoordinationPlanListQuery", "limit").bounds = {
        maxDepth: 3,
      };
    }),
    Error,
    "does not apply to a number",
  );
});

Deno.test("a decimal string keeps its declared range", () => {
  const budget = (contractSchemas as unknown as Record<string, Shaped>)
    .RunCreate.shape.budgetLimitUsd;
  assertEquals(budget.safeParse("200").success, true);
  assertEquals(budget.safeParse("200.01").success, false);
  assertEquals(budget.safeParse("-1").success, false);
});
