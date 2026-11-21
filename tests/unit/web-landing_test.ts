import { assertEquals } from "@std/assert";
import {
  landingDestination,
  landingRoute,
  landingSearch,
  parseLanding,
} from "../../apps/web/src/notifications/landing.ts";

const ID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const TASK = "11111111-2222-4333-8444-555555555555";

Deno.test("an anchor is a kind and an id, or a version number", () => {
  assertEquals(parseLanding(`step:${ID}`), { kind: "step", id: ID });
  assertEquals(parseLanding("version:3"), { kind: "version", id: "3" });
  assertEquals(parseLanding(`comment:${ID}`), { kind: "comment", id: ID });
});

Deno.test("anything else is no landing", () => {
  for (
    const bad of [
      null,
      "",
      "step",
      "step:",
      "step:not-a-uuid",
      "version:0",
      "version:3x",
      "version:1234567890",
      `task:${ID}`,
      `step:${ID}:extra`,
      5,
    ]
  ) assertEquals(parseLanding(bad), null);
});

Deno.test("the search keeps only well-formed landing keys", () => {
  assertEquals(
    landingSearch({ at: `step:${ID}`, gone: "1", n: ID, r: "4", other: "x" }),
    { at: `step:${ID}`, gone: true, n: ID, r: 4 },
  );
  assertEquals(landingSearch({ at: "nope", n: "x", r: "0", gone: "0" }), {});
});

Deno.test("an available target opens its path with its anchor and the read marker", () => {
  assertEquals(
    landingDestination(
      { status: "available", path: `/tasks/${TASK}`, anchor: `step:${ID}` },
      { id: ID, revision: 2 },
    ),
    {
      route: { to: "/tasks/$taskId", params: { taskId: TASK } },
      search: { at: `step:${ID}`, n: ID, r: 2 },
    },
  );
});

Deno.test("a gone part opens the page, says so, and carries no anchor", () => {
  assertEquals(
    landingDestination(
      { status: "part_unavailable", path: `/tasks/${TASK}`, anchor: null },
      { id: ID, revision: null },
    ),
    {
      route: { to: "/tasks/$taskId", params: { taskId: TASK } },
      search: { gone: true, n: ID },
    },
  );
});

Deno.test("an unavailable or unexpected target goes nowhere", () => {
  const note = { id: ID, revision: 1 };
  assertEquals(
    landingDestination(
      { status: "unavailable", path: null, anchor: null },
      note,
    ),
    null,
  );
  for (
    const path of ["https://evil.example/x", "/settings", "/tasks/x", null]
  ) {
    assertEquals(
      landingDestination({ status: "available", path, anchor: null }, note),
      null,
    );
  }
});

Deno.test("the document route is allowed, with its version anchor", () => {
  const art = "99999999-8888-4777-8666-555555555555";
  assertEquals(
    landingDestination(
      {
        status: "available",
        path: `/tasks/${TASK}/artifacts/${art}`,
        anchor: "version:3",
      },
      { id: ID, revision: 1 },
    )?.search.at,
    "version:3",
  );
  assertEquals(
    landingRoute(`/tasks/${TASK}/artifacts/${art}`),
    {
      to: "/tasks/$taskId/artifacts/$artifactId",
      params: { taskId: TASK, artifactId: art },
    },
  );
});
