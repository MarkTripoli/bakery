import { assert, assertEquals } from "@std/assert";
import { parseWorkflowExpression } from "../../packages/contracts/src/workflow-compiler/expression.ts";
import { isSecretName } from "../../packages/contracts/src/workflow-compiler/secrets.ts";
import { createDesignCatalog } from "../fixtures/workflow-compiler/design-catalog.ts";
import {
  compileWorkflowDocument,
  decodeWorkflowJson,
  snapshotWorkflowValue,
  WORKFLOW_COMPILER_MESSAGES,
  type WorkflowCompilerDiagnostic,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";

const SENTINEL = "SENTINEL-9f3a!@#$%^&*()secret";

function assertNoEcho(
  diagnostics: readonly WorkflowCompilerDiagnostic[],
): void {
  const serialized = JSON.stringify(diagnostics);
  assert(!serialized.includes("SENTINEL"), serialized);
  for (const diagnostic of diagnostics) {
    assert(
      Object.values(WORKFLOW_COMPILER_MESSAGES).includes(diagnostic.message),
    );
  }
}

Deno.test("__proto__ keys are rejected at every depth without pollution", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const texts = [
      `{"${key}":{"polluted":true}}`,
      `{"a":{"${key}":{"polluted":true}}}`,
      `{"a":[{"b":{"${key}":1}}]}`,
    ];
    for (const text of texts) {
      const decoded = decodeWorkflowJson(text);
      assert(!decoded.ok, text);
      assertEquals(decoded.diagnostics[0]?.code, "definition_key_forbidden");
      assertEquals(decoded.diagnostics[0]?.path.includes(key), false);
    }
  }
  const built = JSON.parse('{"a":{"__proto__":{"polluted":true}}}');
  const snapshot = snapshotWorkflowValue(built);
  assert(!snapshot.ok);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
  assertEquals(
    (Object.prototype as Record<string, unknown>).polluted,
    undefined,
  );
});

Deno.test("accessors are never invoked", () => {
  let calls = 0;
  const hostile = {
    get value() {
      calls += 1;
      return 1;
    },
  };
  const nested = {
    list: [
      Object.defineProperty({}, "x", {
        get: () => (calls += 1),
        enumerable: true,
      }),
    ],
  };
  const array: unknown[] = [];
  Object.defineProperty(array, 0, {
    get: () => (calls += 1),
    enumerable: true,
  });
  for (const input of [hostile, nested, array]) {
    const result = snapshotWorkflowValue(input);
    assert(!result.ok);
    assertEquals(result.diagnostics[0]?.code, "definition_value_unsupported");
  }
  assertEquals(calls, 0);
});

Deno.test("deep nesting terminates with one definition_too_deep", () => {
  const text = "[".repeat(100_000);
  // Bounded by the byte ceiling first, so build within it and nest past depth 64.
  const within = decodeWorkflowJson("[".repeat(100_000));
  assert(!within.ok);
  assertEquals(within.diagnostics.length, 1);
  assertEquals(within.diagnostics[0]?.code, "definition_too_deep");
  const oversized = decodeWorkflowJson(text + "]".repeat(100_000));
  assert(!oversized.ok);
  assertEquals(oversized.diagnostics.length, 1);
  assertEquals(oversized.diagnostics[0]?.code, "definition_too_large");
  const objects = decodeWorkflowJson('{"a":'.repeat(15_000));
  assert(!objects.ok);
  assertEquals(objects.diagnostics[0]?.code, "definition_too_deep");

  let value: unknown = 0;
  for (let index = 0; index < 100_000; index += 1) value = [value];
  const snapshot = snapshotWorkflowValue(value);
  assert(!snapshot.ok);
  assertEquals(snapshot.diagnostics.length, 1);
  assertEquals(snapshot.diagnostics[0]?.code, "definition_too_deep");
  let record: unknown = 0;
  for (let index = 0; index < 100_000; index += 1) record = { next: record };
  const recordSnapshot = snapshotWorkflowValue(record);
  assert(!recordSnapshot.ok);
  assertEquals(recordSnapshot.diagnostics.length, 1);
});

Deno.test("non-JSON and non-plain values are rejected", () => {
  class Hostile {
    value = 1;
  }
  const symbolKeyed = { [Symbol("k")]: 1 };
  for (
    const input of [
      new Hostile(),
      symbolKeyed,
      Object.create({ inherited: 1 }),
      () => 1,
      1n,
      undefined,
      Symbol("s"),
    ]
  ) {
    const result = snapshotWorkflowValue(input);
    assert(!result.ok);
    assertEquals(result.diagnostics[0]?.code, "definition_value_unsupported");
  }
});

Deno.test("sentinels in keys, numbers and tokens are never echoed", () => {
  const cases: unknown[] = [
    JSON.parse(`{"${SENTINEL}":{"__proto__":1}}`),
    { [SENTINEL]: 2 ** 60 },
    { a: { [SENTINEL]: [Number.NaN] } },
    { [SENTINEL]: new Date(0) },
  ];
  for (const input of cases) {
    const result = snapshotWorkflowValue(input);
    assert(!result.ok);
    assertNoEcho(result.diagnostics);
  }
  const texts = [
    `{"${SENTINEL}":1,"${SENTINEL}":2}`,
    `{"${SENTINEL}":1.00000000000000001}`,
    `{"${SENTINEL}": tru}`,
    `{"${SENTINEL}":"\\q"}`,
    `{"a":{"${SENTINEL}":[` + "[".repeat(100) + "]}}",
    `{"${SENTINEL}":${"9".repeat(80)}}`,
  ];
  for (const text of texts) {
    const result = decodeWorkflowJson(text);
    assert(!result.ok, text);
    assertNoEcho(result.diagnostics);
  }
});

Deno.test("oversized text is rejected before parsing", () => {
  const result = decodeWorkflowJson(`"${"x".repeat(1_000_000)}"`);
  assert(!result.ok);
  assertEquals(result.diagnostics.length, 1);
  assertEquals(result.diagnostics[0]?.code, "definition_too_large");
});

/** Relative file plus match text for each permitted type-position `import(`. Empty by design. */
const IMPORT_CALL_ALLOWLIST: readonly string[] = [];

async function listSources(root: URL, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory) {
      files.push(
        ...await listSources(
          new URL(`${entry.name}/`, root),
          `${prefix}${entry.name}/`,
        ),
      );
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files.sort();
}

