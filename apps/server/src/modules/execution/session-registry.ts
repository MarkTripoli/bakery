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

import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  type ActionRegistry,
} from "@bakery/contracts/action-registry";
import { createNormalizedCommandMetadata } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

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
      const definition = definitions.find((item) => item.name === name);
      const split = definition
        ? splitCallArguments(definition, input)
        : { params: {}, value: input };
      const dispatched = Object.assign({}, context, {
        params: split.params,
      }) as ActionContext;
      // A command needs an idempotency key and a session call carries no header,
      // so one is derived from the attempt, the tool and the exact arguments: an
      // identical retry replays the stored answer instead of repeating the act,
      // and different arguments are a different act.
      const commandMetadata = definition &&
          definition.policy.type === ActionKind.Command
        ? (async () => {
          // A replace, mv or rm names the version it read (If-Match), exactly
          // as a person's request does; the session call carries it as the
          // same header and it joins the derived key, so a retry against a
          // newer version is a different act, not a replay (#448).
          const ifMatch = context.request.headers.get("if-match");
          return createNormalizedCommandMetadata(
            definition,
            new Request(context.request.url, {
              method: "POST",
              headers: {
                "idempotency-key": `session:${await sha256Hex(
                  canonicalJson({
                    attemptId: context.agentSession?.attemptId ?? null,
                    tool: name,
                    params: split.params,
                    value: split.value,
                    ...(ifMatch === null ? {} : { ifMatch }),
                  }),
                )}`,
                ...(ifMatch === null ? {} : { "if-match": ifMatch }),
              },
            }),
            split.params,
            split.value,
          );
        })()
        : undefined;
      return Promise.resolve(commandMetadata).then(async (metadata) => {
        const result = await registry.execute(
          name,
          dispatched,
          split.value,
          metadata,
        );
        return definition?.policy.type === ActionKind.Command
          ? decodeCommandResult(result)
          : result;
      });
    },
  };
}

/**
 * Splits an agent's arguments into the route parameters and the operation input.
 *
 * An operation addressed by id (`/v1/approvals/:id/decision`) reads that id from
 * the route, not from its body, and the agent has no route. The route parameters
 * are therefore taken from the arguments by the path's own names, and left out
 * of the input unless the operation's input schema defines them itself (as
 * `IdPath` does). Without this every by-id tool addressed the attempt's own id.
 */
export function splitCallArguments(
  definition: Pick<ActionDefinition, "path" | "input">,
  args: unknown,
): Readonly<{ params: Record<string, string>; value: unknown }> {
  const names = [...definition.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)]
    .map((match) => match[1]);
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { params: {}, value: args };
  }
  const record = args as Record<string, unknown>;
  const shape = (definition.input as { shape?: Record<string, unknown> })
    .shape ?? {};
  const params: Record<string, string> = {};
  const value: Record<string, unknown> = { ...record };
  for (const name of names) {
    const given = record[name];
    if (typeof given === "string") params[name] = given;
    if (!(name in shape)) delete value[name];
  }
  return { params, value };
}

/**
 * A command's result is the encoded HTTP response its replay record stores: a
 * status and the body as bytes. Serialised as JSON the bytes become a numbered
 * object, which an agent cannot read, so the body is decoded here and a session
 * gets the same JSON a caller of the route would, and null for an empty body.
 */
export function decodeCommandResult(result: unknown): unknown {
  if (
    typeof result !== "object" || result === null || !("status" in result) ||
    !("body" in result)
  ) return result;
  const { status, body } = result as { status: number; body: unknown };
  if (status === 204 || !(body instanceof Uint8Array)) return null;
  if (body.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(body));
}
