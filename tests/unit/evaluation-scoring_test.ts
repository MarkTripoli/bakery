import { assert, assertEquals } from "@std/assert";
import {
  evaluateCheck,
  jsonDeepEqual,
  jsonSchemaSubsetDefect,
  validateJsonSchemaSubset,
} from "../../packages/contracts/src/evaluation-scoring.ts";

// #44 slice 2: the JSON-schema subset shared by the worker check and the
// server judge validation, and the deterministic check evaluator.

const bytes = (text: string) => new TextEncoder().encode(text);

const schema = {
  type: "object",
  required: ["verdict", "score"],
  properties: {
    verdict: { type: "string" },
    score: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
    nested: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  },
};

Deno.test("the subset validator accepts a value that satisfies type, required and properties", () => {
  assertEquals(
    validateJsonSchemaSubset(schema, { verdict: "good", score: 0.5, extra: 1 }),
    { ok: true },
  );
  assertEquals(
    validateJsonSchemaSubset(schema, {
      verdict: "good",
      score: 1,
      tags: ["a"],
      nested: { ok: true },
    }),
    { ok: true },
  );
});

Deno.test("the subset validator names each violation by path", () => {
  const missing = validateJsonSchemaSubset(schema, { verdict: "good" });
  assertEquals(missing, {
    ok: false,
    violations: [{ path: "/score", message: "is required" }],
  });
  const wrongType = validateJsonSchemaSubset(schema, { verdict: 1, score: 1 });
  assert(!wrongType.ok);
  assertEquals(wrongType.violations[0].path, "/verdict");
  const nested = validateJsonSchemaSubset(schema, {
    verdict: "x",
    score: 1,
    tags: ["a", 2],
    nested: {},
  });
  assert(!nested.ok);
  assertEquals(nested.violations.map((v) => v.path).sort(), [
    "/nested/ok",
    "/tags/1",
  ]);
  assert(!validateJsonSchemaSubset(schema, ["not", "an", "object"]).ok);
  assert(!validateJsonSchemaSubset(schema, null).ok);
});

Deno.test("integer, null and type lists follow JSON semantics", () => {
  assert(validateJsonSchemaSubset({ type: "integer" }, 3).ok);
  assert(!validateJsonSchemaSubset({ type: "integer" }, 3.5).ok);
  assert(validateJsonSchemaSubset({ type: ["string", "null"] }, null).ok);
  assert(!validateJsonSchemaSubset({ type: "number" }, Number.NaN).ok);
  assert(validateJsonSchemaSubset(true, { anything: 1 }).ok);
  assert(!validateJsonSchemaSubset(false, 1).ok);
});

Deno.test("a malformed schema is a defect, never a silent pass", () => {
  assertEquals(
    jsonSchemaSubsetDefect({ type: "date" }),
    "type must name JSON types",
  );
  assertEquals(
    jsonSchemaSubsetDefect({ required: "score" }),
    "required must be a list of property names",
  );
  assertEquals(
    jsonSchemaSubsetDefect("object"),
    "schema must be an object or a boolean",
  );
  assert(!validateJsonSchemaSubset({ type: "date" }, "2026-01-01").ok);
  assertEquals(jsonSchemaSubsetDefect(schema), null);
});

Deno.test("deep equality ignores key order and compares arrays by position", () => {
  assert(jsonDeepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert(!jsonDeepEqual([1, 2], [2, 1]));
  assert(!jsonDeepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert(!jsonDeepEqual(null, {}));
});

Deno.test("contains passes on the substring and fails with a reason otherwise", () => {
  const check = { kind: "contains" as const, config: { substring: "done" } };
  assertEquals(evaluateCheck(check, bytes("all done.")), {
    state: "passed",
    score: 1,
    reason: null,
  });
  assertEquals(evaluateCheck(check, bytes("not yet")), {
    state: "failed",
    score: 0,
    reason: "output does not contain the expected text",
  });
});

Deno.test("equals compares the parsed JSON output with config.expected", () => {
  const check = {
    kind: "equals" as const,
    config: { expected: { a: [1, 2] } },
  };
  assertEquals(evaluateCheck(check, bytes('{"a":[1,2]}')).state, "passed");
  assertEquals(evaluateCheck(check, bytes('{"a":[2,1]}')).state, "failed");
});

Deno.test("json_schema validates the parsed output against config.schema", () => {
  const check = { kind: "json_schema" as const, config: { schema } };
  assertEquals(
    evaluateCheck(check, bytes('{"verdict":"ok","score":1}')).state,
    "passed",
  );
  const failed = evaluateCheck(check, bytes('{"verdict":"ok"}'));
  assertEquals(failed.state, "failed");
  assertEquals(failed.score, 0);
  assert(failed.reason?.includes("/score is required"));
});

Deno.test("an unparseable output fails with a reason; an unusable check config is an error", () => {
  const jsonCheck = { kind: "json_schema" as const, config: { schema } };
  assertEquals(evaluateCheck(jsonCheck, bytes("{not json")), {
    state: "failed",
    score: 0,
    reason: "output is not valid JSON",
  });
  assertEquals(
    evaluateCheck(jsonCheck, new Uint8Array([0xff, 0xfe])).reason,
    "output is not valid UTF-8 text",
  );
  for (
    const check of [
      { kind: "contains" as const, config: { substring: "" } },
      { kind: "contains" as const, config: "done" },
      { kind: "equals" as const, config: {} },
      { kind: "json_schema" as const, config: { schema: { type: "date" } } },
    ]
  ) {
    const verdict = evaluateCheck(check, bytes("{}"));
    assertEquals(verdict.state, "error", JSON.stringify(check));
    assertEquals(verdict.score, null);
    assert(verdict.reason);
  }
});
