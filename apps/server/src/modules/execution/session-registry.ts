/**
 * The executable set of operations a session may call (#401).
 *
 * The operations a session can reach are owned by the modules that already
 * implement them - tasks and runs by the task registry, artifacts by the
 * artifact registry. This composes those registries instead of re-registering
 * their actions: a second registration would be a second handler to keep in
 * step, and the first time they disagreed the session would call something
 * subtly different from the route the rest of the product calls.
 *
 * Dispatch therefore delegates to whichever registry owns the name, which keeps
 * the authority runner, command runner and response encoding of the owning
 * module exactly as they are.
 */

import type {
  ActionContext,
  ActionDefinition,
  ActionRegistry,
} from "@bakery/contracts/action-registry";

export type SessionToolSources = Readonly<{
  registries: readonly ActionRegistry[];
  /** The operations a session may be offered; not everything registered. */
  offered: readonly string[];
}>;

export type SessionToolRegistry = Readonly<{
  /** Offered actions, in the order the sources declare them. */
  list(): readonly ActionDefinition[];
  /** Runs one, through the registry that owns it. */
  execute(
    name: string,
    context: ActionContext,
    input: unknown,
  ): Promise<unknown>;
}>;

export function createSessionToolRegistry(
  sources: SessionToolSources,
): SessionToolRegistry {
  const offered = new Set(sources.offered);
  const owner = new Map<string, ActionRegistry>();
  const definitions: ActionDefinition[] = [];
  for (const registry of sources.registries) {
    for (const definition of registry.list()) {
      // Only the operations the session map names, and only the first owner: a
      // duplicate would make the call depend on registry construction order.
      if (!offered.has(definition.name) || owner.has(definition.name)) continue;
      owner.set(definition.name, registry);
      definitions.push(definition);
    }
  }
  return {
    list: () => definitions,
    execute: (name, context, input) => {
      const registry = owner.get(name);
      if (!registry) {
        // Unreachable through the gateway, which resolves the tool from
        // `list()` first. Refused rather than silently redirected.
        return Promise.reject(new Error(`SESSION_TOOL_NOT_COMPOSED: ${name}`));
      }
      return registry.execute(name, context, input);
    },
  };
}
