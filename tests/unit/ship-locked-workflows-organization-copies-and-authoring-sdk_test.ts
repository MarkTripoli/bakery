import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
  WORKFLOW_COMPILER_LIMITS,
  type WorkflowCompilerDiagnosticCode,
  type WorkflowJsonValue,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  decodeWorkflowYaml,
  encodeWorkflowYaml,
} from "../../packages/contracts/src/workflow-compiler/yaml.ts";

// #35 slice a. A workflow can be imported from, and exported to, YAML 1.2 as a
// JSON-compatible subset. Unsafe YAML is a diagnostic, never a value: the
// importer must never hand the compiler anything the JSON decoder would refuse.

function accepted(text: string): WorkflowJsonValue {
  const result = decodeWorkflowYaml(text);
  assert(result.ok, `expected ${JSON.stringify(text)} to be accepted`);
  return result.value;
}

function codesOf(text: string): WorkflowCompilerDiagnosticCode[] {
  const result = decodeWorkflowYaml(text);
  assert(!result.ok, `expected ${JSON.stringify(text)} to be refused`);
  return result.diagnostics.map((item) => item.code);
}

Deno.test("YAML 1.2 plain data decodes to the same value as its JSON", () => {
  const yaml = [
    "# a comment is presentation, not data",
    "apiVersion: bakery.dev/v1",
    "kind: workflow",
    "inputs:",
    "  target: {type: string, required: true}",
    "steps:",
    "  - id: one",
    "    uses: workflow.noop",
    '    label: "quoted: yes"',
    "    note: |",
    "      two",
    "      lines",
    "    ratio: 0.5",
    "    count: 3",
    "    none: null",
    "    flag: true",
    "",
  ].join("\n");
  const json = JSON.stringify({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: { target: { type: "string", required: true } },
    steps: [{
      id: "one",
      uses: "workflow.noop",
      label: "quoted: yes",
      note: "two\nlines\n",
      ratio: 0.5,
      count: 3,
      none: null,
      flag: true,
    }],
  });
  assertEquals(canonicalJson(accepted(yaml)), canonicalJson(JSON.parse(json)));
});

Deno.test("YAML 1.2 core schema: yes, no, on, off, dates and underscores stay strings", () => {
  const value = accepted(
    "a: yes\nb: No\nc: on\nd: OFF\ne: 2001-12-14\nf: 1_000\ni: ~\n",
  ) as Record<string, unknown>;
  assertEquals(value.a, "yes");
  assertEquals(value.b, "No");
  assertEquals(value.c, "on");
  assertEquals(value.d, "OFF");
  assertEquals(value.e, "2001-12-14");
  assertEquals(value.f, "1_000");
  assertEquals(value.i, null);
});

Deno.test("every explicit tag and every directive is refused, standard or not", () => {
  for (
    const text of [
      "a: !!str 12\n",
      "a: !!float 1\n",
      "a: !!int 1\n",
      "a: !!map {b: 1}\n",
      "%YAML 1.1\n---\na: yes\n",
      "%TAG !e! tag:evil.example,2002:\n---\na: 1\n",
      "%TAG !! tag:evil.example,2002:\n---\na: 1\n",
      "%TAG !! tag:yaml.org,2002:\n---\na: 1\n",
      "%TAG !e! tag:yaml.org,2002:\n---\na: 1\n",
      "%YAML 1.2\n---\na: 1\n",
      "%FOO bar\n---\na: 1\n",
      "!!str a: 1\n",
      "!custom a: 1\n",
      "a: !custom x\n",
      "a: !!binary aGk=\n",
      "a: !!set {x}\n",
      "a: !!timestamp 2001-12-14\n",
      "a: !<tag:evil.example,2002:x> y\n",
      "!custom\nb: 1\n",
    ]
  ) {
    assertEquals(codesOf(text), ["yaml_tag_forbidden"], text);
  }
});

