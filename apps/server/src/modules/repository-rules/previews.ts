import { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  type ContractInput,
  type ContractOutput,
  isUuid,
} from "@bakery/contracts/contracts";
import { RepositoryRulesImplementedAction } from "@bakery/contracts/implemented-actions";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  OrganizationRepositoryRulesSchema,
  REPOSITORY_RULE_KEYS,
  REPOSITORY_RULE_MODES,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules,
  validateRepositoryRuleOverrides,
} from "@bakery/contracts/repository-rules";
import {
  createRuleImpactClassifier,
  evaluateRuleSample,
  type OverrideSummary,
  type RuleImpact,
} from "@bakery/contracts/repository-rule-preview";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { organizationRules } from "./effective.ts";
import {
  readLatestRuleVersionRow,
  repositoryRuleVersionDigest,
} from "./postgres.ts";

/** Repositories read per statement; running totals and one page are all that is kept. */
export const PREVIEW_BATCH_SIZE = 1000;
/** Hard ceiling on repositories one preview scans (twenty batches). */
export const PREVIEW_MAX_REPOSITORIES = 20_000;
/**
 * Hard ceiling on the summarized data one preview reads (override summaries,
 * matching command ids and names), counted in UTF-16 code units of their
 * serialized text (`String.length`), not in UTF-8 bytes. Cheap shapes stay far
 * below it; it exists so heavy profiles cannot turn a scan into a memory hog.
 */
export const PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
/**
 * Transaction-local timeout applied to EACH statement; a whole scan is bounded
 * by the request deadline (10 s), not by this value alone.
 */
export const PREVIEW_STATEMENT_TIMEOUT = "5s";
/** Previews that may scan at once per organization, per principal and per process. */
export const PREVIEW_MAX_PER_ORGANIZATION = 1;
export const PREVIEW_MAX_PER_PRINCIPAL = 1;
export const PREVIEW_MAX_GLOBAL = 2;
/** Body hint only: the problem has `retryAfterSeconds`, there is no Retry-After header. */
const PREVIEW_RETRY_AFTER_SECONDS = 2;
/** Distinct override shapes whose classification is memoized in one preview. */
export const PREVIEW_MEMO_LIMIT = 5000;
const DEFAULT_PAGE_SIZE = 25;
/** The ordinal cursor kind, with a constant position, keyset-orders by id. */
const PREVIEW_ORDERING = "position:asc,iteration:asc,id:asc";
const PREVIEW_ACTION =
  RepositoryRulesImplementedAction.RepositoryRulePreviewsCreateForOrganization;
/** Postgres SQLSTATE query_canceled, raised by statement_timeout. */
const QUERY_CANCELED = "57014";

const activeByOrganization = new Map<string, number>();
const activeByPrincipal = new Map<string, number>();
let activeGlobal = 0;

function leave(counts: Map<string, number>, key: string): void {
  const left = (counts.get(key) ?? 1) - 1;
  if (left <= 0) counts.delete(key);
  else counts.set(key, left);
}

/**
 * In-process admission for organization scans, so neither one organization
 * nor one person administering several can hold the server's small
 * connection pool. Returns the release function; refuses with a typed,
 * retryable 503 while the organization, the principal or the process is at
 * its limit. The state is per server process, not per cluster.
 */
export function acquirePreviewSlot(
  organizationId: string,
  principalId: string,
): () => void {
  if (
    (activeByOrganization.get(organizationId) ?? 0) >=
      PREVIEW_MAX_PER_ORGANIZATION ||
    (activeByPrincipal.get(principalId) ?? 0) >= PREVIEW_MAX_PER_PRINCIPAL ||
    activeGlobal >= PREVIEW_MAX_GLOBAL
  ) {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { retryAfterSeconds: PREVIEW_RETRY_AFTER_SECONDS },
    });
  }
  activeByOrganization.set(
    organizationId,
    (activeByOrganization.get(organizationId) ?? 0) + 1,
  );
  activeByPrincipal.set(
    principalId,
    (activeByPrincipal.get(principalId) ?? 0) + 1,
  );
  activeGlobal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGlobal--;
    leave(activeByOrganization, organizationId);
    leave(activeByPrincipal, principalId);
  };
}

