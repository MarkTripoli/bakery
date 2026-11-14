import { assertEquals } from "@std/assert";
import {
  copyName,
  NAME_LIMIT,
  presetSource,
  slugOf,
  uniqueSlug,
  versionSource,
} from "../../apps/web/src/pages/library/copy-workflow.ts";

Deno.test("a name becomes an address the server accepts", () => {
  assertEquals(slugOf("Release train (copy)"), "release-train-copy");
  assertEquals(slugOf("  Café déploiement  "), "cafe-deploiement");
  assertEquals(slugOf("!!!"), "workflow");
  const pattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  for (const name of ["a", "A--B", "x".repeat(300), "Ünï cødé 2"]) {
    const slug = slugOf(name);
    assertEquals(pattern.test(slug) && slug.length <= 100, true, name);
  }
});

Deno.test("an address taken by another workflow gets the next free number", () => {
  assertEquals(uniqueSlug("Release train", new Set()), "release-train");
  assertEquals(
    uniqueSlug("Release train", new Set(["release-train"])),
    "release-train-2",
  );
  assertEquals(
    uniqueSlug("Release train", new Set(["release-train", "release-train-2"])),
    "release-train-3",
  );
});

Deno.test("a copy's name says it is a copy and stays within the limit", () => {
  assertEquals(copyName("Release train", "(copy)"), "Release train (copy)");
  const long = copyName("n".repeat(400), "(copy)");
  assertEquals(long.length <= NAME_LIMIT, true);
  assertEquals(long.endsWith(" (copy)"), true);
});

Deno.test("a built-in workflow's steps become a definition with only id and action", () => {
  const source = presetSource(
    {
      revision: 3,
      steps: [{ id: "brief", uses: "task.brief" }, {
        id: "implement",
        uses: "harness.implement",
      }],
    },
    { title: "Coding", description: null },
  );
  assertEquals(source.name, "Coding");
  assertEquals(source.description, "");
  assertEquals(source.revision, 3);
  assertEquals(source.definition, {
    steps: [{ id: "brief", uses: "task.brief" }, {
      id: "implement",
      uses: "harness.implement",
    }],
  });
  assertEquals("sourceYaml" in source, false);
});

Deno.test("a copy of a version carries its definition and its file when it has one", () => {
  const spec = { steps: [{ id: "a", uses: "task.brief" }] };
  const withFile = versionSource({ name: "Mine", description: "Does it" }, {
    revision: 2,
    normalizedSpec: spec,
    sourceYaml: "steps: []\n",
  });
  assertEquals(withFile.definition, spec);
  assertEquals(withFile.sourceYaml, "steps: []\n");
  assertEquals(withFile.description, "Does it");
  const without = versionSource({ name: "Mine" }, {
    revision: 1,
    normalizedSpec: spec,
    sourceYaml: "",
  });
  assertEquals("sourceYaml" in without, false);
  assertEquals(without.description, "");
});
