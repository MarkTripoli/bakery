import { assertEquals } from "@std/assert";
import {
  belongsToWords,
  changedWhen,
  copiedWords,
  emptyWords,
  fileSize,
  fingerprint,
  licenseShownInFiles,
  manifestFiles,
  pinnedRevisions,
  scopeWords,
  serverScope,
  skillBadges,
  skillFilter,
  skillOrigin,
  skillSearch,
  sourceKindWords,
  usedByGroups,
  versionInUseWords,
  versionStatusWords,
} from "../../apps/web/src/pages/library/skills-state.ts";
import { libraryTab } from "../../apps/web/src/pages/library/library-state.ts";

const ID = "00000000-0000-4000-8000-000000000001";

Deno.test("the Skills tab is a Library tab of its own", () => {
  assertEquals(libraryTab("skills"), "skills");
});

Deno.test("the scope filter reads the URL and sends the server's scope", () => {
  assertEquals(skillFilter("global"), "global");
  assertEquals(skillFilter("organization"), "organization");
  assertEquals(skillFilter("personal"), "personal");
  assertEquals(skillFilter("mine"), "all");
  assertEquals(skillFilter(undefined), "all");
  assertEquals(serverScope("all"), undefined);
  assertEquals(serverScope("personal"), "personal");
});

Deno.test("a name search is trimmed, capped at 200 and dropped when empty", () => {
  assertEquals(skillSearch("  house "), "house");
  assertEquals(skillSearch("   "), undefined);
  assertEquals(skillSearch(undefined), undefined);
  assertEquals(skillSearch(7), undefined);
  assertEquals(skillSearch("x".repeat(250))?.length, 200);
});

Deno.test("who a skill belongs to has one set of words", () => {
  assertEquals(belongsToWords("global").key, "library.skills.belongsTo.global");
  assertEquals(
    belongsToWords("personal").key,
    "library.skills.belongsTo.personal",
  );
  assertEquals(scopeWords("personal").key, "library.skills.scope.personal");
});

Deno.test("the list badges only Turned off: Private and Draft are said in words beside it", () => {
  assertEquals(skillBadges({ enabled: false }), ["turnedOff"]);
  assertEquals(skillBadges({ enabled: true }), []);
});

Deno.test("Files says the licence only when Where it came from does not say the same", () => {
  // No licence of its own: nothing to say.
  assertEquals(licenseShownInFiles(null, "none"), false);
  assertEquals(licenseShownInFiles(null, { license: "MIT" }), false);
  // No source (written here, or a copy): no other card says it.
  assertEquals(licenseShownInFiles("MIT", "none"), true);
  // The source cannot be read: do not lose the fact.
  assertEquals(licenseShownInFiles("MIT", "failed"), true);
  // The source is still loading: wait, so it does not flash and go.
  assertEquals(licenseShownInFiles("MIT", "loading"), false);
  // The source says the same: said once, there.
  assertEquals(licenseShownInFiles("MIT", { license: "MIT" }), false);
  // The source says something else, or nothing: the skill's own is new.
  assertEquals(licenseShownInFiles("MIT", { license: "Apache-2.0" }), true);
  assertEquals(licenseShownInFiles("MIT", { license: null }), true);
});

Deno.test("the version in use, or No version yet in muted text", () => {
  assertEquals(
    versionInUseWords({ activeVersionId: ID, activeRevision: 3 }),
    {
      words: { key: "library.skills.version", values: { number: 3 } },
      muted: false,
    },
  );
  assertEquals(
    versionInUseWords({ activeVersionId: null, activeRevision: null }),
    { words: { key: "library.skills.noVersion" }, muted: true },
  );
});

Deno.test("changed is relative within a week, then a date", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");
  assertEquals(
    changedWhen("2026-11-22T11:50:00.000Z", now, "en", "UTC"),
    "10 minutes ago",
  );
  assertEquals(
    changedWhen("2026-11-22T09:00:00.000Z", now, "en", "UTC"),
    "3 hours ago",
  );
  assertEquals(
    changedWhen("2026-11-21T09:00:00.000Z", now, "en", "UTC"),
    "yesterday",
  );
  assertEquals(
    changedWhen("2026-11-18T12:00:00.000Z", now, "en", "UTC"),
    "4 days ago",
  );
  assertEquals(
    changedWhen("2026-11-01T12:00:00.000Z", now, "en", "UTC"),
    "Nov 1, 2026",
  );
});

Deno.test("an empty list says the search or the filter, never both", () => {
  assertEquals(emptyWords("personal", "house"), {
    title: { key: "library.skills.empty.search", values: { text: "house" } },
    description: null,
  });
  assertEquals(emptyWords("personal", undefined), {
    title: { key: "library.skills.empty.personal.title" },
    description: { key: "library.skills.empty.personal.description" },
  });
});

