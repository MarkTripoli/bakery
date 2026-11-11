import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Ordered store of bounded provider facts.
 *
 * A fact is written only from a fresh provider read, never from a webhook
 * payload, and only when its ordering marker is newer than the stored one:
 * the pair (provider_updated_at, observed_started_at), compared in that
 * order. A delayed or reordered read therefore cannot overwrite newer state,
 * and a read of the state already stored changes nothing but the stored read
 * start, so `version` moves only when the provider object did.
 */

/** Kinds of provider object stored as facts; pull requests have their own table. */
export const RemoteFactKind = Object.freeze(
  {
    Issue: "issue",
    CheckRun: "check_run",
  } as const,
);
export type RemoteFactKind =
  (typeof RemoteFactKind)[keyof typeof RemoteFactKind];

/** State of a fact whose object a fresh read found gone (404, 410 or moved). */
export const GONE_STATE = "gone";

/** Most label names one fact keeps. */
export const FACT_MAX_LABELS = 50;
/** Longest label name one fact keeps, in characters. */
export const FACT_MAX_LABEL_LENGTH = 50;
/** Largest canonical JSON summary one fact stores, in bytes. */
export const FACT_MAX_SUMMARY_BYTES = 2048;

const FULL_SHA = /^[0-9a-f]{40}$/;
const textEncoder = new TextEncoder();

/**
 * The bounded summary of a fact. The object is strict, so an issue body, a
 * comment or any other free text cannot be stored by adding a key; every
 * field is a short, validated projection of what the provider returned.
 */
export const RemoteFactSummarySchema = z.object({
  labels: z.array(
    z.string().min(1).max(FACT_MAX_LABEL_LENGTH).describe(
      "One label name, at most 50 characters.",
    ),
  ).max(FACT_MAX_LABELS).optional().describe(
    "Issue label names, at most 50 of them; omitted for a check run.",
  ),
  locked: z.boolean().optional().describe(
    "Whether the issue conversation is locked; omitted for a check run.",
  ),
  stateReason: z.string().max(64).nullable().optional().describe(
    "Provider reason an issue closed (for example completed or not_planned), null when none; omitted for a check run.",
  ),
  name: z.string().max(256).optional().describe(
    "Check run name as the check's App reported it; omitted for an issue.",
  ),
  status: z.string().max(64).optional().describe(
    "Provider status of a check run (queued, in_progress or completed); omitted for an issue.",
  ),
  appId: z.number().int().nonnegative().nullable().optional().describe(
    "Numeric id of the GitHub App that owns the check run; null when GitHub no longer has the App, so the author is unknown; omitted for an issue.",
  ),
  appSlug: z.string().max(100).nullable().optional().describe(
    "Slug of the GitHub App that owns the check run; null when GitHub no longer has the App, so the author is unknown; omitted for an issue.",
  ),
  startedAt: z.string().max(64).nullable().optional().describe(
    "ISO 8601 time the check run started, null when it has not; omitted for an issue.",
  ),
  completedAt: z.string().max(64).nullable().optional().describe(
    "ISO 8601 time the check run completed, null when it has not; omitted for an issue.",
  ),
}).strict().refine(
  (summary) => summaryBytes(summary) <= FACT_MAX_SUMMARY_BYTES,
  { message: "the fact summary exceeds 2 KiB" },
).describe(
  "Bounded projection of one provider object: label names and flags for an issue, name, status and App for a check run. Never carries an issue body or any free text; its canonical JSON is at most 2 KiB.",
);
export type RemoteFactSummary = z.output<typeof RemoteFactSummarySchema>;

function summaryBytes(summary: unknown): number {
  return textEncoder.encode(canonicalJson(summary)).byteLength;
}

/** The longest prefix of `text` that fits `max` UTF-16 units without splitting a code point. */
function clip(text: string, max: number): string {
  let clipped = "";
  for (const character of text) {
    if (clipped.length + character.length > max) break;
    clipped += character;
  }
  return clipped;
}

/**
 * Fits a summary to its bounds deterministically instead of rejecting it:
 * at most 50 labels, each clipped to 50 characters, then trailing labels are
 * dropped until the canonical JSON is within 2 KiB. 50 labels of 50
 * characters alone exceed 2 KiB, so a busy issue must not fail the store;
 * readers build the summary with this and the schema stays the safety net.
 */
