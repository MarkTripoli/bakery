import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  agentToken,
  countRows,
  currentDraft,
  factsFor,
  json,
  PROPOSED,
  publish,
  PUBLISHABLE,
  readProposal,
  refusal,
  seedWaitingProposal,
  seedWorkflowDraft,
  send,
  type Who,
  withFixture,
} from "../helpers/definition-authoring.ts";

// Issue #421, QA test plan comment 6904898662: section 3 (the AUTH matrix),
// section 2 (the held-lock races), 4.17 (accept racing publish) and section
// 5 (tenancy and kind mixing). Publish grants are O52; deciding a proposal is
// a person's act whatever the agent holds (O51).

type Grant = { id: string; version: number };

async function grant(
  fixture: Parameters<typeof send>[0],
  who: Who,
  body: Record<string, unknown>,
): Promise<Grant> {
  return await json<Grant>(
    await send(fixture, who, "POST", "/v1/definition-publish-grants", { body }),
    201,
  );
}

const publishedCount = (
  fixture: Parameters<typeof send>[0],
  organizationId: string,
  versionId: string,
) =>
  countRows(
    fixture,
    `select count(*)::text as count from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [organizationId, versionId],
  );

Deno.test("3.8-3.13: agents author freely, publish only under a grant, and never decide", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "matrix", { role: "admin" });
    const person = { seed };
    const agent = await agentToken(fixture, seed);
    const otherSeat = await agentToken(fixture, seed);
    const asAgent = { seed, agent };
    const asOtherSeat = { seed, agent: otherSeat };

    // Create, edit and validate: allowed for an agent with no grant.
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      asAgent,
      "matrix-flow",
    );
    const renamed = await send(
      fixture,
      asAgent,
      "PATCH",
      `/v1/workflows/${workflowId}`,
      { body: { name: "Renamed by agent" }, ifMatch: 1 },
    );
    assertEquals(renamed.status, 200, await renamed.text());

    // 3.10 / 3.13 Publish without a grant: refused, and nothing recorded as
    // if it had succeeded.
    const refused = await refusal(
      await publish(fixture, asAgent, workflowId, draft),
    );
    assertEquals(refused, { status: 403, code: "AUTH_FORBIDDEN" });
    assertEquals(
      await publishedCount(fixture, seed.organizationId, draft.id),
      0,
    );
    const afterRefusal = await factsFor(fixture, seed.organizationId, draft.id);
    assert(!afterRefusal.audits.includes("workflowVersions.publish"));
    assert(!afterRefusal.events.includes("workflow.version_published"));
    // Switching on is granted with publishing, never by default.
    assertEquals(
      (await refusal(
        await send(fixture, asAgent, "PATCH", `/v1/workflows/${workflowId}`, {
          body: { enabled: false },
          ifMatch: 2,
        }),
      )).status,
      403,
    );

    // An agent can never grant itself (or anyone) the power.
    assertEquals(
      (await send(fixture, asAgent, "POST", "/v1/definition-publish-grants", {
        body: { definitionKind: "workflow", definitionId: workflowId },
      })).status,
      401,
    );
    // A grant must be bounded: every definition needs a named seat.
    assertEquals(
      (await send(fixture, person, "POST", "/v1/definition-publish-grants", {
        body: { definitionKind: "workflow" },
      })).status,
      422,
    );
    // A grant of another kind does not cover this workflow (5.20).
    await grant(fixture, person, {
      definitionKind: "agent",
      accessTokenId: agent.tokenId,
    });
    assertEquals(
      (await refusal(await publish(fixture, asAgent, workflowId, draft)))
        .status,
      403,
    );

    // 3.10 With a seat grant on this definition, this seat publishes, as an
    // agent's action (O50); another seat stays refused.
    const seatGrant = await grant(fixture, person, {
      definitionKind: "workflow",
      definitionId: workflowId,
      accessTokenId: agent.tokenId,
    });
    assertEquals(
      (await refusal(await publish(fixture, asOtherSeat, workflowId, draft)))
        .status,
      403,
    );
    const published = await json<{ id: string }>(
      await publish(fixture, asAgent, workflowId, draft),
      200,
    );
    const audit = await fixture.pgDatabase.query<
      { principal_id: string; details: Record<string, unknown> }
    >(
      `select principal_id, details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'workflowVersions.publish'`,
      [seed.organizationId, published.id],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].principal_id, agent.principalId);
    assertEquals(audit.rows[0].details.actorKind, "agent");
    assertEquals(audit.rows[0].details.accessTokenId, agent.tokenId);
    // "Use this version" under the same grant.
    const current = await json<{ version: number }>(
      await send(fixture, person, "GET", `/v1/workflows/${workflowId}`),
      200,
    );
    assertEquals(
      (await send(
        fixture,
        asAgent,
        "POST",
        `/v1/workflows/${workflowId}/activations`,
        { body: { versionId: published.id }, ifMatch: current.version },
      )).status,
      200,
    );

    // Revoking takes the power away again.
    assertEquals(
      (await send(
        fixture,
        person,
        "DELETE",
        `/v1/definition-publish-grants/${seatGrant.id}`,
        { ifMatch: seatGrant.version },
      )).status,
      204,
    );
    const next = await json<{ id: string; version: number }>(
      await send(
        fixture,
        asAgent,
        "POST",
        `/v1/workflows/${workflowId}/versions`,
        {
          body: { definition: PROPOSED },
        },
      ),
      201,
    );
    assertEquals(
      (await refusal(await publish(fixture, asAgent, workflowId, next))).status,
      403,
    );
    // A definition grant (no seat) lets any agent publish this definition.
    await grant(fixture, person, {
      definitionKind: "workflow",
      definitionId: workflowId,
    });
    assertEquals(
      (await publish(fixture, asOtherSeat, workflowId, next)).status,
      200,
    );

    // 3.8 / 3.11 No agent decides a proposal, with or without a grant: the
    // grant is never self-approval (O51).
    const { workflowId: proposedId, proposal } = await seedWaitingProposal(
      fixture,
      seed,
    );
    await grant(fixture, person, {
      definitionKind: "workflow",
      definitionId: proposedId,
    });
    for (const decision of ["accept", "reject"] as const) {
      assertEquals(
        await refusal(
          await send(
            fixture,
            asAgent,
            "POST",
            `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
            { body: { decision }, ifMatch: proposal.version },
          ),
        ),
        { status: 403, code: "AUTH_FORBIDDEN" },
      );
    }
    assertEquals(
      (await readProposal(fixture, seed, proposal.id)).state,
      "waiting",
    );

    // 3.9 A person's acceptance is the person's change, not the agent's.
    const accepted = await json<{ state: string; decidedBy: string }>(
      await send(
        fixture,
        person,
        "POST",
        `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
        { body: { decision: "accept" }, ifMatch: proposal.version },
      ),
      200,
    );
    assertEquals(accepted.decidedBy, seed.principalId);
    const applied = await currentDraft(fixture, seed, proposedId);
    const write = await fixture.pgDatabase.query<
      { principal_id: string; details: Record<string, unknown> }
    >(
      `select principal_id, details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'workflowVersions.update'
        order by created_at desc limit 1`,
      [seed.organizationId, applied.id],
    );
    assertEquals(write.rows[0].principal_id, seed.principalId);
    assertEquals(write.rows[0].details.actorKind, "person");
  }));

Deno.test("2: a decision that loses a held-lock race answers 409 and writes nothing", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "race", { role: "admin" });
    const person = { seed };
    for (
      const [holderState, loser] of [
        ["rejected", "accept"],
        ["accepted", "reject"],
      ] as const
    ) {
      const { workflowId, proposal } = await seedWaitingProposal(fixture, seed);
      const before = await currentDraft(fixture, seed, workflowId);
      const factsBefore = await factsFor(
        fixture,
        seed.organizationId,
        proposal.id,
      );
      let pending: Promise<Response> | undefined;
      await withPgTransaction(fixture.pgDatabase, async (holder) => {
        await holder.query(
          `select 1 from bakery.workflow_definition_proposals
            where organization_id = $1 and id = $2 for update`,
          [seed.organizationId, proposal.id],
        );
        pending = send(
          fixture,
          person,
          "POST",
          `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
          { body: { decision: loser }, ifMatch: proposal.version },
        );
        // Let the decision reach the proposal lock before the holder settles.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await holder.query(
          `update bakery.workflow_definition_proposals
              set state = $3, decided_at = now(), version = version + 1
            where organization_id = $1 and id = $2`,
          [seed.organizationId, proposal.id, holderState],
        );
      });
      const lost = await refusal(await pending!);
      assertEquals(lost.status, 409);
      const after = await currentDraft(fixture, seed, workflowId);
      assertEquals(after, before);
      assertEquals(
        (await readProposal(fixture, seed, proposal.id)).state,
        holderState,
      );
      assertEquals(
        await factsFor(fixture, seed.organizationId, proposal.id),
        factsBefore,
      );
    }

    // 2.7 The zero-row case: the proposal row goes while the decision waits.
    const { proposal } = await seedWaitingProposal(fixture, seed);
    let pending: Promise<Response> | undefined;
    await withPgTransaction(fixture.pgDatabase, async (holder) => {
      await holder.query(
        `select 1 from bakery.workflow_definition_proposals
          where organization_id = $1 and id = $2 for update`,
        [seed.organizationId, proposal.id],
      );
      pending = send(
        fixture,
        person,
        "POST",
        `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
        { body: { decision: "accept" }, ifMatch: proposal.version },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder.query(
        `delete from bakery.workflow_definition_proposals
          where organization_id = $1 and id = $2`,
        [seed.organizationId, proposal.id],
      );
    });
    assertEquals((await refusal(await pending!)).status, 404);
    const gone = await factsFor(fixture, seed.organizationId, proposal.id);
    assert(!gone.audits.includes("workflowDefinitionProposalDecisions.create"));
    assert(!gone.events.includes("workflowDefinitionProposal.decided"));
  }));

Deno.test("4.17: accept racing publish has exactly the two legal outcomes", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "accept-publish", {
      role: "admin",
    });
    const person = { seed };
    for (let round = 0; round < 2; round++) {
      const { workflowId, draft, proposal } = await seedWaitingProposal(
        fixture,
        seed,
      );
      let accepting: Promise<Response> | undefined;
      let publishing: Promise<Response> | undefined;
      // Hold the definition lock so both requests queue behind it, in an order
      // the round flips.
      await withPgTransaction(fixture.pgDatabase, async (holder) => {
        await holder.query(
          `select 1 from bakery.workflow_definitions
            where organization_id = $1 and id = $2 for update`,
          [seed.organizationId, workflowId],
        );
        const accept = () =>
          send(
            fixture,
            person,
            "POST",
            `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
            { body: { decision: "accept" }, ifMatch: proposal.version },
          );
        const publishNow = () => publish(fixture, person, workflowId, draft);
        if (round === 0) {
          accepting = accept();
          await new Promise((resolve) => setTimeout(resolve, 200));
          publishing = publishNow();
        } else {
          publishing = publishNow();
          await new Promise((resolve) => setTimeout(resolve, 200));
          accepting = accept();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      const [accepted, published] = await Promise.all([
        accepting!,
        publishing!,
      ]);
      const settled = await readProposal(fixture, seed, proposal.id);
      const version = await fixture.pgDatabase.query<
        { normalized_spec: unknown }
      >(
        `select normalized_spec from bakery.workflow_versions
          where organization_id = $1 and id = $2`,
        [seed.organizationId, draft.id],
      );
      if (accepted.status === 200) {
        // The accept froze first: the draft moved on, so the stale publish
        // published nothing, and the proposal reads accepted.
        assertEquals(settled.state, "accepted");
        assertEquals(published.status, 412, await published.text());
        assertEquals(version.rows.length, 0);
        assertEquals(
          (await currentDraft(fixture, seed, workflowId)).id,
          draft.id,
        );
      } else {
        // The publish froze first: the version excludes the change and the
        // proposal is superseded by it, never left waiting.
        assertEquals(accepted.status, 409, await accepted.text());
        assertEquals(published.status, 200, await published.text());
        assertEquals(settled.state, "superseded");
        assertEquals(settled.supersededByVersionId, draft.id);
        assertEquals(version.rows[0].normalized_spec, PUBLISHABLE);
      }
    }
  }));