Deno.test("the manifest lists the instructions file first, then the others by path", () => {
  const files = manifestFiles({
    entryPath: "SKILL.md",
    manifest: {
      schemaVersion: 1,
      entryPath: "SKILL.md",
      license: "MIT",
      files: [
        {
          path: "scripts/run.sh",
          mediaType: "text/x-shellscript",
          sizeBytes: 120,
          sha256: "a",
          isExecutable: true,
        },
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          sizeBytes: 2048,
          sha256: "b",
          isExecutable: false,
        },
        {
          path: "examples/a.md",
          mediaType: "text/markdown",
          sizeBytes: 10,
          sha256: "c",
          isExecutable: false,
        },
      ],
    },
  });
  assertEquals(files.entry?.path, "SKILL.md");
  assertEquals(files.others.map((file) => file.path), [
    "examples/a.md",
    "scripts/run.sh",
  ]);
  assertEquals(files.license, "MIT");
});

Deno.test("a manifest of another shape lists nothing and has no licence", () => {
  assertEquals(manifestFiles({ entryPath: "SKILL.md", manifest: null }), {
    entry: null,
    others: [],
    license: null,
  });
  assertEquals(
    manifestFiles({ entryPath: "SKILL.md", manifest: { files: "x" } }).others,
    [],
  );
});

Deno.test("sizes, fingerprints and statuses in words", () => {
  assertEquals(fileSize(120, "en"), "120 bytes");
  assertEquals(fileSize(2048, "en"), "2 kB");
  assertEquals(fileSize(1_500_000, "en"), "1.5 MB");
  assertEquals(fingerprint("sha256:0123456789abcdef"), "0123456789ab");
  assertEquals(fingerprint("abcdef"), "abcdef");
  assertEquals(
    versionStatusWords("retired").key,
    "library.skill.versions.status.retired",
  );
  assertEquals(
    sourceKindWords("local_bundle").key,
    "library.skill.origin.kind.local_bundle",
  );
});

Deno.test("used by is two groups, each in name order", () => {
  const usage = (
    kind: "agent" | "workflow",
    name: string,
    revision: number,
  ) => ({
    kind,
    definitionId: ID,
    definitionName: name,
    versionId: ID,
    revision,
    skillVersionIds: [ID],
    createdAt: "2026-11-20T09:00:00.000Z",
  });
  const groups = usedByGroups([
    usage("workflow", "Release", 2),
    usage("agent", "Reviewer", 4),
    usage("workflow", "Nightly", 1),
  ]);
  assertEquals(groups.agents.map((row) => row.definitionName), ["Reviewer"]);
  assertEquals(groups.workflows.map((row) => row.definitionName), [
    "Nightly",
    "Release",
  ]);
});

Deno.test("where a skill came from: a copy, then a source, else written here", () => {
  assertEquals(
    skillOrigin({
      copiedFromSkillId: ID,
      copiedFromVersionId: null,
      sourceId: ID,
    }),
    { kind: "copied", skillId: ID, versionId: null },
  );
  assertEquals(
    skillOrigin({
      copiedFromSkillId: null,
      copiedFromVersionId: null,
      sourceId: ID,
    }),
    { kind: "source", sourceId: ID },
  );
  assertEquals(
    skillOrigin({
      copiedFromSkillId: null,
      copiedFromVersionId: null,
      sourceId: null,
    }),
    { kind: "written" },
  );
  assertEquals(copiedWords("House style", 2), {
    key: "library.skill.origin.copied",
    values: { name: "House style", number: 2 },
  });
  assertEquals(copiedWords("House style", null), {
    key: "library.skill.origin.copiedNamed",
    values: { name: "House style" },
  });
  assertEquals(copiedWords(null, 2), {
    key: "library.skill.origin.copiedUnknown",
  });
});

Deno.test("a usage row names the versions of the skill it pins, once each, in order", () => {
  const versions = [
    { id: "v1", revision: 1 },
    { id: "v2", revision: 2 },
    { id: "v3", revision: 3 },
  ];
  assertEquals(pinnedRevisions({ skillVersionIds: ["v1"] }, versions), [1]);
  // Order and repeats in the answer do not matter.
  assertEquals(
    pinnedRevisions({ skillVersionIds: ["v2", "v1", "v2"] }, versions),
    [1, 2],
  );
  // A version the page cannot name is left out, never guessed.
  assertEquals(
    pinnedRevisions({ skillVersionIds: ["v3", "gone"] }, versions),
    [3],
  );
  assertEquals(pinnedRevisions({ skillVersionIds: [] }, versions), []);
});
