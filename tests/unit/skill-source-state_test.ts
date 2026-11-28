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
  assertEquals(sourceProblems(EMPTY_SOURCE_FORM, false, false), {
    address: "address",
    name: "name",
    licence: "licence",
    revision: "revision",
  });
});

Deno.test("a saved source needs only the choice and a revision", () => {
  assertEquals(sourceProblems(EMPTY_SOURCE_FORM, true, false), {
    sourceId: "choose",
    revision: "revision",
  });
  assertEquals(
    sourceProblems(
      { ...EMPTY_SOURCE_FORM, sourceId: "a", revision: "v1" },
      true,
      false,
    ),
    {},
  );
});

Deno.test("a skill is named after the last folder, as the server names it", () => {
  assertEquals(importedName("/skills/release-notes/"), "release-notes");
  assertEquals(importedName("  "), "imported-skill");
});

Deno.test("each server code has its own words and unknown ones do not guess", () => {
  assertEquals(
    importFailureKind("SOURCE_INVALID", "skills/a", "main", false),
    "invalid",
  );
  assertEquals(
    importFailureKind("SOURCE_INVALID", "", "main", false),
    "invalidAtTop",
  );
  assertEquals(
    importFailureKind("SOURCE_TIMEOUT", "", "main", false),
    "timeout",
  );
  assertEquals(
    importFailureKind("SOURCE_REVISION_NOT_FOUND", "", "main", false),
    "missingRevision",
  );
  assertEquals(importFailureKind("INTERNAL", "", "main", false), "other");
  assertEquals(importFailureKind(null, "", "main", false), "other");
});

Deno.test("a short commit hash that was not found asks for all of it", () => {
  const kind = (revision: string) =>
    importFailureKind("SOURCE_REVISION_NOT_FOUND", "", revision, false);
  assertEquals(kind("e4bb5d9"), "shortCommit");
  assertEquals(kind("E4BB5D9"), "shortCommit");
  assertEquals(kind("release-9"), "missingRevision");
  assertEquals(kind("v2.1.0"), "missingRevision");
  assertEquals(kind("a".repeat(40)), "missingRevision");
});

Deno.test("a web address archive needs no revision and has its own words", () => {
  assertEquals(
    sourceProblems(
      {
        ...EMPTY_SOURCE_FORM,
        address: "https://example.test/skills.tar.gz",
        name: "Archive",
        licence: "MIT",
      },
      false,
      true,
    ),
    {},
  );
  assertEquals(
    importFailureKind("SOURCE_INVALID", "", "", true),
    "invalidArchiveAtTop",
  );
  assertEquals(
    importFailureKind("SOURCE_INVALID", "skills/a", "", true),
    "invalidArchive",
  );
  assertEquals(
    importFailureKind("SOURCE_UNAVAILABLE", "", "", true),
    "unavailableArchive",
  );
  assertEquals(importFailureKind("SOURCE_TIMEOUT", "", "", true), "timeout");
});
