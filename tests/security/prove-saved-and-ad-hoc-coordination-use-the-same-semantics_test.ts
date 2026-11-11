import { assert, assertEquals } from "@std/assert";
import {
  fourLaneSpec,
  fourLaneWorkflowDocument,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import {
  childOf,
  completeLane,
  createFromWorkflow,
  createPlan,
  materialize,
  planOf,
  publishOutput,
} from "../helpers/coordination-lanes.ts";

const SECRET_QUESTION = "PRIVATE-CHILD-QUESTION-PROMPT";

Deno.test("every origin enforces the same roles, tenancy and workflow visibility", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const published = await fx.publishWorkflowVersion(
      fourLaneWorkflowDocument(),
    );
    const draft = await fx.publishWorkflowVersion(
      fourLaneWorkflowDocument(),
      { status: "draft" },
    );
    const foreign = await fx.publishWorkflowVersion(
      fourLaneWorkflowDocument(),
      { organizationId: fx.hostileOrganizationId },
    );
    const parent = await fx.insertTask("security parent");
    const body = (workflowVersionId: string) => ({
      parentTaskId: parent,
      workflowVersionId,
      nodeId: "delivery",
    });

    // A viewer reads but cannot create from any origin.
    assertEquals(
      (await fx.send(fx.viewer, "POST", "/v1/coordination-plans", {
        body: { parentTaskId: parent, spec: fourLaneSpec() },
      })).status,
      403,
    );
    assertEquals(
      (await fx.send(
        fx.viewer,
        "POST",
        "/v1/coordination-plans/from-workflow",
        { body: body(published.workflowVersionId) },
      )).status,
      403,
    );
    assertEquals(
      (await fx.send(fx.viewer, "GET", "/v1/coordination-plans")).status,
      200,
    );

    // Foreign, missing and unpublished workflow versions are all not found,
    // so a caller cannot tell them apart or probe another organization.
    for (
      const workflowVersionId of [
        foreign.workflowVersionId,
        draft.workflowVersionId,
        crypto.randomUUID(),
      ]
    ) {
      const response = await createFromWorkflow(fx, body(workflowVersionId));
      assertEquals(response.status, 404, await response.text());
    }
    const none = await fx.owner`
      select count(*)::int as count from bakery.coordination_plans
       where organization_id = ${fx.organizationId}
         and parent_task_id = ${parent}`;
    assertEquals(none[0].count, 0, "a refused request stores nothing");

    // A principal of another organization cannot reach the entry at all.
    for (
      const organizationId of [fx.organizationId, fx.hostileOrganizationId]
    ) {
      const response = await fx.send(
        fx.outsider,
        "POST",
        "/v1/coordination-plans/from-workflow",
        { organizationId, body: body(published.workflowVersionId) },
      );
      assert([403, 404].includes(response.status), String(response.status));
    }

    // Parent access is checked before the workflow is read: a missing parent
    // and a parent in another organization give the same refusal whether or
    // not the workflow version exists or maps.
    const problem = async (response: Response) => {
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      return { status: response.status, code: body.code, type: body.type };
    };
    const refusals = [];
    for (
      const workflowVersionId of [
        published.workflowVersionId,
        draft.workflowVersionId,
        crypto.randomUUID(),
      ]
    ) {
      refusals.push(
        await problem(
          await createFromWorkflow(fx, {
            parentTaskId: crypto.randomUUID(),
            workflowVersionId,
            nodeId: "delivery",
          }),
        ),
        await problem(
          await createFromWorkflow(fx, {
            parentTaskId: crypto.randomUUID(),
            workflowVersionId,
            nodeId: "not-a-parallel-node",
          }),
        ),
        await problem(
          await fx.send(
            fx.outsider,
            "POST",
            "/v1/coordination-plans/from-workflow",
            {
              organizationId: fx.hostileOrganizationId,
              body: {
                parentTaskId: parent,
                workflowVersionId,
                nodeId: "delivery",
              },
            },
          ),
        ),
      );
    }
    assertEquals(
      new Set(refusals.map((r) => JSON.stringify(r))).size,
      1,
      `one refusal for every combination: ${JSON.stringify(refusals[0])}`,
    );
    assertEquals(refusals[0].status, 404);

    // The saved origin cannot be claimed by a caller that composed the plan,
    // and a ticket origin must be https and bounded.
    const claimed = await createPlan(fx, parent, fourLaneSpec(), {
      origin: {
        kind: "saved_workflow",
        workflowId: published.workflowId,
        workflowVersionId: published.workflowVersionId,
        nodeId: "delivery",
      },
    });
    assertEquals(claimed.status, 422);
    assert((await claimed.text()).includes("origin_not_allowed"));
    const badOrigins = [
      {
        kind: "ticket",
        provider: "jira",
        reference: "X-1",
        url: "http://x.test/1",
      },
      {
        kind: "ticket",
        provider: "jira",
        reference: "X-1",
        url: "javascript:alert(1)",
      },
      {
        kind: "ticket",
        provider: "jira",
        reference: "X-1",
        url: `https://x.test/${"a".repeat(2048)}`,
      },
      { kind: "ticket", provider: "jira", reference: "X-1", extra: true },
      { kind: "elsewhere" },
    ];
    for (const origin of badOrigins) {
      const response = await createPlan(fx, parent, fourLaneSpec(), { origin });
      assertEquals(response.status, 422, JSON.stringify(origin).slice(0, 80));
    }
    const stillNone = await fx.owner`
      select count(*)::int as count from bakery.coordination_plans
       where organization_id = ${fx.organizationId}
         and parent_task_id = ${parent}`;
    assertEquals(stillNone[0].count, 0);
  } finally {
    await fx.close();
  }
});

