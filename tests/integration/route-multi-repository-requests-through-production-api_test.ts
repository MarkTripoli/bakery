import { assert, assertEquals } from "@std/assert";
import {
  type CoordinationFixture,
  fourLaneWorkflowDocument,
  openCoordinationFixture,
  threeLaneSpec,
} from "../helpers/coordination-fixture.ts";
import { createFromWorkflow, planOf } from "../helpers/coordination-lanes.ts";

type Lane = { laneKey: string; childTaskId: string; status: string };

Deno.test("an ordinary multi-repository request flows through the production API", async () => {
  const fx = await openCoordinationFixture();
  try {
    const adminCookie = await fx.cookieFor(fx.admin);
    const developerCookie = await fx.cookieFor(fx.developer);
    const call = async (
      cookie: string,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      await fx.productionApp.fetch(
        new Request(`http://test${path}`, {
          method,
          headers: {
            cookie,
            origin: fx.publicBaseUrl,
            "Bakery-Organization-Id": fx.organizationId,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(method === "GET"
              ? {}
              : { "Idempotency-Key": crypto.randomUUID() }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );

    for (
      const [alias, role, key] of [
        ["api", "backend", "api"],
        ["web", "frontend", "web"],
        ["mobile", "mobile", "mobile"],
      ] as const
    ) {
      const set = await call(
        adminCookie,
        "PUT",
        `/v1/applications/${fx.applicationId}/repository-roles`,
        { alias, role, repositoryId: fx.repositories[key].repositoryId },
      );
      assertEquals(set.status, 200, await set.clone().text());
    }
    // The coordinator needs no saved workflow: parent task, spec, materialize.
    const parent = await fx.insertTask(
      "add saved views to the API and web app",
    );
    const created = await call(
      developerCookie,
      "POST",
      "/v1/coordination-plans",
      {
        parentTaskId: parent,
        spec: threeLaneSpec(),
        budgetLimitUsd: "1.5",
      },
    );
    assertEquals(created.status, 201, await created.clone().text());
    const plan = await created.json();
    assertEquals(plan.budgetLimitUsd, "1.5");
    const materialized = await (await call(
      developerCookie,
      "POST",
      `/v1/coordination-plans/${plan.id}/materialize`,
      {},
    )).json() as { lanes: Lane[]; status: string };
    assertEquals(materialized.status, "materialized");
    for (const lane of materialized.lanes) {
      const child = await (await call(
        developerCookie,
        "GET",
        `/v1/tasks/${lane.childTaskId}`,
      )).json();
      assertEquals(child.parentTaskId, parent);
      assert(child.repositoryId && child.repositoryProfileId);
    }
    const listed = await (await call(
      developerCookie,
      "GET",
      `/v1/coordination-plans?parentTaskId=${parent}`,
    )).json();
    assertEquals(listed.items.map((p: { id: string }) => p.id), [plan.id]);
    const links = await (await call(
      developerCookie,
      "GET",
      `/v1/tasks/${parent}/repositories`,
    )).json();
    assertEquals(links.items.length, 3);
    assert(
      links.items.every((l: { provenance: string }) => l.provenance === "plan"),
    );

    // Dependant waits (early start refused, nothing written); an independent lane is admitted immediately.
    const start = (taskId: string) =>
      startRun(fx, call, developerCookie, taskId);
    const web = materialized.lanes.find((l) => l.laneKey === "web")!;
    const mobile = materialized.lanes.find((l) => l.laneKey === "mobile")!;
    assertEquals((await start(mobile.childTaskId)).status, "queued");
    const early = await call(
      developerCookie,
      "POST",
      `/v1/tasks/${web.childTaskId}/runs`,
      {
        workflowVersionId: fx.workflowVersionId,
        repositoryProfileId: (await (await call(
          developerCookie,
          "GET",
          `/v1/tasks/${web.childTaskId}`,
        )).json()).repositoryProfileId,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { taskId: web.childTaskId },
      },
    );
    assertEquals(early.status, 409, "early dependant start is refused");

    const canceled = await (await call(
      developerCookie,
      "POST",
      `/v1/coordination-plans/${plan.id}/cancel`,
      {},
    )).json();
    assertEquals(canceled.status, "canceled");
    const afterCancel = await (await call(
      developerCookie,
      "GET",
      `/v1/tasks/${mobile.childTaskId}`,
    )).json();
    assertEquals(afterCancel.status, "canceled");
  } finally {
    await fx.close();
  }
});

async function startRun(
  fx: CoordinationFixture,
  call: (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>,
  cookie: string,
  taskId: string,
): Promise<{ status: string }> {
  const task = await (await call(cookie, "GET", `/v1/tasks/${taskId}`)).json();
  const response = await call(cookie, "POST", `/v1/tasks/${taskId}/runs`, {
    workflowVersionId: fx.workflowVersionId,
    repositoryProfileId: task.repositoryProfileId,
    executionMode: "repository",
    budgetLimitUsd: "0.005000",
    inputs: { taskId },
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json();
}

Deno.test("#66: a workflow authored, versioned and published through the API becomes a plan", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const cookie = await fx.cookieFor(fx.admin);
    const api = async (
      method: string,
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await fx.productionApp.fetch(
        new Request(`${fx.publicBaseUrl}${path}`, {
          method,
          headers: {
            "Bakery-Organization-Id": fx.organizationId,
            cookie,
            origin: fx.publicBaseUrl,
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
      const text = await response.text();
      return { status: response.status, text, json: () => JSON.parse(text) };
    };

    // The real authoring path: no spec inserted with SQL.
    const workflow = await api("POST", "/v1/workflows", {
      slug: "four-lane",
      name: "Four lanes",
      description: "Authored parallel delivery.",
    });
    assertEquals(workflow.status, 201, workflow.text);
    const workflowId = workflow.json().id;
    const draft = await api("POST", `/v1/workflows/${workflowId}/versions`, {
      definition: fourLaneWorkflowDocument(),
    });
    assertEquals(draft.status, 201, draft.text);
    const published = await api(
      "POST",
      `/v1/workflows/${workflowId}/versions/${draft.json().id}/publish`,
      {},
      { "If-Match": '"1"' },
    );
    assertEquals(published.status, 200, published.text);

    const plan = await planOf(
      await createFromWorkflow(fx, {
        parentTaskId: await fx.insertTask("authored parent"),
        workflowVersionId: published.json().id,
        nodeId: "delivery",
      }),
    );
    assertEquals(
      plan.lanes.map((lane) => lane.laneKey).sort(),
      ["contract", "integration", "mobile", "web"],
    );
    assertEquals(plan.origin, {
      kind: "saved_workflow",
      workflowId,
      workflowVersionId: published.json().id,
      nodeId: "delivery",
    });
  } finally {
    await fx.close();
  }
});
