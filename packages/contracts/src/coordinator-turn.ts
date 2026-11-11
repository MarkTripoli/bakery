import { z } from "zod";

/** Largest agent reply body, bytes. */
export const MAX_REPLY_BYTES = 32 * 1024;

export const CoordinatorReplyEffectSchema = z.object({
  type: z.literal("reply").describe(
    "Discriminator selecting the reply effect.",
  ),
  body: z.string().min(1).max(MAX_REPLY_BYTES).describe(
    "Agent reply text Bakery appends to the transcript as an agent_output message.",
  ),
}).strict().describe(
  "Effect asking Bakery to append one agent reply message to the conversation.",
);

export const CoordinatorQuestionEffectSchema = z.object({
  type: z.literal("question").describe(
    "Discriminator selecting the question effect.",
  ),
  prompt: z.string().min(1).max(4000).describe(
    "Question text the agent wants a participant to answer.",
  ),
  options: z.array(
    z.object({
      id: z.string().min(1).max(100).describe("Stable option identifier."),
      label: z.string().min(1).max(300).describe(
        "Human-readable option label.",
      ),
    }).strict().describe("One selectable answer option."),
  ).max(20).describe("Closed set of allowed answers.").optional().describe(
    "Optional closed set of allowed answers.",
  ),
  allowFreeText: z.boolean().describe("Free-text answer flag.").optional()
    .describe(
      "Whether a free-text answer is accepted besides the options; defaults to true only when no options are listed.",
    ),
  audience: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("task_participants").describe(
        "Discriminator selecting every participant of the conversation.",
      ),
    }).strict().describe("Audience of all conversation participants."),
    z.object({
      type: z.literal("principals").describe(
        "Discriminator selecting an explicit principal list.",
      ),
      principalIds: z.array(z.string().uuid().describe("Principal id."))
        .min(1).max(50).describe(
          "Principals allowed to read and answer or decide; everyone else gets not found.",
        ),
    }).strict().describe(
      "Audience restricted to explicit principals, who alone can read and answer or decide it.",
    ),
  ]).describe("Audience selector.").optional().describe(
    "Actor scope allowed to read and answer; defaults to task participants.",
  ),
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60)
    .describe("Question lifetime in seconds.").optional()
    .describe(
      "Seconds until the question expires; defaults to seven days.",
    ),
}).strict().describe(
  "Effect asking Bakery to open a durable question bound to the asking turn.",
);

export const CoordinatorPlanRevisionEffectSchema = z.object({
  type: z.literal("planRevision").describe(
    "Discriminator selecting the plan revision effect.",
  ),
  title: z.string().min(1).max(300).describe("Proposed plan title."),
  steps: z.array(
    z.object({
      id: z.string().min(1).max(100).describe("Stable step identifier."),
      title: z.string().min(1).max(300).describe("Short step title."),
      detail: z.string().max(4000).describe("Step detail text."),
    }).strict().describe("One proposed plan step."),
  ).min(1).max(100).describe("Ordered proposed plan steps."),
}).strict().describe(
  "Effect proposing a plan revision; Bakery stores it as the task's next plan revision and requests approval when the stage policy needs a human.",
);

export const CoordinatorNoopEffectSchema = z.object({
  type: z.literal("noop").describe("Discriminator selecting the noop effect."),
}).strict().describe("Effect asking Bakery to change nothing.");

export const CoordinatorEffectSchema = z.discriminatedUnion("type", [
  CoordinatorReplyEffectSchema,
  CoordinatorQuestionEffectSchema,
  CoordinatorPlanRevisionEffectSchema,
  CoordinatorNoopEffectSchema,
]).describe("One typed effect a coordinator turn asks Bakery to apply.");
export type CoordinatorEffect = z.infer<typeof CoordinatorEffectSchema>;

/** Worker action name registered for coordinator turns; never a workflow step. */
export const COORDINATOR_TURN_ACTION = "coordinator.turn";

/** Canonical job input transport bound (`executionJobInputFitsTransport`). */
export const COORDINATOR_INPUT_MAX_BYTES = 100_000;
/** `buildCoordinatorTurnJobInput` trims the transcript to this many bytes. */
export const COORDINATOR_INPUT_TARGET_BYTES = 90_000;
/**
 * Worker terminal result payload cap is `WORKER_RESULT_MAX_BYTES` = 32_000
 * (apps/worker/src/types.ts:19, enforced at supervisor-execution.ts:1111).
 * The output bound is min(65536, 32000 - 4096), leaving envelope headroom.
 */
