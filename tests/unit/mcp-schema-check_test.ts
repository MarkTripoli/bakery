import { assertEquals } from "@std/assert";
import { checkAgainstSchema } from "../../apps/server/src/modules/mcp/schema-check.ts";

// #435 slice 2b: a tool call's arguments are checked against the input schema the
// tool declared when it was pinned, and only the first problem's pointer comes back.

const schema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 5 },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    mode: { enum: ["fast", "deep"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    nested: {
      type: "object",
      properties: { id: { type: ["string", "null"] } },
      required: ["id"],
    },
  },
  required: ["query"],
  additionalProperties: false,
};

Deno.test("arguments the schema accepts pass", () => {
  assertEquals(checkAgainstSchema(schema, { query: "hi" }), null);
  assertEquals(
    checkAgainstSchema(schema, {
      query: "hi",
      limit: 3,
      mode: "fast",
      tags: ["a"],
      nested: { id: null },
    }),
    null,
  );
});

Deno.test("each kind of mismatch names the place and never the value", () => {
  const cases: [unknown, string][] = [
    [{}, "/query"],
    [{ query: 5 }, "/query"],
    [{ query: "" }, "/query"],
    [{ query: "toolong" }, "/query"],
    [{ query: "a", limit: 1.5 }, "/limit"],
    [{ query: "a", limit: 11 }, "/limit"],
    [{ query: "a", mode: "slow" }, "/mode"],
    [{ query: "a", tags: ["a", "b", "c"] }, "/tags"],
    [{ query: "a", tags: [1] }, "/tags/0"],
    [{ query: "a", nested: {} }, "/nested/id"],
    [{ query: "a", extra: 1 }, "/extra"],
    ["not an object", ""],
  ];
  for (const [value, pointer] of cases) {
    assertEquals(
      checkAgainstSchema(schema, value),
      pointer,
      JSON.stringify(value),
    );
  }
});

Deno.test("an unknown keyword, a missing schema or a pointer-like key is not a reason to refuse or to fail", () => {
  assertEquals(checkAgainstSchema({ $ref: "#/x", format: "email" }, "x"), null);
  assertEquals(checkAgainstSchema(undefined, { a: 1 }), null);
  assertEquals(
    checkAgainstSchema({ type: "object", additionalProperties: false }, {
      "a/b": 1,
    }),
    "/a~1b",
  );
  assertEquals(
    checkAgainstSchema(
      { anyOf: [{ type: "string" }, { type: "integer" }] },
      true,
    ),
    "",
  );
  assertEquals(
    checkAgainstSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1),
    "",
  );
});