Deno.test("no dynamic code execution anywhere in the compiler module", async () => {
  const forbidden = [
    /\b(eval|Function)\s*\(/,
    /\bnew\s+Function\b/,
    /\bimport\s*\(/,
    /\bRegExp\s*\(/,
    /\bsetTimeout\s*\(/,
    /\bwith\s*\(/,
  ];
  const root = new URL(
    "../../packages/contracts/src/workflow-compiler/",
    import.meta.url,
  );
  const files = await listSources(root);
  assert(files.includes("passes/flow.ts"), "scan must reach nested passes");
  assert(files.length >= 20, `scan saw only ${files.length} files`);
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, root));
    for (const pattern of forbidden) {
      const match = pattern.exec(source);
      if (match === null) continue;
      assert(
        pattern.source.includes("import") &&
          IMPORT_CALL_ALLOWLIST.includes(`${file}:${match[0]}`),
        `${file} matches ${pattern}`,
      );
    }
  }
  assertEquals(IMPORT_CALL_ALLOWLIST.length, 0);
});

Deno.test("hostile sentinels never reach diagnostics under eval and Function traps", async () => {
  const saved = { eval: globalThis.eval, Function: globalThis.Function };
  const calls: string[] = [];
  const trapped = globalThis as unknown as Record<string, unknown>;
  const known = new Set(Object.values(WORKFLOW_COMPILER_MESSAGES));
  try {
    trapped.eval = () => {
      calls.push("eval");
      throw new Error("trapped");
    };
    trapped.Function = function () {
      calls.push("Function");
      throw new Error("trapped");
    };
    const hostile = {
      apiVersion: `SENTINEL-v`,
      kind: "SENTINEL-kind",
      name: "SENTINEL-name",
      "SENTINEL-key": 1,
      inputs: { "SENTINEL-input": { type: "SENTINEL-type" } },
      steps: [
        {
          id: "SENTINEL-id",
          uses: "SENTINEL.action",
          with: {
            "SENTINEL-field": "$step.SENTINEL.x",
            other: "SENTINEL-text $input.SENTINEL",
          },
          if: "SENTINEL == 'SENTINEL' && ",
          needs: ["SENTINEL-need"],
        },
        { id: "w", wait: { event: "SENTINEL.event" } },
      ],
    };
    const texts = [JSON.stringify(hostile), "{SENTINEL", "SENTINEL"];
    for (const input of [hostile, ...texts]) {
      const result = await compileWorkflowDocument(input, {
        catalog: createDesignCatalog(),
      });
      assert(!result.ok);
      assertNoEcho(result.diagnostics);
      for (const diagnostic of result.diagnostics) {
        assert(known.has(diagnostic.message));
        assert(!diagnostic.path.includes("SENTINEL"));
      }
    }
  } finally {
    trapped.eval = saved.eval;
    trapped.Function = saved.Function;
  }
  assertEquals(calls, []);
});

const HANG_GUARD_MS = 60_000;

/** Runs a parse and asserts one bounded diagnostic; the guard only catches hangs. */
function assertBoundedFailure(text: string, code: string): void {
  const started = performance.now();
  const result = parseWorkflowExpression(text);
  assert(performance.now() - started < HANG_GUARD_MS, "parser hung");
  assert(!result.ok, "hostile expression was accepted");
  assertEquals(result.diagnostic.code, code);
  assertEquals(
    result.diagnostic.message,
    (WORKFLOW_COMPILER_MESSAGES as Record<string, string>)[code],
  );
  assert(result.work.tokens <= 1025, `tokens ${result.work.tokens}`);
  assert(result.work.nodes <= 129, `nodes ${result.work.nodes}`);
  assert(result.work.maxDepth <= 33, `depth ${result.work.maxDepth}`);
  assert(!JSON.stringify(result).includes("SENTINEL"));
}

Deno.test("a 1 MB expression is refused before tokenizing", () => {
  const text = "1".repeat(1_000_000);
  const result = parseWorkflowExpression(text);
  assert(!result.ok);
  assertEquals(result.diagnostic.code, "expression_too_long");
  assertEquals(result.work, { tokens: 0, nodes: 0, maxDepth: 0 });
  const padded = `${"SENTINEL ".repeat(200_000)}true`;
  assertBoundedFailure(padded, "expression_too_long");
});

Deno.test("deep nesting inside the length limit stops at the depth bound", () => {
  assertBoundedFailure("(".repeat(1000), "expression_too_deep");
  assertBoundedFailure("(".repeat(1024), "expression_too_deep");
  assertBoundedFailure(
    `${"(".repeat(500)}true${")".repeat(500)}`,
    "expression_too_deep",
  );
  assertBoundedFailure("!".repeat(1000), "expression_too_deep");
  assertBoundedFailure("! ".repeat(500) + "true", "expression_too_deep");
  assertBoundedFailure(
    `${"!(".repeat(300)}true${")".repeat(300)}`,
    "expression_too_deep",
  );
});

Deno.test("long connective chains stop at the length or node bound", () => {
  // 500 terms exceed the length limit, so they never reach the tokenizer.
  assertBoundedFailure(
    Array.from({ length: 500 }, () => "true").join(" && "),
    "expression_too_long",
  );
  assertBoundedFailure(
    Array.from({ length: 500 }, () => "1").join("&&"),
    "expression_too_long",
  );
  // Compact chains that fit in 1024 characters hit the node bound.
  assertBoundedFailure(
    Array.from({ length: 340 }, () => "1").join("&&"),
    "expression_too_many_nodes",
  );
  assertBoundedFailure(
    Array.from({ length: 340 }, () => "1").join("||"),
    "expression_too_many_nodes",
  );
  assertBoundedFailure(
    Array.from({ length: 170 }, () => "$a.b==1").join("&&").replaceAll(
      "$a",
      "$input",
    ).slice(0, 1024),
    "expression_too_many_nodes",
  );
});

Deno.test("oversized lists and hostile tokens fail with one bounded diagnostic", () => {
  assertBoundedFailure(
    `$input.a in [${Array.from({ length: 400 }, () => "1").join(",")}]`,
    "expression_list_too_long",
  );
  assertBoundedFailure("[".repeat(1000), "expression_syntax_invalid");
  assertBoundedFailure(`"${"\\".repeat(1000)}`, "expression_syntax_invalid");
  assertBoundedFailure("9".repeat(1000), "expression_number_invalid");
  assertBoundedFailure(`$input.${"a.".repeat(500)}a`, "reference_malformed");
  assertBoundedFailure("$".repeat(1000), "reference_malformed");
});

Deno.test("expression diagnostics never echo the expression", () => {
  const sentinelText = "SENTINEL-77!@#";
  const hostile = [
    `"${sentinelText}`,
    `$input.a == ${sentinelText}`,
    `$${sentinelText}.a`,
    `$secretSENTINEL.x`,
    `$input.SENTINEL.${sentinelText}`,
    `1${sentinelText}`,
    `[${sentinelText}]`,
    `${"(".repeat(40)}SENTINEL`,
    `"SENTINEL" == "SENTINEL" == 1`,
  ];
  for (const text of hostile) {
    const result = parseWorkflowExpression(text);
    assert(!result.ok, text);
    assert(!JSON.stringify(result).includes("SENTINEL"), text);
    assert(
      Object.values(WORKFLOW_COMPILER_MESSAGES).includes(
        result.diagnostic.message,
      ),
    );
  }
});

Deno.test("expressions are data: a quoted reference or code stays a string", () => {
  const traps: string[] = [];
  const realEval = globalThis.eval;
  const RealFunction = globalThis.Function;
  const fakeEval = ((): never => {
    traps.push("eval");
    throw new Error("eval trapped");
  }) as unknown as typeof eval;
  const fakeFunction = (() => {
    traps.push("Function");
    throw new Error("Function trapped");
  }) as unknown as FunctionConstructor;
  globalThis.eval = fakeEval;
  try {
    (globalThis as { Function: FunctionConstructor }).Function = fakeFunction;
    for (
      const text of [
        '"$input.x" == "$secret.y"',
        '"constructor" == "__proto__"',
        '$input.a == "process.exit(1)"',
        '"${1+1}" == "`x`"',
        '"alert(1)" in ["eval(\'x\')"]',
      ]
    ) {
      const result = parseWorkflowExpression(text);
      assert(result.ok, text);
    }
    // Code-shaped text outside a string is just a syntax error.
    for (
      const text of ["process.exit(1)", "constructor", "this", "a => a", "x()"]
    ) {
      const result = parseWorkflowExpression(text);
      assert(!result.ok, text);
    }
  } finally {
    globalThis.eval = realEval;
    (globalThis as { Function: FunctionConstructor }).Function = RealFunction;
  }
  assertEquals(traps, []);
});

// ---------------------------------------------------------------------------
// Phase 4: no-echo of submitted keys and values through the full compiler.
// ---------------------------------------------------------------------------

type Def = Record<string, unknown>;

function workflow(steps: unknown[], extra: Def = {}): Def {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: { target: { type: "string", required: true } },
    steps,
    ...extra,
  };
}

const action = (extra: Def = {}): Def => ({
  id: "first",
  uses: "workflow.noop",
  ...extra,
});

async function failures(definition: unknown) {
  const text = typeof definition === "string"
    ? definition
    : JSON.stringify(definition);
  const result = await compileWorkflowDocument(text);
  assert(!result.ok, "expected rejection");
  assertNoEcho(result.diagnostics);
  return result.diagnostics.map(({ path, code }) => ({ path, code }));
}

Deno.test("sentinels in workflow input names are rejected without echo", async () => {
  const found = await failures(
    workflow([action()], {
      inputs: { [SENTINEL]: { type: "string", required: true } },
    }),
  );
  assertEquals(found, [{ path: "/inputs", code: "input_name_invalid" }]);
});

Deno.test("sentinels in output names are rejected without echo", async () => {
  const branch = {
    id: "choose",
    branch: {
      when: "$input.target == 1",
      then: [action({ id: "on_prod" })],
      outputs: { [SENTINEL]: { then: "x" } },
    },
  };
  assertEquals(await failures(workflow([branch])), [{
    path: "/steps/0/branch/outputs",
    code: "output_name_invalid",
  }]);
  const parallel = {
    id: "fan",
    parallel: {
      maxConcurrency: 1,
      join: "all-required",
      failurePolicy: "stop-dependent",
      branches: [{
        id: "lane_a",
        repository: "main",
        steps: [action({ id: "work_a" })],
      }],
      outputs: { lane_a: { [SENTINEL]: "x" } },
    },
  };
  assertEquals(await failures(workflow([parallel])), [{
    path: "/steps/0/parallel/outputs/lane_a",
    code: "output_name_invalid",
  }]);
  const laneKey = {
    ...parallel,
    parallel: {
      ...parallel.parallel,
      outputs: { [SENTINEL]: { value: "x" } },
    },
  };
  assertEquals(await failures(workflow([laneKey])), [{
    path: "/steps/0/parallel/outputs",
    code: "parallel_lanes_invalid",
  }]);
});

Deno.test("sentinels in unknown keys, agents keys and identifiers are never echoed", async () => {
  assertEquals(
    await failures(workflow([action({ [SENTINEL]: 1 })])),
    [{ path: "/steps/0", code: "field_unknown" }],
  );
  assertEquals(
    await failures(workflow([action()], { [SENTINEL]: 1 })),
    [{ path: "", code: "field_unknown" }],
  );
  assertEquals(
    await failures(workflow([action()], {
      agents: { [SENTINEL]: "22222222-2222-4222-8222-222222222222" },
    })),
    [{ path: "/agents", code: "action_unknown" }],
  );
  assertEquals(
    await failures(workflow([action({ id: SENTINEL })])),
    [{ path: "/steps/0/id", code: "node_id_invalid" }],
  );
  assertEquals(
    await failures(workflow([action({ uses: SENTINEL })])),
    [{ path: "/steps/0/uses", code: "action_unknown" }],
  );
  assertEquals(
    await failures(workflow([action({ limits: { [SENTINEL]: 1 } })])),
    [{ path: "/steps/0/limits", code: "field_unknown" }],
  );
  assertEquals(
    await failures(workflow([action({ retry: { [SENTINEL]: 1 } })])),
    [{ path: "/steps/0/retry", code: "field_unknown" }],
  );
  assertEquals(
    await failures(workflow([action({ needs: [SENTINEL, SENTINEL] })])),
    [{ path: "/steps/0/needs", code: "needs_invalid" }],
  );
  assertEquals(
    await failures(workflow([action({ requires: [SENTINEL] })])),
    [{ path: "/steps/0/requires", code: "action_requires_invalid" }],
  );
  assertEquals(
    await failures(workflow([action({ timeout: SENTINEL })])),
    [{ path: "/steps/0/timeout", code: "duration_invalid" }],
  );
  assertEquals(
    await failures(
      workflow([{ id: "pause", wait: { event: SENTINEL, timeout: "1m" } }]),
    ),
    [{ path: "/steps/0/wait/event", code: "wait_shape_invalid" }],
  );
  assertEquals(
    await failures(workflow([action({ with: { a: `${SENTINEL} $input.x` } })])),
    [{ path: "/steps/0/with", code: "value_reference_ambiguous" }],
  );
  assertEquals(
    await failures(workflow([action({ with: { a: `$${SENTINEL}.x` } })])),
    [{ path: "/steps/0/with", code: "reference_malformed" }],
  );
  assertEquals(
    await failures(
      workflow([action({ effectKey: [SENTINEL, "$input.target"] })]),
    ),
    [{ path: "/steps/0/effectKey", code: "effect_key_invalid" }],
  );
  assertEquals(
    await failures(
      workflow([action({ if: `$input.target == "${SENTINEL}" &&` })]),
    ),
    [{ path: "/steps/0/if", code: "expression_syntax_invalid" }],
  );
});

Deno.test("unknown with keys and nested json keys are reported at the field, not the key", async () => {
  const unknownWithKey = await failures(
    workflow([
      action({ with: { ok: "$input.target", [SENTINEL]: "$bogus.x" } }),
    ]),
  );
  assertEquals(unknownWithKey, [{
    path: "/steps/0/with",
    code: "reference_root_unknown",
  }]);
  const nested = await failures(
    `{"apiVersion":"bakery.dev/v1","kind":"workflow","steps":[{"id":"first","uses":"integration.action","with":{"arguments":{"${SENTINEL}":{"deep":1},"__proto__":{"x":1}}}}]}`,
  );
  assertEquals(nested, [{
    path: "/steps/0/with",
    code: "definition_key_forbidden",
  }]);
  const nestedUnsafe = await failures(
    `{"apiVersion":"bakery.dev/v1","kind":"workflow","steps":[{"id":"first","uses":"integration.action","with":{"arguments":{"${SENTINEL}":{"constructor":1}}}}]}`,
  );
  assertEquals(nestedUnsafe, [{
    path: "/steps/0/with",
    code: "definition_key_forbidden",
  }]);
});

Deno.test("keys inside $literal content never reach a pointer", async () => {
  const text = (content: string) =>
    `{"apiVersion":"bakery.dev/v1","kind":"workflow","steps":[{"id":"first","uses":"workflow.noop","with":{"note":{"$literal":${content}}}}]}`;
  const forbidden = await failures(
    text(`{"${SENTINEL}":{"__proto__":1},"safeKey":{"constructor":2}}`),
  );
  for (const entry of forbidden) {
    assertEquals(entry.code, "definition_key_forbidden");
    assert(entry.path.startsWith("/steps/0/with"), entry.path);
    assert(!entry.path.includes("safeKey"), entry.path);
    assert(!entry.path.includes("$literal"), entry.path);
  }
  const deep = await failures(
    text(`{"${SENTINEL}":${"[".repeat(100)}${"]".repeat(100)}}`),
  );
  assertEquals(deep.map((entry) => entry.code), ["definition_too_deep"]);
  assert(!deep[0]!.path.includes("safeKey"));
  // Inside the literal, reference-looking text and reserved keys are inert.
  const literal = await compileWorkflowDocument(text(
    `{"$input":"$step.a.b","$oops":"$secret.x","text":"see $env.X"}`,
  ));
  assert(literal.ok, literal.ok ? "" : JSON.stringify(literal.diagnostics));
});

Deno.test("reserved dollar syntax outside a literal escape is rejected", async () => {
  assertEquals(
    await failures(workflow([action({ with: { a: { $oops: SENTINEL } } })])),
    [{ path: "/steps/0/with", code: "literal_reserved_key" }],
  );
  assertEquals(
    await failures(
      workflow([action({ with: { a: "$secret.token", b: "$env.HOME" } })]),
    ),
    [{ path: "/steps/0/with", code: "reference_secret_forbidden" }],
  );
});

Deno.test("secret-named workflow inputs are rejected at the inputs container", async () => {
  for (
    const name of [
      "password",
      "dbPassword",
      "apiKey",
      "privateKey",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "passphrase",
      "credential",
    ]
  ) {
    assertEquals(
      await failures(
        workflow([action()], {
          inputs: { [name]: { type: "string", required: true } },
        }),
      ),
      [{ path: "/inputs", code: "input_secret_forbidden" }],
      name,
    );
  }
});

Deno.test("hostile definitions compile to bounded diagnostics", async () => {
  const deepSequence = (levels: number) => {
    let node: Def = action({ id: "leaf" });
    for (let level = 0; level < levels; level += 1) {
      node = { id: `level${level}`, steps: [node] };
    }
    return node;
  };
  const tooDeep = await failures(workflow([deepSequence(20)]));
  assert(tooDeep.length <= 2, JSON.stringify(tooDeep));
  assertEquals(tooDeep[0]?.code, "node_depth_exceeded");
  const wide = await failures(
    workflow(
      Array.from({ length: 5000 }, (_, i) => action({ id: `step${i}` })),
    ),
  );
  assert(wide.length <= 101);
  const huge = await failures(
    workflow([action({ with: { a: "x".repeat(200_000) } })]),
  );
  assertEquals(huge, [{ path: "", code: "definition_too_large" }]);
  const manyErrors = await failures(
    workflow(
      Array.from(
        { length: 300 },
        (_, i) => ({ id: `step${i}`, uses: SENTINEL }),
      ),
    ),
  );
  assert(manyErrors.length <= 101);
  assertEquals(manyErrors.at(-1)?.code, "diagnostics_truncated");
  assertNoEcho([{
    path: "",
    code: "diagnostics_truncated",
    message: WORKFLOW_COMPILER_MESSAGES.diagnostics_truncated,
  }]);
});

Deno.test("compiling hostile input never invokes eval or Function", async () => {
  const realEval = globalThis.eval;
  const realFunction = globalThis.Function;
  let trapped = 0;
  const trap = () => {
    trapped += 1;
    throw new Error("dynamic code evaluation attempted");
  };
  (globalThis as { eval: unknown }).eval = trap;
  (globalThis as { Function: unknown }).Function = trap;
  try {
    const definitions: unknown[] = [
      workflow([
        action({
          with: { a: "$input.target", b: { $literal: "process.exit(1)" } },
          if: '$input.target == "`${1}`" || (1 < 2)',
        }),
      ]),
      workflow([action({ with: { a: "${constructor.constructor('x')()}" } })]),
      workflow([action({ with: { a: "__proto__" } })]),
    ];
    for (const definition of definitions) {
      await compileWorkflowDocument(JSON.stringify(definition));
    }
  } finally {
    (globalThis as { eval: unknown }).eval = realEval;
    (globalThis as { Function: unknown }).Function = realFunction;
  }
  assertEquals(trapped, 0);
});

// ---------------------------------------------------------------------------
// Phase 5a: catalog resolution is closed over secrets and never echoes input.
// ---------------------------------------------------------------------------

const SECRET_INPUT_SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string" },
    token: { type: "string", writeOnly: true },
    dbPassword: { type: "string" },
    apiKey: { type: "string" },
  },
  required: [],
  additionalProperties: false,
};