Deno.test("anchors and aliases are refused, used or not", () => {
  for (
    const text of [
      "a: &x 1\nb: *x\n",
      "a: &x 1\n",
      "a: &x [1]\nb: [*x]\n",
      "&x {a: 1}\n",
      "- &a {b: 1}\n- *a\n",
    ]
  ) {
    assertEquals(codesOf(text)[0], "yaml_alias_forbidden", text);
  }
});

Deno.test("an alias is refused where it stands, and so is the anchor it points at", () => {
  assertEquals(codesOf("a: *x\n"), ["yaml_alias_forbidden"]);
  assertEquals(codesOf("&k a: 1\n"), ["yaml_alias_forbidden"]);
  const result = decodeWorkflowYaml("a: &x 1\nb: *x\n");
  assert(!result.ok);
  assertEquals(
    result.diagnostics.map((item) => [item.path, item.code]),
    [["/a", "yaml_alias_forbidden"], ["/b", "yaml_alias_forbidden"]],
  );
});

Deno.test("an explicitly empty document is the JSON null; no document at all is refused", () => {
  assertEquals(accepted("---\n"), null);
  assertEquals(accepted("null\n"), null);
  assertEquals(codesOf(""), ["yaml_syntax_invalid"]);
});

Deno.test("a merge key is refused whether or not an alias supplies it; a quoted one is a string", () => {
  assertEquals(accepted('c:\n  "<<": {b: 2}\n'), { c: { "<<": { b: 2 } } });
  assertEquals(accepted("c:\n  '<<': 1\n"), { c: { "<<": 1 } });
  for (
    const text of [
      "a: {b: 1}\nc:\n  <<: {b: 2}\n",
      "{<<: {b: 2}}\n",
      "base: &b {x: 1}\nc:\n  <<: *b\n",
    ]
  ) {
    assert(
      codesOf(text).includes("yaml_merge_key_forbidden") ||
        codesOf(text).includes("yaml_alias_forbidden"),
      text,
    );
  }
  assertEquals(codesOf("c:\n  <<: {b: 2}\n"), ["yaml_merge_key_forbidden"]);
});

Deno.test("a repeated key is refused, in a block map and in a flow map", () => {
  for (
    const text of ["a: 1\na: 2\n", "{a: 1, a: 2}\n", "x:\n  b: 1\n  b: 1\n"]
  ) {
    assertEquals(codesOf(text), ["definition_duplicate_key"], text);
  }
});

Deno.test("more than one document, or none, is refused", () => {
  assertEquals(codesOf("a: 1\n---\nb: 2\n"), ["yaml_multiple_documents"]);
  assertEquals(codesOf("---\na: 1\n...\n---\nb: 2\n"), [
    "yaml_multiple_documents",
  ]);
  for (const text of ["", "   \n", "# only a comment\n"]) {
    assertEquals(codesOf(text), ["yaml_syntax_invalid"], JSON.stringify(text));
  }
});

Deno.test("malformed YAML is one fixed diagnostic that never echoes the text", () => {
  for (
    const text of [
      "a: [1, 2\n",
      "a: {b: 1\n",
      "a:\n\t- tab\n",
      "a: 'unterminated\n",
      "- a\nb: 1\n",
    ]
  ) {
    const result = decodeWorkflowYaml(text);
    assert(!result.ok, text);
    assertEquals(result.diagnostics.map((item) => item.code), [
      "yaml_syntax_invalid",
    ]);
    assert(!JSON.stringify(result.diagnostics).includes("unterminated"));
  }
});

Deno.test("numbers that are not exactly representable JSON numbers are refused", () => {
  for (
    const text of [
      "a: .inf\n",
      "a: -.inf\n",
      "a: .nan\n",
      "a: 1e999\n",
      "a: 12345678901234567890\n",
      "a: 0.1000000000000000055511151231257827021181583404541015626\n",
      "a: 0x1F\n",
      "a: 0o17\n",
      "a: 010\n",
      "a: -007\n",
      "a: +1\n",
      "a: .5\n",
      "a: 1.\n",
      "a: [1, 2, 9007199254740993]\n",
    ]
  ) {
    assertEquals(codesOf(text), ["definition_number_invalid"], text);
  }
  // 2^53 is the first integer that is not safe: the JSON decoder refuses it.
  assertEquals(codesOf("a: 9007199254740992\n"), ["definition_number_invalid"]);
  assertEquals(accepted("a: [1, 1.0, -0.5, 1e3, 9007199254740991]\n"), {
    a: [1, 1, -0.5, 1000, 9007199254740991],
  });
});

