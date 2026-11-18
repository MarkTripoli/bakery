import { assert, assertEquals } from "@std/assert";
import { validateWorkflowSourceYaml } from "../../apps/server/src/modules/workflows/validation.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";

// #35 AC2: publication stores a draft's source YAML beside its definition, so
// the check that the source is safe, and is the definition's own, runs there.
// These cases drive the check itself; the publish route is covered through the
// mounted API in the integration file.
const definition = {
  kind: "fixed",
  steps: [{ id: "first", uses: "workflow.noop" }],
};
const SECRET = "do-not-echo-this-value";

const codes = (source: string, value: unknown = definition) =>
  validateWorkflowSourceYaml(source, value).map((issue) => issue.code);

Deno.test("the canonical JSON a draft stores by default is a safe, matching source", () => {
  assertEquals(codes(canonicalJson(definition)), []);
});

Deno.test("block YAML that describes the definition is accepted, whatever its formatting", () => {
  const yaml = [
    "# a comment",
    "kind: fixed",
    "steps:",
    "  - id: first",
    "    uses: workflow.noop",
    "",
  ].join("\n");
  assertEquals(codes(yaml), []);
});

Deno.test("an unsafe YAML is blocked with a code and a pointer, never an echo", () => {
  const cases: [string, string][] = [
    [`kind: !!str fixed\nsteps: []\nnote: ${SECRET}`, "yaml_tag_forbidden"],
    [`base: &a\n  v: ${SECRET}\nuse: *a`, "yaml_alias_forbidden"],
    [`kind: fixed\nkind: ${SECRET}`, "definition_duplicate_key"],
    [`<<: {a: ${SECRET}}\nkind: fixed`, "yaml_merge_key_forbidden"],
    [`kind: fixed\n---\nkind: ${SECRET}`, "yaml_multiple_documents"],
    [`%YAML 1.2\n---\nkind: ${SECRET}`, "yaml_tag_forbidden"],
  ];
  for (const [source, code] of cases) {
    const issues = validateWorkflowSourceYaml(source, definition);
    assert(
      issues.some((issue) => issue.code === code),
      `${code}: ${JSON.stringify(issues)}`,
    );
    assert(
      !JSON.stringify(issues).includes(SECRET),
      "a finding echoed submitted text",
    );
  }
});

Deno.test("a YAML that decodes to a different definition is blocked as a mismatch", () => {
  assertEquals(
    codes("kind: fixed\nsteps:\n  - id: other\n    uses: workflow.noop\n"),
    ["source_yaml_mismatch"],
  );
});

Deno.test("a text over the byte ceiling is refused before it is parsed", () => {
  assertEquals(codes(`kind: ${"x".repeat(200_000)}`), ["definition_too_large"]);
});

Deno.test("malformed YAML is one fixed finding", () => {
  assertEquals(codes("kind: [unterminated"), ["yaml_syntax_invalid"]);
});
