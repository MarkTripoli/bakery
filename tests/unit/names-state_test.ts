import { assertEquals } from "@std/assert";
import {
  archiveInput,
  changed,
  createInput,
  nameProblem,
  namesOf,
  updateInput,
  valuesOf,
} from "../../apps/web/src/pages/projects/names-state.ts";

const binding = (over: Record<string, unknown> = {}) =>
  ({
    id: "b1",
    organizationId: "o",
    applicationId: "a",
    role: "api",
    alias: null,
    repositoryId: "r1",
    repositorySlug: "api-service",
    provenance: null,
    version: 3,
    archivedAt: null,
    ...over,
  }) as never;

Deno.test("a repository's names are its own, active ones first, each group by name", () => {
  const list = [
    binding({ id: "1", role: "z" }),
    binding({ id: "2", role: "b", archivedAt: "2026-01-01T00:00:00.000Z" }),
    binding({ id: "3", role: "a" }),
    binding({ id: "4", role: "other", repositoryId: "r2" }),
  ];
  assertEquals(
    namesOf(list, "r1").map((item: { id: string }) => item.id),
    ["3", "1", "2"],
  );
});

Deno.test("a name is required and each field is bounded", () => {
  const ok = { name: "api", others: "", note: "" };
  assertEquals(nameProblem(ok), null);
  assertEquals(nameProblem({ ...ok, name: "  " }), "empty");
  assertEquals(nameProblem({ ...ok, others: "x".repeat(201) }), "tooLong");
  assertEquals(nameProblem({ ...ok, note: "x".repeat(200) }), null);
});

Deno.test("empty other names and note are sent as null, and text is trimmed", () => {
  assertEquals(
    createInput("a", "r1", { name: " api ", others: " ", note: " n " }),
    {
      applicationId: "a",
      repositoryId: "r1",
      role: "api",
      alias: null,
      provenance: "n",
    },
  );
  assertEquals(
    updateInput(binding(), { name: "api", others: "backend", note: "" }),
    { expectedVersion: 3, role: "api", alias: "backend", provenance: null },
  );
});

Deno.test("archive and restore switch the same name off and on, carrying the version", () => {
  const now = new Date("2026-02-03T04:05:06.000Z");
  assertEquals(archiveInput(binding(), now), {
    expectedVersion: 3,
    archivedAt: "2026-02-03T04:05:06.000Z",
  });
  assertEquals(
    archiveInput(binding({ archivedAt: "2026-01-01T00:00:00.000Z" }), now),
    { expectedVersion: 3, archivedAt: null },
  );
});

Deno.test("a name is changed only when a value differs from what is saved", () => {
  const saved = binding({ alias: "backend", provenance: "from the wiki" });
  assertEquals(changed(saved, valuesOf(saved)), false);
  assertEquals(changed(saved, { ...valuesOf(saved), note: "other" }), true);
  assertEquals(changed(saved, { ...valuesOf(saved), name: " api " }), false);
});