/** Bounds the rest of the transaction's statements in time. */
export async function applyPreviewStatementTimeout(
  transaction: PgTransactionClient,
): Promise<void> {
  await transaction.query(
    "select set_config('statement_timeout', $1, true)",
    [PREVIEW_STATEMENT_TIMEOUT],
  );
}

/** Turns a cancelled (timed out) statement into a typed timeout, never a raw 500. */
export function mapPreviewDatabaseError(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    postgresErrorCode(error) === QUERY_CANCELED ||
    postgresErrorCode(cause) === QUERY_CANCELED
  ) {
    return new StandardError({ code: "DEPENDENCY_TIMEOUT", cause: error });
  }
  return error;
}

export type ScanRow = {
  id: string;
  application_id: string;
  name: string;
  summaries: unknown;
  command_ids: unknown;
};

/** Serialized size of the data one scanned row contributes to the byte budget. */
export function scanRowBytes(row: ScanRow): number {
  return row.name.length + JSON.stringify(row.summaries).length +
    JSON.stringify(row.command_ids).length;
}

const StoredSummariesSchema = z.array(
  z.object({
    k: z.enum(REPOSITORY_RULE_KEYS).describe(
      "Rule key of one stored override.",
    ),
    e: z.boolean().describe("Whether the stored override is enabled."),
    m: z.enum(REPOSITORY_RULE_MODES).describe(
      "Enforcement mode of the stored override.",
    ),
    b: z.string().nullable().describe(
      "Stored checker binding; any text, since stored data may be corrupt.",
    ),
  }).strict().describe("One projected override summary of a scanned row."),
).max(REPOSITORY_RULE_KEYS.length).describe(
  "Projected override summaries of one scanned repository, at most one per rule key.",
);

/**
 * Reads the projected override summaries of one row; anything malformed
 * counts as no overrides, so one corrupt profile cannot fail every preview.
 */
export function parseOverrideSummaries(value: unknown): OverrideSummary[] {
  const parsed = StoredSummariesSchema.safeParse(value);
  if (!parsed.success) return [];
  const keys = new Set(parsed.data.map((item) => item.k));
  if (keys.size !== parsed.data.length) return [];
  return parsed.data.map((item) => ({
    ruleKey: item.k,
    enabled: item.e,
    mode: item.m,
    checkBinding: item.b,
  }));
}

function commandIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// One statement per batch. Only what classification reads leaves the
// database: per-override rule key, enabled, mode and checker binding (at most
// five entries), and only those active-profile command ids that some binding
// could name. Neither whole configs nor option bodies are shipped.
export const SCAN_SQL = `with page as (
   select r.id, r.application_id, r.name, r.active_profile_id
     from bakery.repositories r
    where r.organization_id = $1
      and r.archived_at is null
      and ($2::uuid is null or r.id > $2::uuid)
    order by r.id
    limit $3
 )
 select page.id, page.application_id, page.name,
        ov.entries as summaries, cm.ids as command_ids
   from page
   left join bakery.repository_profiles p
     on p.organization_id = $1
    and p.repository_id = page.id
    and p.id = page.active_profile_id
   left join lateral (
     select p.config #> '{repositoryRules,entries}' as rules,
            p.config #> '{fixedPolicy,commands}' as commands
   ) x on true
   left join lateral (
     select coalesce(jsonb_agg(jsonb_build_object(
              'k', o ->> 'ruleKey',
              'e', o -> 'enabled',
              'm', o ->> 'mode',
              'b', o #> '{options,checkBinding}')), '[]'::jsonb) as entries
       from jsonb_array_elements(
         case when jsonb_typeof(x.rules) = 'array'
              then case when jsonb_array_length(x.rules) between 1 and 5
                        then x.rules
                        else '[]'::jsonb end
              else '[]'::jsonb end
       ) as o
      where jsonb_typeof(o) = 'object'
   ) ov on true
   left join lateral (
     select coalesce(jsonb_agg(c.id), '[]'::jsonb) as ids
       from (
         select e -> 'id' as id
           from jsonb_array_elements(
             case when jsonb_typeof(x.commands) = 'array'
                  then x.commands else '[]'::jsonb end
           ) as e
          where jsonb_typeof(e) = 'object'
       ) c
      where (c.id #>> '{}') = any($4::text[])
         or ov.entries @> jsonb_build_array(jsonb_build_object('b', c.id))
   ) cm on true
  order by page.id`;

