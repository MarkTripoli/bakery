import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";

/**
 * Webhook events the receiver parses. Any other event that passes signature
 * verification is acknowledged and stored ignored without reading its payload.
 */
export const SUPPORTED_EVENTS = Object.freeze(
  [
    "ping",
    "installation",
    "installation_repositories",
    "github_app_authorization",
    "repository",
    "issues",
    "pull_request",
    "check_run",
    "check_suite",
  ] as const,
);
export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

const SUPPORTED_EVENT_SET: ReadonlySet<string> = new Set(SUPPORTED_EVENTS);

export function isSupportedEvent(value: string): value is SupportedEvent {
  return SUPPORTED_EVENT_SET.has(value);
}

/**
 * What a supported event asks of the processor. `ping` creates no route; the
 * other three are the stored route purposes.
 */
export const INTAKE_EVENT_FAMILIES = Object.freeze(
  ["installation_reconcile", "discovery", "fact_refresh", "ping"] as const,
);
export type IntakeEventFamily = (typeof INTAKE_EVENT_FAMILIES)[number];
export type IntakeRoutePurpose = Exclude<IntakeEventFamily, "ping">;

/** Longest string the stored projection keeps, in UTF-16 code units. */
export const PROJECTION_MAX_STRING = 256;

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,255}$/;
const EVENT_NAME_PATTERN = /^[a-z_]{1,100}$/;

/** The `X-GitHub-Delivery` value when it is 1 to 255 letters, digits or hyphens, else null. */
export function parseDeliveryIdHeader(value: string | null): string | null {
  return value !== null && DELIVERY_ID_PATTERN.test(value) ? value : null;
}

/** The `X-GitHub-Event` value when it is 1 to 100 lowercase letters or underscores, else null. */
export function parseEventNameHeader(value: string | null): string | null {
  return value !== null && EVENT_NAME_PATTERN.test(value) ? value : null;
}

const InstallationIdSchema = z.number().int().positive().describe(
  "Numeric GitHub installation id. Bakery resolves it together with the registration to its own installation row; it never names an organization.",
);

const RepositoryIdSchema = z.number().int().positive().describe(
  "Numeric GitHub repository id, the same value a selected repository resource stores as its external id.",
);

const ActionSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).describe(
  "Event action GitHub reports, such as created, suspend or labeled. Kept as bounded text so a new GitHub action does not reject the delivery.",
);

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/).describe(
  "Full 40-character lowercase hex commit SHA GitHub reports for the head being described.",
);

const InstallationReferenceSchema = z.object({
  id: InstallationIdSchema,
}).describe(
  "Installation GitHub attaches to a delivery sent for an App installation; fields other than the id are dropped.",
);

const RepositoryReferenceSchema = z.object({
  id: RepositoryIdSchema,
}).describe(
  "Repository a delivery is about; fields other than the id, including the name, are dropped because names can change.",
);

const PingPayloadSchema = z.object({
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the ping was sent for; an App-level ping carries none.",
  ),
}).describe(
  "Payload of a ping GitHub sends when a webhook is created or tested; only the installation reference is read.",
);

const InstallationPayloadSchema = z.object({
  action: ActionSchema,
  installation: InstallationReferenceSchema,
}).describe(
  "Payload of an installation lifecycle event (created, deleted, suspend, unsuspend, new_permissions_accepted); the installation is required because the event is about it.",
);

const InstallationRepositoriesPayloadSchema = z.object({
  action: ActionSchema,
  installation: InstallationReferenceSchema,
}).describe(
  "Payload of a change to the repositories an installation can reach (added or removed); the repository lists are dropped because a rescan reads the current set.",
);

const AppAuthorizationPayloadSchema = z.object({
  action: ActionSchema,
}).describe(
  "Payload of a user revoking the App's authorization; it carries no installation, so the receipt stage stores it ignored.",
);

const RepositoryPayloadSchema = z.object({
  action: ActionSchema,
  repository: RepositoryReferenceSchema,
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the repository event was sent for; a delivery without one is stored ignored.",
  ),
}).describe(
  "Payload of a repository event (created, deleted, archived, renamed, transferred and similar).",
);

const IssuesPayloadSchema = z.object({
  action: ActionSchema,
  issue: z.object({
    number: z.number().int().positive().describe(
      "Issue number within its repository, the number GitHub shows as #N.",
    ),
    pull_request: z.unknown().optional().describe(
      "Present only when the item is a pull request; only the key is kept, so the item can be told apart from an issue, and its content is never read.",
    ),
  }).describe(
    "Issue the event is about; only the number and the pull request marker are kept.",
  ),
  repository: RepositoryReferenceSchema,
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the issue event was sent for; a delivery without one is stored ignored.",
  ),
}).describe(
  "Payload of an issues event (opened, edited, labeled, closed and similar). It is a hint: the processor re-reads the issue before recording anything.",
);

