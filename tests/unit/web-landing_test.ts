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

const DOC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VERSION = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const COMMENT = "cccccccc-dddd-4eee-8fff-000000000000";
const CONVERSATION = "dddddddd-eeee-4fff-8000-111111111111";
const MESSAGE = "eeeeeeee-ffff-4000-8111-222222222222";

Deno.test("a grant-only reader's document path opens the shared document, with its version and comment", () => {
  assertEquals(
    landingRoute(
      `/shared/documents/${DOC}?version=${VERSION}&comment=${COMMENT}`,
    ),
    {
      to: "/shared/documents/$artifactId",
      params: { artifactId: DOC },
      own: { version: VERSION, comment: COMMENT },
    },
  );
  assertEquals(landingRoute(`/shared/documents/${DOC}`), {
    to: "/shared/documents/$artifactId",
    params: { artifactId: DOC },
    own: { version: undefined, comment: undefined },
  });
});

Deno.test("a grant-only reader's conversation path opens the shared conversation at its message", () => {
  assertEquals(
    landingRoute(`/shared/conversations/${CONVERSATION}?message=${MESSAGE}`),
    {
      to: "/shared/conversations/$conversationId",
      params: { conversationId: CONVERSATION },
      own: { message: MESSAGE },
    },
  );
});

Deno.test("a shared path with a bad id, a bad parameter or another prefix is not followed", () => {
  assertEquals(landingRoute("/shared/documents/not-a-uuid"), null);
  assertEquals(landingRoute(`/shared/documents/${DOC}/extra`), null);
  assertEquals(landingRoute(`/shared/files/${DOC}`), null);
  assertEquals(landingRoute(`/files/versions/${DOC}`), null);
  assertEquals(
    landingRoute(`/shared/documents/${DOC}?comment=nope&version=${VERSION}`),
    {
      to: "/shared/documents/$artifactId",
      params: { artifactId: DOC },
      own: { version: VERSION, comment: undefined },
    },
  );
});

Deno.test("a shared target opens its page with its own search, the anchor and the read marker", () => {
  assertEquals(
    landingDestination(
      {
        status: "available",
        path: `/shared/documents/${DOC}?version=${VERSION}&comment=${COMMENT}`,
        anchor: `comment:${COMMENT}`,
      },
      { id: ID, revision: 3 },
    ),
    {
      route: {
        to: "/shared/documents/$artifactId",
        params: { artifactId: DOC },
        own: { version: VERSION, comment: COMMENT },
      },
      search: {
        version: VERSION,
        comment: COMMENT,
        at: `comment:${COMMENT}`,
        n: ID,
        r: 3,
      },
    },
  );
  assertEquals(
    landingDestination(
      {
        status: "part_unavailable",
        path: `/shared/documents/${DOC}?version=${VERSION}`,
        anchor: null,
      },
      { id: ID, revision: null },
    )?.search,
    { version: VERSION, gone: true, n: ID },
  );
});