Deno.test("keys must be strings: numbers, booleans, null and collections are refused", () => {
  for (
    const text of ["1: a\n", "true: a\n", "null: a\n", "? [a, b]\n: c\n"]
  ) {
    assertEquals(codesOf(text), ["definition_value_unsupported"], text);
  }
  assertEquals(accepted('"1": a\n'), { "1": "a" });
});

Deno.test("a forbidden key is refused as it is for JSON", () => {
  assertEquals(codesOf("__proto__: 1\n"), ["definition_key_forbidden"]);
  assertEquals(codesOf("a:\n  constructor: 1\n"), ["definition_key_forbidden"]);
  assertEquals(codesOf("{prototype: 1}\n"), ["definition_key_forbidden"]);
});

Deno.test("size, depth and value count are bounded before anything deep is walked", () => {
  const limits = WORKFLOW_COMPILER_LIMITS;
  // Too large is judged on the text, ahead of a parse that would also fail.
  assertEquals(codesOf("[" + "x".repeat(limits.bytes)), [
    "definition_too_large",
  ]);
  assertEquals(codesOf("a: " + "x".repeat(limits.bytes)), [
    "definition_too_large",
  ]);
  // A multi-byte text is measured in bytes, not characters.
  assertEquals(
    codesOf("a: " + "é".repeat(Math.floor(limits.bytes / 2))),
    ["definition_too_large"],
  );
  // Depth: just inside passes, one past is refused, in flow and block styles.
  const nest = (depth: number) =>
    "[".repeat(depth) + "1" + "]".repeat(depth) + "\n";
  assert(decodeWorkflowYaml(nest(limits.jsonDepth - 1)).ok);
  assertEquals(codesOf(nest(limits.jsonDepth + 1)), ["definition_too_deep"]);
  const block = (depth: number) =>
    Array.from(
      { length: depth },
      (_, level) => `${"  ".repeat(level)}k${level}:`,
    ).join("\n") + " 1\n";
  assertEquals(codesOf(block(limits.jsonDepth + 1)), ["definition_too_deep"]);
  // The worst case a text of the maximum size can nest: it must come back as a
  // diagnostic, not as a thrown stack overflow.
  const worst = "[".repeat(Math.floor(limits.bytes / 2)) +
    "]".repeat(Math.floor(limits.bytes / 2));
  assertEquals(codesOf(worst), ["definition_too_deep"]);
  // Value count.
  const many = "[" + "1,".repeat(limits.jsonValues + 1) + "1]\n";
  assert(new TextEncoder().encode(many).length <= limits.bytes);
  assertEquals(codesOf(many), ["definition_too_many_values"]);
});

Deno.test("every fault is reported at its own path, in document order", () => {
  const sequence = decodeWorkflowYaml("a: [.inf, 1, .nan]\n");
  assert(!sequence.ok);
  assertEquals(sequence.diagnostics.map((item) => item.path), [
    "/a/0",
    "/a/2",
  ]);
  const map = decodeWorkflowYaml("x: .inf\ny: 1\nz: .nan\n");
  assert(!map.ok);
  assertEquals(map.diagnostics.map((item) => item.path), ["/x", "/z"]);
});

Deno.test("a nested document carrying only one fault reports that fault at its path", () => {
  const result = decodeWorkflowYaml("steps:\n  - id: one\n    n: .inf\n");
  assert(!result.ok);
  assertEquals(result.diagnostics.length, 1);
  assertEquals(result.diagnostics[0]!.code, "definition_number_invalid");
  assertEquals(result.diagnostics[0]!.path, "/steps/0/n");
});

// Export.

