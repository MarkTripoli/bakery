import { assertThrows } from "@std/assert";
import {
  ActionKind,
  ActionRegistry,
  ActionRegistryError,
  assertRegisteredActions,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { createCatalogActionRegistry } from "../../apps/server/src/modules/catalog/actions.ts";

const commandRunner = { run: () => Promise.reject(new Error("not run")) };

Deno.test("a registry that runs a command with a key refuses a catalog entry that does not tell clients to send one (#74)", () => {
  const registry = new ActionRegistry(undefined, commandRunner as never);
  registry.register({
    name: "skillDrafts.get",
    method: HttpMethod.Get,
    path: "/v1/skills/:id/draft",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillDraft,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: () => Promise.reject(new Error("not run")),
  } as never);
  assertThrows(
    () => assertRegisteredActions(registry),
    ActionRegistryError,
    "needs an Idempotency-Key the catalog does not tell clients to send",
  );
});

Deno.test("the catalog registry the server builds assembles with its command runner (#74)", () => {
  createCatalogActionRegistry({} as never, {
    commandRunner: commandRunner as never,
  });
});
