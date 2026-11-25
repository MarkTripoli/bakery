import { assertEquals } from "@std/assert";
import {
  base64ToText,
  groupFiles,
  isScript,
  isTextMedia,
  mediaTypeOf,
  pathProblem,
  problemWords,
  slugOf,
  textToBase64,
  typedCheck,
  typedDraft,
} from "../../apps/web/src/pages/library/skill-draft-state.ts";

const file = (path: string, id = path) => ({
  id,
  path,
  mediaType: "text/markdown",
  isExecutable: false,
  sizeBytes: 10,
  sha256: "a".repeat(64),
});

Deno.test("a slug is made from the name: lowercase, digits and single hyphens", () => {
  assertEquals(slugOf("Release checklist, v2!"), "release-checklist-v2");
  assertEquals(slugOf("  Café   au lait  "), "cafe-au-lait");
  assertEquals(slugOf("!!!"), "skill");
  assertEquals(slugOf("a".repeat(150)).length, 100);
});

Deno.test("text media are the ones the editor can show", () => {
  assertEquals(isTextMedia("text/markdown; charset=utf-8"), true);
  assertEquals(isTextMedia("application/json"), true);
  assertEquals(isTextMedia("application/vnd.api+json"), true);
  assertEquals(isTextMedia("application/octet-stream"), false);
  assertEquals(isTextMedia("image/png"), false);
});

Deno.test("a file's type and whether it is a script come from its name", () => {
  assertEquals(mediaTypeOf("SKILL.md"), "text/markdown");
  assertEquals(mediaTypeOf("scripts/check.sh"), "text/x-shellscript");
  assertEquals(mediaTypeOf("notes"), "text/plain");
  assertEquals(isScript("scripts/check.sh"), true);
  assertEquals(isScript("SKILL.md"), false);
});

Deno.test("text survives the trip to base64 and back, accents included", () => {
  const text = "Plain words, café, 日本語\n";
  assertEquals(base64ToText(textToBase64(text)), text);
  assertEquals(textToBase64(""), "");
});

Deno.test("a new file name is refused for the reasons a person can fix", () => {
  const files = [file("SKILL.md"), file("examples/a.md")];
  assertEquals(pathProblem(files, "  "), "empty");
  assertEquals(pathProblem(files, "skill.MD"), "taken");
  assertEquals(pathProblem(files, "/abs.md"), "invalid");
  assertEquals(pathProblem(files, "a/../b.md"), "invalid");
  assertEquals(pathProblem(files, "dir//b.md"), "invalid");
  assertEquals(pathProblem(files, "x".repeat(501)), "tooLong");
  assertEquals(pathProblem(files, "scripts/check.sh"), null);
  assertEquals(pathProblem(files, "SKILL.md", "SKILL.md"), null);
  const full = Array.from({ length: 256 }, (_, index) => file(`f${index}.md`));
  assertEquals(pathProblem(full, "extra.md"), "full");
  assertEquals(pathProblem(full, "renamed.md", "f1.md"), null);
});

Deno.test("files are grouped as the instructions and the rest", () => {
  const draft = {
    entryPath: "SKILL.md",
    files: [file("a.md"), file("SKILL.md"), file("b.md")],
  };
  const grouped = groupFiles(draft);
  assertEquals(grouped.entry?.path, "SKILL.md");
  assertEquals(grouped.others.map((item) => item.path), ["a.md", "b.md"]);
  assertEquals(groupFiles({ entryPath: "SKILL.md", files: [] }).entry, null);
});

Deno.test("a problem reads tied to its file and line, or to the whole skill", () => {
  assertEquals(
    problemWords({ file: null, line: null, code: "c", message: "Too big." }),
    {
      key: "library.skills.editor.problems.whole",
      values: { message: "Too big." },
    },
  );
  assertEquals(
    problemWords({ file: "SKILL.md", line: null, code: "c", message: "Bad." }),
    {
      key: "library.skills.editor.problems.file",
      values: { file: "SKILL.md", message: "Bad." },
    },
  );
  assertEquals(
    problemWords({ file: "SKILL.md", line: 3, code: "c", message: "Bad." }),
    {
      key: "library.skills.editor.problems.line",
      values: { file: "SKILL.md", line: 3, message: "Bad." },
    },
  );
});

Deno.test("what the contract leaves untyped is read as files and problems, and shapes that are not are dropped", () => {
  const draft = typedDraft({
    id: "d",
    skillId: "s",
    baseVersionId: null,
    baseRevision: null,
    entryPath: "SKILL.md",
    license: null,
    files: [file("SKILL.md"), { path: 3 }, null],
    totalBytes: 10,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as never);
  assertEquals(draft.files.map((item) => item.path), ["SKILL.md"]);
  const check = typedCheck({
    ok: false,
    draftVersion: 2,
    problems: [{ file: "a.md", line: 2, code: "x", message: "M" }, "nope"],
  } as never);
  assertEquals(check.problems, [
    { file: "a.md", line: 2, code: "x", message: "M" },
  ]);
});
