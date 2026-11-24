import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { ActionDefinition } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { authorizeWithBindings } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { OrganizationActor } from "../../apps/server/src/modules/auth/application/authority.ts";
import type { RunPower } from "../../apps/server/src/modules/auth/application/run-grants.ts";

/**
 * A run power grant is the last fallback when the role and the bindings refuse
 * (#456 slice 2a). It widens a permission miss only, only for a human, only for
 * the four actions it names, and only with the power that action needs; a token
 * still has to carry the scope, and the grant is not looked up for anything
 * else.
 */

const action = (name: string) =>
  ({
    name,
    policy: { type: "command", access: "Developer" },
  }) as unknown as ActionDefinition;

function person(
  role: string,
  options: { tokenScopes?: string[]; type?: string } = {},
): OrganizationActor {
  return {
    subject: {
      principalId: crypto.randomUUID(),
      principalType: options.type ?? "human",
      displayName: "Pat",
    },
    organizationId: crypto.randomUUID(),
    role,
    capabilities: [],
    ...(options.tokenScopes ? { tokenScopes: options.tokenScopes } : {}),
  } as unknown as OrganizationActor;
}

const noTarget = () => Promise.resolve(undefined);
const neverRunGrant = () => Promise.resolve(false);

/** A power lookup that records which powers were asked about. */
function spy(answer: boolean) {
  const asked: RunPower[] = [];
  return {
    asked,
    holds: (entry: { power: RunPower }) => {
      asked.push(entry.power);
      return Promise.resolve(answer);
    },
  };
}

Deno.test("approving: a guest who holds the approve power is let through, asked once for that power", async () => {
  const actor = person("guest");
  const power = spy(true);
  const permitted = await authorizeWithBindings(
    action("approvals.decide"),
    actor,
    noTarget,
    neverRunGrant,
    power.holds,
  );
  assertStrictEquals(permitted, actor);
  assertEquals(power.asked, ["approve"]);
});

Deno.test("answering asks for the answer power and nothing else", async () => {
  const power = spy(true);
  await authorizeWithBindings(
    action("questions.answer"),
    person("guest"),
    noTarget,
    neverRunGrant,
    power.holds,
  );
  assertEquals(power.asked, ["answer"]);
});

Deno.test("without the power the original refusal stands", async () => {
  const refused = await assertRejects(
    () =>
      authorizeWithBindings(
        action("approvals.decide"),
        person("guest"),
        noTarget,
        neverRunGrant,
        spy(false).holds,
      ),
    StandardError,
  );
  assertEquals(
    ["AUTH_FORBIDDEN", "RESOURCE_NOT_FOUND"].includes(
      (refused as StandardError).code,
    ),
    true,
  );
});

Deno.test("an action that is not a power never asks for one", async () => {
  const power = spy(true);
  for (
    const name of [
      "approvals.revoke",
      "approvals.list",
      "artifactComments.list",
    ]
  ) {
    await assertRejects(
      () =>
        authorizeWithBindings(
          action(name),
          person("guest"),
          noTarget,
          neverRunGrant,
          power.holds,
        ),
      StandardError,
      undefined,
      name,
    );
  }
  assertEquals(power.asked, []);
});

Deno.test("a read-only token is a scope refusal even with the power", async () => {
  const power = spy(true);
  const refused = await assertRejects(
    () =>
      authorizeWithBindings(
        action("approvals.decide"),
        person("guest", { tokenScopes: ["bakery:read"] }),
        noTarget,
        neverRunGrant,
        power.holds,
      ),
    StandardError,
  );
  assertEquals((refused as StandardError).code, "INSUFFICIENT_SCOPE");
});

Deno.test("a non-human is never widened by a power", async () => {
  const power = spy(true);
  await assertRejects(
    () =>
      authorizeWithBindings(
        action("approvals.decide"),
        person("guest", { type: "service" }),
        noTarget,
        neverRunGrant,
        power.holds,
      ),
    StandardError,
  );
  assertEquals(power.asked, []);
});

Deno.test("a denial that is not a permission miss is passed on and no power is looked up", async () => {
  // A developer holds the permission, so a read-only token is refused for its
  // scope by the role check itself, which is not a permission miss.
  const power = spy(true);
  const refused = await assertRejects(
    () =>
      authorizeWithBindings(
        action("approvals.decide"),
        person("developer", { tokenScopes: ["bakery:read"] }),
        noTarget,
        neverRunGrant,
        power.holds,
      ),
    StandardError,
  );
  assertEquals((refused as StandardError).code, "INSUFFICIENT_SCOPE");
  assertEquals(power.asked, []);
});