export const COORDINATOR_OUTPUT_MAX_BYTES = Math.min(65_536, 32_000 - 4_096);

const encoder = new TextEncoder();
function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** Canonical (sorted keys, undefined dropped) JSON, as admission measures it. */
function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(entry).sort()) {
        const child = (entry as Record<string, unknown>)[key];
        if (child !== undefined) sorted[key] = normalize(child);
      }
      return sorted;
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

/** Question effect the agent may emit: audience is always every participant. */
export const CoordinatorAgentQuestionEffectSchema =
  CoordinatorQuestionEffectSchema.extend({
    audience: z.object({
      type: z.literal("task_participants").describe(
        "Discriminator selecting every participant of the conversation.",
      ),
    }).strict().describe("Audience of all conversation participants.")
      .optional().describe(
        "Actor scope allowed to answer; the agent can only address all task participants.",
      ),
  }).strict().describe(
    "Question effect emitted by the agent; restricted audiences are not allowed because the agent holds no user identities.",
  );

export const CoordinatorAgentEffectSchema = z.discriminatedUnion("type", [
  CoordinatorReplyEffectSchema,
  CoordinatorAgentQuestionEffectSchema,
  CoordinatorPlanRevisionEffectSchema,
  CoordinatorNoopEffectSchema,
]).describe(
  "One typed effect the live coordinator agent may ask Bakery to apply.",
);

/** What the model emits; basis of the `--json-schema` argument. */
export const CoordinatorModelOutputSchema = z.object({
  effects: z.array(CoordinatorAgentEffectSchema).max(20).describe(
    "Ordered effects Bakery applies for this turn; at most twenty.",
  ),
}).strict().describe(
  "Structured coordinator turn answer emitted by the model.",
);

/** Worker result for one coordinator turn. */
export const CoordinatorTurnJobOutputSchema = z.object({
  effects: z.array(CoordinatorAgentEffectSchema).max(20).describe(
    "Ordered effects Bakery applies for this turn; at most twenty.",
  ),
  model: z.string().min(1).max(200).describe(
    "Model identifier that produced the answer.",
  ),
  claudeCodeVersion: z.string().min(1).max(100).describe(
    "Claude Code harness version that ran the turn.",
  ),
  sessionId: z.string().min(1).max(200).describe("Harness session id.")
    .optional()
    .describe(
      "Harness session id of the turn, when the harness exposes one.",
    ),
}).strict().superRefine((value, ctx) => {
  if (byteLength(value) > COORDINATOR_OUTPUT_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      message:
        `Serialized coordinator output exceeds ${COORDINATOR_OUTPUT_MAX_BYTES} bytes.`,
    });
  }
}).describe(
  "Result of one coordinator turn: effects plus harness provenance, capped in total serialized size.",
);
export type CoordinatorTurnJobOutput = z.infer<
  typeof CoordinatorTurnJobOutputSchema
>;

/** JSON Schema handed to the harness so it emits only valid effects. */
export function coordinatorOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(CoordinatorModelOutputSchema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

const decimal = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).describe(
  "Lossless nonnegative decimal sequence number.",
);
const optionalId = z.uuid().describe("Exact resource identity.");
const nullValue = z.null().describe("Explicit absent value.");
function orNull<T extends z.ZodType>(schema: T, description: string) {
  return z.union([schema, nullValue]).describe(description);
}
const recordKey = z.string().describe("Field name.");

export const CoordinatorTurnMessageSchema = z.object({
  sequence: decimal.describe("Message sequence number as a decimal string."),
  role: z.enum(["participant", "agent"]).describe(
    "Author role; never a principal id.",
  ),
  messageType: z.string().min(1).max(100).describe("Stored message type."),
  intent: z.string().max(100).describe("Stored message intent."),
  body: z.string().max(100_000).describe("Message body text."),
}).strict().describe("One transcript message shown to the coordinator agent.");

