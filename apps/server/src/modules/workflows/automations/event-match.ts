/**
 * Which verified inbound events an automation's event trigger answers (issue
 * #36). Matching is exact and small, and it reads only what the receipt keeps:
 * the provider and event kind, the action, and the three scalar fields of the
 * stored projection (`number`, `headSha`, `repositoryId`). There is no
 * expression, pattern or nesting, and nothing from the event's payload.
 *
 * What a trigger may name is closed here, so a version that could never fire is
 * refused when it is created, not left to sit silent: only the kinds Bakery
 * routes to the processors (`issues`, `pull_request`, `check_run`,
 * `check_suite`), and only the filter keys the projection holds. Labels and the
 * sender are not in the projection; a later change may add them.
 */
import { type EventTrigger, TriggerError } from "./trigger.ts";

/** The event kinds an event trigger can name. */
export const EVENT_TRIGGER_KINDS = Object.freeze(
  ["issues", "pull_request", "check_run", "check_suite"] as const,
);

/** The projection fields a filter can compare, and the type each holds. */
export const EVENT_FILTER_KEYS = Object.freeze(
  { number: "number", headSha: "string", repositoryId: "number" } as const,
);

/** The part of a stored receipt the matcher reads. */
export type EventFacts = Readonly<{
  kind: string;
  action: string | null;
  number: number | null;
  headSha: string | null;
  repositoryId: number | null;
}>;

/**
 * Refuses an event trigger that names a kind or a filter key the receipt does
 * not carry, or a filter value of the wrong type. Throws a `TriggerError`
 * naming the part and why; returns nothing otherwise.
 */
export function assertSupportedEventTrigger(trigger: EventTrigger): void {
  if (!(EVENT_TRIGGER_KINDS as readonly string[]).includes(trigger.kind)) {
    throw new TriggerError(["kind"], "kind_unsupported");
  }
  for (const [key, value] of Object.entries(trigger.filter)) {
    // Own keys only: `constructor` and `toString` are not projection fields.
    if (!Object.hasOwn(EVENT_FILTER_KEYS, key)) {
      throw new TriggerError(["filter", key], "filter_key_unsupported");
    }
    const expected = EVENT_FILTER_KEYS[key as keyof typeof EVENT_FILTER_KEYS];
    const fits = expected === "number"
      ? typeof value === "number" && Number.isSafeInteger(value)
      : typeof value === "string";
    if (!fits) throw new TriggerError(["filter", key], "filter_value_type");
  }
}

/**
 * Whether the event answers the trigger: the same kind, the same action when
 * the trigger names one, and every filter entry strictly equal to the event's
 * field. A field the event does not have (null) equals nothing.
 */
export function eventMatches(
  trigger: EventTrigger,
  event: EventFacts,
): boolean {
  if (trigger.kind !== event.kind) return false;
  if (trigger.action !== undefined && trigger.action !== event.action) {
    return false;
  }
  for (const [key, value] of Object.entries(trigger.filter)) {
    const field = (event as Record<string, unknown>)[key];
    if (
      !Object.hasOwn(EVENT_FILTER_KEYS, key) || field === null ||
      field !== value
    ) {
      return false;
    }
  }
  return true;
}