function secretCatalog() {
  return createDesignCatalog({ schemas: { EmptyInput: SECRET_INPUT_SCHEMA } });
}

function secretWorkflow(withValue: Record<string, unknown>) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: { target: { type: "string", required: true } },
    steps: [{ id: "first", uses: "workflow.noop", with: withValue }],
  };
}

async function reject(definition: unknown, catalog = secretCatalog()) {
  const result = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(definition)),
    { catalog },
  );
  assert(!result.ok, "expected rejection");
  return result.diagnostics;
}

Deno.test("values bound to writeOnly or secret-named fields are rejected", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["literal to a writeOnly field", { token: "plain" }, "token"],
    ["reference to a writeOnly field", { token: "$input.target" }, "token"],
    ["literal to a password field", { dbPassword: SENTINEL }, "dbPassword"],
    ["reference to an apiKey field", { apiKey: "$input.target" }, "apiKey"],
    [
      "escaped literal to a secret field",
      { apiKey: { $literal: SENTINEL } },
      "apiKey",
    ],
  ];
  for (const [name, withValue, field] of cases) {
    const diagnostics = await reject(secretWorkflow(withValue));
    assertEquals(
      diagnostics.map(({ path, code }) => ({ path, code })),
      [{ path: `/steps/0/with/${field}`, code: "input_secret_forbidden" }],
      name,
    );
    assertNoEcho(diagnostics);
  }
  // A non-sensitive sibling field is still accepted.
  const ok = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(secretWorkflow({ note: "fine" }))),
    { catalog: secretCatalog() },
  );
  assert(ok.ok, ok.ok ? "" : JSON.stringify(ok.diagnostics));
});

