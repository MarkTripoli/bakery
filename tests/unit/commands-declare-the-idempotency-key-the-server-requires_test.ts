import { assertEquals } from "@std/assert";
import { clientManifest } from "../../packages/contracts/generated/client-manifest.ts";
import type { ActionDefinition } from "../../packages/contracts/src/action-registry.ts";
import { createCatalogActionRegistry } from "../../apps/server/src/modules/catalog/actions.ts";
import { createDeliveryActionRegistry } from "../../apps/server/src/modules/delivery/actions.ts";

const declared = new Map<string, string>(
  clientManifest.actions.map((entry) => [entry.action, entry.idempotency]),
);

const commandRunner = { run: () => Promise.reject(new Error("not run")) };

function keyRequiredButUndeclared(
  actions: readonly ActionDefinition[],
): string[] {
  return actions
    .filter((action) =>
      action.policy.type === "command" && action.naturalIdempotency !== true
    )
    .filter((action) =>
      !(declared.get(action.name) ?? "").includes("Idempotency-Key")
    )
    .map((action) => action.name)
    .sort();
}

Deno.test("every command a registry runs with a key tells the client to send one (#74)", () => {
  const registries = [
    createCatalogActionRegistry({} as never, {
      commandRunner: commandRunner as never,
    }),
    createDeliveryActionRegistry({} as never, {} as never, {} as never),
  ];
  assertEquals(
    registries.flatMap((registry) => keyRequiredButUndeclared(registry.list())),
    [],
  );
});
