import { assert, assertEquals } from "@std/assert";
import { CoordinatorEffectSchema } from "../../apps/server/src/modules/conversation/coordinator.ts";
import { requireHumanPrincipal } from "../../apps/server/src/modules/conversation/approvals.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  type ApprovalFixture,
  HUMAN_APPROVAL,
  openApprovalFixture,
  PLAN_EFFECT,
} from "../helpers/scoped-approvals.ts";

async function withFixture(
  work: (f: ApprovalFixture) => Promise<void>,
): Promise<void> {
  const fixture = await openApprovalFixture();
  try {
    await work(fixture);
  } finally {
    await fixture.close();
  }
}

async function pending(f: ApprovalFixture) {
  const task = await f.newTask({ policy: HUMAN_APPROVAL });
  await f.askAgent(task, [PLAN_EFFECT("Guarded")]);
  const [approval] = await f.approvalsFor(task.taskId);
  return { task, approval };
}

Deno.test("service accounts and worker identities cannot decide or revoke, a human with the same role can", () =>
  withFixture(async (f) => {
    const { task, approval } = await pending(f);
    for (const type of ["service", "worker"] as const) {
      const identity = await f.tokenFor(type);
      const decided = await f.decide(approval, "approve", { identity });
      assertEquals(decided.status, 403, type);
      assertEquals((await decided.json()).code, "AUTH_FORBIDDEN");
      assertEquals((await f.revoke(approval, identity)).status, 403, type);
      assertEquals((await f.getApproval(approval.id)).status, "open");
    }
    // Same role and scopes, human principal: the decision goes through.
    const human = await f.tokenFor("human");
    const allowed = await f.decide(approval, "approve", { identity: human });
    assertEquals(allowed.status, 200, await allowed.clone().text());
    // A non-human token cannot consume-by-revoke after approval either.
    const service = await f.tokenFor("service");
    assertEquals((await f.revoke(approval, service)).status, 403);
    assertEquals((await f.getApproval(approval.id)).status, "answered");
    assertEquals(await f.runCount(task.taskId), 0);
  }));

Deno.test("the human-only guard reports approval_requires_human for every non-human type", () => {
  for (const principalType of ["service", "worker", "agent"]) {
    try {
      requireHumanPrincipal(
        { authority: { subject: { principalType } } } as never,
      );
      throw new Error("expected a refusal");
    } catch (error) {
      assert(error instanceof StandardError);
      assertEquals(error.code, "AUTH_FORBIDDEN");
      assertEquals(error.params?.reason, "approval_requires_human");
    }
  }
  requireHumanPrincipal(
    { authority: { subject: { principalType: "human" } } } as never,
  );
});

Deno.test("the coordinator can never emit a decision effect", () => {
  for (const type of ["approval", "approvalDecision", "decision", "decide"]) {
    assertEquals(
      CoordinatorEffectSchema.safeParse({ type, decision: "approve" }).success,
      false,
      type,
    );
  }
});

Deno.test("viewers read approvals but cannot decide; anonymous is refused", () =>
  withFixture(async (f) => {
    const { approval } = await pending(f);
    const viewer = await f.tokenFor("human", { role: "viewer" });
    assertEquals(
      (await f.call(viewer, "GET", `/v1/approvals/${approval.id}`)).status,
      200,
    );
    assertEquals(
      (await f.call(viewer, "GET", `/v1/plan-revisions`)).status,
      200,
    );
    assertEquals(
      (await f.decide(approval, "approve", { identity: viewer })).status,
      403,
    );
    const anonymous = await f.fx.productionApp.fetch(
      new Request(`${f.fx.publicBaseUrl}/v1/approvals/${approval.id}`, {
        headers: { "Bakery-Organization-Id": f.fx.organizationId },
      }),
    );
    assertEquals(anonymous.status, 401);
    assertEquals((await f.getApproval(approval.id)).status, "open");
  }));

Deno.test("a foreign tenant can neither read, list, decide nor revoke", () =>
  withFixture(async (f) => {
    const { task, approval } = await pending(f);
    const outsider = await f.as(f.fx.outsider);
    const org = f.fx.hostileOrganizationId;
    const get = await f.call(outsider, "GET", `/v1/approvals/${approval.id}`, {
      organizationId: org,
    });
    assertEquals(get.status, 404);
    const list = await f.call(outsider, "GET", "/v1/approvals", {
      organizationId: org,
    });
    assertEquals((await list.json()).items.length, 0);
    assertEquals(
      (await f.call(
        outsider,
        "GET",
        `/v1/plan-revisions?taskId=${task.taskId}`,
        {
          organizationId: org,
        },
      ).then((r) => r.json())).items.length,
      0,
    );
    const decide = await f.call(
      outsider,
      "POST",
      `/v1/approvals/${approval.id}/decision`,
      {
        organizationId: org,
        body: { decision: "approve", expectedVersion: approval.version },
      },
    );
    assertEquals(decide.status, 404);
    assertEquals(
      (await f.call(outsider, "POST", `/v1/approvals/${approval.id}/revoke`, {
        organizationId: org,
        body: {},
      })).status,
      404,
    );
    // Naming the victim's organization with the outsider's session is refused.
    const crossHeader = await f.decide(approval, "approve", {
      identity: outsider,
    });
    assert(crossHeader.status === 403 || crossHeader.status === 404);
    assertEquals((await f.getApproval(approval.id)).status, "open");
    // The foreign tenant cannot use the victim's approval at its own tasks either.
  }));

