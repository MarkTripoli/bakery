import { assertEquals } from "@std/assert";
import {
  agentBindings,
  canUse,
  defaultVersion,
  exportFileName,
  newestFirst,
  stepsOf,
  versionState,
} from "../../apps/web/src/pages/library/workflow-state.ts";

const version = (id: string, revision: number, status: string) =>
  ({ id, revision, status }) as never;

Deno.test("a version is draft or retired by its status, in use when it is the one the workflow points at, else published", () => {
  assertEquals(
    versionState({ id: "a", status: "draft" } as never, "a"),
    "draft",
  );
  assertEquals(
    versionState({ id: "a", status: "retired" } as never, "a"),
    "retired",
  );
  assertEquals(
    versionState({ id: "a", status: "published" } as never, "a"),
    "inUse",
  );
  assertEquals(
    versionState({ id: "b", status: "published" } as never, "a"),
    "published",
  );
  assertEquals(
    versionState({ id: "b", status: "published" } as never, null),
    "published",
  );
  assertEquals(
    versionState({ id: "b", status: "something-new" } as never, "a"),
    "published",
  );
});

Deno.test("only a published version that is not in use can be used", () => {
  assertEquals(canUse({ id: "b", status: "published" } as never, "a"), true);
  assertEquals(canUse({ id: "a", status: "published" } as never, "a"), false);
  assertEquals(canUse({ id: "c", status: "draft" } as never, "a"), false);
  assertEquals(canUse({ id: "d", status: "retired" } as never, "a"), false);
});

Deno.test("versions are newest first, and the page opens on the one in use, else the newest published, else the newest", () => {
  const all = [
    version("v1", 1, "retired"),
    version("v3", 3, "published"),
    version("v2", 2, "published"),
    version("v4", 4, "draft"),
  ];
  assertEquals(newestFirst(all).map((row) => row.id), ["v4", "v3", "v2", "v1"]);
  assertEquals(defaultVersion(all, "v2")?.id, "v2");
  assertEquals(defaultVersion(all, null)?.id, "v3");
  assertEquals(defaultVersion([version("v4", 4, "draft")], null)?.id, "v4");
  assertEquals(defaultVersion([], null), null);
});

Deno.test("steps are read in order with the agent version a step names, else the workflow's binding for its action", () => {
  const steps = stepsOf({
    normalizedSpec: {
      kind: "fixed",
      agents: { "harness.implement": "av-default" },
      steps: [
        { id: "brief", uses: "task.brief" },
        { id: "implement", uses: "harness.implement" },
        { id: "review", uses: "agent.review", agentVersionId: "av-own" },
        { id: "", uses: "ignored" },
        { uses: "no-id" },
      ],
    },
  } as never);
  assertEquals(steps, [
    { id: "brief", uses: "task.brief", agentVersionId: null },
    {
      id: "implement",
      uses: "harness.implement",
      agentVersionId: "av-default",
    },
    { id: "review", uses: "agent.review", agentVersionId: "av-own" },
  ]);
  assertEquals(stepsOf({ normalizedSpec: null } as never), []);
  assertEquals(stepsOf({ normalizedSpec: { steps: "nope" } } as never), []);
});

Deno.test("an agent version resolves to its agent's name and its number", () => {
  const found = agentBindings(
    [{ id: "a1", name: "Code writer" }, {
      id: "a2",
      name: "Reviewer",
    }] as never,
    new Map([
      ["a1", [{ id: "av1", revision: 2 }] as never],
      ["a2", [{ id: "av2", revision: 1 }] as never],
    ]),
  );
  assertEquals(found.get("av1"), { agentName: "Code writer", revision: 2 });
  assertEquals(found.get("av2"), { agentName: "Reviewer", revision: 1 });
  assertEquals(found.get("missing"), undefined);
});

Deno.test("an exported file is named for the workflow's slug and the version, safely", () => {
  assertEquals(exportFileName("release-train", 3), "release-train-v3.yaml");
  assertEquals(exportFileName("a b/c", 1), "a-b-c-v1.yaml");
  assertEquals(exportFileName("", 2), "workflow-v2.yaml");
  // A path never escapes: separators become dashes.
  assertEquals(exportFileName("../x", 2), "..-x-v2.yaml");
});