export function boundFactSummary(
  summary: RemoteFactSummary,
): RemoteFactSummary {
  if (summary.labels === undefined) return summary;
  let labels = summary.labels.slice(0, FACT_MAX_LABELS).map((label) =>
    clip(label, FACT_MAX_LABEL_LENGTH)
  ).filter((label) => label.length > 0);
  let bounded = { ...summary, labels };
  while (labels.length > 0 && summaryBytes(bounded) > FACT_MAX_SUMMARY_BYTES) {
    labels = labels.slice(0, -1);
    bounded = { ...summary, labels };
  }
  return bounded;
}

/** Identity of one fact inside an organization. */
export const FactKeySchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization that owns the repository resource the object was read through; every query filters on it.",
  ),
  resourceId: z.string().uuid().describe(
    "Repository resource (bakery.integration_resources) the object belongs to; the fact takes its connection and installation from this row.",
  ),
  kind: z.enum([RemoteFactKind.Issue, RemoteFactKind.CheckRun]).describe(
    "Kind of provider object: issue or check_run.",
  ),
  externalId: z.string().min(1).max(64).describe(
    "Provider id of the object as decimal text (the issue id or the check run id).",
  ),
}).strict().describe(
  "Identity of one remote fact: the organization, the repository resource, the object kind and its provider id.",
);
export type FactKey = z.output<typeof FactKeySchema>;

/** The marker that orders two observations of one object. */
export const ObservationOrderSchema = z.object({
  providerUpdatedAt: z.date().describe(
    "Time the provider says the object last changed (updated_at; for a check run completedAt, else startedAt).",
  ),
  observedStartedAt: z.date().describe(
    "Time Bakery began the read that observed the object, taken before the request was sent.",
  ),
}).strict().describe(
  "Ordering marker of one observation: provider time first, then the time the read began.",
);
export type ObservationOrder = z.output<typeof ObservationOrderSchema>;

/** One fresh provider observation, ready to store. */
export const RemoteFactSchema = z.object({
  ...FactKeySchema.shape,
  number: z.number().int().positive().nullable().describe(
    "Issue number inside its repository; null for a check run.",
  ),
  headSha: z.string().regex(FULL_SHA).nullable().describe(
    "Full lowercase commit SHA a check run ran against; null for an issue.",
  ),
  state: z.string().min(1).max(64).describe(
    "Provider state: open or closed for an issue, the check status for a check run, or gone once a read found the object missing.",
  ),
  conclusion: z.string().min(1).max(64).nullable().describe(
    "Check run conclusion (success, failure and so on); null for an issue or an unfinished run.",
  ),
  ...ObservationOrderSchema.shape,
  summary: RemoteFactSummarySchema,
}).strict().superRefine((fact, context) => {
  if (fact.kind === RemoteFactKind.Issue && fact.number === null) {
    context.addIssue({
      code: "custom",
      path: ["number"],
      message: "an issue fact needs its number",
    });
  }
  if (fact.kind === RemoteFactKind.CheckRun && fact.headSha === null) {
    context.addIssue({
      code: "custom",
      path: ["headSha"],
      message: "a check run fact needs its head SHA",
    });
  }
}).describe(
  "One fresh provider observation of an issue or a check run, with the ordering marker the store compares before writing.",
);
export type RemoteFact = z.output<typeof RemoteFactSchema>;

/** What a fact says about its object, apart from its identity and read time. */
export type FactProjection = Pick<
  RemoteFact,
  | "number"
  | "headSha"
  | "state"
  | "conclusion"
  | "providerUpdatedAt"
  | "summary"
>;

/** Outcome of an ordered write. */
export type FactWriteResult = "written" | "unchanged" | "stale";
/** `absent`: no fact is stored for the key, so there is nothing to mark. */
export type MarkGoneResult = FactWriteResult | "absent";

/**
 * Whether `incoming` orders after `stored`: a greater provider time, or an
 * equal one and a later read start. Equal markers are not newer. No stored
 * marker (never observed) is always older.
 */
