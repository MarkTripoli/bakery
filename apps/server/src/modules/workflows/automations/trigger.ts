/**
 * The trigger of an automation version (issue #36): data, never an expression.
 * It is one of two shapes and nothing else is accepted:
 *
 *   { "type": "schedule", "cron": "0 9 * * mon-fri", "timezone": "Europe/Berlin" }
 *   { "type": "event", "provider": "github", "kind": "issues", "action": "opened",
 *     "filter": { "repository": "acme/web" } }
 *
 * A schedule is a five-field cron expression and an IANA timezone (see
 * `schedule.ts`). An event names the provider and the kind (and optionally the
 * action) of a verified inbound event and an explicit filter: equality on the
 * named fields of the event's normalized projection, at most 16 of them, scalar
 * values only. There is no predicate language, no pattern and no nesting.
 */
import { isValidTimeZone, parseCron } from "./schedule.ts";

export type ScheduleTrigger = Readonly<{
  type: "schedule";
  cron: string;
  timezone: string;
}>;

export type EventFilterValue = string | number | boolean;

export type EventTrigger = Readonly<{
  type: "event";
  provider: "github";
  kind: string;
  /** Present only when the trigger names an action. */
  action?: string;
  filter: Readonly<Record<string, EventFilterValue>>;
}>;

export type AutomationTrigger = ScheduleTrigger | EventTrigger;

/** A trigger that is not one of the shapes, with the path to the part and why. */
export class TriggerError extends Error {
  override readonly name = "TriggerError";
  constructor(readonly path: readonly string[], readonly reason: string) {
    super(`${path.join(".") || "trigger"}: ${reason}`);
  }
}

/** The providers whose verified inbound events can trigger an automation. */
export const TRIGGER_PROVIDERS = ["github"] as const;

const MAX_FILTER_ENTRIES = 16;
const MAX_FILTER_STRING = 256;
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const FILTER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  // Only a plain object: an array, a class instance or a null-prototype object is not one.
  return typeof value === "object" && value !== null &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TriggerError([...path, key], "unknown_key");
    }
  }
}

function parseFilter(
  value: unknown,
): Record<string, EventFilterValue> {
  if (value === undefined) return {};
  if (!plainObject(value)) {
    throw new TriggerError(["filter"], "filter_not_object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_FILTER_ENTRIES) {
    throw new TriggerError(["filter"], "filter_too_large");
  }
  const filter: Record<string, EventFilterValue> = {};
  for (const [key, entry] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!FILTER_KEY.test(key)) {
      throw new TriggerError(["filter", key], "filter_key_invalid");
    }
    if (typeof entry === "string") {
      if (entry.length > MAX_FILTER_STRING) {
        throw new TriggerError(["filter", key], "filter_value_too_long");
      }
    } else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new TriggerError(["filter", key], "filter_value_invalid");
      }
    } else if (typeof entry !== "boolean") {
      throw new TriggerError(["filter", key], "filter_value_invalid");
    }
    filter[key] = entry;
  }
  return filter;
}

/** Reads a trigger, or throws a `TriggerError` naming the part that is wrong. */
export function parseTrigger(value: unknown): AutomationTrigger {
  if (!plainObject(value)) throw new TriggerError([], "trigger_not_object");
  if (value.type === "schedule") {
    onlyKeys(value, ["type", "cron", "timezone"], []);
    if (typeof value.cron !== "string") {
      throw new TriggerError(["cron"], "cron_invalid");
    }
    try {
      parseCron(value.cron);
    } catch {
      throw new TriggerError(["cron"], "cron_invalid");
    }
    if (
      typeof value.timezone !== "string" || !isValidTimeZone(value.timezone)
    ) {
      throw new TriggerError(["timezone"], "timezone_invalid");
    }
    return {
      type: "schedule",
      cron: value.cron.trim(),
      timezone: value.timezone,
    };
  }
  if (value.type === "event") {
    onlyKeys(value, ["type", "provider", "kind", "action", "filter"], []);
    if (
      typeof value.provider !== "string" ||
      !(TRIGGER_PROVIDERS as readonly string[]).includes(value.provider)
    ) throw new TriggerError(["provider"], "provider_unknown");
    if (typeof value.kind !== "string" || !EVENT_NAME.test(value.kind)) {
      throw new TriggerError(["kind"], "kind_invalid");
    }
    if (
      value.action !== undefined &&
      (typeof value.action !== "string" || !EVENT_NAME.test(value.action))
    ) throw new TriggerError(["action"], "action_invalid");
    return {
      type: "event",
      provider: value.provider as "github",
      kind: value.kind,
      ...(value.action === undefined ? {} : { action: value.action as string }),
      filter: parseFilter(value.filter),
    };
  }
  throw new TriggerError(["type"], "type_unknown");
}
