import {
  TICKET_ROUTE_FALLBACK_ROLE,
  type TicketRouteBlockReason,
} from "@bakery/contracts/ticket-admission";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Label routing (#31): which repositories one ticket targets. A source's rules
 * map provider label keys to repositories in roles; a ticket targets the
 * union of the rules its labels match, one target per repository. With no
 * matching rule the ticket falls back to the source's own repository, as it
 * did before routing existed. A match that cannot be honoured (an archived or
 * inaccessible target, or an ambiguous role) blocks the ticket with a named
 * reason; it is never dropped from the union or routed somewhere else.
 *
 * The resolution is pure. Admission reads the rules under the source lock,
 * resolves once, lets readiness report the outcome and pins the targets of a
 * ticket it admits. A request that exists is never resolved again.
 */

/** One rule of a source with the live state of the repository it routes to. */
export type TicketRouteRule = {
  id: string;
  labelId: string;
  repositoryId: string;
  role: string;
  presetId: string;
  version: number;
  /** The repository is archived. */
  repositoryArchived: boolean;
  /** The repository still belongs to the source's application and its connection is live. */
  repositoryAccessible: boolean;
};

/** One repository a ticket is routed to. */
export type TicketRouteTarget = {
  repositoryId: string;
  role: string;
  /** The rule that routed here, or null for the fallback to the source's repository. */
  ruleId: string | null;
  ruleVersion: number | null;
  presetId: string;
};

export type TicketRouteResolution =
  | {
    kind: "routed";
    /** One per repository, ordered by role then repository id. */
    targets: TicketRouteTarget[];
    /** True when rules exist but none matched, so the source's repository was used. */
    fallback: boolean;
  }
  | {
    kind: "blocked";
    reason: TicketRouteBlockReason;
    /** Stable references to what blocked it, such as `label:backend`. */
    refs: string[];
  };

const FIXED_PRESET_ID = "fixed-coding";

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Resolves the targets of a ticket carrying `labels`. `fallbackRepositoryId`
 * is the source's own repository; null leaves an unmatched ticket with no
 * target, which repository readiness already refuses.
 */
export function resolveTicketRoutes(
  labels: readonly string[],
  rules: readonly TicketRouteRule[],
  fallbackRepositoryId: string | null,
): TicketRouteResolution {
  const carried = new Set(labels);
  const matched = rules.filter((rule) => carried.has(rule.labelId)).sort((
    left,
    right,
  ) =>
    byText(left.labelId, right.labelId) ||
    byText(left.repositoryId, right.repositoryId)
  );
  if (matched.length === 0) {
    return {
      kind: "routed",
      targets: fallbackRepositoryId === null ? [] : [{
        repositoryId: fallbackRepositoryId,
        role: TICKET_ROUTE_FALLBACK_ROLE,
        ruleId: null,
        ruleVersion: null,
        presetId: FIXED_PRESET_ID,
      }],
      fallback: rules.length > 0,
    };
  }
  const deleted = matched.filter((rule) => rule.repositoryArchived);
  if (deleted.length > 0) {
    return {
      kind: "blocked",
      reason: "route_target_deleted",
      refs: deleted.map((rule) => `label:${rule.labelId}`),
    };
  }
  const inaccessible = matched.filter((rule) => !rule.repositoryAccessible);
  if (inaccessible.length > 0) {
    return {
      kind: "blocked",
      reason: "route_target_inaccessible",
      refs: inaccessible.map((rule) => `label:${rule.labelId}`),
    };
  }
  const byRepository = new Map<string, TicketRouteRule[]>();
  const byRole = new Map<string, Set<string>>();
  for (const rule of matched) {
    byRepository.set(rule.repositoryId, [
      ...(byRepository.get(rule.repositoryId) ?? []),
      rule,
    ]);
    byRole.set(
      rule.role,
      (byRole.get(rule.role) ?? new Set()).add(rule.repositoryId),
    );
  }
  const ambiguous: string[] = [];
  for (const [role, repositories] of byRole) {
    if (repositories.size > 1) ambiguous.push(`role:${role}`);
  }
  for (const group of byRepository.values()) {
    const first = group[0];
    if (
      group.some((rule) =>
        rule.role !== first.role || rule.presetId !== first.presetId
      )
    ) {
      ambiguous.push(...group.map((rule) => `label:${rule.labelId}`));
    }
  }
  if (ambiguous.length > 0) {
    return { kind: "blocked", reason: "route_ambiguous", refs: ambiguous };
  }
  // The union, one target per repository: labels that agree on a repository's
  // role and preset collapse into the first rule (by label key).
  const targets = [...byRepository.values()].map((group) => ({
    repositoryId: group[0].repositoryId,
    role: group[0].role,
    ruleId: group[0].id,
    ruleVersion: group[0].version,
    presetId: group[0].presetId,
  })).sort((left, right) =>
    byText(left.role, right.role) ||
    byText(left.repositoryId, right.repositoryId)
  );
  return { kind: "routed", targets, fallback: false };
}

type RuleRow = {
  id: string;
  provider_label_id: string;
  repository_id: string;
  role: string;
  preset_id: string;
  version: number;
  repository_archived: boolean;
  repository_accessible: boolean;
};

/**
 * The rules of one source with their repositories' live state. The caller
 * holds the source row, so a concurrent rule replacement (which takes it
 * `for update`) waits for this transaction.
 */
export async function readRouteRules(
  transaction: PgTransactionClient,
  source: { organizationId: string; id: string; applicationId: string },
): Promise<TicketRouteRule[]> {
  const result = await transaction.query<RuleRow>(
    `select rule.id, rule.provider_label_id, rule.repository_id, rule.role,
            rule.preset_id, rule.version,
            repository.archived_at is not null as repository_archived,
            (repository.application_id = $3
              and connection.archived_at is null) as repository_accessible
       from bakery.ticket_routing_rules as rule
       join bakery.repositories as repository
         on repository.organization_id = rule.organization_id
        and repository.id = rule.repository_id
       left join bakery.integration_connections as connection
         on connection.organization_id = repository.organization_id
        and connection.id = repository.integration_connection_id
      where rule.organization_id = $1 and rule.ticket_source_id = $2
      order by rule.provider_label_id, rule.repository_id`,
    [source.organizationId, source.id, source.applicationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    labelId: row.provider_label_id,
    repositoryId: row.repository_id,
    role: row.role,
    presetId: row.preset_id,
    version: row.version,
    repositoryArchived: row.repository_archived,
    // A repository with no connection row predates connections and stays
    // accessible; the left join reads its archive test as null-safe true.
    repositoryAccessible: row.repository_accessible === true,
  }));
}