export function isNewer(
  incoming: ObservationOrder,
  stored: ObservationOrder | null,
): boolean {
  if (stored === null) return true;
  const incomingProvider = incoming.providerUpdatedAt.getTime();
  const storedProvider = stored.providerUpdatedAt.getTime();
  if (incomingProvider !== storedProvider) {
    return incomingProvider > storedProvider;
  }
  return incoming.observedStartedAt.getTime() >
    stored.observedStartedAt.getTime();
}

/**
 * SHA-256 over the canonical JSON of the projection, so the same object
 * state yields the same digest whatever the key order. The provider time is
 * part of it: an object the provider touched again is a new state even when
 * its projected fields did not move, so a late older read cannot slip in
 * under a stored marker that never advanced.
 */
export async function factDigest(projection: FactProjection): Promise<string> {
  return await sha256Hex(canonicalJson({
    number: projection.number,
    headSha: projection.headSha,
    state: projection.state,
    conclusion: projection.conclusion,
    providerUpdatedAt: projection.providerUpdatedAt.toISOString(),
    summary: projection.summary,
  }));
}

/**
 * The resource row a fact may hang from: a repository that is not archived.
 * Whether it is still selected and available stays with the caller, which
 * rechecks its authority before it reads and writes.
 */
const LIVE_REPOSITORY = `resource.kind = 'repository'
  and resource.archived_at is null`;

/**
 * Stores one fresh observation when it orders after the stored one and its
 * digest differs. The insert reads its connection and installation from the
 * organization's own, non-archived repository resource row, so a key naming
 * another organization's resource, an archived one or one that is not a
 * repository inserts nothing and fails closed (RESOURCE_NOT_FOUND).
 *
 * A `stale` result means a newer observation is already stored. A fact that
 * is `gone` is replaced only by a read that began after the gone read, so a
 * read that saw a greater provider time but started earlier cannot revive a
 * deleted object. `unchanged` means the same state is stored; when that read
 * began later than the stored one, the stored read start and `observed_at`
 * move up to it while `version`, digest, state and provider time never
 * change, so an earlier-started read of another state in the same provider
 * second cannot overwrite a state a later read confirmed.
 */
