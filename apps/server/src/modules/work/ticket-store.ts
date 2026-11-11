import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import {
  isTicketRequestDisposition,
  isTicketRequestIntent,
  isTicketRequestOrigin,
  type TicketAuthorityEvidence,
  TicketAuthorityEvidenceSchema,
  type TicketPresetPin,
  TicketPresetPinSchema,
  type TicketReadinessReport,
  TicketReadinessReportSchema,
  type TicketRequestDisposition,
  type TicketRequestIntent,
  type TicketRequestOrigin,
  type TicketSnapshot,
  type TicketSourcePolicy,
  type TicketStoredReport,
  TicketStoredReportSchema,
} from "@bakery/contracts/ticket-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  parseOffsetInstant,
  parseTicketSourcePolicy,
} from "./ticket-policy.ts";
import type { TicketSourceHandle } from "./ticket-source-reader.ts";
import { canTransition } from "./ticket-request-state.ts";
import { PLAN_STAGE } from "./stage-policy.ts";

/**
 * SQL for the ticket tables: sources, tickets, links, requests and readiness
 * reports. No function here decides anything: admission and recheck own the
 * rules and call these inside one transaction. The lock order every ticket
 * writer follows is source (share), ticket (update), application (update),
 * then task; `lockSource` and `lockTicket` are the first two steps of it.
 * Reports are select and insert only (the table grants nothing else), so a
 * report is never read `for update`.
 */

const REQUEST_ONE_NONTERMINAL_INDEX = "ticket_requests_one_nonterminal_idx";

/**
 * The one shape of the instants the poll keeps in `sync_checkpoint` for its
 * own waiting and ordering: what `Date.prototype.toISOString` writes. Text of
 * this shape sorts as time does, which the poll list relies on in SQL (a
 * regular expression both JavaScript and PostgreSQL read). A stored `notBefore`
 * of any other shape is corrupt: the checkpoint reads as empty (the position
 * is lost, the source is polled and the next write repairs it). A stored
 * `attemptedAt` of any other shape is only restamped by the next write; the
 * list orders it as never attempted and the position stays.
 */
export const SYNC_INSTANT_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$";
const SYNC_INSTANT = new RegExp(SYNC_INSTANT_PATTERN);

/**
 * Where the poll of one source stands, kept in `sync_checkpoint`. Only the
 * poll writes it; a value that does not parse is read as empty, so a bad
 * write costs one step of repeated work and never blocks the source.
 */
export const TicketSyncCheckpointSchema = z.object({
  marker: z.string().nullable().describe(
    "Provider-update instant, ISO 8601, of the last fact-index issue the poll moved past; null before the first step.",
  ),
  markerNumber: z.number().int().nullable().describe(
    "Issue number of that fact, the second half of the keyset position inside a group of issues updated at one instant; null with no marker.",
  ),
  cursor: z.number().int().nullable().describe(
    "Issue number of the last request or waiting ticket the rotation reached; the next step continues after it and wraps; null before the first rotation.",
  ),
  notBefore: z.string().regex(SYNC_INSTANT).nullable().describe(
    "ISO 8601 instant before which the source is not polled, set from a provider rate limit; null when none applies.",
  ),
  attemptedAt: z.string().nullable().default(null).catch(null).describe(
    "ISO 8601 instant of the last step that ran for the source, whether it reached its end or stopped on a rate limit or lost authority; the poll lists the least recently attempted source first. Null before the first step. Stored text of another shape is kept and restamped by the next write; a value that is not text reads as null.",
  ),
  failure: z.object({
    number: z.number().int().describe("Issue number that failed."),
    code: z.string().min(1).max(200).describe(
      "Problem code of the failure, a fixed code and never provider text.",
    ),
    count: z.number().int().min(1).describe(
      "Consecutive steps that failed on this number with this code.",
    ),
  }).strict().nullable().describe(
    "The fact-index issue the checkpoint is held behind and how often it failed in a row; null when none.",
  ),
}).strict().describe(
  "Progress of the ticket poll of one source: the fact-index keyset position, the rotation cursor, a rate-limit not-before instant, the last attempt instant and the failure the position is held behind.",
);
export type TicketSyncCheckpoint = z.output<typeof TicketSyncCheckpointSchema>;

export const EMPTY_SYNC_CHECKPOINT: TicketSyncCheckpoint = Object.freeze({
  marker: null,
  markerNumber: null,
  cursor: null,
  notBefore: null,
  attemptedAt: null,
  failure: null,
});

/** The stored checkpoint, or the empty one when the value is missing or invalid. */
export function readSyncCheckpoint(value: unknown): TicketSyncCheckpoint {
  const parsed = TicketSyncCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_SYNC_CHECKPOINT;
}

/** What `ticket_sources.sync_health` holds. */
export type TicketSyncHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "auth_required";

/** A ticket source with its stored policy parsed. */
export type TicketSource = {
  id: string;
  organizationId: string;
  connectionId: string;
  resourceId: string;
  applicationId: string;
  repositoryId: string | null;
  externalContainerId: string;
  enabled: boolean;
  policy: TicketSourcePolicy;
  policyRevision: number;
  version: number;
  syncCheckpoint: TicketSyncCheckpoint;
  syncHealth: TicketSyncHealth;
  lastProblemCode: string | null;
};