Deno.test("catalog diagnostics never echo submitted keys, checks, events or values", async () => {
  const hostile = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: { target: { type: "string", required: true } },
    steps: [
      {
        id: "first",
        uses: "quality.check",
        with: {
          repositoryId: "11111111-1111-4111-8111-111111111111",
          revision: SENTINEL,
          [SENTINEL]: { [SENTINEL]: SENTINEL },
        },
        checks: [SENTINEL, "lint"],
        limits: { maxFindings: 3 },
      },
      {
        id: "second",
        wait: { event: "no.such.event", timeout: "1h" },
      },
    ],
  };
  const diagnostics = await reject(hostile, createDesignCatalog());
  assertNoEcho(diagnostics);
  const codes = diagnostics.map(({ code }) => code).sort();
  assertEquals(codes, [
    "action_checks_invalid",
    "action_limits_invalid",
    "input_field_unknown",
    "wait_event_unknown",
  ]);
  for (const diagnostic of diagnostics) {
    assert(!diagnostic.path.includes("SENTINEL"), diagnostic.path);
  }
});

Deno.test("hostile prototype names resolve to nothing in the catalog", () => {
  const catalog = createDesignCatalog();
  for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
    assertEquals(catalog.resolveAction(name), undefined, name);
    assertEquals(catalog.event(name), undefined, name);
    assertEquals(catalog.limitFields(name), [], name);
  }
});

