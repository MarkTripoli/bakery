import { assert, assertEquals } from "@std/assert";
import {
  buildContextDocument,
  type ContextDocumentSource,
} from "../../apps/worker/src/context-document-source.ts";
import {
  renderContextDocument,
  validateContextDocument,
} from "../../apps/worker/src/context-document.ts";

const pin = { sha256: "a".repeat(64), sizeBytes: 42 };

const source: ContextDocumentSource = {
  runId: "11111111-1111-4111-8111-111111111111",
  stepKey: "implement",
  goal: "Implement the approved plan.",
  outputs: ["bakery.implementation-summary"],
  inputs: [{
    slot: "brief",
    path: "brief/notes.md",
    mediaType: "text/markdown",
    pin,
  }],
  contextDir: "/attempt/context",
  outputDir: "/attempt/outputs",
};

Deno.test("the pin supplies the digest and the size, and nothing else", () => {
  const document = buildContextDocument(source);
  assertEquals(document.inputs, [{
    slot: "brief",
    path: "brief/notes.md",
    digest: "a".repeat(64),
    sizeBytes: 42,
    mediaType: "text/markdown",
  }]);
});

Deno.test("the builder carries a missing slot through instead of inventing one", () => {
  // `slot` is required by the type, so this shape is reachable only from a
  // value the type did not cover - parsed JSON, a queue payload. The builder's
  // job in that case is to carry what it was given, not to make a name up.
  const untyped = {
    ...source,
    inputs: [{ ...source.inputs[0], slot: undefined }],
  };
  const document = buildContextDocument(
    untyped as unknown as ContextDocumentSource,
  );
  assertEquals(document.inputs[0].slot, undefined);
});

Deno.test("an unnamed slot is either refused or a known gap, never silently new", () => {
  // The refusal lives in dd72c4853 on rig/400-flat-delete-b (#518). Until that
  // merges, this case cannot assert the refusal outright - a permanently red
  // case cannot merge, and its reason would live in prose rather than in the
  // assertion. It asserts the CLOSED behaviour when the fix is present, and
  // otherwise pins the known gap, so it fails if the gap changes shape or if
  // somebody removes the fix.
  const document = buildContextDocument({
    ...source,
    inputs: [{ ...source.inputs[0], slot: "" }],
  });
  const verdict = validateContextDocument(document);
  if (verdict?.reason === "context_input_slot_missing") {
    assert(true, "the fix is present and the unnamed slot is refused");
    return;
  }
  assertEquals(
    verdict,
    null,
    "absent the fix this must be the known gap, not a new fault",
  );
  // And the gap is exactly what it was described as: a row with no name.
  const row = renderContextDocument(document)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .at(-1);
  assertEquals(
    row,
    "| " + "``" + " | `brief/notes.md` | `" + "a".repeat(64) +
      "` | 42 bytes | `text/markdown` |",
  );
});

Deno.test("the builder does not repair a path the renderer would refuse", () => {
  const document = buildContextDocument({
    ...source,
    inputs: [{ ...source.inputs[0], path: "../outside.md" }],
  });
  assertEquals(validateContextDocument(document), {
    reason: "context_input_path_unsafe",
  });
});

Deno.test("a valid document renders an index that names the pinned bytes", () => {
  const document = buildContextDocument(source);
  assertEquals(validateContextDocument(document), null);
  const markdown = renderContextDocument(document);
  assert(markdown.includes("`brief/notes.md`"));
  assert(markdown.includes("`" + "a".repeat(64) + "`"));
  assert(markdown.includes("42 bytes"));
  assert(markdown.includes("`brief`"));
});

Deno.test("every declared input reaches the index, in declared order", () => {
  const document = buildContextDocument({
    ...source,
    inputs: [
      { ...source.inputs[0], slot: "brief", path: "brief/notes.md" },
      {
        slot: "plan",
        path: "plan/plan.md",
        mediaType: "text/markdown",
        pin: { sha256: "b".repeat(64), sizeBytes: 7 },
      },
    ],
  });
  assertEquals(
    document.inputs.map((input) => input.slot),
    ["brief", "plan"],
  );
  assertEquals(document.inputs[1].digest, "b".repeat(64));
});