type TicketSourceRow = {
  id: string;
  organization_id: string;
  integration_connection_id: string;
  integration_resource_id: string;
  application_id: string;
  repository_id: string | null;
  external_container_id: string;
  enabled: boolean;
  policy: unknown;
  policy_revision: number;
  version: number;
  sync_checkpoint: unknown;
  sync_health: TicketSyncHealth;
  last_problem_code: string | null;
};

const SOURCE_COLUMNS = `id, organization_id, integration_connection_id,
  integration_resource_id, application_id, repository_id,
  external_container_id, enabled, policy, policy_revision, version,
  sync_checkpoint, sync_health, last_problem_code`;

function toSource(row: TicketSourceRow): TicketSource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.integration_connection_id,
    resourceId: row.integration_resource_id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    externalContainerId: row.external_container_id,
    enabled: row.enabled,
    policy: parseTicketSourcePolicy(row.policy),
    policyRevision: row.policy_revision,
    version: row.version,
    syncCheckpoint: readSyncCheckpoint(row.sync_checkpoint),
    syncHealth: row.sync_health,
    lastProblemCode: row.last_problem_code,
  };
}

/**
 * Locks one source `for share`, which pins its `policy_revision`, policy and
 * delegation until the transaction ends: a policy update waits for the share
 * lock and an admission that starts after a queued update reads the new
 * revision, so an admission never mixes the two.
 */
