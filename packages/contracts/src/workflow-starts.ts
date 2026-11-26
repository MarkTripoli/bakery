import { z } from "zod";

/**
 * A workflow version's starts (one engine O8).
 *
 * A start is what makes a version runnable without a person: an event matcher
 * or a schedule, authored and exported with the version. It is data and never
 * an expression, for the same reason an automation's trigger is: reviewable,
 * diffable, and impossible to smuggle a predicate through.
 *
 * Starts sit beside the version's specification rather than inside it, so the
 * digest a version was published under covers only what executes and every
 * already-published version stays valid. They are switched on by publishing the
 * version and by nothing else: no conversation, skill or agent can activate a
 * start on a version that is not the one in use.
 */

/** A filter value: equality on a named field of the event's neutral projection. */
export const WorkflowStartFilterValueSchema = z.union([
  z.string().max(512).describe("Text a field must equal."),
  z.number().describe("Number a field must equal."),
  z.boolean().describe("Whether a field must be true or false."),
]).describe(
  "Value a field of the event's neutral projection must equal for the start to match.",
);

/** At most this many field comparisons per start, so matching stays cheap. */
export const WORKFLOW_START_FILTER_MAX_FIELDS = 16;

/** At most this many starts per version, so a version cannot become a fan-out. */
export const WORKFLOW_START_MAX = 16;

const startId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe(
    "Stable identifier of the start within its version, lowercase letters, digits and hyphens.",
  );

export const WorkflowStartEventValueSchema = z.enum(["repositoryId"]).describe(
  "Value the firing event supplies: repositoryId is the Bakery repository the event arrived on.",
);

const eventStartSchema = z.object({
  kind: z.literal("event").describe(
    "This start fires when a matching event arrives.",
  ),
  eventKind: z.string().min(1).max(120).describe(
    "Provider-neutral event kind to match, for example work_item.ready. It is never a provider's own event name.",
  ),
  filter: z.record(
    z.string().min(1).max(120).describe(
      "Field of the event's neutral projection to compare.",
    ),
    WorkflowStartFilterValueSchema,
  )
    .refine(
      (filter) =>
        Object.keys(filter).length <= WORKFLOW_START_FILTER_MAX_FIELDS,
      {
        message: `At most ${WORKFLOW_START_FILTER_MAX_FIELDS} filter fields.`,
      },
    )
    .describe(
      "Equality filters on fields of the neutral event projection; an empty object matches every event of the kind.",
    ),
  inputsFromEvent: z.record(
    z.string().min(1).max(120).describe(
      "Name of one workflow input the event supplies.",
    ),
    WorkflowStartEventValueSchema,
  )
    .refine(
      (inputs) =>
        Object.keys(inputs).length <= WORKFLOW_START_FILTER_MAX_FIELDS,
      {
        message:
          `At most ${WORKFLOW_START_FILTER_MAX_FIELDS} inputs from the event.`,
      },
    )
    .optional()
    .describe(
      "Inputs of each run this start fires that take their value from the event that fired it, by input name. They are set over the start's static inputs. Omitted means none.",
    ),
}).strict().describe(
  "An event matcher: fire this version when an event of the named kind matches every filter.",
);

const scheduleStartSchema = z.object({
  kind: z.literal("schedule").describe(
    "This start fires on a clock rather than on an event.",
  ),
  cron: z.string().min(1).max(120).describe(
    "Five-field cron expression in the canonical form the schedule parser stores.",
  ),
  timezone: z.string().min(1).max(64).describe(
    "IANA timezone the expression is read in.",
  ),
}).strict().describe(
  "A clock start: fire this version on the named schedule in the named zone.",
);

/** The most a run one start fires may spend; a run budget is decimal USD. */
export const WORKFLOW_START_MAX_BUDGET_USD = 10_000;

/** The most the inputs of one start may weigh once written as JSON. */
export const WORKFLOW_START_MAX_INPUT_BYTES = 16_000;

export const WorkflowStartSchema = z.object({
  id: startId,
  inputs: z.record(
    z.string().min(1).max(120).describe("Name of one workflow input."),
    z.json().describe("Value of that input, any JSON."),
  )
    .refine(
      (inputs) =>
        new TextEncoder().encode(JSON.stringify(inputs)).byteLength <=
          WORKFLOW_START_MAX_INPUT_BYTES,
      {
        message:
          `Inputs weigh at most ${WORKFLOW_START_MAX_INPUT_BYTES} bytes.`,
      },
    )
    .optional()
    .describe(
      "Inputs of each run this start fires, by name, as the workflow declares them. Static data, never an expression. Omitted means none, which a workflow that requires an input refuses at start with a stable code on the firing.",
    ),
  budgetUsd: z.number().min(0).max(WORKFLOW_START_MAX_BUDGET_USD).optional()
    .describe(
      "Budget in USD of each run this start fires. Omitted means 0, which a workflow with a model step refuses at start, so a start that needs a model must name one.",
    ),
  on: z.discriminatedUnion("kind", [eventStartSchema, scheduleStartSchema])
    .describe("What makes this start fire."),
}).strict().describe(
  "One start of a workflow version: an identifier and either an event matcher or a schedule.",
);
export type WorkflowStart = z.output<typeof WorkflowStartSchema>;

export const WorkflowStartsSchema = z.array(WorkflowStartSchema).max(
  WORKFLOW_START_MAX,
).refine(
  (starts) => new Set(starts.map((start) => start.id)).size === starts.length,
  { message: "Start identifiers must be unique within a version." },
).describe(
  `The starts of one workflow version, at most ${WORKFLOW_START_MAX}, each with a unique identifier.`,
);
export type WorkflowStarts = z.output<typeof WorkflowStartsSchema>;

/** A version that starts nothing, which is what every version begins as. */
export const NO_STARTS: WorkflowStarts = [];
