import { assertEquals } from "@std/assert";
import {
  EMPTY_SOURCE_FORM,
  httpsAddress,
  importedName,
  importFailureKind,
  sourceProblems,
} from "../../apps/web/src/pages/library/skill-source-state.ts";

Deno.test("only a plain https address is accepted", () => {
  assertEquals(
    httpsAddress("https://example.test/org/repo")?.host,
    "example.test",
  );
  for (
    const refused of [
      "http://example.test/repo",
      "https://example.test:8443/repo",
      "https://person@example.test/repo",
      "https://example.test/repo?ref=main",
      "git@example.test:org/repo.git",
    ]
  ) assertEquals(httpsAddress(refused), null, refused);
});

Deno.test("a new repository needs its address, name, licence and revision", () => {
  assertEquals(sourceProblems(EMPTY_SOURCE_FORM, false), {
    address: "address",
    name: "name",
    licence: "licence",
    revision: "revision",
  });
});

Deno.test("a saved source needs only the choice and a revision", () => {
  assertEquals(sourceProblems(EMPTY_SOURCE_FORM, true), {
    sourceId: "choose",
    revision: "revision",
  });
  assertEquals(
    sourceProblems(
      { ...EMPTY_SOURCE_FORM, sourceId: "a", revision: "v1" },
      true,
    ),
    {},
  );
});

Deno.test("a skill is named after the last folder, as the server names it", () => {
  assertEquals(importedName("/skills/release-notes/"), "release-notes");
  assertEquals(importedName("  "), "imported-skill");
});

Deno.test("each server code has its own words and unknown ones do not guess", () => {
  assertEquals(importFailureKind("SOURCE_INVALID", "skills/a"), "invalid");
  assertEquals(importFailureKind("SOURCE_INVALID", ""), "invalidAtTop");
  assertEquals(importFailureKind("SOURCE_TIMEOUT", ""), "timeout");
  assertEquals(importFailureKind("INTERNAL", ""), "other");
  assertEquals(importFailureKind(null, ""), "other");
});