/**
 * Side-effect-free impact of a draft organization rule set.
 *
 * Reads only: no lock, no audit, no domain event, no outbox, no replay row.
 * Every statement carries `organization_id = $1` bound to the authorized
 * organization. The scan streams keyset batches (at most
 * `PREVIEW_MAX_REPOSITORIES` rows and `PREVIEW_MAX_BYTES` of summarized data)
 * in one snapshot (the action declares REPEATABLE READ), under a statement
 * timeout, and admits one scan per organization.
 */
export function createOrganizationRulePreviewHandler(secret: string) {
  return async (
    context: ActionContext,
    value: ContractInput<"RepositoryRulePreviewOrganizationCreate">,
  ) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const release = acquirePreviewSlot(organizationId, principalId);
    try {
      return await previewOrganization(
        secret,
        transaction,
        organizationId,
        principalId,
        value,
      );
    } catch (error) {
      throw mapPreviewDatabaseError(error);
    } finally {
      release();
    }
  };
}

async function previewOrganization(
  secret: string,
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  value: ContractInput<"RepositoryRulePreviewOrganizationCreate">,
) {
  await applyPreviewStatementTimeout(transaction);
  const currentRow = await readLatestRuleVersionRow(
    transaction,
    organizationId,
  );
  const currentRevision = currentRow?.revision ?? 0;
  if (currentRevision !== value.expectedRevision) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const draftRevision = currentRevision + 1;
  const parsed = OrganizationRepositoryRulesSchema.safeParse({
    revision: draftRevision,
    entries: value.entries,
  });
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  const draft = parsed.data;
  const draftDigest = await repositoryRuleVersionDigest(
    draftRevision,
    draft.entries,
  );
  const classify = createRuleImpactClassifier(
    organizationRules(currentRow),
    draft,
  );
  const draftBindings = [
    ...new Set(
      draft.entries.flatMap((entry) =>
        (entry.ruleKey === "code.magicNumbers" ||
            entry.ruleKey === "code.magicStrings") &&
          entry.options.checkBinding !== null
          ? [entry.options.checkBinding]
          : []
      ),
    ),
  ];
  const binding: CursorBinding = {
    action: PREVIEW_ACTION,
    principalId,
    organizationId,
    ordering: PREVIEW_ORDERING,
    filters: draftDigest,
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, value.cursor, binding);
  const pageAfter = position?.id ?? null;
  const limit = value.limit ?? DEFAULT_PAGE_SIZE;

  const counts = {
    repositories: 0,
    inherited: 0,
    overridden: 0,
    newlyLocked: 0,
    unsupported: 0,
  };
  const items: ContractOutput<"RepositoryRulePreviewItem">[] = [];
  const memo = new Map<string, RuleImpact>();
  let bytes = 0;
  let lastId: string | null = null;
  for (;;) {
    const batch: { rows: ScanRow[] } = await transaction.query<ScanRow>(
      SCAN_SQL,
      [organizationId, lastId, PREVIEW_BATCH_SIZE, draftBindings],
    );
    for (const row of batch.rows) {
      counts.repositories++;
      if (counts.repositories > PREVIEW_MAX_REPOSITORIES) {
        throw unprocessable(["repositories"], "too_many_repositories");
      }
      bytes += scanRowBytes(row);
      if (bytes > PREVIEW_MAX_BYTES) {
        throw unprocessable(["repositories"], "preview_too_large");
      }
      const summaries = parseOverrideSummaries(row.summaries);
      const commands = commandIds(row.command_ids);
      // JSON of the tuple: collision-free whatever a stored binding contains.
      const memoKey = JSON.stringify([
        summaries.map((entry) => [
          entry.ruleKey,
          entry.enabled,
          entry.mode,
          entry.checkBinding,
        ]),
        commands,
      ]);
      let impact = memo.get(memoKey);
      if (!impact) {
        impact = classify(summaries, commands);
        if (memo.size < PREVIEW_MEMO_LIMIT) memo.set(memoKey, impact);
      }
      if (impact.status === "inherited") counts.inherited++;
      else if (impact.status === "overridden") counts.overridden++;
      else counts.newlyLocked++;
      if (impact.unsupported) counts.unsupported++;
      if (items.length <= limit && (pageAfter === null || row.id > pageAfter)) {
        items.push({
          repositoryId: row.id,
          applicationId: row.application_id,
          repositoryName: row.name,
          status: impact.status,
          unsupported: impact.unsupported,
          supersededRules: [...impact.supersededRules],
          reactivatedRules: [...impact.reactivatedRules],
        });
      }
    }
    if (batch.rows.length < PREVIEW_BATCH_SIZE) break;
    lastId = batch.rows[batch.rows.length - 1].id;
  }
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    organizationId,
    currentRevision,
    draftRevision,
    draftDigest,
    counts,
    items: page,
    nextCursor: items.length > limit && last
      ? await encodeCursor(secret, binding, {
        position: 0,
        iteration: 0,
        id: last.repositoryId,
      })
      : null,
  };
}

