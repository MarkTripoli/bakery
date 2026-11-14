import { assertEquals } from "@std/assert";
import {
  byName,
  definitionBadge,
  libraryTab,
} from "../../apps/web/src/pages/library/library-state.ts";

Deno.test("the tab is Agents only when asked for, otherwise Workflows", () => {
  assertEquals(libraryTab("agents"), "agents");
  assertEquals(libraryTab("workflows"), "workflows");
  assertEquals(libraryTab(undefined), "workflows");
  assertEquals(libraryTab("anything else"), "workflows");
});

Deno.test("a turned-off definition is Turned off whatever its version; no version in use is its own badge", () => {
  assertEquals(
    definitionBadge({ enabled: true, activeVersionId: "v1" }),
    "inUse",
  );
  assertEquals(
    definitionBadge({ enabled: false, activeVersionId: "v1" }),
    "turnedOff",
  );
  assertEquals(
    definitionBadge({ enabled: false, activeVersionId: null }),
    "turnedOff",
  );
  assertEquals(
    definitionBadge({ enabled: true, activeVersionId: null }),
    "noVersionInUse",
  );
});

Deno.test("definitions are listed in name order, ties by id, without changing the input", () => {
  const rows = [
    { id: "b", name: "Beta" },
    { id: "a2", name: "Alpha" },
    { id: "a1", name: "Alpha" },
  ] as never[];
  assertEquals(byName(rows).map((row: { id: string }) => row.id), [
    "a1",
    "a2",
    "b",
  ]);
  assertEquals((rows[0] as { id: string }).id, "b");
});