Deno.test("catalog resolution compiles no patterns and runs no eval", async () => {
  const trapped = {
    eval: globalThis.eval,
    Function: globalThis.Function,
    RegExp: globalThis.RegExp,
  };
  const calls: string[] = [];
  const catalog = createDesignCatalog({
    schemas: {
      EmptyInput: {
        type: "object",
        properties: {
          note: { type: "string", pattern: "([never-compiled" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });
  // Resolve once so lazy conversion happens inside the trap window.
  const definition = JSON.parse(JSON.stringify(secretWorkflow({ note: "x" })));
  try {
    (globalThis as unknown as Record<string, unknown>).eval = () => {
      calls.push("eval");
      throw new Error("eval trapped");
    };
    (globalThis as unknown as Record<string, unknown>).Function = function () {
      calls.push("Function");
      throw new Error("Function trapped");
    };
    const result = await compileWorkflowDocument(definition, { catalog });
    assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  } finally {
    (globalThis as unknown as Record<string, unknown>).eval = trapped.eval;
    (globalThis as unknown as Record<string, unknown>).Function =
      trapped.Function;
  }
  assertEquals(calls, []);
});

// ---------------------------------------------------------------------------
// Phase 5b: references never read secrets, echo input or walk the prototype.
// ---------------------------------------------------------------------------

const SECRET_OUTPUT_CATALOG = () =>
  createDesignCatalog({
    schemas: {
      EmptyOutput: {
        type: "object",
        properties: {
          note: { type: "string" },
          accessToken: { type: "string" },
          nested: {
            type: "object",
            properties: { dbPassword: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
          vault: { type: "string", writeOnly: true },
        },
        required: [],
        additionalProperties: false,
      },
      EmptyInput: {
        type: "object",
        properties: { note: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    },
  });

async function flowRejects(
  definition: unknown,
  catalog = createDesignCatalog(),
) {
  const result = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(definition)),
    { catalog },
  );
  assert(!result.ok, "expected rejection");
  assertNoEcho(result.diagnostics);
  return result.diagnostics.map(({ path, code }) => ({ path, code }));
}

Deno.test("secret and environment references are forbidden in every position", async () => {
  const roots = ["$secret.token", "$secrets.token", "$env.HOME", "$vault.key"];
  for (const root of roots) {
    assertEquals(
      await flowRejects(
        workflow([action({ with: { note: root } })]),
      ),
      [{ path: "/steps/0/with", code: "reference_secret_forbidden" }],
      root,
    );
    assertEquals(
      await flowRejects(
        workflow([action({ if: `${root} == "x"` })]),
      ),
      [{ path: "/steps/0/if", code: "reference_secret_forbidden" }],
      root,
    );
  }
  assertEquals(
    await flowRejects(workflow([
      action({
        uses: "delivery.deploy",
        with: { releaseId: "r", environment: "production" },
        effectKey: ["deploy", "$env.TOKEN"],
      }),
    ])),
    [{ path: "/steps/0/effectKey", code: "reference_secret_forbidden" }],
  );
});

Deno.test("sensitive output fields cannot be read", async () => {
  const catalog = SECRET_OUTPUT_CATALOG();
  const reader = (path: string): unknown =>
    workflow([
      action({ id: "source" }),
      action({ id: "reader", if: `${path} == "x"` }),
    ]);
  for (
    const path of [
      "$step.source.accessToken",
      "$step.source.nested.dbPassword",
      "$step.source.vault",
    ]
  ) {
    assertEquals(
      await flowRejects(reader(path), catalog),
      [{ path: "/steps/1/if", code: "reference_secret_forbidden" }],
      path,
    );
  }
  // A neighbouring non-sensitive field is still readable.
  const ok = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(reader("$step.source.note"))),
    { catalog },
  );
  assert(ok.ok, ok.ok ? "" : JSON.stringify(ok.diagnostics));
});

const LIST_SECRET_CATALOG = () =>
  createDesignCatalog({
    schemas: {
      EmptyOutput: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                note: { type: "string" },
                apiKey: { type: "string" },
              },
              required: [],
              additionalProperties: false,
            },
          },
          maybe: {
            anyOf: [{
              type: "object",
              properties: { clientSecret: { type: "string" } },
              required: [],
              additionalProperties: false,
            }, { type: "null" }],
          },
        },
        required: [],
        additionalProperties: false,
      },
      EmptyInput: {
        type: "object",
        properties: { note: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    },
  });

/** A reference placed in each position that could carry a value onward. */
function sinks(reference: string): [string, Def][] {
  const source = action({ id: "source" });
  return [
    [
      "json with field",
      workflow([
        source,
        action({
          id: "reader",
          uses: "integration.action",
          with: {
            actionId: "notify",
            actionVersion: 1,
            resourceId: "00000000-0000-4000-8000-000000000000",
            arguments: reference,
          },
          effectKey: ["notify", "$input.keyId"],
        }),
      ], {
        inputs: {
          target: { type: "string", required: true },
          keyId: { type: "uuid", required: true },
        },
      }),
    ],
    [
      "condition",
      workflow([source, action({ id: "reader", if: `${reference} == "x"` })]),
    ],
    [
      "seed candidate",
      workflow([source, {
        id: "fix",
        repeat: {
          max: 2,
          seed: { currentCandidate: { copy: reference, done: false } },
          until: "$repeat.currentCandidate.done == true",
          steps: [action({ id: "try_one" })],
          outputs: { currentCandidate: { copy: "x", done: false } },
        },
      }]),
    ],
    [
      "branch export",
      workflow([source, {
        id: "choose",
        branch: {
          when: '$input.target == "prod"',
          then: [action({ id: "on_prod" })],
          outputs: { copy: { then: reference } },
        },
      }]),
    ],
    [
      "lane export",
      workflow([source, {
        id: "fan",
        parallel: {
          maxConcurrency: 1,
          join: "all-required",
          failurePolicy: "stop-dependent",
          branches: [{
            id: "lane_a",
            repository: "main",
            steps: [action({ id: "a_step" })],
          }],
          outputs: { lane_a: { copy: reference } },
        },
      }]),
    ],
  ];
}

Deno.test("whole and nested reads of a sensitive value are forbidden in every sink", async () => {
  const cases: [
    string,
    () => ReturnType<typeof createDesignCatalog>,
    string[],
  ][] = [
    ["secret object", SECRET_OUTPUT_CATALOG, [
      "$step.source",
      "$step.source.nested",
      "$step.source.nested.dbPassword",
    ]],
    ["list of objects", LIST_SECRET_CATALOG, [
      "$step.source",
      "$step.source.rows",
    ]],
    ["nullable object", LIST_SECRET_CATALOG, ["$step.source.maybe"]],
  ];
  for (const [label, makeCatalog, references] of cases) {
    for (const reference of references) {
      for (const [sink, definition] of sinks(reference)) {
        // Missing integration fields are unrelated noise; only the reference
        // verdict matters here.
        const found = (await flowRejects(definition, makeCatalog())).filter(
          (entry) => entry.code.startsWith("reference_"),
        );
        assert(found.length >= 1, `${label} ${reference} ${sink}`);
        assertEquals(
          found.every((entry) => entry.code === "reference_secret_forbidden"),
          true,
          `${label} ${reference} ${sink}: ${JSON.stringify(found)}`,
        );
      }
    }
  }
  // A clean sibling still flows into every sink.
  for (const [sink, definition] of sinks("$step.source.note")) {
    const ok = await compileWorkflowDocument(
      JSON.parse(JSON.stringify(definition)),
      { catalog: SECRET_OUTPUT_CATALOG() },
    );
    assert(ok.ok, `${sink}: ${ok.ok ? "" : JSON.stringify(ok.diagnostics)}`);
  }
});

Deno.test("secret-named segments are forbidden when no catalog types the read", async () => {
  const reads = [
    "$step.aa.apiKey",
    "$step.aa.config.clientSecret",
    "$task.password",
    "$step.ww.event.clientSecret",
  ];
  for (const read of reads) {
    const result = await compileWorkflowDocument(
      JSON.parse(JSON.stringify(workflow([
        action({ id: "aa" }),
        { id: "ww", wait: { event: "task.status", timeout: "1h" } },
        action({ id: "reader", if: `${read} == "x"` }),
      ]))),
    );
    assert(!result.ok, read);
    assertNoEcho(result.diagnostics);
    assertEquals(
      result.diagnostics.map((entry) => entry.code),
      ["reference_secret_forbidden"],
      read,
    );
  }
  const bound = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(workflow([action({ with: { password: "x" } })]))),
  );
  assert(!bound.ok);
  assertEquals(
    bound.diagnostics.map(({ path, code }) => ({ path, code })),
    [{ path: "/steps/0/with", code: "input_secret_forbidden" }],
  );
});

Deno.test("authored candidate fields and export names with secret words are not readable", async () => {
  const catalog = createDesignCatalog();
  const seeded = (field: string, read: string): Def =>
    workflow([{
      id: "fix",
      repeat: {
        max: 2,
        seed: { currentCandidate: { [field]: "v", done: false } },
        until: `${read} == "v"`,
        steps: [action({ id: "try_one" })],
        outputs: { currentCandidate: { [field]: "w", done: false } },
      },
    }]);
  for (
    const read of [
      "$repeat.currentCandidate.apiKey",
      "$repeat.currentCandidate",
    ]
  ) {
    const found = await flowRejects(seeded("apiKey", read), catalog);
    assert(found.some((entry) => entry.code === "reference_secret_forbidden"));
  }
  const afterLoop = workflow([
    {
      id: "fix",
      repeat: {
        max: 2,
        seed: { currentCandidate: { apiKey: "v", done: false } },
        until: "$repeat.currentCandidate.done == true",
        steps: [action({ id: "try_one" })],
        outputs: { currentCandidate: { apiKey: "w", done: false } },
      },
    },
    action({ id: "reader", if: '$step.fix.currentCandidate.apiKey == "v"' }),
  ]);
  assertEquals(
    (await flowRejects(afterLoop, catalog)).map((entry) => entry.code),
    ["reference_secret_forbidden"],
  );
  const exported = workflow([
    {
      id: "choose",
      branch: {
        when: '$input.target == "prod"',
        then: [action({ id: "on_prod" })],
        outputs: { clientSecret: { then: "x" } },
      },
    },
    action({ id: "reader", if: '$step.choose.clientSecret == "x"' }),
  ]);
  assertEquals(
    (await flowRejects(exported, catalog)).map((entry) => entry.code),
    ["reference_secret_forbidden"],
  );
});

Deno.test("references with hostile segment names resolve to plain diagnostics", async () => {
  const names = [
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ];
  for (const name of names) {
    for (
      const path of [
        `$step.${name}.x`,
        `$step.source.${name}`,
        `$input.${name}`,
        `$task.${name}`,
      ]
    ) {
      const found = await flowRejects(
        workflow([
          action({ id: "source" }),
          action({ id: "reader", if: `${path} == "x"` }),
        ]),
      );
      assertEquals(found.length, 1, path);
      assert(
        [
          "reference_step_unknown",
          "reference_field_unknown",
          "reference_input_unknown",
        ].includes(found[0]!.code),
        `${path} ${found[0]!.code}`,
      );
    }
  }
  for (
    const text of ["$step.__proto__.x", "$input.__proto__", "$step.a.__proto__"]
  ) {
    assertEquals(
      await flowRejects(workflow([action({ if: `${text} == "x"` })])),
      [{ path: "/steps/0/if", code: "reference_malformed" }],
      text,
    );
  }
  assertEquals(
    ({} as Record<string, unknown>).polluted,
    undefined,
  );
});

Deno.test("resolution failures never echo the reference text", async () => {
  const tail = "Q9zSentinelLongSegment";
  const probes: [string, string][] = [
    [`$step.SENTINEL${tail}.value`, "reference_step_unknown"],
    [`$input.SENTINEL${tail}`, "reference_input_unknown"],
    [`$task.SENTINEL${tail}`, "reference_field_unknown"],
    [`$step.source.SENTINEL${tail}`, "reference_field_unknown"],
    [`$repeat.SENTINEL${tail}`, "reference_repeat_scope"],
  ];
  for (const [path, code] of probes) {
    const found = await flowRejects(workflow([
      action({ id: "source" }),
      action({ id: "reader", if: `${path} == "x"` }),
    ]));
    assertEquals(found, [{ path: "/steps/1/if", code }], path);
  }
  // Unsafe characters in a path fail the expression grammar, never echoed.
  assertEquals(
    await flowRejects(workflow([action({
      if: `$step.${SENTINEL}.x == "x"`,
    })])),
    [{ path: "/steps/0/if", code: "expression_syntax_invalid" }],
  );
});