type RepositoryPreviewRow = {
  repository_id: string;
  profile_id: string | null;
  profile_revision: number | null;
  organization_revision: number | null;
  organization_config: { entries?: unknown } | null;
};

/**
 * Side-effect-free dry run of proposed overrides for one repository. One
 * statement reads the repository, its ACTIVE profile and the latest
 * organization baseline, so the three share a snapshot. Every table read
 * carries the explicit organization predicate; an unknown, foreign or
 * archived repository answers the same 404.
 */
export async function previewRepositoryRuleOverrides(
  context: ActionContext,
  value: ContractInput<"RepositoryRulePreviewRepositoryCreate">,
) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const repositoryId = context.params.id;
  if (!isUuid(repositoryId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query<RepositoryPreviewRow>(
    `select r.id as repository_id,
            p.id as profile_id,
            p.revision as profile_revision,
            o.revision as organization_revision,
            o.config as organization_config
       from bakery.repositories r
       left join bakery.repository_profiles p
         on p.organization_id = r.organization_id
        and p.repository_id = r.id
        and p.id = r.active_profile_id
       left join lateral (
         select v.revision, v.config
           from bakery.organization_repository_rule_versions v
          where v.organization_id = r.organization_id
          order by v.revision desc
          limit 1
       ) o on true
      where r.organization_id = $1 and r.id = $2 and r.archived_at is null`,
    [organizationId, repositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // Duplicate rule keys are refused the way profile publication refuses them.
  const overrides = RepositoryRuleOverridesSchema.safeParse(value.overrides);
  if (!overrides.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: overrides.error.issues.map((issue) => ({
          path: ["overrides", ...issue.path],
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  const organization = row.organization_revision === null
    ? null
    : organizationRules({
      revision: row.organization_revision,
      config: row.organization_config,
    });
  const base = {
    repositoryId: row.repository_id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    organizationRevision: organization?.revision ?? 0,
  };
  const validation = validateRepositoryRuleOverrides(
    organization,
    overrides.data,
  );
  if (!validation.ok) {
    return {
      ...base,
      conflicts: validation.conflicts.map((conflict) => ({ ...conflict })),
      effective: null,
      sampleResults: [],
    };
  }
  const effective = await resolveRepositoryRules(organization, overrides.data);
  return {
    ...base,
    conflicts: [],
    effective,
    sampleResults: value.sample === undefined
      ? []
      : evaluateRuleSample(effective.entries, value.sample),
  };
}
