import { StandardError } from "@bakery/contracts/http";

/**
 * Where a run may reach, pinned when it is created (issue #427, chapter 25
 * section 14). `offline` refuses every external effect and every brokered
 * integration credential; metered model calls stay allowed.
 */
export const RUN_ENVIRONMENTS = ["live", "offline"] as const;
export type RunEnvironment = (typeof RUN_ENVIRONMENTS)[number];

/** Narrows a stored column value; anything unknown fails closed as offline. */
export function toRunEnvironment(value: unknown): RunEnvironment {
  return value === "live" ? "live" : "offline";
}

/**
 * The environment a spawned run is pinned to. Omitted, it inherits the
 * spawning run's; an offline run may never open a live one, because that child
 * would carry effects the parent is not allowed to make.
 */
export function childRunEnvironment(
  parent: RunEnvironment,
  requested: RunEnvironment | undefined,
): RunEnvironment {
  if (requested === undefined) return parent;
  if (parent === "offline" && requested === "live") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "environment_offline_parent" },
    });
  }
  return requested;
}