Deno.test("flow checks stay bounded for wide and deep documents", async () => {
  const verify = {
    id: "verify",
    uses: "quality.check",
    with: { repositoryId: "$input.repositoryId", revision: "abc" },
    checks: ["lint"],
    timeout: "1m",
  };
  // 190 chained steps, each needing the previous one and reading it.
  const chain = (evidence: string): unknown[] => {
    const steps: unknown[] = [verify];
    for (let index = 0; index < 190; index += 1) {
      const previous = index === 0 ? "verify" : `step_${index - 1}`;
      steps.push({
        id: `step_${index}`,
        needs: [previous],
        uses: "review.independent",
        timeout: "1m",
        with: { revision: `$step.${previous}.headSha`, evidence },
        if:
          `$step.verify.allRequired == true || $step.verify.headSha != "${index}"`,
      });
    }
    return steps;
  };
  const run = async (steps: unknown[]) => {
    const started = performance.now();
    const result = await compileWorkflowDocument(
      JSON.parse(JSON.stringify(workflow(steps, {
        inputs: { repositoryId: { type: "uuid", required: true } },
      }))),
      { catalog: createDesignCatalog() },
    );
    const elapsed = performance.now() - started;
    assert(elapsed < 20_000, `took ${elapsed}ms`);
    assertNoEcho(result.diagnostics);
    return result;
  };
  const valid = await run(chain("$step.verify.checkRunIds"));
  assert(
    valid.ok,
    valid.ok ? "" : JSON.stringify(valid.diagnostics.slice(0, 3)),
  );
  // Every step is wrong: findings are capped, with one truncation marker.
  const broken = await run(chain("$step.verify.nope"));
  assert(!broken.ok);
  assertEquals(broken.diagnostics.length, 101);
  assertEquals(broken.diagnostics[100]?.code, "diagnostics_truncated");
  assert(
    broken.diagnostics.slice(0, 100).every((diagnostic) =>
      diagnostic.code === "reference_field_unknown"
    ),
  );
});

Deno.test("reference resolution compiles no code", async () => {
  const calls: string[] = [];
  const saved = { eval: globalThis.eval, Function: globalThis.Function };
  try {
    (globalThis as unknown as Record<string, unknown>).eval = () => {
      calls.push("eval");
      throw new Error("trapped");
    };
    (globalThis as unknown as Record<string, unknown>).Function = function () {
      calls.push("Function");
      throw new Error("trapped");
    };
    const result = await compileWorkflowDocument(
      JSON.parse(JSON.stringify(workflow([
        {
          id: "verify",
          uses: "quality.check",
          with: { repositoryId: "$input.repositoryId", revision: "abc" },
          checks: ["lint"],
        },
        {
          id: "after",
          uses: "review.independent",
          with: {
            revision: "$step.verify.headSha",
            evidence: "$step.verify.checkRunIds",
          },
          if: '$step.verify.allRequired == true && $task.status in ["active"]',
        },
      ], { inputs: { repositoryId: { type: "uuid", required: true } } }))),
      { catalog: createDesignCatalog() },
    );
    assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  } finally {
    (globalThis as unknown as Record<string, unknown>).eval = saved.eval;
    (globalThis as unknown as Record<string, unknown>).Function =
      saved.Function;
  }
  assertEquals(calls, []);
});

// ---------------------------------------------------------------------------
// Value slots: alphanumeric submitted keys never reach a pointer.
// ---------------------------------------------------------------------------

const KEY = "hunterPassword2";

function leaked(result: Awaited<ReturnType<typeof compileWorkflowDocument>>) {
  assert(!result.ok, "expected rejection");
  return JSON.stringify(result.diagnostics).includes(KEY);
}

/** Each probe holds `KEY` as an authored key below a value slot. */
function keyProbes(bad: unknown): [string, Def][] {
  const candidate = { [KEY]: { deep: bad } };
  return [
    [
      "with field",
      workflow([action({
        uses: "integration.action",
        with: { arguments: candidate },
      })]),
    ],
    [
      "with unknown field",
      workflow([action({ with: { [KEY]: bad } })]),
    ],
    [
      "repeat seed mapping",
      workflow([{
        id: "fix",
        repeat: {
          max: 2,
          seed: { currentCandidate: candidate },
          until: "$repeat.currentCandidate.done == true",
          steps: [action({ id: "try_one" })],
          outputs: { currentCandidate: { done: false } },
        },
      }]),
    ],
    [
      "repeat seed sequence",
      workflow([{
        id: "fix",
        repeat: {
          max: 2,
          seed: {
            steps: [action({ id: "seeded" })],
            outputs: { currentCandidate: candidate },
          },
          until: "$repeat.currentCandidate.done == true",
          steps: [action({ id: "try_one" })],
          outputs: { currentCandidate: { done: false } },
        },
      }]),
    ],
    [
      "repeat outputs",
      workflow([{
        id: "fix",
        repeat: {
          max: 2,
          seed: { currentCandidate: { done: false } },
          until: "$repeat.currentCandidate.done == true",
          steps: [action({ id: "try_one" })],
          outputs: { currentCandidate: candidate },
        },
      }]),
    ],
    [
      "branch outputs",
      workflow([{
        id: "choose",
        branch: {
          when: '$input.target == "prod"',
          then: [action({ id: "on_prod" })],
          else: [action({ id: "on_dev" })],
          outputs: { picked: { then: candidate, else: candidate } },
        },
      }]),
    ],
    [
      "parallel outputs",
      workflow([{
        id: "fan",
        parallel: {
          maxConcurrency: 1,
          join: "all-required",
          failurePolicy: "stop-dependent",
          branches: [{
            id: "lane_a",
            repository: "main",
            steps: [action({ id: "work_a" })],
          }],
          outputs: { lane_a: { result: candidate } },
        },
      }]),
    ],
  ];
}

Deno.test("alphanumeric keys below a value slot never enter a pointer (object path)", async () => {
  for (const bad of [Infinity, "$bogus.x", { $oops: 1 }]) {
    for (const [name, definition] of keyProbes(bad)) {
      const result = await compileWorkflowDocument(definition);
      assertEquals(leaked(result), false, `${name}: ${String(bad)}`);
    }
  }
  const userKey = await compileWorkflowDocument(
    workflow([action({ with: { userKey: "$bogus.x" } })]),
  );
  assertEquals(leaked(userKey), false);
  assert(!userKey.ok);
  assertEquals(userKey.diagnostics[0]?.path, "/steps/0/with");
});

Deno.test("alphanumeric keys below a value slot never enter a pointer (JSON text path)", async () => {
  const cases: [string, string][] = [
    ["inexact number", "1.00000000000000001"],
    ["unsafe key", '{"__proto__":1}'],
    ["reference", '"$bogus.x"'],
    ["reserved key", '{"$oops":1}'],
  ];
  for (const [label, bad] of cases) {
    for (const [name] of keyProbes(null)) {
      const json = keyProbeText(name, bad);
      const result = await compileWorkflowDocument(json);
      assertEquals(leaked(result), false, `${name}: ${label}`);
    }
  }
  const duplicate = await compileWorkflowDocument(
    `{"apiVersion":"bakery.dev/v1","kind":"workflow","steps":[{"id":"first","uses":"integration.action","with":{"arguments":{"${KEY}":1,"${KEY}":2}}}]}`,
  );
  assert(!duplicate.ok);
  assertEquals(leaked(duplicate), false);
  assertEquals(duplicate.diagnostics[0]?.code, "definition_duplicate_key");
});

const HUNTER = "hunterPassword2";

/** Definitions that carry the submitted key and a snapshot-failing value. */
function structuralKeyProbes(bad: unknown): [string, Def][] {
  return [
    [
      "effectKey part",
      workflow([action({
        uses: "delivery.deploy",
        with: { releaseId: "r", environment: "production" },
        effectKey: ["deploy", { [HUNTER]: bad }],
      })]),
    ],
    ["agents key", workflow([action()], { agents: { [HUNTER]: bad } })],
    ["unknown step key", workflow([action({ [HUNTER]: { x: bad } })])],
    ["unknown root key", workflow([action()], { [HUNTER]: { x: bad } })],
  ];
}

Deno.test("submitted keys in effectKey, agents and unknown positions never enter a pointer (object path)", async () => {
  for (const [name, definition] of structuralKeyProbes(Infinity)) {
    const result = await compileWorkflowDocument(definition);
    assert(!result.ok, name);
    assertEquals(
      JSON.stringify(result.diagnostics).includes(HUNTER),
      false,
      name,
    );
  }
});