Deno.test("5.19-5.21: grants and publishes are organization-scoped and leak nothing", () =>
  withFixture(async (fixture) => {
    const a = await seedOrganization(fixture, "tenant-a", { role: "admin" });
    const b = await seedOrganization(fixture, "tenant-b", { role: "admin" });
    const agentA = await agentToken(fixture, a);
    const agentB = await agentToken(fixture, b);
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      { seed: a },
      "tenant-flow",
    );
    const grantA = await grant(fixture, { seed: a }, {
      definitionKind: "workflow",
      definitionId: workflowId,
    });
    // Org B cannot see or revoke org A's grant, nor grant on its workflow.
    assertEquals(
      (await send(
        fixture,
        { seed: b },
        "DELETE",
        `/v1/definition-publish-grants/${grantA.id}`,
        { ifMatch: grantA.version },
      )).status,
      404,
    );
    const foreignDefinition = await refusal(
      await send(
        fixture,
        { seed: b },
        "POST",
        "/v1/definition-publish-grants",
        {
          body: { definitionKind: "workflow", definitionId: workflowId },
        },
      ),
    );
    // 5.21 Org A's definition with org B's seat: the same answer as an
    // unknown definition, so neither id is confirmed.
    const foreignSeat = await refusal(
      await send(
        fixture,
        { seed: a },
        "POST",
        "/v1/definition-publish-grants",
        {
          body: {
            definitionKind: "workflow",
            definitionId: workflowId,
            accessTokenId: agentB.tokenId,
          },
        },
      ),
    );
    assertEquals(foreignDefinition, {
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    assertEquals(foreignSeat, foreignDefinition);
    // 5.20 A kind that does not match the id is not found, never "the id exists".
    assertEquals(
      (await refusal(
        await send(
          fixture,
          { seed: a },
          "POST",
          "/v1/definition-publish-grants",
          {
            body: { definitionKind: "skill", definitionId: workflowId },
          },
        ),
      )).status,
      404,
    );
    // Org B's agent cannot publish org A's draft, grant or not.
    assertEquals(
      (await refusal(
        await send(
          fixture,
          { seed: a, agent: agentB },
          "POST",
          `/v1/workflows/${workflowId}/versions/${draft.id}/publish`,
          { body: {}, ifMatch: draft.version },
        ),
      )).status,
      404,
    );
    assertEquals(
      (await refusal(
        await publish(fixture, { seed: b }, workflowId, draft),
      )).status,
      404,
    );
    assertEquals(
      await publishedCount(fixture, a.organizationId, draft.id),
      0,
    );
    // Org A's own agent, under org A's grant, does publish.
    assertEquals(
      (await publish(fixture, { seed: a, agent: agentA }, workflowId, draft))
        .status,
      200,
    );
    // 5.22 The same slug in two organizations is independent.
    await seedWorkflowDraft(fixture, { seed: b }, "tenant-flow");
    assertEquals(
      (await send(fixture, { seed: a }, "POST", "/v1/workflows", {
        body: { slug: "tenant-flow", name: "dup", description: "" },
      })).status,
      409,
    );
  }));