export async function upsertFact(
  transaction: PgTransactionClient,
  input: RemoteFact,
): Promise<FactWriteResult> {
  const fact = RemoteFactSchema.parse(input);
  const digest = await factDigest(fact);
  const written = await transaction.query<{ version: number }>(
    `insert into bakery.integration_remote_facts as fact (
       id, organization_id, connection_id, installation_id, resource_id, kind,
       external_id, number, head_sha, state, conclusion, provider_updated_at,
       observed_started_at, observed_at, digest, summary, version
     )
     select $1::uuid, resource.organization_id, resource.connection_id,
       resource.installation_id, resource.id, $4::text, $5::text, $6::integer,
       $7::text, $8::text, $9::text, $10::timestamptz, $11::timestamptz,
       now(), $12::text, $13::jsonb, 1
       from bakery.integration_resources as resource
      where resource.organization_id = $2::uuid and resource.id = $3::uuid
        and ${LIVE_REPOSITORY}
     on conflict (resource_id, kind, external_id) do update
       set number = excluded.number, head_sha = excluded.head_sha,
           state = excluded.state, conclusion = excluded.conclusion,
           provider_updated_at = excluded.provider_updated_at,
           observed_started_at = excluded.observed_started_at,
           observed_at = excluded.observed_at, digest = excluded.digest,
           summary = excluded.summary, version = fact.version + 1
       where fact.organization_id = excluded.organization_id
         and (fact.provider_updated_at, fact.observed_started_at)
           < (excluded.provider_updated_at, excluded.observed_started_at)
         and fact.digest <> excluded.digest
         and (fact.state <> $14::text
           or fact.observed_started_at < excluded.observed_started_at)
     returning version`,
    [
      crypto.randomUUID(),
      fact.organizationId,
      fact.resourceId,
      fact.kind,
      fact.externalId,
      fact.number,
      fact.headSha,
      fact.state,
      fact.conclusion,
      fact.providerUpdatedAt,
      fact.observedStartedAt,
      digest,
      JSON.stringify(fact.summary),
      GONE_STATE,
    ],
  );
  if (written.rowCount === 1) return "written";
  // Nothing was written: the same state is stored, or a newer one is. A read
  // of the stored state that began later confirms it, so the stored read
  // start moves up; the row is otherwise left as it is.
  const confirmed = await transaction.query(
    `update bakery.integration_remote_facts as fact
        set observed_started_at = $5::timestamptz, observed_at = now()
       from bakery.integration_resources as resource
      where fact.organization_id = $1::uuid and fact.resource_id = $2::uuid
        and fact.kind = $3::text and fact.external_id = $4::text
        and fact.digest = $6::text
        and fact.observed_started_at < $5::timestamptz
        and resource.organization_id = fact.organization_id
        and resource.id = fact.resource_id and ${LIVE_REPOSITORY}
      returning fact.id`,
    [
      fact.organizationId,
      fact.resourceId,
      fact.kind,
      fact.externalId,
      fact.observedStartedAt,
      digest,
    ],
  );
  if (confirmed.rowCount === 1) return "unchanged";
  const stored = await transaction.query<{ digest: string }>(
    `select fact.digest from bakery.integration_remote_facts as fact
       join bakery.integration_resources as resource
         on resource.organization_id = fact.organization_id
        and resource.id = fact.resource_id
      where fact.organization_id = $1::uuid and fact.resource_id = $2::uuid
        and fact.kind = $3::text and fact.external_id = $4::text
        and ${LIVE_REPOSITORY}`,
    [fact.organizationId, fact.resourceId, fact.kind, fact.externalId],
  );
  const row = stored.rows[0];
  // No live repository resource of this organization, or no stored fact.
  if (row === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return row.digest === digest ? "unchanged" : "stale";
}

type StoredFactRow = FactProjection & {
  id: string;
  observedStartedAt: Date;
  digest: string;
  version: number;
};

/**
 * Records that a fresh read found the object gone (404, 410, or a path that
 * moved while its repository stayed). Only `state` changes: the provider time
 * and the last projection stay, so the gone read orders by the time it began.
 * A fact that was never stored is `absent`, not invented, and a gone read
 * that began before the stored observation is `stale`. A repeated gone read
 * is `unchanged`; when it began later than the stored read, the stored read
 * start and `observed_at` move up to it (never `version`, digest, state or
 * provider time), so an earlier-started read of a greater provider time
 * cannot revive an object a later read confirmed gone.
 */
export async function markGone(
  transaction: PgTransactionClient,
  key: FactKey,
  observedStartedAt: Date,
): Promise<MarkGoneResult> {
  const identity = FactKeySchema.parse(key);
  const startedAt = ObservationOrderSchema.shape.observedStartedAt.parse(
    observedStartedAt,
  );
  const found = await transaction.query<StoredFactRow>(
    `select id, number, head_sha as "headSha", state, conclusion,
       provider_updated_at as "providerUpdatedAt",
       observed_started_at as "observedStartedAt", digest, summary, version
       from bakery.integration_remote_facts
      where organization_id = $1 and resource_id = $2 and kind = $3
        and external_id = $4
      for update`,
    [
      identity.organizationId,
      identity.resourceId,
      identity.kind,
      identity.externalId,
    ],
  );
  const stored = found.rows[0];
  if (stored === undefined) return "absent";
  const digest = await factDigest({ ...stored, state: GONE_STATE });
  if (digest === stored.digest) {
    // Already gone. The row is locked by the select above, so this update
    // cannot race another writer; a later read only moves the read clock.
    if (startedAt.getTime() > stored.observedStartedAt.getTime()) {
      await transaction.query(
        `update bakery.integration_remote_facts
            set observed_started_at = $4::timestamptz, observed_at = now()
          where organization_id = $1 and id = $2 and version = $3
            and observed_started_at < $4::timestamptz`,
        [identity.organizationId, stored.id, stored.version, startedAt],
      );
    }
    return "unchanged";
  }
  const incoming = {
    providerUpdatedAt: stored.providerUpdatedAt,
    observedStartedAt: startedAt,
  };
  if (!isNewer(incoming, stored)) return "stale";
  const updated = await transaction.query<{ version: number }>(
    `update bakery.integration_remote_facts
        set state = $4, digest = $5, observed_started_at = $6,
            observed_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and version = $3
        and observed_started_at < $6
      returning version`,
    [
      identity.organizationId,
      stored.id,
      stored.version,
      GONE_STATE,
      digest,
      startedAt,
    ],
  );
  return updated.rowCount === 1 ? "written" : "stale";
}
