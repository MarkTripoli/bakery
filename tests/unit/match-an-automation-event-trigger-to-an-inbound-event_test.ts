import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertSupportedEventTrigger,
  EVENT_FILTER_KEYS,
  EVENT_TRIGGER_KINDS,
  type EventFacts,
  eventMatches,
} from "../../apps/server/src/modules/workflows/automations/event-match.ts";
import {
  type EventTrigger,
  parseTrigger,
  TriggerError,
} from "../../apps/server/src/modules/workflows/automations/trigger.ts";

// #36 slice 4d. An event trigger answers an inbound event by exact equality on
// the receipt's own fields, and a version cannot name a kind or filter key the
// receipt does not carry (it would never fire).

const trigger = (over: Record<string, unknown> = {}): EventTrigger =>
  parseTrigger({
    type: "event",
    provider: "github",
    kind: "issues",
    ...over,
  }) as EventTrigger;

const event = (over: Partial<EventFacts> = {}): EventFacts => ({
  kind: "issues",
  action: "opened",
  number: 7,
  headSha: null,
  repositoryId: 4242,
  ...over,
});

Deno.test("the kind must be equal, and the action only when the trigger names one", () => {
  assert(eventMatches(trigger(), event()));
  assert(eventMatches(trigger({ action: "opened" }), event()));
  assert(!eventMatches(trigger({ action: "closed" }), event()));
  assert(!eventMatches(trigger(), event({ kind: "pull_request" })));
  // A trigger without an action answers an event that has none as well.
  assert(eventMatches(trigger(), event({ action: null })));
  // A trigger that names an action is not answered by an event without one.
  assert(!eventMatches(trigger({ action: "opened" }), event({ action: null })));
});

Deno.test("every filter entry must equal the event's field, strictly", () => {
  assert(eventMatches(trigger({ filter: { number: 7 } }), event()));
  assert(!eventMatches(trigger({ filter: { number: 8 } }), event()));
  // Strict: a string is not the number, and a missing field equals nothing.
  assert(!eventMatches(trigger({ filter: { number: "7" } }), event()));
  assert(
    !eventMatches(trigger({ filter: { number: 7 } }), event({ number: null })),
  );
  assert(
    !eventMatches(
      trigger({ kind: "check_run", filter: { headSha: "a".repeat(40) } }),
      event({ kind: "check_run", headSha: null }),
    ),
  );
  assert(
    eventMatches(
      trigger({ kind: "check_run", filter: { headSha: "a".repeat(40) } }),
      event({ kind: "check_run", headSha: "a".repeat(40) }),
    ),
  );
  // All entries, not any.
  assert(
    !eventMatches(
      trigger({ filter: { number: 7, repositoryId: 1 } }),
      event(),
    ),
  );
  assert(
    eventMatches(
      trigger({ filter: { number: 7, repositoryId: 4242 } }),
      event(),
    ),
  );
});

Deno.test("a filter key the receipt does not carry never matches, even if the event object had it", () => {
  // The trigger parser accepts any scalar key; the matcher reads only the
  // projection's fields, whatever else an object carries.
  const loose = { ...event(), sender: "octocat" } as unknown as EventFacts;
  assert(!eventMatches(trigger({ filter: { sender: "octocat" } }), loose));
  assert(!eventMatches(trigger({ filter: { kind: "issues" } }), event()));
  assert(!eventMatches(trigger({ filter: { action: "opened" } }), event()));
});

Deno.test("only kinds the receipt routes and filter keys it carries can be named, with the right type", () => {
  for (const kind of EVENT_TRIGGER_KINDS) {
    assertSupportedEventTrigger(trigger({ kind }));
  }
  const refused = (over: Record<string, unknown>) =>
    assertThrows(
      () => assertSupportedEventTrigger(trigger(over)),
      TriggerError,
    );
  assertEquals(refused({ kind: "push" }).reason, "kind_unsupported");
  assertEquals(refused({ kind: "installation" }).path, ["kind"]);
  // Inherited names are not projection fields either.
  assertEquals(
    refused({ filter: { constructor: "x" } }).reason,
    "filter_key_unsupported",
  );
  assertEquals(
    refused({ filter: { toString: 1 } }).reason,
    "filter_key_unsupported",
  );
  const key = refused({ filter: { labels: "bug" } });
  assertEquals([key.path, key.reason], [
    ["filter", "labels"],
    "filter_key_unsupported",
  ]);
  assertEquals(
    refused({ filter: { number: "7" } }).reason,
    "filter_value_type",
  );
  assertEquals(
    refused({ filter: { number: 7.5 } }).reason,
    "filter_value_type",
  );
  assertEquals(
    refused({ filter: { headSha: 12 } }).reason,
    "filter_value_type",
  );
  assertEquals(
    refused({ filter: { repositoryId: true } }).reason,
    "filter_value_type",
  );
  // The keys are the projection's, and nothing else.
  assertEquals(Object.keys(EVENT_FILTER_KEYS).sort(), [
    "headSha",
    "number",
    "repositoryId",
  ]);
  assertSupportedEventTrigger(
    trigger({
      filter: { number: 7, headSha: "a".repeat(40), repositoryId: 1 },
    }),
  );
});
