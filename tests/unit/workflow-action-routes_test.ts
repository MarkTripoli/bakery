import { assertEquals } from "@std/assert";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import { createWorkflowActionRoutes } from "../../apps/server/src/modules/workflow-actions/routes.ts";

const publicBaseUrl = "https://bakery.example";

function authenticatedRoutes() {
  return createWorkflowActionRoutes({
    publicBaseUrl,
    browserSession: async (_context, next) => await next(),
  });
}

function cursorRecord(cursor: string): Record<string, unknown> {
  const encoded = cursor.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
  );
}

function encodedCursor(record: Record<string, unknown>): string {
  return btoa(JSON.stringify(record))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

Deno.test("workflow action routes register the authenticated list and detail endpoints", async () => {
  const app = authenticatedRoutes();
  const listResponse = await app.request("/v1/workflow-actions");
  const list = await listResponse.json();

  assertEquals(listResponse.status, 200);
  assertEquals(list.nextCursor, null);
  assertEquals(
    list.items.map((item: { actionId: string }) => item.actionId),
    [...WORKFLOW_ACTION_NAMES],
  );
  assertEquals(list.items.length, 19);
  assertEquals(list.items[0], {
    actionId: WORKFLOW_ACTION_NAMES[0],
    version: WORKFLOW_ACTION_REGISTRY_VERSION,
    ...WORKFLOW_ACTION_METADATA[WORKFLOW_ACTION_NAMES[0]],
    modelBillingRequired: true,
  });
  assertEquals("handler" in list.items[0], false);

  const actionId = "harness.implement";
  const detailResponse = await app.request(
    `/v1/workflow-actions/${actionId}/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
  );
  assertEquals(detailResponse.status, 200);
  assertEquals(await detailResponse.json(), {
    actionId,
    version: WORKFLOW_ACTION_REGISTRY_VERSION,
    ...WORKFLOW_ACTION_METADATA[actionId],
    modelBillingRequired: true,
  });
});

Deno.test("workflow action list paginates the canonical order without gaps or duplicates", async () => {
  const app = authenticatedRoutes();
  const actionIds: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ limit: "4" });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await app.request(`/v1/workflow-actions?${query}`);
    const page = await response.json();

    assertEquals(response.status, 200);
    assertEquals(page.items.length <= 4, true);
    actionIds.push(
      ...page.items.map((item: { actionId: string }) => item.actionId),
    );
    cursor = page.nextCursor;
    if (cursor !== null) {
      assertEquals(cursors.has(cursor), false);
      cursors.add(cursor);
    }
  } while (cursor !== null);

  assertEquals(actionIds, [...WORKFLOW_ACTION_NAMES]);
  assertEquals(new Set(actionIds).size, WORKFLOW_ACTION_NAMES.length);
  assertEquals(cursors.size, 4);
});

Deno.test("workflow action list enforces limit boundaries", async () => {
  const app = authenticatedRoutes();
  for (
    const [limit, expectedLength, hasNext] of [
      ["1", 1, true],
      ["18", 18, true],
      ["19", 19, false],
      ["100", 19, false],
    ] as const
  ) {
    const response = await app.request(`/v1/workflow-actions?limit=${limit}`);
    const page = await response.json();
    assertEquals(response.status, 200);
    assertEquals(page.items.length, expectedLength);
    assertEquals(page.nextCursor !== null, hasNext);
  }

  for (const limit of ["", "0", "01", "-1", "1.5", "101", "NaN"]) {
    const response = await app.request(`/v1/workflow-actions?limit=${limit}`);
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "MALFORMED_REQUEST");
  }

  for (
    const query of [
      "limit=1&limit=2",
      "page=1",
      "pageNumber=1",
      "pageIndex=1",
      "offset=1",
      "skip=1",
    ]
  ) {
    const response = await app.request(`/v1/workflow-actions?${query}`);
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "MALFORMED_REQUEST");
  }
});

Deno.test("workflow action list rejects malformed, unknown, and incompatible cursors", async () => {
  const app = authenticatedRoutes();
  const first = await (
    await app.request("/v1/workflow-actions?limit=1")
  ).json();
  const validCursor = first.nextCursor as string;
  const validRecord = cursorRecord(validCursor);
  const invalidCursors = [
    "",
    "not-a-cursor",
    `${validCursor}=`,
    encodedCursor({ ...validRecord, catalogVersion: 2 }),
    encodedCursor({ ...validRecord, ordering: "action-id:asc" }),
    encodedCursor({ ...validRecord, after: "unknown.action" }),
    encodedCursor({
      ...validRecord,
      after: WORKFLOW_ACTION_NAMES.at(-1),
    }),
  ];

  for (const cursor of invalidCursors) {
    const response = await app.request(
      `/v1/workflow-actions?cursor=${encodeURIComponent(cursor)}`,
    );
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "INVALID_CURSOR");
  }

  const duplicate = await app.request(
    `/v1/workflow-actions?cursor=${validCursor}&cursor=${validCursor}`,
  );
  assertEquals(duplicate.status, 400);
  assertEquals((await duplicate.json()).code, "MALFORMED_REQUEST");
});

Deno.test("workflow action detail fails closed for unknown actions and versions", async () => {
  const app = authenticatedRoutes();
  for (
    const path of [
      "/v1/workflow-actions/unknown.action/versions/1",
      "/v1/workflow-actions/rpi.research/versions/2",
      "/v1/workflow-actions/rpi.research/versions/01",
    ]
  ) {
    const response = await app.request(path);
    const body = await response.json();
    assertEquals(response.status, 404);
    assertEquals(body.code, "RESOURCE_NOT_FOUND");
  }
});

Deno.test("workflow action routes reject unauthenticated requests before metadata handlers", async () => {
  let rejected = 0;
  const app = createWorkflowActionRoutes({
    publicBaseUrl,
    browserSession: (context) => {
      rejected += 1;
      return Promise.resolve(context.json({ code: "AUTH_REQUIRED" }, 401));
    },
  });

  for (
    const path of [
      "/v1/workflow-actions?limit=0&cursor=not-a-cursor",
      "/v1/workflow-actions/rpi.research/versions/1",
    ]
  ) {
    const response = await app.request(path);
    assertEquals(response.status, 401);
    assertEquals(await response.json(), { code: "AUTH_REQUIRED" });
  }
  assertEquals(rejected, 2);
});
