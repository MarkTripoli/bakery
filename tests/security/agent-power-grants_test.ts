import { assertEquals } from "@std/assert";
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