Deno.test("export is block YAML with sorted keys and unchanged array order", () => {
  const exported = encodeWorkflowYaml({
    kind: "workflow",
    apiVersion: "bakery.dev/v1",
    steps: [{ uses: "b", id: "2" }, { uses: "a", id: "1" }],
  });
  assert(exported.ok);
  assertEquals(
    exported.text,
    [
      "apiVersion: bakery.dev/v1",
      "kind: workflow",
      "steps:",
      '  - id: "2"',
      "    uses: b",
      '  - id: "1"',
      "    uses: a",
      "",
    ].join("\n"),
  );
});

Deno.test("export refuses what is not plain JSON data, with a diagnostic", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (
    const value of [
      { a: undefined },
      { a: Number.NaN },
      { a: Infinity },
      { a: 10n },
      { a: new Date(0) },
      { a: new Map() },
      { a: () => 1 },
      { a: Symbol("x") },
      cyclic,
    ]
  ) {
    const result = encodeWorkflowYaml(value);
    assert(!result.ok);
    assert(result.diagnostics.length > 0);
  }
});

Deno.test("export never emits an anchor, alias or tag, even for a shared object", () => {
  const shared = { x: 1 };
  const exported = encodeWorkflowYaml({ a: shared, b: shared, c: [shared] });
  assert(exported.ok);
  assert(!exported.text.includes("&"));
  assert(!exported.text.includes("*"));
  assert(decodeWorkflowYaml(exported.text).ok);
});

const AWKWARD_STRINGS = [
  "",
  " ",
  "yes",
  "no",
  "on",
  "off",
  "true",
  "null",
  "~",
  "123",
  "1e3",
  "0x1F",
  ".inf",
  "-.inf",
  ".nan",
  "2001-12-14",
  "<<",
  "*alias",
  "&anchor",
  "!tag",
  "!!str",
  "- item",
  "? key",
  ": value",
  "# not a comment",
  "a: b",
  "a #b",
  "---",
  "...",
  "%DIRECTIVE",
  "@at",
  "`tick",
  "{",
  "[",
  "}",
  "]",
  ",",
  "'",
  '"',
  "\\",
  "line one\nline two",
  "trailing newline\n",
  "\n\nleading newlines",
  "  leading spaces",
  "trailing spaces  ",
  "tab\there",
  "carriage\rreturn",
  "nul\u0000byte",
  "bell\u0007",
  "bom\ufeffinside",
  "line\u2028separator",
  "para\u2029separator",
  "\ufeffa",
  "\ufeff",
  "x\ufeffy",
  "del\x7fhere",
  "c1\x80\x84\x86\x9fend",
  "nonchar\ufffe\uffffend",
  "  indented\nline",
  " x\n y",
  "\tx\ny",
  "lone\ud800high",
  "lone\udc00low",
  "next\u0085line",
  "é accents and 日本語 and 😀",
  "x".repeat(300),
  ("word ".repeat(80)).trim(),
  "a".repeat(120) + "\n" + "b".repeat(120),
];

Deno.test("every awkward string survives export then import as the same string", () => {
  for (const text of AWKWARD_STRINGS) {
    for (
      const value of [{ k: text }, [text], { [text.slice(0, 40) || "e"]: 1 }]
    ) {
      const exported = encodeWorkflowYaml(value);
      assert(exported.ok, JSON.stringify(text));
      const imported = decodeWorkflowYaml(exported.text);
      assert(imported.ok, `${JSON.stringify(text)} -> ${exported.text}`);
      assertEquals(canonicalJson(imported.value), canonicalJson(value));
    }
  }
});

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomValue(random: () => number, depth: number): WorkflowJsonValue {
  const roll = random();
  if (depth > 4 || roll < 0.35) {
    const scalar = random();
    if (scalar < 0.2) return null;
    if (scalar < 0.3) return random() < 0.5;
    if (scalar < 0.5) return Math.floor(random() * 2000) - 1000;
    if (scalar < 0.6) return Math.round(random() * 1e6) / 1000;
    return AWKWARD_STRINGS[Math.floor(random() * AWKWARD_STRINGS.length)]!;
  }
  if (roll < 0.65) {
    return Array.from(
      { length: Math.floor(random() * 4) },
      () => randomValue(random, depth + 1),
    );
  }
  const entries: Record<string, WorkflowJsonValue> = {};
  for (let index = 0; index < Math.floor(random() * 5); index += 1) {
    const key = random() < 0.5
      ? `k${index}`
      : AWKWARD_STRINGS[Math.floor(random() * AWKWARD_STRINGS.length)]!
        .slice(0, 30);
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    entries[key] = randomValue(random, depth + 1);
  }
  return entries;
}

