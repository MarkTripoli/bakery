import { assertEquals } from "@std/assert";
import {
  diffSkillText,
  SKILL_TEXT_DIFF_MAX_BYTES,
  SKILL_TEXT_DIFF_MAX_LINES,
} from "../../apps/server/src/modules/catalog/skill-text-diff.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("a changed line shows as one removed and one added line in a hunk", () => {
  const result = diffSkillText(
    bytes("one\ntwo\nthree\n"),
    bytes("one\nTWO\nthree\n"),
  );
  assertEquals(result, {
    kind: "diff",
    text: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three",
  });
});

Deno.test("a file that is added is all added lines and one that is removed is all removed", () => {
  assertEquals(diffSkillText(null, bytes("a\nb\n")), {
    kind: "diff",
    text: "@@ -1,0 +1,2 @@\n+a\n+b",
  });
  assertEquals(diffSkillText(bytes("a\nb\n"), null), {
    kind: "diff",
    text: "@@ -1,2 +1,0 @@\n-a\n-b",
  });
});

Deno.test("identical text has no hunks", () => {
  assertEquals(diffSkillText(bytes("same\n"), bytes("same\n")), {
    kind: "diff",
    text: "",
  });
});

Deno.test("distant changes are two hunks with three lines of context", () => {
  const before = Array.from({ length: 20 }, (_, i) => "line " + i);
  const after = [...before];
  after[1] = "changed one";
  after[18] = "changed eighteen";
  const result = diffSkillText(
    bytes(before.join("\n") + "\n"),
    bytes(after.join("\n") + "\n"),
  );
  assertEquals(result.kind, "diff");
  if (result.kind !== "diff") return;
  const hunks = result.text.split("\n").filter((line) => line.startsWith("@@"));
  assertEquals(hunks, ["@@ -1,5 +1,5 @@", "@@ -16,5 +16,5 @@"]);
});

Deno.test("a file that is not text, or is too large, is named instead of shown", () => {
  assertEquals(diffSkillText(new Uint8Array([0, 1, 2]), bytes("x")), {
    kind: "omitted",
    reason: "binary",
  });
  assertEquals(diffSkillText(new Uint8Array([0xff, 0xfe]), bytes("x")), {
    kind: "omitted",
    reason: "binary",
  });
  assertEquals(
    diffSkillText(
      new Uint8Array(SKILL_TEXT_DIFF_MAX_BYTES + 1).fill(97),
      bytes("x"),
    ),
    { kind: "omitted", reason: "too_large" },
  );
  const many = (prefix: string) =>
    bytes(
      Array.from(
        { length: SKILL_TEXT_DIFF_MAX_LINES + 1 },
        (_, i) => prefix + i,
      ).join("\n"),
    );
  assertEquals(diffSkillText(many("a"), many("b")), {
    kind: "omitted",
    reason: "too_large",
  });
});