const PullRequestPayloadSchema = z.object({
  action: ActionSchema,
  pull_request: z.object({
    number: z.number().int().positive().describe(
      "Pull request number within its repository, the number GitHub shows as #N.",
    ),
    head: z.object({
      sha: CommitShaSchema,
    }).describe("Head branch of the pull request; only its commit is kept."),
  }).describe(
    "Pull request the event is about; only the number and head commit are kept.",
  ),
  repository: RepositoryReferenceSchema,
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the pull request event was sent for; a delivery without one is stored ignored.",
  ),
}).describe(
  "Payload of a pull_request event (opened, synchronize, closed and similar). It is a hint: the processor re-reads the pull request before recording anything.",
);

const CheckRunPayloadSchema = z.object({
  action: ActionSchema,
  check_run: z.object({
    id: z.number().int().positive().describe(
      "Numeric GitHub id of the check run.",
    ),
    head_sha: CommitShaSchema,
  }).describe(
    "Check run the event is about; only its id and the commit it ran on are kept.",
  ),
  repository: RepositoryReferenceSchema,
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the check run event was sent for; a delivery without one is stored ignored.",
  ),
}).describe(
  "Payload of a check_run event (created, completed, rerequested and similar). It is a hint: the processor re-reads the check runs of the commit.",
);

const CheckSuitePayloadSchema = z.object({
  action: ActionSchema,
  check_suite: z.object({
    id: z.number().int().positive().describe(
      "Numeric GitHub id of the check suite.",
    ),
    head_sha: CommitShaSchema,
  }).describe(
    "Check suite the event is about; only its id and the commit it ran on are kept.",
  ),
  repository: RepositoryReferenceSchema,
  installation: InstallationReferenceSchema.optional().describe(
    "Installation the check suite event was sent for; a delivery without one is stored ignored.",
  ),
}).describe(
  "Payload of a check_suite event (completed, requested, rerequested). It is a hint: the processor re-reads the check runs of the commit.",
);

/**
 * One schema per supported event. Strict means required fields are validated
 * (a wrong type, a missing id or a malformed SHA fails the delivery); fields
 * GitHub adds are dropped rather than rejected, so the parsed payload holds
 * only what Bakery reads.
 */
export const INTAKE_PAYLOAD_SCHEMAS = {
  ping: PingPayloadSchema,
  installation: InstallationPayloadSchema,
  installation_repositories: InstallationRepositoriesPayloadSchema,
  github_app_authorization: AppAuthorizationPayloadSchema,
  repository: RepositoryPayloadSchema,
  issues: IssuesPayloadSchema,
  pull_request: PullRequestPayloadSchema,
  check_run: CheckRunPayloadSchema,
  check_suite: CheckSuitePayloadSchema,
} as const satisfies Record<SupportedEvent, z.ZodType<object>>;

type PayloadOf<Event extends SupportedEvent> = z.output<
  (typeof INTAKE_PAYLOAD_SCHEMAS)[Event]
>;

/** A delivery whose event name is supported and whose payload passed its schema. */
export type SupportedDelivery = {
  [Event in SupportedEvent]: {
    supported: true;
    eventName: Event;
    action: string | null;
    payload: PayloadOf<Event>;
  };
}[SupportedEvent];

/** A verified delivery whose event name Bakery does not parse; its payload is never read. */
export type UnsupportedDelivery = { supported: false; eventName: string };

export type ParsedDelivery = SupportedDelivery | UnsupportedDelivery;

export type IntakeContentKind = "json" | "form";

/**
 * Maps a `Content-Type` header to the encoding GitHub uses for deliveries:
 * `application/json`, or `application/x-www-form-urlencoded` carrying one
 * `payload` field. Parameters such as charset are ignored; any other media
 * type, or none, gives null.
 */
export function parseIntakeContentType(
  contentType: string | null,
): IntakeContentKind | null {
  if (contentType === null) return null;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "application/json") return "json";
  if (mediaType === "application/x-www-form-urlencoded") return "form";
  return null;
}

function decodeUtf8(
  raw: Uint8Array,
  code: "MALFORMED_JSON" | "MALFORMED_REQUEST",
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (cause) {
    throw new StandardError({ code, cause });
  }
}

function formPayload(raw: Uint8Array): string {
  const fields = new URLSearchParams(decodeUtf8(raw, "MALFORMED_REQUEST"));
  const names = [...fields.keys()];
  const payload = fields.get("payload");
  if (names.length !== 1 || payload === null) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return payload;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new StandardError({ code: "MALFORMED_JSON", cause });
  }
}

function actionOf(payload: object): string | null {
  return "action" in payload && typeof payload.action === "string"
    ? payload.action
    : null;
}

function accepted<
  Event extends SupportedEvent,
  Schema extends z.ZodType<object>,
>(
  eventName: Event,
  schema: Schema,
  json: unknown,
): {
  supported: true;
  eventName: Event;
  action: string | null;
  payload: z.output<Schema>;
} {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new StandardError({ code: "MALFORMED_REQUEST", cause: result.error });
  }
  return {
    supported: true,
    eventName,
    action: actionOf(result.data),
    payload: result.data,
  };
}