export async function lockSource(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<TicketSource> {
  const result = await transaction.query<TicketSourceRow>(
    `select ${SOURCE_COLUMNS} from bakery.ticket_sources
      where organization_id = $1 and id = $2
      for share`,
    [organizationId, sourceId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toSource(row);
}

/**
 * Locks one source `for update`. A sync that writes the source row takes it,
 * never `for share` first: two writers that each held a share lock would
 * each wait at the update for the other's to clear, and deadlock. The sync
 * inside the caller's one registry transaction takes it first, before any
 * ticket, and the admissions inside re-take their `for share` on a row it
 * already holds stronger; so does a source preview, the only other operation
 * that records several tickets in one transaction. The poll's write
 * transaction takes it as its only lock, to merge with what another run wrote
 * since its read.
 */
export async function lockSourceForUpdate(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<TicketSource> {
  const result = await transaction.query<TicketSourceRow>(
    `select ${SOURCE_COLUMNS} from bakery.ticket_sources
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, sourceId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toSource(row);
}

/**
 * Records one poll step on the source row: the checkpoint, the health, the
 * problem code and, when the step reached its end, `last_synced_at`. It
 * writes these columns and no other: `version`, `policy_revision` and
 * `updated_at` stay as they were, so an admin's `If-Match` update is not
 * refused because a poll ran.
 */
export async function writeSyncProgress(
  transaction: PgTransactionClient,
  progress: {
    organizationId: string;
    sourceId: string;
    checkpoint: TicketSyncCheckpoint;
    health: TicketSyncHealth;
    problemCode: string | null;
    synced: boolean;
  },
): Promise<void> {
  const result = await transaction.query(
    `update bakery.ticket_sources
        set sync_checkpoint = $3::jsonb, sync_health = $4,
            last_problem_code = $5,
            last_synced_at = case when $6::boolean then now()
                                  else last_synced_at end
      where organization_id = $1 and id = $2`,
    [
      progress.organizationId,
      progress.sourceId,
      JSON.stringify(TicketSyncCheckpointSchema.parse(progress.checkpoint)),
      progress.health,
      progress.problemCode,
      progress.synced,
    ],
  );
  if (result.rowCount !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/**
 * Records a poll step that ended in a refusal before it wrote anything: a fresh
 * `attemptedAt` in `sync_checkpoint` and the refusal's problem code in
 * `last_problem_code`. It is a raw minimal write on purpose. The refusal may be
 * that the stored policy no longer parses, so it loads no `TicketSource` and
 * parses nothing, and it needs no lock beyond the row it updates: the
 * statement merges the stamp into whatever checkpoint is stored when it gets
 * the row. A checkpoint that is not an object is replaced by the empty one
 * (the poll reads it as empty anyway). A source stored as `auth_required`
 * keeps its problem code, because lost authority needs a person, as in
 * `recordStepDefect`. `sync_health`, `last_synced_at`, `version`,
 * `policy_revision` and `updated_at` stay as they were. Returns whether the
 * row exists.
 */
export async function writeRefusedAttempt(
  transaction: PgTransactionClient,
  refusal: {
    organizationId: string;
    sourceId: string;
    problemCode: string;
    attemptedAt: Date;
  },
): Promise<boolean> {
  const result = await transaction.query(
    `update bakery.ticket_sources
        set sync_checkpoint = jsonb_set(
              case when jsonb_typeof(sync_checkpoint) = 'object'
                   then sync_checkpoint else $5::jsonb end,
              '{attemptedAt}', to_jsonb($3::text)),
            last_problem_code = case when sync_health = 'auth_required'
                                     then last_problem_code else $4::text end
      where organization_id = $1 and id = $2`,
    [
      refusal.organizationId,
      refusal.sourceId,
      refusal.attemptedAt.toISOString(),
      refusal.problemCode,
      JSON.stringify(EMPTY_SYNC_CHECKPOINT),
    ],
  );
  return result.rowCount === 1;
}

/** The provider rows a source reads through, as the database holds them now. */
export type TicketSourceScope = {
  installationId: string;
  handle: TicketSourceHandle;
};

/**
 * The connection's installation and the repository resource of a source, read
 * without locks. `lockAuthority` takes the share locks afterwards and the
 * verdict over the locked rows is the authority; this only names them.
 */
export async function readSourceScope(
  transaction: PgTransactionClient,
  source: Pick<
    TicketSource,
    "id" | "organizationId" | "connectionId" | "resourceId"
  >,
): Promise<TicketSourceScope> {
  const result = await transaction.query<{
    installation_id: string;
    external_id: string;
    display_name: string;
  }>(
    `select connection.installation_id, resource.external_id,
            resource.display_name
       from bakery.integration_connections as connection
       join bakery.integration_resources as resource
         on resource.connection_id = connection.id
      where connection.organization_id = $1 and connection.id = $2
        and resource.id = $3`,
    [source.organizationId, source.connectionId, source.resourceId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    installationId: row.installation_id,
    handle: {
      organizationId: source.organizationId,
      connectionId: source.connectionId,
      resourceId: source.resourceId,
      repositoryFullName: row.display_name,
      externalRepositoryId: row.external_id,
    },
  };
}

/** The source and its reader handle without a lock, for a prefetch outside any transaction. */
export async function readSourceHandle(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<{ source: TicketSource; handle: TicketSourceHandle }> {
  const result = await transaction.query<TicketSourceRow>(
    `select ${SOURCE_COLUMNS} from bakery.ticket_sources
      where organization_id = $1 and id = $2`,
    [organizationId, sourceId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const source = toSource(row);
  const scope = await readSourceScope(transaction, source);
  return { source, handle: scope.handle };
}

/** One external ticket row. */
export type TicketRow = {
  id: string;
  organizationId: string;
  sourceId: string;
  externalTicketId: string;
  key: string;
  number: string | null;
  snapshot: TicketSnapshot;
  requirementsDigest: string;
  providerUpdateMarker: string;
  state: string;
  version: number;
};

type TicketRowRaw = {
  id: string;
  organization_id: string;
  ticket_source_id: string;
  external_ticket_id: string;
  key: string;
  number: string | null;
  snapshot: TicketSnapshot;
  requirements_digest: string;
  provider_update_marker: string;
  state: string;
  version: number;
};

const TICKET_COLUMNS = `id, organization_id, ticket_source_id,
  external_ticket_id, key, number, snapshot, requirements_digest,
  provider_update_marker, state, version`;

function toTicket(row: TicketRowRaw): TicketRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sourceId: row.ticket_source_id,
    externalTicketId: row.external_ticket_id,
    key: row.key,
    number: row.number,
    snapshot: row.snapshot,
    requirementsDigest: row.requirements_digest,
    providerUpdateMarker: row.provider_update_marker,
    state: row.state,
    version: row.version,
  };
}

/** Everything `upsertExternalTicket` stores about one observed issue. */
export type TicketObservation = {
  organizationId: string;
  sourceId: string;
  /** GitHub issue id (the immutable database id); the dedupe identity. */
  externalTicketId: string;
  number: number;
  snapshot: TicketSnapshot;
  requirementsDigest: string;
  /** Provider `updated_at`, an ISO 8601 timestamp with offset. */
  providerUpdateMarker: string;
  visibility: "public" | "private";
};

export type TicketUpsertResult = {
  result: "written" | "unchanged" | "stale";
  ticket: TicketRow;
};

async function snapshotDigest(snapshot: TicketSnapshot): Promise<string> {
  return await sha256Hex(canonicalJson(snapshot));
}

/**
 * Inserts the observed issue, or locks the stored row `for update` and writes
 * only when the observation orders after the stored one. The row is always
 * locked when this returns, so the caller holds the ticket lock.
 *
 * - `written`: a first sight, or a newer provider marker, or the same marker
 *   with a different snapshot (labels can change without the marker moving).
 * - `unchanged`: the same marker and the same snapshot.
 * - `stale`: the stored marker is newer; nothing is written and the caller
 *   must not act on this older read.
 *
 * A read whose links failed (`links` null) keeps the stored links rather than
 * erasing them: absence is never inferred. The update is guarded by the
 * version it read, so a write that lost a race touches nothing.
 */
export async function upsertExternalTicket(
  transaction: PgTransactionClient,
  observation: TicketObservation,
): Promise<TicketUpsertResult> {
  const incoming = parseOffsetInstant(observation.providerUpdateMarker);
  if (incoming === null) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["providerUpdatedAt"],
          code: "ticket_provider_marker_invalid",
          message: "ticket provider marker invalid",
        }],
      },
    });
  }
  const repositoryFullName = observation.snapshot.repositoryFullName;
  const identity = [
    `${repositoryFullName}#${observation.number}`,
    String(observation.number),
    `https://github.com/${repositoryFullName}/issues/${observation.number}`,
  ] as const;
  const inserted = await transaction.query<TicketRowRaw>(
    `insert into bakery.external_tickets (
       id, organization_id, ticket_source_id, external_ticket_id, key, number,
       safe_url, snapshot, requirements_digest, provider_update_marker,
       visibility, state, last_observed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, now())
     on conflict (organization_id, ticket_source_id, external_ticket_id)
     do nothing
     returning ${TICKET_COLUMNS}`,
    [
      crypto.randomUUID(),
      observation.organizationId,
      observation.sourceId,
      observation.externalTicketId,
      ...identity,
      JSON.stringify(observation.snapshot),
      observation.requirementsDigest,
      observation.providerUpdateMarker,
      observation.visibility,
      observation.snapshot.state,
    ],
  );
  if (inserted.rows[0]) {
    return { result: "written", ticket: toTicket(inserted.rows[0]) };
  }
  const locked = await transaction.query<TicketRowRaw>(
    `select ${TICKET_COLUMNS} from bakery.external_tickets
      where organization_id = $1 and ticket_source_id = $2
        and external_ticket_id = $3
      for update`,
    [
      observation.organizationId,
      observation.sourceId,
      observation.externalTicketId,
    ],
  );
  const stored = locked.rows[0];
  if (!stored) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const storedMarker = parseOffsetInstant(stored.provider_update_marker);
  if (storedMarker !== null && incoming < storedMarker) {
    return { result: "stale", ticket: toTicket(stored) };
  }
  const merged: TicketSnapshot = {
    ...observation.snapshot,
    links: observation.snapshot.links ?? stored.snapshot.links,
  };
  const sameMarker = storedMarker !== null && incoming === storedMarker;
  if (
    sameMarker &&
    await snapshotDigest(merged) === await snapshotDigest(stored.snapshot)
  ) {
    return { result: "unchanged", ticket: toTicket(stored) };
  }
  const updated = await transaction.query<TicketRowRaw>(
    `update bakery.external_tickets
        set key = $4, number = $5, safe_url = $6, snapshot = $7::jsonb,
            requirements_digest = $8, provider_update_marker = $9,
            visibility = $10, state = $11, last_observed_at = now(),
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and version = $3
      returning ${TICKET_COLUMNS}`,
    [
      stored.organization_id,
      stored.id,
      stored.version,
      ...identity,
      JSON.stringify(merged),
      observation.requirementsDigest,
      observation.providerUpdateMarker,
      observation.visibility,
      merged.state,
    ],
  );
  if (!updated.rows[0]) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_changed" },
    });
  }
  return { result: "written", ticket: toTicket(updated.rows[0]) };
}

/**
 * The ticket a number names inside one source, locked `for update`, or null.
 * Used when the provider answer carries no issue id (the issue is gone, moved
 * or a pull request), so the row is found by its number; the newest
 * observation wins if a transferred issue left two.
 */
export async function lockTicketByNumber(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
  number: number,
): Promise<TicketRow | null> {
  const result = await transaction.query<TicketRowRaw>(
    `select ${TICKET_COLUMNS} from bakery.external_tickets
      where organization_id = $1 and ticket_source_id = $2 and number = $3
      order by last_observed_at desc, id
      limit 1
      for update`,
    [organizationId, sourceId, String(number)],
  );
  return result.rows[0] ? toTicket(result.rows[0]) : null;
}

/** Locks one ticket row `for update`. */
export async function lockTicket(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
): Promise<TicketRow> {
  const result = await transaction.query<TicketRowRaw>(
    `select ${TICKET_COLUMNS} from bakery.external_tickets
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, ticketId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toTicket(row);
}

/**
 * A ticket's source and number, read without a lock. `ticket_source_id` never
 * changes, so a caller that holds a ticket id can name the source to lock
 * first, then lock the ticket and read it again under its lock.
 */
export async function readTicketRef(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
): Promise<{ sourceId: string; number: number | null }> {
  const result = await transaction.query<
    { ticket_source_id: string; number: string | null }
  >(
    `select ticket_source_id, number from bakery.external_tickets
      where organization_id = $1 and id = $2`,
    [organizationId, ticketId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const number = row.number === null ? null : Number(row.number);
  return {
    sourceId: row.ticket_source_id,
    number: number !== null && Number.isSafeInteger(number) ? number : null,
  };
}

/**
 * The ticket a number names inside one source and the nonterminal request it
 * owns, read without a lock: the poll's dispatch decision, which `admitTicket`
 * and `recheckTicket` confirm under their locks. A ticket that owns a request
 * wins over a newer one with the same number (a transferred issue).
 */
export async function findTicketForNumber(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
  number: number,
): Promise<{ ticketId: string; requestId: string | null } | null> {
  const result = await transaction.query<
    { ticket_id: string; request_id: string | null }
  >(
    `select ticket.id as ticket_id, request.id as request_id
       from bakery.external_tickets as ticket
       left join bakery.ticket_requests as request
         on request.organization_id = ticket.organization_id
        and request.external_ticket_id = ticket.id
        and request.disposition in ('waiting', 'admitted', 'active', 'suspended')
      where ticket.organization_id = $1 and ticket.ticket_source_id = $2
        and ticket.number = $3
      order by (request.id is not null) desc, ticket.last_observed_at desc,
               ticket.id
      limit 1`,
    [organizationId, sourceId, String(number)],
  );
  const row = result.rows[0];
  return row ? { ticketId: row.ticket_id, requestId: row.request_id } : null;
}

/**
 * Issue numbers of a source the poll must look at again whatever the fact
 * index says: tickets with a nonterminal request, and tickets whose newest
 * report is `waiting` while their snapshot still carries a request label and
 * no hold label (a merged blocker admits them). Ordered by number starting
 * after `after` and wrapping, so a limit that cuts the list resumes where it
 * stopped on the next step. `exclude` names numbers already chosen.
 */
export async function listRotationNumbers(
  transaction: PgTransactionClient,
  request: {
    organizationId: string;
    sourceId: string;
    requestLabels: readonly string[];
    holdLabel: string;
    after: number | null;
    exclude: readonly number[];
    limit: number;
  },
): Promise<number[]> {
  const result = await transaction.query<{ number: number }>(
    `select ticket.number::int as number
       from bakery.external_tickets as ticket
      where ticket.organization_id = $1 and ticket.ticket_source_id = $2
        and ticket.number is not null
        and ticket.number::int <> all($5::int[])
        and (
          exists (
            select 1 from bakery.ticket_requests as request
             where request.organization_id = ticket.organization_id
               and request.external_ticket_id = ticket.id
               and request.disposition
                 in ('waiting', 'admitted', 'active', 'suspended'))
          or (
            (select report.verdict from bakery.ticket_readiness_reports as report
              where report.organization_id = ticket.organization_id
                and report.external_ticket_id = ticket.id
              order by report.version desc limit 1) = 'waiting'
            and jsonb_exists_any(ticket.snapshot -> 'labels', $3::text[])
            and not jsonb_exists(ticket.snapshot -> 'labels', $4)))
      group by ticket.number::int
      order by (ticket.number::int <= $6::int), ticket.number::int
      limit $7`,
    [
      request.organizationId,
      request.sourceId,
      [...request.requestLabels],
      request.holdLabel,
      [...request.exclude],
      request.after ?? -1,
      request.limit,
    ],
  );
  return result.rows.map((row) => row.number);
}

/** A readiness report row as stored. */
type ReportRowRaw = {
  id: string;
  external_ticket_id: string;
  version: number;
  verdict: string;
  basis_digest: string;
  requirements_digest: string | null;
  dependency_digest: string | null;
  source_policy_revision: number;
  preset: unknown;
  checks: unknown;
  origin: string;
  evaluated_at: Date;
};

const REPORT_COLUMNS = `id, external_ticket_id, version, verdict, basis_digest,
  requirements_digest, dependency_digest, source_policy_revision, preset,
  checks, origin, evaluated_at`;

function toStoredReport(row: ReportRowRaw): TicketStoredReport {
  return TicketStoredReportSchema.parse({
    id: row.id,
    externalTicketId: row.external_ticket_id,
    sequence: row.version,
    report: {
      version: 1,
      verdict: row.verdict,
      checks: row.checks,
      requirementsDigest: row.requirements_digest,
      dependencyDigest: row.dependency_digest,
      basisDigest: row.basis_digest,
      sourcePolicyRevision: row.source_policy_revision,
      preset: row.preset,
    },
    origin: row.origin,
    evaluatedAt: row.evaluated_at.toISOString(),
  });
}

/** The newest stored report of a ticket, or null. A plain select: reports take no row lock. */
export async function latestReport(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
): Promise<TicketStoredReport | null> {
  const result = await transaction.query<ReportRowRaw>(
    `select ${REPORT_COLUMNS} from bakery.ticket_readiness_reports
      where organization_id = $1 and external_ticket_id = $2
      order by version desc
      limit 1`,
    [organizationId, ticketId],
  );
  return result.rows[0] ? toStoredReport(result.rows[0]) : null;
}

/** One report by id, or null. A plain select. */
export async function reportById(
  transaction: PgTransactionClient,
  organizationId: string,
  reportId: string,
): Promise<TicketStoredReport | null> {
  const result = await transaction.query<ReportRowRaw>(
    `select ${REPORT_COLUMNS} from bakery.ticket_readiness_reports
      where organization_id = $1 and id = $2`,
    [organizationId, reportId],
  );
  return result.rows[0] ? toStoredReport(result.rows[0]) : null;
}

/**
 * Stores `report` as the next report of the ticket when its basis digest
 * differs from the newest stored one, else returns the newest. The caller
 * already holds the ticket row lock, which serializes the compare and the
 * insert; the unique `(external_ticket_id, version)` is the floor under it.
 */
export async function appendReportIfChanged(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
  report: TicketReadinessReport,
  origin: TicketRequestOrigin,
): Promise<{ stored: TicketStoredReport; appended: boolean }> {
  const parsed = TicketReadinessReportSchema.parse(report);
  const latest = await latestReport(transaction, organizationId, ticketId);
  if (latest !== null && latest.report.basisDigest === parsed.basisDigest) {
    return { stored: latest, appended: false };
  }
  const inserted = await transaction.query<ReportRowRaw>(
    `insert into bakery.ticket_readiness_reports (
       id, organization_id, external_ticket_id, version, verdict, basis_digest,
       requirements_digest, dependency_digest, source_policy_revision, preset,
       checks, origin, evaluated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, now())
     returning ${REPORT_COLUMNS}`,
    [
      crypto.randomUUID(),
      organizationId,
      ticketId,
      (latest?.sequence ?? 0) + 1,
      parsed.verdict,
      parsed.basisDigest,
      parsed.requirementsDigest,
      parsed.dependencyDigest,
      parsed.sourcePolicyRevision,
      JSON.stringify(parsed.preset),
      JSON.stringify(parsed.checks),
      origin,
    ],
  );
  return { stored: toStoredReport(inserted.rows[0]), appended: true };
}

/** One ticket request with the task its link names. */
export type TicketRequest = {
  id: string;
  organizationId: string;
  linkId: string;
  taskId: string;
  externalTicketId: string;
  intent: TicketRequestIntent;
  generation: number;
  origin: TicketRequestOrigin;
  authorityPrincipalId: string | null;
  authorityEvidence: TicketAuthorityEvidence;
  inboundEventRouteId: string | null;
  sourcePolicyRevision: number;
  requirementsDigest: string;
  readinessReportId: string | null;
  pinnedPreset: TicketPresetPin;
  disposition: TicketRequestDisposition;
  dispositionReason: string | null;
  workflowRunId: string | null;
  pauseRequestedAt: Date | null;
  version: number;
};

type RequestRowRaw = {
  id: string;
  organization_id: string;
  ticket_task_link_id: string;
  task_id: string;
  external_ticket_id: string;
  intent: string;
  generation: number;
  origin: string;
  authority_principal_id: string | null;
  authority_evidence: unknown;
  inbound_event_route_id: string | null;
  source_policy_revision: number;
  requirements_digest: string;
  readiness_report_id: string | null;
  pinned_preset: unknown;
  disposition: string;
  disposition_reason: string | null;
  workflow_run_id: string | null;
  pause_requested_at: Date | null;
  version: number;
};

const REQUEST_SELECT = `select request.id, request.organization_id,
  request.ticket_task_link_id, link.task_id, request.external_ticket_id,
  request.intent, request.generation, request.origin,
  request.authority_principal_id, request.authority_evidence,
  request.inbound_event_route_id, request.source_policy_revision,
  request.requirements_digest, request.readiness_report_id,
  request.pinned_preset, request.disposition, request.disposition_reason,
  request.workflow_run_id, request.pause_requested_at, request.version
  from bakery.ticket_requests as request
  join bakery.ticket_task_links as link
    on link.organization_id = request.organization_id
   and link.id = request.ticket_task_link_id`;

function toRequest(row: RequestRowRaw): TicketRequest {
  if (
    !isTicketRequestIntent(row.intent) || !isTicketRequestOrigin(row.origin) ||
    !isTicketRequestDisposition(row.disposition)
  ) {
    throw new Error("TICKET_REQUEST_ROW_INVALID");
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    linkId: row.ticket_task_link_id,
    taskId: row.task_id,
    externalTicketId: row.external_ticket_id,
    intent: row.intent,
    generation: row.generation,
    origin: row.origin,
    authorityPrincipalId: row.authority_principal_id,
    authorityEvidence: TicketAuthorityEvidenceSchema.parse(
      row.authority_evidence,
    ),
    inboundEventRouteId: row.inbound_event_route_id,
    sourcePolicyRevision: row.source_policy_revision,
    requirementsDigest: row.requirements_digest,
    readinessReportId: row.readiness_report_id,
    pinnedPreset: TicketPresetPinSchema.parse(row.pinned_preset),
    disposition: row.disposition,
    dispositionReason: row.disposition_reason,
    workflowRunId: row.workflow_run_id,
    pauseRequestedAt: row.pause_requested_at,
    version: row.version,
  };
}

/**
 * The one request of a ticket in `waiting`, `admitted`, `active` or
 * `suspended`, or null. A plain select: the caller holds the ticket lock, so
 * the answer cannot change under it.
 */
export async function findNonterminalRequest(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
): Promise<TicketRequest | null> {
  const result = await transaction.query<RequestRowRaw>(
    `${REQUEST_SELECT}
      where request.organization_id = $1 and request.external_ticket_id = $2
        and request.disposition in ('waiting', 'admitted', 'active', 'suspended')`,
    [organizationId, ticketId],
  );
  return result.rows[0] ? toRequest(result.rows[0]) : null;
}

/** One request by id, or null. */
export async function requestById(
  transaction: PgTransactionClient,
  organizationId: string,
  requestId: string,
): Promise<TicketRequest | null> {
  const result = await transaction.query<RequestRowRaw>(
    `${REQUEST_SELECT}
      where request.organization_id = $1 and request.id = $2`,
    [organizationId, requestId],
  );
  return result.rows[0] ? toRequest(result.rows[0]) : null;
}

/** The newest stored report of each ticket, by ticket id, in one read; a list page's projection. */
export async function latestReportsFor(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketIds: readonly string[],
): Promise<Map<string, TicketStoredReport>> {
  if (ticketIds.length === 0) return new Map();
  const result = await transaction.query<ReportRowRaw>(
    `select distinct on (external_ticket_id) ${REPORT_COLUMNS}
       from bakery.ticket_readiness_reports
      where organization_id = $1 and external_ticket_id = any($2::uuid[])
      order by external_ticket_id, version desc`,
    [organizationId, [...ticketIds]],
  );
  return new Map(
    result.rows.map((row) => [row.external_ticket_id, toStoredReport(row)]),
  );
}

/** The nonterminal request of each ticket that has one, by ticket id, in one read. */
export async function nonterminalRequestsFor(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketIds: readonly string[],
): Promise<Map<string, TicketRequest>> {
  if (ticketIds.length === 0) return new Map();
  const result = await transaction.query<RequestRowRaw>(
    `${REQUEST_SELECT}
      where request.organization_id = $1
        and request.external_ticket_id = any($2::uuid[])
        and request.disposition in ('waiting', 'admitted', 'active', 'suspended')`,
    [organizationId, [...ticketIds]],
  );
  return new Map(
    result.rows.map((row) => [row.external_ticket_id, toRequest(row)]),
  );
}

/** Next generation number of a ticket; the caller holds the ticket lock. */
export async function nextGeneration(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketId: string,
): Promise<number> {
  const result = await transaction.query<{ generation: number }>(
    `select coalesce(max(generation), 0) + 1 as generation
       from bakery.ticket_requests
      where organization_id = $1 and external_ticket_id = $2`,
    [organizationId, ticketId],
  );
  return result.rows[0].generation;
}

/** Inserts the primary link between a ticket and the task its request owns. */
export async function insertPrimaryLink(
  transaction: PgTransactionClient,
  facts: { organizationId: string; ticketId: string; taskId: string },
): Promise<string> {
  const linkId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.ticket_task_links (
       id, organization_id, external_ticket_id, task_id, role
     ) values ($1, $2, $3, $4, 'primary')`,
    [linkId, facts.organizationId, facts.ticketId, facts.taskId],
  );
  return linkId;
}

/**
 * What `insertRequest` stores. The request starts `waiting` with no run; the id
 * is chosen by the caller so it can name it in the run's idempotency key.
 */
export type TicketRequestInsert = {
  id: string;
  organizationId: string;
  linkId: string;
  ticketId: string;
  intent: TicketRequestIntent;
  generation: number;
  origin: TicketRequestOrigin;
  authorityPrincipalId: string;
  authorityEvidence: TicketAuthorityEvidence;
  inboundEventRouteId: string | null;
  sourcePolicyRevision: number;
  requirementsDigest: string;
  readinessReportId: string;
  pinnedPreset: TicketPresetPin;
};

function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Object; depth++) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Inserts the request. It runs after the nonterminal-request check under the
 * ticket lock, so the unique index is a floor, not the mechanism. If the
 * index refuses anyway the transaction is already aborted and everything it
 * wrote (the task, the conversation, the link) must go with it: this throws
 * `STATE_CONFLICT {reason: "ticket_request_exists"}` and never returns a
 * winner after side effects.
 */