Deno.test("submitted keys in effectKey, agents and unknown positions never enter a pointer (JSON text path)", async () => {
  const marker = '"__BAD__"';
  for (const [name] of structuralKeyProbes("__BAD__")) {
    const probe = structuralKeyProbes("__BAD__").find(([label]) =>
      label === name
    )![1];
    const text = JSON.stringify(probe).replace(marker, "1.00000000000000001");
    const result = await compileWorkflowDocument(text);
    assert(!result.ok, name);
    assertEquals(
      JSON.stringify(result.diagnostics).includes(HUNTER),
      false,
      name,
    );
  }
});

/** JSON text of a probe whose deepest value is the raw JSON text `bad`. */
function keyProbeText(name: string, bad: string): string {
  const marker = '"__BAD__"';
  const probe = keyProbes("__BAD__").find(([label]) => label === name)![1];
  return JSON.stringify(probe).replace(marker, bad);
}

Deno.test("oversized value lists report a diagnostic instead of throwing", async () => {
  const items = Array.from({ length: 1001 }, () => "$input.target");
  for (const catalog of [undefined, createDesignCatalog()]) {
    const result = await compileWorkflowDocument(
      workflow([action({
        uses: "integration.action",
        with: { arguments: items },
      })]),
      { catalog },
    );
    assert(!result.ok);
    assert(
      result.diagnostics.some((entry) => entry.code === "field_invalid"),
      JSON.stringify(result.diagnostics),
    );
    assertNoEcho(result.diagnostics);
  }
});

// ---------------------------------------------------------------------------
// Declared-name positions: only names that match their shape pattern enter a
// pointer, and only at the exact position.
// ---------------------------------------------------------------------------

const BRANCH_BODY = {
  when: '$input.target == "prod"',
  then: [action({ id: "on_prod" })],
  else: [action({ id: "on_dev" })],
};

function declaredNameProbes(bad: unknown = { deep: 1 }): [string, Def][] {
  const repeat = (extra: Def): Def => ({
    id: "fix",
    repeat: {
      max: 2,
      seed: { currentCandidate: { done: false } },
      until: "$repeat.currentCandidate.done == true",
      steps: [action({ id: "try_one" })],
      outputs: { currentCandidate: { done: false } },
      ...extra,
    },
  });
  return [
    [
      "unknown repeat.outputs key",
      workflow([repeat({
        outputs: { currentCandidate: { done: false }, [HUNTER]: bad },
      })]),
    ],
    [
      "unknown seed.outputs key",
      workflow([repeat({
        seed: {
          steps: [action({ id: "seeded" })],
          outputs: { currentCandidate: { done: false }, [HUNTER]: bad },
        },
      })]),
    ],
    [
      "unknown branch arm",
      workflow([{
        id: "choose",
        branch: {
          ...BRANCH_BODY,
          outputs: { picked: { then: "x", [HUNTER]: bad } },
        },
      }]),
    ],
    [
      "underscore input name",
      workflow([action()], {
        inputs: {
          target: { type: "string" },
          hunter_pw2: bad,
        },
      }),
    ],
    [
      "underscore output name",
      workflow([{
        id: "choose",
        branch: {
          ...BRANCH_BODY,
          outputs: { hunter_pw2: { then: bad } },
        },
      }]),
    ],
    [
      "underscore lane export name",
      workflow([{
        id: "fan",
        parallel: {
          maxConcurrency: 1,
          join: "all-required",
          failurePolicy: "stop-dependent",
          branches: [{
            id: "lane_a",
            repository: "main",
            steps: [action({ id: "work_a" })],
          }],
          outputs: { lane_a: { hunter_pw2: bad } },
        },
      }]),
    ],
  ];
}

Deno.test("hostile keys at declared-name positions never enter a pointer", async () => {
  for (const [name, definition] of declaredNameProbes()) {
    for (const input of [definition, JSON.stringify(definition)]) {
      const result = await compileWorkflowDocument(input, {
        catalog: createDesignCatalog(),
      });
      assert(!result.ok, name);
      const text = JSON.stringify(result.diagnostics);
      assertEquals(text.includes("hunterPassword2"), false, name);
      assertEquals(text.includes("hunter_pw2"), false, name);
    }
  }
});

/**
 * A declared-name position rebuilt from fixed names outside any step node
 * (root, `ui`, `limits`) must truncate at the last real position. Each value
 * fails the decoder (INEXACT on text, Infinity on objects), so the pointer is
 * built at the hostile key itself.
 */
function rebuiltPositionProbes(
  bad: unknown,
): [string, Def, string, string][] {
  return [
    [
      "root branch outputs",
      workflow([action()], { branch: { outputs: { [HUNTER]: bad } } }),
      "/branch/outputs",
      HUNTER,
    ],
    [
      "root parallel lane export",
      workflow([action()], {
        parallel: { outputs: { lane_a: { [HUNTER]: bad } } },
      }),
      "/parallel/outputs",
      HUNTER,
    ],
    [
      "node ui branch outputs",
      workflow([action({ ui: { branch: { outputs: { [HUNTER]: bad } } } })]),
      "/steps/0/ui/branch/outputs",
      HUNTER,
    ],
    [
      "limits branch outputs",
      workflow([action()], {
        limits: { branch: { outputs: { [HUNTER]: bad } } },
      }),
      "/limits/branch/outputs",
      HUNTER,
    ],
    [
      "root parallel lane id",
      workflow([action()], { parallel: { outputs: { hunter_pw2: bad } } }),
      "/parallel/outputs",
      "hunter_pw2",
    ],
    [
      "root repeat seed outputs",
      workflow([action()], {
        repeat: { seed: { outputs: { [HUNTER]: bad } } },
      }),
      "/repeat/seed/outputs",
      HUNTER,
    ],
    [
      "root repeat outputs",
      workflow([action()], { repeat: { outputs: { [HUNTER]: bad } } }),
      "/repeat/outputs",
      HUNTER,
    ],
  ];
}

const DECLARED_NAME_POINTERS: readonly string[] = [
  "/steps/0/repeat/outputs",
  "/steps/0/repeat/seed/outputs",
  "/steps/0/branch/outputs/picked",
  "/inputs",
  "/steps/0/branch/outputs",
  "/steps/0/parallel/outputs/lane_a",
];

Deno.test("hostile declared-name keys truncate at the exact pointer (object path)", async () => {
  const probes = declaredNameProbes(Infinity);
  assertEquals(probes.length, DECLARED_NAME_POINTERS.length);
  for (const [index, [name, definition]] of probes.entries()) {
    const result = await compileWorkflowDocument(definition);
    assert(!result.ok, name);
    assertEquals(
      result.diagnostics.map((d) => d.path),
      [DECLARED_NAME_POINTERS[index]],
      name,
    );
  }
});

Deno.test("hostile declared-name keys truncate at the exact pointer (JSON text path)", async () => {
  const probes = declaredNameProbes("__BAD__");
  for (const [index, [name, definition]] of probes.entries()) {
    const text = JSON.stringify(definition).replace(
      '"__BAD__"',
      "1.00000000000000001",
    );
    const result = await compileWorkflowDocument(text);
    assert(!result.ok, name);
    assertEquals(
      result.diagnostics.map((d) => d.path),
      [DECLARED_NAME_POINTERS[index]],
      name,
    );
  }
});

Deno.test("declared-name positions rebuilt outside a step node truncate (object path)", async () => {
  for (
    const [name, definition, pointer, key] of rebuiltPositionProbes(Infinity)
  ) {
    const result = await compileWorkflowDocument(definition);
    assert(!result.ok, name);
    assertEquals(result.diagnostics.map((d) => d.path), [pointer], name);
    assertEquals(JSON.stringify(result.diagnostics).includes(key), false, name);
  }
});

Deno.test("declared-name positions rebuilt outside a step node truncate (JSON text path)", async () => {
  const marker = '"__BAD__"';
  for (
    const [name, definition, pointer, key] of rebuiltPositionProbes("__BAD__")
  ) {
    const text = JSON.stringify(definition).replace(
      marker,
      "1.00000000000000001",
    );
    const result = await compileWorkflowDocument(text);
    assert(!result.ok, name);
    assertEquals(result.diagnostics.map((d) => d.path), [pointer], name);
    assertEquals(JSON.stringify(result.diagnostics).includes(key), false, name);
  }
});