/**
 * Decodes and validates one verified delivery. JSON and the form encoding
 * (exactly one `payload` field) are accepted; any other content type is
 * UNSUPPORTED_MEDIA_TYPE, unreadable JSON or UTF-8 is MALFORMED_JSON, and a
 * payload that fails its schema or a malformed form or event name is
 * MALFORMED_REQUEST. An event name outside SUPPORTED_EVENTS returns
 * `{ supported: false }` before any decoding or schema work.
 */
export function parseDelivery(
  input: { contentType: string | null; raw: Uint8Array; eventName: string },
): ParsedDelivery {
  const kind = parseIntakeContentType(input.contentType);
  if (kind === null) {
    throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const eventName = parseEventNameHeader(input.eventName);
  if (eventName === null) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  if (!isSupportedEvent(eventName)) return { supported: false, eventName };
  const json = parseJson(
    kind === "form"
      ? formPayload(input.raw)
      : decodeUtf8(input.raw, "MALFORMED_JSON"),
  );
  switch (eventName) {
    case "ping":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.ping, json);
    case "installation":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.installation, json);
    case "installation_repositories":
      return accepted(
        eventName,
        INTAKE_PAYLOAD_SCHEMAS.installation_repositories,
        json,
      );
    case "github_app_authorization":
      return accepted(
        eventName,
        INTAKE_PAYLOAD_SCHEMAS.github_app_authorization,
        json,
      );
    case "repository":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.repository, json);
    case "issues":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.issues, json);
    case "pull_request":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.pull_request, json);
    case "check_run":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.check_run, json);
    case "check_suite":
      return accepted(eventName, INTAKE_PAYLOAD_SCHEMAS.check_suite, json);
  }
}

const EVENT_FAMILY = {
  ping: "ping",
  // Lifecycle of the installation itself; github_app_authorization has no
  // installation, so the receipt stage stores it ignored (no_installation).
  installation: "installation_reconcile",
  github_app_authorization: "installation_reconcile",
  installation_repositories: "discovery",
  repository: "discovery",
  issues: "fact_refresh",
  pull_request: "fact_refresh",
  check_run: "fact_refresh",
  check_suite: "fact_refresh",
} as const satisfies Record<SupportedEvent, IntakeEventFamily>;

/** The route purpose family of a supported event, from its name alone. */
export function classifyEvent(
  event: { readonly eventName: SupportedEvent },
): IntakeEventFamily {
  return EVENT_FAMILY[event.eventName];
}

export const IntakeProjectionSchema = z.object({
  action: z.string().max(PROJECTION_MAX_STRING).nullable().describe(
    "Event action, or null for an event without one such as ping.",
  ),
  installationId: z.number().int().positive().nullable().describe(
    "Numeric GitHub installation id from the payload, or null when the delivery carries none.",
  ),
  repositoryId: z.number().int().positive().nullable().describe(
    "Numeric GitHub repository id the event is about, or null for events not about one repository.",
  ),
  number: z.number().int().positive().nullable().describe(
    "Issue or pull request number the event is about, or null for events that name neither.",
  ),
  headSha: z.string().max(PROJECTION_MAX_STRING).nullable().describe(
    "Head commit SHA of a pull request or check event, or null for other events.",
  ),
}).describe(
  "Bounded summary of a delivery kept on its receipt in place of the body: ids, a number and a commit SHA, each string at most 256 characters, never repository text.",
);
export type IntakeProjection = z.output<typeof IntakeProjectionSchema>;

function bounded(value: string | null): string | null {
  return value === null ? null : value.slice(0, PROJECTION_MAX_STRING);
}

/** The bounded projection stored on the receipt; every string is cut to 256 characters. */
export function projectEvent(event: SupportedDelivery): IntakeProjection {
  const base: IntakeProjection = {
    action: bounded(event.action),
    installationId: null,
    repositoryId: null,
    number: null,
    headSha: null,
  };
  switch (event.eventName) {
    case "ping":
    case "installation":
    case "installation_repositories":
      base.installationId = event.payload.installation?.id ?? null;
      break;
    case "github_app_authorization":
      break;
    case "repository":
      base.installationId = event.payload.installation?.id ?? null;
      base.repositoryId = event.payload.repository.id;
      break;
    case "issues":
      base.installationId = event.payload.installation?.id ?? null;
      base.repositoryId = event.payload.repository.id;
      base.number = event.payload.issue.number;
      break;
    case "pull_request":
      base.installationId = event.payload.installation?.id ?? null;
      base.repositoryId = event.payload.repository.id;
      base.number = event.payload.pull_request.number;
      base.headSha = bounded(event.payload.pull_request.head.sha);
      break;
    case "check_run":
      base.installationId = event.payload.installation?.id ?? null;
      base.repositoryId = event.payload.repository.id;
      base.headSha = bounded(event.payload.check_run.head_sha);
      break;
    case "check_suite":
      base.installationId = event.payload.installation?.id ?? null;
      base.repositoryId = event.payload.repository.id;
      base.headSha = bounded(event.payload.check_suite.head_sha);
      break;
  }
  return IntakeProjectionSchema.parse(base);
}