export async function insertRequest(
  transaction: PgTransactionClient,
  facts: TicketRequestInsert,
): Promise<void> {
  try {
    await transaction.query(
      `insert into bakery.ticket_requests (
         id, organization_id, ticket_task_link_id, external_ticket_id, intent,
         generation, origin, authority_principal_id, authority_evidence,
         inbound_event_route_id, source_policy_revision, requirements_digest,
         readiness_report_id, pinned_preset, disposition
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
         $14::jsonb, 'waiting')`,
      [
        facts.id,
        facts.organizationId,
        facts.linkId,
        facts.ticketId,
        facts.intent,
        facts.generation,
        facts.origin,
        facts.authorityPrincipalId,
        JSON.stringify(facts.authorityEvidence),
        facts.inboundEventRouteId,
        facts.sourcePolicyRevision,
        facts.requirementsDigest,
        facts.readinessReportId,
        JSON.stringify(facts.pinnedPreset),
      ],
    );
  } catch (error) {
    if (violatedConstraint(error) === REQUEST_ONE_NONTERMINAL_INDEX) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "ticket_request_exists" },
        cause: error,
      });
    }
    throw error;
  }
}

/** The request columns a lifecycle step may change. */
export type TicketRequestPatch = {
  intent?: TicketRequestIntent;
  sourcePolicyRevision?: number;
  requirementsDigest?: string;
  readinessReportId?: string | null;
  disposition?: TicketRequestDisposition;
  dispositionReason?: string | null;
  workflowRunId?: string | null;
  pauseRequestedAt?: "now" | null;
};

