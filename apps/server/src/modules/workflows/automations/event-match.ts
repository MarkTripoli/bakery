/**
 * Which verified inbound events an automation's event trigger answers (issue
 * #36). Matching is exact and small, and it reads only what the receipt keeps:
 * the event kind, the action, and the scalar fields of the stored, normalized
 * projection. There is no expression, pattern or nesting, and nothing from the
 * event's payload.
 *
 * What a trigger may name is closed by the provider's own declaration of what
 * its receipt routes (`automationEventsOf`): the matcher reads that list and
 * names no provider's events, so a version that could never fire is refused
 * when it is created, not left to sit silent.
 */
import { automationEventsOf } from "../../integrations/automation-events.ts";
import { type EventTrigger, TriggerError } from "./trigger.ts";

/** The part of a stored receipt the matcher reads. */
export type EventFacts = Readonly<{
  kind: string;
  action: string | null;
  number: number | null;
  headSha: string | null;
  repositoryId: number | null;
}>;

/**
 * Refuses an event trigger that names a provider that routes nothing to
 * automations, a kind or a filter key the provider's receipt does not carry, or
 * a filter value of the wrong type. Throws a `TriggerError` naming the part and
 * why; returns nothing otherwise.
 */
export function assertSupportedEventTrigger(trigger: EventTrigger): void {
  const declared = automationEventsOf(trigger.provider);
  if (declared === undefined) {
    throw new TriggerError(["provider"], "provider_unknown");
  }
  if (!declared.kinds.includes(trigger.kind)) {
    throw new TriggerError(["kind"], "kind_unsupported");
  }
  for (const [key, value] of Object.entries(trigger.filter)) {
    // Own keys only: `constructor` and `toString` are not projection fields.
    if (!Object.hasOwn(declared.filterKeys, key)) {
      throw new TriggerError(["filter", key], "filter_key_unsupported");
    }
    const fits = declared.filterKeys[key] === "number"
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
  const declared = automationEventsOf(trigger.provider);
  if (declared === undefined) return false;
  for (const [key, value] of Object.entries(trigger.filter)) {
    const field = (event as Record<string, unknown>)[key];
    if (
      !Object.hasOwn(declared.filterKeys, key) || field === null ||
      field !== value
    ) {
      return false;
    }
  }
  return true;
}