Deno.test("parent read and list never carry child evidence or private questions", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const saved = await fx.publishWorkflowVersion(fourLaneWorkflowDocument());
    const parent = await fx.insertTask("evidence parent");
    const plan = await materialize(
      fx,
      (await planOf(
        await createFromWorkflow(fx, {
          parentTaskId: parent,
          workflowVersionId: saved.workflowVersionId,
          nodeId: "delivery",
        }),
      )).id,
    );
    const contract = await completeLane(fx, plan, "contract", "contract");
    assert(contract.output);
    const extra = await publishOutput(fx, childOf(plan, "web"), "evidence");

    // A question private to the admin on a child task.
    const child = await fx.owner`
      select id, conversation_id from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${
      childOf(plan, "web")
    }`;
    await fx.owner`
      insert into bakery.questions (
        organization_id, kind, conversation_id, task_id, generation, prompt,
        allow_free_text, audience
      ) values (${fx.organizationId}, 'question', ${child[0].conversation_id},
        ${child[0].id}, 1, ${SECRET_QUESTION}, true,
        ${
      fx.owner.json({
        type: "principals",
        principalIds: [fx.admin.principalId],
      })
    })`;

    const laneKeys = [
      "childTaskId",
      "declaredOutputs",
      "laneDigest",
      "laneKey",
      "prerequisites",
      "repositoryId",
      "reusedFromLaneId",
      "status",
    ];
    for (const viewer of [fx.developer, fx.viewer, fx.admin]) {
      const read = await fx.send(
        viewer,
        "GET",
        `/v1/coordination-plans/${plan.id}`,
      );
      const list = await fx.send(
        viewer,
        "GET",
        `/v1/coordination-plans?parentTaskId=${parent}`,
      );
      for (const response of [read, list]) {
        const text = await response.text();
        assertEquals(response.status, 200, text);
        for (
          const leaked of [
            SECRET_QUESTION,
            contract.output.versionId,
            contract.output.sha,
            extra.versionId,
            extra.sha,
            "snapshot",
            "content",
          ]
        ) {
          assert(!text.includes(leaked), `${leaked} leaked to a plan read`);
        }
        const parsed = JSON.parse(text);
        const plans = parsed.items ?? [parsed];
        for (const item of plans) {
          for (const lane of item.lanes) {
            assertEquals(Object.keys(lane).sort(), laneKeys);
          }
        }
      }
    }

    // Question reads go through the real question operations. A question
    // private to named principals is invisible to everyone else: it is absent
    // from lists and not found by id, for the viewer role and for a developer
    // outside the audience alike. Only the audience member sees and answers it.
    const questionId = (await fx.owner`
      select id from bakery.questions
       where organization_id = ${fx.organizationId} and task_id = ${
      child[0].id
    }`)[0]
      .id as string;
    const listPath = `/v1/questions?taskId=${child[0].id}`;
    const visible = async (principal: typeof fx.admin) => {
      const response = await fx.sendQuestions(principal, "GET", listPath);
      const body = await response.json();
      return {
        status: response.status,
        ids: response.status === 200
          ? (body.items as { id: string }[]).map((q) => q.id)
          : [],
      };
    };
    assertEquals(await visible(fx.viewer), { status: 200, ids: [] });
    assertEquals(await visible(fx.developer), { status: 200, ids: [] });
    assertEquals(await visible(fx.admin), { status: 200, ids: [questionId] });
    for (const principal of [fx.viewer, fx.developer]) {
      assertEquals(
        (await fx.sendQuestions(
          principal,
          "GET",
          `/v1/questions/${questionId}`,
        ))
          .status,
        404,
      );
    }
    assertEquals(
      (await fx.sendQuestions(fx.admin, "GET", `/v1/questions/${questionId}`))
        .status,
      200,
    );
    // The parent task's question list holds no child question.
    const parentList = await (await fx.sendQuestions(
      fx.developer,
      "GET",
      `/v1/questions?taskId=${parent}`,
    )).json();
    assertEquals(parentList.items, []);
    // The developer outside the audience gets the same 404 as get; the viewer
    // role is refused by role (403) for every question id, existing or not.
    for (
      const [principal, expected] of [[fx.developer, 404], [
        fx.viewer,
        403,
      ]] as const
    ) {
      const denied = await fx.sendQuestions(
        principal,
        "PUT",
        `/v1/questions/${questionId}/answer`,
        { body: { answer: { text: "not for me" } } },
      );
      assertEquals(
        denied.status,
        expected,
        `${principal.displayName} must not confirm the question exists`,
      );
    }
    const untouched = await fx.owner`
      select status from bakery.questions where id = ${questionId}`;
    assertEquals(untouched[0].status, "open", "outsiders left it open");

    // A private approval and a private question on an archived conversation
    // answer the outsider with the same 404: neither the kind refusal nor the
    // archived refusal confirms the id exists.
    const privateAudience = fx.owner.json({
      type: "principals",
      principalIds: [fx.admin.principalId],
    });
    const approvalId = crypto.randomUUID();
    await fx.owner`
      insert into bakery.questions (
        id, organization_id, kind, conversation_id, task_id, generation, prompt,
        allow_free_text, audience
      ) values (${approvalId}, ${fx.organizationId}, 'approval',
        ${child[0].conversation_id}, ${child[0].id}, 1, 'private approval',
        false, ${privateAudience})`;
    const archivedChild = await fx.insertTask("archived private question");
    const archivedConversation = (await fx.owner`
      select id, conversation_id from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${archivedChild}`)[
      0
    ];
    const archivedQuestionId = crypto.randomUUID();
    await fx.owner`
      insert into bakery.questions (
        id, organization_id, kind, conversation_id, task_id, generation, prompt,
        allow_free_text, audience
      ) values (${archivedQuestionId}, ${fx.organizationId}, 'question',
        ${archivedConversation.conversation_id}, ${archivedConversation.id}, 1,
        'private archived', true, ${privateAudience})`;
    await fx.owner`
      update bakery.conversations set archived_at = now()
       where organization_id = ${fx.organizationId}
         and id = ${archivedConversation.conversation_id}`;
    for (const hidden of [approvalId, archivedQuestionId]) {
      const denied = await fx.sendQuestions(
        fx.developer,
        "PUT",
        `/v1/questions/${hidden}/answer`,
        { body: { answer: { text: "not for me" } } },
      );
      assertEquals(denied.status, 404, `outsider answering ${hidden}`);
    }
    await fx.owner`
      delete from bakery.questions where id = ${approvalId}`;
    const answered = await fx.sendQuestions(
      fx.admin,
      "PUT",
      `/v1/questions/${questionId}/answer`,
      { body: { answer: { text: "approved" } } },
    );
    assertEquals(answered.status, 200, await answered.clone().text());

    // Replay under different grants: the developer's re-create returns the
    // same plan with the same exact lane shape; the viewer cannot replay.
    const replayed = await createFromWorkflow(fx, {
      parentTaskId: parent,
      workflowVersionId: saved.workflowVersionId,
      nodeId: "delivery",
    });
    const replayText = await replayed.text();
    assertEquals(replayed.status, 201, replayText);
    const replayPlan = JSON.parse(replayText);
    assertEquals(replayPlan.id, plan.id);
    for (const lane of replayPlan.lanes) {
      assertEquals(Object.keys(lane).sort(), laneKeys);
    }
    for (
      const leaked of [SECRET_QUESTION, contract.output.versionId, extra.sha]
    ) {
      assert(!replayText.includes(leaked), `${leaked} leaked on replay`);
    }
    const viewerReplay = await fx.send(
      fx.viewer,
      "POST",
      "/v1/coordination-plans/from-workflow",
      {
        body: {
          parentTaskId: parent,
          workflowVersionId: saved.workflowVersionId,
          nodeId: "delivery",
        },
      },
    );
    assertEquals(viewerReplay.status, 403);
    const sets = [];
    for (const principal of [fx.developer, fx.viewer, fx.admin]) {
      const list = await (await fx.send(
        principal,
        "GET",
        `/v1/coordination-plans?parentTaskId=${parent}`,
      )).json();
      sets.push(list.items.map((p: { id: string }) => p.id));
    }
    assertEquals(sets, [[plan.id], [plan.id], [plan.id]]);
  } finally {
    await fx.close();
  }
});