/**
 * Applies a patch to a request by the version the caller read. A move to a
 * disposition the machine does not allow throws before any write, and a
 * request that changed since it was read throws `ticket_request_changed`.
 */
export async function updateRequest(
  transaction: PgTransactionClient,
  current: TicketRequest,
  patch: TicketRequestPatch,
): Promise<TicketRequest> {
  if (
    patch.disposition !== undefined &&
    !canTransition(current.disposition, patch.disposition)
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_request_transition_illegal" },
    });
  }
  const assignments: string[] = [];
  const values: unknown[] = [
    current.organizationId,
    current.id,
    current.version,
  ];
  const set = (column: string, value: unknown, cast = "") => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };
  if (patch.intent !== undefined) set("intent", patch.intent);
  if (patch.sourcePolicyRevision !== undefined) {
    set("source_policy_revision", patch.sourcePolicyRevision);
  }
  if (patch.requirementsDigest !== undefined) {
    set("requirements_digest", patch.requirementsDigest);
  }
  if (patch.readinessReportId !== undefined) {
    set("readiness_report_id", patch.readinessReportId);
  }
  if (patch.disposition !== undefined) set("disposition", patch.disposition);
  if (patch.dispositionReason !== undefined) {
    set("disposition_reason", patch.dispositionReason);
  }
  if (patch.workflowRunId !== undefined) {
    set("workflow_run_id", patch.workflowRunId);
  }
  if (patch.pauseRequestedAt !== undefined) {
    assignments.push(
      patch.pauseRequestedAt === null
        ? "pause_requested_at = null"
        : "pause_requested_at = now()",
    );
  }
  const updated = await transaction.query<{ id: string }>(
    `update bakery.ticket_requests
        set ${
      assignments.concat(["updated_at = now()", "version = version + 1"]).join(
        ", ",
      )
    }
      where organization_id = $1 and id = $2 and version = $3
      returning id`,
    values,
  );
  if (updated.rows.length !== 1) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_request_changed" },
    });
  }
  const reread = await requestById(
    transaction,
    current.organizationId,
    current.id,
  );
  if (reread === null) throw new Error("TICKET_REQUEST_UPDATE_LOST");
  return reread;
}