Deno.test("exported YAML round-trips to the same canonical JSON and digest", async () => {
  const random = prng(35);
  for (let run = 0; run < 400; run += 1) {
    const value = { root: randomValue(random, 0) };
    const exported = encodeWorkflowYaml(value);
    assert(exported.ok, `run ${run}`);
    const imported = decodeWorkflowYaml(exported.text);
    assert(imported.ok, `run ${run}: ${exported.text}`);
    assertEquals(
      await sha256Hex(canonicalJson(imported.value)),
      await sha256Hex(canonicalJson(value)),
      `run ${run}: ${exported.text}`,
    );
    // Exporting what was imported is stable text.
    const again = encodeWorkflowYaml(imported.value);
    assert(again.ok);
    assertEquals(again.text, exported.text);
  }
});

Deno.test("a definition that block YAML would push past the ceiling exports as its canonical JSON, which imports", () => {
  const limits = WORKFLOW_COMPILER_LIMITS;
  // Block indentation grows with depth: a long list at the bottom of a deep
  // chain is a small definition and a very large block text.
  let value: WorkflowJsonValue = Array.from({ length: 1_500 }, () => "a");
  for (let level = limits.jsonDepth - 3; level >= 0; level -= 1) {
    value = { ["k" + level]: value };
  }
  const canonical = canonicalJson(value);
  assert(
    new TextEncoder().encode(canonical).length < limits.bytes,
    "the definition itself is in bounds",
  );
  const exported = encodeWorkflowYaml(value);
  assert(exported.ok);
  assertEquals(exported.text, canonical, "block form would not have fit");
  assert(new TextEncoder().encode(exported.text).length <= limits.bytes);
  const imported = decodeWorkflowYaml(exported.text);
  assert(imported.ok);
  assertEquals(canonicalJson(imported.value), canonical);
  // A definition that fits in block form stays block form.
  const small = encodeWorkflowYaml({ a: { b: ["c"] } });
  assert(small.ok);
  assertEquals(small.text, "a:\n  b:\n    - c\n");
});

Deno.test("export quotes every word a YAML 1.1 reader would read as a boolean, null or merge", () => {
  for (
    const word of [
      "y",
      "Y",
      "n",
      "N",
      "yes",
      "Yes",
      "YES",
      "no",
      "No",
      "on",
      "On",
      "off",
      "OFF",
      "true",
      "True",
      "false",
      "null",
      "Null",
      "~",
      "<<",
    ]
  ) {
    const exported = encodeWorkflowYaml({ k: word, [word]: 1 });
    assert(exported.ok, word);
    assert(exported.text.includes(`k: "${word}"`), exported.text);
    assert(exported.text.includes(`"${word}": 1`), exported.text);
    const imported = decodeWorkflowYaml(exported.text);
    assert(imported.ok, word);
    assertEquals(
      canonicalJson(imported.value),
      canonicalJson({ k: word, [word]: 1 }),
    );
  }
});

Deno.test("a long string is one line of text whatever its length", () => {
  const long = ("word ".repeat(80)).trim();
  const exported = encodeWorkflowYaml({ k: long });
  assert(exported.ok);
  assertEquals(exported.text, `k: ${long}\n`);
});

Deno.test("export refuses a value past the definition ceiling, as import would", () => {
  const result = encodeWorkflowYaml({
    a: "x".repeat(WORKFLOW_COMPILER_LIMITS.bytes),
  });
  assert(!result.ok);
  assertEquals(result.diagnostics.map((item) => item.code), [
    "definition_too_large",
  ]);
});