Deno.test("an approval private to named principals does not exist for anyone else", () =>
  withFixture(async (f) => {
    const { approval } = await pending(f);
    const outsider = await f.tokenFor("human");
    const member = await f.tokenFor("human");
    await f.fx.owner`
      update bakery.questions
         set audience = ${
      f.fx.owner.json({
        type: "principals",
        principalIds: [member.principalId],
      })
    }
       where organization_id = ${f.fx.organizationId} and id = ${approval.id}`;
    const ids = async (identity: typeof member) => {
      const list = await f.call(
        identity,
        "GET",
        `/v1/approvals?taskId=${approval.taskId}`,
      );
      assertEquals(list.status, 200);
      return ((await list.json()).items as { id: string }[]).map((i) => i.id);
    };
    assertEquals(await ids(outsider), []);
    assertEquals(await ids(member), [approval.id]);
    assertEquals(
      (await f.call(outsider, "GET", `/v1/approvals/${approval.id}`)).status,
      404,
    );
    assertEquals(
      (await f.call(member, "GET", `/v1/approvals/${approval.id}`)).status,
      200,
    );
    const refused = await f.decide(approval, "approve", { identity: outsider });
    assertEquals(refused.status, 404, "decide does not confirm existence");
    const status = async () =>
      (await f.fx.owner`
        select status from bakery.questions
         where organization_id = ${f.fx.organizationId} and id = ${approval.id}`)[
        0
      ].status;
    assertEquals(await status(), "open");
    const decided = await f.decide(approval, "approve", { identity: member });
    assertEquals(decided.status, 200, await decided.clone().text());
    // After the decision the outsider still cannot probe it with a replay.
    const replay = await f.decide(approval, "approve", { identity: outsider });
    assertEquals(replay.status, 404);
  }));

Deno.test("an outsider deciding a private approval on an archived conversation still gets 404", () =>
  withFixture(async (f) => {
    const { approval } = await pending(f);
    const outsider = await f.tokenFor("human");
    const member = await f.tokenFor("human");
    await f.fx.owner`
      update bakery.questions
         set audience = ${
      f.fx.owner.json({
        type: "principals",
        principalIds: [member.principalId],
      })
    }
       where organization_id = ${f.fx.organizationId} and id = ${approval.id}`;
    await f.fx.owner`
      update bakery.conversations set archived_at = now()
       where organization_id = ${f.fx.organizationId}
         and id = (select conversation_id from bakery.questions
                    where organization_id = ${f.fx.organizationId}
                      and id = ${approval.id})`;
    const refused = await f.decide(approval, "approve", { identity: outsider });
    assertEquals(
      refused.status,
      404,
      "the archive refusal must not reveal a private approval",
    );
    const status = (await f.fx.owner`
      select status from bakery.questions
       where organization_id = ${f.fx.organizationId} and id = ${approval.id}`)[
      0
    ].status;
    assertEquals(status, "open");
    // Members keep the archive refusal.
    const archived = await f.decide(approval, "approve", { identity: member });
    assertEquals(archived.status, 409, await archived.clone().text());
  }));

Deno.test("an outsider cannot revoke a private approved approval, a member can", () =>
  withFixture(async (f) => {
    const { approval } = await pending(f);
    const outsider = await f.tokenFor("human");
    const member = await f.tokenFor("human");
    await f.fx.owner`
      update bakery.questions
         set audience = ${
      f.fx.owner.json({
        type: "principals",
        principalIds: [member.principalId],
      })
    }
       where organization_id = ${f.fx.organizationId} and id = ${approval.id}`;
    const decided = await f.decide(approval, "approve", { identity: member });
    assertEquals(decided.status, 200, await decided.clone().text());
    const state = async () =>
      (await f.fx.owner`
        select status, version, revoked_at, revoked_by from bakery.questions
         where organization_id = ${f.fx.organizationId} and id = ${approval.id}`)[
        0
      ];
    const before = await state();
    assertEquals(before.status, "answered");
    const refused = await f.revoke(approval, outsider);
    assertEquals(refused.status, 404, await refused.clone().text());
    assertEquals(await state(), before, "outsider revoke leaves the row as is");
    const revoked = await f.revoke(approval, member);
    assertEquals(revoked.status, 200, await revoked.clone().text());
    assertEquals((await state()).status, "revoked");
  }));