Deno.test("real declared-name positions still extend the pointer", async () => {
  const bad = Infinity;
  const nested = await compileWorkflowDocument(workflow([{
    id: "choose",
    branch: {
      ...BRANCH_BODY,
      then: [{
        id: "inner",
        branch: {
          ...BRANCH_BODY,
          then: [action({ id: "i_a" })],
          else: [action({ id: "i_b" })],
          outputs: { picked: { then: bad, else: "y" } },
        },
      }],
    },
  }]));
  assert(!nested.ok);
  assertEquals(
    nested.diagnostics[0]?.path,
    "/steps/0/branch/then/0/branch/outputs/picked/then",
  );
});

Deno.test("declared names extend the pointer under sequence, repeat, seed and lane nesting", async () => {
  const innerBranch = (bad: unknown): Def => ({
    id: "choose",
    branch: {
      ...BRANCH_BODY,
      outputs: { picked: { then: bad, else: "y" } },
    },
  });
  const forms = (bad: unknown): [string, Def, string][] => [
    [
      "sequence child",
      { id: "seq", steps: [innerBranch(bad)] },
      "/steps/0/steps/0/branch/outputs/picked/then",
    ],
    [
      "repeat body",
      {
        id: "fix",
        repeat: {
          max: 2,
          seed: { currentCandidate: { done: false } },
          until: "$repeat.currentCandidate.done == true",
          steps: [innerBranch(bad)],
          outputs: { currentCandidate: { done: false } },
        },
      },
      "/steps/0/repeat/steps/0/branch/outputs/picked/then",
    ],
    [
      "repeat seed steps",
      {
        id: "fix",
        repeat: {
          max: 2,
          seed: {
            steps: [innerBranch(bad)],
            outputs: { currentCandidate: { done: false } },
          },
          until: "$repeat.currentCandidate.done == true",
          steps: [action({ id: "try_one" })],
          outputs: { currentCandidate: { done: false } },
        },
      },
      "/steps/0/repeat/seed/steps/0/branch/outputs/picked/then",
    ],
    [
      "lane steps",
      {
        id: "fan",
        parallel: {
          maxConcurrency: 1,
          join: "all-required",
          failurePolicy: "stop-dependent",
          branches: [{
            id: "lane_a",
            repository: "main",
            steps: [innerBranch(bad)],
          }],
          outputs: { lane_a: { result: "x" } },
        },
      },
      "/steps/0/parallel/branches/0/steps/0/branch/outputs/picked/then",
    ],
  ];
  for (const [name, step, pointer] of forms(Infinity)) {
    const result = await compileWorkflowDocument(workflow([step]));
    assert(!result.ok, name);
    assertEquals(result.diagnostics[0]?.path, pointer, name);
  }
  for (const [name, step, pointer] of forms("__BAD__")) {
    const text = JSON.stringify(workflow([step])).replace(
      '"__BAD__"',
      "1.00000000000000001",
    );
    const result = await compileWorkflowDocument(text);
    assert(!result.ok, name);
    assertEquals(result.diagnostics[0]?.path, pointer, name);
  }
});

// ---------------------------------------------------------------------------
// Shared author-built subtypes (a DAG) must not make compilation exponential.
// ---------------------------------------------------------------------------

const DAG_DEPTH = 60;

function dagCompile(steps: unknown[]) {
  const started = performance.now();
  return compileWorkflowDocument(workflow(steps), {
    catalog: createDesignCatalog(),
  }).then((result) => ({ result, ms: performance.now() - started }));
}

Deno.test("chained branch exports with shared subtypes terminate with a bounded diagnostic", async () => {
  const steps: unknown[] = [];
  for (let level = 0; level < DAG_DEPTH; level += 1) {
    const prev = level === 0 ? { n: 1 } : `$step.b${level - 1}.xx`;
    steps.push({
      id: `b${level}`,
      branch: {
        ...BRANCH_BODY,
        then: [action({ id: `t${level}` })],
        else: [action({ id: `e${level}` })],
        outputs: {
          xx: {
            then: { aa: prev, bb: prev },
            else: { aa: prev, bb: prev },
          },
        },
      },
    });
  }
  const { result, ms } = await dagCompile(steps);
  assert(!result.ok);
  assertEquals(
    result.diagnostics.some((d) => d.code === "type_mismatch"),
    true,
  );
  assert(JSON.stringify(result.diagnostics).length < 50_000);
  assert(ms < 10_000, `took ${ms} ms`);
});

/** Asserts the first type_mismatch sits at `path` and the count stays bounded. */
function assertDoublingBound(
  result: Awaited<ReturnType<typeof compileWorkflowDocument>>,
  ms: number,
  path: string,
): void {
  assert(!result.ok, "expected rejection");
  const mismatches = result.diagnostics.filter((d) =>
    d.code === "type_mismatch"
  );
  assertEquals(mismatches[0]?.path, path);
  assert(result.diagnostics.length <= 4, `${result.diagnostics.length}`);
  assert(ms < HANG_GUARD_MS, `took ${ms} ms`);
}

Deno.test("chained repeat candidates with shared subtypes terminate", async () => {
  const steps: unknown[] = [];
  for (let level = 0; level < DAG_DEPTH; level += 1) {
    const prev = level === 0
      ? { n: 1 }
      : `$step.r${level - 1}.currentCandidate`;
    const candidate = { aa: prev, bb: prev };
    steps.push({
      id: `r${level}`,
      repeat: {
        max: 2,
        seed: { currentCandidate: candidate },
        until: '$input.target == "done"',
        steps: [action({ id: `try${level}` })],
        outputs: { currentCandidate: candidate },
      },
    });
  }
  const { result, ms } = await dagCompile(steps);
  // Level 11 is the first whose type exceeds 4096 nodes (2^12 leaves).
  assertDoublingBound(result, ms, "/steps/10/repeat/seed/currentCandidate");
});

Deno.test("chained lane exports with shared subtypes terminate", async () => {
  const steps: unknown[] = [];
  for (let level = 0; level < DAG_DEPTH; level += 1) {
    const prev = level === 0 ? { n: 1 } : `$step.p${level - 1}.lane_a.result`;
    steps.push({
      id: `p${level}`,
      parallel: {
        maxConcurrency: 1,
        join: "all-required",
        failurePolicy: "stop-dependent",
        branches: [{
          id: "lane_a",
          repository: "main",
          steps: [action({ id: `w${level}` })],
        }],
        outputs: { lane_a: { result: { aa: prev, bb: prev } } },
      },
    });
  }
  const { result, ms } = await dagCompile(steps);
  assertDoublingBound(result, ms, "/steps/10/parallel/outputs/lane_a/result");
});

// ---------------------------------------------------------------------------
// Secret-name matching is linear in the key length (no regex backtracking).
// ---------------------------------------------------------------------------

const ALLCAPS = "A".repeat(90_000);
const SECRET_GUARD_MS = 1_000;

Deno.test("a 90k all-caps key is matched in linear time", () => {
  const started = performance.now();
  assertEquals(isSecretName(ALLCAPS), false);
  assertEquals(isSecretName(`${ALLCAPS}PASSWORD`), true);
  assertEquals(isSecretName("XApiKey"), true);
  assertEquals(isSecretName("DBPASSWORD"), true);
  assertEquals(isSecretName("api_key"), true);
  assertEquals(isSecretName("targetName"), false);
  assert(performance.now() - started < SECRET_GUARD_MS, "isSecretName hung");
});

Deno.test("a 90k all-caps key compiles without a hang (no catalog, text and object)", async () => {
  const definition = workflow([action({ with: { [ALLCAPS]: "x" } })]);
  for (const input of [definition, JSON.stringify(definition)]) {
    const started = performance.now();
    const result = await compileWorkflowDocument(input);
    assert(performance.now() - started < SECRET_GUARD_MS, "compile hung");
    assertEquals(result.ok, true);
  }
});

Deno.test("a 90k all-caps nested literal key compiles without a hang (design catalog)", async () => {
  const definition = workflow([action({
    uses: "integration.action",
    with: { arguments: { x: "$input.target", n: { [ALLCAPS]: 1 } } },
  })]);
  const started = performance.now();
  const result = await compileWorkflowDocument(definition, {
    catalog: createDesignCatalog(),
  });
  assert(performance.now() - started < SECRET_GUARD_MS, "compile hung");
  assert(!JSON.stringify(result).includes(ALLCAPS));
});