Deno.test("a byte order mark inside a key or value is data: it round-trips to the same digest", () => {
  for (const value of [{ "\ufeffa": 1 }, { "\ufeff": 1 }, { k: "\ufeffx" }]) {
    const exported = encodeWorkflowYaml(value);
    assert(exported.ok);
    assert(!exported.text.includes("\ufeff"), "written as an escape");
    const imported = decodeWorkflowYaml(exported.text);
    assert(imported.ok, exported.text);
    assertEquals(canonicalJson(imported.value), canonicalJson(value));
  }
});

Deno.test("a byte order mark at the very start of the text is the stream's, and is ignored", () => {
  assertEquals(accepted("\ufeffa: 1\n"), { a: 1 });
});

Deno.test("a definition whose root is not an object exports as its canonical JSON, which imports", () => {
  for (
    const root of [
      "  indented\nline",
      " x\n y",
      "plain",
      "",
      7,
      -0.5,
      true,
      null,
      [],
      ["a", { b: [1, "  c\nd"] }],
    ]
  ) {
    const exported = encodeWorkflowYaml(root);
    assert(exported.ok);
    assertEquals(exported.text, canonicalJson(root));
    const imported = decodeWorkflowYaml(exported.text);
    assert(imported.ok, exported.text);
    assertEquals(canonicalJson(imported.value), canonicalJson(root));
  }
});

Deno.test("the byte ceiling counts bytes, not UTF-16 units", () => {
  const text = "#" + "\u20ac".repeat(33_400) + "\na: 1"; // 100,206 bytes, 33,406 units
  const result = decodeWorkflowYaml(text);
  assert(!result.ok);
  assertEquals(result.diagnostics[0]?.code, "definition_too_large");
});

Deno.test("a character YAML 1.2 does not list as printable is refused raw, wherever it stands", () => {
  const raw = [
    "\u0000",
    "\u0001",
    "\u0008",
    "\u000b",
    "\u000c",
    "\u001f",
    "\u007f",
    "\u0080",
    "\u0084",
    "\u0086",
    "\u009f",
    "\ufffe",
    "\uffff",
    "\ud800",
    "\udc00",
    "\ud83dx",
    "x\ude00",
  ];
  for (const char of raw) {
    for (
      const text of [
        `a: ${char}\n`,
        `a: "${char}"\n`,
        `a: 'x${char}y'\n`,
        `# ${char}\na: 1\n`,
        `${char}a: 1\n`,
        `a: |\n  ${char}\n`,
      ]
    ) {
      assertEquals(
        codesOf(text),
        ["yaml_syntax_invalid"],
        JSON.stringify(text),
      );
    }
  }
  // Tab, line feed, carriage return, NEL, a surrogate pair and the BOM are text.
  assertEquals(accepted('a: "x\ty"\r\nb: 2\r\n'), { a: "x\ty", b: 2 });
  assertEquals(accepted('a: "\u0085\ud83d\ude00\ufeff"\n'), {
    a: "\u0085\ud83d\ude00\ufeff",
  });
  // The same characters as escapes are data the JSON decoder would take.
  assertEquals(accepted('a: "\\u0000\\x7f"\n'), { a: "\u0000\u007f" });
});

Deno.test("an exported string with a character the importer refuses raw is written as an escape and imports", () => {
  const value = {
    k: "a\u0000b\u007f\u0085\u0090\ufffe\uffff\ud800",
    "\u007f": 1,
  };
  const exported = encodeWorkflowYaml(value);
  assert(exported.ok);
  assert(!hasRawSpecial(exported.text), exported.text);
  const imported = decodeWorkflowYaml(exported.text);
  assert(imported.ok, exported.text);
  assertEquals(canonicalJson(imported.value), canonicalJson(value));
});

/** True when the text holds a BOM, a raw non-printable or half a surrogate pair. */
function hasRawSpecial(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0)!;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d ||
      code >= 0x7f && code <= 0x84 || code >= 0x86 && code <= 0x9f ||
      code === 0xfffe || code === 0xffff || code === 0xfeff ||
      code >= 0xd800 && code <= 0xdfff;
  });
}