export const CoordinatorTurnJobInputSchema = z.object({
  turnId: z.uuid().describe("Conversation turn this job answers."),
  conversationId: z.uuid().describe("Conversation the turn belongs to."),
  contextThroughSequence: decimal.describe(
    "Highest message sequence the agent may see.",
  ),
  messages: z.array(CoordinatorTurnMessageSchema).max(1000).describe(
    "Transcript messages, ascending by sequence, possibly trimmed at the front.",
  ),
  truncatedBeforeSequence: orNull(
    decimal,
    "When older messages were dropped, the lowest kept sequence; otherwise null.",
  ),
  scope: z.object({
    applicationId: orNull(optionalId, "Application scope, if any."),
    repositoryId: orNull(optionalId, "Repository scope, if any."),
    taskId: orNull(optionalId, "Task the plan attaches to, if any."),
  }).strict().describe("Conversation scope."),
  openQuestions: z.array(
    z.record(recordKey, z.unknown().describe("Question field value.")).describe(
      "One open question as stored.",
    ),
  ).max(50).describe("Questions still awaiting an answer."),
  currentPlanRevision: orNull(
    z.record(
      recordKey,
      z.unknown().describe("Plan context field value."),
    ).describe("Current plan revision context as stored."),
    "Current plan revision context, or null.",
  ),
  limits: z.object({
    maxEffects: z.number().int().describe("Most effects the answer may hold."),
    maxReplyBytes: z.number().int().describe("Largest reply body in bytes."),
    maxOutputBytes: z.number().int().describe(
      "Largest serialized answer in bytes.",
    ),
  }).strict().describe("Output limits the agent must respect."),
}).strict().superRefine((value, ctx) => {
  if (
    encoder.encode(canonicalJson(value)).length > COORDINATOR_INPUT_MAX_BYTES
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        `Canonical coordinator job input exceeds ${COORDINATOR_INPUT_MAX_BYTES} bytes.`,
    });
  }
}).describe(
  "Input of one coordinator turn job; canonical size fits the job transport.",
);
export type CoordinatorTurnJobInput = z.infer<
  typeof CoordinatorTurnJobInputSchema
>;

/** Provider-neutral turn snapshot the builder consumes (subset of the executor input). */
export type CoordinatorTurnSource = Readonly<{
  turnId: string;
  conversationId: string;
  contextThroughSequence: string;
  messages: ReadonlyArray<
    Readonly<{
      sequence: string;
      authorId: string | null;
      messageType: string;
      intent: string;
      body: string;
    }>
  >;
  scope: Readonly<{
    applicationId: string | null;
    repositoryId: string | null;
    taskId: string | null;
  }>;
  openQuestions: readonly unknown[];
  currentPlanRevision: unknown | null;
}>;

/** Build the job input, dropping oldest messages until it fits 90000 bytes. */
export function buildCoordinatorTurnJobInput(
  source: CoordinatorTurnSource,
): CoordinatorTurnJobInput {
  const all = source.messages.map((message) => ({
    sequence: message.sequence,
    role: message.authorId === null ? "agent" as const : "participant" as const,
    messageType: message.messageType,
    intent: message.intent,
    body: message.body,
  }));
  const make = (drop: number): CoordinatorTurnJobInput => {
    const messages = all.slice(drop);
    return {
      turnId: source.turnId,
      conversationId: source.conversationId,
      contextThroughSequence: source.contextThroughSequence,
      messages,
      truncatedBeforeSequence: drop > 0 && messages.length > 0
        ? messages[0].sequence
        : drop > 0
        ? source.contextThroughSequence
        : null,
      scope: { ...source.scope },
      openQuestions: source.openQuestions as CoordinatorTurnJobInput[
        "openQuestions"
      ],
      currentPlanRevision: source
        .currentPlanRevision as CoordinatorTurnJobInput[
          "currentPlanRevision"
        ],
      limits: {
        maxEffects: 20,
        maxReplyBytes: MAX_REPLY_BYTES,
        maxOutputBytes: COORDINATOR_OUTPUT_MAX_BYTES,
      },
    };
  };
  const size = (input: CoordinatorTurnJobInput) =>
    encoder.encode(canonicalJson(input)).length;
  let low = 0;
  let high = all.length;
  // Smallest drop count that fits; size is monotone in dropped messages.
  while (low < high) {
    const mid = (low + high) >> 1;
    if (size(make(mid)) <= COORDINATOR_INPUT_TARGET_BYTES) high = mid;
    else low = mid + 1;
  }
  return make(low);
}
