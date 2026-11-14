import { assertEquals } from "@std/assert";
import {
  MAX_REQUEST_JSON_DEPTH,
  unsafeRequestJson,
} from "../../packages/contracts/src/request-json.ts";

// A request body is checked for what the recursive schemas cannot survive and
// what the parser would silently drop, without recursion of its own (#36, QA on #364).

// `depth` objects inside one another around a scalar.
const nested = (depth: number, leaf: unknown = 1): unknown => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};
const nestedArrays = (depth: number): unknown => {
  let value: unknown = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
};

Deno.test("an ordinary body is fine, and so is one at the depth limit", () => {
  assertEquals(
    unsafeRequestJson({ a: 1, b: [1, 2, { c: "x" }], d: null }),
    null,
  );
  assertEquals(unsafeRequestJson({}), null);
  assertEquals(unsafeRequestJson([]), null);
  assertEquals(unsafeRequestJson("text"), null);
  assertEquals(unsafeRequestJson(null), null);
  assertEquals(unsafeRequestJson(7), null);
  assertEquals(MAX_REQUEST_JSON_DEPTH, 128);
  assertEquals(unsafeRequestJson(nested(MAX_REQUEST_JSON_DEPTH)), null);
  assertEquals(unsafeRequestJson(nestedArrays(MAX_REQUEST_JSON_DEPTH)), null);
  // Keys that merely look like it are fine.
  assertEquals(
    unsafeRequestJson({
      proto: 1,
      __proto: 2,
      proto__: 3,
      constructor: 4,
      prototype: 5,
    }),
    null,
  );
  // As a value it is just text.
  assertEquals(unsafeRequestJson({ ruleKey: "__proto__" }), null);
});

Deno.test("a body nested past the limit is refused however it is nested, at any size, without overflowing the stack", () => {
  assertEquals(
    unsafeRequestJson(nested(MAX_REQUEST_JSON_DEPTH + 1)),
    "too_deep",
  );
  assertEquals(
    unsafeRequestJson(nestedArrays(MAX_REQUEST_JSON_DEPTH + 1)),
    "too_deep",
  );
  // Mixed arrays and objects.
  let mixed: unknown = 1;
  for (let level = 0; level < MAX_REQUEST_JSON_DEPTH + 5; level += 1) {
    mixed = level % 2 === 0 ? [mixed] : { k: mixed };
  }
  assertEquals(unsafeRequestJson(mixed), "too_deep");
  // The depths that overflow a recursive validator, and far beyond.
  for (const depth of [2_000, 3_200, 5_000, 100_000, 1_000_000]) {
    assertEquals(unsafeRequestJson(nested(depth)), "too_deep", String(depth));
  }
  // Deep in one branch while another is shallow.
  assertEquals(
    unsafeRequestJson({
      shallow: { a: 1 },
      deep: nested(MAX_REQUEST_JSON_DEPTH + 2),
    }),
    "too_deep",
  );
});

Deno.test("a __proto__ key is refused at any depth, in objects inside arrays too", () => {
  const parsed = (text: string) => JSON.parse(text);
  assertEquals(
    unsafeRequestJson(parsed('{"__proto__":{"admin":true}}')),
    "proto_key",
  );
  assertEquals(unsafeRequestJson(parsed('{"__proto__":"x"}')), "proto_key");
  assertEquals(
    unsafeRequestJson(parsed('{"a":{"b":{"__proto__":1}}}')),
    "proto_key",
  );
  assertEquals(
    unsafeRequestJson(parsed('{"a":[{"x":1},{"__proto__":1}]}')),
    "proto_key",
  );
  assertEquals(unsafeRequestJson(parsed('[{"__proto__":null}]')), "proto_key");
  assertEquals(
    unsafeRequestJson(
      parsed('{"trigger":{"type":"event","filter":{"__proto__":"x"}}}'),
    ),
    "proto_key",
  );
  // A real prototype is not a key.
  assertEquals(unsafeRequestJson(Object.create({ __proto__: 1 })), null);
});

Deno.test("a NUL character is refused in any key or text, at any depth, however it was written", () => {
  const parsed = (text: string) => JSON.parse(text);
  for (
    const text of [
      '{"name":"bad\\u0000text"}',
      '{"name":"\\u0000"}',
      '{"a":{"b":["x","y\\u0000"]}}',
      '{"a\\u0000b":1}',
      '{"a":{"\\u0000":1}}',
      '{"inputs":{"deep":[[["\\u0000"]]]}}',
      '{"filter":{"k":"v\\u0000"}}',
    ]
  ) assertEquals(unsafeRequestJson(parsed(text)), "nul", text);
  assertEquals(unsafeRequestJson("a\u0000b"), "nul");
  assertEquals(unsafeRequestJson(["x\u0000"]), "nul");
  // Text that merely contains other control characters or an escaped backslash-zero is fine.
  assertEquals(
    unsafeRequestJson(
      parsed('{"a":"line\\nbreak\\ttab","b":"\\\\u0000","c":"\\u0001"}'),
    ),
    null,
  );
  assertEquals(
    unsafeRequestJson({ a: "\u200b zero width", b: "\ufffd" }),
    null,
  );
  // Depth and the other key still win where they apply.
  assertEquals(
    unsafeRequestJson(parsed('{"__proto__":"a\\u0000"}')),
    "proto_key",
  );
});
