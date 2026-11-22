import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { assertAgentMayExercise } from "../../apps/server/src/modules/auth/application/agent-power-grants.ts";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  agentToken,
  json,
  seedWorkflowDraft,
  send,
  withFixture,
} from "../helpers/definition-authoring.ts";

// Issue #414, chapter 25 O51/O52: only a person grants an agent an off-by-default
// power, a grant is bounded, and a revoke is a compare-and-delete.

type Grant = { id: string; version: number; power: string };

Deno.test("only a person grants a bounded power, and a revoke names the version", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "powers", { role: "admin" });
    const person = { seed };
    const agent = await agentToken(fixture, seed);
    const asAgent = { seed, agent };
    const { workflowId } = await seedWorkflowDraft(
      fixture,
      asAgent,
      "power-flow",
    );
    const create = (who: typeof person | typeof asAgent, body: unknown) =>
      send(fixture, who, "POST", "/v1/agent-power-grants", {
        body: body as Record<string, unknown>,
      });

    // An agent can never grant itself, or anyone, a power (O51).
    assertEquals(
      (await create(asAgent, { power: "decide", workflowId })).status,
      401,
    );
    // Bounded: every workflow needs a named seat; an unknown power, workflow
    // and seat are refused without saying which was wrong.
    assertEquals((await create(person, { power: "decide" })).status, 422);
    // An unknown power is refused by the input schema before the handler runs.
    assertEquals(
      (await create(person, { power: "fly", workflowId })).status,
      400,
    );
    assertEquals(
      (await create(person, {
        power: "decide",
        workflowId: crypto.randomUUID(),
      })).status,
      404,
    );
    assertEquals(
      (await create(person, {
        power: "run_control",
        accessTokenId: crypto.randomUUID(),
      })).status,
      404,
    );

    // A person grants; a second identical grant is a conflict.
    const granted = await json<Grant>(
      await create(person, { power: "decide", workflowId }),
      201,
    );
    assertEquals(granted.power, "decide");
    assertEquals(
      (await create(person, { power: "decide", workflowId })).status,
      409,
    );
    // A different power on the same workflow is its own grant.
    await json<Grant>(
      await create(person, { power: "run_control", workflowId }),
      201,
    );

    // An agent cannot revoke either, and a revoke needs the version.
    const path = `/v1/agent-power-grants/${granted.id}`;
    assertEquals(
      (await send(fixture, asAgent, "DELETE", path, {
        ifMatch: granted.version,
      })).status,
      401,
    );
    assertEquals(
      (await send(fixture, person, "DELETE", path, {
        ifMatch: granted.version + 5,
      })).status,
      412,
    );
    assertEquals(
      (await send(fixture, person, "DELETE", path, {
        ifMatch: granted.version,
      })).status,
      204,
    );
    assertEquals(
      (await send(fixture, person, "DELETE", path, {
        ifMatch: granted.version,
      })).status,
      404,
    );
  }));

Deno.test("an ask grant names exactly one role or group, and an expiry must lie ahead", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "ask-bounds", {
      role: "admin",
    });
    const person = { seed };
    const agent = await agentToken(fixture, seed);
    const { workflowId } = await seedWorkflowDraft(
      fixture,
      { seed, agent },
      "ask-flow",
    );
    const create = (body: Record<string, unknown>) =>
      send(fixture, person, "POST", "/v1/agent-power-grants", { body });
    // No audience, two audiences, and an audience on another power: refused.
    assertEquals((await create({ power: "ask", workflowId })).status, 422);
    assertEquals(
      (await create({
        power: "ask",
        workflowId,
        roleKey: "admin",
        groupId: crypto.randomUUID(),
      })).status,
      422,
    );
    assertEquals(
      (await create({ power: "decide", workflowId, roleKey: "admin" }))
        .status,
      422,
    );
    // A role or group that is not there is not found.
    assertEquals(
      (await create({ power: "ask", workflowId, roleKey: "no-such-role" }))
        .status,
      404,
    );
    assertEquals(
      (await create({
        power: "ask",
        workflowId,
        groupId: crypto.randomUUID(),
      })).status,
      404,
    );
    // An expiry already past is refused; one ahead is kept.
    assertEquals(
      (await create({
        power: "decide",
        workflowId,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })).status,
      422,
    );
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const granted = await json<
      Grant & { expiresAt: string | null; roleKey: string | null }
    >(
      await create({ power: "ask", workflowId, roleKey: "admin", expiresAt }),
      201,
    );
    assertEquals(granted.roleKey, "admin");
    assertEquals(granted.expiresAt, expiresAt);
    // One grant per audience: the same role again conflicts, another does not.
    assertEquals(
      (await create({ power: "ask", workflowId, roleKey: "admin" })).status,
      409,
    );
    await json<Grant>(
      await create({ power: "ask", workflowId, roleKey: "developer" }),
      201,
    );
  }));

Deno.test("a lapsed grant is refused live with its own named reason", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "lapse", { role: "admin" });
    const agent = await agentToken(fixture, seed);
    const grant = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.agent_power_grants
         (organization_id, power, access_token_id, granted_by, expires_at)
       values ($1, 'run_control', $2, $3, now() + interval '1 hour')
       returning id`,
      [seed.organizationId, agent.tokenId, seed.principalId],
    );
    const exercise = () =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          assertAgentMayExercise(
            transaction,
            {
              principal: {
                principalId: agent.principalId,
                principalType: "service",
              },
              accessToken: { id: agent.tokenId },
            } as unknown as Parameters<typeof assertAgentMayExercise>[1],
            {
              organizationId: seed.organizationId,
              principalId: agent.principalId,
              power: "run_control",
            },
          ),
      );
    // Live: the seat holds the power.
    assertEquals((await exercise()).attribution.actorKind, "agent");
    // Lapsed: refused on the next call, named apart from a missing grant.
    await fixture.pgDatabase.query(
      `update bakery.agent_power_grants
          set expires_at = now() - interval '1 second' where id = $1`,
      [grant.rows[0].id],
    );
    const lapsed = await assertRejects(exercise, StandardError);
    assertEquals(
      (lapsed as StandardError).params?.reason,
      "agent_power_grant_expired",
    );
    // Gone: the plain missing-grant reason.
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [grant.rows[0].id],
    );
    const missing = await assertRejects(exercise, StandardError);
    assertEquals(
      (missing as StandardError).params?.reason,
      "agent_power_requires_grant",
    );
  }));
