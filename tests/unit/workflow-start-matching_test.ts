/**
 * Slice 2 of #406: a start matches a provider-neutral event, and a start that no
 * source could ever fire is refused when it is written. Provider event names
 * never reach the matcher; the closed translation table is the only place a
 * provider appears.
 */
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { WorkflowStartsSchema } from "@bakery/contracts/workflow-starts";
import {
  neutralEventOf,
  neutralFieldsOf,
} from "../../apps/server/src/modules/integrations/neutral-events.ts";
import { GITHUB_PROVIDER } from "../../apps/server/src/modules/integrations/registry.ts";
import { startMatches } from "../../apps/server/src/modules/workflows/start-match.ts";
import { readStarts } from "../../apps/server/src/modules/workflows/start-read.ts";

const facts = (
  kind: string,
  action: string | null,
  rest: Partial<
    { number: number; headSha: string; repositoryId: number }
  > = {},
) => ({
  kind,
  action,
  number: rest.number ?? null,
  headSha: rest.headSha ?? null,
  repositoryId: rest.repositoryId ?? null,
});

Deno.test("a delivery translates into a neutral event with the fields it carries", () => {
  assertEquals(
    neutralEventOf(
      GITHUB_PROVIDER,
      facts("pull_request", "opened", {
        number: 3,
        headSha: "abc",
        repositoryId: 7,
      }),
    ),
    {
      kind: "change_request.opened",
      fields: { number: 3, headSha: "abc", repositoryId: 7 },
    },
  );
  // A provider's own action name is renamed, never passed through.
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("pull_request", "synchronize"))?.kind,
    "change_request.updated",
  );
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("issues", "labeled"))?.kind,
    "work_item.labeled",
  );
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("check_run", "completed"))?.kind,
    "check.completed",
  );
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("check_suite", "completed"))?.kind,
    "check.completed",
  );
});

Deno.test("a field the delivery does not carry is left out, so a filter on it never matches", () => {
  const event = neutralEventOf(
    GITHUB_PROVIDER,
    facts("issues", "opened", { repositoryId: 7 }),
  );
  assertEquals(event?.fields, { repositoryId: 7 });
});

Deno.test("an event or action with no neutral meaning produces no event", () => {
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("pull_request", "locked")),
    null,
  );
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("pull_request", null)),
    null,
  );
  assertEquals(neutralEventOf(GITHUB_PROVIDER, facts("ping", "opened")), null);
  assertEquals(
    neutralEventOf("not-a-provider", facts("issues", "opened")),
    null,
  );
  // Inherited object keys are not providers, events or actions.
  assertEquals(neutralEventOf("constructor", facts("issues", "opened")), null);
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("constructor", "opened")),
    null,
  );
  assertEquals(
    neutralEventOf(GITHUB_PROVIDER, facts("issues", "toString")),
    null,
  );
});

Deno.test("the vocabulary declares what each kind can be filtered on", () => {
  assertEquals(neutralFieldsOf("change_request.opened"), {
    number: "number",
    headSha: "string",
    repositoryId: "number",
  });
  // Reserved for ticket admission (#407): nameable, with no field declared yet.
  assertEquals(neutralFieldsOf("work_item.ready"), {});
  assertEquals(neutralFieldsOf("pull_request"), undefined);
  assertEquals(neutralFieldsOf("constructor"), undefined);
});

const event = {
  kind: "change_request.opened",
  fields: { number: 3, headSha: "abc", repositoryId: 7 },
} as const;
const on = (
  eventKind: string,
  filter: Record<string, string | number | boolean> = {},
) => ({ kind: "event" as const, eventKind, filter });

Deno.test("a start matches the same kind and every filter entry strictly equal", () => {
  assert(startMatches(on("change_request.opened"), event));
  assert(startMatches(on("change_request.opened", { repositoryId: 7 }), event));
  assert(
    startMatches(
      on("change_request.opened", { repositoryId: 7, headSha: "abc" }),
      event,
    ),
  );
  assertFalse(startMatches(on("change_request.closed"), event));
  assertFalse(
    startMatches(on("change_request.opened", { repositoryId: 8 }), event),
  );
  // One entry failing fails the whole filter.
  assertFalse(
    startMatches(
      on("change_request.opened", { repositoryId: 7, headSha: "other" }),
      event,
    ),
  );
});

Deno.test("matching is strict about type and about fields the event lacks", () => {
  assertFalse(
    startMatches(on("change_request.opened", { repositoryId: "7" }), event),
  );
  assertFalse(
    startMatches(on("change_request.opened", { number: true }), event),
  );
  assertFalse(startMatches(on("change_request.opened", { missing: 1 }), event));
  // Inherited object keys are not event fields.
  assertFalse(
    startMatches(on("change_request.opened", { constructor: "x" }), event),
  );
  assertFalse(
    startMatches(
      on("change_request.opened", { repositoryId: 7 }),
      { kind: "change_request.opened", fields: {} },
    ),
  );
});

const parsed = (starts: unknown) => WorkflowStartsSchema.parse(starts);
const refusedWith = (starts: unknown, reason: string, startId: string) => {
  const error = assertThrows(() => readStarts(parsed(starts)), StandardError);
  assertEquals(error.code, "VALIDATION_FAILED");
  assertEquals(error.params, { reason, startId });
};
const eventStart = (
  eventKind: string,
  filter: Record<string, string | number | boolean> = {},
) => [{ id: "s", on: { kind: "event" as const, eventKind, filter } }];

Deno.test("a start no source could fire is refused where it is written", () => {
  refusedWith(eventStart("pull_request"), "start_event_kind_unknown", "s");
  refusedWith(
    eventStart("change_request.merged"),
    "start_event_kind_unknown",
    "s",
  );
  refusedWith(eventStart("constructor"), "start_event_kind_unknown", "s");
  refusedWith(
    eventStart("change_request.opened", { branch: "main" }),
    "start_filter_key_unsupported",
    "s",
  );
  refusedWith(
    eventStart("change_request.opened", { constructor: "x" }),
    "start_filter_key_unsupported",
    "s",
  );
  refusedWith(
    eventStart("change_request.opened", { repositoryId: "7" }),
    "start_filter_value_type",
    "s",
  );
  refusedWith(
    eventStart("change_request.opened", { repositoryId: 1.5 }),
    "start_filter_value_type",
    "s",
  );
  refusedWith(
    eventStart("change_request.opened", { headSha: 5 }),
    "start_filter_value_type",
    "s",
  );
  // The reserved kind is nameable, but no field is declared for it yet.
  refusedWith(
    eventStart("work_item.ready", { state: "open" }),
    "start_filter_key_unsupported",
    "s",
  );
});

Deno.test("a start a source can fire is read as written, and schedules still go through the scheduler's parsers", () => {
  assertEquals(
    readStarts(
      parsed(eventStart("change_request.opened", { repositoryId: 7 })),
    ),
    eventStart("change_request.opened", { repositoryId: 7 }),
  );
  assertEquals(readStarts(parsed(eventStart("work_item.ready"))).length, 1);
  const clock = (cron: string, timezone: string) => [
    { id: "clock", on: { kind: "schedule" as const, cron, timezone } },
  ];
  assertEquals(
    readStarts(parsed(clock("0 9 * * *", "europe/london"))),
    clock("0 9 * * *", "Europe/London"),
  );
  const error = assertThrows(
    () => readStarts(parsed(clock("61 * * * *", "UTC"))),
    StandardError,
  );
  assertEquals(error.params, {
    reason: "start_schedule_cron_invalid",
    startId: "clock",
  });
});
