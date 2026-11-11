import { assert, assertEquals } from "@std/assert";
import {
  allocateStepKey,
  canonicalJson,
  compileWorkflowDocument as rawCompileWorkflowDocument,
  createDiagnosticCollector,
  createWorkflowCompilerCatalog,
  decodeWorkflowJson as rawDecodeWorkflowJson,
  expandStepKeys,
  isAssignable,
  isExactNumberText,
  literalMatches,
  parseDuration,
  parseStepKey,
  pointerOf,
  schemaToValueType,
  sha256Hex,
  snapshotWorkflowValue as rawSnapshotWorkflowValue,
  type ValueType,
  WORKFLOW_COMPILER_DIAGNOSTIC_CODES,
  WORKFLOW_COMPILER_LIMITS,
  WORKFLOW_COMPILER_MESSAGES,
  WorkflowCompilerInvariantError,
  WorkflowSemanticDocumentSchema,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  type ExpressionParseResult,
  parseWorkflowExpression as rawParseWorkflowExpression,
} from "../../packages/contracts/src/workflow-compiler/expression.ts";
import { parseReferenceText as rawParseReferenceText } from "../../packages/contracts/src/workflow-compiler/reference.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  arr,
  createDesignCatalog,
  designLimitFields,
  designSchemas,
  int,
  obj,
  str,
  uuid,
} from "../fixtures/workflow-compiler/design-catalog.ts";
import { specimenDefinition } from "../fixtures/workflow-compiler/specimen.ts";
import { WORKFLOW_ACTION_NAMES } from "../../packages/contracts/src/workflow-action-registry.ts";
import { canonicalJson as serverCanonicalJson } from "../../apps/server/src/platform/canonical-json.ts";

const exercisedCodes = new Set<string>();
const knownCodes: ReadonlySet<string> = new Set(
  WORKFLOW_COMPILER_DIAGNOSTIC_CODES,
);

function recordCodes<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) recordCodes(item, depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && knownCodes.has(record.code)) {
    exercisedCodes.add(record.code);
  }
  for (const key of ["diagnostics", "diagnostic", "error", "errors"]) {
    if (key in record) recordCodes(record[key], depth + 1);
  }
  return value;
}

const compileWorkflowDocument = (
  ...args: Parameters<typeof rawCompileWorkflowDocument>
) => rawCompileWorkflowDocument(...args).then((result) => recordCodes(result));
const decodeWorkflowJson = (
  ...args: Parameters<typeof rawDecodeWorkflowJson>
) => recordCodes(rawDecodeWorkflowJson(...args));
const snapshotWorkflowValue = (
  ...args: Parameters<typeof rawSnapshotWorkflowValue>
) => recordCodes(rawSnapshotWorkflowValue(...args));
const parseWorkflowExpression = (
  ...args: Parameters<typeof rawParseWorkflowExpression>
) => recordCodes(rawParseWorkflowExpression(...args));
const parseReferenceText = (
  ...args: Parameters<typeof rawParseReferenceText>
) => recordCodes(rawParseReferenceText(...args));

Deno.test("parseDuration converts bounded literals to milliseconds", () => {
  const table: [string, number | null][] = [
    ["0s", 0],
    ["500ms", 500],
    ["1s", 1_000],
    ["30m", 1_800_000],
    ["1800s", 1_800_000],
    ["24h", 86_400_000],
    ["1d", 86_400_000],
    ["999999d", 999_999 * 86_400_000],
    ["", null],
    ["1", null],
    ["01s", null],
    ["-1s", null],
    ["1.5s", null],
    ["1 s", null],
    ["1w", null],
    ["1000000s", null],
  ];
  for (const [text, expected] of table) {
    assertEquals(parseDuration(text), expected, text);
  }
  assertEquals(parseDuration(30), null);
  assertEquals(parseDuration("9".repeat(100)), null);
  assertEquals(WORKFLOW_COMPILER_LIMITS.durationMaxMs, 86_400_000);
});

Deno.test("pointerOf escapes segments and truncates at the first unsafe one", () => {
  assertEquals(pointerOf([]), "");
  assertEquals(
    pointerOf(["steps", 2, "with", "arguments"]),
    "/steps/2/with/arguments",
  );
  assertEquals(pointerOf(["steps", "bad key", "x"]), "/steps");
  assertEquals(pointerOf(["steps", -1]), "/steps");
  assertEquals(pointerOf(["steps", 1.5]), "/steps");
  assertEquals(pointerOf(["a/b"]), "");
  assertEquals(pointerOf(["a~b"]), "");
  assertEquals(pointerOf(["__proto__"]), "");
  assertEquals(
    pointerOf(["quality.check", "test:rails"]),
    "/quality.check/test:rails",
  );
  assertEquals(pointerOf(["x".repeat(65)]), "");
});

Deno.test("diagnostic collector dedupes and caps with a truncation marker", () => {
  const collector = createDiagnosticCollector();
  collector.add("/a", "field_invalid");
  collector.add("/a", "field_invalid");
  assertEquals(collector.size, 1);
  for (let index = 0; index < 200; index += 1) {
    collector.add(`/steps/${index}`, "field_unknown");
  }
  const list = collector.list();
  assertEquals(list.length, WORKFLOW_COMPILER_LIMITS.diagnostics + 1);
  assertEquals(list.at(-1)?.code, "diagnostics_truncated");
  assert(collector.truncated);
});

Deno.test("message table covers exactly the closed code set", () => {
  assertEquals(
    Object.keys(WORKFLOW_COMPILER_MESSAGES).sort(),
    [...WORKFLOW_COMPILER_DIAGNOSTIC_CODES].sort(),
  );
  assertEquals(
    new Set(WORKFLOW_COMPILER_DIAGNOSTIC_CODES).size,
    WORKFLOW_COMPILER_DIAGNOSTIC_CODES.length,
  );
});

Deno.test("decoder accepts JSON and rejects syntax errors with one diagnostic", () => {
  const ok = decodeWorkflowJson('{"b":[1,2,{"c":null}],"a":"x\\u0041\\n"}');
  assert(ok.ok);
  assertEquals(canonicalJson(ok.value), '{"a":"xA\\n","b":[1,2,{"c":null}]}');
  for (
    const text of [
      "",
      "{",
      '{"a":}',
      '{"a":1,}',
      "[1,]",
      "01",
      "-",
      "1x",
      "'a'",
      '{"a":1} x',
      '"\\q"',
      '"a\nb"',
      "tru",
    ]
  ) {
    const result = decodeWorkflowJson(text);
    assert(!result.ok, text);
    assertEquals(
      result.diagnostics[0]?.code,
      "definition_syntax_invalid",
      text,
    );
  }
});

Deno.test("decoder rejects duplicate members at the container", () => {
  const result = decodeWorkflowJson('{"steps":[{"id":"aa","id":"bb"}]}');
  assert(!result.ok);
  assertEquals(result.diagnostics, [{
    path: "/steps/0",
    code: "definition_duplicate_key",
    message: WORKFLOW_COMPILER_MESSAGES.definition_duplicate_key,
  }]);
  const root = decodeWorkflowJson('{"a":1,"a":2}');
  assert(!root.ok);
  assertEquals(root.diagnostics[0]?.path, "");
});

Deno.test("number exactness table", () => {
  const accepted = [
    "0",
    "-0",
    "1",
    "1.0",
    "1e0",
    "1E0",
    "-1.5",
    "0.1",
    "1e5",
    "100",
    "0.30000000000000004",
    "9007199254740991",
  ];
  for (const token of accepted) assert(isExactNumberText(token), token);
  const rejected = [
    "9007199254740993",
    "1.00000000000000001",
    "0.1000000000000000055511151231257827",
    "1e999",
    "-",
    "01",
    ".5",
    "1.",
    "+1",
    "0".repeat(65),
    "1".repeat(65),
    "",
  ];
  for (const token of rejected) assert(!isExactNumberText(token), token);
});

Deno.test("decoder and snapshot reject non-exact and non-safe numbers", () => {
  for (
    const text of [
      "9007199254740993",
      "1.00000000000000001",
      "9007199254740992",
      "1e300",
      "[" + "1".repeat(65) + "]",
    ]
  ) {
    const result = decodeWorkflowJson(text);
    assert(!result.ok, text);
    assertEquals(
      result.diagnostics[0]?.code,
      "definition_number_invalid",
      text,
    );
  }
  const same = [
    decodeWorkflowJson("1"),
    decodeWorkflowJson("1.0"),
    decodeWorkflowJson("1e0"),
  ];
  for (const entry of same) {
    assert(entry.ok);
    assertEquals(entry.value, 1);
  }
  const zero = decodeWorkflowJson("-0");
  assert(zero.ok);
  assert(Object.is(zero.value, 0));
  const snapshot = snapshotWorkflowValue({ n: 2 ** 53 });
  assert(!snapshot.ok);
  assertEquals(snapshot.diagnostics[0], {
    path: "/n",
    code: "definition_number_invalid",
    message: WORKFLOW_COMPILER_MESSAGES.definition_number_invalid,
  });
  const negativeZero = snapshotWorkflowValue([-0]);
  assert(negativeZero.ok);
  assert(Object.is((negativeZero.value as number[])[0], 0));
});

Deno.test("snapshot rejects non-JSON values with fixed diagnostics", () => {
  const cases: unknown[] = [
    { a: undefined },
    { a: 1n },
    { a: () => 1 },
    { a: Symbol("x") },
    { a: Number.NaN },
    { a: Infinity },
    { a: new Date(0) },
    { a: new Map() },
    [, 1],
  ];
  for (const input of cases) {
    const result = snapshotWorkflowValue(input);
    assert(!result.ok);
    assertEquals(result.diagnostics[0]?.code, "definition_value_unsupported");
  }
});

Deno.test("snapshot returns a frozen null-prototype copy", () => {
  const source = { a: [1, { b: "x" }], c: null };
  const result = snapshotWorkflowValue(source);
  assert(result.ok);
  const value = result.value as Record<string, unknown>;
  assertEquals(Object.getPrototypeOf(value), null);
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.a));
  assert(value !== source);
  assertEquals(canonicalJson(value), canonicalJson(source));
});

Deno.test("snapshot reports at the nearest safe ancestor and honours opaque containers", () => {
  const unsafe = snapshotWorkflowValue({
    steps: [{ with: { "bad key": 2 ** 60 } }],
  });
  assert(!unsafe.ok);
  assertEquals(unsafe.diagnostics[0]?.path, "/steps/0/with");
  const opaque = snapshotWorkflowValue(
    { steps: [{ with: { arguments: { name: 2 ** 60 } } }] },
    { opaqueAt: (segments) => segments.at(-1) === "arguments" },
  );
  assert(!opaque.ok);
  assertEquals(opaque.diagnostics[0]?.path, "/steps/0/with/arguments");
});

Deno.test("size and value count ceilings", () => {
  const big = decodeWorkflowJson(JSON.stringify("x".repeat(100_001)));
  assert(!big.ok);
  assertEquals(big.diagnostics[0]?.code, "definition_too_large");
  const many = snapshotWorkflowValue(Array.from({ length: 20_001 }, () => 0));
  assert(!many.ok);
  assertEquals(many.diagnostics[0]?.code, "definition_too_many_values");
  const manyText = decodeWorkflowJson(
    `[${Array.from({ length: 20_001 }, () => "0").join(",")}]`,
  );
  assert(!manyText.ok);
  assertEquals(manyText.diagnostics[0]?.code, "definition_too_many_values");
  const multibyte = snapshotWorkflowValue({ a: "é".repeat(60_000) });
  assert(!multibyte.ok);
  assertEquals(multibyte.diagnostics[0]?.code, "definition_too_large");
});