/**
 * Whether the task owns an approved plan approval that no run consumed, that
 * is not revoked and has not expired. Re-pinning a request rewrites the task
 * text, so such an approval (made for the old text) would start a run against
 * the new text. Only a human may revoke an approval, so a re-pin refuses
 * instead.
 */
export async function taskHasUnconsumedApproval(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<boolean> {
  const result = await transaction.query(
    `select 1 from bakery.questions
      where organization_id = $1 and task_id = $2 and kind = 'approval'
        and subject_type = 'plan_revision' and status = 'answered'
        and decision = 'approve' and consumed_at is null
        and revoked_at is null
        and (expires_at is null or expires_at > now())
      limit 1`,
    [organizationId, taskId],
  );
  return result.rows.length > 0;
}

/** The task a request owns, locked `for update`. */
export type LockedTask = {
  id: string;
  applicationId: string;
  repositoryId: string | null;
  conversationId: string;
  version: number;
  status: string;
  currentRunId: string | null;
  planningOnly: boolean;
  approvalPolicy: unknown;
};

/**
 * Locks the task row `for update`. Call it only after the application lock:
 * HTTP `runs.create` takes the application and then the task, so a ticket
 * writer that took the task first would deadlock against it.
 */
export async function lockTaskForUpdate(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<LockedTask> {
  const result = await transaction.query<{
    id: string;
    application_id: string;
    repository_id: string | null;
    conversation_id: string;
    version: number;
    status: string;
    current_run_id: string | null;
    planning_only: boolean;
    approval_policy: unknown;
  }>(
    `select id, application_id, repository_id, conversation_id, version,
            status, current_run_id, planning_only, approval_policy
       from bakery.tasks
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    id: row.id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    conversationId: row.conversation_id,
    version: row.version,
    status: row.status,
    currentRunId: row.current_run_id,
    planningOnly: row.planning_only,
    approvalPolicy: row.approval_policy,
  };
}

/** Status of a run, or null when the run does not exist. A plain select. */
export async function runStatusOf(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<string | null> {
  const result = await transaction.query<{ status: string }>(
    `select status from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  return result.rows[0]?.status ?? null;
}

/** What a recheck reads of the task a request owns. */
export type TaskState = {
  status: string;
  currentRunId: string | null;
  approvalPolicy: unknown;
};

/**
 * The task's status, current run and stage policy, a plain select. A recheck
 * holds the application lock, so no `runs.create` can start a run under it;
 * the run it may start (`advance`) re-checks the task under its own lock.
 */
export async function readTaskState(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<TaskState> {
  const result = await transaction.query<{
    status: string;
    current_run_id: string | null;
    approval_policy: unknown;
  }>(
    `select status, current_run_id, approval_policy from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    status: row.status,
    currentRunId: row.current_run_id,
    approvalPolicy: row.approval_policy,
  };
}

/**
 * The approval that lets the task's plan stage start a run: answered with
 * `approve`, unconsumed, unrevoked, unexpired, scoped to the plan stage and the
 * task's policy digest, and bound to the digest of the task's latest approved
 * plan revision. The same match `consumeApprovalForAdmission` makes, as a plain
 * select; the run admission consumes it by compare-and-swap. Null when none.
 */
export async function findAvailableApproval(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
  policyDigest: string,
): Promise<string | null> {
  const result = await transaction.query<{ id: string }>(
    `select question.id
       from bakery.questions as question
       join (
         select id, digest from bakery.plan_revisions
          where organization_id = $1 and task_id = $2 and status = 'approved'
          order by revision desc limit 1
       ) as revision
         on question.subject_id = revision.id
        and question.subject_digest = revision.digest
      where question.organization_id = $1 and question.task_id = $2
        and question.kind = 'approval' and question.subject_type = 'plan_revision'
        and question.scope->>'stage' = $3 and question.policy_digest = $4
        and question.status = 'answered' and question.decision = 'approve'
        and question.consumed_at is null and question.revoked_at is null
        and (question.expires_at is null or question.expires_at > now())
      order by question.created_at, question.id
      limit 1`,
    [organizationId, taskId, PLAN_STAGE, policyDigest],
  );
  return result.rows[0]?.id ?? null;
}