Deno.test("canonical JSON equals the server helper", async () => {
  const fixtures: unknown[] = [
    null,
    true,
    0,
    -1.5,
    "é \n",
    [],
    {},
    { b: 1, a: { d: [3, 2, 1], c: null } },
    { z: [{ y: 1, x: 2 }], a: undefined },
    { "ä": 1, "a": 2, "Z": 3, "10": 4, "9": 5 },
  ];
  for (const fixture of fixtures) {
    assertEquals(canonicalJson(fixture), serverCanonicalJson(fixture));
  }
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("semantic document schema accepts a minimal document", () => {
  const parsed = WorkflowSemanticDocumentSchema.safeParse({
    compilerVersion: 1,
    registryVersion: 1,
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: {},
    limits: { wallClockMs: 86_400_000, maxAttempts: 1000 },
    agents: {},
    steps: [{
      kind: "action",
      id: "noop",
      needs: [],
      action: "workflow.noop",
      with: { kind: "literal", value: {} },
      requires: [],
      timeoutMs: 1_800_000,
      retry: { maxAttempts: 1, backoffMs: 0, on: [] },
    }],
  });
  assert(parsed.success);
  assert(
    !WorkflowSemanticDocumentSchema.safeParse({ kind: "workflow" }).success,
  );
});

function astOf(text: string): unknown {
  const result = parseWorkflowExpression(text);
  assert(result.ok, `${text} -> ${JSON.stringify(result)}`);
  return result.ast;
}

function codeOf(text: unknown): string {
  const result: ExpressionParseResult = parseWorkflowExpression(text);
  assert(!result.ok, JSON.stringify(result));
  return result.diagnostic.code;
}

const ref = (name: string) => ({ kind: "ref", root: "input", path: [name] });
const lit = (value: string | number | boolean | null) => ({
  kind: "literal",
  value,
});

Deno.test("expression precedence and associativity table", () => {
  const a = ref("a");
  const b = ref("b");
  const c = ref("c");
  // && binds tighter than ||.
  assertEquals(
    astOf("$input.a || $input.b && $input.c"),
    {
      kind: "logical",
      op: "or",
      left: a,
      right: { kind: "logical", op: "and", left: b, right: c },
    },
  );
  // Both connectives are left associative.
  assertEquals(astOf("$input.a && $input.b && $input.c"), {
    kind: "logical",
    op: "and",
    left: { kind: "logical", op: "and", left: a, right: b },
    right: c,
  });
  assertEquals(astOf("$input.a || $input.b || $input.c"), {
    kind: "logical",
    op: "or",
    left: { kind: "logical", op: "or", left: a, right: b },
    right: c,
  });
  // ! binds looser than comparison and applies to the whole comparison.
  assertEquals(astOf("!$input.a == 1"), {
    kind: "not",
    operand: { kind: "compare", op: "eq", left: a, right: lit(1) },
  });
  assertEquals(astOf("!!$input.a"), {
    kind: "not",
    operand: { kind: "not", operand: a },
  });
  assertEquals(astOf("!$input.a && $input.b"), {
    kind: "logical",
    op: "and",
    left: { kind: "not", operand: a },
    right: b,
  });
  // Comparison binds tighter than &&.
  assertEquals(astOf("$input.a == 1 && $input.b != 2"), {
    kind: "logical",
    op: "and",
    left: { kind: "compare", op: "eq", left: a, right: lit(1) },
    right: { kind: "compare", op: "ne", left: b, right: lit(2) },
  });
  const operators: [string, string][] = [
    ["==", "eq"],
    ["!=", "ne"],
    ["<", "lt"],
    ["<=", "le"],
    [">", "gt"],
    [">=", "ge"],
  ];
  for (const [symbol, op] of operators) {
    assertEquals(astOf(`$input.a ${symbol} 3`), {
      kind: "compare",
      op,
      left: a,
      right: lit(3),
    });
  }
  assertEquals(astOf('$input.a in ["x", 2, true, null]'), {
    kind: "compare",
    op: "in",
    left: a,
    right: {
      kind: "list",
      items: [lit("x"), lit(2), lit(true), lit(null)],
    },
  });
  assertEquals(astOf("$input.a in []"), {
    kind: "compare",
    op: "in",
    left: a,
    right: { kind: "list", items: [] },
  });
});

Deno.test("parentheses override precedence and redundant ones vanish", () => {
  assertEquals(
    astOf("($input.a || $input.b) && $input.c"),
    {
      kind: "logical",
      op: "and",
      left: {
        kind: "logical",
        op: "or",
        left: ref("a"),
        right: ref("b"),
      },
      right: ref("c"),
    },
  );
  const canonical = astOf("$input.a == 1 && !$input.b");
  for (
    const variant of [
      "  $input.a==1&&!$input.b ",
      "($input.a == 1) && (!$input.b)",
      "((($input.a) == (1))) && ((!($input.b)))",
      "\t$input.a\n==\r1 && ! $input.b",
    ]
  ) {
    assertEquals(astOf(variant), canonical, variant);
  }
  // The comparison operand stays a distinct grouped node.
  assertEquals(
    astOf("($input.a && $input.b) == true"),
    {
      kind: "compare",
      op: "eq",
      left: { kind: "logical", op: "and", left: ref("a"), right: ref("b") },
      right: lit(true),
    },
  );
});

Deno.test("comparison is non-associative", () => {
  assertEquals(codeOf("$input.a == 1 == 2"), "expression_syntax_invalid");
  assertEquals(codeOf("1 < 2 < 3"), "expression_syntax_invalid");
  assertEquals(codeOf("$input.a in [1] in [2]"), "expression_syntax_invalid");
  // Explicit grouping is accepted.
  assert(parseWorkflowExpression("($input.a == 1) == true").ok);
});

Deno.test("expression literals are exact JSON scalars", () => {
  assertEquals(astOf('"a\\u0041\\n\\"b"'), lit('aA\n"b'));
  assertEquals(astOf("-0"), lit(0));
  assertEquals(astOf("1.0"), lit(1));
  assertEquals(astOf("1e2"), lit(100));
  assertEquals(astOf("-12.5E-1"), lit(-1.25));
  assertEquals(astOf("true"), lit(true));
  assertEquals(astOf("false"), lit(false));
  assertEquals(astOf("null"), lit(null));
  // A quoted reference is a string, not a reference.
  assertEquals(astOf('"$input.x"'), lit("$input.x"));
  assertEquals(astOf("$step.a.b.c"), {
    kind: "ref",
    root: "step",
    path: ["a", "b", "c"],
  });
  assertEquals(astOf("$repeat.currentCandidate"), {
    kind: "ref",
    root: "repeat",
    path: ["currentCandidate"],
  });
});

Deno.test("every expression code is reachable", () => {
  const cases: [unknown, string][] = [
    ["", "expression_syntax_invalid"],
    ["   ", "expression_syntax_invalid"],
    [42, "expression_syntax_invalid"],
    [null, "expression_syntax_invalid"],
    ["$input.a &&", "expression_syntax_invalid"],
    ["&& $input.a", "expression_syntax_invalid"],
    ["$input.a $input.b", "expression_syntax_invalid"],
    ["($input.a", "expression_syntax_invalid"],
    ["$input.a)", "expression_syntax_invalid"],
    ["$input.a & $input.b", "expression_syntax_invalid"],
    ["$input.a = 1", "expression_syntax_invalid"],
    ["$input.a == 'x'", "expression_syntax_invalid"],
    ['"unterminated', "expression_syntax_invalid"],
    ['"bad\\q"', "expression_syntax_invalid"],
    ['"bad\\u12"', "expression_syntax_invalid"],
    ['"tab\t"', "expression_syntax_invalid"],
    ["truthy", "expression_syntax_invalid"],
    ["True", "expression_syntax_invalid"],
    ["undefined", "expression_syntax_invalid"],
    ["01", "expression_syntax_invalid"],
    ["1.", "expression_syntax_invalid"],
    ["-", "expression_syntax_invalid"],
    ["1a", "expression_syntax_invalid"],
    ["+1", "expression_syntax_invalid"],
    ["0x10", "expression_syntax_invalid"],
    ["\u00a0true", "expression_syntax_invalid"],
    ["[1,]", "expression_syntax_invalid"],
    ["[1 2]", "expression_syntax_invalid"],
    ["[$input.a]", "expression_syntax_invalid"],
    ["[[1]]", "expression_syntax_invalid"],
    ["[1", "expression_syntax_invalid"],
    ["fn($input.a)", "expression_syntax_invalid"],
    ["$input.a.b()", "expression_syntax_invalid"],
    ["`x`", "expression_syntax_invalid"],
    ["1".repeat(1025), "expression_too_long"],
    [`${"(".repeat(33)}true${")".repeat(33)}`, "expression_too_deep"],
    ["!".repeat(33) + "true", "expression_too_deep"],
    [
      Array.from({ length: 70 }, () => "true").join(" && "),
      "expression_too_many_nodes",
    ],
    [
      `$input.a in [${Array.from({ length: 33 }, () => "1").join(",")}]`,
      "expression_list_too_long",
    ],
    ["9007199254740993", "expression_number_invalid"],
    ["1.00000000000000001", "expression_number_invalid"],
    ["1e999", "expression_number_invalid"],
    ["1".repeat(65), "expression_number_invalid"],
    ["$input", "reference_malformed"],
    ["$input.", "reference_malformed"],
    ["$input..a", "reference_malformed"],
    ["$input.1a", "reference_malformed"],
    ["$.a", "reference_malformed"],
    ["$", "reference_malformed"],
    [
      `$input.${Array.from({ length: 33 }, () => "a").join(".")}`,
      "reference_malformed",
    ],
    ["$bogus.a", "reference_root_unknown"],
    ["$Input.a", "reference_root_unknown"],
    ["$secret.a", "reference_secret_forbidden"],
    ["$secrets.a", "reference_secret_forbidden"],
    ["$secretToken.a", "reference_secret_forbidden"],
    ["$env.HOME", "reference_secret_forbidden"],
    ["$vault.key", "reference_secret_forbidden"],
  ];
  for (const [input, expected] of cases) {
    const text = typeof input === "string" && input.length > 60
      ? `${input.slice(0, 20)}...`
      : String(input);
    assertEquals(codeOf(input), expected, text);
  }
  // Boundaries that are still accepted.
  assert(
    parseWorkflowExpression(
      `${"(".repeat(32)}true${")".repeat(32)}`,
    ).ok,
  );
  assert(parseWorkflowExpression("!".repeat(32) + "true").ok);
  assert(
    parseWorkflowExpression(
      `$input.a in [${Array.from({ length: 32 }, () => "1").join(",")}]`,
    ).ok,
  );
  assert(parseWorkflowExpression("1".repeat(64)).ok === false);
  assert(parseWorkflowExpression(" ".repeat(1023) + "1").ok);
});

Deno.test("expression diagnostics carry fixed prose and work counters", () => {
  const result = parseWorkflowExpression("$input.a &&");
  assert(!result.ok);
  assertEquals(
    result.diagnostic.message,
    WORKFLOW_COMPILER_MESSAGES.expression_syntax_invalid,
  );
  assert(result.work.tokens >= 3);
  const good = parseWorkflowExpression("$input.a == 1");
  assert(good.ok);
  assertEquals(good.work, { tokens: 4, nodes: 3, maxDepth: 0 });
});

Deno.test("parseReferenceText reads whole reference tokens", () => {
  assertEquals(parseReferenceText("$step.repair.outcome"), {
    ok: true,
    root: "step",
    path: ["repair", "outcome"],
  });
  assertEquals(parseReferenceText("input.a"), {
    ok: false,
    code: "reference_malformed",
  });
  assertEquals(parseReferenceText("$task.status"), {
    ok: true,
    root: "task",
    path: ["status"],
  });
  assertEquals(parseReferenceText("$input.a b"), {
    ok: false,
    code: "reference_malformed",
  });
});

// ---------------------------------------------------------------------------
// Phase 4: shape, identifiers, tagged values, normalization and digest.
// ---------------------------------------------------------------------------

type Def = Record<string, unknown>;

const AGENT = "22222222-2222-4222-8222-222222222222";

const noop = (id: string): Def => ({ id, uses: "workflow.noop" });

/** A well-typed artifact reference for `planArtifact`-style inputs. */
const ARTIFACT: Def = {
  artifactId: "11111111-1111-4111-8111-111111111111",
  versionId: "33333333-3333-4333-8333-333333333333",
  sha256: "a".repeat(64),
};

function workflow(steps: unknown[], extra: Def = {}): Def {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: {
      repositoryId: { type: "uuid", required: true },
      target: { type: "string", required: true },
    },
    steps,
    ...extra,
  };
}

function repeatNode(extra: Def = {}, body: Def = {}): Def {
  return {
    id: "fix",
    repeat: {
      max: 2,
      seed: { currentCandidate: { done: false } },
      until: "$repeat.currentCandidate.done == true",
      steps: [noop("try_one")],
      outputs: { currentCandidate: { done: false } },
      ...body,
    },
    ...extra,
  };
}

function parallelNode(extra: Def = {}, body: Def = {}): Def {
  return {
    id: "fan",
    parallel: {
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      branches: [
        { id: "lane_a", repository: "main", steps: [noop("work_a")] },
        { id: "lane_b", repository: "main", steps: [noop("work_b")] },
      ],
      ...body,
    },
    ...extra,
  };
}

function branchNode(extra: Def = {}, body: Def = {}): Def {
  return {
    id: "choose",
    branch: {
      when: '$input.target == "prod"',
      then: [noop("on_prod")],
      else: [noop("on_dev")],
      ...body,
    },
    ...extra,
  };
}

/** Drops `undefined` members so builders can omit fields by setting them. */
function plain(definition: unknown): unknown {
  return typeof definition === "string"
    ? definition
    : JSON.parse(JSON.stringify(definition));
}

async function diagnose(
  definition: unknown,
): Promise<{ path: string; code: string }[]> {
  const result = await compileWorkflowDocument(plain(definition));
  assert(!result.ok, "expected the definition to be rejected");
  return result.diagnostics.map(({ path, code }) => ({ path, code }));
}

async function accepted(definition: unknown) {
  const result = await compileWorkflowDocument(plain(definition));
  assert(
    result.ok,
    result.ok ? "" : JSON.stringify(result.diagnostics),
  );
  return result;
}

type Case = [string, unknown, { path: string; code: string }[]];

async function runCases(cases: Case[]): Promise<void> {
  for (const [name, definition, expected] of cases) {
    assertEquals(await diagnose(definition), expected, name);
  }
}

Deno.test("a minimal workflow normalizes with defaults applied", async () => {
  const result = await accepted(workflow([noop("first")]));
  assertEquals(result.document.compilerVersion, 1);
  assertEquals(result.document.limits, {
    wallClockMs: 86_400_000,
    maxAttempts: 1000,
  });
  assertEquals(result.document.agents, {});
  const [step] = result.document.steps;
  assertEquals(step?.kind, "action");
  if (step?.kind === "action") {
    assertEquals(step.timeoutMs, 1_800_000);
    assertEquals(step.retry, { maxAttempts: 1, backoffMs: 0, on: [] });
    assertEquals(step.needs, []);
    assertEquals(step.with, { kind: "literal", value: {} });
  }
  assert(WorkflowSemanticDocumentSchema.safeParse(result.document).success);
  assertEquals(
    result.digest,
    await sha256Hex(serverCanonicalJson(result.document)),
  );
});

Deno.test("root and structural diagnostics carry exact paths", async () => {
  await runCases([
    ["non-object root", [], [{ path: "", code: "field_invalid" }]],
    [
      "wrong apiVersion",
      { ...workflow([noop("first")]), apiVersion: "other/v1" },
      [{ path: "", code: "workflow_version_unsupported" }],
    ],
    [
      "wrong kind",
      { ...workflow([noop("first")]), kind: "task" },
      [{ path: "", code: "workflow_version_unsupported" }],
    ],
    [
      "unknown root field",
      { ...workflow([noop("first")]), bogus: 1 },
      [{ path: "", code: "field_unknown" }],
    ],
    [
      "missing steps",
      { apiVersion: "bakery.dev/v1", kind: "workflow" },
      [{ path: "", code: "field_missing" }],
    ],
    [
      "steps not an array",
      workflow([]) && { ...workflow([]), steps: {} },
      [{ path: "/steps", code: "field_invalid" }],
    ],
    [
      "empty steps",
      workflow([]),
      [{ path: "/steps", code: "field_invalid" }],
    ],
    [
      "step not an object",
      workflow(["x"]),
      [{ path: "/steps/0", code: "field_invalid" }],
    ],
    [
      "step without a kind",
      workflow([{ id: "first" }]),
      [{ path: "/steps/0", code: "node_kind_invalid" }],
    ],
    [
      "step with two kinds",
      workflow([{ id: "first", uses: "workflow.noop", steps: [noop("x")] }]),
      [{ path: "/steps/0", code: "node_kind_invalid" }],
    ],
    [
      "unknown node field",
      workflow([{ ...noop("first"), bogus: 1 }]),
      [{ path: "/steps/0", code: "field_unknown" }],
    ],
    [
      "field not valid for the kind",
      workflow([{ ...branchNode(), with: {} }]),
      [{ path: "/steps/0", code: "field_unknown" }],
    ],
    [
      "missing node id",
      workflow([{ uses: "workflow.noop" }]),
      [{ path: "/steps/0", code: "field_missing" }],
    ],
    [
      "cancel policy",
      { ...workflow([noop("first")]), cancel: "never" },
      [{ path: "/cancel", code: "field_invalid" }],
    ],
    [
      "unregistered action",
      workflow([{ id: "first", uses: "made.up" }]),
      [{ path: "/steps/0/uses", code: "action_unknown" }],
    ],
    [
      "action name not a string",
      workflow([{ id: "first", uses: 1 }]),
      [{ path: "/steps/0/uses", code: "field_invalid" }],
    ],
    [
      "with not an object",
      workflow([{ ...noop("first"), with: "x" }]),
      [{ path: "/steps/0/with", code: "field_invalid" }],
    ],
  ]);
});

Deno.test("identifier diagnostics cover invalid, duplicate, reserved, depth and count", async () => {
  await runCases([
    [
      "uppercase id",
      workflow([noop("First")]),
      [{ path: "/steps/0/id", code: "node_id_invalid" }],
    ],
    [
      "id too short",
      workflow([noop("a")]),
      [{ path: "/steps/0/id", code: "node_id_invalid" }],
    ],
    [
      "non-string id",
      workflow([{ id: 4, uses: "workflow.noop" }]),
      [{ path: "/steps/0/id", code: "node_id_invalid" }],
    ],
    [
      "duplicate top-level ids",
      workflow([noop("first"), noop("first")]),
      [{ path: "/steps/1/id", code: "node_id_duplicate" }],
    ],
    [
      "duplicate across branch arms",
      workflow([
        branchNode({}, { then: [noop("same")], else: [noop("same")] }),
      ]),
      [{ path: "/steps/0/branch/else/0/id", code: "node_id_duplicate" }],
    ],
    [
      "seed and body steps share a namespace",
      workflow([
        repeatNode({}, {
          seed: {
            steps: [noop("shared")],
            outputs: { currentCandidate: "$step.fix.shared.out" },
          },
          steps: [noop("shared")],
        }),
      ]),
      [{ path: "/steps/0/repeat/steps/0/id", code: "node_id_duplicate" }],
    ],
    [
      "duplicate lane ids",
      workflow([
        parallelNode({}, {
          branches: [
            { id: "lane_a", repository: "main", steps: [noop("work_a")] },
            { id: "lane_a", repository: "main", steps: [noop("work_b")] },
          ],
        }),
      ]),
      [{
        path: "/steps/0/parallel/branches/1/id",
        code: "node_id_duplicate",
      }],
    ],
    [
      "repeat body id iterations",
      workflow([repeatNode({}, { steps: [noop("iterations")] })]),
      [{ path: "/steps/0/repeat/steps/0/id", code: "node_id_reserved" }],
    ],
    [
      "repeat seed id outcome",
      workflow([
        repeatNode({}, {
          seed: {
            steps: [noop("outcome")],
            outputs: { currentCandidate: "$step.fix.outcome.out" },
          },
        }),
      ]),
      [{
        path: "/steps/0/repeat/seed/steps/0/id",
        code: "node_id_reserved",
      }],
    ],
  ]);
  await accepted(workflow([
    parallelNode({}, {
      branches: [
        { id: "lane_a", repository: "main", steps: [noop("work")] },
        { id: "lane_b", repository: "main", steps: [noop("work")] },
      ],
    }),
  ]));

  let nested: Def = noop("leaf");
  for (let level = 0; level < 9; level += 1) {
    nested = { id: `level${level}`, steps: [nested] };
  }
  assertEquals(
    await diagnose(workflow([nested])),
    [{
      path: "/steps/0" + "/steps/0".repeat(8),
      code: "node_depth_exceeded",
    }],
  );
  let allowed: Def = noop("leaf");
  for (let level = 0; level < 7; level += 1) {
    allowed = { id: `level${level}`, steps: [allowed] };
  }
  await accepted(workflow([allowed]));

  const many = Array.from(
    { length: 201 },
    (_, index) => ({ ...noop(`step${index}`), timeout: "1s" }),
  );
  assertEquals(await diagnose(workflow(many)), [{
    path: "/steps",
    code: "node_count_exceeded",
  }]);
  await accepted(workflow(many.slice(0, 200)));
});

Deno.test("workflow inputs reject bad names, types and secrets at the container", async () => {
  const withInputs = (inputs: unknown) => ({
    ...workflow([noop("first")]),
    inputs,
  });
  await runCases([
    [
      "name outside the key pattern",
      withInputs({ "Bad-Name": { type: "string", required: true } }),
      [{ path: "/inputs", code: "input_name_invalid" }],
    ],
    [
      "secret-named input",
      withInputs({ dbPassword: { type: "string", required: true } }),
      [{ path: "/inputs", code: "input_secret_forbidden" }],
    ],
    [
      "api key input",
      withInputs({ apiKey: { type: "string", required: true } }),
      [{ path: "/inputs", code: "input_secret_forbidden" }],
    ],
    [
      "unsupported type",
      withInputs({ blob: { type: "object", required: true } }),
      [{ path: "/inputs/blob/type", code: "input_type_unsupported" }],
    ],
    [
      "unknown input field",
      withInputs({
        target: { type: "string", required: true, description: "x" },
      }),
      [{ path: "/inputs/target", code: "field_unknown" }],
    ],
    [
      "required must be explicit",
      withInputs({ target: { type: "string" } }),
      [{ path: "/inputs/target", code: "field_missing" }],
    ],
    [
      "inputs not an object",
      withInputs([]),
      [{ path: "/inputs", code: "field_invalid" }],
    ],
    [
      "bad enum",
      withInputs({ target: { type: "string", required: true, enum: [] } }),
      [{ path: "/inputs/target/enum", code: "field_invalid" }],
    ],
  ]);
  const enumerated = await accepted(
    withInputs({ mode: { type: "string", required: false, enum: ["a", "b"] } }),
  );
  assertEquals(enumerated.document.inputs["mode"]?.enum, ["a", "b"]);
});

Deno.test("limits, durations, agents and step agent versions", async () => {
  const withLimits = (limits: unknown) => ({
    ...workflow([noop("first")]),
    limits,
  });
  await runCases([
    [
      "wallClock below the minimum",
      withLimits({ wallClock: "500ms" }),
      [{ path: "/limits/wallClock", code: "duration_invalid" }],
    ],
    [
      "wallClock above the ceiling",
      withLimits({ wallClock: "25h" }),
      [{ path: "/limits/wallClock", code: "timeout_exceeds_ceiling" }],
    ],
    [
      "wallClock malformed",
      withLimits({ wallClock: 30 }),
      [{ path: "/limits/wallClock", code: "duration_invalid" }],
    ],
    [
      "maxCostUsd negative",
      withLimits({ maxCostUsd: -1 }),
      [{ path: "/limits/maxCostUsd", code: "limits_invalid" }],
    ],
    [
      "maxAttempts zero",
      withLimits({ maxAttempts: 0 }),
      [{ path: "/limits/maxAttempts", code: "limits_invalid" }],
    ],
    [
      "maxRepairCycles above eight",
      withLimits({ maxRepairCycles: 9 }),
      [{ path: "/limits/maxRepairCycles", code: "limits_invalid" }],
    ],
    [
      "unknown limits field",
      withLimits({ description: "x" }),
      [{ path: "/limits", code: "field_unknown" }],
    ],
    [
      "limits not an object",
      withLimits("x"),
      [{ path: "/limits", code: "field_invalid" }],
    ],
    [
      "agents with an unknown action",
      { ...workflow([noop("first")]), agents: { "made.up": AGENT } },
      [{ path: "/agents", code: "action_unknown" }],
    ],
    [
      "agents with a non-uuid version",
      { ...workflow([noop("first")]), agents: { "rpi.research": "nope" } },
      [{ path: "/agents/rpi.research", code: "agent_binding_invalid" }],
    ],
    [
      "agents not an object",
      { ...workflow([noop("first")]), agents: [] },
      [{ path: "/agents", code: "field_invalid" }],
    ],
    [
      "step agentVersionId",
      workflow([{ ...noop("first"), agentVersionId: AGENT }]),
      [{
        path: "/steps/0/agentVersionId",
        code: "step_agent_version_forbidden",
      }],
    ],
    [
      "timeout 0s",
      workflow([{ ...noop("first"), timeout: "0s" }]),
      [{ path: "/steps/0/timeout", code: "duration_invalid" }],
    ],
    [
      "timeout 500ms",
      workflow([{ ...noop("first"), timeout: "500ms" }]),
      [{ path: "/steps/0/timeout", code: "duration_invalid" }],
    ],
    [
      "timeout 25h",
      workflow([{ ...noop("first"), timeout: "25h" }]),
      [{ path: "/steps/0/timeout", code: "timeout_exceeds_ceiling" }],
    ],
    [
      "backoff above one hour",
      workflow([{
        ...{ id: "check", uses: "quality.check" },
        retry: { maxAttempts: 2, backoff: "2h" },
      }]),
      [{ path: "/steps/0/retry/backoff", code: "timeout_exceeds_ceiling" }],
    ],
  ]);
  const ok = await accepted({
    ...workflow([{
      id: "check",
      uses: "quality.check",
      retry: { maxAttempts: 2, backoff: "0s", on: ["DEPENDENCY_TIMEOUT"] },
    }]),
    agents: { "rpi.research": AGENT.toUpperCase(), "harness.implement": AGENT },
    limits: { wallClock: "2h" },
  });
  assertEquals(ok.document.agents["rpi.research"], AGENT);
  assertEquals(ok.document.limits.wallClockMs, 7_200_000);
  const [step] = ok.document.steps;
  if (step?.kind === "action") {
    assertEquals(step.retry, {
      maxAttempts: 2,
      backoffMs: 0,
      on: ["DEPENDENCY_TIMEOUT"],
    });
  }
});

Deno.test("action fields: requires, checks, limits, retry and needs", async () => {
  const check = (extra: Def): Def => ({
    id: "check",
    uses: "quality.check",
    ...extra,
  });
  await runCases([
    [
      "unknown capability",
      workflow([check({ requires: ["telepathy"] })]),
      [{ path: "/steps/0/requires", code: "action_requires_invalid" }],
    ],
    [
      "duplicate capability",
      workflow([check({ requires: ["git", "git"] })]),
      [{ path: "/steps/0/requires", code: "action_requires_invalid" }],
    ],
    [
      "duplicate check",
      workflow([check({ checks: ["lint", "lint"] })]),
      [{ path: "/steps/0/checks", code: "action_checks_invalid" }],
    ],
    [
      "checks not a list",
      workflow([check({ checks: "lint" })]),
      [{ path: "/steps/0/checks", code: "field_invalid" }],
    ],
    [
      "limit key not known",
      workflow([check({ limits: { maxEverything: 1 } })]),
      [{ path: "/steps/0/limits", code: "field_unknown" }],
    ],
    [
      "maxFindings out of range",
      workflow([check({ limits: { maxFindings: 1001 } })]),
      [{ path: "/steps/0/limits/maxFindings", code: "action_limits_invalid" }],
    ],
    [
      "maxCostUsd negative",
      workflow([check({ limits: { maxCostUsd: -1 } })]),
      [{ path: "/steps/0/limits/maxCostUsd", code: "action_limits_invalid" }],
    ],
    [
      "maxDuration bad",
      workflow([check({ limits: { maxDuration: "0s" } })]),
      [{ path: "/steps/0/limits/maxDuration", code: "duration_invalid" }],
    ],
    [
      "retry not an object",
      workflow([check({ retry: 3 })]),
      [{ path: "/steps/0/retry", code: "retry_invalid" }],
    ],
    [
      "retry attempts zero",
      workflow([check({ retry: { maxAttempts: 0 } })]),
      [{ path: "/steps/0/retry/maxAttempts", code: "retry_invalid" }],
    ],
    [
      "retry attempts above the registry",
      workflow([check({ retry: { maxAttempts: 3 } })]),
      [{ path: "/steps/0/retry/maxAttempts", code: "retry_exceeds_registry" }],
    ],
    [
      "retry fault outside the registry",
      workflow([check({ retry: { on: ["DEPENDENCY_UNAVAILABLE"] } })]),
      [{ path: "/steps/0/retry/on", code: "retry_fault_unsupported" }],
    ],
    [
      "retry fault duplicated",
      workflow([
        check({ retry: { on: ["DEPENDENCY_TIMEOUT", "DEPENDENCY_TIMEOUT"] } }),
      ]),
      [{ path: "/steps/0/retry/on", code: "retry_invalid" }],
    ],
    [
      "retry unknown key",
      workflow([check({ retry: { forever: true } })]),
      [{ path: "/steps/0/retry", code: "field_unknown" }],
    ],
    [
      "needs not a list",
      workflow([check({ needs: "other" })]),
      [{ path: "/steps/0/needs", code: "needs_invalid" }],
    ],
    [
      "needs with duplicates",
      workflow([check({ needs: ["aa", "aa"] })]),
      [{ path: "/steps/0/needs", code: "needs_invalid" }],
    ],
    [
      "needs with a non-string",
      workflow([check({ needs: [1] })]),
      [{ path: "/steps/0/needs", code: "needs_invalid" }],
    ],
  ]);
  const ok = await accepted(workflow([
    noop("aa"),
    noop("zz"),
    check({
      needs: ["zz", "aa"],
      requires: ["shell", "git"],
      checks: ["test", "lint"],
      limits: { maxDuration: "10m", maxFindings: 5 },
    }),
  ]));
  const step = ok.document.steps[2];
  if (step?.kind === "action") {
    assertEquals(step.needs, ["aa", "zz"]);
    assertEquals(step.requires, ["browser", "git", "shell"]);
    assertEquals(step.checks, ["lint", "test"]);
    assertEquals(step.timeoutMs, 600_000);
    assertEquals(step.limits, { maxDurationMs: 600_000, maxFindings: 5 });
  }
});

Deno.test("tagged values: references, literals, escapes and ambiguity", async () => {
  const withValue = (value: unknown, key = "a") =>
    workflow([{ ...noop("first"), with: { [key]: value } }]);
  await runCases([
    [
      "reference with text around it",
      withValue("x $input.target"),
      [{ path: "/steps/0/with", code: "value_reference_ambiguous" }],
    ],
    [
      "reserved token in a plain string",
      withValue("see $step.x"),
      [{ path: "/steps/0/with", code: "value_reference_ambiguous" }],
    ],
    [
      "reserved token in a list",
      withValue(["ok", "a $secret b"]),
      [{ path: "/steps/0/with", code: "value_reference_ambiguous" }],
    ],
    [
      "unknown $ key",
      withValue({ $oops: 1 }),
      [{ path: "/steps/0/with", code: "literal_reserved_key" }],
    ],
    [
      "$literal beside another key",
      withValue({ $literal: 1, other: 2 }),
      [{ path: "/steps/0/with", code: "literal_reserved_key" }],
    ],
    [
      "bare dollar",
      withValue("$"),
      [{ path: "/steps/0/with", code: "reference_malformed" }],
    ],
    [
      "reference without a path",
      withValue("$input"),
      [{ path: "/steps/0/with", code: "reference_malformed" }],
    ],
    [
      "reference with a bad segment",
      withValue("$input.a-b"),
      [{ path: "/steps/0/with", code: "reference_malformed" }],
    ],
    [
      "unknown root",
      withValue("$bogus.a"),
      [{ path: "/steps/0/with", code: "reference_root_unknown" }],
    ],
    [
      "secret root",
      withValue("$secret.token"),
      [{ path: "/steps/0/with", code: "reference_secret_forbidden" }],
    ],
    [
      "env root",
      withValue("$env.HOME"),
      [{ path: "/steps/0/with", code: "reference_secret_forbidden" }],
    ],
    [
      "vault root",
      withValue("$vault.key"),
      [{ path: "/steps/0/with", code: "reference_secret_forbidden" }],
    ],
    [
      "reference nested under a deeper object",
      withValue({ inner: { deep: "$bogus.a" } }),
      [{ path: "/steps/0/with", code: "reference_root_unknown" }],
    ],
    [
      "object holding a reference needs field-name keys",
      withValue({ "bad key": 1, ok: "$input.target" }),
      [{ path: "/steps/0/with", code: "field_invalid" }],
    ],
  ]);

  const result = await accepted(workflow([{
    ...noop("first"),
    with: {
      ref: "$input.target",
      text: "plain text",
      escaped: { $literal: "$input.target" },
      free: { "any key!": [1, "two"] },
      mixed: { list: ["$input.target", 3], field: { $literal: { $x: 1 } } },
    },
  }]));
  const [step] = result.document.steps;
  if (step?.kind !== "action") throw new Error("expected an action");
  assertEquals(step.with.kind, "object");
  if (step.with.kind !== "object") return;
  assertEquals(step.with.fields["ref"], {
    kind: "ref",
    root: "input",
    path: ["target"],
  });
  assertEquals(step.with.fields["text"], {
    kind: "literal",
    value: "plain text",
  });
  assertEquals(step.with.fields["escaped"], {
    kind: "literal",
    value: "$input.target",
  });
  assertEquals(step.with.fields["free"], {
    kind: "literal",
    value: { "any key!": [1, "two"] },
  });
  assertEquals(step.with.fields["mixed"]?.kind, "object");
});

Deno.test("effect keys need a reference part and bounded literal parts", async () => {
  const withKey = (effectKey: unknown) =>
    workflow([{ id: "merge", uses: "delivery.merge", effectKey }]);
  await runCases([
    [
      "literal-only key",
      withKey(["merge", "static"]),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "single literal",
      withKey("merge"),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "uppercase literal part",
      withKey(["Merge", "$input.repositoryId"]),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "non-string part",
      withKey(["merge", 1, "$input.repositoryId"]),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "empty list",
      withKey([]),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "too many parts",
      withKey(Array.from({ length: 9 }, () => "$input.repositoryId")),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
    [
      "secret reference part",
      withKey(["merge", "$secret.key"]),
      [{ path: "/steps/0/effectKey", code: "reference_secret_forbidden" }],
    ],
    [
      "interpolated part",
      withKey(["merge", "x-$input.repositoryId"]),
      [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
    ],
  ]);
  const single = await accepted(withKey("$input.repositoryId"));
  const list = await accepted(
    withKey(["merge", "$input.repositoryId", "$input.repositoryId"]),
  );
  const [one] = single.document.steps;
  const [many] = list.document.steps;
  if (one?.kind === "action") {
    assertEquals(one.effectKey, {
      kind: "effect_key",
      parts: [{ kind: "ref", root: "input", path: ["repositoryId"] }],
    });
  }
  if (many?.kind === "action") assertEquals(many.effectKey?.parts.length, 3);
});

Deno.test("conditions compile to data nodes and report parser codes", async () => {
  await runCases([
    [
      "if with a syntax error",
      workflow([{ ...noop("first"), if: "$input.target ==" }]),
      [{ path: "/steps/0/if", code: "expression_syntax_invalid" }],
    ],
    [
      "if that is not a string",
      workflow([{ ...noop("first"), if: true }]),
      [{ path: "/steps/0/if", code: "expression_syntax_invalid" }],
    ],
    [
      "if with an unknown reference root",
      workflow([{ ...noop("first"), if: "$nope.x == 1" }]),
      [{ path: "/steps/0/if", code: "reference_root_unknown" }],
    ],
    [
      "if too long",
      workflow([{ ...noop("first"), if: "1 == 1" + " ".repeat(2000) }]),
      [{ path: "/steps/0/if", code: "expression_too_long" }],
    ],
    [
      "branch without when",
      workflow([branchNode({}, { when: undefined })].map((node) => {
        const branch = { ...(node["branch"] as Def) };
        delete branch["when"];
        return { ...node, branch };
      })),
      [{ path: "/steps/0/branch", code: "field_missing" }],
    ],
    [
      "repeat until syntax",
      workflow([repeatNode({}, { until: "(" })]),
      [{ path: "/steps/0/repeat/until", code: "expression_syntax_invalid" }],
    ],
  ]);
  const ok = await accepted(
    workflow([{ ...noop("first"), if: '$input.target == "a"' }]),
  );
  const [step] = ok.document.steps;
  assertEquals(step?.if, {
    kind: "compare",
    op: "eq",
    left: { kind: "ref", root: "input", path: ["target"] },
    right: { kind: "literal", value: "a" },
  });
});

Deno.test("repeat: seed forms, outputs and max", async () => {
  const seedCases: Case[] = [
    [
      "mixed seed forms",
      workflow([
        repeatNode({}, {
          seed: {
            currentCandidate: "$input.target",
            steps: [noop("s")],
            outputs: { currentCandidate: "x" },
          },
        }),
      ]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "extra seed key",
      workflow([
        repeatNode({}, {
          seed: { currentCandidate: "$input.target", other: 1 },
        }),
      ]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "empty seed",
      workflow([repeatNode({}, { seed: {} })]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "seed not an object",
      workflow([repeatNode({}, { seed: "x" })]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "sequence seed with empty steps",
      workflow([
        repeatNode({}, {
          seed: { steps: [], outputs: { currentCandidate: "x" } },
        }),
      ]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "sequence seed with extra outputs",
      workflow([
        repeatNode({}, {
          seed: {
            steps: [noop("s")],
            outputs: { currentCandidate: "x", more: 1 },
          },
        }),
      ]),
      [{ path: "/steps/0/repeat/seed", code: "repeat_seed_invalid" }],
    ],
    [
      "repeat outputs with extra key",
      workflow([
        repeatNode({}, { outputs: { currentCandidate: "x", other: 1 } }),
      ]),
      [{ path: "/steps/0/repeat/outputs", code: "repeat_outputs_invalid" }],
    ],
    [
      "repeat outputs missing",
      workflow([repeatNode({}, { outputs: undefined })]),
      [{ path: "/steps/0/repeat/outputs", code: "repeat_outputs_invalid" }],
    ],
    [
      "repeat outputs with the wrong name",
      workflow([repeatNode({}, { outputs: { candidate: "x" } })]),
      [{ path: "/steps/0/repeat/outputs", code: "repeat_outputs_invalid" }],
    ],
    [
      "max zero",
      workflow([repeatNode({}, { max: 0 })]),
      [{ path: "/steps/0/repeat/max", code: "repeat_max_invalid" }],
    ],
    [
      "max nine",
      workflow([repeatNode({}, { max: 9 })]),
      [{ path: "/steps/0/repeat/max", code: "repeat_max_invalid" }],
    ],
    [
      "max fractional",
      workflow([repeatNode({}, { max: 1.5 })]),
      [{ path: "/steps/0/repeat/max", code: "repeat_max_invalid" }],
    ],
    [
      "unknown repeat key",
      workflow([repeatNode({}, { forever: true })]),
      [{ path: "/steps/0/repeat", code: "field_unknown" }],
    ],
  ];
  await runCases(seedCases);
  const mapping = await accepted(workflow([repeatNode()]));
  const sequence = await accepted(workflow([
    repeatNode({}, {
      seed: {
        steps: [noop("seed_one")],
        outputs: { currentCandidate: "$step.fix.seed_one.out" },
      },
    }),
  ]));
  const [mapped] = mapping.document.steps;
  const [sequenced] = sequence.document.steps;
  if (mapped?.kind === "repeat") assertEquals(mapped.seed.form, "mapping");
  if (sequenced?.kind === "repeat") {
    assertEquals(sequenced.seed.form, "sequence");
  }
  assert(mapping.digest !== sequence.digest);
});

Deno.test("branch outputs and export-name conflicts", async () => {
  await runCases([
    [
      "branch output name not matching the pattern",
      workflow([branchNode({}, { outputs: { "Bad-Name": { then: "x" } } })]),
      [{ path: "/steps/0/branch/outputs", code: "output_name_invalid" }],
    ],
    [
      "branch output without arms",
      workflow([branchNode({}, { outputs: { picked: {} } })]),
      [{
        path: "/steps/0/branch/outputs/picked",
        code: "branch_outputs_invalid",
      }],
    ],
    [
      "branch output unknown arm key",
      workflow([branchNode({}, { outputs: { picked: { both: 1 } } })]),
      [
        { path: "/steps/0/branch/outputs/picked", code: "field_unknown" },
        {
          path: "/steps/0/branch/outputs/picked",
          code: "branch_outputs_invalid",
        },
      ],
    ],
    [
      "branch without then",
      workflow([{
        id: "choose",
        branch: { when: "$input.target == 1", else: [noop("x1")] },
      }]),
      [{ path: "/steps/0/branch", code: "field_missing" }],
    ],
    [
      "branch output named like an arm child",
      workflow([
        branchNode({}, {
          then: [noop("picked")],
          outputs: { picked: { then: "$step.choose.picked.x" } },
        }),
      ]),
      [{
        path: "/steps/0/branch/outputs/picked",
        code: "output_name_conflict",
      }],
    ],
    [
      "branch output named like an else-arm child",
      workflow([
        branchNode({}, {
          else: [noop("picked")],
          outputs: { picked: { then: "x" } },
        }),
      ]),
      [{
        path: "/steps/0/branch/outputs/picked",
        code: "output_name_conflict",
      }],
    ],
    [
      "lane export named like a lane child",
      workflow([
        parallelNode({}, {
          branches: [
            { id: "lane_a", repository: "main", steps: [noop("result")] },
            { id: "lane_b", repository: "main", steps: [noop("work_b")] },
          ],
          outputs: { lane_a: { result: "$step.fan.lane_a.result.x" } },
        }),
      ]),
      [{
        path: "/steps/0/parallel/outputs/lane_a/result",
        code: "output_name_conflict",
      }],
    ],
    [
      "lane export name invalid",
      workflow([
        parallelNode({}, { outputs: { lane_a: { "Bad Name": "x" } } }),
      ]),
      [{
        path: "/steps/0/parallel/outputs/lane_a",
        code: "output_name_invalid",
      }],
    ],
    [
      "outputs keyed by a non-lane",
      workflow([parallelNode({}, { outputs: { lane_c: { result: "x" } } })]),
      [{
        path: "/steps/0/parallel/outputs",
        code: "parallel_lanes_invalid",
      }],
    ],
    [
      "outputs keyed by an invalid id",
      workflow([
        parallelNode({}, { outputs: { "Bad Lane": { result: "x" } } }),
      ]),
      [{
        path: "/steps/0/parallel/outputs",
        code: "parallel_lanes_invalid",
      }],
    ],
  ]);
  const ok = await accepted(workflow([
    branchNode({}, {
      outputs: { picked: { then: "$step.choose.on_prod.x" } },
    }),
    parallelNode({}, {
      outputs: { lane_a: { result: "$step.fan.lane_a.work_a.x" } },
    }),
  ]));
  const [branch] = ok.document.steps;
  if (branch?.kind === "branch") {
    assertEquals(Object.keys(branch.outputs), ["picked"]);
    assertEquals(branch.outputs["picked"]?.else, undefined);
  }
});

Deno.test("wait and parallel shapes", async () => {
  const waitNode = (wait: unknown): Def => ({ id: "pause", wait });
  const lane = (id: string, extra: Def = {}): Def => ({
    id,
    repository: "main",
    steps: [noop(`work_${id}`)],
    ...extra,
  });
  await runCases([
    [
      "wait with neither form",
      workflow([waitNode({})]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
    [
      "wait with both forms",
      workflow([waitNode({ duration: "1m", event: "question.answered" })]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
    [
      "wait not an object",
      workflow([waitNode("1m")]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
    [
      "wait duration with extra key",
      workflow([waitNode({ duration: "1m", timeout: "1m" })]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
    [
      "event wait without timeout",
      workflow([waitNode({ event: "question.answered" })]),
      [{ path: "/steps/0/wait", code: "wait_timeout_required" }],
    ],
    [
      "event name invalid",
      workflow([waitNode({ event: "Bad Event!", timeout: "1h" })]),
      [{ path: "/steps/0/wait/event", code: "wait_shape_invalid" }],
    ],
    [
      "event wait with an extra key",
      workflow([waitNode({ event: "question.answered", timeout: "1h", x: 1 })]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
    [
      "wait duration below minimum",
      workflow([waitNode({ duration: "100ms" })]),
      [{ path: "/steps/0/wait/duration", code: "duration_invalid" }],
    ],
    [
      "wait timeout above ceiling",
      workflow([waitNode({ event: "question.answered", timeout: "2d" })]),
      [{ path: "/steps/0/wait/timeout", code: "timeout_exceeds_ceiling" }],
    ],
    [
      "parallel without join",
      workflow([parallelNode({}, { join: undefined })]),
      [{ path: "/steps/0/parallel/join", code: "parallel_join_required" }],
    ],
    [
      "parallel with another join",
      workflow([parallelNode({}, { join: "any" })]),
      [{ path: "/steps/0/parallel/join", code: "parallel_join_required" }],
    ],
    [
      "parallel without failure policy",
      workflow([parallelNode({}, { failurePolicy: undefined })]),
      [{
        path: "/steps/0/parallel/failurePolicy",
        code: "parallel_failure_policy_required",
      }],
    ],
    [
      "parallel concurrency zero",
      workflow([parallelNode({}, { maxConcurrency: 0 })]),
      [{
        path: "/steps/0/parallel/maxConcurrency",
        code: "parallel_concurrency_invalid",
      }],
    ],
    [
      "parallel concurrency above the lane count",
      workflow([parallelNode({}, { maxConcurrency: 3 })]),
      [{
        path: "/steps/0/parallel/maxConcurrency",
        code: "parallel_concurrency_invalid",
      }],
    ],
    [
      "parallel without lanes",
      workflow([parallelNode({}, { branches: [] })]),
      [
        { path: "/steps/0/parallel/branches", code: "parallel_lanes_invalid" },
      ],
    ],
    [
      "parallel with nine lanes",
      workflow([
        parallelNode({}, {
          maxConcurrency: 1,
          branches: Array.from(
            { length: 9 },
            (_, index) => lane(`lane_${index}`),
          ),
        }),
      ]),
      [
        { path: "/steps/0/parallel/branches", code: "parallel_lanes_invalid" },
      ],
    ],
    [
      "lane without a repository",
      workflow([
        parallelNode({}, {
          branches: [lane("lane_a", { repository: undefined }), lane("lane_b")],
        }),
      ]),
      [{
        path: "/steps/0/parallel/branches/0/repository",
        code: "lane_repository_invalid",
      }],
    ],
    [
      "lane with a bad repository alias",
      workflow([
        parallelNode({}, {
          branches: [
            lane("lane_a"),
            lane("lane_b", { repository: "Main Repo" }),
          ],
        }),
      ]),
      [{
        path: "/steps/0/parallel/branches/1/repository",
        code: "lane_repository_invalid",
      }],
    ],
    [
      "lane with an unknown field",
      workflow([
        parallelNode({}, {
          branches: [lane("lane_a", { bogus: 1 }), lane("lane_b")],
        }),
      ]),
      [{ path: "/steps/0/parallel/branches/0", code: "field_unknown" }],
    ],
    [
      "lane without steps",
      workflow([
        parallelNode({}, {
          branches: [lane("lane_a", { steps: undefined }), lane("lane_b")],
        }),
      ]),
      [{ path: "/steps/0/parallel/branches/0", code: "field_missing" }],
    ],
    [
      "lane needs not a list",
      workflow([
        parallelNode({}, {
          branches: [lane("lane_a", { needs: "lane_b" }), lane("lane_b")],
        }),
      ]),
      [{ path: "/steps/0/parallel/branches/0/needs", code: "needs_invalid" }],
    ],
    [
      "unknown parallel key",
      workflow([parallelNode({}, { sneaky: 1 })]),
      [{ path: "/steps/0/parallel", code: "field_unknown" }],
    ],
  ]);
  const ok = await accepted(workflow([
    waitNode({ event: "question.answered", timeout: "1h" }),
    { id: "short", wait: { duration: "90s" } },
    parallelNode({}, {
      branches: [lane("lane_a"), lane("lane_b", { needs: ["lane_a"] })],
    }),
  ]));
  const [event, short] = ok.document.steps;
  if (event?.kind === "wait") {
    assertEquals(event.wait, {
      kind: "event",
      event: "question.answered",
      timeoutMs: 3_600_000,
    });
  }
  if (short?.kind === "wait") {
    assertEquals(short.wait, { kind: "duration", durationMs: 90_000 });
  }
});

Deno.test("presentation keys are stripped only at the root, node and lane levels", async () => {
  const presentation = {
    name: "n",
    description: "d",
    label: "l",
    layout: { x: 1 },
    ui: { y: 2 },
    position: { x: 3 },
  };
  const plain = await accepted(workflow([
    noop("first"),
    parallelNode(),
  ]));
  const decorated = await accepted({
    ...workflow([
      { ...noop("first"), ...presentation },
      parallelNode(presentation, {
        branches: [
          {
            id: "lane_a",
            repository: "main",
            steps: [{ ...noop("work_a"), ...presentation }],
            ...presentation,
          },
          { id: "lane_b", repository: "main", steps: [noop("work_b")] },
        ],
      }),
    ]),
    name: "w",
    description: "d",
    layout: { z: 1 },
    ui: {},
  });
  assertEquals(plain.digest, decorated.digest);
  // `label` and `position` are not root presentation keys.
  await runCases([
    [
      "label at the root",
      { ...workflow([noop("first")]), label: "x" },
      [{ path: "", code: "field_unknown" }],
    ],
    [
      "name inside limits",
      { ...workflow([noop("first")]), limits: { name: "x" } },
      [{ path: "/limits", code: "field_unknown" }],
    ],
    [
      "description inside a repeat body",
      workflow([repeatNode({}, { description: "x" })]),
      [{ path: "/steps/0/repeat", code: "field_unknown" }],
    ],
    [
      "layout inside a wait",
      workflow([{ id: "pause", wait: { duration: "1m", layout: 1 } }]),
      [{ path: "/steps/0/wait", code: "wait_shape_invalid" }],
    ],
  ]);
  // Inside value positions the same names are data, never stripped.
  const withData = await accepted(workflow([{
    ...noop("first"),
    with: { arguments: { description: "a", name: "b", layout: 1 } },
  }]));
  const [step] = withData.document.steps;
  if (step?.kind === "action") {
    assertEquals(step.with, {
      kind: "literal",
      value: { arguments: { description: "a", name: "b", layout: 1 } },
    });
  }
});

Deno.test("JSON text input is decoded with duplicate rejection", async () => {
  const text = JSON.stringify(workflow([noop("first")]));
  assert((await compileWorkflowDocument(text)).ok);
  const duplicated = text.replace(
    '"kind":"workflow"',
    '"kind":"workflow","kind":"workflow"',
  );
  assertEquals(await diagnose(duplicated), [{
    path: "",
    code: "definition_duplicate_key",
  }]);
  assertEquals(await diagnose("{"), [{
    path: "",
    code: "definition_syntax_invalid",
  }]);
});

Deno.test("semantic document digest ignores key order and pins a fixture", async () => {
  const definition = workflow([
    { ...noop("first"), with: { b: 2, a: 1 } },
    repeatNode(),
  ]);
  const reversed = JSON.parse(JSON.stringify(definition), (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).reverse());
    }
    return value;
  });
  const left = await accepted(definition);
  const right = await accepted(reversed);
  assertEquals(left.digest, right.digest);
  assertEquals(
    left.digest,
    await sha256Hex(canonicalJson(left.document)),
  );
  assertEquals(
    left.digest,
    "6898ca7fa046345f6baab59d1397207f01ccf2e42693b80effa7be28a0a80802",
  );
});

Deno.test("the compiler invariant error is a distinct error type", () => {
  const error = new WorkflowCompilerInvariantError("x");
  assert(error instanceof Error);
  assertEquals(error.name, "WorkflowCompilerInvariantError");
});

// ---------------------------------------------------------------------------
// Phase 5a: catalog, value types and action resolution.
// ---------------------------------------------------------------------------

Deno.test("JSON Schema subset converts to value types", () => {
  const convert = (schema: unknown) => schemaToValueType(schema);
  assertEquals(convert(uuid()), {
    kind: "string",
    format: "uuid",
    constraints: { pattern: "^[0-9a-f-]{36}$" },
  });
  assertEquals(convert({ type: "integer", minimum: 1 }), {
    kind: "number",
    integer: true,
    constraints: { minimum: 1 },
  });
  assertEquals(convert({ type: "boolean" }), { kind: "boolean" });
  assertEquals(convert({ type: "string", enum: ["a", "b"] })?.kind, "string");
  assertEquals(convert({ const: "x" }), { kind: "string", enum: ["x"] });
  assertEquals(convert({ anyOf: [{ type: "string" }, { type: "null" }] }), {
    kind: "nullable",
    inner: { kind: "string" },
  });
  assertEquals(convert({ type: ["integer", "null"] }), {
    kind: "nullable",
    inner: { kind: "number", integer: true },
  });
  assertEquals(
    convert(
      (designSchemas["IntegrationActionInput"] as {
        properties: Record<string, unknown>;
      }).properties["arguments"],
    ),
    { kind: "json" },
  );
  assertEquals(convert({ type: "number", const: 1 }), {
    kind: "number",
    integer: false,
    constraints: { const: 1 },
  });
  assertEquals(convert({ type: "boolean", const: true }), {
    kind: "boolean",
  });
  // Non-uuid formats are runtime-only constraints, not subtypes.
  assertEquals(convert({ type: "string", format: "date-time" }), {
    kind: "string",
    constraints: { format: "date-time" },
  });
});

Deno.test("unsupported schema constructs stay unresolved instead of widening", () => {
  const cases: [string, unknown][] = [
    ["empty schema", {}],
    ["non-object", "string"],
    ["open object", { type: "object", properties: {} }],
    ["record object", {
      type: "object",
      additionalProperties: { type: "string" },
    }],
    ["ref", { $ref: "#/$defs/x" }],
    ["allOf", { allOf: [{ type: "string" }] }],
    ["numeric enum", { type: "number", enum: [1, 2] }],
    ["array without items", { type: "array" }],
    ["heterogeneous union", {
      anyOf: [{ type: "string" }, { type: "boolean" }],
    }],
    ["both anyOf and oneOf", {
      anyOf: [{ type: "string" }],
      oneOf: [{ type: "string" }],
    }],
    ["required name missing", {
      type: "object",
      properties: {},
      required: ["a"],
      additionalProperties: false,
    }],
    ["unknown type", { type: "tuple" }],
  ];
  for (const [name, schema] of cases) {
    assertEquals(schemaToValueType(schema), undefined, name);
  }
  let deep: unknown = { type: "string" };
  for (let index = 0; index < 40; index += 1) {
    deep = { type: "array", items: deep };
  }
  assertEquals(schemaToValueType(deep), undefined, "depth bound");
});

Deno.test("identical-shape unions collapse and differing shapes do not", () => {
  const repair = schemaToValueType(designSchemas["RepairInput"]);
  assertEquals(repair?.kind, "object");
  if (repair?.kind === "object") {
    assertEquals([...repair.fields.keys()].sort(), [
      "currentCandidate",
      "failedCheckIds",
      "findings",
      "repositoryId",
    ]);
    // The differing minItems bounds are runtime-only and dropped; equal
    // bounds survive.
    const findings = repair.fields.get("findings")?.type;
    assertEquals(findings?.kind, "list");
    assertEquals(
      (findings as { constraints?: unknown } | undefined)?.constraints,
      { maxItems: 1000 },
    );
  }
  const different = {
    anyOf: [obj({ a: str() }), obj({ a: int() })],
  };
  assertEquals(schemaToValueType(different), undefined);
  const renamed = { anyOf: [obj({ a: str() }), obj({ b: str() })] };
  assertEquals(schemaToValueType(renamed), undefined);
  const optionality = {
    anyOf: [obj({ a: str() }), obj({ a: str() }, [])],
  };
  assertEquals(schemaToValueType(optionality), undefined);
});

Deno.test("a catalog pattern that is not valid regex still resolves", () => {
  const broken = "([unclosed";
  assertEquals(
    (() => {
      try {
        new RegExp(broken);
        return "valid";
      } catch {
        return "invalid";
      }
    })(),
    "invalid",
  );
  const type = schemaToValueType({ type: "string", pattern: broken });
  assertEquals(type, { kind: "string", constraints: { pattern: broken } });
});

Deno.test("assignability and literal checks never coerce", () => {
  const uuidType = schemaToValueType(uuid()) as ValueType;
  const stringType: ValueType = { kind: "string" };
  const intType: ValueType = { kind: "number", integer: true };
  const numberType: ValueType = { kind: "number", integer: false };
  assert(isAssignable(uuidType, stringType));
  assert(!isAssignable(stringType, uuidType));
  assert(isAssignable(intType, numberType));
  assert(!isAssignable(numberType, intType));
  assert(!isAssignable(stringType, numberType));
  assert(isAssignable(stringType, { kind: "json" }));
  assert(!isAssignable({ kind: "json" }, stringType));
  assert(
    isAssignable({ kind: "null" }, { kind: "nullable", inner: stringType }),
  );
  assert(!isAssignable({ kind: "nullable", inner: stringType }, stringType));
  assert(
    isAssignable(stringType, { kind: "nullable", inner: stringType }),
  );
  assert(
    isAssignable(
      { kind: "list", item: uuidType },
      { kind: "list", item: stringType },
    ),
  );
  assert(literalMatches("11111111-1111-4111-8111-111111111111", uuidType));
  assert(!literalMatches("not-a-uuid", uuidType));
  assert(!literalMatches(7, uuidType));
  assert(literalMatches(3, intType));
  assert(!literalMatches(3.5, intType));
  assert(literalMatches(null, { kind: "nullable", inner: stringType }));
  assert(!literalMatches("x", { kind: "string", enum: ["a"] }));
  const closed = schemaToValueType(obj({ a: str(), b: int() }, ["a"]))!;
  assert(literalMatches({ a: "x" }, closed));
  assert(!literalMatches({ b: 1 }, closed));
  assert(!literalMatches({ a: "x", c: 1 }, closed));
});

Deno.test("the design catalog resolves every registered action", () => {
  const catalog = createDesignCatalog();
  for (const name of WORKFLOW_ACTION_NAMES) {
    assert(catalog.resolveAction(name), name);
  }
  assertEquals(catalog.resolveAction("not.registered"), undefined);
  assertEquals(catalog.resolveAction("__proto__"), undefined);
  assertEquals(catalog.limitFields("review.independent"), [
    "maxDuration",
    "maxCostUsd",
    "maxFindings",
  ]);
  assertEquals(catalog.limitFields("__proto__"), []);
  assertEquals(catalog.event("question.answered")?.payload?.kind, "object");
  assertEquals(catalog.event("constructor"), undefined);
  assertEquals(catalog.task()?.kind, "object");
});

const CHECK = {
  id: "verify",
  uses: "quality.check",
  with: { repositoryId: "$input.repositoryId", revision: "abc123" },
  checks: ["lint", "test"],
};

async function diagnoseWith(
  definition: unknown,
  catalog = createDesignCatalog(),
): Promise<{ path: string; code: string }[]> {
  const result = await compileWorkflowDocument(plain(definition), { catalog });
  assert(!result.ok, "expected the definition to be rejected");
  return result.diagnostics.map(({ path, code }) => ({ path, code }));
}

Deno.test("every Phase 5a code reports its exact path", async () => {
  const cases: [string, unknown, { path: string; code: string }[]][] = [
    [
      "unknown check name against the design set",
      workflow([{ ...CHECK, checks: ["lint", "mystery"] }]),
      [{ path: "/steps/0/checks/1", code: "action_checks_invalid" }],
    ],
    [
      "checks on an action whose input has no checks field",
      workflow([{
        id: "build",
        uses: "harness.implement",
        with: {
          repositoryId: "$input.repositoryId",
          planArtifact: ARTIFACT,
        },
        checks: ["lint"],
      }]),
      [{ path: "/steps/0/checks", code: "action_checks_unsupported" }],
    ],
    [
      "maxFindings on an action that does not allow it",
      workflow([{ ...CHECK, limits: { maxFindings: 5 } }]),
      [{ path: "/steps/0/limits/maxFindings", code: "action_limits_invalid" }],
    ],
    [
      "maxCostUsd above the workflow ceiling",
      workflow([{ ...CHECK, limits: { maxCostUsd: 20 } }], {
        limits: { maxCostUsd: 10 },
      }),
      [
        { path: "/steps/0/limits/maxCostUsd", code: "action_limits_invalid" },
        { path: "/limits", code: "expansion_cost_exceeded" },
      ],
    ],
    [
      "checks supplied in with and on the node",
      workflow([{
        ...CHECK,
        with: { ...CHECK.with, checks: ["lint"] },
      }]),
      [{ path: "/steps/0/checks", code: "action_duplicate_field" }],
    ],
    [
      "effect key supplied in with and on the node",
      workflow([{
        id: "ship",
        uses: "delivery.deploy",
        with: {
          releaseId: "r1",
          environment: "production",
          effectKey: "k1",
        },
        effectKey: ["deploy", "$input.repositoryId"],
      }]),
      [{ path: "/steps/0/effectKey", code: "action_duplicate_field" }],
    ],
    [
      "keyed action without an effect key",
      workflow([{
        id: "ship",
        uses: "delivery.deploy",
        with: { releaseId: "r1", environment: "production" },
      }]),
      [
        { path: "/steps/0/with/effectKey", code: "input_field_missing" },
        { path: "/steps/0", code: "action_effect_key_required" },
      ],
    ],
    [
      "unknown with field is reported at the container",
      workflow([{
        ...CHECK,
        with: { ...CHECK.with, bogus: 1 },
      }]),
      [{ path: "/steps/0/with", code: "input_field_unknown" }],
    ],
    [
      "missing required field",
      workflow([{ ...CHECK, with: { repositoryId: "$input.repositoryId" } }]),
      [{ path: "/steps/0/with/revision", code: "input_field_missing" }],
    ],
    [
      "checks are required even when the node omits them",
      workflow([{ id: "verify", uses: "quality.check", with: CHECK.with }]),
      [{ path: "/steps/0/with/checks", code: "input_field_missing" }],
    ],
    [
      "wait on an unknown event",
      workflow([{
        id: "hold",
        wait: { event: "no.such.event", timeout: "1h" },
      }]),
      [{ path: "/steps/0/wait/event", code: "wait_event_unknown" }],
    ],
    [
      "unresolved action schema",
      workflow([noop("first")]),
      [{ path: "/steps/0/uses", code: "action_schema_unresolved" }],
    ],
    [
      "with is not an object after a literal escape",
      workflow([{
        id: "verify",
        uses: "quality.check",
        with: { $literal: 7 },
      }]),
      [{ path: "/steps/0/with", code: "field_invalid" }],
    ],
  ];
  for (const [name, definition, expected] of cases) {
    const catalog = name === "unresolved action schema"
      ? createDesignCatalog({ schemas: { EmptyInput: {} } })
      : createDesignCatalog();
    assertEquals(await diagnoseWith(definition, catalog), expected, name);
  }
});

Deno.test("a design catalog accepts well-formed action steps and events", async () => {
  const result = await compileWorkflowDocument(
    plain(workflow([
      CHECK,
      { id: "hold", wait: { event: "question.answered", timeout: "1h" } },
      { id: "tail", uses: "workflow.noop", with: {} },
    ])),
    { catalog: createDesignCatalog() },
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  // The same definition compiles without a catalog and yields the same digest.
  const bare = await accepted(workflow([
    CHECK,
    { id: "hold", wait: { event: "question.answered", timeout: "1h" } },
    { id: "tail", uses: "workflow.noop", with: {} },
  ]));
  assertEquals(bare.digest, result.digest);
});

Deno.test("catalog-less compiles keep ignoring action inputs", async () => {
  await accepted(workflow([{ ...noop("first"), with: { anything: 1 } }]));
});

Deno.test("pattern-only check names use the source pattern", async () => {
  const catalog = createDesignCatalog({ checkNames: null });
  const ok = await compileWorkflowDocument(
    plain(workflow([{ ...CHECK, checks: ["lint", "custom:check_1"] }])),
    { catalog },
  );
  assert(ok.ok, ok.ok ? "" : JSON.stringify(ok.diagnostics));
  assertEquals(
    await diagnoseWith(
      workflow([{ ...CHECK, checks: ["Bad Name!", "ok"] }]),
      catalog,
    ),
    [{ path: "/steps/0/checks/0", code: "action_checks_invalid" }],
  );
});

Deno.test("the live default catalog resolves the implemented actions", async () => {
  const catalog = defaultWorkflowCompilerCatalog();
  assert(defaultWorkflowCompilerCatalog() === catalog, "built once");
  assertEquals(catalog.checkNames, null);
  const result = await compileWorkflowDocument(
    plain(workflow([
      CHECK,
      {
        id: "build",
        needs: ["verify"],
        uses: "harness.implement",
        with: {
          repositoryId: "$input.repositoryId",
          planArtifact: AGENT,
        },
      },
      { id: "tail", needs: ["build"], uses: "workflow.noop" },
    ])),
    { catalog },
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(
    await diagnoseWith(
      workflow([{
        id: "study",
        uses: "rpi.research",
        with: { taskId: "$input.repositoryId" },
      }]),
      catalog,
    ),
    [{ path: "/steps/0/uses", code: "action_schema_unresolved" }],
  );
  assertEquals(
    await diagnoseWith(
      workflow([{ ...CHECK, checks: ["Bad Name!"] }]),
      catalog,
    ),
    [{ path: "/steps/0/checks/0", code: "action_checks_invalid" }],
  );
  assertEquals(
    await diagnoseWith(
      workflow([{ ...CHECK, limits: { maxFindings: 3 } }]),
      catalog,
    ),
    [{ path: "/steps/0/limits/maxFindings", code: "action_limits_invalid" }],
  );
  assertEquals(catalog.task()?.kind, "object");
  assertEquals(catalog.event("question.answered")?.payload?.kind, "object");
  // Mixed-case event names from the transport inventory are accepted.
  assert(catalog.event("taskRepository.updated"));
  const mixed = await compileWorkflowDocument(
    plain(workflow([{
      id: "hold",
      wait: { event: "taskRepository.updated", timeout: "1h" },
    }])),
    { catalog },
  );
  assert(mixed.ok, mixed.ok ? "" : JSON.stringify(mixed.diagnostics));
});

Deno.test("the live catalog reports the schemas missing from the contracts", () => {
  const catalog = defaultWorkflowCompilerCatalog();
  const unresolved = WORKFLOW_ACTION_NAMES.filter((name) =>
    !catalog.resolveAction(name)
  );
  // rpi.plan left the design-only set when #437/#440 published dispatchable
  // workflow action discovery and step bindings for it; review.independent
  // left it when #94 registered ReviewInput and ReviewOutput as worker action
  // schemas; everything the registry still marks design-only stays unresolved
  // in the live catalog.
  for (
    const name of [
      "rpi.research",
      "delivery.merge",
    ]
  ) {
    assert((unresolved as string[]).includes(name), name);
  }
  for (
    const name of [
      "quality.check",
      "harness.implement",
      "workflow.noop",
      "rpi.plan",
      "review.independent",
    ]
  ) {
    assert(!(unresolved as string[]).includes(name), name);
  }
});

Deno.test("the doc 06 specimen resolves cleanly against the design catalog", async () => {
  const specimen = await specimenDefinition();
  const result = await compileWorkflowDocument(plain(specimen), {
    catalog: createDesignCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  // The live catalog lags the design and reports unresolved schemas.
  const live = await compileWorkflowDocument(plain(specimen), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  assert(!live.ok);
  assert(
    live.diagnostics.some((d) => d.code === "action_schema_unresolved"),
  );
});

Deno.test("a catalog built from a lazy schema lookup resolves on demand", () => {
  const asked: string[] = [];
  const catalog = createWorkflowCompilerCatalog({
    schemas: (name) => {
      asked.push(name);
      return name === "EmptyInput" || name === "EmptyOutput"
        ? obj({})
        : undefined;
    },
    events: {},
    taskSchema: () => obj({ id: uuid() }),
    checkNames: null,
    actionLimitFields: Object.fromEntries(
      WORKFLOW_ACTION_NAMES.map((name) => [name, []]),
    ) as never,
  });
  assertEquals(asked, []);
  assert(catalog.resolveAction("workflow.noop"));
  assertEquals(catalog.resolveAction("rpi.design"), undefined);
  assertEquals(catalog.resolveAction("rpi.design"), undefined);
  assertEquals(asked.filter((name) => name === "DesignInput").length, 1);
  assertEquals(arr(str()).type, "array");
});

// ---------------------------------------------------------------------------
// Phase 5b: references, needs and the type check.
// ---------------------------------------------------------------------------

type Found = { path: string; code: string };

const chk = (id: string, extra: Def = {}): Def => ({
  id,
  uses: "quality.check",
  with: { repositoryId: "$input.repositoryId", revision: "abc" },
  checks: ["lint"],
  ...extra,
});

const rev = (id: string, withExtra: Def = {}, extra: Def = {}): Def => ({
  id,
  uses: "review.independent",
  with: {
    revision: "$step.verify.headSha",
    evidence: "$step.verify.checkRunIds",
    ...withExtra,
  },
  ...extra,
});

async function flowDiagnostics(
  definition: unknown,
  catalog = createDesignCatalog(),
): Promise<Found[]> {
  return await diagnoseWith(definition, catalog);
}

async function flowAccepted(
  definition: unknown,
  catalog = createDesignCatalog(),
): Promise<void> {
  const result = await compileWorkflowDocument(plain(definition), { catalog });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
}

async function flowCases(
  cases: [string, unknown, Found[]][],
  catalog = createDesignCatalog(),
): Promise<void> {
  for (const [name, definition, expected] of cases) {
    assertEquals(await flowDiagnostics(definition, catalog), expected, name);
  }
}

const candidateSeed = { headSha: "$step.verify.headSha" };

function fixLoop(extra: Def = {}, body: Def = {}): Def {
  return {
    id: "fix",
    repeat: {
      max: 2,
      seed: { currentCandidate: candidateSeed },
      until: '$repeat.currentCandidate.headSha == "done"',
      steps: [
        chk("try_one", {
          with: {
            repositoryId: "$input.repositoryId",
            revision: "$repeat.currentCandidate.headSha",
          },
        }),
      ],
      outputs: { currentCandidate: { headSha: "$step.fix.try_one.headSha" } },
      ...body,
    },
    ...extra,
  };
}

Deno.test("reference flow: ordering, self reads and guards", async () => {
  await flowCases([
    [
      "reading a later sibling",
      workflow([rev("early"), chk("verify")]),
      [
        { path: "/steps/0/with/revision", code: "reference_future" },
        { path: "/steps/0/with/evidence", code: "reference_future" },
      ],
    ],
    [
      "reading its own output",
      workflow([
        chk("verify", {
          with: {
            repositoryId: "$input.repositoryId",
            revision: "$step.verify.headSha",
          },
        }),
      ]),
      [{ path: "/steps/0/with/revision", code: "reference_self" }],
    ],
    [
      "reading a conditionally skipped step without needing it",
      workflow([
        chk("verify", { if: '$input.target == "prod"' }),
        rev("after"),
      ]),
      [
        { path: "/steps/1/with/revision", code: "reference_skipped_step" },
        { path: "/steps/1/with/evidence", code: "reference_skipped_step" },
      ],
    ],
    [
      "a container reading its own descendant from if (not yet complete)",
      workflow([{
        id: "group",
        steps: [chk("verify")],
        if: "$step.group.verify.allRequired == true",
      }]),
      [{ path: "/steps/0/if", code: "reference_future" }],
    ],
  ]);
  await flowAccepted(workflow([
    chk("verify", { if: '$input.target == "prod"' }),
    rev("after", {}, { needs: ["verify"] }),
    rev("later", {}, { needs: ["after"] }),
  ]));
  // A conditional reader may read a step guarded by the same condition.
  await flowAccepted(workflow([
    chk("verify", { if: '$input.target == "prod"' }),
    {
      id: "inside",
      needs: ["verify"],
      steps: [rev("deeper")],
    },
  ]));
  // Sequences are transparent: children are addressed through their parent.
  await flowAccepted(workflow([
    { id: "group", steps: [chk("verify")] },
    rev("after", {
      revision: "$step.group.verify.headSha",
      evidence: "$step.group.verify.checkRunIds",
    }),
  ]));
});

Deno.test("reference resolution: inputs, steps, task and typed fields", async () => {
  await flowCases([
    [
      "undeclared input",
      workflow([chk("verify", {
        with: {
          repositoryId: "$input.nope",
          revision: "abc",
        },
      })]),
      [{ path: "/steps/0/with/repositoryId", code: "reference_input_unknown" }],
    ],
    [
      "unknown step",
      workflow([
        chk("verify"),
        rev("after", { revision: "$step.nope.headSha" }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_step_unknown" }],
    ],
    [
      "unknown output field",
      workflow([
        chk("verify"),
        rev("after", { revision: "$step.verify.nope" }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_field_unknown" }],
    ],
    [
      "field read through a scalar",
      workflow([
        chk("verify"),
        rev("after", { revision: "$step.verify.headSha.length" }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_field_unknown" }],
    ],
    [
      "field read from a scalar input",
      workflow([chk("verify", {
        with: {
          repositoryId: "$input.repositoryId.nope",
          revision: "abc",
        },
      })]),
      [{ path: "/steps/0/with/repositoryId", code: "reference_field_unknown" }],
    ],
  ]);
  await flowCases([
    [
      "unknown task field in a condition",
      workflow([{ ...noop("first"), if: '$task.nope == "x"' }]),
      [{ path: "/steps/0/if", code: "reference_field_unknown" }],
    ],
    [
      "a whole container is not a value",
      workflow([
        { id: "group", steps: [chk("verify")] },
        rev("after", { revision: "$step.group", evidence: [] }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_field_unknown" }],
    ],
    [
      "no field of a json output",
      workflow([
        {
          id: "call",
          uses: "integration.action",
          with: {
            actionId: "ping",
            actionVersion: 1,
            resourceId: "$input.repositoryId",
            arguments: { any: 1 },
          },
          effectKey: ["call", "$input.repositoryId"],
        },
        rev("after", { revision: "$step.call.value", evidence: [] }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_field_unknown" }],
    ],
  ]);
  await flowAccepted(workflow([
    { ...noop("first"), if: '$task.status == "active"' },
    chk("verify", {
      with: {
        repositoryId: "$input.repositoryId",
        revision: "$input.target",
      },
    }),
    rev("after"),
  ]));
});

Deno.test("optional inputs and fields read as nullable", async () => {
  const inputs = {
    repositoryId: { type: "uuid", required: true },
    target: { type: "string", required: false },
  };
  await flowCases([
    [
      "an optional input is not assignable to a required string",
      workflow([chk("verify", {
        with: {
          repositoryId: "$input.repositoryId",
          revision: "$input.target",
        },
      })], { inputs }),
      [{ path: "/steps/0/with/revision", code: "type_mismatch" }],
    ],
    [
      "ordering a nullable input",
      workflow([{ ...noop("first"), if: '$input.target < "b"' }], { inputs }),
      [{ path: "/steps/0/if", code: "expression_operand_invalid" }],
    ],
  ]);
  await flowAccepted(
    workflow([{ ...noop("first"), if: "$input.target == null" }], { inputs }),
  );
  await flowAccepted(
    workflow([{ ...noop("first"), if: '$input.target == "x"' }], { inputs }),
  );
});

Deno.test("repeat results, candidates and scopes", async () => {
  // Repeat results are addressed as $step.<id>.{iterations,currentCandidate,outcome}.
  await flowAccepted(workflow([
    chk("verify"),
    fixLoop(),
    rev("report", {
      revision: "$step.fix.currentCandidate.headSha",
      evidence: "$step.verify.checkRunIds",
    }, {
      if: '$step.fix.outcome == "completed" && $step.fix.iterations < 3',
    }),
  ]));
  await flowCases([
    [
      "iterations compared with a string",
      workflow([chk("verify"), fixLoop(), {
        ...noop("report"),
        if: '$step.fix.iterations == "two"',
      }]),
      [{ path: "/steps/2/if", code: "expression_operand_invalid" }],
    ],
    [
      "outcome is not a number",
      workflow([chk("verify"), fixLoop(), {
        ...noop("report"),
        if: "$step.fix.outcome == 1",
      }]),
      [{ path: "/steps/2/if", code: "expression_operand_invalid" }],
    ],
    [
      "candidate field that the seed does not carry",
      workflow([chk("verify"), fixLoop(), {
        ...noop("report"),
        if: '$step.fix.currentCandidate.nope == "x"',
      }]),
      [{ path: "/steps/2/if", code: "reference_field_unknown" }],
    ],
    [
      "body step read from outside the repeat",
      workflow([
        chk("verify"),
        fixLoop(),
        rev("report", {
          revision: "$step.fix.try_one.headSha",
        }),
      ]),
      [{ path: "/steps/2/with/revision", code: "reference_repeat_scope" }],
    ],
    [
      "repeat result read from inside its own body",
      workflow([
        chk("verify"),
        fixLoop({}, {
          steps: [
            chk("try_one", {
              with: {
                repositoryId: "$input.repositoryId",
                revision: "$step.fix.outcome",
              },
            }),
          ],
          outputs: {
            currentCandidate: { headSha: "$step.fix.try_one.headSha" },
          },
        }),
      ]),
      [{
        path: "/steps/1/repeat/steps/0/with/revision",
        code: "reference_future",
      }],
    ],
    [
      "candidate outside any repeat",
      workflow([{ ...noop("first"), if: "$repeat.currentCandidate.x == 1" }]),
      [{ path: "/steps/0/if", code: "reference_repeat_scope" }],
    ],
    [
      "repeat field other than currentCandidate",
      workflow([
        chk("verify"),
        fixLoop({}, {
          until: "$repeat.iterations == 1",
        }),
      ]),
      [{ path: "/steps/1/repeat/until", code: "reference_field_unknown" }],
    ],
    [
      "outputs candidate the seed type cannot hold",
      workflow([
        chk("verify"),
        fixLoop({}, {
          outputs: { currentCandidate: { headSha: 7 } },
        }),
      ]),
      [{
        path: "/steps/1/repeat/outputs/currentCandidate",
        code: "type_mismatch",
      }],
    ],
    [
      "outputs candidate with an extra field",
      workflow([
        chk("verify"),
        fixLoop({}, {
          outputs: { currentCandidate: { headSha: "x", other: 1 } },
        }),
      ]),
      [{
        path: "/steps/1/repeat/outputs/currentCandidate",
        code: "type_mismatch",
      }],
    ],
    [
      "until that is not boolean",
      workflow([
        chk("verify"),
        fixLoop({}, {
          until: "$repeat.currentCandidate.headSha",
        }),
      ]),
      [{ path: "/steps/1/repeat/until", code: "condition_not_boolean" }],
    ],
  ]);
});

Deno.test("repeat seed scopes: sequence seeds, body reads and outer candidates", async () => {
  const sequenceSeed = (extra: Def = {}): Def =>
    fixLoop({}, {
      seed: {
        steps: [chk("seed_check")],
        outputs: {
          currentCandidate: { headSha: "$step.fix.seed_check.headSha" },
        },
      },
      ...extra,
    });
  // Sequence-seed outputs may read seed steps; the seed type types the candidate.
  await flowAccepted(workflow([sequenceSeed()]));
  await flowCases([
    [
      "a body step reading a seed step",
      workflow([sequenceSeed({
        steps: [
          chk("try_one", {
            with: {
              repositoryId: "$input.repositoryId",
              revision: "$step.fix.seed_check.headSha",
            },
          }),
        ],
        outputs: { currentCandidate: { headSha: "$step.fix.try_one.headSha" } },
      })]),
      [{
        path: "/steps/0/repeat/steps/0/with/revision",
        code: "reference_repeat_scope",
      }],
    ],
    [
      "a seed step reading the body",
      workflow([fixLoop({}, {
        seed: {
          steps: [
            chk("seed_check", {
              with: {
                repositoryId: "$input.repositoryId",
                revision: "$step.fix.try_one.headSha",
              },
            }),
          ],
          outputs: {
            currentCandidate: { headSha: "$step.fix.seed_check.headSha" },
          },
        },
      })]),
      [{
        path: "/steps/0/repeat/seed/steps/0/with/revision",
        code: "reference_repeat_scope",
      }],
    ],
    [
      "a seed mapping reading the body",
      workflow([
        chk("verify"),
        fixLoop({}, {
          seed: { currentCandidate: { headSha: "$step.fix.try_one.headSha" } },
        }),
      ]),
      [{
        path: "/steps/1/repeat/seed/currentCandidate",
        code: "reference_repeat_scope",
      }],
    ],
  ]);
  // In a seed, $repeat names the enclosing outer repeat.
  await flowAccepted(workflow([
    chk("verify"),
    {
      id: "outer",
      repeat: {
        max: 2,
        seed: { currentCandidate: candidateSeed },
        until: '$repeat.currentCandidate.headSha == "done"',
        steps: [
          fixLoop({ id: "inner" }, {
            seed: {
              currentCandidate: {
                headSha: "$repeat.currentCandidate.headSha",
              },
            },
            outputs: {
              currentCandidate: {
                headSha: "$step.outer.inner.try_one.headSha",
              },
            },
            steps: [chk("try_one")],
          }),
        ],
        outputs: {
          currentCandidate: {
            headSha: "$step.outer.inner.currentCandidate.headSha",
          },
        },
      },
    },
  ]));
});

Deno.test("branch outputs and arm scoping", async () => {
  const branch = (body: Def = {}, extra: Def = {}): Def => ({
    id: "choose",
    branch: {
      when: '$input.target == "prod"',
      then: [chk("on_prod")],
      else: [chk("on_dev")],
      outputs: {
        sha: {
          then: "$step.choose.on_prod.headSha",
          else: "$step.choose.on_dev.headSha",
        },
        only: { then: "$step.choose.on_prod.headSha" },
      },
      ...body,
    },
    ...extra,
  });
  await flowAccepted(workflow([
    branch(),
    rev("after", {
      revision: "$step.choose.sha",
      evidence: [],
    }),
    { ...noop("check_only"), if: "$step.choose.only == null" },
  ]));
  await flowCases([
    [
      "arm step read from outside the branch",
      workflow([
        branch(),
        rev("after", {
          revision: "$step.choose.on_prod.headSha",
          evidence: [],
        }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_unselected_branch" }],
    ],
    [
      "one-armed output is nullable",
      workflow([
        branch(),
        rev("after", { revision: "$step.choose.only", evidence: [] }),
      ]),
      [{ path: "/steps/1/with/revision", code: "type_mismatch" }],
    ],
    [
      "other arm read from within an arm",
      workflow([branch({
        then: [
          chk("on_prod"),
          rev("second", {
            revision: "$step.choose.on_dev.headSha",
            evidence: [],
          }),
        ],
      })]),
      [{
        path: "/steps/0/branch/then/1/with/revision",
        code: "reference_unselected_branch",
      }],
    ],
    [
      "then output reading the else arm",
      workflow([branch({
        outputs: { sha: { then: "$step.choose.on_dev.headSha" } },
      })]),
      [{
        path: "/steps/0/branch/outputs/sha/then",
        code: "reference_unselected_branch",
      }],
    ],
    [
      "arms with incompatible output types",
      workflow([branch({
        outputs: { sha: { then: "$step.choose.on_prod.headSha", else: 3 } },
      })]),
      [{
        path: "/steps/0/branch/outputs/sha",
        code: "branch_outputs_invalid",
      }],
    ],
    [
      "when that is not boolean",
      workflow([branch({ when: "$input.target" })]),
      [{ path: "/steps/0/branch/when", code: "condition_not_boolean" }],
    ],
    [
      "a conditional arm step read from the same arm without needs",
      workflow([branch({
        then: [
          chk("on_prod", { if: '$input.target == "prod"' }),
          rev("second", {
            revision: "$step.choose.on_prod.headSha",
            evidence: [],
          }),
        ],
      })]),
      [
        {
          path: "/steps/0/branch/then/1/with/revision",
          code: "reference_skipped_step",
        },
        {
          path: "/steps/0/branch/outputs/sha/then",
          code: "reference_skipped_step",
        },
        {
          path: "/steps/0/branch/outputs/only/then",
          code: "reference_skipped_step",
        },
      ],
    ],
  ]);
});

Deno.test("parallel exports, lane scope and prerequisite lanes", async () => {
  const group = (
    laneB: Def = {},
    outputs: Def = {
      lane_a: { sha: "$step.fan.lane_a.a_check.headSha" },
      lane_b: { sha: "$step.fan.lane_b.b_check.headSha" },
    },
  ): Def => ({
    id: "fan",
    parallel: {
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      branches: [
        { id: "lane_a", repository: "main", steps: [chk("a_check")] },
        {
          id: "lane_b",
          repository: "main",
          needs: ["lane_a"],
          steps: [
            rev("b_check", { revision: "$step.fan.lane_a.sha" }),
          ],
          ...laneB,
        },
      ],
      outputs,
    },
  });
  const laneBSteps = (withExtra: Def): Def => ({
    steps: [
      rev("b_check", { evidence: "$step.verify.checkRunIds", ...withExtra }),
    ],
  });
  // Exports are read after the group; a prerequisite lane's exports are readable.
  await flowAccepted(workflow([
    chk("verify"),
    group(laneBSteps({ revision: "$step.fan.lane_a.sha" })),
    rev("after", {
      revision: "$step.fan.lane_b.sha",
      evidence: "$step.verify.checkRunIds",
    }),
  ]));
  await flowCases([
    [
      "lane step subtree read after the group",
      workflow([
        chk("verify"),
        group(laneBSteps({ revision: "$step.fan.lane_a.sha" })),
        rev("after", { revision: "$step.fan.lane_a.a_check.headSha" }),
      ]),
      [{ path: "/steps/2/with/revision", code: "reference_parallel_scope" }],
    ],
    [
      "sibling lane export without a prerequisite",
      workflow([
        chk("verify"),
        group({
          ...laneBSteps({ revision: "$step.fan.lane_a.sha" }),
          needs: [],
        }),
      ]),
      [{
        path: "/steps/1/parallel/branches/1/steps/0/with/revision",
        code: "reference_parallel_sibling",
      }],
    ],
    [
      "sibling lane step read from another lane",
      workflow([
        chk("verify"),
        group(laneBSteps({ revision: "$step.fan.lane_a.a_check.headSha" })),
      ]),
      [{
        path: "/steps/1/parallel/branches/1/steps/0/with/revision",
        code: "reference_parallel_scope",
      }],
    ],
    [
      "export value pointing into another lane",
      workflow([
        chk("verify"),
        group(laneBSteps({ revision: "$step.fan.lane_a.sha" }), {
          lane_a: { sha: "$step.fan.lane_b.b_check.headSha" },
        }),
      ]),
      [{
        path: "/steps/1/parallel/outputs/lane_a/sha",
        code: "reference_parallel_scope",
      }],
    ],
    [
      "a lane reading its own export",
      workflow([
        chk("verify"),
        group({
          steps: [
            rev("b_check", { revision: "$step.fan.lane_b.sha" }),
          ],
        }),
      ]),
      [{
        path: "/steps/1/parallel/branches/1/steps/0/with/revision",
        code: "reference_future",
      }],
    ],
    [
      "unknown lane export",
      workflow([
        chk("verify"),
        group(laneBSteps({ revision: "$step.fan.lane_a.sha" })),
        rev("after", { revision: "$step.fan.lane_a.nope" }),
      ]),
      [{ path: "/steps/2/with/revision", code: "reference_field_unknown" }],
    ],
  ].map(([name, definition, expected]) => [
    name,
    definition,
    expected,
  ]) as [string, unknown, Found[]][]);
});

Deno.test("lane exports follow prerequisite order, not authored order", async () => {
  // lane_a needs lane_b although it is written first.
  await flowAccepted(workflow([
    chk("verify"),
    {
      id: "fan",
      parallel: {
        maxConcurrency: 2,
        join: "all-required",
        failurePolicy: "stop-dependent",
        branches: [
          {
            id: "lane_a",
            repository: "main",
            needs: ["lane_b"],
            steps: [rev("a_check", { revision: "$step.fan.lane_b.sha" })],
          },
          { id: "lane_b", repository: "main", steps: [chk("b_check")] },
        ],
        outputs: { lane_b: { sha: "$step.fan.lane_b.b_check.headSha" } },
      },
    },
  ]));
});

Deno.test("needs: unknown, forward, self and lane cycles", async () => {
  await flowCases([
    [
      "needs an unknown sibling",
      workflow([noop("first"), { ...noop("second"), needs: ["ghost"] }]),
      [{ path: "/steps/1/needs/0", code: "needs_unknown" }],
    ],
    [
      "needs a later sibling",
      workflow([{ ...noop("first"), needs: ["second"] }, noop("second")]),
      [{ path: "/steps/0/needs/0", code: "needs_forward" }],
    ],
    [
      "needs itself",
      workflow([{ ...noop("first"), needs: ["first"] }]),
      [{ path: "/steps/0/needs/0", code: "needs_cycle" }],
    ],
    [
      "needs a step of another scope",
      workflow([
        noop("outer_step"),
        {
          id: "group",
          steps: [{ ...noop("inner_step"), needs: ["outer_step"] }],
        },
      ]),
      [{ path: "/steps/1/steps/0/needs/0", code: "needs_unknown" }],
    ],
  ]);
  const lanes = (a: string[], b: string[], c: string[] = []): Def => ({
    id: "fan",
    parallel: {
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      branches: [
        { id: "lane_a", repository: "main", needs: a, steps: [noop("work_a")] },
        { id: "lane_b", repository: "main", needs: b, steps: [noop("work_b")] },
        { id: "lane_c", repository: "main", needs: c, steps: [noop("work_c")] },
      ],
    },
  });
  await flowCases([
    [
      "lane cycle",
      workflow([lanes(["lane_b"], ["lane_a"])]),
      [{ path: "/steps/0/parallel/branches/1/needs/0", code: "needs_cycle" }],
    ],
    [
      "three-lane cycle",
      workflow([lanes(["lane_b"], ["lane_c"], ["lane_a"])]),
      [{ path: "/steps/0/parallel/branches/2/needs/0", code: "needs_cycle" }],
    ],
    [
      "lane needing itself",
      workflow([lanes(["lane_a"], [])]),
      [{ path: "/steps/0/parallel/branches/0/needs/0", code: "needs_cycle" }],
    ],
    [
      "lane needing an unknown lane",
      workflow([lanes(["ghost"], [])]),
      [{ path: "/steps/0/parallel/branches/0/needs/0", code: "needs_unknown" }],
    ],
  ]);
  // Lanes may need later lanes; only cycles are errors.
  await flowAccepted(workflow([lanes(["lane_b"], ["lane_c"], [])]));
});

Deno.test("conditions: boolean results and operand typing", async () => {
  const guard = (condition: string): unknown =>
    workflow([{ ...noop("first"), if: condition }]);
  await flowCases([
    ["string result", guard("$input.target"), [{
      path: "/steps/0/if",
      code: "condition_not_boolean",
    }]],
    ["number literal result", guard("1"), [{
      path: "/steps/0/if",
      code: "condition_not_boolean",
    }]],
    ["list result", guard('["a"]'), [{
      path: "/steps/0/if",
      code: "condition_not_boolean",
    }]],
    ["negating a string", guard("!$input.target"), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["connective over a number", guard("1 && true"), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["string equal to number", guard("$input.target == 1"), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["non-nullable against null", guard("$input.target == null"), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["ordering booleans", guard("true < false"), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["ordering a string against a number", guard('"a" < 1'), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["membership of a number in strings", guard('1 in ["a", "b"]'), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["membership against a scalar", guard('"a" in "abc"'), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["list of mixed families", guard('"a" in ["a", 1]'), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
    ["comparing an object", guard('["a"] == ["a"]'), [{
      path: "/steps/0/if",
      code: "expression_operand_invalid",
    }]],
  ]);
  for (
    const ok of [
      "true",
      '$input.target == "a" || $input.target != "b"',
      '$input.target in ["a", "b"]',
      "$input.target in []",
      "1 < 2.5 && !(2 >= 3)",
      '"a" <= $input.target',
      "null == null",
      '$task.status in ["active", "queued"]',
    ]
  ) {
    await flowAccepted(guard(ok));
  }
});

Deno.test("with values are type checked without coercion", async () => {
  await flowCases([
    [
      "number where a string is required",
      workflow([chk("verify", {
        with: {
          repositoryId: "$input.repositoryId",
          revision: 5,
        },
      })]),
      [{ path: "/steps/0/with/revision", code: "type_mismatch" }],
    ],
    [
      "non-uuid literal for a uuid field",
      workflow([chk("verify", {
        with: {
          repositoryId: "not-a-uuid",
          revision: "abc",
        },
      })]),
      [{ path: "/steps/0/with/repositoryId", code: "type_mismatch" }],
    ],
    [
      "string reference for a uuid field",
      workflow([
        chk("first"),
        chk("second", {
          with: {
            repositoryId: "$step.first.headSha",
            revision: "abc",
          },
        }),
      ]),
      [{ path: "/steps/1/with/repositoryId", code: "type_mismatch" }],
    ],
    [
      "list of strings for a list of uuids",
      workflow([
        chk("first"),
        rev("second", {
          revision: "$step.first.headSha",
          evidence: ["$step.first.headSha"],
        }),
      ]),
      [{ path: "/steps/1/with/evidence", code: "type_mismatch" }],
    ],
    [
      "object with an unknown member for a closed object",
      workflow([{
        id: "build",
        uses: "harness.implement",
        with: {
          repositoryId: "$input.repositoryId",
          planArtifact: { ...ARTIFACT, extra: 1 },
        },
      }]),
      [{ path: "/steps/0/with/planArtifact", code: "type_mismatch" }],
    ],
    [
      "object holding a reference of the wrong type",
      workflow([chk("verify"), {
        id: "build",
        uses: "harness.implement",
        with: {
          repositoryId: "$input.repositoryId",
          planArtifact: { ...ARTIFACT, versionId: "$step.verify.headSha" },
        },
      }]),
      [{ path: "/steps/1/with/planArtifact", code: "type_mismatch" }],
    ],
  ]);
  // References assign into lists, objects and json targets.
  await flowAccepted(workflow([
    chk("verify"),
    rev("second", { evidence: ["$input.repositoryId"] }),
    {
      id: "call",
      uses: "integration.action",
      with: {
        actionId: "ping",
        actionVersion: 1,
        resourceId: "$input.repositoryId",
        arguments: { sha: "$step.verify.headSha", nested: ["$input.target"] },
      },
      effectKey: ["call", "$input.repositoryId"],
    },
  ]));
});

Deno.test("wait outputs are typed by outcome and payload", async () => {
  const waits = (condition: string): unknown =>
    workflow([
      { id: "hold", wait: { event: "question.answered", timeout: "1h" } },
      { id: "nap", wait: { duration: "5m" } },
      { ...noop("after"), if: condition },
    ]);
  for (
    const ok of [
      '$step.hold.outcome == "timed_out"',
      '$step.hold.outcome in ["received", "timed_out"]',
      "$step.hold.event == null",
      '$step.nap.outcome == "elapsed"',
      "$step.hold.event.questionId == null",
    ]
  ) {
    await flowAccepted(waits(ok));
  }
  await flowCases([
    [
      "outcome compared with a number",
      waits("$step.hold.outcome == 1"),
      [{ path: "/steps/2/if", code: "expression_operand_invalid" }],
    ],
    [
      "unknown payload field",
      waits("$step.hold.event.nope == null"),
      [{ path: "/steps/2/if", code: "reference_field_unknown" }],
    ],
    [
      "duration waits carry no event",
      waits("$step.nap.event == null"),
      [{ path: "/steps/2/if", code: "reference_field_unknown" }],
    ],
    [
      "a wait reading a later step is not possible, but its output is future",
      workflow([
        { ...noop("early"), if: '$step.hold.outcome == "timed_out"' },
        { id: "hold", wait: { event: "question.answered", timeout: "1h" } },
      ]),
      [{ path: "/steps/0/if", code: "reference_future" }],
    ],
  ]);
});

Deno.test("effect keys need typed, non-empty parts", async () => {
  const deploy = (key: unknown, schemas: Record<string, unknown> = {}): [
    unknown,
    ReturnType<typeof createDesignCatalog>,
  ] => [
    workflow([
      chk("verify"),
      {
        id: "ship",
        uses: "delivery.deploy",
        with: { releaseId: "r1", environment: "production" },
        effectKey: key,
      },
    ], {
      inputs: {
        repositoryId: { type: "uuid", required: true },
        target: { type: "string", required: true },
        revisionNumber: { type: "integer", required: true },
        ratio: { type: "number", required: true },
        optional: { type: "string", required: false },
      },
    }),
    createDesignCatalog({ schemas }),
  ];
  // uuid, integer and nonEmpty string parts are accepted.
  for (
    const key of [
      ["deploy", "$input.repositoryId", "$input.revisionNumber"],
      ["deploy", "$step.verify.baseSha"],
      ["deploy", "$step.verify.headSha"],
    ]
  ) {
    const [definition, catalog] = deploy(key);
    await flowAccepted(definition, catalog);
  }
  const rejects: [string, unknown][] = [
    ["a string without minLength", ["deploy", "$input.target"]],
    ["a nullable part", ["deploy", "$input.optional"]],
    ["a number part", ["deploy", "$input.ratio"]],
    ["a list part", ["deploy", "$step.verify.checkRunIds"]],
  ];
  for (const [name, key] of rejects) {
    const [definition, catalog] = deploy(key);
    assertEquals(
      await flowDiagnostics(definition, catalog),
      [{ path: "/steps/1/effectKey", code: "effect_key_invalid" }],
      name,
    );
  }
  // A step output string whose schema declares no minLength is untyped-length.
  const lax = {
    CheckOutput: obj({
      allRequired: { type: "boolean" },
      checkRunIds: arr(uuid(), { minItems: 1 }),
      failedCheckIds: arr(uuid()),
      headSha: str(),
      baseSha: str(),
      policyDigest: str(),
    }),
  };
  const [laxDefinition, laxCatalog] = deploy(
    ["deploy", "$step.verify.headSha"],
    lax,
  );
  assertEquals(
    await flowDiagnostics(laxDefinition, laxCatalog),
    [{ path: "/steps/1/effectKey", code: "effect_key_invalid" }],
  );
  // A reference that does not resolve is reported with its own code.
  const [missing, missingCatalog] = deploy(["deploy", "$step.ghost.x"]);
  assertEquals(
    await flowDiagnostics(missing, missingCatalog),
    [{ path: "/steps/1/effectKey", code: "reference_step_unknown" }],
  );
});

Deno.test("sensitive outputs and unresolved actions", async () => {
  const sensitive = createDesignCatalog({
    schemas: {
      CheckOutput: obj({
        allRequired: { type: "boolean" },
        checkRunIds: arr(uuid(), { minItems: 1 }),
        failedCheckIds: arr(uuid()),
        headSha: str({ minLength: 1 }),
        baseSha: str({ minLength: 1 }),
        policyDigest: str({ minLength: 1 }),
        accessToken: str(),
        nested: obj({ dbPassword: str() }),
      }),
    },
  });
  await flowCases([
    [
      "reading a secret-named output field",
      workflow([
        chk("verify"),
        rev("after", { revision: "$step.verify.accessToken" }),
      ]),
      [{ path: "/steps/1/with/revision", code: "reference_secret_forbidden" }],
    ],
    [
      "reading a secret-named nested field in a condition",
      workflow([chk("verify"), {
        ...noop("after"),
        if: '$step.verify.nested.dbPassword == "x"',
      }]),
      [{ path: "/steps/1/if", code: "reference_secret_forbidden" }],
    ],
  ], sensitive);
  // An action that does not resolve has no output type, so its readers are not
  // reported twice.
  const live = defaultWorkflowCompilerCatalog();
  assertEquals(
    await flowDiagnostics(
      workflow([
        {
          id: "study",
          uses: "rpi.research",
          with: { taskId: "$input.repositoryId" },
        },
        {
          id: "after",
          uses: "workflow.noop",
          if: '$step.study.artifact.versionId == "x"',
        },
      ]),
      live,
    ),
    [{ path: "/steps/0/uses", code: "action_schema_unresolved" }],
  );
});

Deno.test("compiling without a catalog still checks needs and reference flow", async () => {
  const unknown = await compileWorkflowDocument(
    plain(workflow([{ ...noop("first"), needs: ["ghost"] }])),
  );
  assert(!unknown.ok);
  assertEquals(
    unknown.diagnostics.map(({ path, code }) => ({ path, code })),
    [{ path: "/steps/0/needs/0", code: "needs_unknown" }],
  );
  // Flow and scope rules need no catalog, so they run here too.
  const loose = await compileWorkflowDocument(
    plain(workflow([{ ...noop("first"), if: "$input.nope == 1" }])),
  );
  assert(!loose.ok);
  assertEquals(
    loose.diagnostics.map(({ path, code }) => ({ path, code })),
    [{ path: "/steps/0/if", code: "reference_input_unknown" }],
  );
});

// Phase 6: bounds, worst case, step keys and plan.

const fast = (id: string, extra: Def = {}): Def => ({
  ...noop(id),
  timeout: "10s",
  ...extra,
});

async function worstOf(steps: unknown[], extra: Def = {}) {
  const result = await accepted(workflow(steps, extra));
  return result.plan.worstCase;
}

Deno.test("worst case follows the documented formulas", async () => {
  // Retry: attempts, time = timeout x attempts + backoff x (attempts - 1).
  assertEquals(
    await worstOf([{
      id: "pub",
      uses: "artifact.publish",
      timeout: "1m",
      retry: { maxAttempts: 2, backoff: "30s" },
      limits: { maxCostUsd: 2 },
    }]),
    { steps: 1, attempts: 2, timeMs: 150_000, costUsd: 4 },
  );
  // Waits count their duration or event timeout.
  assertEquals(
    await worstOf([
      { id: "nap", wait: { duration: "90s" } },
      { id: "hold", wait: { event: "question.answered", timeout: "1h" } },
    ]),
    { steps: 2, attempts: 2, timeMs: 90_000 + 3_600_000, costUsd: 0 },
  );
  // A branch takes the per-metric maximum of its arms.
  assertEquals(
    await worstOf([{
      id: "choose",
      branch: {
        when: '$input.target == "prod"',
        then: [fast("one")],
        else: [fast("two"), fast("three")],
      },
    }]),
    { steps: 2, attempts: 2, timeMs: 20_000, costUsd: 0 },
  );
  // A missing else arm counts as zero.
  assertEquals(
    await worstOf([{
      id: "choose",
      branch: { when: '$input.target == "prod"', then: [fast("one")] },
    }]),
    { steps: 1, attempts: 1, timeMs: 10_000, costUsd: 0 },
  );
  // A repeat is seed + max x body; a sequence seed counts once.
  assertEquals(
    await worstOf([{
      id: "fix",
      repeat: {
        max: 3,
        seed: {
          steps: [fast("seeded")],
          outputs: { currentCandidate: { done: false } },
        },
        until: "$repeat.currentCandidate.done == true",
        steps: [fast("aa"), fast("bb")],
        outputs: { currentCandidate: "$step.fix.aa.out" },
      },
    }]),
    { steps: 7, attempts: 7, timeMs: 70_000, costUsd: 0 },
  );
  // A mapping seed contributes nothing.
  assertEquals(
    await worstOf([repeatNode({}, { max: 4, steps: [fast("only")] })]),
    { steps: 4, attempts: 4, timeMs: 40_000, costUsd: 0 },
  );
  // Parallel sums every lane.
  assertEquals(
    await worstOf([parallelNode({}, {
      branches: [
        { id: "lane_a", repository: "main", steps: [fast("work_a")] },
        {
          id: "lane_b",
          repository: "main",
          steps: [fast("work_b"), fast("work_c")],
        },
      ],
    })]),
    { steps: 3, attempts: 3, timeMs: 30_000, costUsd: 0 },
  );
  // Sequences sum.
  assertEquals(
    await worstOf([{ id: "group", steps: [fast("aa"), fast("bb")] }]),
    { steps: 2, attempts: 2, timeMs: 20_000, costUsd: 0 },
  );
});

Deno.test("expansion bounds report workflow-level diagnostics", async () => {
  const three = [fast("aa"), fast("bb"), fast("cc")];
  assertEquals(
    await diagnose(workflow(three, { limits: { maxAttempts: 2 } })),
    [{ path: "/limits", code: "expansion_attempts_exceeded" }],
  );
  assertEquals(
    await diagnose(workflow([noop("slow")], { limits: { wallClock: "1m" } })),
    [{ path: "/limits", code: "expansion_wall_clock_exceeded" }],
  );
  assertEquals(
    await diagnose(
      workflow([fast("paid", { limits: { maxCostUsd: 5 } })], {
        limits: { maxCostUsd: 4 },
      }),
    ),
    [{ path: "/limits", code: "expansion_cost_exceeded" }],
  );
  // Spend equal to the ceiling is allowed; undeclared spend contributes 0.
  await accepted(
    workflow([fast("paid", { limits: { maxCostUsd: 4 } }), fast("free")], {
      limits: { maxCostUsd: 4 },
    }),
  );
  // 8 x 8 x 8 x 2 = 1024 expanded steps.
  const deep = repeatNode({ id: "outer" }, {
    max: 8,
    steps: [
      repeatNode({ id: "middle" }, {
        max: 8,
        steps: [
          repeatNode({ id: "inner" }, {
            max: 8,
            steps: [fast("one"), fast("two")],
          }),
        ],
      }),
    ],
  });
  assertEquals(
    await diagnose(workflow([deep], { limits: { maxAttempts: 1000 } })),
    [
      { path: "/steps", code: "expansion_steps_exceeded" },
      { path: "/limits", code: "expansion_attempts_exceeded" },
    ],
  );
  assertEquals(
    await diagnose(
      workflow([repeatNode({}, { max: 3 })], {
        limits: { maxRepairCycles: 2 },
      }),
    ),
    [{ path: "/steps/0/repeat/max", code: "repeat_exceeds_policy" }],
  );
  await accepted(
    workflow([repeatNode({}, { max: 2 })], { limits: { maxRepairCycles: 2 } }),
  );
});

Deno.test("parallel join and failure policy must be explicit", async () => {
  for (const key of ["join", "failurePolicy", "maxConcurrency"]) {
    const node = parallelNode();
    delete (node["parallel"] as Def)[key];
    const found = await diagnose(workflow([node]));
    assertEquals(found.length, 1, key);
    assertEquals(found[0]!.path.startsWith("/steps/0/parallel"), true, key);
  }
  assertEquals(
    await diagnose(workflow([parallelNode({}, { join: "any" })])),
    [{ path: "/steps/0/parallel/join", code: "parallel_join_required" }],
  );
  assertEquals(
    await diagnose(workflow([parallelNode({}, { failurePolicy: "ignore" })])),
    [{
      path: "/steps/0/parallel/failurePolicy",
      code: "parallel_failure_policy_required",
    }],
  );
});

Deno.test("diagnostics stop at the cap with one truncation marker", async () => {
  const steps = Array.from({ length: 120 }, (_, index) => ({
    id: `step_${index}`,
    uses: "workflow.noop",
    needs: ["ghost"],
  }));
  const result = await compileWorkflowDocument(plain(workflow(steps)));
  assert(!result.ok);
  assertEquals(
    result.diagnostics.length,
    WORKFLOW_COMPILER_LIMITS.diagnostics + 1,
  );
  assertEquals(result.diagnostics.at(-1)?.code, "diagnostics_truncated");
});

Deno.test("nested repeat, parallel and repeat steps get unique round-trip keys", async () => {
  const inner = repeatNode({ id: "inner" }, {
    max: 3,
    seed: {
      steps: [fast("prep")],
      outputs: { currentCandidate: { done: false } },
    },
    steps: [fast("work")],
  });
  const outer = repeatNode({ id: "outer" }, {
    max: 8,
    seed: {
      steps: [fast("setup")],
      outputs: { currentCandidate: { done: false } },
    },
    steps: [
      parallelNode({ id: "fan" }, {
        maxConcurrency: 3,
        branches: ["lane_a", "lane_b", "lane_c"].map((id) => ({
          id,
          repository: "main",
          steps: [{ ...inner, id: "inner" }],
        })),
      }),
    ],
  });
  const result = await accepted(workflow([outer]));
  const keys = expandStepKeys(result.plan);
  assertEquals(new Set(keys).size, keys.length);
  // setup once + 8 iterations x 3 lanes x (prep once + 3 work iterations).
  assertEquals(keys.length, 1 + 8 * 3 * (1 + 3));
  assertEquals(keys.length, result.plan.worstCase.steps);
  for (const key of keys) {
    const parsed = parseStepKey(key);
    const step = result.plan.steps.find((candidate) =>
      candidate.qualifiedId === parsed.qualifiedId
    );
    assert(step, key);
    assertEquals(allocateStepKey(step, parsed.iterationPath), key);
  }
  assert(keys.includes("outer@0.setup"));
  assert(keys.includes("outer@8.fan.lane_c.inner@3.work"));
  assert(keys.includes("outer@5.fan.lane_b.inner@0.prep"));
});

Deno.test("allocateStepKey rejects a wrong depth or range and parseStepKey rejects junk", async () => {
  const result = await accepted(workflow([
    repeatNode({ id: "fix" }, {
      max: 3,
      seed: {
        steps: [fast("seeded")],
        outputs: { currentCandidate: { done: false } },
      },
      steps: [fast("body")],
    }),
    fast("after"),
  ]));
  const byId = (id: string) =>
    result.plan.steps.find((step) => step.qualifiedId === id)!;
  assertEquals(allocateStepKey(byId("fix.body"), [2]), "fix@2.body");
  assertEquals(allocateStepKey(byId("fix.seeded"), [0]), "fix@0.seeded");
  assertEquals(allocateStepKey(byId("after"), []), "after");
  for (
    const [id, path] of [
      ["fix.body", []],
      ["fix.body", [1, 1]],
      ["fix.body", [0]],
      ["fix.body", [4]],
      ["fix.body", [1.5]],
      ["fix.seeded", [1]],
      ["after", [1]],
    ] as [string, number[]][]
  ) {
    let thrown = false;
    try {
      allocateStepKey(byId(id), path);
    } catch (error) {
      thrown = error instanceof Error && error.name === "WorkflowStepKeyError";
    }
    assert(thrown, `${id} ${JSON.stringify(path)}`);
  }
  for (
    const bad of ["", "a", "Fix.body", "fix@x.body", "fix@01.body", "a..b"]
  ) {
    let thrown = false;
    try {
      parseStepKey(bad);
    } catch {
      thrown = true;
    }
    assert(thrown, bad);
  }
  assertEquals(parseStepKey("outer@3.inner@1.fan.lane_a.step"), {
    qualifiedId: "outer.inner.fan.lane_a.step",
    iterationPath: [3, 1],
  });
});

Deno.test("expandStepKeys refuses to exceed the step limit", async () => {
  const result = await accepted(workflow([repeatNode({}, { max: 2 })]));
  const [step] = result.plan.steps;
  assert(step);
  const big = {
    steps: [{
      ...step,
      loops: Array.from({ length: 4 }, () => ({
        repeat: "fix",
        max: 8,
        seed: false,
      })),
    }],
  };
  let thrown = false;
  try {
    expandStepKeys(big);
  } catch (error) {
    thrown = error instanceof Error && error.name === "WorkflowStepKeyError";
  }
  assert(thrown);
});

Deno.test("decoder reports forbidden keys and excessive depth", () => {
  const forbidden = decodeWorkflowJson('{"a":{"__proto__":1}}');
  assert(!forbidden.ok);
  assertEquals(forbidden.diagnostics[0]?.code, "definition_key_forbidden");
  const deep = decodeWorkflowJson("[".repeat(100));
  assert(!deep.ok);
  assertEquals(deep.diagnostics[0]?.code, "definition_too_deep");
  const snapshot = snapshotWorkflowValue({ constructor: 1 });
  assert(!snapshot.ok);
  assertEquals(snapshot.diagnostics[0]?.code, "definition_key_forbidden");
});

Deno.test("every closed diagnostic code is exercised by this suite", () => {
  // Collector-only codes are exercised through the collector directly.
  const collector = createDiagnosticCollector(1);
  collector.add("/a", "field_invalid");
  collector.add("/b", "field_unknown");
  for (const diagnostic of collector.list()) {
    exercisedCodes.add(diagnostic.code);
  }
  assertEquals(
    [...exercisedCodes].sort(),
    [...WORKFLOW_COMPILER_DIAGNOSTIC_CODES].sort(),
  );
});

// ---------------------------------------------------------------------------
// Review fixes: catalog-free flow rules, authored indexes, enums, costs.
// ---------------------------------------------------------------------------

Deno.test("a compile without a catalog still rejects flow and scope violations", async () => {
  const definition = workflow([
    { ...noop("aa"), if: "$step.bb.x == 1" },
    { ...noop("bb"), if: "$repeat.currentCandidate.x == 1" },
  ]);
  const expected = [
    { path: "/steps/0/if", code: "reference_future" },
    { path: "/steps/1/if", code: "reference_repeat_scope" },
  ];
  assertEquals(await diagnose(definition), expected);
  assertEquals(await diagnoseWith(definition), expected);
  // Reads of action outputs stay untyped without a catalog.
  await accepted(workflow([
    noop("aa"),
    { ...noop("bb"), if: "$step.aa.anything.at.all == 1" },
  ]));
});

Deno.test("needs and checks diagnostics point at the authored index", async () => {
  assertEquals(
    await diagnose(
      workflow([noop("aa"), { ...noop("bb"), needs: ["zz", "aa"] }]),
    ),
    [{ path: "/steps/1/needs/0", code: "needs_unknown" }],
  );
  assertEquals(
    await diagnose(workflow([
      noop("aa"),
      { ...noop("bb"), needs: ["aa", "zz"] },
    ])),
    [{ path: "/steps/1/needs/1", code: "needs_unknown" }],
  );
  assertEquals(
    await diagnoseWith(workflow([{ ...CHECK, checks: ["zzz", "lint"] }])),
    [{ path: "/steps/0/checks/0", code: "action_checks_invalid" }],
  );
  assertEquals(
    await diagnoseWith(
      workflow([{ ...CHECK, checks: ["test", "lint", "zzz"] }]),
    ),
    [{ path: "/steps/0/checks/2", code: "action_checks_invalid" }],
  );
});

Deno.test("input enums are duplicate-free string sets with sorted members", async () => {
  const withInput = (entry: unknown) =>
    workflow([noop("aa")], { inputs: { mode: entry } });
  assertEquals(
    await diagnose(
      withInput({ type: "boolean", required: true, enum: ["x", "x"] }),
    ),
    [{ path: "/inputs/mode/enum", code: "input_type_unsupported" }],
  );
  assertEquals(
    await diagnose(
      withInput({ type: "integer", required: true, enum: [1, 2] }),
    ),
    [{ path: "/inputs/mode/enum", code: "input_type_unsupported" }],
  );
  assertEquals(
    await diagnose(
      withInput({ type: "string", required: true, enum: ["x", "x"] }),
    ),
    [{ path: "/inputs/mode/enum", code: "field_invalid" }],
  );
  assertEquals(
    await diagnose(withInput({ type: "string", required: true, enum: [1] })),
    [{ path: "/inputs/mode/enum", code: "field_invalid" }],
  );
  const left = await accepted(
    withInput({ type: "string", required: true, enum: ["b", "a"] }),
  );
  const right = await accepted(
    withInput({ type: "string", required: true, enum: ["a", "b"] }),
  );
  assertEquals(left.digest, right.digest);
});

Deno.test("literals compared with an enum-typed operand must be members", async () => {
  const gated = (condition: string) =>
    workflow([
      { id: "ww", wait: { event: "task.status", timeout: "1h" } },
      { ...noop("after"), if: condition },
    ]);
  const bad = [
    '$step.ww.outcome == "elapsedd"',
    '"elapsedd" != $step.ww.outcome',
    '$step.ww.outcome in ["received", "typo"]',
    '$step.ww.event.status == "done"',
  ];
  for (const condition of bad) {
    assertEquals(
      await diagnoseWith(gated(condition)),
      [{ path: "/steps/1/if", code: "expression_operand_invalid" }],
      condition,
    );
  }
  for (
    const condition of [
      '$step.ww.outcome == "received"',
      '$step.ww.outcome in ["received", "timed_out"]',
      '$step.ww.event.status == "failed"',
    ]
  ) {
    const result = await compileWorkflowDocument(plain(gated(condition)), {
      catalog: createDesignCatalog(),
    });
    assert(result.ok, `${condition}: ${JSON.stringify(result)}`);
  }
  // The same typo in repeat.until is rejected instead of never exiting early.
  assertEquals(
    await diagnoseWith(workflow([
      { id: "ww", wait: { duration: "1m" } },
      repeatNode({ id: "fix" }, {
        until: '$step.ww.outcome == "elapsedd"',
      }),
    ])),
    [{ path: "/steps/1/repeat/until", code: "expression_operand_invalid" }],
  );
});

Deno.test("ordering comparisons skip the enum-literal membership rule", async () => {
  const gated = (condition: string) =>
    workflow([
      { id: "ww", wait: { event: "task.status", timeout: "1h" } },
      { ...noop("after"), if: condition },
    ]);
  const result = await compileWorkflowDocument(
    plain(gated('$step.ww.outcome < "zzz"')),
    { catalog: createDesignCatalog() },
  );
  assert(result.ok, JSON.stringify(result));
  // Equality against the same non-member still fails.
  assertEquals(
    await diagnoseWith(gated('$step.ww.outcome == "zzz"')),
    [{ path: "/steps/1/if", code: "expression_operand_invalid" }],
  );
});

Deno.test("cost ceilings must be whole micro-dollars", async () => {
  const paid = (id: string, cost: number) =>
    fast(id, { limits: { maxCostUsd: cost } });
  await accepted(workflow([paid("aa", 0.000001)]));
  assertEquals(
    await diagnose(workflow([paid("aa", 0.0000004)])),
    [{ path: "/steps/0/limits/maxCostUsd", code: "action_limits_invalid" }],
  );
  assertEquals(
    await diagnose(workflow([paid("aa", 0.1)], {
      limits: { maxCostUsd: 0.0000004 },
    })),
    [{ path: "/limits/maxCostUsd", code: "limits_invalid" }],
  );
});

Deno.test("worst-case cost compares at micro-dollar scale", async () => {
  const paid = (id: string, cost: number) =>
    fast(id, { limits: { maxCostUsd: cost } });
  await accepted(
    workflow([paid("aa", 0.1), paid("bb", 0.2)], {
      limits: { maxCostUsd: 0.3 },
    }),
  );
  assertEquals(
    await diagnose(
      workflow([paid("aa", 0.1), paid("bb", 0.2)], {
        limits: { maxCostUsd: 0.299999 },
      }),
    ),
    [{ path: "/limits", code: "expansion_cost_exceeded" }],
  );
});

Deno.test("event payload fields with secret names are sensitive", async () => {
  const catalog = createWorkflowCompilerCatalog({
    schemas: designSchemas,
    events: {
      "vault.opened": {
        payloadFields: { clientSecret: "string", note: "string" },
      },
    },
    taskSchema: {},
    checkNames: null,
    actionLimitFields: designLimitFields(),
  });
  const reader = (path: string) =>
    workflow([
      { id: "ww", wait: { event: "vault.opened", timeout: "1h" } },
      { ...noop("after"), if: `${path} == "x"` },
    ]);
  assertEquals(
    await diagnoseWith(reader("$step.ww.event.clientSecret"), catalog),
    [{ path: "/steps/1/if", code: "reference_secret_forbidden" }],
  );
  const ok = await compileWorkflowDocument(
    plain(reader("$step.ww.event.note")),
    { catalog },
  );
  assert(ok.ok, JSON.stringify(ok));
});

Deno.test("the default catalog is importable by package specifier", async () => {
  const module = await import(
    "@bakery/contracts/workflow-compiler/default-catalog"
  );
  assertEquals(
    module.defaultWorkflowCompilerCatalog,
    defaultWorkflowCompilerCatalog,
  );
});

Deno.test("cost ceilings that are not exact micro-dollars are rejected", async () => {
  const paid = (id: string, cost: number) =>
    fast(id, { limits: { maxCostUsd: cost } });
  for (const cost of [0.0000010000004, 4e-13]) {
    assertEquals(
      await diagnose(workflow([paid("aa", cost)])),
      [{ path: "/steps/0/limits/maxCostUsd", code: "action_limits_invalid" }],
      String(cost),
    );
  }
  await accepted(workflow([paid("aa", 0.1)]));
  await accepted(workflow([paid("aa", 9999.999999)]));
});

Deno.test("secret names match plurals, acronym runs and flattened forms", async () => {
  const { isSecretName } = await import(
    "../../packages/contracts/src/workflow-compiler/secrets.ts"
  );
  for (
    const name of [
      "apiKeys",
      "accessTokens",
      "privateKeys",
      "XApiKey",
      "DBPASSWORD",
      "dbpassword",
      "secrets",
      "passwords",
      "credentials",
      "db_password",
      "refreshToken",
    ]
  ) {
    assertEquals(isSecretName(name), true, name);
  }
  for (
    const name of ["target", "repository", "keyword", "tokenCount", "done"]
  ) {
    assertEquals(isSecretName(name), false, name);
  }
});

Deno.test("author-built types past the node ceiling report type_mismatch", async () => {
  const steps: unknown[] = [];
  for (let level = 0; level < 20; level += 1) {
    const prev = level === 0 ? { n: 1 } : `$step.b${level - 1}.xx`;
    steps.push({
      id: `b${level}`,
      branch: {
        when: "$input.target == 1",
        then: [fast(`t${level}`)],
        else: [fast(`e${level}`)],
        outputs: {
          xx: { then: { aa: prev, bb: prev }, else: { aa: prev, bb: prev } },
        },
      },
    });
  }
  const codes = (await diagnose(workflow(steps))).map((d) => d.code);
  assertEquals(codes.includes("type_mismatch"), true);
});
